/// <reference lib="webworker" />
/** Web Worker entry: binds the pure handler of `worker.ts` to the worker scope. */

import { createMapGlWorker, type WorkerRequest } from "./worker.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const worker = createMapGlWorker((msg, transfer) => scope.postMessage(msg, transfer));
scope.onmessage = (e: MessageEvent<WorkerRequest>) => worker.handle(e.data);
