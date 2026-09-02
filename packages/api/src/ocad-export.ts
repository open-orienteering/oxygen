/**
 * Who may take the OCAD source file out of Oxygen.
 *
 * Tiles, SVG windows, and course overprints are rendered views; they are
 * what operators need to run a race. The `.ocd` blob is the club's map,
 * and anyone who can fetch it can walk away with a full-resolution copy.
 * Event-uploaded maps belong to that event's managers. Maps that came
 * from the club library still belong to the club, so only an instance
 * admin (or the library uploader, for the library row itself) may
 * download them — including via the event backup, which otherwise
 * streams `map_files.file_data` in the dump.
 */

export function canDownloadEventMap(args: {
  authEnabled: boolean;
  isAdmin: boolean;
  fromClubLibrary: boolean;
}): boolean {
  if (!args.authEnabled) return true;
  if (args.fromClubLibrary) return args.isAdmin;
  return true;
}

export function canDownloadClubLibraryMap(args: {
  authEnabled: boolean;
  isAdmin: boolean;
  isUploader: boolean;
}): boolean {
  if (!args.authEnabled) return true;
  return args.isAdmin || args.isUploader;
}
