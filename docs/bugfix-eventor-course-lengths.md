# Eventor course lengths in IOF CourseData export

## Symptom

The IOF CourseData export for Eventor event 55754 showed every course
as roughly one kilometre long. Eventor's published start list had the
actual lengths, ranging from 1,410 m to 3,020 m. For example:

| Class | Oxygen before | Eventor |
|---|---:|---:|
| Inskolning | 660 m | 1,410 m |
| U4 | 1,200 m | 2,480 m |
| H16 | 1,470 m | 3,020 m |

The XML writer wrote `courses.length_m` verbatim. The wrong value was
already stored.

## Root cause

The immediate cause was an older OCAD parser bug that read this
1:15,000 map as 1:7,500 and nearly halved every geometric length. See
[bugfix-ocad-course-scale-and-export-lengths.md](bugfix-ocad-course-scale-and-export-lengths.md).

Even with that fixed, a published length can intentionally differ
from the straight control-to-control sum: OCAD/IOF can carry extra
distance, marked routes or detours around forbidden terrain. Eventor
therefore remains a useful repair source for untouched imported
courses.

Oxygen's Eventor sync fetched:

- native `eventclasses` for class ids and metadata;
- `export/classes` for no-timing mode;
- entries and results.

It did not fetch Eventor's official IOF 3.0 start list. That endpoint,
`starts/event/iofxml`, contains the published value at:

```xml
<ClassStart>
  <Class><Id type="Sweden">682913</Id><Name>U4</Name></Class>
  <Course raceNumber="1"><Length>2480</Length></Course>
</ClassStart>
```

## Fix

`fetchEventClasses` enriches each class with the positive class-level
length from `starts/event/iofxml`. During Eventor sync, an existing
class with a course assignment may update an untouched imported
course's `length_m`.

An Oxygen-edited course (`geometry_source = 'editor'`) is never
overwritten: its current coordinates and sequence are authoritative.
Several classes may share one imported course; Oxygen updates it only
when all published values encountered agree. Conflicts are left
untouched instead of using last-write-wins.

The start-list request is best-effort. If Eventor has not generated a
start list yet, class and entry sync still succeeds and the local
length remains unchanged.

## Regression coverage

- `eventor-course-lengths.test.ts` parses class ids, names and lengths
  from a representative Eventor IOF 3.0 start list.
- `integration/eventor-reentry.test.ts` verifies that `eventor.sync`
  replaces a geometric 1,200 m course length with Eventor's published
  2,480 m value.
