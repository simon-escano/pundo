import { expect, type Page } from "@playwright/test";

export const ROUTES = ["plan", "grocery", "day-1", "prep", "cook", "recipes"] as const;
export type Route = (typeof ROUTES)[number];

/** Open the deterministic dev fixture (fresh DB, fixed clock + seed). `locked` = rolled + locked + pantry stock. */
export async function openFixture(page: Page, route: Route = "plan", state: "draft" | "locked" = "draft") {
  await page.goto(`/?fixture=demo&state=${state}#/${route}`);
  await expect(page.locator("main[data-route]")).toBeVisible();
  await expect(page.getByTestId("view-loading")).toHaveCount(0); // lazy views: wait for the chunk
  await page.evaluate(() => document.fonts.ready);
}

const labelFor = (r: Route) => ({ plan: "Plan", grocery: "Grocery", "day-1": "Day 1", prep: "Prep", cook: "Cook", recipes: "Recipes" })[r];

export const goto = async (page: Page, route: Route) => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: labelFor(route), exact: true }).click();
  await expect(page.locator("main")).toHaveAttribute("data-route", route);
  await expect(page.getByTestId("view-loading")).toHaveCount(0);
};

export const money = (t: string | null) => Number((t ?? "").replace(/[^\d.]/g, ""));

/**
 * The physical-layout contract, asserted on whatever is currently on screen:
 *  1. no horizontal page overflow
 *  2. no element scrolls horizontally, none sticks out of the viewport, none uses scroll-snap
 *  3. every interactive target is at least 44 × 44 CSS px
 */
export async function assertLayout(page: Page) {
  const r = await page.evaluate(() => {
    const vw = window.innerWidth;
    const problems: string[] = [];
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ").slice(0, 2).join(".") : ""}`;

    if (document.body.scrollWidth > vw) problems.push(`body.scrollWidth ${document.body.scrollWidth} > ${vw}`);
    if (document.documentElement.scrollWidth > vw) problems.push(`html.scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);

    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.scrollSnapType !== "none") problems.push(`scroll-snap on ${name(el)}`);
      if (["auto", "scroll"].includes(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) problems.push(`horizontal scroller ${name(el)} (${el.scrollWidth}>${el.clientWidth})`);
      const b = el.getBoundingClientRect();
      if (b.width > 0 && cs.visibility !== "hidden" && (b.right > vw + 1 || b.left < -1)) problems.push(`${name(el)} spills out of viewport (${Math.round(b.left)}..${Math.round(b.right)} of ${vw})`);
    }

    const targets = [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [role="button"]')];
    let checked = 0;
    for (const el of targets) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      // A checkbox's tap target is its label; otherwise the element itself.
      const box = (el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type) ? el.closest("label") ?? el : el).getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      checked++;
      if (box.width < 43.5 || box.height < 43.5) problems.push(`tap target ${name(el)} "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 24)}" is ${Math.round(box.width)}×${Math.round(box.height)}`);
    }
    return { problems, checked };
  });
  expect(r.problems, r.problems.join("\n")).toEqual([]);
  expect(r.checked).toBeGreaterThan(0);
}
