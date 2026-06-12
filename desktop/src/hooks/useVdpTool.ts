import { useEffect } from 'react';

export function useVdpTool(
    vdpFields: any[], 
    setVdpFields: (updater: any) => void, 
    selectedFieldIds: string[], 
    onSelectField?: (ids: string[]) => void,
    isActive: boolean = true
) {

    const updateSelectedField = (changes: any) => {
        if (!setVdpFields || selectedFieldIds.length === 0) return;
        setVdpFields((prev: any[]) => prev.map(f => selectedFieldIds.includes(f.id) ? { ...f, ...changes } : f));
    };

    const deleteSelectedField = () => {
        if (!setVdpFields || selectedFieldIds.length === 0) return;
        setVdpFields((prev: any[]) => prev.filter(f => !selectedFieldIds.includes(f.id)));
        if (onSelectField) onSelectField([]);
    };

    const handleGroupFields = () => {
        if (!setVdpFields || selectedFieldIds.length < 2) return;
        const newGroupId = `group_${Date.now()}`;
        setVdpFields((prev: any[]) => prev.map(f => selectedFieldIds.includes(f.id) ? { ...f, groupId: newGroupId } : f));
    };

    const handleUngroupFields = () => {
        if (!setVdpFields || selectedFieldIds.length === 0) return;
        setVdpFields((prev: any[]) => prev.map(f => selectedFieldIds.includes(f.id) ? { ...f, groupId: undefined } : f));
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Bỏ qua nếu tool thuộc tab nền (không active) — tránh phím tắt lây giữa các tab.
            if (!isActive) return;
            if (e.target instanceof HTMLInputElement || 
                e.target instanceof HTMLTextAreaElement || 
                e.target instanceof HTMLSelectElement) {
                return;
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedFieldIds.length > 0) {
                e.preventDefault();
                deleteSelectedField();
            }
            if (e.ctrlKey && e.key.toLowerCase() === 'g') {
                e.preventDefault();
                if (e.shiftKey) {
                    handleUngroupFields();
                } else {
                    handleGroupFields();
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedFieldIds, setVdpFields, onSelectField, isActive]);

    return {
        updateSelectedField,
        deleteSelectedField,
        handleGroupFields,
        handleUngroupFields
    };
}
