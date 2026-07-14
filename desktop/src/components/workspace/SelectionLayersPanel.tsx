import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Button } from '../Button';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { globalPdfObjectCache } from '../../stores/pdfObjectCache';
import { authenticatedFetch, getApiUrl } from '../../lib/api';
import { Lock, LockOpen, Eye, EyeOff, Trash2, FolderOpen, Plus, Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// ═══════════════════════════════════════════════════════════
//  Edit PDF Layers & Components Panel (unified)
//  Repurposed for Object Edit mode (isObjectEditMode).
//  Uses accurate editObjects from /edit/objects (PDFium) for "thành phần".
//  OCG layers use real /edit/ocg/visibility when in edit (live session).
//  Search, icons, hide/show (ẩn hiện), reorder, delete wired.
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
}

interface EditLayersPanelProps {
    handleDeleteObjects: (objs: any[], pageNum: number) => void;
    fetchPdfObjectsForPage: (pageNum: number) => Promise<void>;
    // For edit PDF upgrade: pass accurate current page objects from edit system for "thành phần"
    editObjects?: any[];
    isEditMode?: boolean;
}

export default function EditLayersPanel({
    handleDeleteObjects,
    fetchPdfObjectsForPage,
    editObjects,
    isEditMode,
}: EditLayersPanelProps) {
  const { t } = useTranslation();
    const { 
        pdfUrl, pdfObjectsVersion, selectedObjectIds, setSelectedObjectIds, hiddenObjectIds, setHiddenObjectIds,
        lockedObjectIds, setLockedObjectIds,
        pdfOcgLayers, hiddenOcgLayerIds, setHiddenOcgLayerIds,
        lockedOcgLayerIds, setLockedOcgLayerIds,
        expandedOcgLayerIds, setExpandedOcgLayerIds,
        selectionFileId, viewerNumPages,
        setPdfObjectsVersion,
        setViewerDirty,
        editAddMode, setEditAddMode,
    } = useWorkspaceStore();

    const [searchTerm, setSearchTerm] = useState(''); // Search for components (thành phần)
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; layer: OcgLayer } | null>(null);
    const [renamingId, setRenamingId] = useState<number | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [dragOverId, setDragOverId] = useState<number | null>(null);
    const dragIdRef = useRef<number | null>(null);
    const renameInputRef = useRef<HTMLInputElement>(null);
    const [isScanningAll, setIsScanningAll] = useState(false);
    const [scanProgress, setScanProgress] = useState(0);

    // Canvas → panel: khi selection đổi (vd click object trên canvas), cuộn dòng
    // tương ứng vào tầm nhìn. Chỉ ĐỌC selectedObjectIds + gọi scroll → không set lại
    // → không có feedback loop. Object không thuộc trang active không có ref → bỏ qua
    // (danh sách "Thành phần" chỉ chứa object trang đang xem). (gộp F7↔edit 2026-07-07)
    const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
    useEffect(() => {
        const firstId = selectedObjectIds[0];
        if (firstId == null) return;
        const el = itemRefs.current[firstId];
        if (el) el.scrollIntoView({ block: 'nearest' });
    }, [selectedObjectIds]);

    const handleScanAllPages = async () => {
        if (!viewerNumPages || isScanningAll) return;
        setIsScanningAll(true);
        setScanProgress(0);
        try {
            // Scan sequentially to avoid overwhelming the backend
            for (let i = 1; i <= viewerNumPages; i++) {
                await fetchPdfObjectsForPage(i);
                setScanProgress(Math.round((i / viewerNumPages) * 100));
            }
        } catch (err) {
            console.error('Scan all pages failed:', err);
        } finally {
            setIsScanningAll(false);
            setScanProgress(0);
        }
    };

    // ─── Toggle Eye (Visibility) ───────────────────────────
    const handleToggleVisibility = useCallback(async (layerId: number) => {
        const isHidden = hiddenOcgLayerIds.includes(layerId);
        const newHidden = isHidden
            ? hiddenOcgLayerIds.filter(id => id !== layerId)
            : [...hiddenOcgLayerIds, layerId];
        
        setHiddenOcgLayerIds(newHidden);
        
        // Edit PDF upgrade: prefer real OCG on live edit session (byte-level)
        // Legacy preflight only for non-edit flows.
        if (selectionFileId) {
            try {
                if (isEditMode) {
                    // Real apply: mutate session.pdf /OCProperties/D/OFF → next renders use it
                    await authenticatedFetch(`${getApiUrl()}/edit/ocg/visibility`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            fid: selectionFileId,
                            layer_id: layerId,
                            visible: isHidden, // was hidden → now visible
                        }),
                    });
                    // Bump to encourage LivePageFrame / objects effects to re-eval (list from live bytes)
                    setPdfObjectsVersion((v: any) => ((v || 0) + 1));
                    // Mark dirty to nudge full viewer / tile refresh path where possible
                    setViewerDirty(true);
                } else {
                    await authenticatedFetch(`${getApiUrl()}/preflight/preview-layers`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            file_id: selectionFileId,
                            page: 1,
                            hidden_layer_ids: newHidden,
                        }),
                    });
                }
            } catch (err) {
                console.error('Layer visibility update failed:', err);
            }
        }
    }, [hiddenOcgLayerIds, setHiddenOcgLayerIds, selectionFileId, isEditMode]);

    // ─── Toggle Lock ───────────────────────────────────────
    const handleToggleLock = useCallback(async (layerId: number) => {
        const isLocked = lockedOcgLayerIds.includes(layerId);
        const newLocked = isLocked
            ? lockedOcgLayerIds.filter(id => id !== layerId)
            : [...lockedOcgLayerIds, layerId];
        
        setLockedOcgLayerIds(newLocked);
        
        if (selectionFileId) {
            try {
                await authenticatedFetch(`${getApiUrl()}/preflight/layers/toggle-lock`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_id: selectionFileId,
                        layer_id: layerId,
                        locked: !isLocked,
                    }),
                });
            } catch (err) {
                console.error('Toggle lock failed:', err);
            }
        }
    }, [lockedOcgLayerIds, setLockedOcgLayerIds, selectionFileId]);

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
        if (!renamingId || !renameValue.trim() || !selectionFileId) {
            setRenamingId(null);
            return;
        }
        
        try {
            setIsLoading(true);
            await authenticatedFetch(`${getApiUrl()}/preflight/layers/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: selectionFileId,
                    layer_id: renamingId,
                    new_name: renameValue.trim(),
                }),
            });
            // Refresh layers
            window.dispatchEvent(new CustomEvent('refresh-ocg-layers'));
        } catch (err) {
            console.error('Rename failed:', err);
        } finally {
            setIsLoading(false);
            setRenamingId(null);
        }
    }, [renamingId, renameValue, selectionFileId]);

    // ─── Delete Layer ──────────────────────────────────────
    const handleDeleteLayer = useCallback(async (layerId: number) => {
        setContextMenu(null);
        if (!selectionFileId) return;
        
        try {
            setIsLoading(true);
            await authenticatedFetch(`${getApiUrl()}/preflight/layers/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: selectionFileId,
                    layer_id: layerId,
                }),
            });
            window.dispatchEvent(new CustomEvent('refresh-ocg-layers'));
        } catch (err) {
            console.error('Delete layer failed:', err);
        } finally {
            setIsLoading(false);
        }
    }, [selectionFileId]);

    // ─── Flatten ───────────────────────────────────────────
    const handleFlatten = useCallback(async () => {
        setContextMenu(null);
        if (!selectionFileId) return;
        
        try {
            setIsLoading(true);
            await authenticatedFetch(`${getApiUrl()}/preflight/layers/flatten`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: selectionFileId }),
            });
            window.dispatchEvent(new CustomEvent('refresh-ocg-layers'));
        } catch (err) {
            console.error('Flatten failed:', err);
        } finally {
            setIsLoading(false);
        }
    }, [selectionFileId]);

    // ─── Drag & Drop Reorder ───────────────────────────────
    const handleDragStart = useCallback((layerId: number) => {
        dragIdRef.current = layerId;
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent, layerId: number) => {
        e.preventDefault();
        setDragOverId(layerId);
    }, []);

    const handleDrop = useCallback(async (e: React.DragEvent, targetId: number) => {
        e.preventDefault();
        setDragOverId(null);
        
        const sourceId = dragIdRef.current;
        if (!sourceId || sourceId === targetId || !selectionFileId) return;
        
        // Build new order by moving sourceId before targetId
        const flatIds = flattenLayerIds(pdfOcgLayers);
        const filtered = flatIds.filter(id => id !== sourceId);
        const targetIdx = filtered.indexOf(targetId);
        filtered.splice(targetIdx, 0, sourceId);
        
        try {
            setIsLoading(true);
            await authenticatedFetch(`${getApiUrl()}/preflight/layers/reorder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: selectionFileId,
                    new_order: filtered,
                }),
            });
            window.dispatchEvent(new CustomEvent('refresh-ocg-layers'));
        } catch (err) {
            console.error('Reorder failed:', err);
        } finally {
            setIsLoading(false);
            dragIdRef.current = null;
        }
    }, [pdfOcgLayers, selectionFileId]);

    // ─── Context Menu ──────────────────────────────────────
    const handleContextMenu = useCallback((e: React.MouseEvent, layer: OcgLayer) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, layer });
    }, []);

    // ─── Render Layer Tree Item ────────────────────────────
    const renderLayerItem = (layer: OcgLayer, depth: number = 0) => {
        const isHidden = hiddenOcgLayerIds.includes(layer.id);
        const isLocked = lockedOcgLayerIds.includes(layer.id);
        const isExpanded = expandedOcgLayerIds.includes(layer.id);
        const hasChildren = layer.children && layer.children.length > 0;
        const isRenaming = renamingId === layer.id;
        const isDragOver = dragOverId === layer.id;

        return (
            <div key={`layer-${layer.id}`}>
                <div
                    className={`flex items-center gap-1 py-1 px-1.5 rounded-md text-[12px] transition-all cursor-pointer group/layer
                        ${isHidden ? 'opacity-40' : ''} 
                        ${isDragOver ? 'bg-blue-100 dark:bg-blue-900/30 ring-1 ring-blue-400' : 'hover:bg-slate-50 dark:hover:bg-zinc-700/50'}
                        ${isLocked ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}
                    `}
                    style={{ paddingLeft: `${depth * 16 + 4}px` }}
                    draggable={!layer.isGroup}
                    onDragStart={() => handleDragStart(layer.id)}
                    onDragOver={(e) => handleDragOver(e, layer.id)}
                    onDrop={(e) => handleDrop(e, layer.id)}
                    onDragLeave={() => setDragOverId(null)}
                    onContextMenu={(e) => handleContextMenu(e, layer)}
                    onDoubleClick={() => !layer.isGroup && startRename(layer)}
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
                        className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/10"
                        style={{ backgroundColor: layer.color || '#3b82f6' }}
                    />

                    {/* Eye Toggle */}
                    <button
                        onClick={(e) => { e.stopPropagation(); handleToggleVisibility(layer.id); }}
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

                    {/* Lock Toggle */}
                    <button
                        onClick={(e) => { e.stopPropagation(); handleToggleLock(layer.id); }}
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
                        <span className={`truncate flex-1 ${
                            isHidden ? 'text-slate-400 dark:text-zinc-500 line-through' : 
                            layer.isGroup ? 'text-slate-600 dark:text-zinc-300 font-bold italic' : 
                            'text-slate-700 dark:text-zinc-200 font-medium'
                        }`}>
                            {layer.isGroup ? (<><FolderOpen className="w-3 h-3 inline-block mr-1 -mt-0.5" />{layer.name}</>) : layer.name}
                        </span>
                    )}

                    {/* Drag Handle (visible on hover) */}
                    {!layer.isGroup && (
                        <div className="w-4 h-4 flex items-center justify-center text-slate-300 dark:text-zinc-600 opacity-0 group-hover/layer:opacity-100 cursor-grab shrink-0">
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M7 2a2 2 0 10.001 4.001A2 2 0 007 2zm0 6a2 2 0 10.001 4.001A2 2 0 007 8zm0 6a2 2 0 10.001 4.001A2 2 0 007 14zm6-8a2 2 0 10.001-4.001A2 2 0 0013 6zm0 2a2 2 0 10.001 4.001A2 2 0 0013 8zm0 6a2 2 0 10.001 4.001A2 2 0 0013 14z" />
                            </svg>
                        </div>
                    )}
                </div>

                {/* Children */}
                {hasChildren && isExpanded && (
                    <div className="border-l border-slate-200 dark:border-zinc-700 ml-3">
                        {layer.children.map(child => renderLayerItem(child, depth + 1))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="flex flex-col h-full gap-3">
            {/* Unified OCG + Thành phần view for Edit PDF upgrade */}
            <div className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 px-1">{t('misc.selectionLayers:lop_thanh_phan_edit_pdf')}</div>

            {/* Loading Overlay */}
            {isLoading && (
                <div className="absolute inset-0 z-50 bg-white/70 dark:bg-zinc-900/70 flex items-center justify-center rounded-lg backdrop-blur-sm">
                    <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-xs font-medium">{t('misc.selectionLayers:dang_xu_ly')}</span>
                    </div>
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
                            {pdfOcgLayers.length} layers
                        </span>
                    </div>

                    {/* Layer Tree */}
                    <div className="flex-1 overflow-y-auto border border-slate-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-800 scroller-thin p-1">
                        {pdfOcgLayers && pdfOcgLayers.length > 0 ? (
                            <div className="flex flex-col gap-0.5">
                                {pdfOcgLayers.map((layer: OcgLayer) => renderLayerItem(layer))}
                            </div>
                        ) : (
                            <div className="p-6 text-center">
                                <div className="text-3xl mb-2 opacity-30">🎨</div>
                                <p className="text-slate-400 dark:text-zinc-500 italic text-xs">
                                    {t('misc.selectionLayers:khong_tim_thay_lop_ocg_nao_trong_file')}
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
                        <span>{t('misc.selectionLayers:keo_sap_xep')}</span>
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

            {/* Components (Thành phần) Section - using editObjects for accuracy */}
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
                                onClick={() => {
                                    const source = editObjects && editObjects.length > 0 ? editObjects : Object.values(globalPdfObjectCache.getAllObjects(pdfUrl || '')).flat();
                                    const allIds = source.map((o: any) => o.id);
                                    if (selectedObjectIds.length === allIds.length) {
                                        setSelectedObjectIds([]);
                                    } else {
                                        setSelectedObjectIds(allIds);
                                    }
                                }}
                                className="text-[11px] bg-slate-100 hover:bg-slate-200 dark:bg-zinc-700 dark:hover:bg-zinc-600 px-2 py-1 rounded transition-colors text-slate-600 dark:text-zinc-300"
                            >
                                {selectedObjectIds.length > 0 ? t('misc.selectionLayers:bo_chon') : t('misc.selectionLayers:chon_tat_ca')}
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto border border-slate-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-800 scroller-thin">
                        {(() => {
                            const sourceObjects = isEditMode && editObjects && editObjects.length > 0 ? editObjects : Object.values(globalPdfObjectCache.getAllObjects(pdfUrl || '')).flat();
                            const filtered = sourceObjects.filter((obj: any) => 
                                !searchTerm || (obj.content || obj.type || '').toLowerCase().includes(searchTerm.toLowerCase())
                            );
                            if (filtered.length === 0) {
                                return <div className="p-4 text-center text-slate-400 italic text-xs">{t('misc.selectionLayers:khong_co_thanh_phan_khop_tim_kiem')}</div>;
                            }
                            return filtered.map((obj: any) => {
                                const isSelected = selectedObjectIds.includes(obj.id);
                                const isHidden = hiddenObjectIds.includes(obj.id);
                                const isLocked = lockedObjectIds.includes(obj.id);
                                return (
                                    <div
                                        key={obj.id}
                                        ref={el => { itemRefs.current[obj.id] = el; }}
                                        className={`flex items-center gap-1.5 p-2 text-xs cursor-pointer border-b border-slate-100 dark:border-zinc-700/50 hover:bg-slate-50 dark:hover:bg-zinc-700/50 transition-colors ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''} ${isHidden ? 'opacity-50' : ''} ${isLocked ? 'opacity-60' : ''}`}
                                    >
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setHiddenObjectIds(prev =>
                                                    prev.includes(obj.id) ? prev.filter(id => id !== obj.id) : [...prev, obj.id]
                                                );
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
                                                // Khi khóa object đang được chọn → nhả chọn để không thể transform
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
                                                setSelectedObjectIds(prev =>
                                                    prev.includes(obj.id) ? prev.filter(id => id !== obj.id) : [...prev, obj.id]
                                                );
                                            }}
                                            className={`rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-3 h-3 ${isLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                                        />
                                        <span className={`font-mono text-[9px] w-8 shrink-0 ${{
                                            'text': 'text-blue-500',
                                            'image': 'text-purple-500',
                                            'vector': 'text-yellow-600'
                                        }[obj.type as string] || 'text-slate-500'}`}>
                                            {obj.type === 'text' ? 'T' : obj.type === 'image' ? '🖼' : obj.type === 'vector' ? '✏️' : '•'}
                                        </span>
                                        <span
                                            className={`truncate flex-1 text-[11px] ${isHidden ? 'line-through text-slate-400' : ''} ${isLocked ? 'italic text-slate-400' : ''}`}
                                            title={obj.content || obj.type}
                                            onClick={() => {
                                                if (isLocked) return;
                                                setSelectedObjectIds(prev =>
                                                    prev.includes(obj.id) ? prev.filter(id => id !== obj.id) : [...prev, obj.id]
                                                );
                                            }}
                                        >
                                            {obj.content || `[${obj.type}]`}
                                        </span>
                                    </div>
                                );
                            });
                        })()}
                    </div>

                    <div className="shrink-0 pt-2">
                        <Button
                            variant="primary"
                            className="w-full bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700 border-transparent text-white shadow-md flex justify-center items-center gap-2"
                            disabled={selectedObjectIds.length === 0}
                            onClick={() => {
                                const source = (editObjects && editObjects.length > 0) ? editObjects : Object.values(globalPdfObjectCache.getAllObjects(pdfUrl || '')).flat();
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

// ─── Helpers ────────────────────────────────────────────────
function flattenLayerIds(layers: OcgLayer[]): number[] {
    const result: number[] = [];
    for (const layer of layers) {
        if (!layer.isGroup) result.push(layer.id);
        if (layer.children?.length) {
            result.push(...flattenLayerIds(layer.children));
        }
    }
    return result;
}
