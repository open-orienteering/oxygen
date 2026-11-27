/// <reference lib="webworker" />
/** The route search worker's entry (docs/course-elevation.md §7.8): binds `createRouteWorkerState` to the worker scope. */

import { createRouteWorkerState, type RouteWorkerRequest } from "./finder";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const handle = createRouteWorkerState();
scope.onmessage = (e: MessageEvent<RouteWorkerRequest>) => {
  const res = handle(e.data);
  if (res) scope.postMessage(res);
};
