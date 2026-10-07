/**
 * Route-level loading skeleton. Shown while a panel page's server component
 * gathers its first payload (relay status, metrics, logs…).
 */
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the panel…</span>
      <div className="glass-card h-24 animate-pulse-glow rounded-2xl" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="glass-card h-28 rounded-2xl opacity-70" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="glass-card h-72 rounded-2xl opacity-60" />
        <div className="glass-card h-72 rounded-2xl opacity-60" />
      </div>
    </div>
  );
}
