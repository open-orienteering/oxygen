// The shared package deliberately has no @types/node (its source must stay
// DOM- and Node-neutral). The test helpers that read the bundled fonts
// need these two functions; declare just them.
declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array;
}
declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}
