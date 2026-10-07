'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

export const metadata = { title: 'Something went wrong' };

/**
 * Root error boundary. Renders for uncaught exceptions in server components and
 * client trees, keeps the frost styling and offers a retry without a reload.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The panel logs to the server; this keeps the browser console useful too.
    console.error('[panel] render error', error);
  }, [error]);

  return (
    <main className="frost-bg frost-grid flex min-h-screen items-center justify-center p-6">
      <Card tone="red" className="relative z-10 w-full max-w-xl">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-500/20 text-lg text-red-200"
          >
            !
          </span>
          <div className="min-w-0">
            <h1 className="font-display text-lg font-semibold tracking-display text-white/90">
              The panel hit an unexpected error
            </h1>
            <p className="mt-1 text-sm text-white/60">
              Nothing was lost — relay state lives in the process, not in this view. You can retry the
              render, or reload the page if the problem persists.
            </p>
            <p className="mt-3 break-words rounded-lg border border-white/10 bg-black/20 p-2 font-mono text-[11px] text-red-200/90">
              {error.message || 'Unknown error'}
              {error.digest ? ` · digest ${error.digest}` : ''}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="frost" onClick={() => reset()}>
                Try again
              </Button>
              <Button variant="ghost" onClick={() => window.location.reload()}>
                Reload panel
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </main>
  );
}
