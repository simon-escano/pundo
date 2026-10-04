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
      className="fixed inset-0 z-[60] flex min-h-dvh flex-col justify-between bg-accent px-7 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))] text-accent-ink outline-none"
    >
      <span className="flex items-center gap-2.5">
        <LogoMark className="size-10 rounded-[0.9rem] ring-1 ring-white/50" />
        <span translate="no" className="font-display text-[1.45rem] font-extrabold leading-none">pundo</span>
      </span>
      <m.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="max-w-md">
        <h1 id="signin-title" className="font-display text-[3.4rem] font-extrabold leading-[0.92] tracking-tight">You’re signed out</h1>
        <p className="mt-4 text-lg opacity-90">Your plan is saved on this device. Sign in to sync it again.</p>
      </m.div>
      <div className="flex w-full max-w-md flex-col gap-2">
        <Button icon={LogIn} className="h-14 bg-accent-ink text-base text-accent hover:brightness-95" onClick={() => window.location.assign(accessLoginUrl(window.location))}>
          Sign in
        </Button>
        <Button variant="ghost" icon={CloudOff} className="text-accent-ink hover:bg-black/10" onClick={onDismiss}>Keep working offline</Button>
      </div>
    </m.div>,
    document.body,
  );
}
