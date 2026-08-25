import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

// Build version: timestamp at build time, used for cache busting
const BUILD_VERSION = new Date().toISOString();

// https://vite.dev/config/
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: [
        "src/lib/format.ts",
        "src/lib/si-protocol.ts",
      ],
      exclude: ["src/**/__tests__/**"],
      thresholds: {
        branches: 75,
        functions: 90,
        lines: 85,
        statements: 85,
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // "prompt", not "autoUpdate": an operator mid-readout should decide
      // when the page reloads, and the banner in App.tsx makes a waiting
      // bundle visible instead of leaving the tab silently stale.
      registerType: "prompt",
      manifest: false, // We provide our own manifest.webmanifest
      workbox: {
        // Precache all built assets (JS, CSS, HTML)
        globPatterns: ["**/*.{js,css,html,svg,woff,woff2}"],
        // Runtime caching for tRPC API calls
        runtimeCaching: [
          {
            // tRPC batch requests — serve from cache when offline, refresh in
            // background when online. Same-origin ONLY: requests rewritten to
            // a venue node (node-discovery) must never be served from the
            // cloud-tab SW cache — mixing the two writers' responses would
            // undermine the single-writer lease.
            urlPattern: (ctx: { sameOrigin: boolean; url: URL }) =>
              ctx.sameOrigin && ctx.url.pathname.startsWith("/trpc/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "trpc-api",
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 24 * 60 * 60, // 24 hours
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // API version endpoint
            urlPattern: /\/api\/version/,
            handler: "NetworkFirst",
            options: {
              cacheName: "api-misc",
              networkTimeoutSeconds: 2,
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60,
              },
            },
          },
        ],
        // Don't precache source maps
        globIgnores: ["**/*.map"],
      },
    }),
  ],
  define: {
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
    // Buffer polyfill for ocad2geojson (uses Node-style Buffer.isBuffer)
    "global": "globalThis",
  },
  resolve: {
    alias: {
      // ocad2geojson imports 'fs' but only uses it for file-path loading (we always pass Buffers)
      fs: path.resolve(__dirname, "src/lib/empty-module.ts"),
    },
  },
  server: {
    // WEB_PORT / API_PROXY_PORT are set by the E2E harness so each shard
    // can run its own web+API pair. Normal dev is unaffected (defaults).
    // Note: deliberately NOT `PORT`, which `pnpm dev` uses for the API.
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: !!process.env.WEB_PORT,
    proxy: {
      "/trpc": {
        target: `http://localhost:${process.env.API_PROXY_PORT ?? 3002}`,
        changeOrigin: true,
      },
      "/api": {
        target: `http://localhost:${process.env.API_PROXY_PORT ?? 3002}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Explicit hash patterns for cache busting in production
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
        // Split heavy vendor deps into cacheable chunks. Vite 8 only
        // accepts the function form of manualChunks.
        manualChunks: (id: string) => {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|react-router|react-router-dom)\//.test(id)) {
            return "vendor-react";
          }
          if (/node_modules\/(i18next|react-i18next)\//.test(id)) {
            return "vendor-i18n";
          }
          if (/node_modules\/(@trpc|@tanstack\/react-query|@tanstack\/query-core)\//.test(id)) {
            return "vendor-trpc";
          }
          return undefined;
        },
      },
    },
  },
});
