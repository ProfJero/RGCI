import { deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { api, apiConfigured } from './api';
import { db } from './firebase';

export type PushState = 'unsupported' | 'denied' | 'default' | 'subscribed' | 'unsubscribed';

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** iOS only allows web push for apps added to the Home Screen. */
export function needsInstallForPush() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return ios && !isStandalone();
}

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function b64urlToBytes(s: string) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

let publicKeyCache: Promise<Uint8Array> | null = null;
function serverKey() {
  publicKeyCache ??= api<{ publicKey: string }>('/v1/push/public-key')
    .then((r) => b64urlToBytes(r.publicKey))
    .catch((e) => {
      publicKeyCache = null;
      throw e;
    });
  return publicKeyCache;
}

/** True when the subscription was made for this server's VAPID key (not, e.g., the old RGCI push worker's). */
function matchesKey(sub: PushSubscription, key: Uint8Array) {
  const own = sub.options?.applicationServerKey;
  if (!own) return true; // browser doesn't expose it — assume fine
  const a = new Uint8Array(own);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

/** Returns a subscription for the current key, replacing one made with an older key. */
async function ensureSubscription(reg: ServiceWorkerRegistration) {
  const key = await serverKey();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !matchesKey(sub, key)) {
    await deleteDoc(doc(db, 'push_subscriptions', await sha256(sub.endpoint))).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) return 'subscribed';
  return Notification.permission === 'granted' ? 'unsubscribed' : 'default';
}

export async function enablePush(uid: string): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!apiConfigured()) throw new Error('Notifications need the RGCI API (VITE_API_URL) to be configured.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'default';
  const reg = await navigator.serviceWorker.ready;
  const sub = await ensureSubscription(reg);
  await saveSubscription(uid, sub);
  return 'subscribed';
}

export async function saveSubscription(uid: string, sub: PushSubscription) {
  const json = sub.toJSON();
  await setDoc(doc(db, 'push_subscriptions', await sha256(sub.endpoint)), {
    uid,
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    userAgent: navigator.userAgent.slice(0, 200),
    createdAt: serverTimestamp(),
  });
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await deleteDoc(doc(db, 'push_subscriptions', await sha256(sub.endpoint))).catch(() => {});
    await sub.unsubscribe();
  }
  return 'unsubscribed';
}

/**
 * Keep the stored subscription fresh for signed-in users (endpoints rotate), and
 * quietly move devices still subscribed with an old VAPID key onto the current one.
 */
export async function refreshPushSubscription(uid: string) {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !(await reg.pushManager.getSubscription())) return;
    const sub = apiConfigured() ? await ensureSubscription(reg) : await reg.pushManager.getSubscription();
    if (sub) await saveSubscription(uid, sub);
  } catch {
    /* offline or push service unavailable — try again next launch */
  }
}

export interface PushSendInput {
  title: string;
  body: string;
  url?: string;
  audience: 'all' | { uids: string[] };
  tag?: string;
  image?: string;
}

interface PushPage { sent: number; failed: number; removed: number; total: number; nextPageToken: string | null }

/** Sends to every device, page by page (the Worker caps work per request). */
export async function sendPush(input: PushSendInput) {
  const total = { sent: 0, failed: 0, removed: 0, total: 0 };
  let pageToken: string | undefined;
  for (let i = 0; i < 200; i++) {
    const r = await api<PushPage>('/v1/push/send', { method: 'POST', json: { ...input, pageToken } });
    total.sent += r.sent;
    total.failed += r.failed;
    total.removed += r.removed;
    total.total += r.total;
    if (!r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  return total;
}
