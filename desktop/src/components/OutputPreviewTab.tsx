import React, { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch, getApiUrl } from '../lib/api';
import pako from 'pako';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import SoftProofPanel from './SoftProofPanel';
import { toast } from './ui/Toast';
import { useTranslation } from 'react-i18next';

interface PlateInfo {
    name: string;
    color: number[];
    alpha_data: string;
    is_spot?: boolean;
}

interface SpotInkMeta {
    name: string;
    rgb: number[];
    coverage_pct: number;
    is_pantone: boolean;
}

interface SeparationsData {
    width: number;
    height: number;
    plates: PlateInfo[];
    spot_inks?: SpotInkMeta[];
    has_spot_colors?: boolean;
    detected_spots?: string[];
    engine?: string;
    page_has_transparency?: boolean;
    blending_color_space?: string;
}

export interface PlateOverlay {
    name: string;
    color: number[];
    dataUrl: string;
    visible: boolean;
}

interface OutputPreviewTabProps {
    fileId: string;
    initialPageNum?: number;
    totalPages?: number;
    onClose: () => void;
    onPlatesChange?: (plates: PlateOverlay[]) => void;
    onFileFixed?: (blob: Blob, name: string) => void;
}

function reconstructPlateDataUrl(plate: PlateInfo, width: number, height: number): { url: string, alphaArray: Uint8ClampedArray } {
    const compressed = Uint8Array.from(atob(plate.alpha_data), c => c.charCodeAt(0));
    const alphaBytes = pako.inflate(compressed);
    const alphaArray = new Uint8ClampedArray(alphaBytes.buffer);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(width, height);
    const [r, g, b] = plate.color;
    for (let i = 0; i < alphaArray.length; i++) {
        const off = i * 4;
        imgData.data[off] = r;
        imgData.data[off + 1] = g;
        imgData.data[off + 2] = b;
        imgData.data[off + 3] = alphaArray[i];
    }
    ctx.putImageData(imgData, 0, 0);
    const url = canvas.toDataURL('image/png');
    canvas.width = 0; canvas.height = 0;
    return { url, alphaArray };
}

export default function OutputPreviewTab({ fileId, initialPageNum = 1, totalPages = 1, onClose, onPlatesChange, onFileFixed }: OutputPreviewTabProps) {
  const { t } = useTranslation();
    const [pageNum, setPageNum] = useState(initialPageNum);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [useGhostscript, setUseGhostscript] = useState(false);
    const [convertingSpot, setConvertingSpot] = useState('');

    const [plateList, setPlateList] = useState<{ name: string; color: number[]; dataUrl: string; is_spot?: boolean }[]>([]);
    const [visiblePlates, setVisiblePlates] = useState<Set<string>>(new Set());
    const [soloPlate, setSoloPlate] = useState<string | null>(null);
    
    const [pageHasTransparency, setPageHasTransparency] = useState(false);
    const [blendingColorSpace, setBlendingColorSpace] = useState('DeviceCMYK');
    const [tacThreshold, setTacThreshold] = useState(280);
    const [showTacWarning, setShowTacWarning] = useState(false);
    const [spotInksMeta, setSpotInksMeta] = useState<SpotInkMeta[]>([]);
    const [engineUsed, setEngineUsed] = useState('');
    const [detectedSpots, setDetectedSpots] = useState<string[]>([]);
    const [showSoftProof, setShowSoftProof] = useState(false);
    const [showTacHeatmap, setShowTacHeatmap] = useState(false);
    
    const setTacHeatmapUrl = useWorkspaceStore(s => s.setTacHeatmapUrl);

    const plateDataRef = React.useRef<{ width: number, height: number, arrays: Record<string, Uint8ClampedArray> } | null>(null);
    const pctRefs = React.useRef<Record<string, HTMLSpanElement | null>>({});
    const tacRef = React.useRef<HTMLSpanElement | null>(null);

    // ── TAC Heatmap Generation (client-side Canvas) ──
    useEffect(() => {
        if (!showTacHeatmap || !plateDataRef.current) {
            setTacHeatmapUrl(null);
            return;
        }
        const { width, height, arrays } = plateDataRef.current;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        const imgData = ctx.createImageData(width, height);
        const threshold = tacThreshold;

        for (let i = 0; i < width * height; i++) {
            let total = 0;
            for (const name in arrays) {
                total += Math.round((arrays[name][i] / 255) * 100);
            }
            const off = i * 4;
            if (total > threshold) {
                const severity = Math.min(1, (total - threshold) / 100);
                // Yellow → Red gradient based on how far over threshold
                imgData.data[off] = 255;
                imgData.data[off + 1] = Math.round(255 * (1 - severity)); // Yellow to Red
                imgData.data[off + 2] = 0;
                imgData.data[off + 3] = Math.round(120 + severity * 100); // 120-220 alpha
            } else {
                imgData.data[off + 3] = 0; // transparent
            }
        }
        ctx.putImageData(imgData, 0, 0);
        const url = canvas.toDataURL('image/png');
        setTacHeatmapUrl(url);
        canvas.width = 0; canvas.height = 0;
    }, [showTacHeatmap, tacThreshold, plateList, setTacHeatmapUrl]);

    // --- Drag Logic ---
    const [pos, setPos] = useState({ x: 0, y: 0 });
    const dragRef = React.useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0, isDragging: false });

    const handlePointerDown = (e: React.PointerEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;
        dragRef.current = { startX: e.clientX, startY: e.clientY, initialX: pos.x, initialY: pos.y, isDragging: true };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!dragRef.current.isDragging) return;
        setPos({
            x: dragRef.current.initialX + (e.clientX - dragRef.current.startX),
            y: dragRef.current.initialY + (e.clientY - dragRef.current.startY)
        });
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        dragRef.current.isDragging = false;
        try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch(err){}
    };
    // ------------------

    // ESC to close
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [onClose]);

    useEffect(() => {
        let isMounted = true;
        const fetchSeparations = async () => {
            setLoading(true);
            setError('');
            setSoloPlate(null);
            try {
                const gsParam = useGhostscript ? '&use_gs=true' : '';
                const res = await authenticatedFetch(`${getApiUrl()}/preflight/separations/${fileId}/${pageNum}?dpi=150${gsParam}`);
                if (!res.ok) throw new Error(t('tabs.outputPreview:khong_the_phan_tach_kem'));
                const result: SeparationsData = await res.json();
                if (!isMounted) return;
                const arrays: Record<string, Uint8ClampedArray> = {};
                const plates = result.plates.map(p => {
                    const { url, alphaArray } = reconstructPlateDataUrl(p, result.width, result.height);
                    arrays[p.name] = alphaArray;
                    return { name: p.name, color: p.color, dataUrl: url, is_spot: p.is_spot };
                });
                plateDataRef.current = { width: result.width, height: result.height, arrays };
                setPlateList(plates);
                setVisiblePlates(new Set(plates.map(p => p.name)));
                setPageHasTransparency(result.page_has_transparency ?? false);
                setBlendingColorSpace(result.blending_color_space ?? 'DeviceCMYK');
                setSpotInksMeta(result.spot_inks ?? []);
                setEngineUsed(result.engine ?? 'pikepdf');
                setDetectedSpots(result.detected_spots ?? []);
            } catch (err: any) {
                if (isMounted) setError(err.message);
            } finally {
                if (isMounted) setLoading(false);
            }
        };
        fetchSeparations();
        return () => { isMounted = false; };
    }, [fileId, pageNum, useGhostscript]);

    useEffect(() => {
        const handlePdfHover = (e: any) => {
            const pos = e.detail;
            if (!pos || pos.pageNum !== pageNum || !plateDataRef.current) return;
            
            const { x, y } = pos;
            const { width, height, arrays } = plateDataRef.current;
            const px = Math.floor(x * width);
            const py = Math.floor(y * height);
            if (px < 0 || px >= width || py < 0 || py >= height) return;
            const idx = py * width + px;
            
            let total = 0;
            for (const name in arrays) {
                const alpha = arrays[name][idx];
                const pct = Math.round((alpha / 255) * 100);
                total += pct;
                const el = pctRefs.current[name];
                if (el) el.textContent = `${pct}%`;
            }
            if (tacRef.current) {
                tacRef.current.textContent = `${total}%`;
                if (total > tacThreshold && showTacWarning) {
                    tacRef.current.className = "font-mono text-[13px] text-red-500 font-bold tabular-nums";
                } else {
                    tacRef.current.className = "font-mono text-[13px] text-slate-400 font-medium tabular-nums";
                }
            }
        };

        window.addEventListener('pdf-hover', handlePdfHover);
        return () => window.removeEventListener('pdf-hover', handlePdfHover);
    }, [pageNum, tacThreshold, showTacWarning]);

    useEffect(() => {
        if (!onPlatesChange) return;
        const effectiveVisible = soloPlate
            ? new Set([soloPlate])
            : visiblePlates;
        onPlatesChange(plateList.map(p => ({
            name: p.name, color: p.color, dataUrl: p.dataUrl,
            visible: effectiveVisible.has(p.name),
        })));
    }, [plateList, visiblePlates, soloPlate, onPlatesChange]);

    useEffect(() => { return () => { onPlatesChange?.([]); setTacHeatmapUrl(null); }; }, []);

    const togglePlate = useCallback((name: string) => {
        setSoloPlate(null); // clear solo when toggling
        setVisiblePlates(prev => {
            const n = new Set(prev);
            if (n.has(name)) n.delete(name); else n.add(name);
            return n;
        });
    }, []);

    const handleSoloPlate = useCallback((name: string) => {
        setSoloPlate(prev => prev === name ? null : name);
    }, []);

    const allProcessVisible = plateList.every(p => visiblePlates.has(p.name)) && !soloPlate;
    const toggleAllProcess = useCallback(() => {
        setSoloPlate(null);
        setVisiblePlates(allProcessVisible ? new Set() : new Set(plateList.map(p => p.name)));
    }, [allProcessVisible, plateList]);

    const PNAMES: Record<string, string> = {
        'Cyan': 'Process Cyan', 'Magenta': 'Process Magenta',
        'Yellow': 'Process Yellow', 'Black': 'Process Black'
    };
    const PROCESS_NAMES = new Set(['Cyan', 'Magenta', 'Yellow', 'Black']);

    const convertSpot = useCallback(async (spotName?: string) => {
        setConvertingSpot(spotName || '__all__');
        try {
            const res = await authenticatedFetch(`${getApiUrl()}/preflight/convert-spot`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: fileId, spot_name: spotName || null }),
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                toast.error(`Lỗi chuyển Spot → CMYK: ${errData.detail || res.statusText}`);
                setConvertingSpot('');
                return;
            }
            const data = await res.json();
            if (data.success && data.output_filename && onFileFixed) {
                const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
                onFileFixed(await dl.blob(), data.output_filename);
            } else if (!data.success) {
                toast.error(`Chuyển Spot → CMYK không thành công: ${data.error || 'Unknown'}`);
            }
        } catch (e: any) {
            console.error('Convert spot failed:', e);
            toast.error(`Lỗi: ${e.message || 'Không kết nối được backend'}`);
        }
        setConvertingSpot('');
    }, [fileId, onFileFixed]);

    const hasSpotInks = plateList.some(p => !PROCESS_NAMES.has(p.name));

    return (
        <div
            className="fixed z-[9999] rounded-2xl overflow-hidden select-none flex flex-col bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-700/80"
            style={{
                top: 50, right: 60, width: 380,
                transform: `translate(${pos.x}px, ${pos.y}px)`,
                boxShadow: '0 20px 40px -10px rgba(0,0,0,0.15), 0 0 10px rgba(0,0,0,0.05)',
                fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
            }}
        >
            {/* ─── Header ─── */}
            <div 
                className="flex items-center justify-between border-b border-slate-100 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-900/80 cursor-move"
                style={{ padding: '10px 16px' }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
            >
                <div className="flex items-center gap-2">
                    <span className="text-[14px]">👁️</span>
                    <span className="font-bold text-[13px] text-slate-700 dark:text-zinc-200 uppercase tracking-wide">{t('tabs.outputPreview:xem_truoc_ban_in')}</span>
                </div>
                <div className="flex items-center gap-1.5">
                    {detectedSpots.length > 0 && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold dark:bg-amber-900/40 dark:text-amber-300">
                            {detectedSpots.length} SPOT
                        </span>
                    )}
                    <button 
                        onClick={onClose} 
                        className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-50 hover:text-red-600 text-slate-400 transition-colors text-[16px]"
                    >×</button>
                </div>
            </div>

            <div className="overflow-y-auto max-h-[calc(100vh-140px)]" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                
                {/* ─── Mode + Engine ─── */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-[12px] text-slate-500">{t('tabs.outputPreview:che_do')}</span>
                        <span className="text-[12px] font-semibold text-indigo-600 dark:text-indigo-400">{t('tabs.outputPreview:tach_kem_separations')}</span>
                    </div>
                    {engineUsed && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                            engineUsed === 'ghostscript' 
                                ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' 
                                : 'bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400'
                        }`}>
                            {engineUsed === 'ghostscript' ? t('tabs.outputPreview:che_do_chuyen_sau') : t('tabs.outputPreview:che_do_nhanh')}
                        </span>
                    )}
                </div>

                {/* ─── Page Navigation ─── */}
                {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-3">
                        <button
                            onClick={() => setPageNum(p => Math.max(1, p - 1))}
                            disabled={pageNum <= 1 || loading}
                            className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-30 transition-colors text-slate-500 text-[14px]"
                        >←</button>
                        <span className="text-[12px] font-semibold text-slate-600 dark:text-zinc-300 tabular-nums">
                            Trang {pageNum} / {totalPages}
                        </span>
                        <button
                            onClick={() => setPageNum(p => Math.min(totalPages, p + 1))}
                            disabled={pageNum >= totalPages || loading}
                            className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-30 transition-colors text-slate-500 text-[14px]"
                        >→</button>
                    </div>
                )}

                {/* ─── Plate List ─── */}
                <div>
                    <div className="flex items-center justify-between" style={{ marginBottom: '4px' }}>
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('tabs.outputPreview:ban_kem')}</span>
                        <button
                            onClick={toggleAllProcess}
                            className={`text-[11px] font-medium rounded transition-colors ${
                                allProcessVisible ? 'text-indigo-600 hover:bg-indigo-50' : 'text-slate-500 hover:bg-slate-100'
                            }`}
                            style={{ padding: '2px 6px' }}
                        >
                            {allProcessVisible ? t('tabs.outputPreview:bo_chon_tat_ca') : t('tabs.outputPreview:chon_tat_ca')}
                        </button>
                    </div>

                    {loading ? (
                        <div className="flex flex-col items-center gap-3 py-8 bg-slate-50 dark:bg-zinc-800/50 rounded-xl border border-slate-100 dark:border-zinc-800">
                            <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                            <span className="text-[13px] text-slate-500 font-medium">{t('tabs.outputPreview:dang_phan_tach_kem')}</span>
                        </div>
                    ) : error ? (
                        <div className="py-4 px-4 text-red-600 text-[13px] text-center bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-100 dark:border-red-900/30">
                            {error}
                        </div>
                    ) : (
                        <div className="rounded-lg border border-slate-200 dark:border-zinc-700 overflow-hidden bg-white dark:bg-zinc-800">
                            {plateList.map((plate, idx) => {
                                const isVisible = soloPlate ? soloPlate === plate.name : visiblePlates.has(plate.name);
                                const isSolo = soloPlate === plate.name;
                                const hex = `#${plate.color.map(c => c.toString(16).padStart(2, '0')).join('')}`;
                                const isSpot = plate.is_spot || !PROCESS_NAMES.has(plate.name);
                                const spotMeta = spotInksMeta.find(s => s.name === plate.name);
                                return (
                                    <div
                                        key={plate.name}
                                        className={`flex items-center justify-between cursor-pointer transition-all ${
                                            idx < plateList.length - 1 ? 'border-b border-slate-100 dark:border-zinc-700' : ''
                                        } ${isSolo ? 'bg-indigo-50 dark:bg-indigo-900/20 ring-1 ring-inset ring-indigo-300 dark:ring-indigo-700' : ''} ${!isVisible && !isSolo ? 'opacity-40' : ''} hover:bg-slate-50 dark:hover:bg-zinc-750`}
                                        style={{ padding: '6px 10px' }}
                                    >
                                        <div className="flex items-center gap-2.5 flex-1 min-w-0">
                                            <input 
                                                type="checkbox" 
                                                checked={isVisible} 
                                                onChange={() => togglePlate(plate.name)} 
                                                className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600 focus:ring-offset-0 cursor-pointer shrink-0" 
                                            />
                                            <div 
                                                className="w-4 h-4 rounded-sm ring-1 ring-black/10 shrink-0" 
                                                style={{ backgroundColor: hex }}
                                            ></div>
                                            <div className="flex flex-col min-w-0">
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-[12px] text-slate-700 dark:text-zinc-200 font-medium truncate">
                                                        {PNAMES[plate.name] || plate.name}
                                                    </span>
                                                    {isSpot && (
                                                        <span className="text-[8px] px-1 py-0 rounded bg-amber-200 text-amber-800 font-bold shrink-0 dark:bg-amber-700/40 dark:text-amber-300">SPOT</span>
                                                    )}
                                                </div>
                                                {isSpot && spotMeta && (
                                                    <span className="text-[9px] text-slate-400 font-mono">
                                                        Phủ: {spotMeta.coverage_pct}%{spotMeta.is_pantone ? ' · Pantone' : ''}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1.5 shrink-0">
                                            <span ref={el => { pctRefs.current[plate.name] = el; }} className="font-mono text-[11px] text-slate-400 tabular-nums">0%</span>
                                            {/* Solo Plate Button */}
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleSoloPlate(plate.name); }}
                                                className={`w-5 h-5 flex items-center justify-center rounded transition-colors text-[11px] ${
                                                    isSolo 
                                                        ? 'bg-indigo-500 text-white' 
                                                        : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-700 hover:text-slate-600'
                                                }`}
                                                title={isSolo ? t('tabs.outputPreview:tat_xem_rieng') : `Xem riêng plate ${plate.name}`}
                                            >
                                                {isSolo ? '◉' : '○'}
                                            </button>
                                            {isSpot && (
                                                <button
                                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); convertSpot(plate.name); }}
                                                    disabled={!!convertingSpot}
                                                    className="text-[9px] px-1.5 py-0.5 bg-amber-500 hover:bg-amber-600 text-white rounded font-bold disabled:opacity-50 transition-colors"
                                                    title={`Chuyển ${plate.name} → CMYK`}
                                                >
                                                    {convertingSpot === plate.name ? '...' : '→CMYK'}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                            {/* TAC Row */}
                            <div className="flex items-center justify-between bg-slate-50/80 dark:bg-zinc-800/80 border-t border-slate-200 dark:border-zinc-700" style={{ padding: '5px 12px' }}>
                                <span className="text-[11px] text-slate-500 italic" style={{ paddingLeft: '30px' }}>{t('tabs.outputPreview:tong_phu_muc_tac')}</span>
                                <span ref={tacRef} className="font-mono text-[11px] text-slate-400 tabular-nums">0%</span>
                            </div>
                        </div>
                    )}
                </div>

                {/* ─── Options ─── */}
                <div style={{ paddingTop: '8px', borderTop: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={showTacWarning}
                                onChange={(e) => setShowTacWarning(e.target.checked)}
                                className="w-3.5 h-3.5 rounded border-slate-300 text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                            />
                            <span className="text-[12px] text-slate-600 dark:text-zinc-300">{t('tabs.outputPreview:canh_bao_tac')}</span>
                        </label>
                        <div className="flex items-center gap-1.5">
                            <div className="w-4 h-4 rounded-sm bg-emerald-500 ring-1 ring-black/10"></div>
                            <div className="flex items-center bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-600 rounded overflow-hidden">
                                <input
                                    type="number"
                                    value={tacThreshold}
                                    onChange={(e) => setTacThreshold(Number(e.target.value))}
                                    className="w-10 text-[12px] text-center bg-transparent text-slate-700 dark:text-zinc-200 border-none outline-none focus:ring-0 p-0"
                                    style={{ padding: '2px 0' }}
                                />
                                <span className="text-[11px] text-slate-400 pr-1.5 select-none">%</span>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={showTacHeatmap}
                                onChange={(e) => setShowTacHeatmap(e.target.checked)}
                                className="w-3.5 h-3.5 rounded border-slate-300 text-red-500 focus:ring-red-500 cursor-pointer"
                            />
                            <span className="text-[12px] text-slate-600 dark:text-zinc-300">{t('tabs.outputPreview:heatmap_vung_qua_muc')}</span>
                        </label>
                        <div className="flex items-center gap-1">
                            <div className="w-3 h-3 rounded-sm bg-gradient-to-r from-yellow-400 to-red-500"></div>
                            <span className="text-[10px] text-slate-400">TAC &gt; {tacThreshold}%</span>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input 
                                type="checkbox" 
                                checked={useGhostscript} 
                                onChange={(e) => setUseGhostscript(e.target.checked)} 
                                className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600 cursor-pointer" 
                            />
                            <span className="text-[12px] text-slate-600 dark:text-zinc-300">
                                Chế độ tách màu chuyên sâu {detectedSpots.length > 0 ? t('tabs.outputPreview:da_tu_bat') : t('tabs.outputPreview:cham_hon')}
                            </span>
                        </label>
                        
                        {/* Tooltip Icon */}
                        <div className="relative group/tooltip flex items-center justify-center w-4 h-4 rounded-full bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-[10px] text-slate-500 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors cursor-help">
                            ?
                            {/* Tooltip Content */}
                            <div className="absolute bottom-full right-1/2 translate-x-[20%] mb-2 w-max max-w-[260px] p-3 bg-slate-800 dark:bg-zinc-700 text-white text-[11px] font-normal leading-relaxed rounded-lg shadow-xl opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all z-[100] pointer-events-none text-left whitespace-normal break-words">
                                <p className="mb-1 text-emerald-300">{t('tabs.outputPreview:he_thong_se_tu_dong_bat_che_do_nay_neu')}</p>
                                <p className="mb-1 opacity-90"><strong className="text-white">{t('tabs.outputPreview:mac_dinh')}</strong> {t('tabs.outputPreview:tach_4_mau_cmyk_tieu_chuan_toc_do_sieu')}</p>
                                <p className="opacity-90"><strong className="text-white">{t('tabs.outputPreview:chuyen_sau')}</strong> {t('tabs.outputPreview:gia_lap_may_rip_thuc_te_boc_chinh_xac')}</p>
                                <div className="absolute top-full right-[20%] translate-x-1/2 w-2 h-2 bg-slate-800 dark:bg-zinc-700 transform rotate-45 -mt-1"></div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* ─── Overprint Preview ─── */}
                <OverprintPreviewToggle fileId={fileId} pageNum={pageNum} />

                {/* ─── Spot Convert All ─── */}
                {hasSpotInks && (
                    <button
                        onClick={() => convertSpot()}
                        disabled={!!convertingSpot}
                        className="w-full px-3 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-[12px] font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {convertingSpot === '__all__' ? (
                            <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('tabs.outputPreview:dang_chuyen')}</>
                        ) : (
                            <>{t('tabs.outputPreview:chuyen_tat_ca_spot_cmyk')}</>
                        )}
                    </button>
                )}

                {/* ─── Page Info ─── */}
                <div className="bg-slate-50 dark:bg-zinc-800/50 rounded-lg border border-slate-100 dark:border-zinc-800" style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <div className="flex items-center justify-between">
                        <span className="text-[11px] text-slate-500">{t('tabs.outputPreview:tong_ban_kem')}</span>
                        <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-300">
                            {plateList.length} ({plateList.filter(p => !PROCESS_NAMES.has(p.name)).length} Spot)
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[11px] text-slate-500">{t('tabs.outputPreview:trong_suot')}</span>
                        <span className={`text-[11px] font-semibold ${pageHasTransparency ? 'text-amber-600' : 'text-slate-600'}`}>
                            {pageHasTransparency ? t('tabs.outputPreview:co') : t('tabs.outputPreview:khong')}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[11px] text-slate-500">{t('tabs.outputPreview:he_mau_hoa_tron')}</span>
                        <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-300">{blendingColorSpace}</span>
                    </div>
                    {detectedSpots.length > 0 && (
                        <div className="flex items-start justify-between mt-1 pt-1 border-t border-slate-200 dark:border-zinc-700">
                            <span className="text-[11px] text-slate-500">{t('tabs.outputPreview:mau_spot')}</span>
                            <div className="flex flex-wrap gap-1 justify-end max-w-[200px]">
                                {detectedSpots.map(s => (
                                    <span key={s} className="text-[9px] px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded font-medium">{s}</span>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* ─── ICC Soft-Proof ─── */}
                <div style={{ borderTop: '1px solid #e2e8f0' }}>
                    <button
                        onClick={() => setShowSoftProof(p => !p)}
                        className="w-full flex items-center justify-between py-2 text-[11px] font-bold text-slate-400 uppercase tracking-widest hover:text-slate-600 dark:hover:text-zinc-300 transition-colors"
                    >
                        <span>🔍 ICC Soft-Proof & Gamut</span>
                        <svg className={`w-3 h-3 transition-transform ${showSoftProof ? 'rotate-180' : ''}`} fill="currentColor" viewBox="0 0 20 20"><path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"/></svg>
                    </button>
                    {showSoftProof && <SoftProofPanel fileId={fileId} />}
                </div>

            </div>
        </div>
    );
}

function OverprintPreviewToggle({ fileId, pageNum }: { fileId: string; pageNum: number }) {
  const { t } = useTranslation();
    const [active, setActive] = useState(false);
    const [loading, setLoading] = useState(false);
    const [diffCount, setDiffCount] = useState<number | null>(null);
    const [error, setError] = useState('');
    const setOverprintPreviewUrl = useWorkspaceStore(s => s.setOverprintPreviewUrl);

    const toggle = useCallback(async () => {
        if (active) {
            // Turn off
            setActive(false);
            setOverprintPreviewUrl(null);
            setDiffCount(null);
            return;
        }

        setLoading(true);
        setError('');
        try {
            const res = await authenticatedFetch(`${getApiUrl()}/preflight/overprint-preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: fileId, page: pageNum, dpi: 150 }),
            });
            const data = await res.json();
            if (data.success) {
                setActive(true);
                setDiffCount(data.diff_pixel_count);
                if (data.has_differences) {
                    setOverprintPreviewUrl(data.diff_overlay);
                } else {
                    setOverprintPreviewUrl(null);
                }
            } else {
                setError(data.error || t('tabs.outputPreview:loi_khong_xac_dinh'));
            }
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [active, fileId, pageNum, setOverprintPreviewUrl]);

    // Reset when page changes
    useEffect(() => {
        setActive(false);
        setOverprintPreviewUrl(null);
        setDiffCount(null);
    }, [pageNum, fileId, setOverprintPreviewUrl]);

    return (
        <div className="flex flex-col gap-1.5">
            <button
                onClick={toggle}
                disabled={loading}
                className={`w-full px-3 py-2 rounded-lg text-[12px] font-bold transition-all flex items-center justify-center gap-2 border ${
                    active
                        ? 'bg-violet-500/15 border-violet-500 text-violet-700 dark:text-violet-300'
                        : 'bg-white dark:bg-zinc-800 border-slate-200 dark:border-zinc-600 text-slate-600 dark:text-zinc-300 hover:border-violet-400'
                }`}
            >
                {loading ? (
                    <><div className="w-3.5 h-3.5 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" /> {t('tabs.outputPreview:dang_phan_tich')}</>
                ) : active ? (
                    <>{t('tabs.outputPreview:tat_overprint_preview')}</>
                ) : (
                    <>🔲 Overprint Preview</>
                )}
            </button>
            {active && diffCount !== null && (
                <div className={`text-[10px] px-2 py-1 rounded ${
                    diffCount > 0
                        ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300'
                        : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
                }`}>
                    {diffCount > 0
                        ? `⚠️ Phát hiện ${diffCount.toLocaleString()} pixel thay đổi khi bật Overprint`
                        : t('tabs.outputPreview:khong_co_su_khac_biet_file_khong_bi_anh')}
                </div>
            )}
            {error && <div className="text-[10px] text-red-500 px-2">{error}</div>}
        </div>
    );
}
