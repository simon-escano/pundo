import { useRegisterSW } from "virtual:pwa-register/react";

/** Service-worker lifecycle: "ready offline" notice once, and a Reload button when a new version is waiting. */
export function UpdatePrompt() {
  const { offlineReady: [offlineReady, setOfflineReady], needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW();
  if (!offlineReady && !needRefresh) return null;
  return (
    <div role="status" data-testid="pwa-prompt" className="mx-auto mt-2 flex max-w-5xl items-center gap-2 rounded-lg border-2 border-ink bg-white px-3 py-2 text-sm font-semibold">
      <span className="flex-1">{needRefresh ? "A new version is ready." : "Ready to work offline."}</span>
      {needRefresh && <button className="btn btn-primary" onClick={() => void updateServiceWorker(true)}>Reload</button>}
      <button className="btn" aria-label="Dismiss" onClick={() => { setOfflineReady(false); setNeedRefresh(false); }}>✕</button>
    </div>
  );
}
