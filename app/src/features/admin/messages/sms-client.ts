import { api } from '@/lib/api';
import { createDoc, getActor, patchDoc } from '@/lib/db';
import { normalizePhone } from '@/lib/phone';
import { uid } from '@/lib/utils';
import { refreshSmsBalance } from '@/lib/sms-balance';

/** Shapes returned by ProfJero Connect (relayed by the RGCI Worker). Optional fields are read defensively. */
export interface PjBatch {
  id: string;
  status: 'submitting' | 'completed' | 'partial' | 'failed';
  senderId: string;
  message: string;
  personalized: boolean;
  totalRecipients: number;
  totalUnitsReserved: number;
  totalUnitsCharged: number;
  submittedCount: number;
  failedCount: number;
  unknownCount: number;
  deliveredCount: number;
  createdAt: string;
  completedAt: string | null;
}
export interface PjRecord {
  id: string;
  recipient: string;
  message: string;
  unitsPerMessage?: number;
  unitsCharged?: number;
  status: 'queued' | 'submitting' | 'submitted' | 'delivered' | 'failed' | 'unknown';
}
export interface PjSendResult {
  batch?: PjBatch;
  records?: PjRecord[];
  scheduled?: boolean;
  campaign?: { id: string; status: string; nextRunAt: string; estimate: { recipients: number; units: number } };
}
export interface PjEstimate {
  recipients: number;
  units: number;
  availableUnits: number;
  sufficient: boolean;
  personalized: boolean;
  samples: { phone: string; message: string; segments: number }[];
}
export interface PjBalance {
  availableUnits: number;
  lowBalance: boolean;
  updatedAt: string;
}

export type Recipient = string | { phone: string; fields?: Record<string, string> };

function cleanRecipients(recipients: Recipient[]) {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of recipients) {
    const phone = normalizePhone(typeof r === 'string' ? r : r.phone);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    out.push(typeof r === 'string' ? phone : { phone, fields: r.fields });
  }
  return out;
}

export function estimateSms(message: string, recipients: Recipient[]) {
  return api<PjEstimate>('/v1/sms/estimate', { method: 'POST', json: { message, recipients: cleanRecipients(recipients) } });
}

export function smsBalance() {
  return api<PjBalance>('/v1/sms/balance');
}

/**
 * Sends (or schedules) an SMS through ProfJero Connect and records it in
 * Firestore. The idempotency key doubles as the history record id, so a retry
 * after a dropped connection can never double-send.
 */
export async function sendSms(input: {
  message: string;
  recipients: Recipient[];
  audience: string;
  senderId?: string;
  scheduleAt?: string | null;
  idempotencyKey?: string;
}) {
  const recipients = cleanRecipients(input.recipients);
  if (!recipients.length) throw new Error('No valid phone numbers to send to.');
  const key = input.idempotencyKey ?? `rgci-${uid()}`;
  const actor = getActor();
  const personalized = recipients.some((r) => typeof r !== 'string' && r.fields && Object.keys(r.fields).length > 0);
  await createDoc(
    'sms_messages',
    {
      senderId: input.senderId ?? '',
      message: input.message,
      audience: input.audience,
      recipients: recipients.length,
      personalized,
      status: input.scheduleAt ? 'scheduled' : 'sending',
      scheduledAt: input.scheduleAt ?? null,
      createdByName: actor?.name ?? '',
      error: null,
    },
    { id: key },
  ).catch(() => {}); // a retry with the same key re-uses the record
  try {
    const res = await api<PjSendResult>('/v1/sms/send', {
      method: 'POST',
      idempotencyKey: key,
      json: { senderId: input.senderId || undefined, message: input.message, recipients, scheduleAt: input.scheduleAt || undefined },
    });
    if (res.scheduled && res.campaign) {
      await patchDoc('sms_messages', key, { status: 'scheduled', campaignId: res.campaign.id, unitsReserved: res.campaign.estimate?.units ?? null });
    } else if (res.batch) {
      await patchDoc('sms_messages', key, batchPatch(res.batch));
    }
    void refreshSmsBalance();
    return { key, ...res };
  } catch (e) {
    await patchDoc('sms_messages', key, { status: 'failed', error: (e as Error).message }).catch(() => {});
    throw e;
  }
}

export function batchPatch(b: PjBatch) {
  return {
    status: b.status,
    senderId: b.senderId,
    unitsReserved: b.totalUnitsReserved,
    unitsCharged: b.totalUnitsCharged,
    delivered: b.deliveredCount,
    failed: b.failedCount,
  };
}

export function getBatch(id: string) {
  return api<{ batch: PjBatch; records: PjRecord[] }>(`/v1/sms/batches/${encodeURIComponent(id)}`);
}

/* ---------------- wallet, unit purchases & account ---------------- */

export interface PjWallet {
  availableUnits: number;
  reservedUnits: number;
  totalUnits: number;
  lowBalanceThreshold: number | null;
  updatedAt: string;
}
export interface PjPackage {
  id: string;
  name?: string;
  units: number;
  amountGhs?: number;
  priceGhs?: number;
  amount?: number;
  description?: string;
  popular?: boolean;
}
export interface PjPricing {
  unitPriceGhs?: number;
  unitPrice?: number;
  currency?: string;
  minUnits?: number;
  packages?: PjPackage[];
}
export interface PjPayment {
  reference: string;
  packageId?: string | null;
  units: number;
  amountGhs: number;
  currency?: string;
  status: string;
  method?: string | null;
  paidAt: string | null;
  walletCreditedAt?: string | null;
  createdAt?: string;
}
export interface PjTransaction {
  id?: string;
  type?: string;
  units?: number;
  delta?: number;
  balanceAfter?: number;
  description?: string;
  reference?: string;
  createdAt?: string;
}
export interface PjSenderId {
  senderId: string;
  status: 'approved' | 'pending' | 'rejected' | string;
  purpose?: string;
  createdAt?: string;
  reviewedAt?: string;
  rejectionReason?: string;
}
export interface PjCampaign {
  id: string;
  name?: string;
  type?: string;
  status: string;
  message?: string;
  senderId?: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  createdAt?: string;
  estimate?: { recipients: number; units: number };
}
export interface PjPlatform {
  name?: string;
  website?: string;
  supportEmail?: string;
  supportPhone?: string;
  whatsapp?: string;
  support?: { email?: string; phone?: string; whatsapp?: string; hours?: string };
}

export const pkgPrice = (p: PjPackage) => p.amountGhs ?? p.priceGhs ?? p.amount ?? 0;
export const unitPriceOf = (p: PjPricing | null | undefined) => p?.unitPriceGhs ?? p?.unitPrice;
/** A payment counts as complete once it is paid or the wallet was credited. */
export const isPaid = (p: Pick<PjPayment, 'status' | 'paidAt' | 'walletCreditedAt'>) =>
  Boolean(p.paidAt || p.walletCreditedAt) || ['paid', 'success', 'successful', 'completed', 'credited'].includes(p.status);
export const isFailed = (p: Pick<PjPayment, 'status'>) => ['failed', 'cancelled', 'canceled', 'abandoned', 'expired', 'reversed'].includes(p.status);

export const smsApi = {
  wallet: () => api<PjWallet>('/v1/sms/wallet'),
  pricing: () => api<PjPricing>('/v1/sms/pricing'),
  platform: () => api<PjPlatform>('/v1/sms/platform'),
  transactions: (before?: string | null, limit = 25) =>
    api<{ transactions: PjTransaction[]; nextCursor: string | null }>(`/v1/sms/transactions?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  payments: (limit = 20) => api<{ payments: PjPayment[]; nextCursor: string | null; totals?: Record<string, number> }>(`/v1/sms/payments?limit=${limit}`),
  payment: (reference: string) => api<{ payment: PjPayment }>(`/v1/sms/payments/${encodeURIComponent(reference)}`),
  buy: (input: { packageId?: string; units?: number; email?: string; method?: 'mobile_money' | 'card'; callbackUrl?: string }, idempotencyKey: string) =>
    api<{ payment: PjPayment; checkoutUrl: string }>('/v1/sms/payments', { method: 'POST', json: input, idempotencyKey }),
  senderIds: () => api<{ senderIds: PjSenderId[] }>('/v1/sms/sender-ids'),
  campaigns: () => api<{ campaigns: PjCampaign[] }>('/v1/sms/campaigns'),
  cancelCampaign: (id: string) => api<{ campaign?: PjCampaign }>(`/v1/sms/campaigns/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  batches: (before?: string | null, limit = 20) =>
    api<{ batches: PjBatch[]; nextCursor: string | null }>(`/v1/sms/batches?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`),
};
