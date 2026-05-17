/**
 * Registration dialog — being re-ported. The Eventor-driven runner
 * lookup / club picker / payment flow is staged with the rest of the
 * post-MeOS work.
 */
interface Props {
  onClose: () => void;
  onSuccess?: (runnerId: number) => void;
  initialCardNo?: number;
}

export function RegistrationDialog({ onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-2xl dark:bg-gray-800">
        <h2 className="mb-2 text-lg font-semibold">Register runner</h2>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
          The runner registration dialog is being re-ported against the
          new PostgreSQL schema. Coming back online shortly.
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-gray-200 px-4 py-2 text-sm font-medium hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
