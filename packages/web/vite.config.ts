import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
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
  plugins: [react(), tailwindcss()],
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
    port: 5173,
    proxy: {
      "/trpc": {
        target: "http://localhost:3002",
        changeOrigin: true,
      },
      "/api": {
        target: "http://localhost:3002",
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
        manualChunks: {
          // Split heavy vendor deps into cacheable chunks
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-i18n": ["i18next", "react-i18next"],
          "vendor-trpc": ["@trpc/client", "@trpc/react-query", "@tanstack/react-query"],
        },
      },
    },
  },
});
