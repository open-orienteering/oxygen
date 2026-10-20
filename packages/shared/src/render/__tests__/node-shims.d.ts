// The shared package deliberately has no @types/node (its source must stay
// DOM- and Node-neutral). The test helpers that read the bundled fonts
// need these two functions; declare just them.
declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: "utf8"): string;
}
declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}
declare module "node:path" {
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
}
