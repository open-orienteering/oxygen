# LiveResults radio codes, shared tavid, hashed login

## Symptom

Enabling LiveResults in Oxygen and then connecting MeOS to the same
`tavid` produced duplicate classes (`U4` vs `U4 3 km`). The Oxygen
class had a radio column; the MeOS class did not, and a test runner
uploaded by MeOS disappeared from the radio view. MeOS also reported
`BADCMP` when logging in with the credentials Oxygen stored on the
`login` row — those credentials are not the MeOS MOP password (that
lives on melin.nu), but the `login.user` / `login.pass` values were
still wrong relative to every other recent competition.

## Root cause

Three independent mismatches with the LiveResults wire format:

1. **Radio identity.** LiveResults (and MeOS) store split controls as
   `visit × 1000 + punchCode`: first punch of 82 is `1082`, the twelfth
   of 100 is `12100`. Oxygen wrote the bare SI code (`82`). The
   `splitcontrols` primary key is `(tavid, classname, corder, code)`,
   so `82` and `1082` coexisted as two radio columns on the same class.
   Result punches MeOS sent as `1082` never matched Oxygen's
   definition.

2. **Unscoped wipe.** Each Oxygen sync ran
   `DELETE FROM splitcontrols WHERE tavid = ?` and re-inserted only
   Oxygen class names. MeOS radios under `U4 3 km` were deleted every
   30 seconds.

3. **Plaintext `login` credentials.** Official clients write 32-char
   md5 hex into `login.user` and `login.pass`. Oxygen inserted
   `oxygen` / `oxygen_<eventId>` in the clear. Of ~25k `login` rows,
   only a handful of legacy clients (including Oxygen and old oos)
   stored plaintext.

## Fix

- Encode radios with `liveResultsRadioCode(code, visit)`. Visit is
  1-based and counts every occurrence of that punch code on the whole
  course (a radio that is the second 82 becomes `2082`). Punches are
  mapped the same way; extra punches of a code that is only on the
  course once (redundant radio units) are dropped because their visit
  number is not in the class's encoded set.
- Replace `splitcontrols` only for Oxygen class names
  (`DELETE … WHERE tavid = ? AND classname IN (…)`).
- Hash `user` and `pass` with md5 on insert, matching the official
  clients. Existing competitions keep whatever was written at create
  time; a new enable after deleting `liveresultsTavid` gets hashed
  rows.

MeOS Resultat-online still authenticates against **melin.nu**, not
this `login` row. Do not run Oxygen's pusher and MeOS against the same
`tavid` at the same time — they still use different class names and
`dbid` spaces.

## Tests

`packages/api/src/__tests__/liveresults.test.ts` — encoding, course
walk, punch visit matching, md5 shape, scoped class-name list.
