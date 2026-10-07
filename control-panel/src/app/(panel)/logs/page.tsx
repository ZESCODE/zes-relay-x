import type { Metadata } from 'next';
import { LogViewer } from '@/components/logs/LogViewer';
import { SectionTitle } from '@/components/ui/Card';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Logs' };

export default function LogsPage() {
  return (
    <div className="space-y-4">
      <SectionTitle hint="relay stdout/stderr · panel · access log">
        Logs
      </SectionTitle>
      <p className="max-w-3xl text-xs text-white/45">
        The viewer tails the in-process ring buffer over SSE. Relay lines keep the{' '}
        <span className="font-mono">[pol-relay]</span> prefix and recognised access records are parsed into
        method, path, status, duration and model — those parsed records also feed the dashboard metrics. The
        full history is also written to <span className="font-mono">data/logs/panel.jsonl</span> with
        size-based rotation.
      </p>
      <LogViewer />
    </div>
  );
}
