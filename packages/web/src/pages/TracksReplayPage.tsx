/**
 * Tracks replay page — being re-ported. Renders an animated replay of
 * GPS routes. Pending the Livelox re-port.
 */
export function TracksReplayPage() {
  return (
    <div className="p-6">
      <h1 className="mb-2 text-xl font-semibold">Tracks replay</h1>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        The replay view is being re-ported against the new PostgreSQL
        schema. Coming back online shortly.
      </p>
    </div>
  );
}

export default TracksReplayPage;
