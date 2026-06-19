import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { getApiUrl } from '../../lib/api';

// ═══════════════════════════════════════════════════════════
//  F7 Layer Panel — Standalone OCG Layer Manager
//  Opens as a floating right-side panel inside AcrobatViewer
// ═══════════════════════════════════════════════════════════

interface OcgLayerObject {
    type: 'xobject' | 'path' | 'text' | 'clip' | string;
    name: string;
    page: number;
}

interface OcgLayer {
    id: number;
    name: string;
    visible: boolean;
    locked: boolean;
    depth: number;
    children: OcgLayer[];
    color: string;
    isGroup?: boolean;
    objects?: OcgLayerObject[];
}

export default function LayerPanel() {
    const {
        file,
        pdfOcgLayers, setPdfOcgLayers,
        hiddenOcgLayerIds, setHiddenOcgLayerIds,
        lockedOcgLayerIds, setLockedOcgLayerIds,
        expandedOcgLayerIds, setExpandedOcgLayerIds,
        isLayerPanelOpen, setIsLayerPanelOpen,
        setOcgPreviewUrl,
        viewerActivePage,
    } = useWorkspaceStore();

    const [isLoading, setIsLoading] = useState(false);
    const [isRendering, setIsRendering] = useState(false);
    const [hiddenObjectKeys, setHiddenObjectKeys] = useState<Set<string>>(new Set());
    const renderAbortRef = useRef<AbortController | null>(null);

    // ─── Fetch layers when panel opens ──────────────────────
    useEffect(() => {
        if (!isLayerPanelOpen || !file) return;
        const filePath = (file as any)?.path;
        if (!filePath) return;

        const fetchLayers = async () => {
            setIsLoading(true);
            try {
                const apiUrl = getApiUrl();
                const layerRes = await fetch(`${apiUrl}/imposition/pdf-layers`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: filePath }),
                });
                if (layerRes.ok) {
                    const layerData = await layerRes.json();
                    setPdfOcgLayers(layerData.layers || []);
                }
            } catch (err) {
                console.error('Failed to fetch OCG layers:', err);
            } finally {
                setIsLoading(false);
            }
        };

        fetchLayers();
    }, [isLayerPanelOpen, file]);

    // ─── Render preview when hidden layers change ────────────
    useEffect(() => {
        const filePath = (file as any)?.path;
        if (!filePath || !isLayerPanelOpen) return;

        // If nothing is hidden, clear preview (show normal tiles)
        if (hiddenOcgLayerIds.length === 0 && hiddenObjectKeys.size === 0) {
            setOcgPreviewUrl(null);
            return;
        }

        // Cancel previous render request
        if (renderAbortRef.current) renderAbortRef.current.abort();
        const controller = new AbortController();
        renderAbortRef.current = controller;

        // Debounce: wait 200ms before calling backend
        const timer = setTimeout(async () => {
            setIsRendering(true);
            try {
                const apiUrl = getApiUrl();
                const res = await fetch(`${apiUrl}/imposition/pdf-layers/preview`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: filePath,
                        page: viewerActivePage || 1,
                        hidden_layer_ids: hiddenOcgLayerIds,
                        hidden_object_keys: Array.from(hiddenObjectKeys),
                        dpi: 150,
                    }),
                    signal: controller.signal,
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.preview_b64 && !controller.signal.aborted) {
                        setOcgPreviewUrl(data.preview_b64);
                    }
                }
            } catch (err: any) {
                if (err.name !== 'AbortError') {
                    console.error('Layer preview render failed:', err);
                }
            } finally {
                if (!controller.signal.aborted) setIsRendering(false);
            }
        }, 200);

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [hiddenOcgLayerIds, hiddenObjectKeys, file, isLayerPanelOpen, viewerActivePage]);

    // ─── Clear preview when panel closes ─────────────────────
    useEffect(() => {
        if (!isLayerPanelOpen) {
            setOcgPreviewUrl(null);
            setHiddenOcgLayerIds([]);
            setHiddenObjectKeys(new Set());
        }
    }, [isLayerPanelOpen]);

    // ─── Toggle Eye (Visibility) ─────────────────────────────
    const handleToggleVisibility = useCallback((layerId: number) => {
        const isHidden = hiddenOcgLayerIds.includes(layerId);
        const newHidden = isHidden
            ? hiddenOcgLayerIds.filter(id => id !== layerId)
            : [...hiddenOcgLayerIds, layerId];
        setHiddenOcgLayerIds(newHidden);
    }, [hiddenOcgLayerIds, setHiddenOcgLayerIds]);

    // ─── Toggle Lock ─────────────────────────────────────────
    const handleToggleLock = useCallback((layerId: number) => {
        const isLocked = lockedOcgLayerIds.includes(layerId);
        setLockedOcgLayerIds(isLocked
            ? lockedOcgLayerIds.filter(id => id !== layerId)
            : [...lockedOcgLayerIds, layerId]
        );
    }, [lockedOcgLayerIds, setLockedOcgLayerIds]);

    // ─── Toggle Expand/Collapse ──────────────────────────────
    const handleToggleExpand = useCallback((layerId: number) => {
        setExpandedOcgLayerIds(prev =>
            prev.includes(layerId)
                ? prev.filter(id => id !== layerId)
                : [...prev, layerId]
        );
    }, [setExpandedOcgLayerIds]);

    // ─── Render Layer Tree Item ──────────────────────────────
    const renderLayerItem = (layer: OcgLayer, depth: number = 0) => {
        const isHidden = hiddenOcgLayerIds.includes(layer.id);
        const isLocked = lockedOcgLayerIds.includes(layer.id);
        const isExpanded = expandedOcgLayerIds.includes(layer.id);
        const hasChildren = layer.children && layer.children.length > 0;
        const hasObjects = layer.objects && layer.objects.length > 0;
        const isExpandable = hasChildren || hasObjects;

        return (
            <div key={`layer-${layer.id}`}>
                <div
                    className={`flex items-center gap-1 py-1.5 px-1.5 rounded-md text-[12px] transition-all cursor-pointer group/layer
                        ${isHidden ? 'opacity-40' : ''} 
                        hover:bg-black/5 dark:hover:bg-white/5
                        ${isLocked ? 'bg-amber-100/50 dark:bg-amber-900/10' : ''}
                    `}
                    style={{ paddingLeft: `${depth * 14 + 6}px` }}
                >
                    {/* Expand/Collapse Arrow */}
                    {isExpandable ? (
                        <button
                            onClick={(e) => { e.stopPropagation(); handleToggleExpand(layer.id); }}
                            className="w-4 h-4 flex items-center justify-center text-slate-400 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-200 transition-colors shrink-0"
                            aria-label={isExpanded ? 'Thu gọn lớp' : 'Mở rộng lớp'}
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
                        className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/10 dark:ring-white/20"
                        style={{ backgroundColor: layer.color || '#3b82f6' }}
                    />

                    {/* Eye Toggle */}
                    <button
                        onClick={(e) => { e.stopPropagation(); handleToggleVisibility(layer.id); }}
                        className={`w-5 h-5 flex items-center justify-center rounded transition-colors shrink-0 ${
                            isHidden 
                                ? 'text-slate-300 dark:text-zinc-600 hover:text-slate-500 dark:hover:text-zinc-400' 
                                : 'text-slate-500 dark:text-zinc-300 hover:text-blue-500 dark:hover:text-blue-400'
                        }`}
                        title={isHidden ? 'Hiển thị lớp' : 'Ẩn lớp'}
                        aria-label={isHidden ? 'Hiển thị lớp' : 'Ẩn lớp'}
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
                                ? 'text-amber-500 hover:text-amber-400' 
                                : 'text-slate-300 dark:text-zinc-700 hover:text-slate-500 dark:hover:text-zinc-400 opacity-0 group-hover/layer:opacity-100'
                        }`}
                        title={isLocked ? 'Mở khóa lớp' : 'Khóa lớp'}
                        aria-label={isLocked ? 'Mở khóa lớp' : 'Khóa lớp'}
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
                    <span className={`truncate flex-1 ${
                        isHidden ? 'text-slate-400 dark:text-zinc-600 line-through' : 
                        layer.isGroup ? 'text-slate-700 dark:text-zinc-300 font-bold italic' : 
                        'text-slate-800 dark:text-zinc-200 font-medium'
                    }`}>
                        {layer.isGroup ? `📁 ${layer.name}` : layer.name}
                    </span>

                    {/* Object count badge */}
                    {layer.objects && layer.objects.length > 0 && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-slate-200 dark:bg-zinc-800 text-slate-500 dark:text-zinc-500 shrink-0">
                            {layer.objects.length}
                        </span>
                    )}
                </div>

                {/* Children (sub-layers) */}
                {hasChildren && isExpanded && (
                    <div className="border-l border-slate-200 dark:border-zinc-700/50 ml-4">
                        {layer.children.map(child => renderLayerItem(child, depth + 1))}
                    </div>
                )}

                {/* Objects inside this layer (flat — page grouping now done by backend children) */}
                {isExpanded && layer.objects && layer.objects.length > 0 && (
                    <div className="border-l border-slate-200 dark:border-zinc-700/50 ml-4">
                        {layer.objects.map((obj: any, idx: number) => {
                            const objKey = `${layer.id}-${idx}`;
                            const isObjHidden = hiddenObjectKeys.has(objKey);
                            return (
                                <div
                                    key={`obj-${layer.id}-${idx}`}
                                    className={`flex items-center gap-1 py-0.5 px-1.5 text-[11px] hover:bg-blue-50/50 dark:hover:bg-blue-900/10 rounded-sm cursor-default transition-colors
                                        ${isObjHidden ? 'opacity-35' : 'text-slate-600 dark:text-zinc-400'}`}
                                    style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
                                    title={obj.color || obj.type}
                                >
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setHiddenObjectKeys(prev => {
                                                const next = new Set(prev);
                                                if (next.has(objKey)) next.delete(objKey);
                                                else next.add(objKey);
                                                return next;
                                            });
                                        }}
                                        className="w-3.5 h-3.5 flex items-center justify-center shrink-0 hover:bg-black/5 dark:hover:bg-white/10 rounded transition-colors"
                                        aria-label={isObjHidden ? 'Hiện đối tượng' : 'Ẩn đối tượng'}
                                    >
                                        {isObjHidden ? (
                                            <svg className="w-2.5 h-2.5 text-slate-300 dark:text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                            </svg>
                                        ) : (
                                            <svg className="w-2.5 h-2.5 text-slate-400 dark:text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                            </svg>
                                        )}
                                    </button>
                                    {obj.color ? (
                                        <div 
                                            className="w-2 h-2 rounded-full shrink-0 ring-1 ring-black/10 dark:ring-white/15"
                                            style={{ backgroundColor: obj.color.startsWith('rgb') ? obj.color : '#888' }}
                                        />
                                    ) : (
                                        <span className="text-[9px] shrink-0 w-2 text-center text-slate-400">◆</span>
                                    )}
                                    <span className={`truncate font-medium ${isObjHidden ? 'line-through' : ''}`}>{obj.name}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    };

    const [panelWidth, setPanelWidth] = useState(280);
    const isDraggingRef = useRef(false);

    // ─── Resize Handler ──────────────────────────────────────
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        isDraggingRef.current = true;
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            if (!isDraggingRef.current) return;
            // The panel is on the right side, so width = window.innerWidth - mouse.clientX
            // Or more reliably: limit between 200px and 600px
            const newWidth = window.innerWidth - moveEvent.clientX;
            setPanelWidth(Math.max(200, Math.min(newWidth, 600)));
        };
        
        const handleMouseUp = () => {
            isDraggingRef.current = false;
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = '';
        };
        
        document.body.style.cursor = 'ew-resize';
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    }, []);

    if (!isLayerPanelOpen) return null;

    return (
        <div 
            className="shrink-0 flex flex-col bg-slate-50 dark:bg-[#121212] border-l border-black/10 dark:border-white/5 select-none overflow-hidden relative"
            style={{ width: `${panelWidth}px` }}
        >
            {/* Resize Handle */}
            <div 
                className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-blue-500/20 active:bg-blue-500/40 z-50 transition-colors"
                onMouseDown={handleMouseDown}
            />
            {/* Header */}
            <div className="flex items-center justify-between px-3 h-10 bg-slate-100 dark:bg-[#18181b] border-b border-black/10 dark:border-white/5">
                <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-indigo-500 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                    <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 tracking-wider">LAYERS</span>
                    <span className="text-[10px] text-slate-400 dark:text-zinc-600 font-mono ml-0.5">(F7)</span>
                    {isRendering && (
                        <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin ml-1" />
                    )}
                </div>
                <button
                    onClick={() => setIsLayerPanelOpen(false)}
                    className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200 transition-colors"
                    aria-label="Đóng bảng lớp"
                >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>

            {/* Loading */}
            {isLoading && (
                <div className="flex items-center justify-center py-6 gap-2">
                    <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-slate-500 dark:text-zinc-400">Đang quét layers...</span>
                </div>
            )}

            {/* Layer Tree */}
            <div className="flex-1 overflow-y-auto p-1.5 acro-thumb-scroll">
                {pdfOcgLayers && pdfOcgLayers.length > 0 ? (
                    <div className="flex flex-col gap-0.5">
                        {pdfOcgLayers.map((layer: OcgLayer) => renderLayerItem(layer))}
                    </div>
                ) : !isLoading ? (
                    <div className="p-6 text-center">
                        <div className="text-3xl mb-3 opacity-20">🎨</div>
                        <p className="text-slate-500 dark:text-zinc-500 italic text-xs">
                            Không tìm thấy lớp OCG nào.
                        </p>
                        <p className="text-slate-400 dark:text-zinc-600 text-[10px] mt-1.5">
                            File PDF cần có Optional Content Groups (OCG) — được tạo bởi Illustrator, InDesign hoặc PrynX Imposition.
                        </p>
                    </div>
                ) : null}
            </div>

            {/* Footer hints */}
            {pdfOcgLayers.length > 0 && (
                <div className="shrink-0 px-3 py-2 border-t border-black/10 dark:border-white/5 flex items-center justify-between bg-slate-100 dark:bg-[#18181b]">
                    <div className="text-[9px] text-slate-400 dark:text-zinc-600 flex gap-3">
                        <span>👁 Ẩn/Hiện</span>
                        <span>🔒 Khóa</span>
                    </div>
                    <span className="text-[10px] text-slate-400 dark:text-zinc-600 font-mono">
                        {pdfOcgLayers.length} layers
                    </span>
                </div>
            )}
        </div>
    );
}
