/**
 * Unit tests for standalone kiosk card processing logic.
 *
 * These tests directly cover the deduplication guard that was at the root of the
 * "auto-print only works the first time" bug:
 *
 * - DeviceManager emits an unresolved entry (actionResolved: false) immediately,
 *   then a resolved update (actionResolved: true) after the DB lookup completes.
 * - The old guard keyed only on card id, so the unresolved entry locked out the
 *   resolved update.
 * - The ref was never reset on idle, so re-reading the same card after an
 *   auto-reset was permanently blocked.
 */

import { describe, it, expect } from "vitest";
import {
  shouldProcessStandaloneCard,
  type StandaloneCardState,
} from "../kiosk-standalone-routing";

function card(overrides: Partial<StandaloneCardState> = {}): StandaloneCardState {
  return {
    id: "card-abc",
    action: "readout",
    actionResolved: true,
    ...overrides,
  };
}

describe("shouldProcessStandaloneCard", () => {
  // ── Null / unresolved guards ───────────────────────────────

  it("returns false for null card", () => {
    expect(shouldProcessStandaloneCard(null, null)).toBe(false);
  });

  it("returns false for undefined card", () => {
    expect(shouldProcessStandaloneCard(undefined, null)).toBe(false);
  });

  it("returns false for unresolved card (actionResolved: false) — root-cause case", () => {
    // DeviceManager fires this first, before the DB lookup completes.
    // The effect must skip it so the resolved update can take over.
    const unresolved = card({ actionResolved: false });
    expect(shouldProcessStandaloneCard(unresolved, null)).toBe(false);
  });

  it("returns false for unresolved card even when lastProcessed exists", () => {
    const unresolved = card({ id: "card-xyz", action: "pre-start", actionResolved: false });
    const last = { id: "card-abc", action: "readout" };
    expect(shouldProcessStandaloneCard(unresolved, last)).toBe(false);
  });

  // ── First resolved card after reset ───────────────────────

  it("returns true for first resolved card when no previous state (lastProcessed null)", () => {
    expect(shouldProcessStandaloneCard(card(), null)).toBe(true);
  });

  // ── Deduplication ─────────────────────────────────────────

  it("returns false when card id and action match lastProcessed — prevents double-fire", () => {
    const last = { id: "card-abc", action: "readout" };
    expect(shouldProcessStandaloneCard(card(), last)).toBe(false);
  });

  // ── Action change with same id ─────────────────────────────

  it("returns true when id matches but action changed (register → readout)", () => {
    // This happens when DeviceManager initially sends action='register' (unregistered runner)
    // and then sends action='readout' after card data is resolved.
    const last = { id: "card-abc", action: "register" };
    const resolved = card({ id: "card-abc", action: "readout" });
    expect(shouldProcessStandaloneCard(resolved, last)).toBe(true);
  });

  it("returns true when id matches but action changed (register → pre-start)", () => {
    const last = { id: "card-abc", action: "register" };
    const resolved = card({ id: "card-abc", action: "pre-start" });
    expect(shouldProcessStandaloneCard(resolved, last)).toBe(true);
  });

  // ── Different card ─────────────────────────────────────────

  it("returns true when card id is different from lastProcessed", () => {
    const last = { id: "card-abc", action: "readout" };
    const differentCard = card({ id: "card-xyz" });
    expect(shouldProcessStandaloneCard(differentCard, last)).toBe(true);
  });

  // ── Re-read after idle reset ───────────────────────────────

  it("returns true after reset (lastProcessed = null) for same id and action — the re-read-after-idle scenario", () => {
    // Simulates: card scanned → processed → kiosk resets to idle (ref cleared) →
    // same card scanned again → must process again.
    const last = null; // ref was cleared by idle transition
    expect(shouldProcessStandaloneCard(card(), last)).toBe(true);
  });

  it("returns false before reset for same id and action, then true after reset", () => {
    const c = card();
    const last = { id: c.id, action: c.action };

    // Before reset: same card/action → skip
    expect(shouldProcessStandaloneCard(c, last)).toBe(false);

    // After reset: null ref → process
    expect(shouldProcessStandaloneCard(c, null)).toBe(true);
  });
});
