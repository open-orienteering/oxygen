import type { resources, defaultNS } from "./i18n";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: (typeof resources)["en"];
    // i18next 27 turned this on by default. The status/info row builders take
    // a narrowed `t` with optional options, which the strict overloads reject;
    // keep the v26 typing until they are rewritten (docs/migrations/2026-11-dependency-upgrade.md part 5).
    strictInterpolationChecks: false;
  }
}
