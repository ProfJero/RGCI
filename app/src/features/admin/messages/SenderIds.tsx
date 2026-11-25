import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, RefreshCw, AlertTriangle, Star, Info } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { upsertDoc } from '@/lib/db';
import { useAuth } from '@/lib/auth';
import { useChurch } from '@/lib/settings';
import { fmtDate } from '@/lib/format';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Banner, EmptyState, SkeletonRows } from '@/components/ui/feedback';
import { smsApi, type PjSenderId } from './sms-client';

const STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  approved: { label: 'Approved', tone: 'success' },
  pending: { label: 'Awaiting approval', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'danger' },
};

/** The names recipients see as the sender. Approved ones can be used; the church default is starred. */
export function SenderIds() {
  const { can } = useAuth();
  const church = useChurch();
  const [rows, setRows] = useState<PjSenderId[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRows((await smsApi.senderIds()).senderIds ?? []);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function makeDefault(id: string) {
    setSaving(id);
    try {
      await upsertDoc('settings', 'church', { smsSenderId: id }, { audit: `Set default SMS Sender ID to ${id}` });
      toast.success(`${id} is now the default Sender ID`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving('');
    }
  }

  const approved = rows.filter((r) => r.status === 'approved');
  const defaultMissing = church.smsSenderId && rows.length > 0 && !approved.some((r) => r.senderId === church.smsSenderId);

  return (
    <div className="space-y-4">
      {defaultMissing && (
        <Banner tone="warning" icon={<AlertTriangle />} title={`The default Sender ID “${church.smsSenderId}” isn’t approved`}>
          Messages will fail until it is approved, or choose an approved Sender ID below.
        </Banner>
      )}
      <Card>
        <CardHeader
          title="Sender IDs"
          description="The name people see as the sender of your SMS (up to 11 characters)."
          icon={<BadgeCheck />}
          action={<Button size="icon-sm" variant="ghost" aria-label="Refresh" icon={<RefreshCw />} onClick={load} />}
        />
        {error && <div className="px-5 pb-4"><Banner tone="danger" icon={<AlertTriangle />}>{error}</Banner></div>}
        {loading && !rows.length ? (
          <div className="px-5 pb-5"><SkeletonRows rows={2} /></div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<BadgeCheck />} title="No Sender IDs yet" description="Request one in the ProfJero Connect dashboard (Messaging → Sender IDs). Approval usually takes 1–3 working days." />
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {rows.map((r) => {
              const st = STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
              const isDefault = church.smsSenderId === r.senderId;
              return (
                <li key={r.senderId} className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center">
                  <span className="grid h-10 min-w-24 shrink-0 place-items-center self-start rounded-lg border border-line bg-surface-2 px-3 font-mono text-sm font-semibold tracking-wide sm:self-center">{r.senderId}</span>
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={st.tone} dot>{st.label}</Badge>
                      {isDefault && <Badge tone="brand"><Star className="size-3" /> Church default</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-fg-3">
                      {r.purpose || 'No purpose given'}
                      {r.createdAt ? ` · requested ${fmtDate(r.createdAt)}` : ''}
                      {r.rejectionReason ? ` · ${r.rejectionReason}` : ''}
                    </p>
                  </div>
                  {r.status === 'approved' && !isDefault && can('settings.manage') && (
                    <Button size="sm" variant="outline" loading={saving === r.senderId} onClick={() => makeDefault(r.senderId)} className="self-start sm:self-center">Make default</Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card className="flex flex-col gap-3 p-5 text-sm sm:flex-row sm:items-center">
        <Info className="size-5 shrink-0 text-fg-3" />
        <p className="flex-1 text-fg-3">
          New Sender IDs are requested and approved in your ProfJero Connect account. Networks in Ghana require an approved Sender ID for every message, so choose a name members recognise, such as <span className="font-mono">RGCI</span> or <span className="font-mono">RGCIntl</span>.
        </p>
      </Card>
    </div>
  );
}
