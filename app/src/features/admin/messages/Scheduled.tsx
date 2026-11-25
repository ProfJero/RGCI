import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, CalendarX, RefreshCw, AlertTriangle, Repeat, Cake } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { patchDoc } from '@/lib/db';
import { useSmsMessages } from '@/lib/queries';
import { fmtDateTime, num, relative } from '@/lib/format';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Banner, EmptyState, SkeletonRows } from '@/components/ui/feedback';
import { useConfirm } from '@/components/ui/confirm';
import { smsApi, type PjCampaign } from './sms-client';

const TONE: Record<string, 'brand' | 'success' | 'neutral' | 'warning' | 'danger' | 'info'> = {
  scheduled: 'brand', active: 'info', running: 'info', sending: 'info', completed: 'success', sent: 'success', cancelled: 'neutral', canceled: 'neutral', paused: 'warning', failed: 'danger',
};

/**
 * Every scheduled, recurring and birthday campaign on the ProfJero Connect account —
 * including ones created in the ProfJero dashboard — with one-tap cancel.
 */
export function Scheduled() {
  const confirm = useConfirm();
  const { data: history } = useSmsMessages();
  const [rows, setRows] = useState<PjCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await smsApi.campaigns();
      const order = (c: PjCampaign) => (['scheduled', 'active', 'running', 'paused'].includes(c.status) ? 0 : 1);
      setRows([...(r.campaigns ?? [])].sort((a, b) => order(a) - order(b) || String(a.nextRunAt ?? '').localeCompare(String(b.nextRunAt ?? ''))));
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancel(c: PjCampaign) {
    const ok = await confirm({ title: 'Cancel this scheduled send?', description: 'It won’t be sent and no units will be charged.', danger: true, confirmLabel: 'Cancel send' });
    if (!ok) return;
    try {
      await smsApi.cancelCampaign(c.id);
      const local = history.find((m) => m.campaignId === c.id);
      if (local) await patchDoc('sms_messages', local.id, { status: 'cancelled' });
      toast.success('Scheduled send cancelled');
      setRows((r) => r.map((x) => (x.id === c.id ? { ...x, status: 'cancelled', nextRunAt: null } : x)));
    } catch (e) {
      toast.error((e as ApiError).message);
    }
  }

  const upcoming = rows.filter((c) => ['scheduled', 'active', 'running', 'paused'].includes(c.status));
  const units = upcoming.reduce((s, c) => s + (c.estimate?.units ?? 0), 0);

  return (
    <Card>
      <CardHeader
        title="Scheduled & recurring sends"
        description={upcoming.length ? `${upcoming.length} upcoming · about ${num(units)} units will be charged when they send` : 'Messages waiting to go out, including those set up in the ProfJero Connect dashboard.'}
        icon={<CalendarClock />}
        action={<Button size="icon-sm" variant="ghost" aria-label="Refresh" icon={<RefreshCw />} onClick={load} />}
      />
      {error && <div className="px-5 pb-4"><Banner tone="danger" icon={<AlertTriangle />}>{error}</Banner></div>}
      {loading && !rows.length ? (
        <div className="px-5 pb-5"><SkeletonRows rows={3} /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<CalendarClock />} title="Nothing scheduled" description="Choose “Schedule for later” when composing an SMS to plan reminders ahead." />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {rows.map((c) => {
            const live = ['scheduled', 'active', 'running', 'paused'].includes(c.status);
            const local = history.find((m) => m.campaignId === c.id);
            const Icon = c.type === 'birthday' ? Cake : c.type === 'recurring' ? Repeat : CalendarClock;
            return (
              <li key={c.id} className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center">
                <span className="hidden size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-fg-2 sm:grid"><Icon className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{c.name || local?.audience || (c.type ? `${c.type[0].toUpperCase()}${c.type.slice(1)} campaign` : `Campaign ${c.id}`)}</span>
                    <Badge tone={TONE[c.status] ?? 'neutral'}>{c.status}</Badge>
                  </div>
                  {(c.message || local?.message) && <p className="mt-0.5 line-clamp-1 text-[13px] text-fg-3">{c.message || local?.message}</p>}
                  <p className="mt-1 text-xs text-fg-3">
                    {c.nextRunAt ? <>Sends {fmtDateTime(c.nextRunAt)} ({relative(c.nextRunAt)})</> : c.lastRunAt ? <>Last ran {fmtDateTime(c.lastRunAt)}</> : null}
                    {c.estimate ? <> · {num(c.estimate.recipients)} recipients · ~{num(c.estimate.units)} units</> : null}
                    {c.senderId ? <> · from {c.senderId}</> : null}
                  </p>
                </div>
                {live && (
                  <Button size="sm" variant="outline" icon={<CalendarX />} onClick={() => cancel(c)} className="self-start sm:self-center">Cancel</Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
