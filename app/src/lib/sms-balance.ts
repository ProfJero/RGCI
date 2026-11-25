import { useEffect, useSyncExternalStore } from 'react';
import { api, apiConfigured } from './api';

/**
 * One shared, lightly cached view of the ProfJero Connect balance, used by the
 * header chip, the dashboard and the SMS pages so they never disagree and the
 * provider isn't asked more than once a minute.
 */
export interface SmsBalanceState {
  units: number | null;
  low: boolean;
  updatedAt: string | null;
  loading: boolean;
  error: string | null;
}

const MAX_AGE = 60_000;
let state: SmsBalanceState = { units: null, low: false, updatedAt: null, loading: false, error: null };
let fetchedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<SmsBalanceState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

/** Fetches the balance now (or joins a request already in flight). */
export function refreshSmsBalance(): Promise<void> {
  if (!apiConfigured()) return Promise.resolve();
  if (inflight) return inflight;
  set({ loading: true });
  inflight = api<{ availableUnits: number; lowBalance: boolean; updatedAt: string }>('/v1/sms/balance')
    .then((b) => {
      fetchedAt = Date.now();
      set({ units: b.availableUnits, low: Boolean(b.lowBalance), updatedAt: b.updatedAt, error: null });
    })
    .catch((e: Error) => set({ error: e.message }))
    .finally(() => {
      inflight = null;
      set({ loading: false });
    });
  return inflight;
}

/** Lets a page that already loaded the full wallet update everyone else. */
export function setSmsBalance(units: number, low?: boolean) {
  fetchedAt = Date.now();
  set({ units, low: low ?? state.low, updatedAt: new Date().toISOString(), error: null });
}

export function useSmsBalance(enabled = true): SmsBalanceState & { refresh: () => Promise<void> } {
  const snap = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  useEffect(() => {
    if (enabled && Date.now() - fetchedAt > MAX_AGE) void refreshSmsBalance();
  }, [enabled]);
  return { ...snap, refresh: refreshSmsBalance };
}

/** Low when below the church's own alert level, or the provider says so. */
export function isLowBalance(units: number | null, providerLow: boolean, threshold?: number | null) {
  if (units == null) return false;
  if (threshold && threshold > 0) return units <= threshold;
  return providerLow || units < 100;
}
