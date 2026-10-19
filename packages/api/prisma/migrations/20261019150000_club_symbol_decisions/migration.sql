-- Club symbol decisions (docs/map-symbols.md §8.5, docs/map-storage.md §2;
-- research 06 §5.3, 07 §4.3 verbatim). Written only by mapImport.decide,
-- read by import stage 6 as the explicit-CRT stage. No event or series
-- column: the instance belongs to one club. `library_version` is the full
-- `<library>@<release>` the decision was made against; readers take every
-- release of the chosen library, newest `decided_at` first.

CREATE TABLE "oxygen"."club_symbol_decisions" (
  "fingerprint"     TEXT NOT NULL,
  "library_version" TEXT NOT NULL,
  "canonical_id"    TEXT,
  "decided_by"      UUID REFERENCES "oxygen"."users"("id") ON DELETE SET NULL,
  "decided_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY ("fingerprint", "library_version")
);
