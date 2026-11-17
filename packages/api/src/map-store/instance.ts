/** Stable per-process identity written to a job row's `claimed_by` (import jobs, DEM jobs). */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

export const INSTANCE_ID = process.env.NODE_ID ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
