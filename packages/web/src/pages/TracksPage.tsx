/**
 * Tracks page — being re-ported. The Livelox/GPX route pipeline is
 * staged with the rest of the post-MeOS work.
 */
export function TracksPage() {
  return (
    <div className="p-6">
      <h1 className="mb-2 text-xl font-semibold">Tracks</h1>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        The GPS tracks / Livelox routes view is being re-ported against
        the new PostgreSQL schema. Coming back online shortly.
      </p>
    </div>
  );
}

export default TracksPage;
