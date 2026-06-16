import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Page } from 'react-pdf';
import { convertFileSrc } from '@tauri-apps/api/core';
import { authenticatedFetch, getApiUrl } from '../../lib/api';
import { VdpPreviewImage } from './ViewerHelpers';
import { useViewerHotkeys } from '../../hooks/viewer/useViewerHotkeys';
import { globalPdfObjectCache } from '../../stores/pdfObjectCache';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useShallow } from 'zustand/react/shallow';
import type { ObjType, BBox, EditOp } from './editTypes';
import { FontSelector } from '../preprocess-tools/FontSelector';

// ─── Edit PDF Object (task 10.1) ─────────────────────────────────────────────
// Object do GET /edit/objects trả về, SAU khi đã convert bbox PDF (bottom-left)
// → hệ canvas top-left (point), để dùng chung công thức `x * scale` với overlay
// Selection_Mode sẵn có. `bbox` ở đây luôn là [x0, y0_top, x1, y1_bottom] (top-left).
interface EditCanvasObj {
    id: string;
    drawIndex: number;
    type: ObjType;
    bbox: BBox; // top-left origin, đơn vị point
    matrix?: number[];
    content?: string; // nội dung text gốc (type='text') để điền sẵn editor
    color?: number[]; // màu tô RGB 0..255 (type='text') để editor khớp màu gốc
}

// ─── Edit PDF Object — move/resize/rotate (task 10.2) ────────────────────────
// Hệ handle nw/ne/sw/se được TÁI DÙNG từ `vdpInteraction`, THÊM handle xoay.
type EditHandle = 'nw' | 'ne' | 'sw' | 'se';

// Trạng thái một thao tác transform đang diễn ra (kéo chuột). startBox là hộp bao
// hợp nhất (union) của các object được chọn TẠI THỜI ĐIỂM BẮT ĐẦU kéo, theo px
// canvas (gốc trên-trái). startX/startY là vị trí chuột (đã khử xoay) lúc bắt đầu.
interface EditInteraction {
    type: 'move' | 'resize' | 'rotate';
    handle?: EditHandle;
    startX: number;
    startY: number;
    startBox: { left: number; top: number; width: number; height: number };
}

// Transform TẠM (preview real-time) áp lên overlay bằng CSS — KHÔNG fetch/lưu mỗi
// frame (Yêu cầu 13.2). dx/dy theo px canvas; sx/sy là hệ số; rotateDeg theo hệ
// MÀN HÌNH (clockwise dương vì trục y canvas hướng xuống).
type EditLiveTransform =
    | { kind: 'move'; dx: number; dy: number }
    | { kind: 'resize'; sx: number; sy: number; anchor: EditHandle }
    | { kind: 'rotate'; rotateDeg: number };

// Handle người dùng kéo → góc NEO cố định (góc đối diện). Backend resize_objects
// nhận trực tiếp góc cố định này; nhãn nw/ne/sw/se ở đây là theo VỊ TRÍ NHÌN THẤY
// và trùng ngữ nghĩa với _anchor_point của backend ('n' = mép trên nhìn thấy).
const EDIT_OPPOSITE_ANCHOR: Record<EditHandle, EditHandle> = {
    nw: 'se', ne: 'sw', sw: 'ne', se: 'nw',
};

// Góc neo cố định → transform-origin CSS (để scale overlay quanh đúng góc cố định).
const EDIT_ANCHOR_ORIGIN: Record<EditHandle, string> = {
    nw: '0% 0%', ne: '100% 0%', sw: '0% 100%', se: '100% 100%',
};

// ─── Edit PDF Object — thêm object (task 10.3) ───────────────────────────────
// Id "ảo" dùng cho editor text inline khi ĐANG ĐẶT object text MỚI (chưa có id từ
// /edit/objects). TÁI DÙNG chung state editingTextId/editTextContent với editor
// text-object hiện có; sentinel này phân biệt nhánh "thêm mới" vs "sửa cụm có sẵn".
const EDIT_ADD_TEXT_ID = '__edit_add_text__';
// Kích thước/cỡ chữ mặc định (point) cho object MỚI tạo tại điểm bấm.
const EDIT_ADD_TEXT_SIZE_PT = 12;
const EDIT_ADD_TEXT_W_PT = 200;
const EDIT_ADD_IMAGE_SIZE_PT = 150;

const TILE_SIZE = 512;

// ═══ Frontend Tile URL Cache ═══
// Persists tile image URLs across Virtuoso mount/unmount cycles
// so scrolling back to a previously-loaded page shows it INSTANTLY (no white flash).
const _tileUrlCache = new Map<string, string>();
const TILE_CACHE_MAX = 200; // Max cached tile URLs (LRU eviction)

function cacheTileUrl(key: string, url: string) {
    // LRU eviction: if full, delete the oldest entry
    if (_tileUrlCache.size >= TILE_CACHE_MAX && !_tileUrlCache.has(key)) {
        const oldest = _tileUrlCache.keys().next().value;
        if (oldest) {
            const oldUrl = _tileUrlCache.get(oldest);
            // Don't revoke protocol URLs (http://tile.localhost), only blobs
            if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
            _tileUrlCache.delete(oldest);
        }
    }
    _tileUrlCache.set(key, url);
}

function getCachedTileUrl(key: string): string | undefined {
    const url = _tileUrlCache.get(key);
    if (url) {
        // Move to end (most recently used) for LRU
        _tileUrlCache.delete(key);
        _tileUrlCache.set(key, url);
    }
    return url;
}

// Clear cache when loading a new file (called from parent)
export function clearTileUrlCache() {
    for (const [, url] of _tileUrlCache) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    _tileUrlCache.clear();
}

// ═══ Edit Objects Cache (chế độ Chỉnh sửa đối tượng) ═══
// Cache danh sách EditCanvasObj theo khóa `${selectionFileId}:${pageIndex}` để
// bật/tắt chế độ KHÔNG phải fetch lại /edit/objects (hết "load lâu khi tắt/bật").
// Clear khi pdfUrl đổi (file mới / commit working-file mới) để không dùng dữ liệu cũ.
const _editObjectsCache = new Map<string, EditCanvasObj[]>();
function clearEditObjectsCache() {
    _editObjectsCache.clear();
}

const LiveTile = React.memo(({ fileKey, pageNum, zoom, coarseZoom, rot, clipX, clipY, clipW, clipH, cssLeft, cssTop, cssW, cssH, eager, getTileUrl, onVisible }: any) => {
    const tileRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const loadedParamsRef = useRef('');
    const preloadRef = useRef<HTMLImageElement|null>(null);
    const hasLoadedOnce = useRef(false);
    
    const currentParams = `${fileKey}_${pageNum}_${zoom}_${rot}_${clipX}_${clipY}_${clipW}_${clipH}`;
    
    // On mount: immediately restore cached image (no white flash!)
    useEffect(() => {
        const cachedUrl = getCachedTileUrl(currentParams);
        if (cachedUrl && imgRef.current) {
            imgRef.current.src = cachedUrl;
            loadedParamsRef.current = currentParams;
            hasLoadedOnce.current = true;
            // Show immediately if cached
            if (tileRef.current) tileRef.current.style.opacity = '1';
            // Trang chính đã hiển thị (từ cache) → mở cổng cho thumbnail tải.
            window.dispatchEvent(new CustomEvent('prynx-main-tile-ready'));
        }
    }, []); // Only on mount
    
    useEffect(() => {
        const el = tileRef.current;
        if (!el) return;
        
        if (loadedParamsRef.current === currentParams) return;
        
        // Check cache before scheduling network load
        const cachedUrl = getCachedTileUrl(currentParams);
        if (cachedUrl && imgRef.current) {
            imgRef.current.src = cachedUrl;
            loadedParamsRef.current = currentParams;
            hasLoadedOnce.current = true;
            if (tileRef.current) tileRef.current.style.opacity = '1';
            return;
        }
        
        (el as any)._loadTile = () => {
            if (loadedParamsRef.current === currentParams) return;
            if (!getTileUrl) return;
            const paramsAtRequest = currentParams;
            loadedParamsRef.current = paramsAtRequest;
            
            // Cancel previous preload
            if (preloadRef.current) {
                preloadRef.current.onload = null;
                preloadRef.current.onerror = null;
                preloadRef.current = null;
            }

            // Tải tile ở 'scale'. cache=true mới lưu cache. onDone gọi sau khi hiện xong
            // (dùng để nối pha sharp sau pha coarse — TUẦN TỰ, tránh tranh chấp mutex pdfium).
            const loadAt = (scale: number, cache: boolean, onDone?: () => void) => {
                getTileUrl(pageNum, rot, scale, clipX, clipY, clipW, clipH)
                    .then((url: string) => {
                        if (loadedParamsRef.current !== paramsAtRequest) {
                            if (url && url.startsWith('blob:') && !url.includes('#keep')) URL.revokeObjectURL(url);
                            return;
                        }
                        const preImg = new Image();
                        preloadRef.current = preImg;
                        preImg.onload = () => {
                            if (loadedParamsRef.current !== paramsAtRequest) return;
                            const imgEl = imgRef.current;
                            if (imgEl) {
                                const oldSrc = imgEl.src;
                                imgEl.src = url;
                                if (cache) cacheTileUrl(paramsAtRequest, url);
                                if (oldSrc && oldSrc.startsWith('blob:') && oldSrc !== url && !oldSrc.includes('#keep')) {
                                    let inCache = false;
                                    for (const [, v] of _tileUrlCache) { if (v === oldSrc) { inCache = true; break; } }
                                    if (!inCache) URL.revokeObjectURL(oldSrc);
                                }
                            }
                            if (!hasLoadedOnce.current) {
                                hasLoadedOnce.current = true;
                                if (tileRef.current) tileRef.current.style.opacity = '1';
                                // Trang chính vừa hiển thị → mở cổng cho thumbnail tải
                                // (tránh thumbnail tranh chấp pdfium handle với trang chính).
                                window.dispatchEvent(new CustomEvent('prynx-main-tile-ready'));
                            }
                            preloadRef.current = null;
                            if (onDone) onDone();
                        };
                        preImg.onerror = () => {
                            preloadRef.current = null;
                            if (onDone) { onDone(); return; }  // coarse lỗi → vẫn thử sharp
                            if (loadedParamsRef.current === paramsAtRequest) loadedParamsRef.current = '';
                        };
                        preImg.src = url;
                    })
                    .catch(() => {
                        if (onDone) { onDone(); return; }
                        if (loadedParamsRef.current === paramsAtRequest) loadedParamsRef.current = '';
                    });
            };

            if (typeof coarseZoom === 'number' && coarseZoom < zoom - 0.05) {
                // Pha 1: coarse (nhanh) hiện trước → Pha 2: sharp nối sau (tuần tự).
                loadAt(coarseZoom, false, () => {
                    if (loadedParamsRef.current === paramsAtRequest) loadAt(zoom, true);
                });
            } else {
                loadAt(zoom, true);
            }
        };
        onVisible(el, false, eager);
        return () => {
            onVisible(el, true, eager);
        };
    }, [currentParams, getTileUrl, onVisible]);
    
    // Cleanup on unmount — DON'T revoke blob URLs, they're in the cache now!
    useEffect(() => {
        return () => {
            if (preloadRef.current) {
                preloadRef.current.onload = null;
                preloadRef.current = null;
            }
            // Intentionally NOT revoking imgRef.current.src — it's cached for instant re-mount
        };
    }, []);
    // Initialize empty pixel only once (but only if no cached image was restored)
    useEffect(() => {
        if (imgRef.current && !imgRef.current.src) {
            imgRef.current.src = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
        }
    }, []);
    
    return (
        <div ref={tileRef} style={{ position: 'absolute', left: cssLeft ?? clipX, top: cssTop ?? clipY, width: cssW || clipW, height: cssH || clipH, outline: 'none', opacity: hasLoadedOnce.current ? 1 : 0, transition: 'opacity 0.05s ease-in' }} className="tile-container">
            <img ref={imgRef} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'fill', pointerEvents: 'none', userSelect: 'none', background: 'white' }} />
        </div>
    );
});

// ═══ VDP text preview với AUTO-FIT ═══
// Bóp cỡ chữ (xuống tối thiểu) để text vừa CHIỀU CAO khung, khớp với engine backend
// (ReportLab cũng bóp theo chiều cao). Khi autoFit === false thì giữ nguyên cỡ chữ.
const VdpAutoFitText = ({ field, scale, text, onAutoFit }: any) => {
    const ref = useRef<HTMLSpanElement>(null);
    // Backend render fontSize ở pt THẬT, nhưng khung dùng đơn vị CSS (×96/72). Để preview
    // khớp output, cỡ chữ trên màn = fontSize(pt) × scale × (96/72). scale = displayWidth/pageDim.w.
    const maxPx = (field.fontSize || 10) * scale * (96 / 72);
    const [fitPx, setFitPx] = useState<number>(maxPx);

    useLayoutEffect(() => {
        if (field.autoFit === false) { setFitPx(maxPx); return; }
        const el = ref.current;
        const parent = el?.parentElement;
        if (!el || !parent) return;
        let size = maxPx;
        el.style.fontSize = `${size}px`;
        let guard = 0;
        while (guard++ < 300 && size > 1 &&
               (el.scrollHeight > parent.clientHeight + 0.5 || el.scrollWidth > parent.clientWidth + 0.5)) {
            size -= Math.max(0.5, size * 0.06);
            el.style.fontSize = `${size}px`;
        }
        setFitPx(size);
        // Ghi cỡ chữ THỰC TẾ (sau khi bóp) về field.fontSize → ô "Cỡ chữ" trên UI luôn khớp
        // preview & output. Chỉ ghi khi đã bị bóp nhỏ hơn để tránh vòng lặp (đã hội tụ).
        if (onAutoFit && scale > 0 && size < maxPx - 0.5) {
            onAutoFit(size / (scale * (96 / 72)));
        }
    }, [text, maxPx, field.width, field.height, field.autoFit, field.fontName, field.fontStyle, field.lineHeight, field.characterSpacing, field.alignment]);

    const fontPx = field.autoFit === false ? maxPx : fitPx;
    return (
        <span
            ref={ref}
            className="px-1 whitespace-pre-wrap break-words overflow-hidden w-full h-full"
            style={{
                color: field.fontColor || '#1e293b',
                fontSize: `${fontPx}px`,
                fontFamily: field.fontName === 'Helvetica' ? 'Arial, sans-serif' : field.fontName === 'Times-Roman' ? '"Times New Roman", serif' : field.fontName === 'Courier' ? 'Courier, monospace' : (field.fontName ? `"${field.fontName}", sans-serif` : 'inherit'),
                fontWeight: field.fontStyle === 'bold' || field.fontStyle === 'bolditalic' ? 'bold' : 'normal',
                fontStyle: field.fontStyle === 'italic' || field.fontStyle === 'bolditalic' ? 'italic' : 'normal',
                lineHeight: field.lineHeight ? `${field.lineHeight}em` : 1,
                // Backend (ReportLab Paragraph) chưa hỗ trợ tracking → preview cũng bỏ qua để khớp output.
                letterSpacing: 0,
                textAlign: field.alignment || 'left'
            }}
        >
            {text}
        </span>
    );
};

export const LivePageFrame = (props: any) => {
    //#region Props & State
    const { originalPageNum, actualWidth100, zoom, rotation, bleedView, highlightBoxes, pageDim,
        onObjectDelete, fetchObjectsForPage,
        getTileUrl, textBlocks, isVdpMode, onVdpBoxCreate, onVdpBoxSelect, onVdpFieldsChange,
        setHoveredPdfPosition, detectedDimension, isBlankDoc, onEditCommit
    } = props;

    const {
        isSelectionMode, isObjectEditMode, pdfObjectsVersion, selectedObjectIds, selectionFileId, hiddenObjectIds, hiddenOcgLayerIds,
        separationPlates, vdpFields, selectedVdpFieldIds,
        softProofImageUrl, gamutWarningUrl, tacHeatmapUrl, overprintPreviewUrl,
        setSelectedObjectIds, pdfUrl, setSelectedVdpFieldIds
    } = useWorkspaceStore(useShallow(state => ({
        isSelectionMode: state.isSelectionMode,
        isObjectEditMode: state.isObjectEditMode,
        pdfObjectsVersion: state.pdfObjectsVersion,
        selectedObjectIds: state.selectedObjectIds,
        selectionFileId: state.selectionFileId,
        hiddenObjectIds: state.hiddenObjectIds,
        hiddenOcgLayerIds: state.hiddenOcgLayerIds,
        separationPlates: state.separationPlates,
        vdpFields: state.vdpFields,
        selectedVdpFieldIds: state.selectedVdpFieldIds,
        softProofImageUrl: state.softProofImageUrl,
        gamutWarningUrl: state.gamutWarningUrl,
        tacHeatmapUrl: state.tacHeatmapUrl,
        overprintPreviewUrl: state.overprintPreviewUrl,
        setSelectedObjectIds: state.setSelectedObjectIds,
        pdfUrl: state.pdfUrl,
        setSelectedVdpFieldIds: state.setSelectedVdpFieldIds
    })));

    const onObjectSelect = setSelectedObjectIds;
    
    const watermarkPreview = useWorkspaceStore(s => s.watermarkPreview);
    const activeDashboardTool = useWorkspaceStore(s => s.activeDashboardTool);
    const containerRef = useRef<HTMLDivElement>(null);
    const marqueeRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startX: number; startY: number; active: boolean; lastHoverTime?: number }>({ startX: 0, startY: 0, active: false });
    
    const { stickPreviewParams } = useWorkspaceStore();

    // VDP Drag/Resize interaction state
    const [vdpInteraction, setVdpInteraction] = useState<{ type: 'move'|'resize', handle?: 'nw'|'ne'|'sw'|'se', fieldIds: string[], startX: number, startY: number, startFields: Record<string, {x: number, y: number, w: number, h: number}> } | null>(null);
    const [editingTextId, setEditingTextId] = useState<string | null>(null);
    const [editTextContent, setEditTextContent] = useState<string>('');
    // Font người dùng chọn khi sửa/thêm text (đường dẫn file .ttf/.otf trên máy);
    // rỗng = giữ font gốc nếu được, ngược lại fallback DejaVuSans (hành vi cũ).
    const [editFontPath, setEditFontPath] = useState<string | undefined>(undefined);
    const [editFontName, setEditFontName] = useState<string>('');
    
    // Preview image state (driven by hiddenObjectIds prop from parent)
    const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);

    // ─── Edit PDF Object — Hit-test + overlay (task 10.1) ────────────────────
    // Nguồn dữ liệu object lấy từ GET /edit/objects (Geometry_Reader, PDFium read-only).
    // Tách biệt khỏi globalPdfObjectCache (luồng /preflight) vì khác hệ tọa độ + khác
    // id-space → tránh phá vỡ delete/hide/SelectionLayersPanel hiện có.
    const [editObjects, setEditObjects] = useState<EditCanvasObj[]>([]);
    const [editSelectedIds, setEditSelectedIds] = useState<string[]>([]);

    // ─── Edit PDF Object — move/resize/rotate + overlay real-time (task 10.2) ─
    // editInteraction: thao tác kéo đang diễn ra. Transform tạm (xem trước real-time)
    // được áp lên ghost qua DOM ref (editGhostRef/editLiveTransformRef bên dưới),
    // KHÔNG dùng state để không re-render mỗi frame (Yêu cầu 13.2).
    const [editInteraction, setEditInteraction] = useState<EditInteraction | null>(null);
    const [editBusy, setEditBusy] = useState(false);
    // Ghost transform REAL-TIME bằng DOM ref — KHÔNG setState mỗi mousemove (tránh
    // re-render TOÀN BỘ LivePageFrame gây giật). editGhostRef trỏ div ghost dashed;
    // handleMouseMove cập nhật trực tiếp editGhostRef.current.style. editLiveTransformRef
    // lưu transform hiện tại để handleMouseUp đọc khi commit (thay cho state).
    const editGhostRef = useRef<HTMLDivElement>(null);
    const editLiveTransformRef = useRef<EditLiveTransform | null>(null);
    // GIỮ ghost ở vị trí vừa thả tới khi overlay cập nhật vị trí MỚI (sau commit)
    // → bỏ hiện tượng khung chọn "giật về chỗ cũ rồi nhảy tới chỗ mới".
    const editGhostHoldRef = useRef<boolean>(false);
    const editGhostHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Ẩn ghost + xóa transform tạm; dùng chung cho commit/refetch/timeout an toàn.
    const hideEditGhost = React.useCallback(() => {
        editGhostHoldRef.current = false;
        if (editGhostHideTimerRef.current) {
            clearTimeout(editGhostHideTimerRef.current);
            editGhostHideTimerRef.current = null;
        }
        if (editGhostRef.current) {
            editGhostRef.current.style.display = 'none';
            editGhostRef.current.style.transform = 'none';
        }
    }, []);

    // ─── Edit PDF Object — editor text inline + thêm object (task 10.3) ──────
    // editAddMode: chế độ "đặt object mới" do toolbar bật ('text'/'image'); cú bấm
    // kế tiếp lên trang sẽ đặt object tại điểm đó. editAddDraft: điểm bấm đã chốt
    // theo hệ CANVAS top-left (point) — convert sang PDF bottom-left khi gửi /edit/add.
    // editFileInputRef: input file ẩn để chọn ảnh khi thêm image.
    const [editAddMode, setEditAddMode] = useState<'text' | 'image' | null>(null);
    const [editAddDraft, setEditAddDraft] = useState<{ xPt: number; yPt: number } | null>(null);
    const editFileInputRef = useRef<HTMLInputElement>(null);

    const observerRef = useRef<IntersectionObserver | null>(null);

    const handleTileVisibility = React.useCallback((el: HTMLElement, isCleanup?: boolean) => {
        if (!observerRef.current) {
            observerRef.current = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const target = entry.target as any;
                        if (target._loadTile) target._loadTile();
                        observerRef.current?.unobserve(target);
                    }
                });
            }, { rootMargin: '600px' });
        }
        if (isCleanup) {
            observerRef.current.unobserve(el);
        } else {
            observerRef.current.observe(el);
        }
    }, []);

    // Scale render cho 1 tile phủ CẢ TRANG (chỉ 1 lần render/trang — pdfium xử lý cả
    // trang dù cắt ô, nên tiling chỉ làm chậm gấp N). Vì chi phí render ~ độ phức tạp
    // PDF chứ gần như KHÔNG theo độ phân giải, ta render ở scale cao (nét) mà giá ~ nhau.
    // LƯỢNG TỬ HOÁ theo nấc → zoom thay đổi nhỏ tái dùng ảnh đã cache (đỡ render lại khi zoom).
    const computeRenderZoom = (z: number) => {
        const dpr = (window.devicePixelRatio || 1);
        const target = Math.max(dpr, z * dpr);
        const w100 = actualWidth100 || 800;
        const ratio = (pageDim && pageDim.w) ? Math.max(1, pageDim.h / pageDim.w) : 1.414;
        // Cap bộ nhớ: cạnh dài bitmap ≤ 6000px (1 render, ~200MB tạm). Native tự clamp ≤8000.
        const capByBudget = 6000 / (w100 * ratio);
        const hardCap = Math.min(7.5, Math.max(dpr, capByBudget));
        const steps = [1, 1.5, 2, 3, 4, 5, 6, 7.5];
        const q = steps.find(s => s >= target - 1e-3) ?? 7.5;
        return Math.max(dpr, Math.min(q, hardCap));
    };
    const [renderZoom, setRenderZoom] = useState(() => computeRenderZoom(zoom));

    useEffect(() => {
        const timeoutId = setTimeout(() => {
            setRenderZoom(computeRenderZoom(zoom));
        }, 250);
        return () => clearTimeout(timeoutId);
    }, [zoom]);

    useEffect(() => {
        if (isSelectionMode && originalPageNum !== -1) {
            fetchObjectsForPage?.(originalPageNum);
        }
    }, [isSelectionMode, originalPageNum, fetchObjectsForPage]);

    // ─── Edit PDF Object: nạp danh sách object từ /edit/objects (task 10.1) ───
    // Khi vào Selection_Mode, gọi GET /edit/objects/{fid}/{pageIndex} (0-based) để lấy
    // ObjMeta (bbox hệ PDF bottom-left) rồi convert sang hệ canvas top-left bằng
    // chiều cao trang (pageDim.h, point) — dùng chung công thức `x * scale` với overlay.
    useEffect(() => {
        if (!isObjectEditMode || originalPageNum === -1 || !selectionFileId || !pageDim?.h) {
            setEditObjects([]);
            setEditSelectedIds([]);
            return;
        }
        const pageIndex = originalPageNum - 1; // /edit dùng chỉ số 0-based
        const cacheKey = `${selectionFileId}:${pageIndex}`;

        // Cache-hit → dùng ngay, KHÔNG fetch lại (bật/tắt chế độ không tải lại).
        const cached = _editObjectsCache.get(cacheKey);
        if (cached) {
            setEditObjects(cached);
            setEditSelectedIds([]);
            hideEditGhost();
            return;
        }

        let cancelled = false;
        // pageDim.h là px@96 (= point × 96/72). Bbox /edit/objects ở POINT. Quy đổi
        // chiều cao trang về POINT để lật trục y NHẤT QUÁN đơn vị (giữ bbox ở point).
        const pageHeightPt = pageDim.h * 72 / 96;
        (async () => {
            try {
                const res = await authenticatedFetch(`${getApiUrl()}/edit/objects/${selectionFileId}/${pageIndex}`);
                if (!res.ok) throw new Error(`/edit/objects HTTP ${res.status}`);
                const data = await res.json();
                if (cancelled) return;
                const objs: EditCanvasObj[] = (data.objects || []).map((o: any) => {
                    const [x0, yb, x1, yt] = o.bbox; // PDF bottom-left: [left, bottom, right, top]
                    // Convert sang top-left: top edge = pageH - yTop, bottom edge = pageH - yBottom.
                    const top = pageHeightPt - yt;
                    const bottom = pageHeightPt - yb;
                    return {
                        id: o.id,
                        drawIndex: o.drawIndex,
                        type: o.type as ObjType,
                        bbox: [x0, Math.min(top, bottom), x1, Math.max(top, bottom)] as BBox,
                        matrix: o.matrix ?? undefined,
                        content: o.content ?? undefined,
                        color: Array.isArray(o.color) ? o.color : undefined,
                    };
                });
                _editObjectsCache.set(cacheKey, objs); // Lưu cache cho lần bật/tắt sau.
                setEditObjects(objs);
                setEditSelectedIds([]);
                hideEditGhost(); // Overlay đã ở vị trí mới → bỏ ghost giữ.
            } catch (err) {
                if (!cancelled) {
                    console.warn('[edit] Không tải được /edit/objects:', err);
                    setEditObjects([]);
                    setEditSelectedIds([]);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [isObjectEditMode, originalPageNum, selectionFileId, pageDim?.h]);

    // ─── Edit PDF Object: Ctrl+A chọn tất cả / Esc bỏ chọn / Delete xóa (task 10.1) ─
    useEffect(() => {
        if (!isObjectEditMode || isVdpMode) return;
        const onKey = (e: KeyboardEvent) => {
            // Bỏ qua khi đang gõ trong input/textarea (vd. editor text inline).
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                setEditSelectedIds(editObjects.map(o => o.id));
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                // Xóa tập object đang chọn → POST /edit/delete → Working_File mới.
                if (editBusy || editSelectedIds.length === 0) return;
                e.preventDefault();
                const op: EditOp = {
                    page: originalPageNum - 1,
                    kind: 'delete',
                    targetIds: [...editSelectedIds],
                };
                const idsToClear = [...editSelectedIds];
                void sendEditAndPreview(op, `${getApiUrl()}/edit/delete`).then(() => {
                    // Bỏ chọn sau khi đã commit (object cũ không còn trên trang mới).
                    setEditSelectedIds(prev => prev.filter(id => !idsToClear.includes(id)));
                });
            } else if (e.key === 'Escape') {
                setEditSelectedIds([]);
                // task 10.3: thoát chế độ đặt object mới đang chờ (nếu có).
                setEditAddMode(null);
                setEditAddDraft(null);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isObjectEditMode, isVdpMode, editObjects, editSelectedIds, editBusy, originalPageNum, selectionFileId, onEditCommit]);

    // ─── Edit PDF Object: reset transform tạm + preview khi đổi lựa chọn (10.2) ─
    // Khi tập chọn thay đổi (hoặc bỏ chọn), bỏ transform tạm và ảnh preview cũ để
    // overlay không "dính" trạng thái của lần thao tác trước.
    useEffect(() => {
        editLiveTransformRef.current = null;
    }, [editSelectedIds]);

    // ─── Edit PDF Object: dọn transform tạm khi Working_File MỚI render (task 12.1) ─
    // SAU commit, onEditCommit → commitWorkingFile đổi `pdfUrl` (Working_File mới đã
    // bake đúng thao tác vào nội dung trang). Khi `pdfUrl` đổi, tile mới phản ánh đúng
    // kết quả lưu → reset transform tạm + xóa cache /edit/objects để overlay khớp
    // Working_File mới (selectionFileId mới → /edit/objects refetch).
    useEffect(() => {
        editLiveTransformRef.current = null;
        // Working_File mới (commit) hoặc file mới → object cũ không còn đúng → xóa cache
        // /edit/objects để lần bật chế độ kế tiếp fetch lại dữ liệu khớp trang mới.
        clearEditObjectsCache();
    }, [pdfUrl]);

    if (originalPageNum === -1) {
        return (
            <div className="bg-white shadow-[0_4px_30px_rgba(0,0,0,0.15)] ring-1 ring-black/5 relative shrink-0 overflow-hidden">
                <div style={{ width: actualWidth100 * zoom, height: actualWidth100 * zoom * 1.414 }} className="bg-white flex items-center justify-center">
                    <span className="text-slate-200 text-3xl font-bold tracking-[0.5em] -rotate-45">DOCUMENT BLANK PAGE</span>
                </div>
            </div>
        );
    }
    
    // Fetch preview image when hidden objects OR hidden OCG layers change
    useEffect(() => {
        if (hiddenObjectIds.length === 0 && hiddenOcgLayerIds.length === 0) {
            setPreviewImageUrl(null);
            setIsPreviewLoading(false);
            return;
        }

        if (!selectionFileId) return;

        let isMounted = true;
        setIsPreviewLoading(true);

        const fetchPreview = async () => {
            try {
                // If there are hidden OCG layers, fetch the layer preview
                if (hiddenOcgLayerIds.length > 0) {
                    const res = await authenticatedFetch(`${getApiUrl()}/preflight/preview-layers`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            file_id: selectionFileId,
                            page: originalPageNum,
                            hidden_layer_numbers: hiddenOcgLayerIds
                        })
                    });
                    if (!res.ok) throw new Error('Preview layer fetch failed');
                    const data = await res.json();
                    if (isMounted && data.success && data.preview_b64) {
                        setPreviewImageUrl(data.preview_b64);
                    }
                    return; // Skip the hidden object fetch if we did OCG
                }

                // Fallback to hidden object preview
                const currentObjects = globalPdfObjectCache.getPageObjects(pdfUrl || '', originalPageNum);
                const objectsToHide = currentObjects.filter((o: any) => hiddenObjectIds.includes(o.id));
                
                const res = await authenticatedFetch(`${getApiUrl()}/preflight/preview-hide`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_id: selectionFileId,
                        page: originalPageNum,
                        objects: objectsToHide.map((obj: any) => ({
                            type: obj.type,
                            bbox: obj.bbox,
                            xref: obj.xref
                        }))
                    })
                });

                if (!res.ok) throw new Error('Preview fetch failed');
                const data = await res.json();
                
                if (isMounted && data.success && data.preview_b64) {
                    setPreviewImageUrl(data.preview_b64);
                }
            } catch (err) {
                console.error("Failed to fetch hidden layer preview:", err);
            } finally {
                if (isMounted) setIsPreviewLoading(false);
            }
        };

        // Small debounce to avoid spamming if user clicks rapidly
        const timeoutId = setTimeout(() => {
            fetchPreview();
        }, 300);

        return () => {
            isMounted = false;
            clearTimeout(timeoutId);
        };
    }, [hiddenObjectIds, hiddenOcgLayerIds, selectionFileId, originalPageNum, pdfObjectsVersion]);
    
    //#endregion

    //#region Drag & Interaction Events
    const displayWidth = actualWidth100 * zoom;
    // Native event listeners to bypass WebView2/React synthetic event limitations
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const handleDragEnter = (e: DragEvent) => {
            e.preventDefault();
            if (isVdpMode) {
                el.style.opacity = '0.8';
                e.dataTransfer!.dropEffect = 'copy';
            }
        };

        const handleDragOver = (e: DragEvent) => {
            e.preventDefault(); // MANDATORY for drop
            if (isVdpMode) {
                e.dataTransfer!.dropEffect = 'copy';
            }
        };

        const handleDragLeave = (e: DragEvent) => {
            el.style.opacity = '1';
        };

        const handleDrop = (e: DragEvent) => {
            el.style.opacity = '1';
            if (!isVdpMode) return;
            e.preventDefault();
            
            let vdpType = '';
            try {
                vdpType = e.dataTransfer!.getData('application/vdp-field');
            } catch(err) {}
            if (!vdpType) {
                try {
                    const payload = JSON.parse(e.dataTransfer!.getData('text/plain'));
                    if (payload && payload.source === 'vdp') {
                        vdpType = payload.type;
                    }
                } catch (err) {}
            }
            
            if (vdpType && pageDim) {
                const rect = el.getBoundingClientRect();
                const curX = e.clientX - rect.left;
                const curY = e.clientY - rect.top;
                
                const pageWidthPt = pageDim.w;
                const scale = displayWidth / pageWidthPt;
                
                const boxX = (curX / scale) / 72 * 25.4;
                const boxY = (curY / scale) / 72 * 25.4;
                
                // default sizes — theo loại field để khung khớp mẫu ngay khi thả
                const isSquare = vdpType === 'qrcode' || vdpType === 'image';
                let wMM = isSquare ? 25 : 50;
                let hMM = vdpType === 'qrcode' || vdpType === 'image' ? 25 : (vdpType === 'barcode' ? 15 : 10);
                // Không cho placeholder vượt quá ~90% kích thước trang (quan trọng với trang nhỏ như 15x15mm)
                // pageDim.w là px@96; field dùng đơn vị "CSS-mm" (mm × 96/72) nên dùng × 25.4 / 72.
                const pageWmm = pageDim.w * 25.4 / 72;
                const pageHmm = pageDim.h * 25.4 / 72;
                const maxW = pageWmm * 0.9;
                const maxH = pageHmm * 0.9;
                if (isSquare) {
                    const s = Math.max(5, Math.min(wMM, maxW, maxH));
                    wMM = s; hMM = s;
                } else {
                    wMM = Math.max(5, Math.min(wMM, maxW));
                    hMM = Math.max(5, Math.min(hMM, maxH));
                }
                // Canh để khung nằm gọn trong trang
                const placeX = Math.max(0, Math.min(boxX, pageWmm - wMM));
                const placeY = Math.max(0, Math.min(boxY, pageHmm - hMM));
                const textContent = vdpType === 'text' ? `{Truong_${vdpFields.length + 1}}` : undefined;
                const fieldName = `Truong_${vdpFields.length + 1}`;
                
                onVdpBoxCreate?.({ 
                    x: placeX, y: placeY, width: wMM, height: hMM, 
                    pageNum: originalPageNum, type: vdpType,
                    textContent: textContent || undefined,
                    name: fieldName || undefined
                } as any); 
            }
        };

        const handleVdpDrop = (e: CustomEvent) => {
            if (!isVdpMode) return;
            const targetEl = e.detail.target as HTMLElement;
            if (!el.contains(targetEl) && el !== targetEl) return;
            
            const vdpType = e.detail.type;
            if (vdpType && pageDim) {
                const rect = el.getBoundingClientRect();
                const curX = e.detail.clientX - rect.left;
                const curY = e.detail.clientY - rect.top;
                
                const pageWidthPt = pageDim.w;
                const scale = displayWidth / pageWidthPt;
                
                const boxX = (curX / scale) / 72 * 25.4;
                const boxY = (curY / scale) / 72 * 25.4;
                
                // default sizes — theo loại field để khung khớp mẫu ngay khi thả
                const isSquare = vdpType === 'qrcode' || vdpType === 'image';
                let wMM = isSquare ? 25 : 50;
                let hMM = vdpType === 'qrcode' || vdpType === 'image' ? 25 : (vdpType === 'barcode' ? 15 : 10);
                // Không cho placeholder vượt quá ~90% kích thước trang (quan trọng với trang nhỏ như 15x15mm)
                // pageDim.w là px@96; field dùng đơn vị "CSS-mm" (mm × 96/72) nên dùng × 25.4 / 72.
                const pageWmm = pageDim.w * 25.4 / 72;
                const pageHmm = pageDim.h * 25.4 / 72;
                const maxW = pageWmm * 0.9;
                const maxH = pageHmm * 0.9;
                if (isSquare) {
                    const s = Math.max(5, Math.min(wMM, maxW, maxH));
                    wMM = s; hMM = s;
                } else {
                    wMM = Math.max(5, Math.min(wMM, maxW));
                    hMM = Math.max(5, Math.min(hMM, maxH));
                }
                // Canh để khung nằm gọn trong trang
                const placeX = Math.max(0, Math.min(boxX, pageWmm - wMM));
                const placeY = Math.max(0, Math.min(boxY, pageHmm - hMM));
                const textContent = e.detail.textContent || (vdpType === 'text' ? `{Truong_${vdpFields.length + 1}}` : undefined);
                const fieldName = e.detail.name || `Truong_${vdpFields.length + 1}`;
                
                onVdpBoxCreate?.({ 
                    x: placeX, y: placeY, width: wMM, height: hMM, 
                    pageNum: originalPageNum, type: vdpType,
                    textContent: textContent || undefined,
                    name: fieldName || undefined
                } as any); 
            }
        };

        el.addEventListener('dragenter', handleDragEnter);
        el.addEventListener('dragover', handleDragOver);
        el.addEventListener('dragleave', handleDragLeave);
        el.addEventListener('drop', handleDrop);
        window.addEventListener('vdp-drop', handleVdpDrop as EventListener);

        return () => {
            el.removeEventListener('dragenter', handleDragEnter);
            el.removeEventListener('dragover', handleDragOver);
            el.removeEventListener('dragleave', handleDragLeave);
            el.removeEventListener('drop', handleDrop);
            window.removeEventListener('vdp-drop', handleVdpDrop as EventListener);
        };
    }, [isVdpMode, pageDim, displayWidth, onVdpBoxCreate, vdpFields.length, originalPageNum]);

    const displayHeight = pageDim && pageDim.w ? displayWidth * (pageDim.h / pageDim.w) : displayWidth * 1.414;
    const renderWidth = actualWidth100 * renderZoom;
    
    const isRotated = (rotation || 0) % 180 !== 0;
    const outerWidth = isRotated ? displayHeight : displayWidth;
    const outerHeight = isRotated ? displayWidth : displayHeight;

    const getUnrotatedCoords = (clientX: number, clientY: number, rect: DOMRect) => {
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const x = clientX - rect.left - cx;
        const y = clientY - rect.top - cy;
        
        const angle = -(rotation || 0) * Math.PI / 180;
        const unrotatedX = x * Math.cos(angle) - y * Math.sin(angle);
        const unrotatedY = x * Math.sin(angle) + y * Math.cos(angle);
        
        return { 
            x: unrotatedX + displayWidth / 2, 
            y: unrotatedY + displayHeight / 2 
        };
    };

    // ─── Edit PDF Object (task 10.2): hộp bao hợp nhất của object đang chọn ───
    // Trả về hộp bao (union) theo px canvas (gốc trên-trái) của các object được
    // chọn, dùng cho overlay transform + neo handle. `scale` = px/point.
    const getEditSelectionBoxPx = (scale: number): { left: number; top: number; width: number; height: number } | null => {
        const sel = editObjects.filter(o => editSelectedIds.includes(o.id));
        if (sel.length === 0) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const o of sel) {
            const [x0, y0, x1, y1] = o.bbox; // đã ở hệ top-left (point)
            minX = Math.min(minX, x0); minY = Math.min(minY, y0);
            maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
        }
        return { left: minX * scale, top: minY * scale, width: (maxX - minX) * scale, height: (maxY - minY) * scale };
    };

    // Bắt đầu một thao tác transform (move/resize/rotate) cho object đang chọn.
    // Khử xoay tọa độ chuột để nhất quán với overlay; xóa preview cũ + transform tạm.
    const beginEditInteraction = (e: React.PointerEvent, type: EditInteraction['type'], handle?: EditHandle) => {
        if (!containerRef.current || !pageDim?.w) return;
        const rect = containerRef.current.getBoundingClientRect();
        // editScale = px màn / POINT (bbox edit ở point). = (displayWidth/px@96) × 96/72.
        const editScale = displayWidth / ((pageDim.w || 595) * 72 / 96);
        const startBox = getEditSelectionBoxPx(editScale);
        if (!startBox) return;
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        // Bắt đầu thao tác mới → hủy ghost-hold/timeout của lần commit trước (nếu có).
        editGhostHoldRef.current = false;
        if (editGhostHideTimerRef.current) {
            clearTimeout(editGhostHideTimerRef.current);
            editGhostHideTimerRef.current = null;
        }
        // Reset transform tạm + ghost về identity rồi hiện ghost (cập nhật style trực
        // tiếp trong handleMouseMove). KHÔNG setState để không re-render lúc bắt đầu kéo.
        editLiveTransformRef.current = null;
        if (editGhostRef.current) {
            editGhostRef.current.style.transform = 'none';
            editGhostRef.current.style.transformOrigin = 'center center';
            editGhostRef.current.style.display = 'block';
        }
        setEditInteraction({ type, handle, startX: coords.x, startY: coords.y, startBox });
        try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };

    // Khi MOUSE UP: dựng EditOp từ transform tạm rồi gửi /edit/transform (1 lần).
    // Đây là ĐIỂM DUY NHẤT gọi backend (KHÔNG gọi khi đang kéo — Yêu cầu 13.2).
    //
    // CHUYỂN TRỤC tọa độ (canvas top-left, y xuống ↔ PDF bottom-left, y lên):
    //  - move : /edit/transform → move_objects mặc định coord_space='pdf', nên FE
    //           phải gửi delta ở hệ PDF: dx giữ nguyên, dy_pdf = -dy_canvas.
    //  - resize: anchor = góc đối diện handle kéo; nhãn nw/ne/sw/se theo VỊ TRÍ NHÌN
    //           THẤY trùng ngữ nghĩa _anchor_point backend ('n'=mép trên) nên gửi thẳng.
    //  - rotate: rotateDeg backend dương = NGƯỢC chiều kim đồng hồ (hệ PDF y lên);
    //           góc đo trên màn (y xuống) dương theo chiều kim đồng hồ → đảo dấu.
    const commitEditTransform = async (lt: EditLiveTransform | null) => {
        if (!lt || !selectionFileId || !pageDim?.w || editSelectedIds.length === 0) {
            return;
        }
        const scale = displayWidth / ((pageDim.w || 595) * 72 / 96); // px canvas / POINT
        const page = originalPageNum - 1;       // /edit dùng 0-based
        let op: EditOp | null = null;

        if (lt.kind === 'move') {
            if (Math.abs(lt.dx) < 0.5 && Math.abs(lt.dy) < 0.5) { return; }
            const dxPt = lt.dx / scale;
            const dyPtCanvas = lt.dy / scale;
            op = { page, kind: 'move', targetIds: editSelectedIds, delta: { dx: dxPt, dy: -dyPtCanvas } };
        } else if (lt.kind === 'resize') {
            if (Math.abs(lt.sx - 1) < 0.002 && Math.abs(lt.sy - 1) < 0.002) { return; }
            op = { page, kind: 'resize', targetIds: editSelectedIds, scale: { sx: lt.sx, sy: lt.sy, anchor: lt.anchor } };
        } else {
            if (Math.abs(lt.rotateDeg) < 0.5) { return; }
            op = { page, kind: 'rotate', targetIds: editSelectedIds, rotateDeg: -lt.rotateDeg };
        }

        setEditBusy(true);
        try {
            const headers = { 'Content-Type': 'application/json' };
            const tRes = await authenticatedFetch(`${getApiUrl()}/edit/transform`, {
                method: 'POST', headers, body: JSON.stringify({ fid: selectionFileId, op }),
            });
            if (!tRes.ok) {
                const detail = await tRes.text().catch(() => '');
                throw new Error(`/edit/transform HTTP ${tRes.status} ${detail}`);
            }
            // EditResponse{output_url, output_filename}: Working_File MỚI (pikepdf, color-safe).
            const tData = await tRes.json().catch(() => null);
            // task 11.1: đẩy Working_File mới vào history → Undo/Redo (Yêu cầu 11.1–11.3).
            // Trang re-render từ Working_File mới (commitWorkingFile đổi pdfUrl → tile mới)
            // nên KHÔNG cần gọi /edit/preview (render PDFium toàn trang) — bỏ để giảm tải.
            if (tData?.success && tData.output_url && onEditCommit) {
                await onEditCommit(tData.output_url, tData.output_filename, tData.output_fid, tData.output_path);
            }
        } catch (err) {
            console.warn('[edit] transform thất bại:', err);
            hideEditGhost(); // Commit lỗi → bỏ ghost giữ (tránh kẹt ở vị trí thả).
        } finally {
            setEditBusy(false);
        }
    };

    // ─── Edit PDF Object (task 10.3): gửi EditOp ──────────────────────────────
    // Helper dùng chung cho editText/add: POST tới `endpoint` rồi onEditCommit.
    // KHÔNG gọi /edit/preview (render PDFium toàn trang) — trang sẽ re-render từ
    // Working_File mới (pdfUrl đổi → tile mới) nên preview là THỪA. TÁI DÙNG đúng
    // cơ chế authenticatedFetch/getApiUrl của commitEditTransform.
    const sendEditAndPreview = async (op: EditOp, endpoint: string) => {
        if (!selectionFileId) return;
        setEditBusy(true);
        try {
            const headers = { 'Content-Type': 'application/json' };
            const tRes = await authenticatedFetch(endpoint, {
                method: 'POST', headers, body: JSON.stringify({ fid: selectionFileId, op }),
            });
            if (!tRes.ok) {
                const detail = await tRes.text().catch(() => '');
                throw new Error(`${endpoint} HTTP ${tRes.status} ${detail}`);
            }
            // EditResponse{output_url, output_filename}: Working_File MỚI (pikepdf, color-safe).
            const tData = await tRes.json().catch(() => null);
            // task 11.1: đẩy Working_File mới vào history → Undo/Redo (Yêu cầu 11.1–11.3).
            if (tData?.success && tData.output_url && onEditCommit) {
                await onEditCommit(tData.output_url, tData.output_filename, tData.output_fid, tData.output_path);
            }
        } catch (err) {
            console.warn('[edit] thao tác thất bại:', err);
        } finally {
            setEditBusy(false);
        }
    };

    // Sửa nội dung một cụm text CÓ SẴN (double-click → editor inline). editText KHÔNG
    // cần bbox: backend resolve vị trí/font/cỡ từ object mục tiêu qua Geometry_Reader.
    const commitEditObjectText = async (objId: string, content: string) => {
        if (!selectionFileId || !pageDim?.w || !content.trim()) return;
        const op: EditOp = {
            page: originalPageNum - 1, kind: 'editText',
            targetIds: [objId],
            // font = đường dẫn file font người dùng chọn (nếu có) → backend nhúng font đó.
            text: { content, font: editFontPath },
        };
        await sendEditAndPreview(op, `${getApiUrl()}/edit/text`);
    };

    // Thêm cụm text MỚI tại điểm bấm. CONVERT TỌA ĐỘ: draft.{xPt,yPt} ở hệ canvas
    // top-left (point); backend add_text dùng hệ PDF bottom-left → yPDF = pageH - yCanvas.
    // bbox = [x0, pageH - yBottomCanvas, x1, pageH - yTopCanvas].
    const commitAddTextObject = async (content: string, draft: { xPt: number; yPt: number }) => {
        if (!selectionFileId || !pageDim?.w || !pageDim?.h || !content.trim()) return;
        const pageH = pageDim.h * 72 / 96; // px@96 → POINT (draft.{xPt,yPt} đã ở point)
        const hPt = EDIT_ADD_TEXT_SIZE_PT * 1.6;
        const x0 = draft.xPt, x1 = draft.xPt + EDIT_ADD_TEXT_W_PT;
        const yTopCanvas = draft.yPt, yBottomCanvas = draft.yPt + hPt;
        const bbox: BBox = [x0, pageH - yBottomCanvas, x1, pageH - yTopCanvas];
        const op: EditOp = {
            page: originalPageNum - 1, kind: 'add',
            targetIds: [], text: { content, sizePt: EDIT_ADD_TEXT_SIZE_PT, bbox, font: editFontPath },
        };
        await sendEditAndPreview(op, `${getApiUrl()}/edit/add`);
    };

    // Thêm ảnh MỚI tại điểm bấm (dataUrl base64). CONVERT TỌA ĐỘ giống add-text:
    // bbox vuông EDIT_ADD_IMAGE_SIZE_PT ở hệ PDF bottom-left (yPDF = pageH - yCanvas).
    const commitAddImageObject = async (dataUrl: string, draft: { xPt: number; yPt: number }) => {
        if (!selectionFileId || !pageDim?.w || !pageDim?.h || !dataUrl) return;
        const pageH = pageDim.h * 72 / 96; // px@96 → POINT (draft.{xPt,yPt} đã ở point)
        const sz = EDIT_ADD_IMAGE_SIZE_PT;
        const x0 = draft.xPt, x1 = draft.xPt + sz;
        const yTopCanvas = draft.yPt, yBottomCanvas = draft.yPt + sz;
        const bbox: BBox = [x0, pageH - yBottomCanvas, x1, pageH - yTopCanvas];
        const op: EditOp = {
            page: originalPageNum - 1, kind: 'add',
            targetIds: [], image: { dataRef: dataUrl, bbox },
        };
        await sendEditAndPreview(op, `${getApiUrl()}/edit/add`);
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        if ((!isSelectionMode && !isObjectEditMode && !isVdpMode) || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        dragRef.current = { startX: coords.x, startY: coords.y, active: true };
        if (marqueeRef.current) {
            marqueeRef.current.style.display = 'block';
            marqueeRef.current.style.left = `${coords.x}px`;
            marqueeRef.current.style.top = `${coords.y}px`;
            marqueeRef.current.style.width = '0px';
            marqueeRef.current.style.height = '0px';
        }
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        const curX = coords.x;
        const curY = coords.y;

        // Dispatch hover event for OutputPreview (throttled to ~20fps to avoid React spam)
        if (setHoveredPdfPosition) {
            const now = Date.now();
            if (!dragRef.current.lastHoverTime || now - dragRef.current.lastHoverTime > 50) {
                dragRef.current.lastHoverTime = now;
                setHoveredPdfPosition({ pageNum: originalPageNum, x: curX / rect.width, y: curY / rect.height });
            }
        }

        // ─── Edit PDF Object (task 10.2): cập nhật ghost transform theo THỜI GIAN
        // THỰC qua DOM ref — KHÔNG setState (tránh re-render toàn bộ LivePageFrame →
        // mượt). Lưu transform vào editLiveTransformRef để mouseup commit. KHÔNG gọi
        // backend khi đang kéo (Yêu cầu 13.2).
        if (editInteraction) {
            const dxPx = curX - editInteraction.startX;
            const dyPx = curY - editInteraction.startY;
            const box = editInteraction.startBox;
            const ghost = editGhostRef.current;
            if (editInteraction.type === 'move') {
                editLiveTransformRef.current = { kind: 'move', dx: dxPx, dy: dyPx };
                if (ghost) {
                    ghost.style.transformOrigin = 'center center';
                    ghost.style.transform = `translate(${dxPx}px, ${dyPx}px)`;
                    ghost.style.display = 'block';
                }
            } else if (editInteraction.type === 'resize') {
                const handle = editInteraction.handle || 'se';
                let newW = box.width, newH = box.height;
                if (handle.includes('e')) newW = box.width + dxPx;
                if (handle.includes('w')) newW = box.width - dxPx;
                if (handle.includes('s')) newH = box.height + dyPx;
                if (handle.includes('n')) newH = box.height - dyPx;
                // Chặn lật/âm: giữ kích thước tối thiểu để sx/sy > 0 (Yêu cầu 6.5).
                newW = Math.max(2, newW);
                newH = Math.max(2, newH);
                const sx = newW / box.width;
                const sy = newH / box.height;
                const anchor = EDIT_OPPOSITE_ANCHOR[handle];
                editLiveTransformRef.current = { kind: 'resize', sx, sy, anchor };
                if (ghost) {
                    ghost.style.transformOrigin = EDIT_ANCHOR_ORIGIN[anchor];
                    ghost.style.transform = `scale(${sx}, ${sy})`;
                    ghost.style.display = 'block';
                }
            } else if (editInteraction.type === 'rotate') {
                const cx = box.left + box.width / 2;
                const cy = box.top + box.height / 2;
                // Vector ban đầu (handle xoay) hướng thẳng LÊN: atan2(-1, 0) = -90°.
                const initAng = Math.atan2(-1, 0);
                const curAng = Math.atan2(curY - cy, curX - cx);
                let deg = (curAng - initAng) * 180 / Math.PI;
                // Giữ Shift → "bắt" góc về bội số 45° (0/45/90/135/180...) cho xoay chuẩn.
                if (e.shiftKey) deg = Math.round(deg / 45) * 45;
                editLiveTransformRef.current = { kind: 'rotate', rotateDeg: deg };
                if (ghost) {
                    ghost.style.transformOrigin = 'center center';
                    ghost.style.transform = `rotate(${deg}deg)`;
                    ghost.style.display = 'block';
                }
            }
            return;
        }

        if (vdpInteraction && onVdpFieldsChange && pageDim) {
            const dx = curX - vdpInteraction.startX;
            const dy = curY - vdpInteraction.startY;
            
            const pageWidthPt = pageDim.w;
            const scale = displayWidth / pageWidthPt;
            
            // Convert pixel delta to mm delta
            const dxMM = (dx / scale) / 72 * 25.4;
            const dyMM = (dy / scale) / 72 * 25.4;
            
            onVdpFieldsChange((prev: any[]) => prev.map(f => {
                if (!vdpInteraction.fieldIds.includes(f.id)) return f;
                const startData = vdpInteraction.startFields[f.id];
                if (!startData) return f;
                
                if (vdpInteraction.type === 'move') {
                    return { ...f, x: startData.x + dxMM, y: startData.y + dyMM };
                } else if (vdpInteraction.type === 'resize') {
                    // Resize theo góc đang kéo (nw/ne/sw/se), giữ cạnh đối diện cố định.
                    const handle = vdpInteraction.handle || 'se';
                    let newX = startData.x, newY = startData.y;
                    let newW = startData.w, newH = startData.h;
                    if (handle.includes('e')) newW = startData.w + dxMM;
                    if (handle.includes('w')) newW = startData.w - dxMM;
                    if (handle.includes('s')) newH = startData.h + dyMM;
                    if (handle.includes('n')) newH = startData.h - dyMM;
                    newW = Math.max(5, newW);
                    newH = Math.max(5, newH);
                    if (f.type === 'qrcode') {
                        const size = Math.max(newW, newH);
                        newW = size;
                        newH = size;
                    }
                    // Khi kéo từ cạnh trái/trên, dời gốc để cạnh phải/dưới đứng yên.
                    if (handle.includes('w')) newX = startData.x + (startData.w - newW);
                    if (handle.includes('n')) newY = startData.y + (startData.h - newH);
                    return { ...f, x: newX, y: newY, width: newW, height: newH };
                }
                return f;
            }));
            return;
        }

        if (!dragRef.current.active || (!isSelectionMode && !isObjectEditMode)) return;
        const { startX, startY } = dragRef.current;
        // Direct DOM update â€” no React re-render
        if (marqueeRef.current) {
            marqueeRef.current.style.left = `${Math.min(startX, curX)}px`;
            marqueeRef.current.style.top = `${Math.min(startY, curY)}px`;
            marqueeRef.current.style.width = `${Math.abs(curX - startX)}px`;
            marqueeRef.current.style.height = `${Math.abs(curY - startY)}px`;
        }
    };

    const handleMouseUp = (e: React.MouseEvent) => {
        // ─── Edit PDF Object (task 10.2): kết thúc thao tác → gửi backend 1 lần ──
        if (editInteraction) {
            setEditInteraction(null);
            const lt = editLiveTransformRef.current;
            // GIỮ ghost ở vị trí vừa thả (không ẩn ngay) → tránh "giật về chỗ cũ".
            // Ghost sẽ ẩn khi overlay nạp vị trí mới (effect /edit/objects) hoặc
            // timeout an toàn dưới đây (phòng commit lỗi/không refetch).
            if (lt) {
                editGhostHoldRef.current = true;
                if (editGhostHideTimerRef.current) clearTimeout(editGhostHideTimerRef.current);
                editGhostHideTimerRef.current = setTimeout(() => hideEditGhost(), 4000);
            } else {
                hideEditGhost();
            }
            editLiveTransformRef.current = null;
            void commitEditTransform(lt);
            return;
        }
        if (vdpInteraction) {
            setVdpInteraction(null);
            return;
        }
        if (!dragRef.current.active || (!isSelectionMode && !isObjectEditMode && !isVdpMode) || !containerRef.current) {
            dragRef.current.active = false;
            if (marqueeRef.current) marqueeRef.current.style.display = 'none';
            return;
        }
        
        const rect = containerRef.current.getBoundingClientRect();
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        const curX = coords.x;
        const curY = coords.y;
        const { startX, startY } = dragRef.current;
        
        dragRef.current.active = false;
        if (marqueeRef.current) marqueeRef.current.style.display = 'none';
        
        // Calculate selection rectangle
        const x1 = Math.min(startX, curX);
        const y1 = Math.min(startY, curY);
        const x2 = Math.max(startX, curX);
        const y2 = Math.max(startY, curY);
        
        // Tiny click = click on empty space => deselect all
        if (x2 - x1 < 5 && y2 - y1 < 5) {
            // Edit PDF Object: bấm vào vùng trống → bỏ chọn (việc chọn object do overlay
            // div xử lý ở onClick — ưu tiên bbox nhỏ nhất nhờ thứ tự xếp chồng DOM).
            if (isObjectEditMode) {
                // task 10.3: nếu đang ở chế độ "đặt object mới" → đặt tại điểm bấm.
                // CONVERT px canvas → point (hệ canvas top-left): pt = px / scale.
                if (editAddMode && !isVdpMode && pageDim?.w) {
                    // editScale = px màn / POINT → draft ra ĐÚNG point cho /edit/add.
                    const editScale = displayWidth / ((pageDim.w || 595) * 72 / 96);
                    const draft = { xPt: curX / editScale, yPt: curY / editScale };
                    if (editAddMode === 'text') {
                        // Mở editor text inline tại điểm bấm → gõ nội dung → commit /edit/add.
                        setEditAddDraft(draft);
                        setEditTextContent('');
                        setEditingTextId(EDIT_ADD_TEXT_ID);
                    } else {
                        // Ảnh: chốt vị trí rồi mở file picker; onChange sẽ gửi /edit/add.
                        setEditAddDraft(draft);
                        editFileInputRef.current?.click();
                    }
                    setEditAddMode(null);
                    return;
                }
                setEditSelectedIds([]); return;
            }
            if (isSelectionMode) onObjectSelect?.([]);
            if (isVdpMode) {
                setSelectedVdpFieldIds([]);
                onVdpBoxSelect?.([]);
            }
            return;
        }

        // ─── Edit PDF Object: marquee chọn object từ /edit/objects (task 10.1) ───
        if (isObjectEditMode && !isVdpMode) {
            const pageWidthPt = pageDim?.w || 595;
            // bbox edit ở POINT → dùng editScale (px màn / point), KHÔNG dùng scale chung.
            const editScale = displayWidth / (pageWidthPt * 72 / 96);
            const picked = [...editSelectedIds];
            editObjects.forEach((obj) => {
                const [ox0, oy0, ox1, oy1] = obj.bbox;
                const left = ox0 * editScale, top = oy0 * editScale;
                const right = ox1 * editScale, bottom = oy1 * editScale;
                if (left < x2 && right > x1 && top < y2 && bottom > y1 && !picked.includes(obj.id)) {
                    picked.push(obj.id);
                }
            });
            setEditSelectedIds(picked);
            return;
        }

        if (isSelectionMode) {
            if (isVdpMode) {
                // Select VDP fields instead of PDF objects
                const pageWidthPt = pageDim?.w || 595;
                const scale = displayWidth / pageWidthPt;
                const newlySelectedIds = [...selectedVdpFieldIds];
                vdpFields.forEach((field: any) => {
                    if (field.pageNum !== originalPageNum) return;
                    const left = (field.x / 25.4 * 72) * scale;
                    const top = (field.y / 25.4 * 72) * scale;
                    const right = left + (field.width / 25.4 * 72) * scale;
                    const bottom = top + (field.height / 25.4 * 72) * scale;
                    
                    if (left < x2 && right > x1 && top < y2 && bottom > y1 && !newlySelectedIds.includes(field.id)) {
                        newlySelectedIds.push(field.id);
                    }
                });
                setSelectedVdpFieldIds(newlySelectedIds);
                onVdpBoxSelect?.(newlySelectedIds);
            } else {
                const pageWidthPt = pageDim?.w || 595;
                const scale = displayWidth / pageWidthPt;

                const currentObjects = globalPdfObjectCache.getPageObjects(pdfUrl || '', originalPageNum);

                const newlySelectedIds = [...selectedObjectIds];

                currentObjects.forEach((obj: any) => {
                    const [ox0, oy0, ox1, oy1] = obj.bbox;
                    const left = ox0 * scale;
                    const top = oy0 * scale;
                    const right = ox1 * scale;
                    const bottom = oy1 * scale;
                    
                    if (left < x2 && right > x1 && top < y2 && bottom > y1 && !newlySelectedIds.includes(obj.id)) {
                        newlySelectedIds.push(obj.id);
                    }
                });
                
                onObjectSelect?.(newlySelectedIds);
            }
        }
    };

    const handleMouseLeave = () => {
        dragRef.current.active = false;
        setVdpInteraction(null);
        // Edit PDF Object (10.2): rời khung khi đang kéo → HỦY thao tác (chưa gọi
        // backend), bỏ transform tạm để overlay không kẹt trạng thái dở dang.
        if (editInteraction) {
            setEditInteraction(null);
            editLiveTransformRef.current = null;
            if (editGhostRef.current) {
                editGhostRef.current.style.display = 'none';
                editGhostRef.current.style.transform = 'none';
            }
        }
        if (marqueeRef.current) marqueeRef.current.style.display = 'none';
    };
    //#endregion

    //#region Render
    return (
        <>
        {/* Inject dynamic fonts for VDP */}
        {isVdpMode && (window as any).__TAURI_INTERNALS__ && vdpFields?.map((field: any, idx: number) => 
            field.fontFile && field.fontName ? (
                <style key={`vdp-font-${field.id || idx}`}>{`
                    @font-face {
                        font-family: "${field.fontName}_local";
                        src: url("${convertFileSrc(field.fontFile)}");
                    }
                `}</style>
            ) : null
        )}
        <div className="relative shrink-0" style={{ width: outerWidth }}>
        <div 
            ref={containerRef}
            className="bg-white shadow-[0_4px_30px_rgba(0,0,0,0.15)] ring-1 ring-black/5 relative shrink-0 overflow-hidden group/pdf-frame" 
            style={{ width: outerWidth, height: outerHeight }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
        >
            <div style={{
                position: 'absolute',
                width: displayWidth,
                height: displayHeight,
                left: '50%',
                top: '50%',
                transform: `translate(-50%, -50%) rotate(${rotation || 0}deg)`,
                transformOrigin: 'center center'
            }}>
            {isBlankDoc ? (
                /* Trang trắng mới tạo: kích thước đã biết, không cần render qua engine nào — hiện nền trắng tức thì */
                <div style={{ width: displayWidth, height: displayHeight, background: 'white' }} />
            ) : getTileUrl ? (() => {
                // 1 TILE phủ cả trang, render ĐÚNG 1 LẦN/scale (KHÔNG chia lưới: pdfium
                // render cả trang dù cắt ô → chia lưới chỉ nhân chi phí ×N). renderZoom đã
                // được lượng tử hoá nên zoom qua lại tái dùng ảnh cache, đỡ render lại.
                const S = renderZoom;
                return (
                    <div style={{ width: displayWidth, height: displayHeight, position: 'relative' }}>
                        {/* Loading Skeleton */}
                        <div className="absolute inset-0 flex items-center justify-center bg-slate-50/50 z-0">
                            <div className="flex flex-col items-center opacity-50">
                                <div className="w-8 h-8 border-4 border-slate-300 border-t-slate-500 rounded-full animate-spin mb-2" />
                                <span className="text-xs font-semibold text-slate-500 tracking-wider">RENDERING</span>
                            </div>
                        </div>
                        <div className="absolute inset-0 z-10">
                            <LiveTile fileKey={pdfUrl || 'unknown'} key="full" pageNum={originalPageNum} zoom={S} rot={0} clipX={0} clipY={0} clipW={0} clipH={0} cssW={Math.ceil(displayWidth)} cssH={Math.ceil(displayHeight)} getTileUrl={getTileUrl} onVisible={handleTileVisibility} />
                        </div>
                    </div>
                );
            })() : (
                <Page
                    className="gpu-zoom-page block max-w-none origin-top-left"
                    pageNumber={originalPageNum}
                    width={renderWidth}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                />
            )}

             {/* Invisible Text Layer for native mode */}
            {getTileUrl && textBlocks && (
                <div className="absolute inset-0 z-[2] select-text" style={{ pointerEvents: isVdpMode ? 'none' : 'auto' }}>
                    {(Array.isArray(textBlocks) ? textBlocks : (textBlocks.blocks || [])).map((block: any, bi: number) => 
                         block.lines?.map((line: any, li: number) => {
                             const pageWidthPt = pageDim?.w || 595;
                             const scale = displayWidth / pageWidthPt;
                             return (
                                 <span
                                     key={`${bi}_${li}`}
                                     style={{
                                         position: 'absolute',
                                         left: line.bbox.x * scale,
                                         top: line.bbox.y * scale,
                                         width: (line.bbox.w) * scale,
                                         height: (line.bbox.h) * scale,
                                         fontSize: `${(line.bbox.h) * scale * 0.85}px`,
                                         lineHeight: '1',
                                         color: 'transparent',
                                         whiteSpace: 'pre',
                                         overflow: 'hidden',
                                     }}
                                 >
                                     {line.chars?.map((c: any) => c.c).join('') || ''}
                                 </span>
                             );
                         })
                     )}
                 </div>
             )}
             
             {/* Output Preview: Separation plate overlays rendered on the PDF page */}
             {separationPlates.length > 0 && (
                 <div className="absolute inset-0 z-[14] bg-white pointer-events-none">
                     {separationPlates.map((plate: any) => plate.visible ? (
                         <img 
                             key={plate.name}
                             src={plate.dataUrl}
                             alt={plate.name}
                             className="absolute inset-0 w-full h-full mix-blend-multiply"
                             style={{ objectFit: 'fill' }}
                         />
                     ) : null)}
                 </div>
             )}

             {/* ICC Soft-Proof Overlay — simulates print output */}
             {softProofImageUrl && (
                 <img 
                     src={softProofImageUrl}
                     alt="Soft-Proof"
                     className="absolute inset-0 z-[16] pointer-events-none"
                     style={{ width: '100%', height: '100%', objectFit: 'fill' }}
                 />
             )}

             {/* Gamut Warning Overlay — highlights out-of-gamut pixels */}
             {gamutWarningUrl && (
                 <img 
                     src={gamutWarningUrl}
                     alt="Gamut Warning"
                     className="absolute inset-0 z-[17] pointer-events-none"
                     style={{ width: '100%', height: '100%', objectFit: 'fill' }}
                 />
             )}

             {/* TAC Heatmap Overlay — highlights areas exceeding total ink coverage threshold */}
             {tacHeatmapUrl && (
                 <img 
                     src={tacHeatmapUrl}
                     alt="TAC Heatmap"
                     className="absolute inset-0 z-[18] pointer-events-none"
                     style={{ width: '100%', height: '100%', objectFit: 'fill' }}
                 />
             )}

             {/* Overprint Preview Overlay — simulates overprint rendering */}
             {overprintPreviewUrl && (
                 <img 
                     src={overprintPreviewUrl}
                     alt="Overprint Preview"
                     className="absolute inset-0 z-[19] pointer-events-none"
                     style={{ width: '100%', height: '100%', objectFit: 'fill' }}
                 />
             )}
             
             {/* Hidden Layers Preview Overlay â€” covers page exactly like Illustrator layer toggle */}
             {previewImageUrl && (
                 <img 
                     src={previewImageUrl} 
                     alt=""
                     className="absolute top-0 left-0 z-[15] pointer-events-none"
                     style={{ width: '100%', height: '100%', objectFit: 'fill' }}
                 />
             )}
             
             {(isPreviewLoading || editBusy) && (
                 <div className="absolute top-1.5 left-1.5 z-50 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded-sm backdrop-blur-md flex items-center gap-1.5">
                     <div className="w-2.5 h-2.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                     Preview...
                 </div>
             )}
             {bleedView?.show && (
                 <div 
                     className="absolute inset-0 pointer-events-none z-[60]" 
                     style={{ 
                         borderWidth: `${bleedView.mm * (96 / 25.4) * zoom}px`,
                         borderColor: 'rgba(239, 68, 68, 0.4)',
                         borderStyle: 'solid',
                         boxSizing: 'border-box'
                     }}
                 />
             )}
             
             {highlightBoxes && highlightBoxes.map((box: any, idx: number) => {
                 if (!pageDim) return null;
                 
                 // If no bbox, it's a page-level issue (like Transparency or Overprint)
                 if (!box.bbox || box.bbox.length !== 4) {
                     return (
                         <div 
                            key={`page-${idx}`}
                            className="absolute inset-0 z-[70] border-[6px] border-amber-500 bg-amber-500/10 shadow-[inset_0_0_30px_rgba(245,158,11,0.5)] animate-pulse pointer-events-none"
                         />
                     );
                 }

                 // Helper to render a single box
                 const renderBox = (bbox: number[], boxIdx: string | number) => {
                     const [x0, y0, x1, y1] = bbox;
                     const pageWidthPt = pageDim.w;
                     const pageHeightPt = pageDim.h;
                     
                     const left = (x0 / pageWidthPt) * 100;
                     const top = (y0 / pageHeightPt) * 100;
                     const width = ((x1 - x0) / pageWidthPt) * 100;
                     const height = ((y1 - y0) / pageHeightPt) * 100;
                     
                     return (
                         <div 
                             key={`box-${idx}-${boxIdx}`}
                             className="absolute z-[70] border-2 border-red-500 bg-red-500/10 shadow-[0_0_15px_rgba(239,68,68,0.5)] animate-pulse pointer-events-none"
                             style={{
                                 left: `${left}%`,
                                 top: `${top}%`,
                                 width: `${width}%`,
                                 height: `${height}%`,
                             }}
                         />
                     );
                 };

                 // Render multiple boxes if available
                 if (box.bboxes && box.bboxes.length > 0) {
                     return box.bboxes.map((b: number[], bIdx: number) => renderBox(b, bIdx));
                 }
                 
                 // Fallback to single box
                 return renderBox(box.bbox, 'single');
             })}

             {/* Selection Tool Overlay */}
             {isSelectionMode && pdfObjectsVersion !== undefined && pageDim && (() => {
                 const currentObjects = globalPdfObjectCache.getPageObjects(pdfUrl || '', originalPageNum);
                 if (!currentObjects || currentObjects.length === 0) return null;
                 const pageWidthPt = pageDim.w;
                 const scale = displayWidth / pageWidthPt;
                 return (
                     <>
                             {[...currentObjects].sort((a: any, b: any) => {
                                 const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
                                 const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
                                 return areaB - areaA; // Largest first (bottom), smallest last (top)
                             }).map((obj: any) => {
                                 const [x0, y0, x1, y1] = obj.bbox;
                                 const isSelected = selectedObjectIds.includes(obj.id);
                                 const isHidden = hiddenObjectIds.includes(obj.id);
                                 const typeColor = obj.type === 'text' ? 'rgb(59,130,246)' : obj.type === 'image' ? 'rgb(168,85,247)' : 'rgb(234,179,8)';
                             return (
                                 <div
                                     key={obj.id}
                                     className={`absolute pointer-events-auto cursor-pointer z-30 transition-colors hover:bg-slate-400/20 hover:border-slate-400 border border-transparent ${isHidden ? 'opacity-30' : ''}`}
                                     style={{ 
                                         left: x0 * scale, top: y0 * scale, 
                                         width: (x1 - x0) * scale, height: (y1 - y0) * scale,
                                         border: isHidden ? `2px dashed rgba(239,68,68,0.6)` : isSelected ? `2px solid ${typeColor}` : undefined,
                                         backgroundColor: isHidden ? 'rgba(239,68,68,0.08)' : isSelected ? `${typeColor}20` : undefined,
                                         boxShadow: isSelected ? `0 0 0 1px ${typeColor}40` : 'none',
                                     }}
                                     title={`${obj.type.toUpperCase()}: ${obj.content || obj.id}`}
                                     onMouseEnter={(e) => {
                                         if (!isSelected && !isHidden) {
                                             (e.currentTarget as HTMLDivElement).style.border = `1.5px solid ${typeColor}`;
                                             (e.currentTarget as HTMLDivElement).style.backgroundColor = `${typeColor}08`;
                                         }
                                     }}
                                     onMouseLeave={(e) => {
                                         if (!isSelected && !isHidden) {
                                             (e.currentTarget as HTMLDivElement).style.border = '1px solid transparent';
                                             (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent';
                                         }
                                     }}
                                     onClick={(e) => {
                                         e.stopPropagation();
                                         if (e.shiftKey) {
                                             onObjectSelect?.(isSelected ? selectedObjectIds.filter((id: string) => id !== obj.id) : [...selectedObjectIds, obj.id]);
                                         } else {
                                             onObjectSelect?.(isSelected && selectedObjectIds.length === 1 ? [] : [obj.id]);
                                         }
                                     }}
                                 />
                             );
                         })}
                     </>
                 );
             })()}

             {/* ─── Edit PDF Object — Selection Overlay (task 10.1) ───────────────
                 Nguồn object: GET /edit/objects (PDFium read-only). Bbox đã convert sang
                 hệ canvas top-left (point) ở effect nạp dữ liệu. Sắp xếp diện tích LỚN→NHỎ
                 để object nhỏ nằm trên cùng → click ưu tiên bbox nhỏ nhất (Yêu cầu 2.1, 2.2).
                 Ctrl+A/Esc xử lý ở keydown effect; overlay vẽ viền quanh object được chọn (2.5). */}
             {isObjectEditMode && pageDim && (() => {
                 // scale = px màn / POINT (bbox edit + editAddDraft.{xPt,yPt} đều ở point).
                 const scale = displayWidth / ((pageDim.w || 595) * 72 / 96);
                 return (
                     <>
                         {[...editObjects].sort((a, b) => {
                             const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
                             const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
                             return areaB - areaA; // lớn nhất trước (dưới cùng), nhỏ nhất sau (trên cùng)
                         }).map((obj) => {
                             const [x0, y0, x1, y1] = obj.bbox;
                             const isSelected = editSelectedIds.includes(obj.id);
                             const typeColor = obj.type === 'text' ? 'rgb(59,130,246)' : obj.type === 'image' ? 'rgb(168,85,247)' : 'rgb(234,179,8)';
                             return (
                                 <div
                                     key={obj.id}
                                     className="absolute pointer-events-auto cursor-pointer z-30 transition-colors border border-transparent"
                                     style={{
                                         left: x0 * scale, top: y0 * scale,
                                         width: (x1 - x0) * scale, height: (y1 - y0) * scale,
                                         border: isSelected ? `2px solid ${typeColor}` : undefined,
                                         backgroundColor: isSelected ? `${typeColor}20` : undefined,
                                         boxShadow: isSelected ? `0 0 0 1px ${typeColor}40` : 'none',
                                     }}
                                     title={`${obj.type.toUpperCase()}: ${obj.id}`}
                                     onMouseEnter={(e) => {
                                         if (!isSelected) {
                                             (e.currentTarget as HTMLDivElement).style.border = `1.5px solid ${typeColor}`;
                                             (e.currentTarget as HTMLDivElement).style.backgroundColor = `${typeColor}08`;
                                         }
                                     }}
                                     onMouseLeave={(e) => {
                                         if (!isSelected) {
                                             (e.currentTarget as HTMLDivElement).style.border = '1px solid transparent';
                                             (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent';
                                         }
                                     }}
                                     onClick={(e) => {
                                         e.stopPropagation();
                                         if (e.shiftKey) {
                                             setEditSelectedIds(prev => prev.includes(obj.id) ? prev.filter(id => id !== obj.id) : [...prev, obj.id]);
                                         } else {
                                             setEditSelectedIds(prev => (prev.length === 1 && prev[0] === obj.id) ? [] : [obj.id]);
                                         }
                                     }}
                                     onDoubleClick={(e) => {
                                         // task 10.3: double-click object TEXT → mở editor inline.
                                         // Chỉ kích hoạt ở chế độ edit-object (KHÔNG VDP) để TÁI DÙNG
                                         // editingTextId/editTextContent mà không xung đột field VDP.
                                         if (obj.type === 'text' && !isVdpMode) {
                                             e.stopPropagation();
                                             setEditingTextId(obj.id);
                                             setEditTextContent(obj.content || '');
                                         }
                                     }}
                                 >
                                     {/* Editor text inline cho cụm text CÓ SẴN (8.5). Enter=commit,
                                         Shift+Enter=xuống dòng, Esc/blur rỗng=hủy. */}
                                     {editingTextId === obj.id && obj.type === 'text' && !isVdpMode && (
                                       <>
                                         {/* Thanh chọn FONT — gắn NGAY TRÊN ô editor (luôn thấy dù
                                             zoom/cuộn). Chọn font máy → nhúng đúng tiếng Việt + style. */}
                                         <div
                                             className="absolute left-0 z-[60] w-[260px] bg-white rounded shadow-lg border border-slate-300 p-1.5 cursor-default"
                                             style={{ bottom: 'calc(100% + 4px)' }}
                                             onMouseDown={(e) => e.stopPropagation()}
                                             onPointerDown={(e) => e.stopPropagation()}
                                             onClick={(e) => e.stopPropagation()}
                                             onDoubleClick={(e) => e.stopPropagation()}
                                         >
                                             <div className="text-[10px] font-bold text-slate-500 mb-1">FONT (chọn để nhúng đúng tiếng Việt)</div>
                                             <FontSelector
                                                 value={editFontName}
                                                 fontFile={editFontPath}
                                                 onChange={(name, file) => { setEditFontName(name); setEditFontPath(file); }}
                                             />
                                             {editFontPath && (
                                                 <button type="button" className="mt-1 text-[10px] text-slate-500 hover:text-rose-600"
                                                     onClick={(e) => { e.stopPropagation(); setEditFontName(''); setEditFontPath(undefined); }}
                                                 >↺ Bỏ chọn font</button>
                                             )}
                                         </div>
                                         <textarea
                                             autoFocus
                                             value={editTextContent}
                                             placeholder="Nhập nội dung…"
                                             onChange={(ev) => setEditTextContent(ev.target.value)}
                                             onBlur={() => {
                                                 const c = editTextContent;
                                                 setEditingTextId(null);
                                                 // Commit khi có nội dung VÀ (khác text gốc HOẶC có chọn font mới).
                                                 if (c.trim() && (c !== (obj.content || '') || !!editFontPath)) void commitEditObjectText(obj.id, c);
                                             }}
                                             onKeyDown={(ev) => {
                                                 if (ev.key === 'Enter' && !ev.shiftKey) {
                                                     ev.preventDefault();
                                                     (ev.currentTarget as HTMLTextAreaElement).blur();
                                                 } else if (ev.key === 'Escape') {
                                                     ev.preventDefault();
                                                     setEditTextContent('');
                                                     setEditingTextId(null);
                                                 }
                                             }}
                                             onClick={(ev) => ev.stopPropagation()}
                                             onMouseDown={(ev) => ev.stopPropagation()}
                                             onPointerDown={(ev) => ev.stopPropagation()}
                                             className="absolute left-0 top-0 z-[55] bg-white border border-emerald-500 outline-none px-1 py-0.5 resize overflow-auto shadow-lg whitespace-pre-wrap"
                                             style={{
                                                 // KHÔNG bó theo bbox (gây "hụt"/cắt chữ): cho khung rộng tối thiểu để
                                                 // thấy & gõ trọn nội dung; cao tự nới theo số dòng (tối thiểu bbox).
                                                 width: `${Math.max((x1 - x0) * scale, 260)}px`,
                                                 minHeight: `${Math.max((y1 - y0) * scale, 28)}px`,
                                                 height: 'auto',
                                                 color: obj.color ? `rgb(${obj.color[0]},${obj.color[1]},${obj.color[2]})` : '#111',
                                                 fontWeight: 600,
                                                 lineHeight: 1.2,
                                                 fontSize: `${Math.max(11, (y1 - y0) * scale * 0.7)}px`,
                                             }}
                                             rows={Math.max(1, editTextContent.split('\n').length)}
                                         />
                                       </>
                                     )}
                                 </div>
                             );
                         })}
                         {/* Editor text inline cho object MỚI (9.5): hiển thị tại điểm bấm đã
                             chốt (editAddDraft) khi đang ở nhánh thêm-text. */}
                         {editingTextId === EDIT_ADD_TEXT_ID && editAddDraft && !isVdpMode && (
                             <textarea
                                 autoFocus
                                 value={editTextContent}
                                 placeholder="Nhập text mới…"
                                 onChange={(ev) => setEditTextContent(ev.target.value)}
                                 onBlur={() => {
                                     const c = editTextContent;
                                     const d = editAddDraft;
                                     setEditingTextId(null);
                                     setEditAddDraft(null);
                                     if (c.trim() && d) void commitAddTextObject(c, d);
                                 }}
                                 onKeyDown={(ev) => {
                                     if (ev.key === 'Enter' && !ev.shiftKey) {
                                         ev.preventDefault();
                                         (ev.currentTarget as HTMLTextAreaElement).blur();
                                     } else if (ev.key === 'Escape') {
                                         ev.preventDefault();
                                         setEditTextContent('');
                                         setEditAddDraft(null);
                                         setEditingTextId(null);
                                     }
                                 }}
                                 onClick={(ev) => ev.stopPropagation()}
                                 onMouseDown={(ev) => ev.stopPropagation()}
                                 onPointerDown={(ev) => ev.stopPropagation()}
                                 className="absolute z-[45] bg-white/95 border border-emerald-500 outline-none px-0.5 resize-none overflow-hidden"
                                 style={{
                                     left: editAddDraft.xPt * scale, top: editAddDraft.yPt * scale,
                                     width: EDIT_ADD_TEXT_W_PT * scale, height: EDIT_ADD_TEXT_SIZE_PT * 1.6 * scale,
                                     color: '#111', lineHeight: 1, fontSize: `${EDIT_ADD_TEXT_SIZE_PT * scale}px`,
                                 }}
                             />
                         )}
                     </>
                 );
             })()}

             {/* Edit PDF Object (task 10.3): toolbar thêm object + input file ẩn (chọn
                 ảnh). Chỉ hiện ở chế độ edit-object (KHÔNG VDP). Bật editAddMode →
                 cú bấm kế tiếp lên trang đặt object tại điểm đó (xử lý ở handleMouseUp). */}
             {isObjectEditMode && !isVdpMode && (
                 <div className="absolute top-1 left-1 z-[60] flex items-center gap-1 pointer-events-auto">
                     <button
                         type="button"
                         onClick={(e) => { e.stopPropagation(); setEditAddMode(m => m === 'text' ? null : 'text'); }}
                         className={`px-2 py-0.5 text-[11px] rounded shadow-sm border ${editAddMode === 'text' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-700 border-slate-300'}`}
                     >➕ Text</button>
                     <button
                         type="button"
                         onClick={(e) => { e.stopPropagation(); setEditAddMode(m => m === 'image' ? null : 'image'); }}
                         className={`px-2 py-0.5 text-[11px] rounded shadow-sm border ${editAddMode === 'image' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-700 border-slate-300'}`}
                     >🖼 Ảnh</button>
                     {editAddMode && (
                         <span className="px-1.5 py-0.5 text-[11px] rounded bg-black/70 text-white">
                             Bấm lên trang để đặt {editAddMode === 'text' ? 'text' : 'ảnh'}…
                         </span>
                     )}
                 </div>
             )}
             <input
                 ref={editFileInputRef}
                 type="file"
                 accept="image/*"
                 className="hidden"
                 onChange={(e) => {
                     const file = e.target.files?.[0];
                     const draft = editAddDraft;
                     e.target.value = ''; // reset để chọn lại cùng file vẫn kích hoạt
                     if (!file || !draft) { setEditAddDraft(null); return; }
                     const reader = new FileReader();
                     reader.onload = () => {
                         const dataUrl = typeof reader.result === 'string' ? reader.result : '';
                         setEditAddDraft(null);
                         if (dataUrl) void commitAddImageObject(dataUrl, draft);
                     };
                     reader.onerror = () => { setEditAddDraft(null); };
                     reader.readAsDataURL(file);
                 }}
             />

             {/* Edit PDF Object (10.2): hộp transform + handle nw/ne/sw/se (tái dùng
                 từ vdpInteraction) + handle XOAY. Ghost dashed cập nhật theo THỜI GIAN
                 THỰC bằng CSS transform qua editGhostRef trong handleMouseMove — KHÔNG
                 setState mỗi frame (Yêu cầu 13.2); chỉ mouseup mới gửi /edit/transform. */}
             {isObjectEditMode && pageDim && editSelectedIds.length > 0 && !(editingTextId && editingTextId !== EDIT_ADD_TEXT_ID) && (() => {
                 // scale = px màn / POINT (getEditSelectionBoxPx nhận px/point).
                 const scale = displayWidth / ((pageDim.w || 595) * 72 / 96);
                 const box = getEditSelectionBoxPx(scale);
                 if (!box) return null;
                 const accent = 'rgb(16,185,129)';
                 return (
                     <>
                         {/* Ghost: xem trước vị trí/kích thước/góc dự kiến (real-time).
                             LUÔN render khi có lựa chọn; handleMouseMove cập nhật trực tiếp
                             style.transform/transformOrigin/display qua editGhostRef (KHÔNG
                             phụ thuộc re-render). Base left/top/width/height TĨNH trong lúc
                             kéo (selection không đổi), lấy từ getEditSelectionBoxPx(scale). */}
                         <div
                             ref={editGhostRef}
                             className="absolute z-[39] pointer-events-none"
                             style={{
                                 left: box.left, top: box.top, width: box.width, height: box.height,
                                 transform: 'none', transformOrigin: 'center center', display: 'none',
                                 border: `2px dashed ${accent}`, backgroundColor: `${accent}14`,
                             }}
                         />
                         {/* Hộp transform — vùng trong = kéo MOVE. */}
                         <div
                             className="absolute z-40 pointer-events-auto cursor-move"
                             style={{
                                 left: box.left, top: box.top, width: box.width, height: box.height,
                                 border: `1.5px solid ${accent}`, backgroundColor: 'transparent',
                             }}
                             onMouseDown={(e) => e.stopPropagation()}
                             onPointerDown={(e) => { e.stopPropagation(); beginEditInteraction(e, 'move'); }}
                             onDoubleClick={(e) => {
                                 // Double-click trên hộp transform (object đang chọn) → mở
                                 // editor text inline nếu object đó là TEXT (hộp z-40 vốn
                                 // che object div z-30 nên double-click trực tiếp không tới).
                                 if (isVdpMode || editSelectedIds.length !== 1) return;
                                 const sel = editObjects.find(o => o.id === editSelectedIds[0]);
                                 if (sel && sel.type === 'text') {
                                     e.stopPropagation();
                                     setEditingTextId(sel.id);
                                     setEditTextContent(sel.content || '');
                                 }
                             }}
                         >
                             {/* Resize handles nw/ne/sw/se (tái dùng hệ handle VDP). */}
                             {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => {
                                 const posCls = handle === 'nw' ? '-left-1.5 -top-1.5 cursor-nw-resize'
                                     : handle === 'ne' ? '-right-1.5 -top-1.5 cursor-ne-resize'
                                     : handle === 'sw' ? '-left-1.5 -bottom-1.5 cursor-sw-resize'
                                     : '-right-1.5 -bottom-1.5 cursor-se-resize';
                                 return (
                                     <div
                                         key={handle}
                                         className={`absolute ${posCls} w-3 h-3 bg-white border-2 rounded-sm shadow-sm hover:scale-150 transition-transform z-[42]`}
                                         style={{ borderColor: accent }}
                                         onMouseDown={(e) => e.stopPropagation()}
                                         onPointerDown={(e) => { e.stopPropagation(); beginEditInteraction(e, 'resize', handle); }}
                                     />
                                 );
                             })}
                             {/* Đường nối tới handle xoay. */}
                             <div
                                 className="absolute left-1/2 -top-7 w-px h-7 -translate-x-1/2 pointer-events-none"
                                 style={{ backgroundColor: accent }}
                             />
                             {/* Handle XOAY — phía trên giữa bbox; tính góc từ tâm → con trỏ. */}
                             <div
                                 className="absolute left-1/2 -top-[2.1rem] w-3 h-3 -translate-x-1/2 bg-white border-2 rounded-full shadow-sm hover:scale-150 transition-transform z-[42] cursor-grab"
                                 style={{ borderColor: accent }}
                                 title="Xoay"
                                 onMouseDown={(e) => e.stopPropagation()}
                                 onPointerDown={(e) => { e.stopPropagation(); beginEditInteraction(e, 'rotate'); }}
                             />
                         </div>
                     </>
                 );
             })()}

             {/* Watermark Live Preview Overlay */}
             {activeDashboardTool === 'watermark' && watermarkPreview && pageDim && (() => {
                 const {
                     watermarkType, watermarkText, batesStart, batesPadding, watermarkImageUrl,
                     layerZIndex, color, fontSize, opacity, rotation, spacing, isRepeated,
                     scaleMode, imageScale, positionXMode, offsetX, positionYMode, offsetY,
                     targetType, rangeStart, rangeEnd, wmWidth = 100, wmHeight = 100
                 } = watermarkPreview;

                 // Check range
                 const pageIdx = originalPageNum - 1;
                 let shouldRender = true;
                 if (targetType === 'even' && (pageIdx + 1) % 2 !== 0) shouldRender = false;
                 if (targetType === 'odd' && (pageIdx + 1) % 2 !== 1) shouldRender = false;
                 if (targetType === 'range' && ((pageIdx + 1) < rangeStart || (pageIdx + 1) > rangeEnd)) shouldRender = false;
                 
                 if (!shouldRender) return null;

                 const dummyText = watermarkText
                    .replace(/\[PAGE\]/g, (pageIdx + 1).toString())
                    .replace(/\[TOTAL\]/g, '99')
                    .replace(/\[DATE\]/g, new Date().toLocaleDateString('vi-VN'))
                    .replace(/\[TIME\]/g, new Date().toLocaleTimeString('vi-VN'))
                    .replace(/\[BATES\]/g, (batesStart + pageIdx).toString().padStart(batesPadding, '0'));

                 // Need to scale physical units (mm, pt) to CSS pixels on screen
                 // Note: AcrobatViewer CSS is heavily zoomed. We rely on displayWidth and pageDim.w
                 // to scale appropriately. pageDim.w is in pixels at 96 DPI.
                 const pageWidthPt = pageDim.w;
                 const pageHeightPt = pageDim.h;
                 const scale = displayWidth / pageWidthPt;
                 
                 let finalScaleX = imageScale;
                 let finalScaleY = imageScale;

                 if (scaleMode === 'fit_page' && wmWidth > 0 && wmHeight > 0) {
                     const rad = rotation * Math.PI / 180;
                     const rotatedWmWidth = Math.abs(wmWidth * Math.cos(rad)) + Math.abs(wmHeight * Math.sin(rad));
                     const rotatedWmHeight = Math.abs(wmWidth * Math.sin(rad)) + Math.abs(wmHeight * Math.cos(rad));
                     const scaleX = pageWidthPt / rotatedWmWidth;
                     const scaleY = pageHeightPt / rotatedWmHeight;
                     finalScaleX = Math.min(scaleX, scaleY);
                     finalScaleY = finalScaleX;
                 } else if (scaleMode === 'stretch' && wmWidth > 0 && wmHeight > 0) {
                     const rad = rotation * Math.PI / 180;
                     const targetWidth = pageWidthPt * Math.abs(Math.cos(rad)) + pageHeightPt * Math.abs(Math.sin(rad));
                     const targetHeight = pageHeightPt * Math.abs(Math.cos(rad)) + pageWidthPt * Math.abs(Math.sin(rad));
                     finalScaleX = targetWidth / wmWidth;
                     finalScaleY = targetHeight / wmHeight;
                 }
                 
                 const scaledWmWidth = wmWidth * finalScaleX * scale;
                 const scaledWmHeight = wmHeight * finalScaleY * scale;
                 
                 const scaledFontSize = fontSize * scale;
                 const scaledSpacing = spacing * scale;
                 
                 // If repeating, we render a grid. If not, absolute position.
                 return (
                     <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ zIndex: layerZIndex === 'top' ? 40 : 1 }}>
                         {isRepeated ? (
                             <div style={{
                                 position: 'absolute',
                                 width: '300%',
                                 height: '300%',
                                 left: '-100%',
                                 top: '-100%',
                                 display: 'flex',
                                 flexDirection: 'column',
                                 justifyContent: 'center',
                                 alignItems: 'center',
                                 gap: `${scaledSpacing / 2}px`,
                                 transform: `rotate(${rotation}deg)`,
                                 opacity: opacity,
                                 color: color,
                                 fontSize: `${scaledFontSize}px`,
                                 fontWeight: 'bold',
                             }}>
                                 {Array.from({ length: 15 }).map((_, rowIndex) => (
                                     <div key={rowIndex} style={{
                                         display: 'flex',
                                         gap: `${scaledSpacing}px`,
                                         marginLeft: rowIndex % 2 !== 0 ? `${(watermarkType === 'text' ? scaledFontSize : scaledWmWidth) + scaledSpacing / 2}px` : '0px',
                                         justifyContent: 'center'
                                     }}>
                                         {Array.from({ length: 15 }).map((_, colIndex) => {
                                             return watermarkType === 'image' ? (
                                                 watermarkImageUrl ? (
                                                    <img key={colIndex} src={watermarkImageUrl} alt="wm" style={{ width: `${scaledWmWidth}px`, height: `${scaledWmHeight}px`, objectFit: scaleMode === 'stretch' ? 'fill' : 'contain', flexShrink: 0, maxWidth: 'none', maxHeight: 'none' }} />
                                                 ) : (
                                                    <div key={colIndex} style={{ width: `${scaledWmWidth}px`, height: `${scaledWmHeight}px`, border: '2px dashed #94a3b8', background: 'rgba(241, 245, 249, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, maxWidth: 'none', maxHeight: 'none' }}>
                                                        <span className="text-slate-500 font-bold text-[10px]">Phôi PDF</span>
                                                    </div>
                                                 )
                                             ) : (
                                                 <span key={colIndex} className="whitespace-nowrap" style={{ flexShrink: 0 }}>{watermarkType === 'text' ? dummyText : '[PDF File]'}</span>
                                             )
                                         })}
                                     </div>
                                 ))}
                             </div>
                         ) : (
                             <div style={{
                                 position: 'absolute',
                                 left: positionXMode === 'center' ? '50%' : positionXMode === 'left' ? `${(offsetX / 25.4 * 72) * scale}px` : 'auto',
                                 right: positionXMode === 'right' ? `${(offsetX / 25.4 * 72) * scale}px` : 'auto',
                                 top: positionYMode === 'center' ? '50%' : positionYMode === 'top' ? `${(offsetY / 25.4 * 72) * scale}px` : 'auto',
                                 bottom: positionYMode === 'bottom' ? `${(offsetY / 25.4 * 72) * scale}px` : 'auto',
                                 transform: `translate(${positionXMode === 'center' ? '-50%' : '0'}, ${positionYMode === 'center' ? '-50%' : '0'}) rotate(${rotation}deg)`,
                                 marginLeft: positionXMode === 'center' ? `${(offsetX / 25.4 * 72) * scale}px` : '0',
                                 marginTop: positionYMode === 'center' ? `${(offsetY / 25.4 * 72) * scale}px` : '0',
                                 opacity: opacity,
                                 color: color,
                                 fontSize: `${scaledFontSize}px`,
                                 fontWeight: 'bold',
                             }}>
                                 {watermarkType === 'image' ? (
                                     watermarkImageUrl ? (
                                        <img src={watermarkImageUrl} alt="wm" style={{ width: `${scaledWmWidth}px`, height: `${scaledWmHeight}px`, objectFit: scaleMode === 'stretch' ? 'fill' : 'contain', maxWidth: 'none', maxHeight: 'none' }} />
                                     ) : (
                                        <div style={{ width: `${scaledWmWidth}px`, height: `${scaledWmHeight}px`, border: '2px dashed #94a3b8', background: 'rgba(241, 245, 249, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', maxWidth: 'none', maxHeight: 'none' }}>
                                            <span className="text-slate-500 font-bold text-xs whitespace-nowrap">Phôi PDF</span>
                                        </div>
                                     )
                                 ) : (
                                     <span className="whitespace-nowrap">{watermarkType === 'text' ? dummyText : '[PDF File]'}</span>
                                 )}
                             </div>
                         )}
                     </div>
                 );
             })()}

             {/* VDP Tool Overlay */}
             {vdpFields && vdpFields.length > 0 && pageDim && (() => {
                 const pageWidthPt = pageDim.w;
                 const scale = displayWidth / pageWidthPt;
                 return vdpFields.filter((f: any) => f.pageNum === originalPageNum).map((field: any) => {
                     const x0 = (field.x / 25.4 * 72) * scale;
                     const y0 = (field.y / 25.4 * 72) * scale;
                     const w = (field.width / 25.4 * 72) * scale;
                     const h = (field.height / 25.4 * 72) * scale;
                     const safeSelectedIds = Array.isArray(selectedVdpFieldIds) ? selectedVdpFieldIds : [];
                     const isSelected = safeSelectedIds.includes(field.id);
                     const isInteracting = vdpInteraction && Array.isArray(vdpInteraction.fieldIds) && vdpInteraction.fieldIds.includes(field.id);
                     return (
                         <div
                             key={field.id}
                             className={`absolute group ${isSelected ? 'z-[60]' : 'z-[55] hover:z-[58]'} border-2 ${isSelected ? 'border-solid border-blue-500 bg-blue-500/10' : 'border-dashed border-transparent group-hover:border-slate-400'} ${isVdpMode ? (isInteracting ? 'pointer-events-auto' : 'pointer-events-auto cursor-move') : 'pointer-events-none'}`}
                             style={{
                                 left: x0, top: y0, width: w, height: h
                             }}
                             onDoubleClick={(e) => {
                                 if (field.type === 'text') {
                                     e.stopPropagation();
                                     setEditingTextId(field.id);
                                     setEditTextContent(field.textContent !== undefined ? field.textContent : `{${field.name}}`);
                                 }
                             }}
                             onMouseDown={(e) => e.stopPropagation()}
                             onPointerDown={(e) => {
                                 if (editingTextId === field.id) return;
                                 e.stopPropagation();
                                 let newSelection = [...safeSelectedIds];
                                 
                                 // Handle Group Selection (if this field belongs to a group, select the whole group)
                                 const groupFields = field.groupId ? vdpFields.filter((f: any) => f.groupId === field.groupId).map((f: any) => f.id) : [field.id];
                                 
                                 if (e.shiftKey) {
                                     const allSelected = groupFields.every((id: string) => newSelection.includes(id));
                                     if (allSelected) {
                                         newSelection = newSelection.filter((id: string) => !groupFields.includes(id));
                                     } else {
                                         newSelection = [...new Set([...newSelection, ...groupFields])];
                                     }
                                 } else {
                                     if (!newSelection.includes(field.id)) {
                                         newSelection = groupFields;
                                     }
                                 }
                                 
                                 setSelectedVdpFieldIds(newSelection);
                                 onVdpBoxSelect?.(newSelection);
                                 if (!containerRef.current) return;
                                 const rect = containerRef.current.getBoundingClientRect();
                                 
                                 // Record start positions for ALL selected fields (or group fields if not in current selection)
                                 const fieldsToMove = newSelection.includes(field.id) ? newSelection : groupFields;
                                 
                                 if (e.altKey) {
                                     // DUPLICATE LOGIC
                                     const newGroupId = `group_${Date.now()}`;
                                     const hasMultiple = fieldsToMove.length > 1 || field.groupId;
                                     const newFieldsToMove: string[] = [];
                                     const startFields: Record<string, {x: number, y: number, w: number, h: number}> = {};
                                     
                                     onVdpFieldsChange?.((prev: any[]) => {
                                         const copies: any[] = [];
                                         fieldsToMove.forEach((id: string) => {
                                             const f = prev.find((tf: any) => tf.id === id);
                                             if (!f) return;
                                             
                                             const copyId = `field_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                                             newFieldsToMove.push(copyId);
                                             startFields[copyId] = { x: f.x, y: f.y, w: f.width, h: f.height };
                                             
                                             let newName = f.name;
                                             let newTextContent = f.textContent;
                                             
                                             if (newName) {
                                                 const match = newName.match(/^(.*?)(\d+)$/);
                                                 if (match) {
                                                     const prefix = match[1];
                                                     let maxNum = parseInt(match[2], 10);
                                                     [...prev, ...copies].forEach((pf: any) => {
                                                         if (pf && pf.name && pf.name.startsWith(prefix)) {
                                                             const m = pf.name.match(/^(.*?)(\d+)$/);
                                                             if (m && m[1] === prefix) {
                                                                 maxNum = Math.max(maxNum, parseInt(m[2], 10));
                                                             }
                                                         }
                                                     });
                                                     newName = `${prefix}${maxNum + 1}`;
                                                     if (newTextContent === `{${f.name}}`) {
                                                         newTextContent = `{${newName}}`;
                                                     } else if (newTextContent && newTextContent.includes(`{${f.name}}`)) {
                                                         newTextContent = newTextContent.replace(new RegExp(`\\{${f.name}\\}`, 'g'), `{${newName}}`);
                                                     }
                                                 } else {
                                                     let maxNum = 0;
                                                     [...prev, ...copies].forEach((pf: any) => {
                                                         if (pf && pf.name && pf.name.startsWith(`${newName}_`)) {
                                                             const m = pf.name.match(/_(\d+)$/);
                                                             if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
                                                         }
                                                     });
                                                     newName = maxNum > 0 ? `${newName}_${maxNum + 1}` : `${newName}_copy`;
                                                     if (newTextContent === `{${f.name}}`) {
                                                         newTextContent = `{${newName}}`;
                                                     } else if (newTextContent && newTextContent.includes(`{${f.name}}`)) {
                                                         newTextContent = newTextContent.replace(new RegExp(`\\{${f.name}\\}`, 'g'), `{${newName}}`);
                                                     }
                                                 }
                                             }

                                             copies.push({
                                                 ...f,
                                                 id: copyId,
                                                 groupId: hasMultiple ? newGroupId : undefined,
                                                 name: newName,
                                                 textContent: newTextContent
                                             });
                                         });
                                         
                                         // Schedule interaction start AFTER state updates
                                         setTimeout(() => {
                                             setSelectedVdpFieldIds(newFieldsToMove);
                                            onVdpBoxSelect?.(newFieldsToMove);
                                             setVdpInteraction({
                                                 type: 'move',
                                                 fieldIds: newFieldsToMove,
                                                 startX: e.clientX - rect.left,
                                                 startY: e.clientY - rect.top,
                                                 startFields
                                             });
                                         }, 0);
                                         
                                         return [...prev, ...copies];
                                     });
                                 } else {
                                     // STANDARD MOVE/RESIZE
                                     const startFields: Record<string, {x: number, y: number, w: number, h: number}> = {};
                                     fieldsToMove.forEach((id: string) => {
                                         const f = vdpFields.find((tf: any) => tf.id === id);
                                         if (f) {
                                             startFields[id] = { x: f.x, y: f.y, w: f.width, h: f.height };
                                         }
                                     });
                                     
                                     setVdpInteraction({
                                         type: 'move',
                                         fieldIds: fieldsToMove,
                                         startX: e.clientX - rect.left,
                                         startY: e.clientY - rect.top,
                                         startFields
                                     });
                                 }
                                 
                                 (e.target as HTMLElement).releasePointerCapture(e.pointerId);
                             }}
                         >
                             <div className={`absolute -top-6 left-0 bg-blue-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow whitespace-nowrap pointer-events-none transition-opacity z-[70] ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                                 {field.fieldName || field.name || 'Chưa đặt tên'} ({field.type})
                             </div>
                             
                             {/* Visual Placeholders */}
                             <div className={`absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden ${(field.type === 'qrcode' || field.type === 'barcode') ? 'opacity-100' : 'mix-blend-multiply ' + (field.type === 'image' ? 'opacity-50' : 'opacity-80')} ${field.type === 'text' ? 'p-1' : ''}`}>
                                 {(field.type === 'qrcode' || field.type === 'barcode') && (
                                     <VdpPreviewImage field={field} />
                                 )}
                                 {field.type === 'image' && (
                                     <div 
                                         className="w-full h-full flex items-center justify-center bg-slate-300 dark:bg-zinc-700/80"
                                         style={{
                                             borderRadius: field.imageShape === 'circle' ? '50%' : field.imageShape === 'rounded' ? '16px' : '0',
                                             clipPath: field.imageShape === 'polygon' ? 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)' : field.imageShape === 'star' ? 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)' : 'none'
                                         }}
                                     >
                                         <svg className="w-full h-full max-w-[50%] max-h-[50%] text-slate-500 opacity-75" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                         </svg>
                                     </div>
                                 )}
                                 {field.type === 'text' && (
                                     editingTextId === field.id ? (
                                         <textarea
                                             autoFocus
                                             value={editTextContent}
                                             onChange={(e) => setEditTextContent(e.target.value)}
                                             onBlur={() => {
                                                 onVdpFieldsChange?.(vdpFields.map((f: any) => f.id === field.id ? { ...f, textContent: editTextContent } : f));
                                                 setEditingTextId(null);
                                             }}
                                             onKeyDown={(e) => {
                                                 if (e.key === 'Enter') {
                                                     if (e.shiftKey) {
                                                         // Allow new line
                                                         return;
                                                     }
                                                     e.preventDefault();
                                                     e.currentTarget.blur();
                                                 }
                                             }}
                                             className="w-full h-full bg-transparent border-none outline-none px-1 resize-none overflow-hidden"
                                             style={{ 
                                                 color: field.fontColor || '#1e293b', 
                                                 fontSize: `${(field.fontSize || 10) * scale}px`,
                                                 fontFamily: field.fontName === 'Helvetica' ? 'Arial, sans-serif' : field.fontName === 'Times-Roman' ? '"Times New Roman", serif' : field.fontName === 'Courier' ? 'Courier, monospace' : (field.fontFile ? `"${field.fontName}_local", sans-serif` : (field.fontName ? `"${field.fontName}", sans-serif` : 'inherit')),
                                                 fontWeight: field.fontStyle === 'bold' || field.fontStyle === 'bolditalic' ? 'bold' : 'normal',
                                                 fontStyle: field.fontStyle === 'italic' || field.fontStyle === 'bolditalic' ? 'italic' : 'normal',
                                                 lineHeight: field.lineHeight ? `${field.lineHeight}em` : 1,
                                                 letterSpacing: field.characterSpacing ? `${field.characterSpacing}pt` : 0,
                                                 pointerEvents: 'auto' 
                                             }}
                                             onPointerDown={(e) => e.stopPropagation()}
                                         />
                                     ) : (
                                         <VdpAutoFitText
                                             field={field}
                                             scale={scale}
                                             text={field.textContent !== undefined ? field.textContent : `{${field.name}}`}
                                             onAutoFit={(pt: number) => {
                                                 const rounded = Math.round(pt * 10) / 10;
                                                 if (onVdpFieldsChange && Math.abs((field.fontSize || 10) - rounded) > 0.2) {
                                                     onVdpFieldsChange((prev: any[]) => prev.map((f: any) => f.id === field.id ? { ...f, fontSize: rounded } : f));
                                                 }
                                             }}
                                         />
                                     )
                                 )}
                             </div>
                             
                             {/* Resize Handles (4 góc) */}
                             {isSelected && (['nw','ne','sw','se'] as const).map((handle) => {
                                 const posCls = handle === 'nw' ? '-left-1.5 -top-1.5 cursor-nw-resize'
                                     : handle === 'ne' ? '-right-1.5 -top-1.5 cursor-ne-resize'
                                     : handle === 'sw' ? '-left-1.5 -bottom-1.5 cursor-sw-resize'
                                     : '-right-1.5 -bottom-1.5 cursor-se-resize';
                                 return (
                                     <div
                                         key={handle}
                                         className={`absolute ${posCls} w-3 h-3 bg-white border-2 border-blue-500 rounded-full shadow-sm hover:scale-150 transition-transform z-[65]`}
                                         onPointerDown={(e) => {
                                             e.stopPropagation();
                                             if (!containerRef.current) return;
                                             const rect = containerRef.current.getBoundingClientRect();
                                             setVdpInteraction({
                                                 type: 'resize',
                                                 handle,
                                                 fieldIds: [field.id],
                                                 startX: e.clientX - rect.left,
                                                 startY: e.clientY - rect.top,
                                                 startFields: {
                                                     [field.id]: { x: field.x, y: field.y, w: field.width, h: field.height }
                                                 }
                                             });
                                             (e.target as HTMLElement).releasePointerCapture(e.pointerId);
                                         }}
                                     />
                                 );
                             })}
                         </div>
                     );
                 });
             })()}



             {/* Preview Stick Text & Numbers Tool */}
             {stickPreviewParams && pageDim && (() => {
                 const { fields, margins, startNumber, increment, padLength, fontName, fontSize, fontColor, rotation, targetType, rangeStart, rangeEnd } = stickPreviewParams;
                 
                 // Check if page should be processed
                 let process = false;
                 if (targetType === 'all') process = true;
                 else if (targetType === 'even') process = originalPageNum % 2 === 0;
                 else if (targetType === 'odd') process = originalPageNum % 2 === 1;
                 else if (targetType === 'range') process = originalPageNum >= rangeStart && originalPageNum <= rangeEnd;
                 
                 if (!process) return null;

                 // Calculate number
                 let currentNumber = startNumber;
                 if (targetType === 'all') {
                     currentNumber += (originalPageNum - 1) * increment;
                 } else {
                     let processedCount = 0;
                     for (let i = 1; i < originalPageNum; i++) {
                         if (targetType === 'even' && i % 2 === 0) processedCount++;
                         else if (targetType === 'odd' && i % 2 === 1) processedCount++;
                         else if (targetType === 'range' && i >= rangeStart && i <= rangeEnd) processedCount++;
                     }
                     currentNumber += processedCount * increment;
                 }

                 const numStr = String(currentNumber).padStart(padLength, '0');
                 const todayStr = new Date().toLocaleDateString('vi-VN');

                 const pageWidthPt = pageDim.w;
                 const scale = displayWidth / pageWidthPt;
                 const MM_TO_PT = 2.83465;

                 const fieldList = [
                     { id: 'topLeft', content: fields?.topLeft, top: margins?.top, bottom: null, left: margins?.left, right: null, align: 'flex-start', valalign: 'flex-start' },
                     { id: 'topCenter', content: fields?.topCenter, top: margins?.top, bottom: null, left: 0, right: 0, align: 'center', valalign: 'flex-start' },
                     { id: 'topRight', content: fields?.topRight, top: margins?.top, bottom: null, left: null, right: margins?.right, align: 'flex-end', valalign: 'flex-start' },
                     { id: 'bottomLeft', content: fields?.bottomLeft, top: null, bottom: margins?.bottom, left: margins?.left, right: null, align: 'flex-start', valalign: 'flex-end' },
                     { id: 'bottomCenter', content: fields?.bottomCenter, top: null, bottom: margins?.bottom, left: 0, right: 0, align: 'center', valalign: 'flex-end' },
                     { id: 'bottomRight', content: fields?.bottomRight, top: null, bottom: margins?.bottom, left: null, right: margins?.right, align: 'flex-end', valalign: 'flex-end' }
                 ];

                 return fieldList.map(f => {
                     if (!f.content) return null;
                     const drawString = f.content.replace(/\[page\]/gi, numStr).replace(/\[date\]/gi, todayStr);
                     if (!drawString) return null;

                     let posStyles: any = { position: 'absolute' };
                     
                     if (f.left !== null && f.right !== null) {
                         posStyles.left = 0;
                         posStyles.width = '100%';
                     } else if (f.left !== null) {
                         posStyles.left = f.left * MM_TO_PT * scale;
                     } else if (f.right !== null) {
                         posStyles.right = f.right * MM_TO_PT * scale;
                     }

                     if (f.top !== null) posStyles.top = f.top * MM_TO_PT * scale;
                     if (f.bottom !== null) posStyles.bottom = f.bottom * MM_TO_PT * scale;

                     posStyles.justifyContent = f.align;
                     posStyles.alignItems = f.valalign;

                     return (
                         <div key={f.id} className="absolute inset-0 pointer-events-none z-[45] flex" style={posStyles}>
                             <div style={{
                                 color: fontColor,
                                 fontSize: `${fontSize * scale}px`,
                                 fontFamily: fontName === 'Times-Roman' ? '"Times New Roman", serif' : fontName === 'Courier' ? 'Courier, monospace' : '"Helvetica Neue", Helvetica, Arial, sans-serif',
                                 transform: `rotate(${rotation}deg)`,
                                 transformOrigin: 'center center',
                                 lineHeight: 1,
                                 whiteSpace: 'nowrap',
                                 textShadow: '0 0 2px rgba(255,255,255,0.8)'
                             }}>
                                 {drawString}
                             </div>
                         </div>
                     );
                 });
             })()}

             {/* Marquee Drag Box — always in DOM, visibility controlled by ref */}
             {(isSelectionMode || isObjectEditMode) && (
                 <div 
                     ref={marqueeRef}
                     className="absolute border-2 border-blue-500 bg-blue-400/15 z-40 pointer-events-none"
                     style={{ display: 'none' }}
                 />
             )}
            </div>
        </div>

        {/* Dimension Overlay — positioned OUTSIDE the page frame */}
        {detectedDimension && (
            <>
                {/* Width Arrow (Below page) */}
                <div className="flex items-center justify-center gap-2 text-blue-500 mt-1.5 pointer-events-none">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                    </svg>
                    <span className="text-xs font-bold whitespace-nowrap bg-white/90 dark:bg-zinc-800/90 px-2 py-0.5 rounded-md shadow-sm border border-blue-200 dark:border-blue-800">
                        W: {(detectedDimension.w * 0.352778).toFixed(1)} mm
                    </span>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                </div>
                {/* Height Arrow (Right of page — absolute positioned) */}
                <div className="absolute top-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5 text-blue-500 pointer-events-none"
                     style={{ left: '100%', marginLeft: 8 }}>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    </svg>
                    <span className="text-xs font-bold whitespace-nowrap bg-white/90 dark:bg-zinc-800/90 px-2 py-0.5 rounded-md shadow-sm border border-blue-200 dark:border-blue-800"
                          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                        H: {(detectedDimension.h * 0.352778).toFixed(1)} mm
                    </span>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                    </svg>
                </div>
            </>
        )}
        </div>
        </>
    );
    //#endregion
};