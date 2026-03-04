import type { ReactNode } from 'react';

interface BulkActionBarProps {
    count: number;
    onDeselectAll: () => void;
    children: ReactNode;
}

/**
 * A floating, sticky bottom bar that appears when items are selected.
 * It provides a slot for actions to be performed on the selection.
 */
export function BulkActionBar({ count, onDeselectAll, children }: BulkActionBarProps) {
    if (count === 0) return null;

    return (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 animate-slide-up">
            <div className="bg-white border border-slate-200 shadow-2xl rounded-2xl px-6 py-3 flex items-center gap-8 min-w-[500px]">
                <div className="flex items-center gap-3 pr-6 border-r border-slate-100 flex-shrink-0">
                    <div className="bg-blue-600 text-white w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shadow-sm">
                        {count}
                    </div>
                    <div className="flex flex-col">
                        <span className="text-sm font-semibold text-slate-900">selected</span>
                        <button
                            onClick={onDeselectAll}
                            className="text-[11px] text-slate-500 hover:text-blue-600 underline text-left transition-colors cursor-pointer"
                        >
                            Deselect all
                        </button>
                    </div>
                </div>

                <div className="flex-1 flex items-center gap-4">
                    {children}
                </div>
            </div>
        </div>
    );
}
