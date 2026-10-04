import { useState } from "react";
import type { z } from "zod";
import type { VideoRefSchema } from "../../domain/schemas/blueprint";
import { toEmbed } from "../../domain/video/embed";
import { useOnline } from "../hooks/useOnline";

type Video = z.infer<typeof VideoRefSchema>;

/** Collapsible 9:16 player. Offline (or un-embeddable) videos degrade to a clear message plus a plain link. */
export function VideoDrawer({ videos }: { videos: readonly Video[] }) {
  const [open, setOpen] = useState(false);
  const online = useOnline();
  if (videos.length === 0) return null;
  return (
    <div className="mt-3" data-testid="video-drawer">
      <button className="btn w-full justify-between" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>▶ Reel{videos.length > 1 ? `s (${videos.length})` : ""}</span>
        <span aria-hidden>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-3">
          {videos.map((v) => {
            const e = toEmbed(v);
            return (
              <figure key={v.url} className="mx-auto w-full max-w-[240px]">
                <div className="relative aspect-[9/16] w-full overflow-hidden rounded-lg border-2 border-ink bg-stone-900" data-testid="video-frame">
                  {!online ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-sm font-semibold text-white" data-testid="video-offline">
                      <p>Offline: video unavailable</p>
                      <a className="btn" href={v.url} target="_blank" rel="noreferrer">Open link</a>
                    </div>
                  ) : e.kind === "iframe" ? (
                    <iframe title={v.title} src={e.src} loading="lazy" className="absolute inset-0 h-full w-full" allow="fullscreen; picture-in-picture" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation" />
                  ) : e.kind === "video" ? (
                    <video className="absolute inset-0 h-full w-full" src={e.src} controls playsInline preload="none" />
                  ) : (
                    <div className="flex h-full items-center justify-center p-3">
                      <a className="btn" href={e.href} target="_blank" rel="noreferrer">Open video</a>
                    </div>
                  )}
                </div>
                <figcaption className="mt-1 text-center text-xs font-semibold muted">{v.title}</figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </div>
  );
}
