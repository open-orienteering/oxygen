/// <reference lib="webworker" />
/** The averaging worker's entry (docs/map-gps-tracks.md §5.2, G27): binds `averageResponse` to the worker scope. */

import { averageResponse, type AverageRequest } from "./average";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (e: MessageEvent<AverageRequest>) => {
  const res = averageResponse(e.data);
  // A buffer named twice is a DataCloneError: x and y may share one.
  scope.postMessage(res, res.ok ? [...new Set<Transferable>([res.line.x.buffer, res.line.y.buffer])] : []);
};
