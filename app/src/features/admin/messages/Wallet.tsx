import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Wallet as WalletIcon, RefreshCw, CreditCard, Smartphone, AlertTriangle, CheckCircle2, ShieldCheck, Sparkles,
  ArrowDownLeft, ArrowUpRight, Clock3, XCircle, LifeBuoy, Mail, Phone, MessageCircle, Receipt,
} from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiConfigured } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useChurch } from '@/lib/settings';
import { isLowBalance, setSmsBalance } from '@/lib/sms-balance';
import { cedis, num, relative, fmtDateTime } from '@/lib/format';
import { cn, uid } from '@/lib/utils';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Banner, EmptyState, Spinner } from '@/components/ui/feedback';
import { Field, Input, TextField } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  isFailed, isPaid, pkgPrice, smsApi, unitPriceOf,
  type PjPackage, type PjPayment, type PjPlatform, type PjPricing, type PjTransaction, type PjWallet,
} from './sms-client';

const LAST_TOPUP = 'rgci-last-topup';
const QUICK_UNITS = [1000, 2500, 5000, 10000];
type Method = 'mobile_money' | 'card';

/** SMS credits: live wallet, buying units through ProfJero Connect checkout, purchase history and wallet activity. */
export function Wallet() {
  const { profile } = useAuth();
  const church = useChurch();
  const [params, setParams] = useSearchParams();
  const [wallet, setWallet] = useState<PjWallet | null>(null);
  const [pricing, setPricing] = useState<PjPricing | null>(null);
  const [platform, setPlatform] = useState<PjPlatform | null>(null);
  const [payments, setPayments] = useState<PjPayment[]>([]);
  const [txns, setTxns] = useState<PjTransaction[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [choice, setChoice] = useState<string>('');
  const [customUnits, setCustomUnits] = useState('');
  const [method, setMethod] = useState<Method>('mobile_money');
  const [email, setEmail] = useState(profile?.email && !profile.email.endsWith('.app') ? profile.email : church.email ?? '');
  const [paying, setPaying] = useState(false);
  const [returned, setReturned] = useState<{ payment: PjPayment | null; checking: boolean } | null>(null);
  const buyRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!apiConfigured()) return setLoading(false);
    setLoading(true);
    setError('');
    try {
      const [w, p, pay, t, plat] = await Promise.all([
        smsApi.wallet(),
        smsApi.pricing().catch(() => null),
        smsApi.payments(15).catch(() => ({ payments: [] as PjPayment[] })),
        smsApi.transactions(null, 25).catch(() => ({ transactions: [] as PjTransaction[], nextCursor: null })),
        smsApi.platform().catch(() => null),
      ]);
      setWallet(w);
      setSmsBalance(w.availableUnits);
      setPricing(p);
      setPlatform(plat);
      setPayments(pay.payments ?? []);
      setTxns(t.transactions ?? []);
      setCursor(t.nextCursor ?? null);
      const pkgs = p?.packages ?? [];
      if (pkgs.length) setChoice((c) => c || (pkgs.find((x) => x.popular) ?? pkgs[Math.min(1, pkgs.length - 1)]).id);
      else setChoice((c) => c || 'custom');
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Confirms a payment with ProfJero Connect (which credits the wallet if paid), retrying briefly while pending. */
  const confirmPayment = useCallback(
    async (reference: string, attempts = 5) => {
      setReturned((r) => ({ payment: r?.payment ?? null, checking: true }));
      for (let i = 0; i < attempts; i++) {
        try {
          const { payment } = await smsApi.payment(reference);
          setReturned({ payment, checking: i < attempts - 1 && !isPaid(payment) && !isFailed(payment) });
          setPayments((list) => [payment, ...list.filter((x) => x.reference !== payment.reference)]);
          if (isPaid(payment)) {
            toast.success(`Top-up successful — ${num(payment.units)} units added`);
            void load();
            return;
          }
          if (isFailed(payment)) return;
        } catch {
          /* keep trying */
        }
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 4000));
      }
      setReturned((r) => (r ? { ...r, checking: false } : r));
    },
    [load],
  );

  // Returning from checkout
  useEffect(() => {
    if (!apiConfigured()) return;
    let ref = params.get('ref') || params.get('reference');
    try {
      ref = ref || sessionStorage.getItem(LAST_TOPUP);
      sessionStorage.removeItem(LAST_TOPUP);
    } catch {
      /* storage unavailable */
    }
    if (!ref) return;
    void confirmPayment(ref);
    if (params.has('ref') || params.has('reference')) {
      const next = new URLSearchParams(params);
      next.delete('ref');
      next.delete('reference');
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unitPrice = unitPriceOf(pricing);
  const packages = useMemo(() => [...(pricing?.packages ?? [])].sort((a, b) => a.units - b.units), [pricing]);
  const perUnit = (p: PjPackage) => (p.units ? pkgPrice(p) / p.units : 0);
  const bestValue = useMemo(() => (packages.length > 1 ? packages.reduce((best, p) => (perUnit(p) < perUnit(best) ? p : best)).id : null), [packages]);
  const minUnits = pricing?.minUnits ?? 1;

  const order = useMemo(() => {
    if (choice === 'custom') {
      const units = Math.round(Number(customUnits) || 0);
      return { label: 'Custom amount', units, amount: unitPrice ? units * unitPrice : null, valid: units >= minUnits };
    }
    const p = packages.find((x) => x.id === choice);
    return p ? { label: p.name ?? p.id, units: p.units, amount: pkgPrice(p), valid: true } : { label: '', units: 0, amount: null, valid: false };
  }, [choice, customUnits, packages, unitPrice, minUnits]);

  async function checkout() {
    if (!order.valid) return toast.error(choice === 'custom' ? `Enter at least ${num(minUnits)} units` : 'Choose a bundle');
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return toast.error('Enter a valid receipt email, or leave it empty');
    setPaying(true);
    try {
      const res = await smsApi.buy(
        {
          ...(choice === 'custom' ? { units: order.units } : { packageId: choice }),
          method,
          email: email || undefined,
          callbackUrl: location.protocol === 'https:' ? `${location.origin}/admin/messages?tab=wallet` : undefined,
        },
        `topup-${uid()}`,
      );
      try {
        sessionStorage.setItem(LAST_TOPUP, res.payment.reference);
      } catch {
        /* storage unavailable */
      }
      location.href = res.checkoutUrl;
    } catch (e) {
      toast.error((e as ApiError).message);
      setPaying(false);
    }
  }

  async function loadMore() {
    if (!cursor) return;
    setMoreLoading(true);
    try {
      const t = await smsApi.transactions(cursor, 25);
      setTxns((x) => [...x, ...(t.transactions ?? [])]);
      setCursor(t.nextCursor ?? null);
    } catch (e) {
      toast.error((e as ApiError).message);
    } finally {
      setMoreLoading(false);
    }
  }

  if (!apiConfigured()) {
    return (
      <Card>
        <EmptyState icon={<WalletIcon />} title="SMS wallet not connected" description="Deploy the RGCI Worker with your ProfJero Connect API key to see your balance and buy units." />
      </Card>
    );
  }

  const low = wallet ? isLowBalance(wallet.availableUnits, false, church.smsLowBalanceUnits ?? wallet.lowBalanceThreshold) : false;
  const support = { email: platform?.support?.email ?? platform?.supportEmail, phone: platform?.support?.phone ?? platform?.supportPhone, whatsapp: platform?.support?.whatsapp ?? platform?.whatsapp };
  const spent = payments.filter(isPaid).reduce((s, p) => s + (p.amountGhs || 0), 0);

  return (
    <div className="space-y-5">
      {error && <Banner tone="danger" icon={<AlertTriangle />} action={<Button size="xs" variant="outline" onClick={load}>Retry</Button>}>{error}</Banner>}
      {returned && <PaymentReturn state={returned} onCheck={() => returned.payment && confirmPayment(returned.payment.reference, 3)} onDismiss={() => setReturned(null)} />}

      {/* Balance */}
      <section className="relative overflow-hidden rounded-2xl bg-brand-900 p-5 text-white shadow-[var(--shadow-card)] sm:p-6" aria-label="SMS balance">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_90%_at_100%_0%,rgb(138_82_239/0.55),transparent_60%),radial-gradient(50%_60%_at_0%_100%,rgb(201_154_46/0.22),transparent_60%)]" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[13px] font-medium text-white/70">
              <WalletIcon className="size-4" /> SMS units available
              {low && <span className="rounded-full bg-gold-300/20 px-2 py-0.5 text-[11px] font-semibold text-gold-100">Running low</span>}
            </p>
            {loading && !wallet ? (
              <div className="mt-2 h-12 w-40 animate-pulse rounded-lg bg-white/10" />
            ) : (
              <p className="mt-1 text-[2.75rem] font-semibold leading-none tracking-tight tabular" data-testid="sms-units">{wallet ? num(wallet.availableUnits) : '—'}</p>
            )}
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-white/70">
              <span>{wallet ? num(wallet.reservedUnits) : '—'} reserved for messages in flight</span>
              {unitPrice ? <span>{cedis(unitPrice)} per unit</span> : null}
              {wallet && <span>Updated {relative(wallet.updatedAt)}</span>}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="gold" icon={<Sparkles />} onClick={() => buyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Buy units</Button>
            <Button variant="ghost" size="icon" aria-label="Refresh balance" icon={<RefreshCw className={cn(loading && 'animate-spin')} />} onClick={load} className="text-white hover:bg-white/10 hover:text-white" />
          </div>
        </div>
      </section>
      {low && (
        <Banner tone="warning" icon={<AlertTriangle />} title="Your SMS balance is running low">
          Top up now so Sunday reminders, birthday wishes and giving receipts keep going out.
        </Banner>
      )}

      {/* Buy */}
      <div ref={buyRef} className="grid scroll-mt-20 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Buy SMS units" description="Pay with Mobile Money or card through ProfJero Connect. Units are added to the church wallet automatically." icon={<Sparkles />} />
          <div className="space-y-6 px-5 pb-5">
            <fieldset>
              <legend className="mb-2 text-[13px] font-semibold text-fg-2">1. Choose a bundle</legend>
              {loading && !pricing ? (
                <div className="grid gap-2 sm:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-28 rounded-xl" />)}</div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Bundles">
                  {packages.map((p) => {
                    const saving = unitPrice && perUnit(p) < unitPrice ? Math.round((1 - perUnit(p) / unitPrice) * 100) : 0;
                    const active = choice === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setChoice(p.id)}
                        className={cn('relative rounded-xl border p-3.5 text-left transition-[border,box-shadow,background]', active ? 'border-brand-500 bg-accent-soft ring-1 ring-brand-500' : 'border-line hover:border-line-strong hover:bg-surface-2/50')}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold capitalize">{p.name ?? p.id}</span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {p.id === bestValue ? <Badge tone="gold">Best value</Badge> : p.popular ? <Badge tone="brand">Popular</Badge> : null}
                            {active && <CheckCircle2 className="size-4 text-accent dark:text-brand-300" />}
                          </span>
                        </div>
                        <div className="mt-2 text-xl font-semibold tracking-tight tabular">{num(p.units)} <span className="text-sm font-normal text-fg-3">units</span></div>
                        <div className="mt-0.5 text-sm font-medium text-fg-2">{cedis(pkgPrice(p))}</div>
                        <div className="mt-1 text-xs text-fg-3">
                          {perUnit(p) ? `GH₵ ${perUnit(p).toFixed(3)} per unit` : ''}
                          {saving > 0 && <span className="ml-1.5 font-medium text-success">Save {saving}%</span>}
                        </div>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={choice === 'custom'}
                    onClick={() => setChoice('custom')}
                    className={cn('rounded-xl border border-dashed p-3.5 text-left transition-colors', choice === 'custom' ? 'border-brand-500 bg-accent-soft ring-1 ring-brand-500' : 'border-line-strong hover:bg-surface-2/50')}
                  >
                    <div className="text-sm font-semibold">Custom amount</div>
                    <div className="mt-2 text-sm text-fg-3">{unitPrice ? `${cedis(unitPrice)} per unit` : 'Any number of units'}</div>
                    <div className="mt-0.5 text-xs text-fg-3">For special campaigns</div>
                  </button>
                </div>
              )}
              {choice === 'custom' && (
                <div className="mt-3 space-y-2">
                  <Field label="Units to buy" hint={order.amount ? `≈ ${cedis(order.amount)}` : minUnits > 1 ? `Minimum ${num(minUnits)} units` : undefined}>
                    <Input type="number" inputMode="numeric" min={minUnits} step="100" value={customUnits} onChange={(e) => setCustomUnits(e.target.value)} placeholder="e.g. 2000" className="sm:max-w-xs" />
                  </Field>
                  <div className="flex flex-wrap gap-1.5">
                    {QUICK_UNITS.map((u) => (
                      <button key={u} type="button" onClick={() => setCustomUnits(String(u))} className={cn('rounded-full border px-3 py-1 text-xs font-medium tabular transition-colors', Number(customUnits) === u ? 'border-brand-500 bg-accent-soft text-accent-soft-fg' : 'border-line text-fg-2 hover:bg-surface-2')}>
                        {num(u)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-[13px] font-semibold text-fg-2">2. Payment method</legend>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Payment method">
                {([
                  ['mobile_money', <Smartphone key="m" />, 'Mobile Money', 'MTN MoMo, Telecel Cash, AT Money'],
                  ['card', <CreditCard key="c" />, 'Debit or credit card', 'Visa, Mastercard'],
                ] as const).map(([value, icon, label, sub]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={method === value}
                    onClick={() => setMethod(value)}
                    className={cn('flex items-center gap-3 rounded-xl border p-3 text-left transition-colors', method === value ? 'border-brand-500 bg-accent-soft ring-1 ring-brand-500' : 'border-line hover:border-line-strong')}
                  >
                    <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-[18px]', method === value ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-fg-2')}>{icon}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{label}</span>
                      <span className="block truncate text-xs text-fg-3">{sub}</span>
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>

            <TextField label="Receipt email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="finance@church.org" hint="ProfJero Connect sends the payment receipt here." />
          </div>
        </Card>

        <Card className="h-fit lg:sticky lg:top-20">
          <CardHeader title="Order summary" icon={<Receipt />} />
          <div className="space-y-4 px-5 pb-5">
            <dl className="space-y-2 text-sm">
              <Row label="Bundle" value={<span className="capitalize">{order.label || '—'}</span>} />
              <Row label="Units" value={order.units ? num(order.units) : '—'} />
              <Row label="Payment" value={method === 'card' ? 'Card' : 'Mobile Money'} />
              {wallet && order.units > 0 && <Row label="Balance after" value={`${num(wallet.availableUnits + order.units)} units`} />}
            </dl>
            <div className="flex items-baseline justify-between border-t border-line pt-3">
              <span className="text-sm font-medium text-fg-2">Total</span>
              <span className="text-2xl font-semibold tracking-tight tabular">{order.amount != null ? cedis(order.amount) : '—'}</span>
            </div>
            <Button className="w-full" size="lg" icon={<ShieldCheck />} onClick={checkout} loading={paying} disabled={!order.valid}>
              Continue to secure checkout
            </Button>
            <p className="text-xs leading-relaxed text-fg-3">
              You’ll finish payment on ProfJero Connect’s secure checkout, then come back here. Units are credited automatically once payment is confirmed — usually within a minute.
            </p>
          </div>
        </Card>
      </div>

      {/* History */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Purchase history" description={spent ? `${cedis(spent)} spent on SMS units` : 'Top-ups paid from this account'} />
          {loading && !payments.length ? (
            <div className="px-5 pb-5"><Spinner /></div>
          ) : payments.length === 0 ? (
            <EmptyState compact title="No purchases yet" description="Your top-ups will appear here." />
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {payments.map((p) => (
                <PaymentRow key={p.reference} p={p} onCheck={() => confirmPayment(p.reference, 1)} />
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Wallet activity" description="Top-ups, message charges and refunds" />
          {loading && !txns.length ? (
            <div className="px-5 pb-5"><Spinner /></div>
          ) : txns.length === 0 ? (
            <EmptyState compact title="No wallet activity yet" />
          ) : (
            <>
              <ul className="max-h-[420px] divide-y divide-line overflow-y-auto border-t border-line">
                {txns.map((t, i) => {
                  const d = t.delta ?? t.units ?? 0;
                  return (
                    <li key={t.id ?? i} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                      <span className={cn('grid size-7 shrink-0 place-items-center rounded-full [&_svg]:size-3.5', d >= 0 ? 'bg-success-soft text-success' : 'bg-surface-2 text-fg-2')}>{d >= 0 ? <ArrowDownLeft /> : <ArrowUpRight />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{t.description ?? (t.type ? t.type.replace(/_/g, ' ') : 'Transaction')}</span>
                        {t.createdAt && <span className="block text-xs text-fg-3">{fmtDateTime(t.createdAt)}</span>}
                      </span>
                      <span className={cn('shrink-0 font-semibold tabular', d >= 0 ? 'text-success' : 'text-fg')}>{d > 0 ? '+' : ''}{num(d)}</span>
                    </li>
                  );
                })}
              </ul>
              {cursor && (
                <div className="border-t border-line p-3 text-center">
                  <Button size="sm" variant="ghost" onClick={loadMore} loading={moreLoading}>Load older activity</Button>
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-soft-fg"><LifeBuoy className="size-5" /></span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold">How SMS units work</p>
          <p className="mt-0.5 text-fg-3">
            One unit = one SMS page to one person. Standard text fits 160 characters per page (153 when longer). Emoji and symbols like ₵ or “smart quotes” switch to Unicode — 70 characters per page — so the composer warns you and offers a fix. Failed messages are refunded automatically.
          </p>
        </div>
        {(support.email || support.phone || support.whatsapp) && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {support.whatsapp && <a className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium hover:bg-surface-2" href={`https://wa.me/${support.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer"><MessageCircle className="size-4" />WhatsApp</a>}
            {support.phone && <a className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium hover:bg-surface-2" href={`tel:${support.phone}`}><Phone className="size-4" />Call</a>}
            {support.email && <a className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium hover:bg-surface-2" href={`mailto:${support.email}`}><Mail className="size-4" />Email support</a>}
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-fg-3">{label}</dt>
      <dd className="font-medium tabular">{value}</dd>
    </div>
  );
}

function statusOf(p: PjPayment) {
  if (isPaid(p)) return { label: 'Paid', tone: 'success' as const };
  if (isFailed(p)) return { label: p.status === 'cancelled' || p.status === 'canceled' ? 'Cancelled' : 'Failed', tone: 'danger' as const };
  return { label: 'Pending', tone: 'warning' as const };
}

function PaymentRow({ p, onCheck }: { p: PjPayment; onCheck: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const st = statusOf(p);
  return (
    <li className="flex items-center gap-3 px-5 py-3 text-sm">
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{num(p.units)} units · {cedis(p.amountGhs)}</span>
        <span className="block truncate text-xs text-fg-3">{fmtDateTime(p.paidAt ?? p.createdAt ?? null) || '—'} · <span className="font-mono">{p.reference}</span></span>
      </span>
      {st.label === 'Pending' && (
        <Button size="xs" variant="outline" loading={busy} onClick={async () => { setBusy(true); await onCheck(); setBusy(false); }}>Check</Button>
      )}
      <Badge tone={st.tone}>{st.label}</Badge>
    </li>
  );
}

function PaymentReturn({ state, onCheck, onDismiss }: { state: { payment: PjPayment | null; checking: boolean }; onCheck: () => void; onDismiss: () => void }) {
  const p = state.payment;
  if (!p) return <Banner tone="info" icon={<Spinner className="size-4" />} title="Confirming your payment…">Checking with ProfJero Connect.</Banner>;
  if (isPaid(p)) {
    return (
      <Banner tone="success" icon={<CheckCircle2 />} title={`Payment received — ${num(p.units)} units added`} action={<Button size="xs" variant="outline" onClick={onDismiss}>Done</Button>}>
        {cedis(p.amountGhs)} · reference <span className="font-mono">{p.reference}</span>
      </Banner>
    );
  }
  if (isFailed(p)) {
    return (
      <Banner tone="danger" icon={<XCircle />} title="Payment was not completed" action={<Button size="xs" variant="outline" onClick={onDismiss}>Dismiss</Button>}>
        No money was taken for reference <span className="font-mono">{p.reference}</span>. You can try again below.
      </Banner>
    );
  }
  return (
    <Banner
      tone="warning"
      icon={state.checking ? <Spinner className="size-4" /> : <Clock3 />}
      title={state.checking ? 'Waiting for payment confirmation…' : 'Payment is still pending'}
      action={!state.checking && <Button size="xs" variant="outline" onClick={onCheck}>Check again</Button>}
    >
      If you approved the Mobile Money prompt, units will be added automatically once the network confirms. Reference <span className="font-mono">{p.reference}</span>.
    </Banner>
  );
}
