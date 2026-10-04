import { CloudOff, LogIn } from "lucide-react";
import { m } from "motion/react";
import { createPortal } from "react-dom";
import { LogoMark } from "./Logo";
import { Button, useModalBehavior } from "./ui";

/** Where Cloudflare Access hosts the login for this app; it returns the user to the page they were on. */
export const accessLoginUrl = (loc: Pick<Location, "hostname" | "pathname" | "search" | "hash">) =>
  `/cdn-cgi/access/login/${loc.hostname}?redirect_url=${encodeURIComponent(`${loc.pathname}${loc.search}${loc.hash}`)}`;

/**
 * Full-screen "signed out" page, in the pundo orange. The login itself is Cloudflare's (the app never sees a password);
 * this explains what happened, reassures that nothing is lost, and offers a way back in.
 */
export function SignInScreen({ onDismiss }: { onDismiss: () => void }) {
  const panel = useModalBehavior(onDismiss);
  return createPortal(
    <m.div
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="signin-title"
      data-testid="signin-screen"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[60] grid min-h-dvh place-items-center overflow-y-auto bg-accent px-7 py-[max(2rem,env(safe-area-inset-top))] text-accent-ink outline-none"
    >
      <m.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="flex w-full max-w-sm flex-col items-center text-center">
        <LogoMark className="size-24 drop-shadow-[0_10px_18px_rgb(60_20_0/0.35)]" />
        <h1 id="signin-title" className="mt-8 font-display text-[2.9rem] font-extrabold leading-[0.95] tracking-tight">You’re signed out</h1>
        <p className="mt-3 max-w-xs text-lg opacity-90">Your plan is saved on this device. Sign in to sync it again.</p>
        <Button icon={LogIn} className="mt-9 h-14 w-full bg-accent-ink text-base text-accent hover:brightness-95" onClick={() => window.location.assign(accessLoginUrl(window.location))}>
          Sign in
        </Button>
        <Button variant="ghost" icon={CloudOff} className="mt-2 w-full !text-accent-ink hover:bg-black/10" onClick={onDismiss}>Keep working offline</Button>
      </m.div>
    </m.div>,
    document.body,
  );
}
