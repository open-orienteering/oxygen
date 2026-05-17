import { useTranslation } from "react-i18next";

interface Props {
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Course import dialog — temporarily simplified during the
 * MeOS→PostgreSQL migration. The OCD/IOF-XML parser pipeline is being
 * re-ported against the new schema; the full upload UI returns once it
 * lands.
 */
export function CourseImportDialog({ onClose }: Props) {
  const { t } = useTranslation("courses");
  void t;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-2xl dark:bg-gray-800">
        <h2 className="mb-2 text-lg font-semibold">Course import</h2>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
          Course import (OCD / IOF&nbsp;XML) is being re-ported against
          the new PostgreSQL schema. Coming back online shortly.
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
