import { useCallback, useContext, useEffect } from 'react';
import { WorkspaceContext } from '@/stores/useWorkspaceStore'; // UIUX (audit 2026-07-27 §D-02) fix-verify

export interface VdpToolField {
    id: string;
    name: string;
    type?: string;
    pageNum?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    position?: { x: number; y: number };
    groupId?: string;
    textContent?: string | null;
    fontName?: string;
    fontFile?: string;
    fontStyle?: string;
    fontSize?: number;
    lineHeight?: number;
    characterSpacing?: number;
    alignment?: string;
    fontColor?: string;
    rotation?: number;
    curveMode?: 'none' | 'arc_top' | 'arc_bottom';
    curveRadius?: number;
    curveOrientation?: 'outward' | 'inward';
    curveTracking?: number;
    [property: string]: unknown;
}

export type VdpFieldsUpdater = VdpToolField[] | ((previous: VdpToolField[]) => VdpToolField[]);
export type SetVdpFields = (updater: VdpFieldsUpdater) => void;

export function useVdpTool(
    vdpFields: VdpToolField[],
    setVdpFields: SetVdpFields | undefined,
    selectedFieldIds: string[], 
    onSelectField?: (ids: string[]) => void,
    isActive: boolean = true
) {
    // UIUX (audit 2026-07-27 §D-02) fix-verify: lấy store workspace qua useContext
    // (KHÔNG qua useWorkspaceStore — hook đó throw khi thiếu Provider); đọc
    // getState() tại thời điểm bấm phím để không dính closure stale.
    const workspaceStore = useContext(WorkspaceContext);

    const updateSelectedField = useCallback((changes: Partial<VdpToolField>) => {
        if (!setVdpFields || selectedFieldIds.length === 0) return;
        setVdpFields((prev) => prev.map(f => selectedFieldIds.includes(f.id) ? { ...f, ...changes } : f));
    }, [selectedFieldIds, setVdpFields]);

    const deleteSelectedField = useCallback(() => {
        if (!setVdpFields || selectedFieldIds.length === 0) return;
        setVdpFields((prev) => prev.filter(f => !selectedFieldIds.includes(f.id)));
        if (onSelectField) onSelectField([]);
    }, [selectedFieldIds, setVdpFields, onSelectField]);

    const handleGroupFields = useCallback(() => {
        if (!setVdpFields || selectedFieldIds.length < 2) return;
        const newGroupId = `group_${Date.now()}`;
        setVdpFields((prev) => prev.map(f => selectedFieldIds.includes(f.id) ? { ...f, groupId: newGroupId } : f));
    }, [selectedFieldIds, setVdpFields]);

    const handleUngroupFields = useCallback(() => {
        if (!setVdpFields || selectedFieldIds.length === 0) return;
        setVdpFields((prev) => prev.map(f => selectedFieldIds.includes(f.id) ? { ...f, groupId: undefined } : f));
    }, [selectedFieldIds, setVdpFields]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Bỏ qua nếu tool thuộc tab nền (không active) — tránh phím tắt lây giữa các tab.
            if (!isActive) return;
            if (e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement ||
                e.target instanceof HTMLSelectElement ||
                (e.target instanceof HTMLElement && e.target.isContentEditable)) { // UIUX (audit 2026-07-27 §D-02)
                return;
            }
            // UIUX (audit 2026-07-27 §D-02): phím mũi tên di chuyển field đang chọn.
            // field.x/y lưu theo "mm phồng" (CSS px) — cộng thẳng vào x/y như drag làm.
            // Để bước nhảy TRÒN SỐ theo mm THẬT (hiển thị = lưu × 0.75): 0.5mm thật
            // = 0.5/0.75 đơn vị lưu; Shift = 5mm thật = 5/0.75 đơn vị lưu.
            const ARROW_DELTA: Record<string, [number, number]> = {
                ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
            };
            if (ARROW_DELTA[e.key] && selectedFieldIds.length > 0 && setVdpFields) {
                e.preventDefault(); // không cuộn trang khi đang di chuyển field
                const step = (e.shiftKey ? 5 : 0.5) / 0.75;
                const [dx, dy] = ARROW_DELTA[e.key];
                // UIUX (audit 2026-07-27 §D-02) fix-verify: kẹp biên trang khi nudge.
                // viewerPageDimMm CÙNG đơn vị "CSS-mm" với field.x/y/width/height
                // (AcrobatViewer set = mm thật × 96/72; VdpAlignPanel cũng dùng thẳng
                // pageDimMm.w với f.x/f.width) → kẹp trực tiếp, không đổi đơn vị.
                const dims = workspaceStore?.getState().viewerPageDimMm ?? null;
                setVdpFields((prev) => prev.map(f => {
                    if (!selectedFieldIds.includes(f.id)) return f;
                    let nx = (f.x || 0) + dx * step;
                    let ny = (f.y || 0) + dy * step;
                    if (dims) {
                        nx = Math.max(0, Math.min(nx, dims.w - (f.width || 0)));
                        ny = Math.max(0, Math.min(ny, dims.h - (f.height || 0)));
                    } else {
                        // Không có kích thước trang → tối thiểu không cho âm.
                        nx = Math.max(0, nx);
                        ny = Math.max(0, ny);
                    }
                    return { ...f, x: nx, y: ny };
                }));
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
    }, [selectedFieldIds, setVdpFields, onSelectField, isActive, workspaceStore, deleteSelectedField, handleGroupFields, handleUngroupFields]);

    return {
        updateSelectedField,
        deleteSelectedField,
        handleGroupFields,
        handleUngroupFields
    };
}
