import { test, expect, type Page } from "@playwright/test";

// Runs against the PRODUCTION build (service worker + precache) served by wrangler with a real API and a fresh local D1.
test.describe.configure({ mode: "serial" });

type Counts = { bought: number; outbox: number; cycles: number };
/** Read IndexedDB directly (not through the app) to prove what is really persisted on the device. */
const idb = (page: Page): Promise<Counts> =>
  page.evaluate(
    () =>
      new Promise<Counts>((resolve, reject) => {
        const open = indexedDB.open("pundo");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(["groceryLineState", "outbox", "cycles"]);
          const g = tx.objectStore("groceryLineState").getAll();
          const o = tx.objectStore("outbox").count();
          const c = tx.objectStore("cycles").count();
          tx.oncomplete = () => resolve({ bought: (g.result as { bought: boolean }[]).filter((r) => r.bought).length, outbox: o.result, cycles: c.result });
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
const indicator = (page: Page) => page.getByTestId("sync-indicator");
const go = (page: Page, route: string) => page.evaluate((r) => (location.hash = `#/${r}`), route);

test("offline-first: the app works without a network, keeps changes on the device, and drains to D1 on reconnect", async ({ page, context, request }) => {
  // Count persistence requests made at boot (the stub grants, standing in for an installed PWA).
  await page.addInitScript(() => {
    let calls = 0;
    (window as unknown as { __persist: () => number }).__persist = () => calls;
    StorageManager.prototype.persist = () => { calls++; return Promise.resolve(true); };
  });

  // ── 1. First online visit: boot, register the service worker, request persistent storage ──
  await page.goto("/");
  await expect(page.locator("main[data-route]")).toBeVisible();
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.ready).active)).toBe(true);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true); // clientsClaim: controlled right away
  await expect.poll(() => page.evaluate(() => (window as unknown as { __persist: () => number }).__persist())).toBe(1);

  // Installable (manifest, icons, service worker) according to Chromium itself.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Page.enable");
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  expect(installabilityErrors, JSON.stringify(installabilityErrors)).toEqual([]);

  // Build a plan while online, lock it, and let it sync.
  await page.getByRole("button", { name: "Roll dishes", exact: true }).click();
  await expect(page.getByTestId("dish-card")).toHaveCount(6);
  await page.getByRole("button", { name: "Lock plan" }).click();
  await expect(page.getByTestId("cycle-status")).toHaveText("Locked");
  await expect(indicator(page)).toHaveAttribute("data-state", "synced", { timeout: 20_000 });
  expect((await idb(page)).outbox).toBe(0);

  // ── 2. Network off: reload straight from the service worker ──
  await context.setOffline(true);
  await expect(indicator(page)).toHaveAttribute("data-state", "offline");
  await expect(indicator(page)).toContainText("Offline");
  await page.reload();
  await expect(page.locator("main[data-route]")).toBeVisible(); // app shell served from the precache
  await expect(page.getByTestId("dish-card")).toHaveCount(6); // data served from IndexedDB
  await expect(page.getByTestId("cycle-status")).toHaveText("Locked");

  // Split-out (lazy) views are precached too: they open offline.
  await go(page, "recipes");
  await expect(page.getByTestId("recipe-count")).toHaveText("15");
  await go(page, "cook");
  await expect(page.getByTestId("cook-card").first()).toBeVisible();
  await go(page, "prep");
  await expect(page.getByTestId("prep-group").first()).toBeVisible();

  // ── 3. Offline mutations land in IndexedDB ──
  await go(page, "grocery");
  const boxes = page.getByTestId("grocery-line").getByLabel(/^Bought:/);
  await boxes.nth(0).click();
  await boxes.nth(1).click();
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  await expect(page.getByTestId("bought-progress")).toContainText("2 of");
  await expect.poll(async () => (await idb(page)).bought).toBe(2);
  const offlineState = await idb(page);
  expect(offlineState.outbox).toBeGreaterThanOrEqual(2); // queued for sync, not lost
  await expect(indicator(page)).toContainText(`${offlineState.outbox} change${offlineState.outbox === 1 ? "" : "s"} queued`);

  // They survive a reload while still offline.
  await page.reload();
  await expect(page.getByTestId("grocery-line").first()).toBeVisible();
  await expect(page.getByTestId("grocery-line").getByLabel(/^Bought:/).nth(0)).toBeChecked();
  await expect(page.getByTestId("grocery-line").getByLabel(/^Bought:/).nth(1)).toBeChecked();
  expect((await idb(page)).bought).toBe(2);

  // The server has NOT seen them yet.
  const before = await (await request.get("/api/sync/pull?since=0&limit=500")).json();
  expect(before.changes.filter((c: { entity: string }) => c.entity === "groceryLineState")).toHaveLength(0);

  // ── 4. Back online: the outbox drains cleanly to D1 ──
  await context.setOffline(false);
  await expect(indicator(page)).toHaveAttribute("data-state", "synced", { timeout: 20_000 });
  await expect.poll(async () => (await idb(page)).outbox).toBe(0);

  const after = await (await request.get("/api/sync/pull?since=0&limit=500")).json();
  const grocery = after.changes.filter((c: { entity: string; payload: { bought: boolean } }) => c.entity === "groceryLineState" && c.payload?.bought);
  expect(grocery.length).toBeGreaterThanOrEqual(2);
  expect(after.changes.some((c: { entity: string; payload: { status?: string } }) => c.entity === "cycle" && c.payload?.status === "locked")).toBe(true);
  expect(after.cursor).toBeGreaterThan(before.cursor);

  // Idempotent: nothing is re-sent and the cursor is stable once drained.
  await page.waitForTimeout(500);
  const settled = await (await request.get("/api/sync/pull?since=0&limit=500")).json();
  expect(settled.cursor).toBe(after.cursor);
});

test("an offline cold start works: a fresh page load with the network already down", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator("main[data-route]")).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  const fresh = await context.newPage(); // a brand-new tab, opened while offline
  await fresh.goto("/#/plan");
  await expect(fresh.locator("main[data-route]")).toBeVisible();
  await expect(fresh.getByTestId("sync-indicator")).toHaveAttribute("data-state", "offline");
  await fresh.close();
  await context.setOffline(false);
});

test("the sync API is never served from the service-worker cache", async ({ page, request }) => {
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const health = await page.evaluate(async () => (await fetch("/api/health")).json());
  expect(health).toMatchObject({ ok: true, service: "pundo" });
  const direct = await request.get("/api/nope");
  expect(direct.status()).toBe(404); // the Worker answers (JSON), not the SPA fallback
  const body = await page.evaluate(async () => { const r = await fetch("/api/nope"); return { status: r.status, type: r.headers.get("content-type") }; });
  expect(body.status).toBe(404);
  expect(body.type).toContain("application/json");
});
