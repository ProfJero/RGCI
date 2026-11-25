import { useSearchParams } from 'react-router';
import { Send, Sparkles, AlertTriangle, Wallet as WalletIcon } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useChurch } from '@/lib/settings';
import { isLowBalance, useSmsBalance } from '@/lib/sms-balance';
import { apiConfigured } from '@/lib/api';
import { num, relative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Page, PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { NoAccess } from '@/features/misc/NoAccess';
import { Compose } from './Compose';
import { SmsHistory } from './SmsHistory';
import { Templates } from './Templates';
import { Wallet } from './Wallet';
import { PushPanel } from './PushPanel';
import { Scheduled } from './Scheduled';
import { SenderIds } from './SenderIds';

export default function Messages() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const sms = can('messaging.sms');
  const push = can('messaging.push');
  const billing = can('messaging.billing');
  if (!sms && !push && !billing) return <NoAccess />;
  const tab = params.get('tab') ?? (sms ? 'compose' : billing ? 'wallet' : 'push');
  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };

  return (
    <Page width="wide">
      <PageHeader
        title="Messages"
        description={sms ? 'SMS through ProfJero Connect and free push notifications to the app.' : 'SMS units for the church’s ProfJero Connect wallet.'}
        actions={sms && tab !== 'compose' ? <Button icon={<Send />} onClick={() => setTab('compose')}>New SMS</Button> : undefined}
      />
      {billing && tab !== 'wallet' && <BalanceStrip onBuy={() => setTab('wallet')} />}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className={cn([sms, billing, push].filter(Boolean).length === 1 && !sms && 'hidden')}>
          {sms && <TabsTrigger value="compose">New SMS</TabsTrigger>}
          {sms && <TabsTrigger value="history">History</TabsTrigger>}
          {sms && <TabsTrigger value="scheduled">Scheduled</TabsTrigger>}
          {sms && <TabsTrigger value="templates">Templates</TabsTrigger>}
          {billing && <TabsTrigger value="wallet">SMS credits</TabsTrigger>}
          {sms && <TabsTrigger value="senders">Sender IDs</TabsTrigger>}
          {push && <TabsTrigger value="push">Push notifications</TabsTrigger>}
        </TabsList>
        {sms && <TabsContent value="compose" className="mt-5"><Compose onSent={() => setTab('history')} /></TabsContent>}
        {sms && <TabsContent value="history" className="mt-5"><SmsHistory /></TabsContent>}
        {sms && <TabsContent value="scheduled" className="mt-5"><Scheduled /></TabsContent>}
        {sms && <TabsContent value="templates" className="mt-5"><Templates /></TabsContent>}
        {billing && <TabsContent value="wallet" className="mt-5"><Wallet /></TabsContent>}
        {sms && <TabsContent value="senders" className="mt-5"><SenderIds /></TabsContent>}
        {push && <TabsContent value="push" className="mt-5"><PushPanel /></TabsContent>}
      </Tabs>
    </Page>
  );
}

/** Always-visible balance so nobody composes a big send into an empty wallet. */
function BalanceStrip({ onBuy }: { onBuy: () => void }) {
  const church = useChurch();
  const bal = useSmsBalance(apiConfigured());
  if (!apiConfigured()) return null;
  const low = isLowBalance(bal.units, bal.low, church.smsLowBalanceUnits);
  return (
    <div className={cn('mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-2.5 text-sm', low ? 'border-warning/25 bg-warning-soft' : 'border-line bg-surface')}>
      <span className={cn('grid size-8 place-items-center rounded-lg [&_svg]:size-4', low ? 'bg-warning/15 text-warning' : 'bg-accent-soft text-accent-soft-fg')}>
        {low ? <AlertTriangle /> : <WalletIcon />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-semibold tabular" data-testid="balance-strip-units">{bal.units == null ? (bal.loading ? '…' : '—') : num(bal.units)}</span>
        <span className="text-fg-2"> SMS units available</span>
        {low && <span className="text-warning"> · running low</span>}
        {bal.updatedAt && <span className="hidden text-fg-3 sm:inline"> · updated {relative(bal.updatedAt)}</span>}
        {bal.error && !bal.units && <span className="text-fg-3"> · {bal.error}</span>}
      </span>
      <Button size="sm" variant={low ? 'gold' : 'soft'} icon={<Sparkles />} onClick={onBuy}>Buy units</Button>
    </div>
  );
}
