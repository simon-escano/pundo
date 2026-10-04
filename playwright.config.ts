import { defineConfig, devices } from "@playwright/test";

// Chromium only: WebKit is unsupported on Fedora, so iPhone is emulated via Chromium.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  expect: { toHaveScreenshot: { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.005 } },
  use: { baseURL: "http://localhost:5173" },
  webServer: [
    // Dev server: fixture-based layout / flow / visual specs.
    { command: "npm run dev -- --port 5173 --strictPort", url: "http://localhost:5173", reuseExistingServer: true },
    // Production build + service worker + the real Worker/API + a fresh local D1, all on one origin (offline spec).
    { command: "npm run e2e:offline-server", url: "http://localhost:8787/api/health", reuseExistingServer: false, timeout: 240_000, stdout: "ignore", stderr: "pipe" },
  ],
  projects: [
    {
      name: "mobile-360",
      testIgnore: /offline\.spec/,
      use: { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } },
    },
    {
      name: "iphone-13",
      testIgnore: /offline\.spec/,
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
    { name: "pixel-7", testIgnore: /offline\.spec/, use: { ...devices["Pixel 7"] } },
    { name: "desktop", testIgnore: /offline\.spec/, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    // Offline-first: production build served by wrangler (service worker allowed, real API, real D1).
    { name: "offline", testMatch: /offline\.spec/, use: { ...devices["Pixel 7"], baseURL: "http://localhost:8787", serviceWorkers: "allow" } },
  ],
});
