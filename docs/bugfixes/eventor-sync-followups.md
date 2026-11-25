# Eventor sync: follow-up review items left as they are

Review of the Eventor sync and import (package 5) found items that were fixed
(see [eventor-resync-data-loss.md](eventor-resync-data-loss.md) and
[eventor-import-atomic.md](eventor-import-atomic.md)) and six that were
deliberately left out. They are recorded here so they are decisions, not
oversights.

## Left out

1. **60 s transaction timeout on the first sync of a very large event.** The
   first sync of an event with several thousand runners and no snapshots does
   its writes in one transaction with a 60 s timeout. A timeout rolls back
   everything and the sync can be retried; nothing is half-applied. Raise the
   timeout or chunk the writes if a real event hits it.
2. **A cancel of a runner who is out on the course without punches follows the
   owner's rule.** A runner with no card read-out, finish time or result status
   is "nothing has happened locally", so a withdrawal in Eventor cancels them
   even if they are physically running. The owner decided this rule; the
   preview lists the names so the operator can see it first.
3. **Slug race on import (`P2002`).** Two imports of the same new event name at
   the same moment can both pass the slug lookup; the second fails on the unique
   index and the client shows the database error. Nothing is written and a retry
   works. A lock would be needed to make the message friendlier.
4. **An entry that gains a person id another row already has.** If the first
   import created one runner from an entry with no person id and another from
   Eventor's results for that person, the entry-keyed runner is cancelled (or
   held back) once the entry carries the person id. The preview lists it. Only
   reachable with results-only rows from a first import.
5. **"Gone from Eventor" banner on a hand-cancelled runner.** A held-back
   runner that the desk later cancels shows the "the sync withdrew them" text,
   since the text keys on status rather than on `cancelled_by_sync`.
6. **A checkout reply lost while waiting for a sync.** `lease.acquire` can now
   wait up to a minute for a running sync. If a proxy cuts that reply, the box's
   rollback (`release`) runs before the lease exists, and the cloud takes the
   lease when the sync ends, with no box copy. A checkout retry from the same
   node recovers it.
