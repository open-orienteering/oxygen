/// <reference lib="webworker" />
/** The print worker's entry (docs/course-print.md §8.6): binds the pure handler of `worker.ts` to the worker scope. */

import type { PrintWorkerRequest } from "./protocol";
import { createPrintWorker } from "./worker";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const worker = createPrintWorker((msg, transfer) => scope.postMessage(msg, transfer ?? []));
scope.onmessage = (e: MessageEvent<PrintWorkerRequest>) => worker.handle(e.data);
