# Bugfix: `OXYGEN_ADMIN_EMAILS` silently did nothing for existing accounts

## Symptom

On the Cloud Run deployment (`oxygen.skogsluffarna.se`) with IAP in front and
`AUTH_MODE=proxy`, the signed-in operator's name rendered in the header but:

- no `ADMIN` badge next to it, and
- no **Manage users** link on the event selector,

even though the deployed revision had the operator's address in
`OXYGEN_ADMIN_EMAILS`.

The two missing pieces are the same condition, so this was one bug rather
than two. `UserChip` returns `null` unless auth is on *and* an identity
resolved, so the name rendering at all proved the header, the email parsing,
and the `users` lookup were all working. Both the badge and the link hang off
`user.isAdmin`.

## Root cause

`resolveUser` applied bootstrap admin status only in the branch that
*creates* a row:

```ts
if (!row && (bootstrap || authAutoProvision())) {
  row = await db.user.create({
    data: { /* ... */ isAdmin: bootstrap, active: true },
  });
}
```

When a row already existed, that branch was skipped and nothing else ever
looked at `parseOxygenAdminEmails()`. `OXYGEN_ADMIN_EMAILS` was therefore a
create-only bootstrap: correct on a virgin database, a no-op everywhere else.

In this deployment the row already existed because the cloud database had
been seeded with a `pg_dump` of the local dev database (see
`docs/deploy-gcp-cloud-run.md` §"Copy the dev database up"), which carried a
non-admin `users` row for the same address. `created_at` was three days
before the Phase 5 work that introduced `OXYGEN_ADMIN_EMAILS` handling.

The same no-op would hit any deployment where the account was auto-provisioned
as a member (`AUTH_AUTO_PROVISION=member`) before the variable was set —
which is the most likely order of operations, since IAP admits the operator
as soon as it is switched on.

This also broke the documented lockout escape hatch. `resolveUser` returns
`null` for `active = false`, and admins cannot deactivate themselves, but
one admin deactivating another left no in-app way back in: adding the
address to `OXYGEN_ADMIN_EMAILS` did nothing, so recovery required raw SQL.

## Fix

Reconcile on every resolve instead of only at creation, placed before the
`active` check so a deactivated bootstrap admin is revived:

```ts
if (row && bootstrap && (!row.isAdmin || !row.active)) {
  row = await db.user.update({
    where: { id: row.id },
    data: { isAdmin: true, active: true },
  });
}

if (!row || !row.active) return null;
```

The write is guarded so the common path stays a single `SELECT`; it only
fires when the row actually disagrees with the variable.

### Grant-only, on purpose

Reconciliation never demotes. If it did, the environment variable would
fight the **Manage users** page: every admin promoted in the UI whose
address was not also in the variable would be demoted on their next
request. So `OXYGEN_ADMIN_EMAILS` is a floor — it guarantees the operator
who controls the deployment can always get in, and leaves every other
account to the UI.

The consequence worth knowing: revoking a bootstrap admin takes two steps,
removing them from the variable *and* clearing the flag in the UI. Clearing
the flag alone is undone by their next request. This is documented in
`docs/authentication.md`.

## Tests

`packages/api/src/__tests__/integration/users.test.ts`, describe block
`OXYGEN_ADMIN_EMAILS reconciliation` — integration rather than unit because
`resolveUser` reads and writes through Prisma:

- a pre-existing member row listed in the variable is promoted, and its
  operator-set `displayName` survives the promotion,
- a deactivated bootstrap admin is revived and resolves non-null,
- an admin whose address is *absent* from the variable is left alone
  (the no-demotion guard).

The first two failed before the fix; the third passed already and exists to
pin the grant-only semantics.

## Fixing an already-affected deployment

Redeploying is enough — the next request from a listed address promotes the
row. To repair it without waiting for a deploy, through the Cloud SQL Auth
Proxy (§"Copy the dev database up" has the proxy invocation):

```sql
UPDATE oxygen.users
   SET is_admin = true, active = true
 WHERE email = 'you@example.com';
```
