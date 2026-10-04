import { RotateCw, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { Button, IconButton } from "./ui";

/** Service-worker lifecycle: "ready offline" notice once, and a Reload button when a new version is waiting. */
export function UpdatePrompt() {
  const { offlineReady: [offlineReady, setOfflineReady], needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW();
  const show = offlineReady || needRefresh;
  return (
    <AnimatePresence>
      {show && (
        <m.div
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -16 }}
          role="status"
          data-testid="pwa-prompt"
          className="fixed inset-x-4 top-[calc(3.75rem+env(safe-area-inset-top))] z-40 mx-auto flex max-w-md items-center gap-2 rounded-full bg-bar py-1.5 pl-5 pr-1.5 text-sm font-medium text-bar-ink shadow-float"
        >
          <span className="flex-1">{needRefresh ? "A new version is ready." : "Ready to work offline."}</span>
          {needRefresh && <Button variant="primary" icon={RotateCw} onClick={() => void updateServiceWorker(true)}>Reload</Button>}
          <IconButton icon={X} label="Dismiss" className="text-bar-ink hover:bg-white/10" onClick={() => { setOfflineReady(false); setNeedRefresh(false); }} />
        </m.div>
      )}
    </AnimatePresence>
  );
}
