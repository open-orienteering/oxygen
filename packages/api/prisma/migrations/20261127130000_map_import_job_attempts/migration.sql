-- MAP-5: count claims so a job that kills the process on every try is given up.
ALTER TABLE "oxygen"."map_import_jobs" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
