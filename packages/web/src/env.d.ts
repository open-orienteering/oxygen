/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

/** Injected at build time by vite.config.ts */
declare const __BUILD_VERSION__: string;
/** `OXYGEN_VERSION` on an image build, else `<package version>-dev`. */
declare const __APP_VERSION__: string;
