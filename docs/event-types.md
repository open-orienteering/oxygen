# Editable event types

Oxygen gives every event an editable type for list labels and filtering.
Choose it while creating a local event, or change it later in **Event →
Event Info** if you have `event.manage`.

The curated codes are:

```text
competition, championship, international, national, district, local, club,
club_training, weekly_course, training, other
```

`other` requires a custom label of at most 80 characters. The selector searches
that label and filters all custom labels under the stable `other` code.

## Eventor metadata stays separate

`events.kind` and `events.kind_custom` are Oxygen-owned and editable.
`eventor_event_meta.classification_id` remains the raw Eventor value used by
registration trends and reporting.

During the initial Eventor import, Oxygen maps classification IDs once:

```text
1 championship   2 national      3 district
4 local          5 club          6 international
```

Unknown values become `competition`. The import also stores the original
classification in `eventor_event_meta`. Later Eventor syncs can refresh that
raw metadata, but never overwrite the editable Oxygen type.

The migration backfills existing Eventor-linked events only while their
previous type is still the generic `competition`, preserving already
specialized local values.
