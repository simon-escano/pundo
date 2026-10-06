import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // The app registers the worker itself (useRegisterSW) so it can show an update prompt.
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["icons/icon.svg", "icons/icon-dark.svg", "icons/apple-touch-icon.png", "icons/apple-touch-icon-dark.png"],
      manifest: {
        id: "/",
        name: "pundo",
        short_name: "pundo",
        description: "Deterministic 2-week meal prep and grocery planner that works offline.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#faf7f2",
        theme_color: "#b45309",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // App shell + every JS/CSS chunk (including the lazy views and the bundled fixtures) + icons.
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/cdn-cgi\//], // the sync API and the Access login are never served from cache
        cleanupOutdatedCaches: true,
        clientsClaim: true, // the very first load is already controlled, so it can go offline immediately
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "vendor-react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: "vendor-motion", test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/, priority: 25 },
            { name: "vendor-zod", test: /node_modules[\\/]zod[\\/]/, priority: 20 },
            { name: "vendor-dexie", test: /node_modules[\\/](dexie|dexie-react-hooks)[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  test: {
    projects: [
      // Pure TS + Dexie (fake-indexeddb) in Node.
      { extends: true, test: { name: "node", environment: "node", include: ["src/**/*.test.ts", "tests/**/*.test.ts"] } },
      // Worker + two-client sync tests inside workerd with a real D1.
      "./vitest.workers.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/domain/**/*.ts", "src/storage/**/*.ts", "src/ui/lib/**/*.ts", "src/ui/persist.ts"],
      exclude: ["src/**/*.test.ts", "src/**/testing/**", "src/domain/schemas/blueprint.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
});
