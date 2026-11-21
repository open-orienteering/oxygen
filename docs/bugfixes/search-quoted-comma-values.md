# Bugfix: searching a name containing a comma returned nothing

## What happened

Searching for a runner by their full name found nothing. The reported
case was a deep link into the runners page:

```
/Ungdomsserien_regionfinal_SO/runners?q=name%3A%22Kempe%2C+Hugo%22
```

which decodes to `name:"Kempe, Hugo"`. The pill rendered, the query
looked right, and the result list was empty. Dropping the comma
(`name:Kempe`) worked, so the search bar looked functional.

This was not a niche edge case. Eventor stores personal names as
`"Family, Given"`, and `eventor.ts` writes that format straight into
`runners.name`, so **every** Eventor-imported runner has a comma in their
name — exactly the character that broke the search.

## Why

`parseExpression` infers a comparison operator from the shape of the
value. The inference ran *after* the quotes were stripped, and it did not
consider which operators the anchor actually supports:

```ts
const rawValue = unquote(segment.slice(colonIdx + 1)); // 'Kempe, Hugo'
const [operator, value] = detectOperator(rawValue, anchor.defaultOperator);

function detectOperator(rawValue, defaultOp) {
  // ...
  if (rawValue.includes(",")) return ["in", rawValue];   // ← here
  if (rawValue.includes("*")) return ["wildcard", rawValue];
  return [defaultOp, rawValue];
}
```

So `name:"Kempe, Hugo"` became an `in` list, and `matchString` handles
`in` as an **exact** match against each comma-separated item:

```ts
case "in":
  return value.split(",").some((v) => lower === v.trim().toLowerCase());
```

The runner is called `"Kempe, Hugo"`, which equals neither `"kempe"` nor
`"hugo"`, so nothing matched. The substring search the user asked for had
silently become an exact match against two fragments.

Two independent defects combined here:

1. **Quoting did not suppress inference.** Quotes are the user's way of
   saying "this is one literal value", but the parser discarded them
   before looking at the content.
2. **Inference ignored `anchor.operators`.** The `name` anchor declares
   `["contains", "wildcard"]` — it never supports `in` — yet the parser
   produced an `in` operator for it anyway.

## Blast radius

The `name` anchor is not the only casualty. Every `contains`-style string
anchor was affected, on every page that has one:

| Page | Anchor | Field |
|------|--------|-------|
| Runners | `name:` | runner name |
| Results | `name:` | runner name |
| Start list | `name:` | runner name |
| Tracks | `name:` | runner name |
| Cards | `runner:` | linked runner name |
| Backup punches | `runner:` | matched runner name |
| Classes / Courses / Controls / Clubs | `name:` | entity name |

Anchors that *do* support `in` (`club:`, `class:`) were broken in the
other direction: a club literally named `"OK Linné, Lund"` could not be
searched at all, because its comma was always read as a list separator.

Two related defects found while tracing this:

- **The search bar carried its own copy of the inference rules.**
  `parseInputToAtom` in `StructuredSearchBar.tsx` duplicated
  `detectOperator` inline, so typed input and `?q=` deep links could
  drift apart. Both copies had the same comma bug.
- **Autocomplete produced broken filters.** Picking a suggested runner
  from the dropdown committed the raw suggestion text unquoted, so
  selecting "Kempe, Hugo" from the list produced a filter that matched
  nothing — the failure was reachable without typing a quote at all.

## Fix

Operator inference is now quote-aware and anchor-aware
(`packages/web/src/lib/structured-search/parser.ts`):

- A **fully quoted value is literal**. Inference never reads `,`, `*`, or
  a `>`/`<` prefix out of it. `name:"Kempe, Hugo"` stays a single
  `contains`.
- Only **top-level commas** — those outside any quoted run — split an
  `in` list. `hasTopLevelComma` / `splitList` replace the naive
  `includes(",")` / `split(",")`.
- An operator is only inferred when **the anchor declares it**. A comma
  can no longer turn `name` into an `in`, and `bib:>5` keeps the `>` as
  part of the value because `bib` has no range operators.

The serializer had to match, or the UI would emit URLs it could not read
back. It now quotes `in` items individually and quotes any value that
would otherwise re-infer a different operator:

```
class:H21,D21                 → in-list, unchanged
class:"Öppen 1","Öppen 2"     → in-list of multi-word items (new form)
name:"Kempe, Hugo"            → literal contains
```

`StructuredSearchBar` no longer carries its own parser: `parseInputToAtom`
and `atomToText` delegate to the exported `parseSegment` and
`serializeAtomBody`, so typed input and deep links cannot drift again.
Suggestion values and multi-select lists are passed through
`quoteLiteral`, which fixes the autocomplete path.

### Behaviour change

A fully quoted comma value is now one literal value rather than a list.
`class:"H21,D21"` asks for a single class named `H21,D21` (which will
match nothing) instead of the two classes `H21` and `D21`. The list forms
`class:H21,D21` and `class:"Öppen 1","Öppen 2"` both still work, and the
multi-select UI emits the latter, so this only affects hand-written or
previously-bookmarked URLs that wrapped a whole list in one pair of
quotes.

An `in` list item cannot itself contain a comma. Quote an item to keep
its spaces, not its commas.

## Why no test caught it

The two existing suites tested the halves of the pipeline separately and
never met in the middle:

- `parser.test.ts` parses query strings but asserts only on the resulting
  token objects — it never filters anything. It did cover
  `name:"Anna Svensson"`, but that value has no comma.
- `filter.test.ts` filters real runners but builds its tokens **by hand**
  as object literals, bypassing the parser entirely. Its `name` /
  `contains` test passes an already-correct operator.

Operator inference lives precisely in the seam between them, so a query
could parse into an operator the matcher could not satisfy and both
suites stayed green. No E2E test used the `name:` anchor at all.

## Tests

- `packages/web/src/lib/structured-search/__tests__/query-to-filter.test.ts`
  (new) closes the seam: it drives raw query string → `parseExpression` →
  `applyFilters` → matching rows, covering the reported case, comma names
  combined with other anchors, negation and OR, comma-containing club
  names, the equivalent anchors on the results and cards pages, in-list
  round-trips, and the anchor-operator gating. 20 tests, all of which
  failed before the fix.
- `e2e/structured-search-names.spec.ts` (new) creates runners named
  `"E2E_Kempe, Hugo"` / `"E2E_Kempe, Marcus"`, then checks the deep link,
  partial-name matching, the typed round-trip through the URL, and that
  multi-word in-lists still filter. All 4 failed before the fix.
