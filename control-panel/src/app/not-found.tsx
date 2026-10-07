import Link from 'next/link';
import { Card } from '@/components/ui/Card';

export const metadata = { title: 'Not found' };

/** 404 page — never leaks whether a route exists behind authentication. */
export default function NotFound() {
  return (
    <main className="frost-bg frost-grid flex min-h-screen items-center justify-center p-6">
      <Card tone="plain" className="relative z-10 w-full max-w-lg text-center">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">404 · not found</p>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-display text-white/90">
          That page drifted off the panel
        </h1>
        <p className="mt-2 text-sm text-white/55">
          The route you asked for does not exist. The five consoles below are the whole surface area.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {(
            [
              ['/dashboard', 'Dashboard'],
              ['/playground', 'Playground'],
              ['/logs', 'Logs'],
              ['/config', 'Config'],
              ['/admin', 'Admin'],
            ] as Array<[string, string]>
          ).map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="glass-btn inline-flex h-9 items-center rounded-xl px-3 text-sm text-white/85"
            >
              {label}
            </Link>
          ))}
        </div>
      </Card>
    </main>
  );
}
