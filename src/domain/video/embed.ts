import type { z } from "zod";
import type { VideoRefSchema } from "../schemas/blueprint";

type VideoRef = z.infer<typeof VideoRefSchema>;

export type VideoEmbed =
  | { kind: "iframe"; src: string; host: string }
  | { kind: "video"; src: string }
  | { kind: "link"; href: string }; // un-embeddable URL: offer an "open" link instead

/** Hosts the CSP `frame-src` must allow (kept here so code and policy cannot drift). */
export const EMBED_HOSTS = ["www.youtube-nocookie.com", "www.instagram.com", "www.tiktok.com"] as const;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Map a stored VideoRef to something safely embeddable (9:16 container). Pure: no network. */
export function toEmbed(v: VideoRef): VideoEmbed {
  const u = parse(v.url);
  if (!u || !["http:", "https:"].includes(u.protocol)) return { kind: "link", href: v.url };
  const parts = u.pathname.split("/").filter(Boolean);
  switch (v.platform) {
    case "youtube_shorts": {
      const id = parts[0] === "shorts" ? parts[1] : u.hostname === "youtu.be" ? parts[0] : u.searchParams.get("v");
      return id && /^[\w-]{6,}$/.test(id) ? { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${id}`, host: "www.youtube-nocookie.com" } : { kind: "link", href: v.url };
    }
    case "instagram_reel": {
      const i = parts.findIndex((p) => p === "reel" || p === "reels" || p === "p");
      const code = i >= 0 ? parts[i + 1] : undefined;
      return code && /^[\w-]+$/.test(code) ? { kind: "iframe", src: `https://www.instagram.com/reel/${code}/embed`, host: "www.instagram.com" } : { kind: "link", href: v.url };
    }
    case "tiktok": {
      const i = parts.indexOf("video");
      const id = i >= 0 ? parts[i + 1] : undefined;
      return id && /^\d+$/.test(id) ? { kind: "iframe", src: `https://www.tiktok.com/embed/v2/${id}`, host: "www.tiktok.com" } : { kind: "link", href: v.url };
    }
    case "direct_mp4":
      return { kind: "video", src: v.url };
  }
}
