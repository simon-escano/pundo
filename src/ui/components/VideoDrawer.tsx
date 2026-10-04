import { useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { ChevronDown, ExternalLink, Play, WifiOff } from "lucide-react";
import type { z } from "zod";
import type { VideoRefSchema } from "../../domain/schemas/blueprint";
import { toEmbed } from "../../domain/video/embed";
import { useOnline } from "../hooks/useOnline";
import { cx, LinkButton } from "./ui";

type Video = z.infer<typeof VideoRefSchema>;

/** Collapsible 9:16 player. Offline (or un-embeddable) videos degrade to a clear message plus a plain link. */
export function VideoDrawer({ videos }: { videos: readonly Video[] }) {
  const [open, setOpen] = useState(false);
  const online = useOnline();
  if (videos.length === 0) return null;
  return (
    <div className="mt-3" data-testid="video-drawer">
      <button type="button" className="flex min-h-[44px] w-full items-center gap-2 rounded-xl px-1 text-sm font-semibold hover:bg-sunken" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Play aria-hidden className="size-4" />
        <span className="flex-1 text-left">Watch reel{videos.length > 1 ? `s (${videos.length})` : ""}</span>
        <ChevronDown aria-hidden className={cx("size-5 text-muted transition-transform duration-200", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="flex flex-col gap-3 pt-2">
              {videos.map((v) => {
                const e = toEmbed(v);
                return (
                  <figure key={v.url} className="mx-auto w-full max-w-[240px]">
                    <div className="relative aspect-[9/16] w-full overflow-hidden rounded-2xl bg-ink" data-testid="video-frame">
                      {!online ? (
                        <div className="flex h-full flex-col items-center justify-center gap-3 p-3 text-center text-sm font-medium text-surface" data-testid="video-offline">
                          <WifiOff aria-hidden className="size-6" />
                          <p>Offline: video unavailable</p>
                          <LinkButton icon={ExternalLink} href={v.url} target="_blank" rel="noreferrer">Open link</LinkButton>
                        </div>
                      ) : e.kind === "iframe" ? (
                        <iframe title={v.title} src={e.src} loading="lazy" className="absolute inset-0 h-full w-full" allow="fullscreen; picture-in-picture" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation" />
                      ) : e.kind === "video" ? (
                        <video className="absolute inset-0 h-full w-full" src={e.src} controls playsInline preload="none" />
                      ) : (
                        <div className="flex h-full items-center justify-center p-3">
                          <LinkButton icon={ExternalLink} href={e.href} target="_blank" rel="noreferrer">Open video</LinkButton>
                        </div>
                      )}
                    </div>
                    <figcaption className="mt-1 text-center text-xs text-muted">{v.title}</figcaption>
                  </figure>
                );
              })}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
