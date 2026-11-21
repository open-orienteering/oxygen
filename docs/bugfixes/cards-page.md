# Bugfix & Feature: Cards Page Improvements

## Summary

Fixed several bugs on the Cards page and added manual card-to-runner linking.

## Bug 1: Duplicate card rows

**Symptom:** Multiple rows with the same SI card number appeared in the table, causing wrong expand positions, stale rows after filtering, and count mismatches.

**Root cause:** The `cardList` API returned all non-removed `oCard` records without deduplicating by `CardNo`. When MeOS or edge cases created multiple `oCard` records for the same physical card, they all appeared as separate rows. Combined with `Fragment key={card.cardNo}`, React key collisions caused rendering glitches.

**Fix:**
- API: Deduplicate by `CardNo` in `cardList`, keeping the record with the highest `Id` (newest)
- UI: Changed React key from `card.cardNo` to `card.id` for robustness

## Bug 2: Filters not persisted in URL

**Symptom:** The rental/filter pills reset on page reload because they used `useState` instead of URL params.

**Fix:** Replaced `useState<RentalFilter>` with `useSearchParam("filter")`. The filter is now reflected in the URL (e.g., `?filter=unreturned`) and persists across page reloads and navigation.

## Bug 3: Header count didn't reflect active filter

**Symptom:** The "X cards" header always showed the total count, even when a filter was active.

**Fix:** When a filter is active, the header now shows `filtered / total` (e.g., "8 / 169").

## Feature: Unlinked cards filter

Added a new "Unlinked" filter pill that shows only cards without a linked runner. Includes a count badge showing how many cards are unlinked.

## Feature: Manual card-to-runner linking

**Problem:** There was no way to manually connect or reconnect a card readout to a specific runner. Linking only happened automatically during card readout.

**Solution:**

- **API:** New `cardReadout.linkCardToRunner` mutation that accepts `{ cardId, runnerId }`. When `runnerId` is null, the card is unlinked. When linking, the mutation clears any previously linked runner before assigning the new one.
- **UI:** In the expanded card detail panel, the "Linked Runner" section now has:
  - "Change" / "Unlink" buttons when a runner is linked
  - "Link" button when no runner is linked
  - Inline runner search (by name, card number, or club) with results dropdown
  - Confirm dialogs before linking/unlinking

## Files Changed

| File | Changes |
|------|---------|
| `packages/api/src/routers/cardReadout.ts` | Dedup `cardList`, add `linkCardToRunner` mutation |
| `packages/web/src/pages/CardsPage.tsx` | React keys, URL filter, unlinked filter, link/unlink UI |
| `packages/api/src/__tests__/integration/card-dedup.test.ts` | 9 integration tests |
| `packages/web/src/i18n/locales/en/devices.json` | New translation keys |
| `packages/web/src/i18n/locales/sv/devices.json` | New translation keys (Swedish) |
