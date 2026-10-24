/**
 * Start-up string for a `worker_threads` worker whose entry sits next to
 * its host module (docs/map-storage.md §6.3; shared by the import worker
 * and the print worker, docs/course-print.md §8.2).
 *
 * tsx's loader does not reach worker threads on Node 20, so a TypeScript
 * entry (dev, E2E, vitest) is started through an eval'd bootstrap that
 * registers tsx inside the worker before importing it; the compiled entry
 * (`dist/`, Docker) is imported as is.
 */

import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/** `entryBase` is the entry's URL without extension, e.g. `new URL("./import-worker", import.meta.url)`; `hostUrl` is the host's `import.meta.url` (decides `.ts` vs `.js`). */
export function workerBootstrap(entryBase: URL, hostUrl: string): string {
  const ext = extname(fileURLToPath(hostUrl));
  const entry = `${entryBase.href}${ext}`;
  if (ext !== ".ts") return `import(${JSON.stringify(entry)})`;
  const tsxApi = import.meta.resolve("tsx/esm/api");
  return `import(${JSON.stringify(tsxApi)}).then(({ register }) => { register(); return import(${JSON.stringify(entry)}); })`;
}
