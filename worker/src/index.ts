/**
 * Restoration Grace Chapel International API — Cloudflare Worker
 * - ProfJero Connect SMS proxy (secret key stays here): send, estimate, delivery,
 *   wallet, unit purchases, sender IDs, scheduled campaigns
 * - Web Push (VAPID) to members' devices
 * - Signed Cloudinary uploads
 * - Daily automations: birthday & anniversary SMS, low SMS balance alerts
 * Crafted by ProfJero.
 */
import type { Env } from './env';
import { authenticate, requireRole, ROLES, type Caller } from './auth';
import { cleanSmsBody, normalizeList, pj } from './profjero';
import { signUpload } from './cloudinary';
import { sendWebPush, type PushSub } from './webpush';
import { createDocument, deleteDocument, listDocuments, runQuery, getDocument, setDocument, type Doc } from './firestore';
import { hasServiceAccount, serviceToken, setUserPassword } from './google';
import { HttpError } from './util';

const VERSION = '1.1.0';

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin || '*' : allowed[0] ?? '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
}

function errorJson(status: number, code: string, message: string, requestId?: string) {
  return json({ error: { code, message, requestId: requestId ?? crypto.randomUUID() } }, status);
}

/** Relays a ProfJero Connect response, keeping its status, error shape and Retry-After. */
async function relay(res: Response, transform?: (body: unknown) => unknown) {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: { code: `http_${res.status}`, message: text.slice(0, 300) || 'Unexpected response from SMS provider' } };
  }
  const extra: Record<string, string> = {};
  const ra = res.headers.get('retry-after');
  if (ra) extra['Retry-After'] = ra;
  return json(res.ok && transform ? transform(body) : body, res.status, extra);
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/* ---------------- push ---------------- */

interface PushInput {
  title: string;
  body: string;
  url?: string;
  image?: string;
  tag?: string;
  audience: 'all' | { uids: string[] };
  pageToken?: string;
}

/**
 * Sends one page of pushes. Large audiences are paged (nextPageToken) so a single
 * request stays within Workers' sub-request limits; the app loops until done.
 */
async function handlePush(caller: Caller, input: PushInput, env: Env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new HttpError(503, 'Push is not configured. Add the VAPID keys to the Worker.', 'not_configured');
  if (!input?.title || !input?.body) throw new HttpError(400, 'Title and body are required');
  const PAGE = 40;
  let subs: { id: string; sub: PushSub }[];
  let nextPageToken: string | undefined;
  const toSub = (d: Record<string, unknown>) => ({ id: String(d.__id), sub: { endpoint: String(d.endpoint), keys: d.keys as PushSub['keys'] } });
  if (input.audience === 'all') {
    const page = await listDocuments(env, 'push_subscriptions', caller.token, PAGE, input.pageToken);
    subs = page.docs.map(toSub);
    nextPageToken = page.nextPageToken;
  } else {
    const uids = (input.audience?.uids ?? []).slice(0, 30);
    if (!uids.length) throw new HttpError(400, 'No recipients');
    subs = (await runQuery(env, 'push_subscriptions', caller.token, [{ field: 'uid', op: 'IN', value: uids }], PAGE)).map(toSub);
  }
  const payload = {
    title: input.title.slice(0, 120),
    body: input.body.slice(0, 300),
    url: typeof input.url === 'string' && input.url.startsWith('/') ? input.url : '/notifications',
    image: input.image,
    tag: input.tag,
  };
  const results = await Promise.all(
    subs.filter((s) => s.sub.endpoint && s.sub.keys?.p256dh).map((s) =>
      sendWebPush(s.sub, payload, { publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY!, subject: env.VAPID_SUBJECT || 'mailto:admin@example.com', topic: input.tag }).then((r) => ({ ...r, id: s.id })),
    ),
  );
  const gone = results.filter((r) => r.gone);
  await Promise.all(gone.map((g) => deleteDocument(env, `push_subscriptions/${g.id}`, caller.token)));
  return {
    sent: results.filter((r) => r.status >= 200 && r.status < 300).length,
    failed: results.filter((r) => !(r.status >= 200 && r.status < 300)).length,
    removed: gone.length,
    total: results.length,
    nextPageToken: nextPageToken ?? null,
  };
}

/* ---------------- router ---------------- */

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  // Public
  if (path === '/' || path === '/v1/health') {
    return json({
      ok: true,
      name: 'RGCI API',
      church: 'Restoration Grace Chapel International',
      version: VERSION,
      sms: Boolean(env.PROFJERO_API_KEY),
      push: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      media: Boolean(env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET),
      serviceAccount: hasServiceAccount(env),
      by: 'ProfJero',
    });
  }
  if (path === '/v1/push/public-key' && m === 'GET') {
    if (!env.VAPID_PUBLIC_KEY) throw new HttpError(503, 'Push is not configured', 'not_configured');
    return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, { 'Cache-Control': 'public, max-age=3600' });
  }
  if (path === '/v1/sms/pricing' && m === 'GET') return relay(await pj(env, '/v1/pricing', { auth: false }));
  if (path === '/v1/sms/platform' && m === 'GET') return relay(await pj(env, '/v1/platform', { auth: false }));

  // Everything below requires a signed-in, active user
  const caller = await authenticate(req, env);

  if (path === '/v1/media/sign' && m === 'POST') {
    const { folder } = (await readJson(req)) as { folder?: string };
    return json(await signUpload(env, String(folder ?? ''), ROLES.staff.includes(caller.role)));
  }

  if (path === '/v1/push/send' && m === 'POST') {
    requireRole(caller, ROLES.push);
    return json(await handlePush(caller, (await readJson(req)) as PushInput, env));
  }

  if (path.startsWith('/v1/admin/users/') && path.endsWith('/password') && m === 'POST') {
    requireRole(caller, ROLES.admin);
    const uid = path.split('/')[4];
    const { password } = (await readJson(req)) as { password?: string };
    if (!password || password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    const target = await getDocument(env, `users/${uid}`, caller.token);
    if (!target) throw new HttpError(404, 'User not found');
    if (target.role === 'super_admin' && caller.role !== 'super_admin') throw new HttpError(403, 'Only a super admin can reset this account');
    await setUserPassword(env, uid, password);
    return json({ ok: true });
  }

  // SMS
  if (path === '/v1/sms/send' && m === 'POST') {
    requireRole(caller, ROLES.smsSend);
    const body = cleanSmsBody(await readJson(req), env);
    const key = req.headers.get('idempotency-key') || `rgci-${crypto.randomUUID()}`;
    if (key.length < 8 || key.length > 120) throw new HttpError(400, 'Idempotency-Key must be 8–120 characters');
    return relay(await pj(env, '/v1/sms/send', { method: 'POST', body, idempotencyKey: key }));
  }
  if (path === '/v1/sms/estimate' && m === 'POST') {
    requireRole(caller, ROLES.smsSend);
    return relay(await pj(env, '/v1/sms/estimate', { method: 'POST', body: cleanSmsBody(await readJson(req), env, true) }));
  }

  const qs = (keys: string[]) => {
    const p = new URLSearchParams();
    keys.forEach((k) => url.searchParams.get(k) && p.set(k, url.searchParams.get(k)!));
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const seg = (i: number) => encodeURIComponent(decodeURIComponent(path.split('/')[i] ?? ''));

  // Wallet & unit purchases — messaging roles and the treasurer
  if (path.startsWith('/v1/sms/balance') || path.startsWith('/v1/sms/wallet') || path.startsWith('/v1/sms/transactions') || path.startsWith('/v1/sms/payments')) {
    requireRole(caller, ROLES.smsBilling);
  } else requireRole(caller, ROLES.messaging);

  if (path === '/v1/sms/balance' && m === 'GET') return relay(await pj(env, '/v1/balance'));
  if (path === '/v1/sms/wallet' && m === 'GET') return relay(await pj(env, '/v1/wallet'));
  if (path === '/v1/sms/transactions' && m === 'GET') return relay(await pj(env, `/v1/wallet/transactions${qs(['limit', 'before'])}`), (b) => normalizeList(b, 'transactions'));
  if (path === '/v1/sms/sender-ids' && m === 'GET') return relay(await pj(env, '/v1/sender-ids'), (b) => normalizeList(b, 'senderIds'));
  if (path === '/v1/sms/batches' && m === 'GET') return relay(await pj(env, `/v1/sms/batches${qs(['limit', 'before'])}`), (b) => normalizeList(b, 'batches'));
  if (/^\/v1\/sms\/batches\/[^/]+$/.test(path) && m === 'GET') return relay(await pj(env, `/v1/sms/batches/${seg(4)}`));
  if (path === '/v1/sms/campaigns' && m === 'GET') return relay(await pj(env, '/v1/campaigns'), (b) => normalizeList(b, 'campaigns'));
  if (/^\/v1\/sms\/campaigns\/[^/]+$/.test(path) && m === 'GET') return relay(await pj(env, `/v1/campaigns/${seg(4)}`));
  if (/^\/v1\/sms\/campaigns\/[^/]+\/cancel$/.test(path) && m === 'POST') return relay(await pj(env, `/v1/campaigns/${seg(4)}/cancel`, { method: 'POST' }));
  if (path === '/v1/sms/payments' && m === 'GET') return relay(await pj(env, `/v1/payments${qs(['limit', 'before'])}`), (b) => normalizeList(b, 'payments'));
  if (/^\/v1\/sms\/payments\/[^/]+$/.test(path) && m === 'GET') return relay(await pj(env, `/v1/payments/${seg(4)}`));
  if (path === '/v1/sms/payments' && m === 'POST') {
    const b = (await readJson(req)) as Record<string, unknown>;
    const body: Record<string, unknown> = {};
    if (typeof b.packageId === 'string') body.packageId = b.packageId;
    else if (Number.isInteger(b.units) && (b.units as number) > 0 && (b.units as number) <= 1_000_000) body.units = b.units;
    else throw new HttpError(400, 'Choose a package or a number of units');
    if (typeof b.email === 'string' && b.email.includes('@')) body.email = b.email;
    if (typeof b.callbackUrl === 'string' && b.callbackUrl.startsWith('https://')) body.callbackUrl = b.callbackUrl;
    if (b.method === 'mobile_money' || b.method === 'card') body.method = b.method;
    const key = req.headers.get('idempotency-key') || `topup-${crypto.randomUUID()}`;
    if (key.length < 8 || key.length > 120) throw new HttpError(400, 'Idempotency-Key must be 8–120 characters');
    return relay(await pj(env, '/v1/payments', { method: 'POST', body, idempotencyKey: key }));
  }

  throw new HttpError(404, 'Not found');
}

/* ---------------- daily jobs ---------------- */

const today = (now: Date) => now.toISOString().slice(0, 10);
const monthDay = (now: Date) => `${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
const reachable = (m: Doc) => Boolean(m.phone) && !m.smsOptOut && !['deceased', 'transferred'].includes(String(m.membershipStatus));

/** Records an automatic send in sms_messages (id = idempotency key) so it shows in the app's history. */
async function recordAutoSend(env: Env, token: string, key: string, info: { audience: string; message: string; senderId?: string; recipients: number }, res: Response) {
  let body: { batch?: Record<string, unknown>; error?: { message?: string } } = {};
  try {
    body = (await res.clone().json()) as typeof body;
  } catch {
    /* not JSON */
  }
  const b = body.batch ?? {};
  await setDocument(env, `sms_messages/${key}`, token, {
    senderId: String(b.senderId ?? info.senderId ?? env.PROFJERO_SENDER_ID ?? ''),
    message: info.message,
    audience: info.audience,
    recipients: info.recipients,
    personalized: true,
    status: res.ok ? String(b.status ?? 'sending') : 'failed',
    unitsReserved: (b.totalUnitsReserved as number | undefined) ?? null,
    unitsCharged: (b.totalUnitsCharged as number | undefined) ?? null,
    delivered: (b.deliveredCount as number | undefined) ?? null,
    failed: (b.failedCount as number | undefined) ?? null,
    scheduledAt: null,
    automatic: true,
    createdByName: 'Automatic',
    error: res.ok ? null : body.error?.message ?? `HTTP ${res.status}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).catch((e) => console.error('[rgci-api] could not record automatic send', e));
}

/** Personalised SMS to everyone whose date field (birthday / wedding anniversary) is today. */
async function celebrationJob(env: Env, kind: 'birthday' | 'anniversary', now = new Date()) {
  if (!hasServiceAccount(env) && env.EMULATOR !== 'true') return { skipped: 'no service account' };
  const token = await serviceToken(env);
  const settings = await getDocument(env, 'settings/church', token);
  const [flag, template, field, label] =
    kind === 'birthday'
      ? ['autoBirthdaySms', 'birthdaySms', 'birthMonthDay', 'Birthday wishes (automatic)']
      : ['autoAnniversarySms', 'anniversarySms', 'anniversaryMonthDay', 'Anniversary wishes (automatic)'];
  if (!settings?.[flag] || !settings[template]) return { skipped: 'disabled' };
  const people = (await runQuery(env, 'members', token, [{ field, op: 'EQUAL', value: monthDay(now) }], 2000)).filter(reachable);
  if (!people.length) return { sent: 0 };
  const key = `${kind}-${today(now)}`;
  const message = String(settings[template]);
  const body = cleanSmsBody(
    {
      message,
      senderId: settings.smsSenderId,
      recipients: people.map((p) => ({ phone: p.phone, fields: Object.fromEntries(Object.entries({ first_name: p.firstName, last_name: p.lastName, name: p.fullName }).filter(([, v]) => v)) })),
    },
    env,
  );
  const res = await pj(env, '/v1/sms/send', { method: 'POST', idempotencyKey: key, body });
  await recordAutoSend(env, token, key, { audience: label, message, senderId: body.senderId as string | undefined, recipients: people.length }, res);
  return { sent: people.length, status: res.status };
}

export const birthdayJob = (env: Env, now = new Date()) => celebrationJob(env, 'birthday', now);
export const anniversaryJob = (env: Env, now = new Date()) => celebrationJob(env, 'anniversary', now);

/**
 * Warns the people who can buy units when the SMS wallet is running low — an in-app
 * notification plus a push to their devices — so Sunday reminders never stop.
 */
export async function lowBalanceJob(env: Env) {
  if (!env.PROFJERO_API_KEY) return { skipped: 'sms not configured' };
  if (!hasServiceAccount(env) && env.EMULATOR !== 'true') return { skipped: 'no service account' };
  const token = await serviceToken(env);
  const settings = await getDocument(env, 'settings/church', token);
  if (settings?.smsLowBalanceAlert === false) return { skipped: 'disabled' };
  const res = await pj(env, '/v1/balance');
  if (!res.ok) return { skipped: `balance ${res.status}` };
  const bal = (await res.json()) as { availableUnits: number; lowBalance?: boolean };
  const threshold = Number(settings?.smsLowBalanceUnits) || 0;
  const low = threshold > 0 ? bal.availableUnits <= threshold : Boolean(bal.lowBalance);
  if (!low) return { low: false, units: bal.availableUnits };

  const staff = (await runQuery(env, 'users', token, [{ field: 'role', op: 'IN', value: ROLES.smsBilling }], 200)).filter((u) => u.isActive !== false);
  const title = 'SMS balance is running low';
  const text = `Only ${bal.availableUnits.toLocaleString('en-GH')} SMS units left. Top up so reminders and receipts keep going out.`;
  const url = '/admin/messages?tab=wallet';
  await Promise.all(
    staff.map((u) => createDocument(env, 'notifications', token, { title, body: text, url, audience: String(u.__id), kind: 'general', createdAt: new Date(), createdBy: 'system' }).catch(() => {})),
  );
  let pushed = 0;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && staff.length) {
    const uids = staff.map((u) => String(u.__id));
    for (let i = 0; i < uids.length; i += 30) {
      const subs = await runQuery(env, 'push_subscriptions', token, [{ field: 'uid', op: 'IN', value: uids.slice(i, i + 30) }], 200);
      const results = await Promise.all(
        subs
          .filter((d) => d.endpoint && (d.keys as PushSub['keys'] | undefined)?.p256dh)
          .map((d) =>
            sendWebPush({ endpoint: String(d.endpoint), keys: d.keys as PushSub['keys'] }, { title, body: text, url, tag: 'sms-low-balance' }, { publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY!, subject: env.VAPID_SUBJECT || 'mailto:admin@example.com', topic: 'sms-low-balance' }),
          ),
      );
      pushed += results.filter((r) => r.status >= 200 && r.status < 300).length;
    }
  }
  return { low: true, units: bal.availableUnits, notified: staff.length, pushed };
}

export async function dailyJobs(env: Env, now = new Date()) {
  const run = async (name: string, job: () => Promise<unknown>) => {
    try {
      return [name, await job()] as const;
    } catch (e) {
      console.error(`[rgci-api] ${name} job failed`, e);
      return [name, { error: String(e) }] as const;
    }
  };
  return Object.fromEntries(await Promise.all([run('birthday', () => birthdayJob(env, now)), run('anniversary', () => anniversaryJob(env, now)), run('lowBalance', () => lowBalanceJob(env))]));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res: Response;
    try {
      res = await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) res = errorJson(e.status, e.code, e.message);
      else {
        console.error('[rgci-api]', e);
        res = errorJson(500, 'internal', 'Something went wrong. Please retry.');
      }
    }
    const headers = new Headers(res.headers);
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    return new Response(res.body, { status: res.status, headers });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dailyJobs(env).then((r) => console.log('[rgci-api] daily jobs', JSON.stringify(r))));
  },
};
