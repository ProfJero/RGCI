// Local stand-in for ProfJero Connect, for development and end-to-end tests.
// Mirrors the documented request/response shapes. Run: node scripts/mock-profjero.mjs
import http from 'node:http';

const PORT = Number(process.env.PORT || 8790);
let units = 1000;
const batches = new Map();
const idem = new Map();
const payments = new Map();
const campaigns = new Map();
const txns = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, type: i % 3 ? 'charge' : 'refund', delta: i % 3 ? -(1 + (i % 4)) : 1, description: i % 3 ? 'SMS send' : 'Refund for failed message', createdAt: new Date(Date.now() - (i + 1) * 3.6e6).toISOString() }));
txns.push({ id: 'topup0', type: 'topup', delta: 1000, description: 'Top-up (starter)', createdAt: new Date(Date.now() - 40 * 3.6e6).toISOString() });
const pages = (m) => { const gsm = !/[^\x00-\x7F£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà€]/.test(m); const per = gsm ? (m.length > 160 ? 153 : 160) : m.length > 70 ? 67 : 70; return Math.max(1, Math.ceil(m.length / per)); };
const render = (m, f = {}) => m.replace(/\{([a-z_]+)(?:\|([^}]*))?\}/gi, (_, k, fb) => f[k] || fb || '');

const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const err = (res, status, message) => send(res, status, { error: { code: `http_${status}`, message, requestId: crypto.randomUUID() } });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const json = body ? JSON.parse(body) : {};
  // Same shapes as the live API (nested per-service pricing).
  if (url.pathname === '/v1/pricing') return send(res, 200, { services: [{ service: 'sms', currency: 'GHS', unitPriceGhs: 0.06, minPurchaseUnits: 50, maxPurchaseUnits: null, active: true, packages: [
    { id: 'starter', service: 'sms', name: 'Starter', units: 500, priceGhs: 20, effectiveRate: 0.04, description: null, active: true, displayOrder: 10 },
    { id: 'church', service: 'sms', name: 'Growth', units: 2750, priceGhs: 100, effectiveRate: 0.036364, description: null, active: true, displayOrder: 30 },
    { id: 'retired', service: 'sms', name: 'Old bundle', units: 100, priceGhs: 5, active: false, displayOrder: 5 },
    { id: 'ministry', service: 'sms', name: 'Enterprise', units: 30000, priceGhs: 1000, effectiveRate: 0.033333, description: null, active: true, displayOrder: 60 },
  ] }] });
  if (url.pathname === '/v1/platform') return send(res, 200, { platformName: 'ProfJero Connect', supportEmail: 'support@profjero.example', supportPhone: '0200000000', customerSignupsEnabled: true });
  if (req.headers.authorization !== 'Bearer pk_live_test') return err(res, 401, 'Missing, invalid, revoked or expired API key.');
  const p = url.pathname;
  if (p === '/v1/balance') return send(res, 200, { availableUnits: units, lowBalance: units < 100, updatedAt: new Date().toISOString() });
  if (p === '/v1/wallet') return send(res, 200, { availableUnits: units, reservedUnits: 0, totalUnits: units, lowBalanceThreshold: 100, updatedAt: new Date().toISOString() });
  if (p === '/v1/wallet/transactions') {
    const limit = Number(url.searchParams.get('limit') || 50);
    const start = url.searchParams.get('before') ? txns.findIndex((t) => t.id === url.searchParams.get('before')) + 1 : 0;
    const page = txns.slice(start, start + limit);
    return send(res, 200, { transactions: page, nextCursor: start + limit < txns.length ? page[page.length - 1].id : null });
  }
  if (p === '/v1/sender-ids') return send(res, 200, { senderIds: [{ senderId: 'RGCI', status: 'approved', purpose: 'Church notifications', createdAt: '2026-08-04T07:00:00Z' }, { senderId: 'RGCIntl', status: 'pending', purpose: 'Events & outreach', createdAt: '2026-11-20T09:00:00Z' }], count: 2 });
  if (p === '/v1/payments' && req.method === 'GET') return send(res, 200, { payments: [...payments.values()].reverse(), totals: {} });
  if (p === '/v1/payments' && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!key) return err(res, 400, 'Idempotency-Key header is required');
    if (idem.has(key)) return send(res, 200, idem.get(key));
    const pkgs = { starter: [500, 20], church: [2750, 100], ministry: [30000, 1000] };
    const [u, a] = json.packageId ? pkgs[json.packageId] ?? [] : [json.units, +(json.units * 0.06).toFixed(2)];
    if (!u) return err(res, 400, 'Unknown package');
    const reference = 'pja_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    const payment = { reference, packageId: json.packageId ?? null, units: u, amountGhs: a, currency: 'GHS', status: 'pending', method: json.method ?? null, paidAt: null, walletCreditedAt: null, createdAt: new Date().toISOString() };
    payments.set(reference, payment);
    const out = { payment, checkoutUrl: `${json.callbackUrl || 'http://127.0.0.1:5173/admin/messages?tab=wallet'}${(json.callbackUrl || '?').includes('?') ? '&' : '?'}reference=${reference}` };
    idem.set(key, out);
    return send(res, 201, out);
  }
  const pay = p.match(/^\/v1\/payments\/(.+)$/);
  if (pay) {
    const payment = payments.get(pay[1]);
    if (!payment) return err(res, 404, 'Not found');
    // the mock "pays" on first status check, like a customer approving the MoMo prompt
    if (payment.status === 'pending') { Object.assign(payment, { status: 'paid', paidAt: new Date().toISOString(), walletCreditedAt: new Date().toISOString() }); units += payment.units; txns.unshift({ id: 'tp' + Date.now(), type: 'topup', delta: payment.units, description: `Top-up (${payment.packageId ?? 'custom'})`, createdAt: new Date().toISOString() }); }
    return send(res, 200, { payment });
  }
  if (p === '/v1/sms/estimate' || p === '/v1/sms/send') {
    const recips = (json.recipients || []).map((r) => (typeof r === 'string' ? { phone: r } : r));
    const msgs = recips.map((r) => render(json.message, r.fields));
    const need = msgs.reduce((n, m) => n + pages(m), 0);
    if (p === '/v1/sms/estimate') return send(res, 200, { recipients: recips.length, units: need, availableUnits: units, sufficient: need <= units, personalized: recips.some((r) => r.fields), samples: msgs.slice(0, 3).map((m, i) => ({ phone: recips[i].phone, message: m, segments: pages(m) })) });
    const key = req.headers['idempotency-key'];
    if (!key) return err(res, 400, 'Idempotency-Key header is required');
    if (idem.has(key)) return send(res, 200, idem.get(key));
    if (!json.senderId) return err(res, 400, 'senderId is required');
    if (need > units) return err(res, 402, 'Insufficient units. Top up your wallet (POST /v1/payments) and retry.');
    if (json.scheduleAt) { const campaign = { id: 'auto' + Math.floor(Math.random() * 1e6), type: 'scheduled', status: 'scheduled', message: json.message, senderId: json.senderId, nextRunAt: json.scheduleAt, createdAt: new Date().toISOString(), estimate: { recipients: recips.length, units: need } }; campaigns.set(campaign.id, campaign); const out = { scheduled: true, campaign }; idem.set(key, out); return send(res, 201, out); }
    units -= need;
    const batch = { id: key, status: 'completed', senderId: json.senderId, message: json.message, personalized: recips.some((r) => r.fields), totalRecipients: recips.length, totalUnitsReserved: need, totalUnitsCharged: need, submittedCount: recips.length, failedCount: 0, unknownCount: 0, deliveredCount: recips.length, createdAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    const records = recips.map((r, i) => ({ id: `${key}__r${i}`, recipient: r.phone, message: msgs[i], unitsPerMessage: pages(msgs[i]), status: 'delivered' }));
    const out = { batch, records };
    batches.set(key, out);
    idem.set(key, out);
    console.log(`[mock-profjero] sent ${recips.length} SMS from ${json.senderId}: ${msgs[0]}`);
    return send(res, 201, out);
  }
  if (p === '/v1/sms/batches') return send(res, 200, { batches: [...batches.values()].map((x) => x.batch).reverse(), nextCursor: null });
  const b = p.match(/^\/v1\/sms\/batches\/(.+)$/);
  if (b) return batches.has(b[1]) ? send(res, 200, batches.get(b[1])) : err(res, 404, 'Not found');
  if (p === '/v1/campaigns') return send(res, 200, { campaigns: [...campaigns.values()] });
  const cc = p.match(/^\/v1\/campaigns\/(.+)\/cancel$/);
  if (cc) { const c = campaigns.get(cc[1]); if (c) Object.assign(c, { status: 'cancelled', nextRunAt: null }); return send(res, 200, { campaign: c ?? { status: 'cancelled' } }); }
  err(res, 404, 'Not found');
}).listen(PORT, () => console.log(`[mock-profjero] listening on http://127.0.0.1:${PORT}`));
