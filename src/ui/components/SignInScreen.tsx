import { CloudOff, LogIn } from "lucide-react";
import { m } from "motion/react";
import { createPortal } from "react-dom";
import { Logo } from "./Logo";
import { Button, useModalBehavior } from "./ui";

/** Where Cloudflare Access hosts the login for this app; it returns the user to the page they were on. */
export const accessLoginUrl = (loc: Pick<Location, "hostname" | "pathname" | "search" | "hash">) =>
  `/cdn-cgi/access/login/${loc.hostname}?redirect_url=${encodeURIComponent(`${loc.pathname}${loc.search}${loc.hash}`)}`;

/**
 * Full-screen "signed out" page. The login itself is Cloudflare's (the app never sees a password); this explains what
 * happened, reassures that nothing is lost, and offers a way back in.
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
      className="fixed inset-0 z-[60] flex min-h-dvh flex-col items-center justify-center bg-surface px-6 outline-none"
    >
      <m.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="flex w-full max-w-sm flex-col items-center text-center">
        <Logo />
        <h1 id="signin-title" className="mt-10 text-2xl font-semibold">You’re signed out</h1>
        <p className="mt-2 text-muted">Your plan is saved on this device. Sign in to sync it again.</p>
        <Button variant="primary" icon={LogIn} className="mt-8 w-full" onClick={() => window.location.assign(accessLoginUrl(window.location))}>
          Sign in
        </Button>
        <Button variant="ghost" icon={CloudOff} className="mt-2 w-full" onClick={onDismiss}>Keep working offline</Button>
      </m.div>
    </m.div>,
    document.body,
  );
}
