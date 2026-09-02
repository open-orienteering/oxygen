-- Track whether an event map was copied from the club library so
-- downloads and backups can keep those OCAD files behind instance admin.
ALTER TABLE "oxygen"."map_files"
  ADD COLUMN "from_club_library" BOOLEAN NOT NULL DEFAULT false;
