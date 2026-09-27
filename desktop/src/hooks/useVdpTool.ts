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
    fontDataUrl?: string;
    fontStyle?: string;
    fontWeight?: number | string;
    fontSize?: number;
    lineHeight?: number;
    characterSpacing?: number;
    alignment?: string;
    fontColor?: string;
    rotation?: number;
    curveMode?: 'none' | 'arc_top' | 'arc_bottom' | 'wave';
    curveRadius?: number;
    curveOrientation?: 'outward' | 'inward';
    curveTracking?: number;
    strokeColor?: string;
    strokeWidth?: number;
    strokeLineJoin?: 'miter' | 'round' | 'bevel';
    strokeLineCap?: 'butt' | 'round' | 'square';
    shadowColor?: string;
    shadowOffsetX?: number;
    shadowOffsetY?: number;
    shadowBlur?: number;
    [property: string]: unknown;
}

export type VdpFieldsUpdater = VdpToolField[] | ((previous: VdpToolField[]) => VdpToolField[]);
export type SetVdpFields = (updater: VdpFieldsUpdater) => void;

// Clipboard lưu trữ các trường VDP sao chép (dùng chung qua các lần render)
let vdpClipboard: VdpToolField[] = [];
let vdpPasteCount = 0;

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

    const copySelectedFields = useCallback(() => {
        if (selectedFieldIds.length === 0) return;
        vdpClipboard = vdpFields
            .filter(f => selectedFieldIds.includes(f.id))
            .map(f => ({ ...f }));
        vdpPasteCount = 0;
    }, [selectedFieldIds, vdpFields]);

    const pasteFields = useCallback(() => {
        if (!setVdpFields || vdpClipboard.length === 0) return;
        vdpPasteCount++;
        const offsetMM = 5 * vdpPasteCount; // 5mm offset mỗi lần dán liên tiếp
        const newGroupId = `group_${Date.now()}`;
        const hasMultiple = vdpClipboard.length > 1;
        const newFieldIds: string[] = [];
        const copies: VdpToolField[] = [];
        const dims = workspaceStore?.getState().viewerPageDimMm ?? null;

        vdpClipboard.forEach(f => {
            const copyId = `field_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            newFieldIds.push(copyId);

            let newName = f.name;
            if (newName) {
                const match = newName.match(/^(.*?)(\d+)$/);
                if (match) {
                    const baseName = match[1];
                    const currentNum = parseInt(match[2], 10);
                    let nextNum = currentNum + 1;
                    while (vdpFields.some(ef => ef.name === `${baseName}${nextNum}`) || copies.some(c => c.name === `${baseName}${nextNum}`)) {
                        nextNum++;
                    }
                    newName = `${baseName}${nextNum}`;
                } else {
                    let nextNum = 2;
                    while (vdpFields.some(ef => ef.name === `${newName}_${nextNum}`) || copies.some(c => c.name === `${newName}_${nextNum}`)) {
                        nextNum++;
                    }
                    newName = `${newName}_${nextNum}`;
                }
            }

            let newTextContent = f.textContent;
            if (newTextContent && f.name) {
                newTextContent = newTextContent.replace(new RegExp(`\\{${f.name}\\}`, 'g'), `{${newName}}`);
            }

            let nx = (f.x ?? 0) + offsetMM;
            let ny = (f.y ?? 0) + offsetMM;
            if (dims) {
                nx = Math.max(0, Math.min(nx, Math.max(0, dims.w - (f.width ?? 10))));
                ny = Math.max(0, Math.min(ny, Math.max(0, dims.h - (f.height ?? 10))));
            } else {
                nx = Math.max(0, nx);
                ny = Math.max(0, ny);
            }

            copies.push({
                ...f,
                id: copyId,
                name: newName,
                textContent: newTextContent,
                x: nx,
                y: ny,
                groupId: hasMultiple ? newGroupId : undefined,
                qrStyle: f.qrStyle ? { ...f.qrStyle } : undefined,
                conditions: f.conditions ? JSON.parse(JSON.stringify(f.conditions)) : undefined,
                rules: f.rules ? JSON.parse(JSON.stringify(f.rules)) : undefined,
            });
        });

        setVdpFields(prev => [...prev, ...copies]);
        if (onSelectField) {
            onSelectField(newFieldIds);
        }
    }, [setVdpFields, vdpFields, onSelectField, workspaceStore]);

    const duplicateSelectedFields = useCallback(() => {
        if (selectedFieldIds.length === 0 || !setVdpFields) return;
        const selected = vdpFields.filter(f => selectedFieldIds.includes(f.id));
        if (selected.length === 0) return;
        vdpClipboard = selected.map(f => ({ ...f }));
        vdpPasteCount = 0;
        pasteFields();
    }, [selectedFieldIds, vdpFields, setVdpFields, pasteFields]);

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

            // Ctrl+C (hoặc Cmd+C): Sao chép trường đang chọn
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
                if (selectedFieldIds.length > 0) {
                    e.preventDefault();
                    copySelectedFields();
                }
                return;
            }
            // Ctrl+V (hoặc Cmd+V): Dán trường đã sao chép
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
                if (vdpClipboard.length > 0) {
                    e.preventDefault();
                    pasteFields();
                }
                return;
            }
            // Ctrl+D (hoặc Cmd+D): Nhân bản tức thì (Duplicate)
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
                if (selectedFieldIds.length > 0) {
                    e.preventDefault();
                    duplicateSelectedFields();
                }
                return;
            }
            // Ctrl+A (hoặc Cmd+A): Chọn tất cả các trường
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                if (vdpFields.length > 0 && onSelectField) {
                    e.preventDefault();
                    onSelectField(vdpFields.map(f => f.id));
                }
                return;
            }

            // UIUX (audit 2026-07-27 §D-02): phím mũi tên di chuyển field đang chọn.
            const ARROW_DELTA: Record<string, [number, number]> = {
                ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
            };
            if (ARROW_DELTA[e.key] && selectedFieldIds.length > 0 && setVdpFields) {
                e.preventDefault(); // không cuộn trang khi đang di chuyển field
                const step = (e.shiftKey ? 5 : 0.5) / 0.75;
                const [dx, dy] = ARROW_DELTA[e.key];
                const dims = workspaceStore?.getState().viewerPageDimMm ?? null;
                setVdpFields((prev) => prev.map(f => {
                    if (!selectedFieldIds.includes(f.id)) return f;
                    let nx = (f.x || 0) + dx * step;
                    let ny = (f.y || 0) + dy * step;
                    if (dims) {
                        nx = Math.max(0, Math.min(nx, dims.w - (f.width || 0)));
                        ny = Math.max(0, Math.min(ny, dims.h - (f.height || 0)));
                    } else {
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
    }, [selectedFieldIds, vdpFields, setVdpFields, onSelectField, isActive, workspaceStore, deleteSelectedField, handleGroupFields, handleUngroupFields, copySelectedFields, pasteFields, duplicateSelectedFields]);

    return {
        updateSelectedField,
        deleteSelectedField,
        handleGroupFields,
        handleUngroupFields,
        copySelectedFields,
        pasteFields,
        duplicateSelectedFields,
    };
}
