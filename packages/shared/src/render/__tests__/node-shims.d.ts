// The shared package deliberately has no @types/node (its source must stay
// DOM- and Node-neutral). The test helpers that read the bundled fonts
// need these functions; declare just them. (`library-fixtures.test.ts`
// also writes stream snapshots on request.)
declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
}
declare const process: { env: Record<string, string | undefined> };
declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}
declare module "node:path" {
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
}
