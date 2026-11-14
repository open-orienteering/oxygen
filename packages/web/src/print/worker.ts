/**
 * The browser's print worker, worker side (docs/course-print.md §8.6, G16;
 * 05 §5.11 phase 2): composes a print job with the shared pipeline's one
 * entry, `renderPrintJob` — the server's composer, writer and faces — so a
 * job composed here gives `maps.pdf`'s bytes for equal writer options
 * (slice G answer 3). It resolves nothing; the document, the graphics and
 * the faces arrive from the main thread (`protocol.ts`).
 *
 * The only web module that imports `@oxygen/shared/print` at runtime: the
 * PDF writer stays in this worker's chunk. A pure message handler, so it
 * is unit-tested without a Worker; `print-worker-entry.ts` binds it to
 * `self`.
 */

import { type PrintFonts, printFontsFromFaces, renderPrintJob } from "@oxygen/shared/print";
import type { PrintWorkerNeed, PrintWorkerRequest, PrintWorkerResponse } from "./protocol";

/** A request to the main thread before it is numbered. */
type NeedBody = PrintWorkerNeed extends infer N ? (N extends unknown ? Omit<N, "reqId"> : never) : never;

type Post = (msg: PrintWorkerResponse, transfer?: Transferable[]) => void;

/** `ArrayBuffer` of exactly these bytes, transferable without detaching a shared buffer. */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  return bytes.slice().buffer as ArrayBuffer;
}

export function createPrintWorker(post: Post) {
  let fonts: PrintFonts | null = null;
  let nextReq = 1;
  const pending = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();
  /** One job at a time, in arrival order (the client queues too). */
  let queue: Promise<void> = Promise.resolve();

  const ask = (msg: NeedBody): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      const reqId = nextReq++;
      pending.set(reqId, { resolve, reject });
      post({ ...msg, reqId } as PrintWorkerNeed);
    });

  async function compose(id: number, msg: Extract<PrintWorkerRequest, { type: "compose" }>): Promise<void> {
    try {
      if (!fonts) throw new Error("print worker: no faces (init first)");
      const out = await renderPrintJob(msg.job, {
        fonts,
        deterministic: msg.deterministic,
        document: (hash) => ask({ type: "need", id, what: "document", hash }),
        graphic: (graphicId, box) => ask(box ? { type: "need", id, what: "graphic", graphicId, box } : { type: "need", id, what: "graphic", graphicId }),
        onPage: (p) => post({ type: "page", id, index: p.index, label: p.label, warnings: p.warnings }),
      });
      const bytes = ownBuffer(out.bytes);
      post({ type: "done", id, bytes, pageCount: out.pageCount, warnings: out.warnings }, [bytes]);
    } catch (err) {
      post({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    handle(msg: PrintWorkerRequest): void {
      switch (msg.type) {
        case "init":
          fonts = printFontsFromFaces(msg.faces.map((f) => ({ family: f.family, data: new Uint8Array(f.data) })));
          return;
        case "compose":
          queue = queue.then(() => compose(msg.id, msg));
          return;
        case "reply": {
          const p = pending.get(msg.reqId);
          if (!p) return;
          pending.delete(msg.reqId);
          if ("error" in msg) p.reject(new Error(msg.error));
          else p.resolve(new Uint8Array(msg.bytes));
          return;
        }
      }
    },
    /** Settles when every compose received so far has answered (tests). */
    idle: (): Promise<void> => queue,
  };
}
