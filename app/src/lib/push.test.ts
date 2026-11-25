// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleted: string[] = [];
const saved: unknown[] = [];
vi.mock('./firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, col: string, id: string) => `${col}/${id}`,
  setDoc: async (path: string, data: unknown) => void saved.push({ path, data }),
  deleteDoc: async (path: string) => void deleted.push(path),
  serverTimestamp: () => 'ts',
}));
const toB64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const NEW_KEY = toB64url(new Uint8Array(65).fill(7));
const OLD_KEY = toB64url(new Uint8Array(65).fill(3));
vi.mock('./api', () => ({ apiConfigured: () => true, api: async () => ({ publicKey: NEW_KEY }) }));

const b64 = (s: string) => Uint8Array.from(atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function fakeSub(endpoint: string, key: Uint8Array | null) {
  return {
    endpoint,
    options: { applicationServerKey: key ? key.buffer : null },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

let current: ReturnType<typeof fakeSub> | null;
const subscribe = vi.fn(async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => (current = fakeSub('https://push.test/new', applicationServerKey)));

beforeEach(() => {
  deleted.length = 0;
  saved.length = 0;
  subscribe.mockClear();
  const reg = { pushManager: { getSubscription: async () => current, subscribe } };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(reg), getRegistration: async () => reg } });
  Object.assign(window, { PushManager: class {}, Notification: Object.assign(class {}, { permission: 'granted', requestPermission: async () => 'granted' }) });
  vi.resetModules();
});

describe('push subscriptions', () => {
  it('replaces a subscription made with an old VAPID key (e.g. the previous RGCI push worker)', async () => {
    const old = fakeSub('https://push.test/old', b64(OLD_KEY));
    current = old;
    const { refreshPushSubscription } = await import('./push');
    await refreshPushSubscription('u1');
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(Array.from(subscribe.mock.calls[0][0].applicationServerKey)).toEqual(Array.from(b64(NEW_KEY)));
    expect(deleted).toHaveLength(1);
    expect(saved).toMatchObject([{ data: { uid: 'u1', endpoint: 'https://push.test/new' } }]);
  });

  it('keeps a subscription that already uses the current key', async () => {
    current = fakeSub('https://push.test/same', b64(NEW_KEY));
    const { enablePush } = await import('./push');
    expect(await enablePush('u2')).toBe('subscribed');
    expect(subscribe).not.toHaveBeenCalled();
    expect(current.unsubscribe).not.toHaveBeenCalled();
    expect(saved).toMatchObject([{ data: { uid: 'u2', endpoint: 'https://push.test/same' } }]);
  });

  it('does nothing in the background for people who never turned notifications on', async () => {
    current = null;
    const { refreshPushSubscription } = await import('./push');
    await refreshPushSubscription('u3');
    expect(subscribe).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });
});
