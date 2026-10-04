import { describe, expect, it } from "vitest";
import { toEmbed, EMBED_HOSTS } from "./embed";

const v = (platform: Parameters<typeof toEmbed>[0]["platform"], url: string) => toEmbed({ title: "t", platform, url });

describe("toEmbed", () => {
  it("YouTube Shorts → nocookie embed (shorts path, youtu.be and ?v= forms)", () => {
    const want = { kind: "iframe", src: "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ", host: "www.youtube-nocookie.com" };
    expect(v("youtube_shorts", "https://www.youtube.com/shorts/aqz-KE-bpKQ")).toEqual(want);
    expect(v("youtube_shorts", "https://youtu.be/aqz-KE-bpKQ")).toEqual(want);
    expect(v("youtube_shorts", "https://www.youtube.com/watch?v=aqz-KE-bpKQ")).toEqual(want);
  });
  it("Instagram reels and TikToks map to their embed endpoints", () => {
    expect(v("instagram_reel", "https://www.instagram.com/reel/C1abcDEF234/?igsh=x")).toEqual({ kind: "iframe", src: "https://www.instagram.com/reel/C1abcDEF234/embed", host: "www.instagram.com" });
    expect(v("tiktok", "https://www.tiktok.com/@chef/video/7123456789012345678")).toEqual({ kind: "iframe", src: "https://www.tiktok.com/embed/v2/7123456789012345678", host: "www.tiktok.com" });
  });
  it("direct mp4 plays natively", () => expect(v("direct_mp4", "https://cdn.example.com/a.mp4")).toEqual({ kind: "video", src: "https://cdn.example.com/a.mp4" }));
  it("falls back to a plain link for unparseable, non-http or id-less URLs", () => {
    for (const [p, u] of [["youtube_shorts", "https://www.youtube.com/"], ["instagram_reel", "https://www.instagram.com/someone/"], ["tiktok", "https://www.tiktok.com/@chef"], ["youtube_shorts", "not a url"], ["tiktok", "ftp://x.com/video/1"], ["youtube_shorts", "https://www.youtube.com/shorts/%"]] as const) {
      expect(v(p, u).kind, u).toBe("link");
    }
  });
  it("every iframe host is in the CSP allow-list", () => {
    for (const e of [v("youtube_shorts", "https://youtu.be/aqz-KE-bpKQ"), v("instagram_reel", "https://www.instagram.com/reel/C1abcDEF234/"), v("tiktok", "https://www.tiktok.com/@a/video/12")]) {
      expect(e.kind === "iframe" && (EMBED_HOSTS as readonly string[]).includes(e.host)).toBe(true);
    }
  });
});
