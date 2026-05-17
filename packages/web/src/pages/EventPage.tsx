import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";

/**
 * Event page — simplified during the post-MeOS migration. Surfaces the
 * core event metadata and configuration; the full Eventor sync /
 * LiveResults push / Online Input config panels are being re-ported
 * against the new schema as separate follow-ups.
 */
export function EventPage() {
  const { t } = useTranslation("event");
  void t;
  const dashboard = trpc.competition.dashboard.useQuery();
  const event = dashboard.data?.event;

  return (
    <div className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{event?.name ?? "Event"}</h1>
        {event?.annotation && (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {event.annotation}
          </p>
        )}
      </header>

      <section className="rounded-lg border bg-white p-4 shadow dark:bg-gray-800">
        <h2 className="mb-2 text-lg font-semibold">Event</h2>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-gray-500">Slug</dt>
          <dd>{event?.nameId ?? "—"}</dd>
          <dt className="text-gray-500">Date</dt>
          <dd>{event?.date ?? "—"}</dd>
          <dt className="text-gray-500">Eventor environment</dt>
          <dd>{event?.eventorEnv ?? "prod"}</dd>
          <dt className="text-gray-500">Eventor event ID</dt>
          <dd>{event?.eventorEventId ?? "—"}</dd>
          <dt className="text-gray-500">Runners</dt>
          <dd>{dashboard.data?.totalRunners ?? 0}</dd>
          <dt className="text-gray-500">Clubs</dt>
          <dd>{dashboard.data?.totalClubs ?? 0}</dd>
          <dt className="text-gray-500">Classes</dt>
          <dd>{dashboard.data?.classes?.length ?? 0}</dd>
          <dt className="text-gray-500">Courses</dt>
          <dd>{dashboard.data?.totalCourses ?? 0}</dd>
          <dt className="text-gray-500">Controls</dt>
          <dd>{dashboard.data?.totalControls ?? 0}</dd>
        </dl>
      </section>

      <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
        <h2 className="mb-2 text-lg font-semibold">Migration notice</h2>
        <p className="text-sm">
          The Eventor sync, LiveResults push, Online Input puller,
          Livelox / Google Sheets / receipt-printer panels are being
          re-ported against the new PostgreSQL schema. They return once
          each pipeline lands; see{" "}
          <code>docs/migrations/2026-drop-meos.md</code> for status.
        </p>
      </section>
    </div>
  );
}

export default EventPage;
