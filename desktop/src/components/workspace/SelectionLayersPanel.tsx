import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Button } from '../Button';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { globalPdfObjectCache } from '../../stores/pdfObjectCache';
import { Lock, LockOpen, Eye, EyeOff, Trash2, FolderOpen, Plus, Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { UseEditSession } from '../../hooks/useEditSession';
import { confirmDialog } from '../ui/confirmDialog';
import { toast } from '../ui/Toast';
import { assignComponentsToDeepestLayers } from './layerComponentTree';
import { requestEditObjectFocus, scrollElementVerticallyIntoView } from './verticalScroll';

// ═══════════════════════════════════════════════════════════
//  Edit PDF Layers & Components Panel (unified)
//  Repurposed for Object Edit mode (isObjectEditMode).
//  Uses accurate editObjects from /edit/objects (PDFium) for "thành phần".
//  OCG layers use real /edit/ocg/visibility when in edit (live session).
//  Search, icons, hide/show (ẩn hiện), and delete are wired; OCG reorder is intentionally disabled.
// ═══════════════════════════════════════════════════════════

interface OcgLayer {
    id: number;
    name: string;
    visible: boolean;
    locked: boolean;
    depth: number;
    children: OcgLayer[];
    color: string;
    isGroup?: boolean;
    isVirtual?: boolean;
    isPageLayer?: boolean;
    parentOcgId?: number;
    pageNum?: number;
}

interface EditLayersPanelProps {
    tabId?: string;
    handleDeleteObjects: (objs: any[], pageNum: number) => void;
    // For edit PDF upgrade: pass accurate current page objects from edit system for "thành phần"
    editObjects?: any[];
    isEditMode?: boolean;
    editSession?: UseEditSession;
}

export default function EditLayersPanel({
    tabId,
    handleDeleteObjects,
    editObjects,
    isEditMode,
    editSession,
}: EditLayersPanelProps) {
  const { t } = useTranslation();
    const {
        pdfUrl, selectedObjectIds, setSelectedObjectIds, hiddenObjectIds, setHiddenObjectIds,
        lockedObjectIds, setLockedObjectIds,
        pdfOcgLayers, hiddenOcgLayerIds, setHiddenOcgLayerIds,
        lockedOcgLayerIds, setLockedOcgLayerIds,
        expandedOcgLayerIds, setExpandedOcgLayerIds,
        viewerActivePage, setError,
        editAddMode, setEditAddMode,
    } = useWorkspaceStore(useShallow(state => ({
        pdfUrl: state.pdfUrl,
        selectedObjectIds: state.selectedObjectIds, setSelectedObjectIds: state.setSelectedObjectIds,
        hiddenObjectIds: state.hiddenObjectIds, setHiddenObjectIds: state.setHiddenObjectIds,
        lockedObjectIds: state.lockedObjectIds, setLockedObjectIds: state.setLockedObjectIds,
        pdfOcgLayers: state.pdfOcgLayers, hiddenOcgLayerIds: state.hiddenOcgLayerIds,
        setHiddenOcgLayerIds: state.setHiddenOcgLayerIds,
        lockedOcgLayerIds: state.lockedOcgLayerIds, setLockedOcgLayerIds: state.setLockedOcgLayerIds,
        expandedOcgLayerIds: state.expandedOcgLayerIds, setExpandedOcgLayerIds: state.setExpandedOcgLayerIds,
        viewerActivePage: state.viewerActivePage,
        setError: state.setError,
        editAddMode: state.editAddMode, setEditAddMode: state.setEditAddMode,
    })));

    const [searchTerm, setSearchTerm] = useState(''); // Search for components (thành phần)
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; layer: OcgLayer } | null>(null);
    const [renamingId, setRenamingId] = useState<number | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const renameInputRef = useRef<HTMLInputElement>(null);

    // Layer PDF chỉ gồm OCG thật. Các nhóm trang/layer ảo do PrynX suy ra được
    // quản lý ở khu vực Thành phần, không giả làm layer gốc của Illustrator/Corel.
    const realOcgLayers = useMemo(() => {
        const onlyReal = (items: OcgLayer[]): OcgLayer[] => items
            .filter(layer => !layer.isVirtual && !layer.isPageLayer)
            .map(layer => ({ ...layer, children: onlyReal(layer.children || []) }));
        return onlyReal(pdfOcgLayers || []);
    }, [pdfOcgLayers]);
    const realOcgCount = useMemo(() => {
        const count = (items: OcgLayer[]): number => items.reduce(
            (total, layer) => total + (layer.id > 0 ? 1 : 0) + count(layer.children || []),
            0,
        );
        return count(realOcgLayers);
    }, [realOcgLayers]);

    const componentRows = useMemo(() => {
        const sourceObjects = isEditMode
            ? (editObjects || [])
            : Object.values(globalPdfObjectCache.getAllObjects(pdfUrl || '')).flat();
        const topmostFirst = [...sourceObjects].sort((a: any, b: any) =>
            (Number(b.drawIndex) || 0) - (Number(a.drawIndex) || 0)
        );
        const counters: Record<string, number> = { text: 0, image: 0, vector: 0 };
        const labeled = topmostFirst.map((obj: any) => {
            const type = String(obj.type || 'vector');
            counters[type] = (counters[type] || 0) + 1;
            const content = String(obj.content || '').trim().replace(/\s+/g, ' ');
            const displayName = type === 'text'
                ? (content
                    ? t('misc.selectionLayers:text_noi_dung', { content: content.slice(0, 40) })
                    : t('misc.selectionLayers:text_n', { n: counters[type] }))
                : type === 'image'
                    ? t('misc.selectionLayers:anh_n', { n: counters[type] })
                    : t('misc.selectionLayers:vector_n', { n: counters[type] });
            return { ...obj, _displayName: displayName };
        });
        const query = searchTerm.trim().toLowerCase();
        return labeled.filter((obj: any) =>
            !query || `${obj._displayName} ${obj.content || ''} ${obj.type || ''}`.toLowerCase().includes(query)
        );
    }, [isEditMode, editObjects, pdfUrl, searchTerm, t]);

    const { byLayerId: componentsByLayerId, unlayered: unlayeredComponents } = useMemo(
        () => assignComponentsToDeepestLayers(realOcgLayers, componentRows),
        [realOcgLayers, componentRows],
    );
    const allComponentIds = useMemo(() => {
        const source = isEditMode
            ? (editObjects || [])
            : Object.values(globalPdfObjectCache.getAllObjects(pdfUrl || '')).flat();
        return source.map((obj: any) => String(obj.id));
    }, [isEditMode, editObjects, pdfUrl]);
    const allComponentsSelected = allComponentIds.length > 0
        && allComponentIds.every(id => selectedObjectIds.includes(id));
    // Canvas → panel: khi selection đổi (vd click object trên canvas), cuộn dòng
    // tương ứng vào tầm nhìn. Chỉ ĐỌC selectedObjectIds + gọi scroll → không set lại
    // → không có feedback loop. Object không thuộc trang active không có ref → bỏ qua
    // (danh sách "Thành phần" chỉ chứa object trang đang xem). (gộp F7↔edit 2026-07-07)
    const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const pendingCanvasFocusRef = useRef<string | null>(null);
    useEffect(() => {
        const syncVisibility = (event: Event) => {
            const detail = (event as CustomEvent).detail || {};
            if (detail.tabId !== tabId) return;
            if (Number(detail.page) !== Math.max(0, viewerActivePage - 1)) return;
            const ids: string[] = Array.isArray(detail.targetIds) ? detail.targetIds : [];
            setHiddenObjectIds(prev => detail.visible
                ? prev.filter(id => !ids.includes(id))
                : Array.from(new Set([...prev, ...ids]))
            );
        };
        window.addEventListener('edit-object-visibility-changed', syncVisibility);
        return () => window.removeEventListener('edit-object-visibility-changed', syncVisibility);
    }, [viewerActivePage, setHiddenObjectIds, tabId]);
    useEffect(() => {
        const objectId = pendingCanvasFocusRef.current;
        if (!objectId || !selectedObjectIds.includes(objectId)) return;
        pendingCanvasFocusRef.current = null;
        requestEditObjectFocus(objectId, Math.max(0, viewerActivePage - 1));
    }, [selectedObjectIds, viewerActivePage]);
    useEffect(() => {
        const firstId = selectedObjectIds[0];
        if (firstId == null) return;
        const el = itemRefs.current[firstId];
        const scrollContainer = el?.closest<HTMLElement>('[data-layer-scroll]');
        if (el && scrollContainer) {
            scrollElementVerticallyIntoView(el, scrollContainer, 'nearest');
        }
    }, [selectedObjectIds]);

    // ─── Toggle Eye (Visibility) ───────────────────────────
    const handleToggleVisibility = useCallback(async (layerId: number) => {
        const wasHidden = hiddenOcgLayerIds.includes(layerId);
        const nextHidden = wasHidden
            ? hiddenOcgLayerIds.filter(id => id !== layerId)
            : [...hiddenOcgLayerIds, layerId];

        // Optimistic UI; rollback nếu live session từ chối thao tác.
        setHiddenOcgLayerIds(nextHidden);
        if (!isEditMode) return;

        try {
            if (!editSession?.sessionId) throw new Error('Phiên chỉnh sửa chưa sẵn sàng, vui lòng thử lại.');
            const outcome = await editSession.applyOp({
                page: Math.max(0, viewerActivePage - 1), kind: 'layerVisibility', targetIds: [],
                layerId, visible: wasHidden,
            });
            if (!outcome) throw new Error('Không thể cập nhật layer.');
        } catch (err: any) {
            setHiddenOcgLayerIds(hiddenOcgLayerIds);
            setError(err?.message || 'Không thể thay đổi trạng thái layer.');
        }
    }, [hiddenOcgLayerIds, setHiddenOcgLayerIds, isEditMode, editSession, viewerActivePage, setError]);
    // ─── Toggle Lock ───────────────────────────────────────
    const handleToggleLock = useCallback(async (layerId: number) => {
        const wasLocked = lockedOcgLayerIds.includes(layerId);
        const nextLocked = wasLocked
            ? lockedOcgLayerIds.filter(id => id !== layerId)
            : [...lockedOcgLayerIds, layerId];
        setLockedOcgLayerIds(nextLocked);
        try {
            if (!editSession?.sessionId) throw new Error('Phiên chỉnh sửa chưa sẵn sàng.');
            const outcome = await editSession.applyOp({
                page: Math.max(0, viewerActivePage - 1), kind: 'layerLock', targetIds: [],
                layerId, locked: !wasLocked,
            });
            if (!outcome) throw new Error('Không thể khóa/mở khóa layer.');
        } catch (err: any) {
            setLockedOcgLayerIds(lockedOcgLayerIds);
            setError(err?.message || 'Không thể khóa/mở khóa layer.');
        }
    }, [lockedOcgLayerIds, setLockedOcgLayerIds, editSession, viewerActivePage, setError]);
    // ─── Toggle Expand/Collapse ────────────────────────────
    const handleToggleExpand = useCallback((layerId: number) => {
        setExpandedOcgLayerIds(prev =>
            prev.includes(layerId)
                ? prev.filter(id => id !== layerId)
                : [...prev, layerId]
        );
    }, [setExpandedOcgLayerIds]);

    // ─── Rename ────────────────────────────────────────────
    const startRename = useCallback((layer: OcgLayer) => {
        setRenamingId(layer.id);
        setRenameValue(layer.name);
        setContextMenu(null);
        setTimeout(() => renameInputRef.current?.focus(), 50);
    }, []);

    const commitRename = useCallback(async () => {
        if (!renamingId || !renameValue.trim()) {
            setRenamingId(null);
            return;
        }
        try {
            setIsLoading(true);
            if (!editSession?.sessionId) throw new Error('Phiên chỉnh sửa chưa sẵn sàng.');
            const outcome = await editSession.applyOp({
                page: Math.max(0, viewerActivePage - 1), kind: 'layerRename', targetIds: [],
                layerId: renamingId, layerName: renameValue.trim(),
            });
            if (!outcome) throw new Error('Không thể đổi tên layer.');
        } catch (err: any) {
            setError(err?.message || 'Không thể đổi tên layer.');
        } finally {
            setIsLoading(false);
            setRenamingId(null);
        }
    }, [renamingId, renameValue, editSession, viewerActivePage, setError]);
    // ─── Delete Layer ──────────────────────────────────────
    const handleDeleteLayer = useCallback(async (layerId: number) => {
        setContextMenu(null);
        try {
            setIsLoading(true);
            if (!editSession?.sessionId) throw new Error('Phiên chỉnh sửa chưa sẵn sàng.');
            const outcome = await editSession.applyOp({
                page: Math.max(0, viewerActivePage - 1), kind: 'layerDelete', targetIds: [], layerId,
            });
            if (!outcome) throw new Error('Không thể xóa layer.');
            setHiddenOcgLayerIds(prev => prev.filter(id => id !== layerId));
            setLockedOcgLayerIds(prev => prev.filter(id => id !== layerId));
        } catch (err: any) {
            setError(err?.message || 'Không thể xóa layer.');
        } finally {
            setIsLoading(false);
        }
    }, [editSession, setHiddenOcgLayerIds, setLockedOcgLayerIds, viewerActivePage, setError]);
    // ─── Flatten ───────────────────────────────────────────
    const handleFlatten = useCallback(async () => {
        setContextMenu(null);
        const confirmed = await confirmDialog({
            title: 'Tạo Working File đã Flatten?',
            message: 'PrynX sẽ tạo một Working File mới từ trạng thái layer đang hiển thị. File hiện tại vẫn được giữ lại để bạn có thể Ctrl+Z quay về.\n\nCác hiệu ứng layer phức tạp có thể được raster hóa; PrynX sẽ cảnh báo trong kết quả.',
            confirmText: 'Tạo file Flatten',
            cancelText: 'Hủy',
            danger: true,
        });
        if (!confirmed) return;

        try {
            setIsLoading(true);
            if (!editSession?.sessionId) {
                throw new Error('Phiên chỉnh sửa chưa sẵn sàng.');
            }
            const result = await editSession.flatten();
            if (!result?.success || !result.output_fid) {
                throw new Error('Không thể tạo Working File Flatten.');
            }
            // GS-SUNSET (audit 2026-07-28 §FL.2): toast là bề mặt UI nhìn thấy thật;
            // reportMsg không được render nên trước đây cảnh báo vẫn bị mất.
            if (result.warning) {
                toast.info(`⚠ ${result.warning}`);
            }
        } catch (err: any) {
            setError(err?.message || 'Flatten layer thất bại.');
        } finally {
            setIsLoading(false);
        }
    }, [editSession, setError]);
    // ─── Context Menu ──────────────────────────────────────
    const handleContextMenu = useCallback((e: React.MouseEvent, layer: OcgLayer) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, layer });
    }, []);

    const selectComponentFromPanel = (objectId: string, alreadySelected: boolean) => {
        if (!alreadySelected) pendingCanvasFocusRef.current = objectId;
        setSelectedObjectIds(prev =>
            prev.includes(objectId) ? prev.filter(id => id !== objectId) : [...prev, objectId]
        );
    };
    const renderComponentItem = (obj: any, keyPrefix: string = 'component') => {
        const isSelected = selectedObjectIds.includes(obj.id);
        const isHidden = hiddenObjectIds.includes(obj.id);
        const isLocked = lockedObjectIds.includes(obj.id);
        return (
            <div
                key={`${keyPrefix}-${obj.id}`}
                ref={el => { itemRefs.current[obj.id] = el; }}
                className={`flex items-center gap-1.5 px-2 py-1.5 text-xs cursor-pointer border-b border-slate-100 dark:border-zinc-700/50 hover:bg-slate-50 dark:hover:bg-zinc-700/50 transition-colors ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''} ${isHidden ? 'opacity-50' : ''} ${isLocked ? 'opacity-60' : ''}`}
            >
                <button
                    onClick={async (e) => {
                        e.stopPropagation();
                        const wasHidden = hiddenObjectIds.includes(obj.id);
                        setHiddenObjectIds(prev => wasHidden
                            ? prev.filter(id => id !== obj.id)
                            : [...prev, obj.id]
                        );
                        if (!isEditMode) return;
                        try {
                            if (!editSession?.sessionId) throw new Error('Phiên chỉnh sửa chưa sẵn sàng.');
                            const outcome = await editSession.applyOp({
                                page: Math.max(0, viewerActivePage - 1),
                                kind: 'objectVisibility',
                                targetIds: [obj.id],
                                visible: wasHidden,
                            });
                            if (!outcome) throw new Error('Không thể đổi hiển thị thành phần.');
                        } catch (err: any) {
                            setHiddenObjectIds(prev => wasHidden
                                ? Array.from(new Set([...prev, obj.id]))
                                : prev.filter(id => id !== obj.id)
                            );
                            setError(err?.message || 'Không thể đổi hiển thị thành phần.');
                        }
                    }}
                    className={`w-5 h-5 flex items-center justify-center rounded hover:bg-slate-200 dark:hover:bg-zinc-600 transition-colors shrink-0 ${isHidden ? 'text-red-400' : 'text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200'}`}
                    title={isHidden ? t('misc.selectionLayers:hien_thanh_phan') : t('misc.selectionLayers:an_thanh_phan')}
                    aria-label={isHidden ? t('misc.selectionLayers:hien_thanh_phan') : t('misc.selectionLayers:an_thanh_phan')}
                >
                    {isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        setLockedObjectIds(prev =>
                            prev.includes(obj.id) ? prev.filter(id => id !== obj.id) : [...prev, obj.id]
                        );
                        setSelectedObjectIds(prev => prev.filter(id => id !== obj.id));
                    }}
                    className={`w-5 h-5 flex items-center justify-center rounded hover:bg-slate-200 dark:hover:bg-zinc-600 transition-colors shrink-0 ${isLocked ? 'text-amber-500' : 'text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200'}`}
                    title={isLocked ? t('misc.selectionLayers:mo_khoa_thanh_phan') : t('misc.selectionLayers:khoa_thanh_phan')}
                    aria-label={isLocked ? t('misc.selectionLayers:mo_khoa_thanh_phan') : t('misc.selectionLayers:khoa_thanh_phan')}
                >
                    {isLocked ? <Lock className="w-3.5 h-3.5" /> : <LockOpen className="w-3.5 h-3.5" />}
                </button>
                <input
                    type="checkbox"
                    checked={isSelected}
                    readOnly
                    disabled={isLocked}
                    onClick={(e) => {
                        e.stopPropagation();
                        if (isLocked) return;
                        selectComponentFromPanel(obj.id, isSelected);
                    }}
                    className={`rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-3 h-3 ${isLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                />
                <span className={`font-mono text-[9px] w-8 shrink-0 ${{
                    text: 'text-blue-500',
                    image: 'text-purple-500',
                    vector: 'text-yellow-600',
                }[obj.type as string] || 'text-slate-500'}`}>
                    {obj.type === 'text' ? 'T' : obj.type === 'image' ? '🖼' : obj.type === 'vector' ? '✏️' : '•'}
                </span>
                <span
                    className={`truncate flex-1 text-[11px] ${isHidden ? 'line-through text-slate-400' : ''} ${isLocked ? 'italic text-slate-400' : ''}`}
                    title={obj._displayName}
                    onClick={() => {
                        if (isLocked) return;
                        selectComponentFromPanel(obj.id, isSelected);
                    }}
                >
                    {obj._displayName}
                </span>
            </div>
        );
    };
    // ─── Render Layer Tree Item ────────────────────────────
    const renderLayerItem = (layer: OcgLayer, depth: number = 0) => {
        const actionLayerId = layer.parentOcgId ?? layer.id;
        const isSyntheticPageLayer = !!layer.isPageLayer;
        const isLabelGroup = !!layer.isGroup && actionLayerId < 0;
        const isHidden = !isLabelGroup && hiddenOcgLayerIds.includes(actionLayerId);
        const isLocked = !isLabelGroup && lockedOcgLayerIds.includes(actionLayerId);
        const isExpanded = expandedOcgLayerIds.includes(layer.id);
        const layerComponents = layer.id > 0 ? (componentsByLayerId.get(layer.id) || []) : [];
        const hasChildren = (layer.children && layer.children.length > 0) || layerComponents.length > 0;
        const isRenaming = renamingId === layer.id;

        return (
            <div key={`layer-${layer.id}`}>
                <div
                    className={`flex items-center gap-1 py-1 px-1.5 rounded-md text-[12px] transition-all cursor-pointer group/layer
                        ${isHidden ? 'opacity-40' : ''} 
                        hover:bg-slate-50 dark:hover:bg-zinc-700/50
                        ${isLocked ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}
                    `}
                    style={{ paddingLeft: `${depth * 16 + 4}px` }}
                    onContextMenu={(e) => { if (!isSyntheticPageLayer && !isLabelGroup) handleContextMenu(e, layer); }}
                    onDoubleClick={() => !layer.isGroup && !isSyntheticPageLayer && startRename(layer)}
                >
                    {/* Expand/Collapse Arrow */}
                    {hasChildren ? (
                        <button
                            onClick={(e) => { e.stopPropagation(); handleToggleExpand(layer.id); }}
                            className="w-4 h-4 flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 transition-colors shrink-0"
                            aria-label={isExpanded ? t('misc.selectionLayers:thu_gon_nhom_lop') : t('misc.selectionLayers:mo_rong_nhom_lop')}
                        >
                            <svg className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                            </svg>
                        </button>
                    ) : (
                        <div className="w-4 shrink-0" />
                    )}

                    {/* Color Dot */}
                    <div 
                        className={`w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/10 ${isLabelGroup ? 'invisible' : ''}`}
                        style={{ backgroundColor: layer.color || '#3b82f6' }}
                    />

                    {/* Eye Toggle */}
                    {!isLabelGroup && (
                    <button
                        onClick={(e) => { e.stopPropagation(); handleToggleVisibility(actionLayerId); }}
                        className={`w-5 h-5 flex items-center justify-center rounded transition-colors shrink-0 ${
                            isHidden 
                                ? 'text-slate-300 dark:text-zinc-600 hover:text-slate-500' 
                                : 'text-slate-500 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-400'
                        }`}
                        title={isHidden ? t('misc.selectionLayers:hien_thi_lop') : t('misc.selectionLayers:an_lop')}
                        aria-label={isHidden ? t('misc.selectionLayers:hien_thi_lop') : t('misc.selectionLayers:an_lop')}
                    >
                        {isHidden ? (
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                            </svg>
                        ) : (
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                        )}
                    </button>
                    )}

                    {/* Lock Toggle */}
                    {!isLabelGroup && (
                    <button
                        onClick={(e) => { e.stopPropagation(); handleToggleLock(actionLayerId); }}
                        className={`w-5 h-5 flex items-center justify-center rounded transition-colors shrink-0 ${
                            isLocked 
                                ? 'text-amber-500 hover:text-amber-600' 
                                : 'text-slate-300 dark:text-zinc-600 hover:text-slate-500 dark:hover:text-zinc-400 opacity-0 group-hover/layer:opacity-100'
                        }`}
                        title={isLocked ? t('misc.selectionLayers:mo_khoa_lop') : t('misc.selectionLayers:khoa_lop')}
                        aria-label={isLocked ? t('misc.selectionLayers:mo_khoa_lop') : t('misc.selectionLayers:khoa_lop')}
                    >
                        {isLocked ? (
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                            </svg>
                        ) : (
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2H7V7a3 3 0 015.905-.75 1 1 0 001.937-.5A5.002 5.002 0 0010 2z" />
                            </svg>
                        )}
                    </button>
                    )}

                    {/* Layer Name */}
                    {isRenaming ? (
                        <input
                            ref={renameInputRef}
                            className="flex-1 bg-white dark:bg-zinc-700 border border-blue-400 rounded px-1.5 py-0.5 text-[12px] outline-none text-slate-800 dark:text-zinc-100"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRename();
                                if (e.key === 'Escape') setRenamingId(null);
                            }}
                        />
                    ) : (
                        <>
                        <span className={`truncate flex-1 ${
                            isHidden ? 'text-slate-400 dark:text-zinc-500 line-through' : 
                            layer.isGroup ? 'text-slate-600 dark:text-zinc-300 font-bold italic' : 
                            'text-slate-700 dark:text-zinc-200 font-medium'
                        }`}>
                            {layer.isGroup ? (<><FolderOpen className="w-3 h-3 inline-block mr-1 -mt-0.5" />{layer.name}</>) : layer.name}
                        </span>
                        {layerComponents.length > 0 && (
                            <span className="text-[9px] min-w-5 px-1 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 text-center shrink-0">
                                {layerComponents.length}
                            </span>
                        )}
                        </>
                    )}

                </div>

                {/* Children */}
                {hasChildren && isExpanded && (
                    <div className="border-l border-slate-200 dark:border-zinc-700 ml-3">
                        {layer.children.map(child => renderLayerItem(child, depth + 1))}
                        {layerComponents.map((obj: any) => renderComponentItem(obj, 'layer-' + layer.id))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="flex flex-col h-full gap-3">
            {/* Unified OCG + Thành phần view for Edit PDF upgrade */}
            <div className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 px-1">{t('misc.selectionLayers:layer_pdf')}</div>

            {/* Loading Overlay */}
            {isLoading && (
                <div className="absolute inset-0 z-50 bg-white/70 dark:bg-zinc-900/70 flex items-center justify-center rounded-lg backdrop-blur-sm">
                    <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-xs font-medium">{t('misc.selectionLayers:dang_xu_ly')}</span>
                    </div>
                </div>
            )}

                    <div className="flex items-center justify-between shrink-0 bg-white dark:bg-zinc-800 p-2 rounded-md border border-slate-200 dark:border-zinc-700">
                        <span className="font-medium text-[13px] text-slate-700 dark:text-zinc-300">{t('misc.selectionLayers:da_chon')} <strong className="text-blue-600 dark:text-blue-400">{selectedObjectIds.length}</strong></span>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                placeholder={t('misc.selectionLayers:tim_thanh_phan')}
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="text-[11px] px-2 py-0.5 rounded border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                            />
                            <button
                                onClick={() => setSelectedObjectIds(allComponentsSelected ? [] : allComponentIds)}
                                className="text-[11px] bg-slate-100 hover:bg-slate-200 dark:bg-zinc-700 dark:hover:bg-zinc-600 px-2 py-1 rounded transition-colors text-slate-600 dark:text-zinc-300"
                            >
                                {allComponentsSelected ? t('misc.selectionLayers:bo_chon') : t('misc.selectionLayers:chon_tat_ca')}
                            </button>
                        </div>
                    </div>

            {searchTerm.trim() && componentRows.length === 0 && (
                <div className="shrink-0 px-2 py-1 text-[11px] text-slate-400 italic">
                    {t('misc.selectionLayers:khong_co_thanh_phan_khop_tim_kiem')}
                </div>
            )}
            {/* OCG Layers Section */}
            <>
                    {/* Toolbar */}
                    <div className="flex items-center gap-1 px-1 shrink-0">
                        <button
                            onClick={handleFlatten}
                            className="text-[10px] bg-slate-100 hover:bg-slate-200 dark:bg-zinc-700 dark:hover:bg-zinc-600 px-2 py-1 rounded transition-colors text-slate-600 dark:text-zinc-300 flex items-center gap-1"
                            title={t('misc.selectionLayers:flatten_visible_gop_tat_ca_layer_thanh')}
                        >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                            </svg>
                            Flatten
                        </button>
                        <div className="flex-1" />
                        <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-mono">
                            {realOcgCount} layers
                        </span>
                    </div>

                    {/* Layer Tree */}
                    <div data-layer-scroll className="flex-1 overflow-y-auto border border-slate-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-800 scroller-thin p-1">
                        {realOcgLayers.length > 0 ? (
                            <div className="flex flex-col gap-0.5">
                                {realOcgLayers.map((layer: OcgLayer) => renderLayerItem(layer))}
                            </div>
                        ) : (
                            <div className="p-6 text-center">
                                <div className="text-3xl mb-2 opacity-30">🎨</div>
                                <p className="text-slate-400 dark:text-zinc-500 italic text-xs">
                                    {t('misc.selectionLayers:file_khong_co_layer_goc')}
                                </p>
                                <p className="text-slate-300 dark:text-zinc-600 text-[10px] mt-1">
                                    {t('misc.selectionLayers:file_can_co_cau_truc_ocg_optional')}
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Keyboard Hints */}
                    <div className="shrink-0 text-[9px] text-slate-400 dark:text-zinc-600 px-1 flex gap-3">
                        <span className="flex items-center gap-1"><Eye className="w-3 h-3" /> {t('misc.selectionLayers:an_hien')}</span>
                        <span className="flex items-center gap-1"><Lock className="w-3 h-3" /> {t('misc.selectionLayers:khoa')}</span>
                        <span>{t('misc.selectionLayers:2x_click_doi_ten')}</span>
                        <span>{t('misc.selectionLayers:thu_tu_layer_theo_file_goc')}</span>
                    </div>
                </>

            {/* Thêm object mới: nút điều khiển editAddMode (STORE dùng chung). Bật →
                cú bấm kế tiếp lên BẤT KỲ trang nào đặt object tại đó. Dời từ canvas
                vào panel cho gọn màn hình (2026-07-07). */}
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={() => setEditAddMode(editAddMode === 'text' ? null : 'text')}
                            className={`flex-1 px-2 py-1 text-[12px] rounded border inline-flex items-center justify-center gap-1 transition-colors ${editAddMode === 'text' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border-slate-300 dark:border-zinc-600 hover:bg-slate-50 dark:hover:bg-zinc-700'}`}
                        ><Plus className="w-3.5 h-3.5" /> Text</button>
                        <button
                            type="button"
                            onClick={() => setEditAddMode(editAddMode === 'image' ? null : 'image')}
                            className={`flex-1 px-2 py-1 text-[12px] rounded border inline-flex items-center justify-center gap-1 transition-colors ${editAddMode === 'image' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border-slate-300 dark:border-zinc-600 hover:bg-slate-50 dark:hover:bg-zinc-700'}`}
                        ><ImageIcon className="w-3.5 h-3.5" /> {t('misc.selectionLayers:anh')}</button>
                    </div>
                    {editAddMode && (
                        <div className="shrink-0 text-[11px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-1 rounded">
                            {t('misc.selectionLayers:bam_len_trang_de_dat', { obj: editAddMode === 'text' ? 'text' : t('misc.selectionLayers:anh_2') })}
                        </div>
                    )}

            {unlayeredComponents.length > 0 && (
                <>
                    <div className="flex items-center gap-2 px-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400">
                        <span className="flex-1">{t('misc.selectionLayers:khong_thuoc_layer_pdf')}</span>
                        <span className="text-[9px] min-w-5 px-1 py-0.5 rounded-full bg-slate-200 dark:bg-zinc-700 text-slate-600 dark:text-zinc-300 text-center">
                            {unlayeredComponents.length}
                        </span>
                    </div>
                    <div data-layer-scroll className="max-h-[35%] overflow-y-auto border border-slate-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-800 scroller-thin">
                        {unlayeredComponents.map((obj: any) => renderComponentItem(obj, 'unlayered'))}
                    </div>
                </>
            )}
                    <div className="shrink-0 pt-2">
                        <Button
                            variant="primary"
                            className="w-full bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700 border-transparent text-white shadow-md flex justify-center items-center gap-2"
                            disabled={selectedObjectIds.length === 0}
                            onClick={() => {
                                const source = isEditMode ? (editObjects || []) : Object.values(globalPdfObjectCache.getAllObjects(pdfUrl || '')).flat();
                                const objectsToDelete = source.filter((o: any) => selectedObjectIds.includes(o.id));
                                if (objectsToDelete.length > 0) {
                                    handleDeleteObjects(objectsToDelete, 1);
                                }
                            }}
                        >
                            <Trash2 className="w-4 h-4" /> {t('misc.selectionLayers:xoa_n_thanh_phan_da_chon', { n: selectedObjectIds.length })}
                        </Button>
                    </div>

            {/* Context Menu */}
            {contextMenu && (
                <>
                    <div className="fixed inset-0 z-context-menu" onClick={() => setContextMenu(null)} />
                    <div 
                        className="fixed z-context-menu bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-lg shadow-xl py-1 min-w-[160px] animate-fade-in"
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                    >
                        <button 
                            onClick={() => startRename(contextMenu.layer)}
                            className="w-full text-left px-3 py-1.5 text-[12px] text-slate-700 dark:text-zinc-200 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center gap-2"
                        >
                            <span>✏️</span> {t('misc.selectionLayers:doi_ten')}
                        </button>
                        <button 
                            onClick={() => handleToggleLock(contextMenu.layer.id)}
                            className="w-full text-left px-3 py-1.5 text-[12px] text-slate-700 dark:text-zinc-200 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center gap-2"
                        >
                            <span>{lockedOcgLayerIds.includes(contextMenu.layer.id) ? <LockOpen className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}</span> 
                            {lockedOcgLayerIds.includes(contextMenu.layer.id) ? t('misc.selectionLayers:mo_khoa') : t('misc.selectionLayers:khoa')}
                        </button>
                        <div className="border-t border-slate-100 dark:border-zinc-700 my-1" />
                        <button 
                            onClick={handleFlatten}
                            className="w-full text-left px-3 py-1.5 text-[12px] text-slate-700 dark:text-zinc-200 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center gap-2"
                        >
                            <span>📋</span> Flatten Visible
                        </button>
                        <div className="border-t border-slate-100 dark:border-zinc-700 my-1" />
                        <button 
                            onClick={() => handleDeleteLayer(contextMenu.layer.id)}
                            className="w-full text-left px-3 py-1.5 text-[12px] text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 flex items-center gap-2"
                        >
                            <span><Trash2 className="w-3.5 h-3.5" /></span> {t('misc.selectionLayers:xoa_lop')}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
