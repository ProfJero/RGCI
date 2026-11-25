// Brings data from the previous RGCI Member Care app (Firebase project
// "rgci-management") into the shape this app uses. Safe to re-run: documents keep
// their ids and are merged, and nothing in the old collections is changed or deleted.
//
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scripts/migrate-legacy.mjs            # dry run (default)
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scripts/migrate-legacy.mjs --apply    # write
//
// Mapping
//   devotions          → devotionals     (title, date, verse → scripture, content → body, prayer)
//   pastoral_requests  → care_requests   (prayer / counselling / visit / urgent; private or public)
//   users              → users           (adds role "member", isActive, fullName, phone where missing)
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const projectId = process.env.FIREBASE_PROJECT_ID || 'rgci-management';
initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();

const stripHtml = (s) =>
  String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Ghana numbers → 233XXXXXXXXX, as the app stores them. */
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 10) d = '233' + d.slice(1);
  if (d.length === 9) d = '233' + d;
  return d;
}

const toTs = (v) => {
  if (!v) return Timestamp.now();
  if (v instanceof Timestamp) return v;
  if (typeof v?.toDate === 'function') return Timestamp.fromDate(v.toDate());
  const t = Date.parse(v);
  return Number.isFinite(t) ? Timestamp.fromMillis(t) : Timestamp.now();
};
const isoDay = (v) => {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = v?.toDate?.() ?? (v ? new Date(v) : null);
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
};

const CARE_TYPE = { prayer_request: 'prayer', prayer: 'prayer', counselling: 'counselling', counselling_request: 'counselling', counseling: 'counselling', visit: 'visit', visit_request: 'visit', visitation: 'visit', urgent: 'urgent', urgent_request: 'urgent', emergency: 'urgent', testimony: 'thanksgiving', thanksgiving: 'thanksgiving' };
const CARE_STATUS = { pending: 'new', new: 'new', open: 'new', in_progress: 'in_progress', 'in-progress': 'in_progress', contacted: 'in_progress', scheduled: 'scheduled', completed: 'completed', resolved: 'completed', done: 'completed', closed: 'closed' };

const stats = {};
const bump = (k) => (stats[k] = (stats[k] ?? 0) + 1);

async function writeAll(collection, rows) {
  if (!APPLY) return;
  for (let i = 0; i < rows.length; i += 400) {
    const batch = db.batch();
    for (const [id, data] of rows.slice(i, i + 400)) batch.set(db.collection(collection).doc(id), data, { merge: true });
    await batch.commit();
  }
}

async function devotions() {
  const snap = await db.collection('devotions').get();
  const rows = snap.docs.map((d) => {
    const x = d.data();
    bump('devotions');
    return [
      d.id,
      {
        title: x.title || 'Daily Devotion',
        date: isoDay(x.date || x.createdAt),
        scripture: x.verse || x.scripture || '',
        scriptureText: x.verseText || x.scriptureText || '',
        body: stripHtml(x.content || x.message || x.body),
        prayer: stripHtml(x.prayer),
        confession: stripHtml(x.confession),
        author: x.author || '',
        imageUrl: x.imageUrl || '',
        status: x.status === 'published' ? 'published' : 'draft',
        createdAt: toTs(x.createdAt || x.date),
        legacy: { collection: 'devotions', id: d.id },
      },
    ];
  });
  await writeAll('devotionals', rows);
}

async function pastoralRequests(uidByPhone) {
  const snap = await db.collection('pastoral_requests').get();
  const rows = snap.docs.map((d) => {
    const x = d.data();
    const type = CARE_TYPE[String(x.type ?? '').toLowerCase()] ?? 'prayer';
    bump(`care:${type}`);
    const phone = normalizePhone(x.phone);
    const followup = x.followup && x.followup !== 'no' ? `Follow-up requested: ${String(x.followup).replace(/^yes,?\s*/i, '')}` : '';
    const extra = [x.preferredContact && `Preferred contact: ${x.preferredContact}`, x.email && `Email: ${x.email}`, followup].filter(Boolean).join('\n');
    const details = stripHtml(x.request || x.message || x.description || x.reason || x.details || '');
    return [
      d.id,
      {
        type,
        uid: x.userId || x.uid || uidByPhone.get(phone) || null,
        memberId: null,
        name: x.fullName || x.name || 'Member',
        phone,
        subject: x.subject || '',
        details: extra ? `${details}\n\n${extra}` : details,
        visibility: x.visibility === 'public' && type === 'prayer' ? 'public' : 'private',
        anonymous: false,
        preferredDate: isoDay(x.preferredDate) || '',
        status: CARE_STATUS[String(x.status ?? '').toLowerCase()] ?? 'new',
        responses: [],
        prayedCount: Number(x.prayedCount ?? 0) || 0,
        createdAt: toTs(x.createdAt),
        updatedAt: toTs(x.updatedAt || x.createdAt),
        legacy: { collection: 'pastoral_requests', id: d.id },
      },
    ];
  });
  await writeAll('care_requests', rows);
}

const ROLES = new Set(['super_admin', 'admin', 'pastor', 'treasurer', 'secretary', 'staff', 'viewer', 'member']);

async function users() {
  const snap = await db.collection('users').get();
  const uidByPhone = new Map();
  const rows = [];
  for (const d of snap.docs) {
    const x = d.data();
    const phone = normalizePhone(x.phone || x.phoneNumber);
    if (phone) uidByPhone.set(phone, d.id);
    const patch = {};
    if (!ROLES.has(x.role)) {
      patch.role = 'member'; // unknown/legacy roles get the least access; promote staff in Users & roles
      if (x.role) bump(`users:legacy-role:${x.role}`);
    }
    if (typeof x.isActive !== 'boolean') patch.isActive = true;
    if (!x.fullName) patch.fullName = x.displayName || x.name || x.email || 'Member';
    if (!x.phone && phone) patch.phone = phone;
    if (!x.uid) patch.uid = d.id;
    if (!x.email && x.emailAddress) patch.email = x.emailAddress;
    if (Object.keys(patch).length) {
      rows.push([d.id, patch]);
      bump('users:updated');
    } else bump('users:unchanged');
  }
  await writeAll('users', rows);
  return uidByPhone;
}

const uidByPhone = await users();
await devotions();
await pastoralRequests(uidByPhone);
console.log(`${APPLY ? 'Migrated' : 'Dry run (use --apply to write)'} — project ${projectId}`);
console.table(stats);
