import { expect, test, type Page } from "@playwright/test";
import { openFixture } from "./helpers";

test("iOS home-screen metadata is in the head", async ({ page }) => {
  await openFixture(page);
  const meta = (name: string) => page.locator(`meta[name="${name}"]`).getAttribute("content");
  expect(await meta("apple-mobile-web-app-capable")).toBe("yes");
  expect(await meta("mobile-web-app-capable")).toBe("yes");
  expect(await meta("apple-mobile-web-app-status-bar-style")).toBe("default");
  expect(await meta("apple-mobile-web-app-title")).toBe("pundo");
  expect(await meta("viewport")).toContain("viewport-fit=cover");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/icons/apple-touch-icon.png");
  const res = await page.request.get("/icons/apple-touch-icon.png");
  expect(res.ok()).toBe(true);
});

/** Drag down with a real touch pointer (CDP), pausing on each step so the page sees a gesture, not a jump. */
async function pull(page: Page, from: { x: number; y: number }, distance: number, release = true) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", y?: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: from.x, y: y! }] });
  await touch("touchStart", from.y);
  for (let i = 1; i <= 12; i++) await touch("touchMove", from.y + (distance * i) / 12);
  if (release) await touch("touchEnd");
  return { cdp, touch };
}

test.describe("pull to refresh", () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(!info.project.use.hasTouch, "touch gesture");
    await openFixture(page);
  });

  const offsetOf = (page: Page) => page.evaluate(() => new DOMMatrixReadOnly(getComputedStyle(document.getElementById("main")!).transform).m42);

  test("a short pull follows the finger, shows the spinner, then settles back without refreshing", async ({ page }) => {
    let navigations = 0;
    page.on("framenavigated", () => navigations++);
    await page.evaluate(() => ((window as unknown as { __alive: boolean }).__alive = true));
    const { touch } = await pull(page, { x: 100, y: 200 }, 40, false);
    expect(await offsetOf(page)).toBeGreaterThan(10);
    expect(await offsetOf(page)).toBeLessThan(60); // resists, short of the threshold
    await expect(page.getByTestId("ptr-indicator")).not.toHaveCSS("opacity", "0");
    await touch("touchEnd");
    await expect.poll(() => offsetOf(page)).toBe(0);
    await expect(page.getByTestId("ptr-indicator")).toHaveCSS("opacity", "0");
    expect(navigations).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive)).toBe(true);
    await expect(page.locator("main")).toHaveCSS("transform", "none"); // no lingering transform
  });

  test("a long pull past the threshold refreshes the app", async ({ page }) => {
    await Promise.all([page.waitForEvent("load"), pull(page, { x: 100, y: 200 }, 260)]);
    await expect(page.locator("main[data-route]")).toBeVisible();
  });

  test("a pull that starts while the page is scrolled does nothing", async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, 300));
    test.skip(await page.evaluate(() => window.scrollY === 0), "page too short to scroll");
    await pull(page, { x: 100, y: 200 }, 200);
    expect(await offsetOf(page)).toBe(0);
  });
});
