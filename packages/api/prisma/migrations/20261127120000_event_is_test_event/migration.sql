-- Package 19 (API-06): marks an event as a throwaway test event. The Test Lab
-- (synthetic runners, simulated races, instant clears) works only on such an
-- event, never on a live one. Additive with a default, so the previous image
-- keeps working.
ALTER TABLE "oxygen"."events"
  ADD COLUMN "is_test_event" BOOLEAN NOT NULL DEFAULT false;
