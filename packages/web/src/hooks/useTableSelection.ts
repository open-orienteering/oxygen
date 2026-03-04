import { useState, useCallback, useMemo } from 'react';

/**
 * A reusable hook for managing multi-selection of items in a table.
 * It tracks selected IDs in a Set and provides helpers for toggling.
 */
export function useTableSelection<T extends { id: number }>(items: T[]) {
    const [selected, setSelected] = useState<Set<number>>(new Set());

    const isSelected = useCallback((id: number) => selected.has(id), [selected]);

    const toggle = useCallback((id: number) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    const selectAll = useCallback(() => {
        setSelected(prev => {
            const next = new Set(prev);
            items.forEach(item => next.add(item.id));
            return next;
        });
    }, [items]);

    const deselectAll = useCallback(() => {
        setSelected(prev => {
            const next = new Set(prev);
            items.forEach(item => next.delete(item.id));
            return next;
        });
    }, [items]);

    const allSelected = useMemo(() => {
        if (items.length === 0) return false;
        return items.every(item => selected.has(item.id));
    }, [items, selected]);

    const someSelected = useMemo(() => {
        return items.some(item => selected.has(item.id));
    }, [items, selected]);

    const toggleAll = useCallback(() => {
        if (allSelected) {
            deselectAll();
        } else {
            selectAll();
        }
    }, [allSelected, deselectAll, selectAll]);

    const clearSelection = useCallback(() => {
        setSelected(new Set());
    }, []);

    return {
        selected,
        isSelected,
        toggle,
        toggleAll,
        selectAll,
        deselectAll,
        allSelected,
        someSelected,
        count: selected.size,
        clearSelection
    };
}
