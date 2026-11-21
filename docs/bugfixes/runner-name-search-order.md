# Bugfix: runner search failed in given-name order

## Symptom

An imported runner stored in Eventor's `Surname, Given name` format could be
found by surname, but autocomplete returned no result when the user typed the
natural displayed order. For example, `Kempe` found `Kempe, Emmy`, while
`Emmy K` did not.

## Cause

The runner-name suggestion and `name:` filter used a literal substring match
against the stored value. `Emmy K` is not a contiguous substring of
`Kempe, Emmy`.

## Fix

Runner-name search now considers both the stored form and a generated
`Given name Surname` variant. Storage, exports, and the displayed runner value
remain unchanged.

Unit and browser tests cover both filtering and autocomplete with a
surname-first name.
