-- Oxygen initial schema. Replaces the MeOS-compatible MySQL multi-DB layout.
-- See docs/schema.md for the UUID+seq pattern, status enums, and overall conventions.

-- ─── Schema ─────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS oxygen;
SET search_path = oxygen, public;

-- ─── Enums ──────────────────────────────────────────────────

CREATE TYPE oxygen.runner_status AS ENUM (
  'unknown',
  'ok',
  'no_timing',
  'missing_punch',
  'dnf',
  'dq',
  'over_max_time',
  'out_of_competition',
  'dns',
  'cancel',
  'not_competing'
);

CREATE TYPE oxygen.control_status AS ENUM (
  'ok',
  'bad',
  'multiple',
  'start',
  'finish',
  'no_timing',
  'optional',
  'bad_no_timing',
  'check',
  'clear'
);

-- ─── Shared functions / triggers ────────────────────────────

CREATE OR REPLACE FUNCTION oxygen.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- ─── Registry ───────────────────────────────────────────────

CREATE TABLE oxygen.events (
  id                 BIGSERIAL PRIMARY KEY,
  name_id            TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  annotation         TEXT NOT NULL DEFAULT '',
  date               DATE NOT NULL,
  zero_time          INTEGER NOT NULL DEFAULT 324000,
  kind               TEXT NOT NULL DEFAULT 'competition',
  eventor_event_id   BIGINT,
  eventor_env        TEXT NOT NULL DEFAULT 'prod',

  liveresults_tavid  INTEGER,
  liveresults_config JSONB,

  organizer_name        TEXT NOT NULL DEFAULT '',
  organizer_eventor_id  INTEGER NOT NULL DEFAULT 0,
  email                 TEXT NOT NULL DEFAULT '',
  homepage              TEXT NOT NULL DEFAULT '',
  phone                 TEXT NOT NULL DEFAULT '',
  street                TEXT NOT NULL DEFAULT '',
  city                  TEXT NOT NULL DEFAULT '',
  zip                   TEXT NOT NULL DEFAULT '',
  org_number            TEXT NOT NULL DEFAULT '',
  vat_exempt            BOOLEAN NOT NULL DEFAULT TRUE,

  card_fee_cents        INTEGER NOT NULL DEFAULT 0,
  entry_fee_cents       INTEGER NOT NULL DEFAULT 0,
  elite_fee_cents       INTEGER NOT NULL DEFAULT 0,
  youth_fee_cents       INTEGER NOT NULL DEFAULT 0,
  youth_age             SMALLINT NOT NULL DEFAULT 0,
  senior_age            SMALLINT NOT NULL DEFAULT 0,
  late_entry_factor     TEXT NOT NULL DEFAULT '',
  ordinary_entry_date   INTEGER NOT NULL DEFAULT 0,
  second_entry_date     INTEGER NOT NULL DEFAULT 0,
  payment_due           INTEGER NOT NULL DEFAULT 0,

  currency_symbol     TEXT NOT NULL DEFAULT 'kr',
  currency_separator  TEXT NOT NULL DEFAULT ',',
  currency_code       TEXT NOT NULL DEFAULT 'SEK',
  currency_pre_symbol BOOLEAN NOT NULL DEFAULT FALSE,
  currency_factor     SMALLINT NOT NULL DEFAULT 1,

  air_plus                     BOOLEAN NOT NULL DEFAULT FALSE,
  awake_hours                  INTEGER NOT NULL DEFAULT 6,
  payment_methods              TEXT NOT NULL DEFAULT 'billed',
  swish_number                 TEXT NOT NULL DEFAULT '',
  swish_payee_name             TEXT NOT NULL DEFAULT '',
  print_registration_receipt   BOOLEAN NOT NULL DEFAULT FALSE,
  registration_receipt_message TEXT NOT NULL DEFAULT '',
  finish_receipt_message       TEXT NOT NULL DEFAULT '',
  receipt_friskvard_note       BOOLEAN NOT NULL DEFAULT FALSE,
  web_url                      TEXT NOT NULL DEFAULT '',
  google_sheets_webhook_url    TEXT NOT NULL DEFAULT '',
  livelox_event_id             INTEGER,

  use_economy    BOOLEAN NOT NULL DEFAULT FALSE,
  use_speaker    BOOLEAN NOT NULL DEFAULT FALSE,
  max_time       INTEGER NOT NULL DEFAULT 0,
  num_stages     SMALLINT NOT NULL DEFAULT 1,
  long_times     BOOLEAN NOT NULL DEFAULT FALSE,
  sub_seconds    BOOLEAN NOT NULL DEFAULT FALSE,
  no_vacant_bib  BOOLEAN NOT NULL DEFAULT FALSE,
  bib_gap        SMALLINT NOT NULL DEFAULT 0,
  bibs_per_class SMALLINT NOT NULL DEFAULT 0,

  pay_modes    JSONB,
  start_groups JSONB,
  control_map  JSONB,
  lists        JSONB,
  machine      JSONB,
  sp_extra     JSONB,
  iv_extra     JSONB,
  entry_extra  JSONB,
  split_print  TEXT NOT NULL DEFAULT '',

  removed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_removed_idx ON oxygen.events (removed);
CREATE TRIGGER trg_events_updated_at BEFORE UPDATE ON oxygen.events
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

-- ─── Per-event seq allocator ────────────────────────────────

CREATE TABLE oxygen.event_seqs (
  event_id   BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  next_seq   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (event_id, table_name)
);

CREATE OR REPLACE FUNCTION oxygen.allocate_event_seq() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  allocated INTEGER;
BEGIN
  IF NEW.seq IS NULL OR NEW.seq = 0 THEN
    INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
    VALUES (NEW.event_id, TG_TABLE_NAME, 2)
    ON CONFLICT (event_id, table_name)
    DO UPDATE SET next_seq = oxygen.event_seqs.next_seq + 1
    RETURNING next_seq - 1 INTO allocated;
    NEW.seq = allocated;
  END IF;
  RETURN NEW;
END $$;

-- ─── Global tables ──────────────────────────────────────────

CREATE TABLE oxygen.settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE oxygen.runner_directory (
  eventor_person_id BIGINT PRIMARY KEY,
  name              TEXT NOT NULL DEFAULT '',
  card_no           INTEGER NOT NULL DEFAULT 0,
  eventor_club_id   INTEGER NOT NULL DEFAULT 0,
  birth_year        SMALLINT NOT NULL DEFAULT 0,
  sex               CHAR(1) NOT NULL DEFAULT '',
  nationality       TEXT NOT NULL DEFAULT '',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX runner_directory_card_idx ON oxygen.runner_directory (card_no);
CREATE INDEX runner_directory_name_idx ON oxygen.runner_directory (name);
CREATE INDEX runner_directory_club_idx ON oxygen.runner_directory (eventor_club_id);
CREATE TRIGGER trg_runner_directory_updated_at BEFORE UPDATE ON oxygen.runner_directory
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

CREATE TABLE oxygen.club_directory (
  eventor_id     BIGINT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  short_name     TEXT NOT NULL DEFAULT '',
  country_code   CHAR(3) NOT NULL DEFAULT '',
  small_logo_png BYTEA,
  large_logo_png BYTEA,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_club_directory_updated_at BEFORE UPDATE ON oxygen.club_directory
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

CREATE TABLE oxygen.eventor_event_meta (
  eventor_event_id  INTEGER PRIMARY KEY,
  name              TEXT NOT NULL DEFAULT '',
  start_date        DATE NOT NULL,
  classification_id INTEGER NOT NULL DEFAULT 0,
  organiser         TEXT NOT NULL DEFAULT '',
  entry_count       INTEGER NOT NULL DEFAULT 0,
  fetched_at        TIMESTAMPTZ NOT NULL
);

CREATE TABLE oxygen.eventor_entry_history (
  eventor_event_id INTEGER NOT NULL
    REFERENCES oxygen.eventor_event_meta(eventor_event_id) ON DELETE CASCADE,
  row_seq          INTEGER NOT NULL,
  entry_class_id   INTEGER NOT NULL DEFAULT 0,
  entry_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (eventor_event_id, row_seq)
);

-- ─── Controls ───────────────────────────────────────────────

CREATE TABLE oxygen.controls (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id    BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL DEFAULT '',
  codes       TEXT NOT NULL DEFAULT '',
  status      oxygen.control_status NOT NULL DEFAULT 'ok',
  time_adjust INTEGER NOT NULL DEFAULT 0,
  min_time    INTEGER NOT NULL DEFAULT 0,
  xpos        DOUBLE PRECISION NOT NULL DEFAULT 0,
  ypos        DOUBLE PRECISION NOT NULL DEFAULT 0,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  radio_type  TEXT NOT NULL DEFAULT 'normal',
  air_plus    TEXT NOT NULL DEFAULT 'default',
  removed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, seq)
);
COMMENT ON COLUMN oxygen.controls.xpos IS
  'OCD map X coordinate (real decimal value). MeOS stored x*10 as int.';
COMMENT ON COLUMN oxygen.controls.lat IS
  'WGS84 latitude (real decimal value). MeOS stored lat*1e6 as int. NULL until coords are imported.';
CREATE INDEX controls_event_removed_idx ON oxygen.controls (event_id, removed);
CREATE TRIGGER trg_controls_allocate_seq BEFORE INSERT ON oxygen.controls
  FOR EACH ROW EXECUTE FUNCTION oxygen.allocate_event_seq();
CREATE TRIGGER trg_controls_updated_at BEFORE UPDATE ON oxygen.controls
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

-- ─── Courses ────────────────────────────────────────────────

CREATE TABLE oxygen.courses (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id          BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL DEFAULT 0,
  name              TEXT NOT NULL DEFAULT '',
  length_m          INTEGER NOT NULL DEFAULT 0,
  climb_m           INTEGER NOT NULL DEFAULT 0,
  number_of_maps    INTEGER NOT NULL DEFAULT 0,
  start_name        TEXT NOT NULL DEFAULT '',
  legs              TEXT NOT NULL DEFAULT '',
  first_as_start    BOOLEAN NOT NULL DEFAULT FALSE,
  last_as_finish    BOOLEAN NOT NULL DEFAULT FALSE,
  finish_control_id UUID REFERENCES oxygen.controls(id) ON DELETE SET NULL,
  shorten           INTEGER NOT NULL DEFAULT 0,
  removed           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, seq)
);
CREATE INDEX courses_event_removed_idx ON oxygen.courses (event_id, removed);
CREATE TRIGGER trg_courses_allocate_seq BEFORE INSERT ON oxygen.courses
  FOR EACH ROW EXECUTE FUNCTION oxygen.allocate_event_seq();
CREATE TRIGGER trg_courses_updated_at BEFORE UPDATE ON oxygen.courses
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

CREATE TABLE oxygen.course_controls (
  course_id  UUID NOT NULL REFERENCES oxygen.courses(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  control_id UUID NOT NULL REFERENCES oxygen.controls(id) ON DELETE RESTRICT,
  PRIMARY KEY (course_id, position)
);
CREATE INDEX course_controls_control_idx ON oxygen.course_controls (control_id);

-- ─── Classes ────────────────────────────────────────────────

CREATE TABLE oxygen.classes (
  id                              UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id                        BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  seq                             INTEGER NOT NULL DEFAULT 0,
  name                            TEXT NOT NULL DEFAULT '',
  long_name                       TEXT NOT NULL DEFAULT '',
  course_id                       UUID REFERENCES oxygen.courses(id) ON DELETE SET NULL,
  eventor_id                      BIGINT,
  low_age                         SMALLINT NOT NULL DEFAULT 0,
  high_age                        SMALLINT NOT NULL DEFAULT 0,
  sex                             TEXT NOT NULL DEFAULT '',
  class_type                      TEXT NOT NULL DEFAULT '',
  class_fee_cents                 INTEGER NOT NULL DEFAULT 0,
  class_fee_red_cents             INTEGER NOT NULL DEFAULT 0,
  high_class_fee_cents            INTEGER NOT NULL DEFAULT 0,
  high_class_fee_red_cents        INTEGER NOT NULL DEFAULT 0,
  second_high_class_fee_cents     INTEGER NOT NULL DEFAULT 0,
  second_high_class_fee_red_cents INTEGER NOT NULL DEFAULT 0,
  allow_quick_entry               BOOLEAN NOT NULL DEFAULT FALSE,
  vacant_count                    INTEGER NOT NULL DEFAULT 0,
  reserved_count                  INTEGER NOT NULL DEFAULT 0,
  start_name                      TEXT NOT NULL DEFAULT '',
  start_block                     INTEGER NOT NULL DEFAULT 0,
  no_timing                       BOOLEAN NOT NULL DEFAULT FALSE,
  free_start                      BOOLEAN NOT NULL DEFAULT FALSE,
  request_start                   BOOLEAN NOT NULL DEFAULT FALSE,
  ignore_start                    BOOLEAN NOT NULL DEFAULT FALSE,
  first_start                     INTEGER NOT NULL DEFAULT 0,
  start_interval                  INTEGER NOT NULL DEFAULT 0,
  sort_index                      INTEGER NOT NULL DEFAULT 0,
  max_time                        INTEGER NOT NULL DEFAULT 0,
  status                          TEXT NOT NULL DEFAULT '',
  direct_result                   BOOLEAN NOT NULL DEFAULT FALSE,
  bib                             TEXT NOT NULL DEFAULT '',
  bib_mode                        TEXT NOT NULL DEFAULT '',
  unordered                       BOOLEAN NOT NULL DEFAULT FALSE,
  number_maps                     INTEGER NOT NULL DEFAULT 0,
  result                          TEXT NOT NULL DEFAULT '',
  leg_method                      TEXT NOT NULL DEFAULT '',
  qualification                   JSONB,
  transfer_flags                  INTEGER NOT NULL DEFAULT 0,
  removed                         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, seq)
);
COMMENT ON COLUMN oxygen.classes.status IS
  'Free-form MeOS tournament-status code (varchar(5) in MeOS). Typically empty; values like "Q","F1","F2" appear in qualifying schemes.';
CREATE INDEX classes_event_removed_idx ON oxygen.classes (event_id, removed);
CREATE INDEX classes_course_idx        ON oxygen.classes (course_id);
CREATE INDEX classes_event_eventor_idx ON oxygen.classes (event_id, eventor_id);
CREATE TRIGGER trg_classes_allocate_seq BEFORE INSERT ON oxygen.classes
  FOR EACH ROW EXECUTE FUNCTION oxygen.allocate_event_seq();
CREATE TRIGGER trg_classes_updated_at BEFORE UPDATE ON oxygen.classes
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

CREATE TABLE oxygen.class_course_pools (
  class_id  UUID NOT NULL REFERENCES oxygen.classes(id) ON DELETE CASCADE,
  stage     SMALLINT NOT NULL DEFAULT 0,
  course_id UUID NOT NULL REFERENCES oxygen.courses(id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, stage, course_id)
);

-- ─── Cards & readouts ──────────────────────────────────────

CREATE TABLE oxygen.card_readouts (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id    BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  card_no     INTEGER NOT NULL,
  card_type   TEXT NOT NULL DEFAULT '',
  punches     JSONB NOT NULL,
  voltage_mv  INTEGER NOT NULL DEFAULT 0,
  battery_low BOOLEAN,
  owner_data  JSONB,
  metadata    JSONB,
  station_id  TEXT,
  read_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX card_readouts_event_card_idx ON oxygen.card_readouts (event_id, card_no);
CREATE INDEX card_readouts_event_time_idx ON oxygen.card_readouts (event_id, read_at DESC);

CREATE TABLE oxygen.cards (
  id           UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id     BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL DEFAULT 0,
  card_no      INTEGER NOT NULL,
  readout_id   UUID REFERENCES oxygen.card_readouts(id) ON DELETE SET NULL,
  read_count   INTEGER NOT NULL DEFAULT 0,
  voltage_mv   INTEGER NOT NULL DEFAULT 0,
  battery_date INTEGER NOT NULL DEFAULT 0,
  punches_raw  TEXT NOT NULL DEFAULT '',
  removed      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, seq)
);
CREATE INDEX cards_event_card_idx ON oxygen.cards (event_id, card_no);
CREATE TRIGGER trg_cards_allocate_seq BEFORE INSERT ON oxygen.cards
  FOR EACH ROW EXECUTE FUNCTION oxygen.allocate_event_seq();
CREATE TRIGGER trg_cards_updated_at BEFORE UPDATE ON oxygen.cards
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

-- ─── Runners ───────────────────────────────────────────────

CREATE TABLE oxygen.runners (
  id                 UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id           BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL DEFAULT 0,
  class_id           UUID REFERENCES oxygen.classes(id) ON DELETE SET NULL,
  club_name          TEXT NOT NULL DEFAULT '',
  eventor_club_id    BIGINT,
  course_id          UUID REFERENCES oxygen.courses(id) ON DELETE SET NULL,
  card_id            UUID REFERENCES oxygen.cards(id) ON DELETE SET NULL,
  name               TEXT NOT NULL DEFAULT '',
  card_no            INTEGER NOT NULL DEFAULT 0,
  start_no           INTEGER NOT NULL DEFAULT 0,
  start_time         INTEGER NOT NULL DEFAULT 0,
  finish_time        INTEGER NOT NULL DEFAULT 0,
  status             oxygen.runner_status NOT NULL DEFAULT 'unknown',
  bib                TEXT NOT NULL DEFAULT '',
  birth_year         SMALLINT NOT NULL DEFAULT 0,
  sex                TEXT NOT NULL DEFAULT '',
  nationality        TEXT NOT NULL DEFAULT '',
  country            TEXT NOT NULL DEFAULT '',
  phone              TEXT NOT NULL DEFAULT '',
  entry_date         INTEGER NOT NULL DEFAULT 0,
  entry_time         INTEGER NOT NULL DEFAULT 0,
  entry_source       INTEGER NOT NULL DEFAULT 0,
  eventor_person_id  BIGINT,
  eventor_entry_id   BIGINT,
  fee_cents          INTEGER NOT NULL DEFAULT 0,
  card_fee_cents     INTEGER NOT NULL DEFAULT 0,
  paid_cents         INTEGER NOT NULL DEFAULT 0,
  pay_mode           SMALLINT NOT NULL DEFAULT 0,
  taxable_cents      INTEGER NOT NULL DEFAULT 0,
  card_returned      BOOLEAN NOT NULL DEFAULT FALSE,
  input_time         INTEGER NOT NULL DEFAULT 0,
  input_status       oxygen.runner_status NOT NULL DEFAULT 'unknown',
  input_points       INTEGER NOT NULL DEFAULT 0,
  input_place        INTEGER NOT NULL DEFAULT 0,
  input_result       JSONB,
  multi_results      JSONB,
  rank               INTEGER NOT NULL DEFAULT 0,
  priority           SMALLINT NOT NULL DEFAULT 0,
  time_adjust        INTEGER NOT NULL DEFAULT 0,
  point_adjust       INTEGER NOT NULL DEFAULT 0,
  transfer_flags     INTEGER NOT NULL DEFAULT 0,
  shorten            BOOLEAN NOT NULL DEFAULT FALSE,
  start_group        INTEGER NOT NULL DEFAULT 0,
  no_restart         BOOLEAN NOT NULL DEFAULT FALSE,
  heat               SMALLINT NOT NULL DEFAULT 0,
  reference          INTEGER NOT NULL DEFAULT 0,
  family             INTEGER NOT NULL DEFAULT 0,
  annotation         TEXT NOT NULL DEFAULT '',
  removed            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, seq)
);
COMMENT ON COLUMN oxygen.runners.club_name IS
  'Free-text club name. Always populated for non-clubless runners. Eventor-linked runners also have eventor_club_id set.';
COMMENT ON COLUMN oxygen.runners.eventor_club_id IS
  'References club_directory.eventor_id when the runner''s club is in the global directory. Not enforced as FK so a runner can keep a stale club_name even if directory rows are pruned.';
CREATE INDEX runners_event_class_idx   ON oxygen.runners (event_id, class_id, removed);
CREATE INDEX runners_event_eventor_club_idx ON oxygen.runners (event_id, eventor_club_id, removed);
CREATE INDEX runners_event_clubname_idx ON oxygen.runners (event_id, lower(club_name));
CREATE INDEX runners_event_card_idx    ON oxygen.runners (event_id, card_no);
CREATE INDEX runners_event_status_idx  ON oxygen.runners (event_id, status, removed);
CREATE INDEX runners_event_start_idx   ON oxygen.runners (event_id, start_time);
CREATE INDEX runners_event_eventor_idx ON oxygen.runners (event_id, eventor_person_id);
CREATE INDEX runners_event_name_idx    ON oxygen.runners (event_id, lower(name));
CREATE TRIGGER trg_runners_allocate_seq BEFORE INSERT ON oxygen.runners
  FOR EACH ROW EXECUTE FUNCTION oxygen.allocate_event_seq();
CREATE TRIGGER trg_runners_updated_at BEFORE UPDATE ON oxygen.runners
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

-- ─── Teams ─────────────────────────────────────────────────

CREATE TABLE oxygen.teams (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id        BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL DEFAULT 0,
  class_id        UUID REFERENCES oxygen.classes(id) ON DELETE SET NULL,
  club_name       TEXT NOT NULL DEFAULT '',
  eventor_club_id BIGINT,
  name            TEXT NOT NULL DEFAULT '',
  start_no        INTEGER NOT NULL DEFAULT 0,
  start_time      INTEGER NOT NULL DEFAULT 0,
  finish_time     INTEGER NOT NULL DEFAULT 0,
  status          oxygen.runner_status NOT NULL DEFAULT 'unknown',
  bib             TEXT NOT NULL DEFAULT '',
  members         UUID[] NOT NULL DEFAULT '{}',
  input_time      INTEGER NOT NULL DEFAULT 0,
  input_status    oxygen.runner_status NOT NULL DEFAULT 'unknown',
  input_points    INTEGER NOT NULL DEFAULT 0,
  input_place     INTEGER NOT NULL DEFAULT 0,
  input_result    JSONB,
  fee_cents       INTEGER NOT NULL DEFAULT 0,
  paid_cents      INTEGER NOT NULL DEFAULT 0,
  pay_mode        SMALLINT NOT NULL DEFAULT 0,
  eventor_id      BIGINT,
  entry_source    INTEGER NOT NULL DEFAULT 0,
  transfer_flags  INTEGER NOT NULL DEFAULT 0,
  no_restart      BOOLEAN NOT NULL DEFAULT FALSE,
  annotation      TEXT NOT NULL DEFAULT '',
  removed         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, seq)
);
CREATE INDEX teams_event_class_idx ON oxygen.teams (event_id, class_id, removed);
CREATE TRIGGER trg_teams_allocate_seq BEFORE INSERT ON oxygen.teams
  FOR EACH ROW EXECUTE FUNCTION oxygen.allocate_event_seq();
CREATE TRIGGER trg_teams_updated_at BEFORE UPDATE ON oxygen.teams
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

-- ─── Control units & punches ───────────────────────────────

CREATE TABLE oxygen.control_units (
  id                   UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id             BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  seq                  INTEGER NOT NULL DEFAULT 0,
  station_serial       INTEGER NOT NULL,
  control_id           UUID REFERENCES oxygen.controls(id) ON DELETE SET NULL,
  last_programmed_code INTEGER,
  battery_voltage_mv   INTEGER,
  battery_low          BOOLEAN NOT NULL DEFAULT FALSE,
  checked_at           TIMESTAMPTZ,
  memory_cleared_at    TIMESTAMPTZ,
  firmware_version     TEXT,
  model_id             INTEGER,
  model_name           TEXT,
  last_seen_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, seq),
  UNIQUE (event_id, station_serial)
);
CREATE INDEX control_units_control_idx ON oxygen.control_units (control_id);
CREATE TRIGGER trg_control_units_allocate_seq BEFORE INSERT ON oxygen.control_units
  FOR EACH ROW EXECUTE FUNCTION oxygen.allocate_event_seq();
CREATE TRIGGER trg_control_units_updated_at BEFORE UPDATE ON oxygen.control_units
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

CREATE TABLE oxygen.punches (
  id           UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id     BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  card_no      INTEGER NOT NULL,
  control_code INTEGER NOT NULL,
  control_id   UUID REFERENCES oxygen.controls(id) ON DELETE SET NULL,
  unit_id      UUID REFERENCES oxygen.control_units(id) ON DELETE SET NULL,
  time         INTEGER NOT NULL,
  punched_at   TIMESTAMPTZ,
  sub_second   SMALLINT,
  source       TEXT NOT NULL DEFAULT 'card',
  is_original  BOOLEAN NOT NULL DEFAULT TRUE,
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed      BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX punches_event_card_idx     ON oxygen.punches (event_id, card_no);
CREATE INDEX punches_event_control_idx  ON oxygen.punches (event_id, control_id);
CREATE INDEX punches_event_imported_idx ON oxygen.punches (event_id, imported_at DESC);
CREATE UNIQUE INDEX punches_oi_dedup_idx ON oxygen.punches (event_id, card_no, control_code, time)
  WHERE source = 'online_input';

-- ─── Event log ─────────────────────────────────────────────

CREATE TABLE oxygen.event_log (
  id               UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id         BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,
  station_id       TEXT NOT NULL,
  client_timestamp TIMESTAMPTZ NOT NULL,
  payload          JSONB NOT NULL,
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX event_log_event_time_idx ON oxygen.event_log (event_id, client_timestamp DESC);
CREATE INDEX event_log_event_type_idx ON oxygen.event_log (event_id, type);

-- ─── Maps & GPS tracks ─────────────────────────────────────

CREATE TABLE oxygen.map_files (
  id          BIGSERIAL PRIMARY KEY,
  event_id    BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL DEFAULT '',
  file_data   BYTEA NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX map_files_event_idx ON oxygen.map_files (event_id);

CREATE TABLE oxygen.rendered_maps (
  id          BIGSERIAL PRIMARY KEY,
  event_id    BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  max_width   INTEGER NOT NULL,
  image_data  BYTEA NOT NULL,
  bounds      JSONB NOT NULL,
  map_scale   INTEGER NOT NULL DEFAULT 0,
  width       INTEGER NOT NULL DEFAULT 0,
  height      INTEGER NOT NULL DEFAULT 0,
  rendered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rendered_maps_event_idx ON oxygen.rendered_maps (event_id);

CREATE TABLE oxygen.map_tiles (
  event_id  BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  z         INTEGER NOT NULL,
  x         INTEGER NOT NULL,
  y         INTEGER NOT NULL,
  tile_data BYTEA NOT NULL,
  PRIMARY KEY (event_id, z, x, y)
);

CREATE TABLE oxygen.tracks (
  id            BIGSERIAL PRIMARY KEY,
  event_id      BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  track_name    TEXT NOT NULL DEFAULT '',
  start_time_ms BIGINT NOT NULL,
  end_time_ms   BIGINT,
  distance_m    DOUBLE PRECISION NOT NULL DEFAULT 0,
  point_count   INTEGER NOT NULL DEFAULT 0,
  geometry      JSONB NOT NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, device_id, start_time_ms)
);
CREATE TRIGGER trg_tracks_updated_at BEFORE UPDATE ON oxygen.tracks
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

CREATE TABLE oxygen.routes (
  id               BIGSERIAL PRIMARY KEY,
  event_id         BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  runner_id        UUID REFERENCES oxygen.runners(id) ON DELETE SET NULL,
  class_id         UUID REFERENCES oxygen.classes(id) ON DELETE SET NULL,
  livelox_class_id INTEGER,
  source_type      TEXT NOT NULL DEFAULT 'livelox',
  color            TEXT NOT NULL DEFAULT '',
  race_start_ms    BIGINT,
  waypoints        JSONB NOT NULL,
  interruptions    JSONB,
  result           JSONB,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX routes_event_runner_idx ON oxygen.routes (event_id, runner_id);
