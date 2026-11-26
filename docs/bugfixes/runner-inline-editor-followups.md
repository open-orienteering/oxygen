# Runner editor: follow-ups left out of package 11

Edge cases found while fixing [runner-inline-editor.md](runner-inline-editor.md)
and left for later, with the reason.

- **A save refused after the row was closed is only logged.** Closing the row
  sends the pending edits through the tRPC client; if the server refuses them
  (a taken card), the pane is gone and the error goes to the console only.
  Showing it needs an app-wide toast, which does not exist yet.
- **No global mutation error handler.** `main.tsx` still has no
  `MutationCache` `onError`. The review's shared toast (WEB-25, WEB-34,
  WEB-38, WEB-50, WEB-69) is its own change across every page.
- **A field whose stored form differs from the typed text stays "dirty".**
  Number fields compare as numbers ("007" settles against 7), text fields
  exactly. If the server ever normalised a text field (it does not today),
  the input would stop following outside changes until the row is reopened.
- **Club and variant refusals.** They go through the same save and show the
  same message, but the selects derive their label from the stored value, so
  there is no field to mark red.
- **Edits queued behind an offline save are lost on close.** While offline
  the save in flight is paused and kept (mutations are persisted), but edits
  sent by closing the row go through the tRPC client and fail to fetch; they
  are only logged.
- **Bib on a peer still on an older build.** A node from before package 11
  ignores `fields.bib` when it replays a `runner.updated`, so bibs differ
  until both nodes run this version.
- **One refusal refuses the whole batch.** Edits queued together go in one
  `runner.update`; if one field is refused (a taken card) the others in that
  save are not stored either and show their stored value again. Blur normally
  sends each field alone, so this needs a save in flight at the time.
