import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Page } from 'react-pdf';
import { convertFileSrc } from '@tauri-apps/api/core';
import { authenticatedFetch, getApiUrl, getSystemFonts } from '../../lib/api';
import { VdpPreviewImage } from './ViewerHelpers';
import { useViewerHotkeys } from '../../hooks/viewer/useViewerHotkeys';
import { globalPdfObjectCache } from '../../stores/pdfObjectCache';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useImposerSettingsStore } from '../imposition-tools/useImposerSettingsStore';
import { useShallow } from 'zustand/react/shallow';
import type { ObjType, BBox, EditOp } from './editTypes';
import type { SessionOpOutcome } from '../../hooks/useEditSession';
import { FontSelector } from '../preprocess-tools/FontSelector';
import { Lock, Check, X, RotateCcw, AlertTriangle } from 'lucide-react';
import {
    pageWidthPtFromDim,
    pageHeightPtFromDim,
    editScale as calcEditScale,
    objectBboxNativeToCanvas,
    clipRectPdfToCanvas,
    addBboxCanvasToNative,
    moveDeltaCanvasToPdf,
    snapRotation,
    rotationScreenToPdf,
    pickFontForName as pickFontForNameUtil,
} from './editGeometry';
import { formatPageNumber, applyTokens, effectiveLR } from '../../lib/stampFormat';

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
    fontName?: string; // tên font gốc (BaseFont) để gợi ý/khớp font hệ thống
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

// Dọn tile của RIÊNG một file (key = `${pdfUrl}_...`) → gọi khi ĐÓNG tab để giải
// phóng bitmap của tab đó mà KHÔNG đụng tile các tab khác đang mở (cache là global,
// dùng chung mọi tab — audit RAM 2026-07-06). Chỉ revoke blob thật.
export function clearTileUrlCacheForFile(fileKeyPrefix: string) {
    if (!fileKeyPrefix) return;
    const prefix = `${fileKeyPrefix}_`;
    for (const [key, url] of _tileUrlCache) {
        if (key.startsWith(prefix)) {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
            _tileUrlCache.delete(key);
        }
    }
}

// ═══ Edit Objects Cache (chế độ Chỉnh sửa đối tượng) ═══
// Cache danh sách EditCanvasObj theo khóa `${selectionFileId}:${pageIndex}` để
// bật/tắt chế độ KHÔNG phải fetch lại /edit/objects (hết "load lâu khi tắt/bật").
// Clear khi pdfUrl đổi (file mới / commit working-file mới) để không dùng dữ liệu cũ.
const _editObjectsCache = new Map<string, EditCanvasObj[]>();
// Gốc CropBox (bx0,by0) theo cùng khóa cache — để add-text/image quy đổi tọa độ
// canvas (cropbox-relative) ↦ PDF NATIVE đúng trên file có CropBox lệch gốc.
const _editCropOriginCache = new Map<string, [number, number]>();
function clearEditObjectsCache() {
    _editObjectsCache.clear();
    _editCropOriginCache.clear();
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
        // FIX màn-trắng-khi-occluded: IntersectionObserver CHỈ bắn khi trang được
        // paint; cửa sổ WebView2 bị coi là occluded thì không paint → observer không
        // bắn → tile không được xin → trắng tới ~7s tới khi bị ép paint (mở DevTools).
        // Gọi _loadTile() ĐỒNG BỘ ngay trong effect (không phụ thuộc observer/paint)
        // để tile luôn được nạp tức thì. Observer vẫn giữ làm dự phòng cho tile cuộn xa;
        // _loadTile có guard nên gọi 2 lần là vô hại.
        (el as any)._loadTile?.();
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

// ═══ Viewport tile grid (chỉ bật ở zoom cao — audit render 2026-07-06) ═══
// Ở zoom cao, single-tile bị cap (computeRenderZoom ≤24 + native max_dim=8000) → bitmap
// nhỏ hơn kích thước hiển thị → browser phóng CSS → mờ. TileLayer chồng LÊN nền single-tile:
// render MỘT tile phủ ĐÚNG vùng đang nhìn (không phải lưới N ô) ở đúng zoom×dpr → sắc như
// Acrobat mà bitmap chặn theo màn hình. Nền single-tile vẫn giữ bên dưới nên không bao giờ
// trắng. Chỉ dùng cho PDF, rot===0 (tránh lệch toạ độ khi trang xoay).
//
// VÌ SAO 1 TILE (không lưới): pdfium duyệt display-list CẢ TRANG cho MỖI lần render + render
// TUẦN TỰ (pool 1 handle, khóa handle.lock). Lưới N ô = N lần duyệt-cả-trang nối đuôi → chậm
// tuyến tính theo số ô. Một tile phủ viewport = 1 lần duyệt + 1 encode + 1 IPC → nhanh nhất.
// Đánh đổi: pan phải render lại (lưới cache được ô cũ). Bù bằng PAD (phủ rộng hơn viewport)
// + SNAP (bo origin về lưới → pan nhỏ trùng key cache cũ, khỏi render lại).
const TILE_PAD = 256;   // device px phủ thêm quanh viewport → pan nhỏ vẫn trong tile
const TILE_SNAP = 256;  // bo origin/extent về bội số này → pan nhỏ tái dùng cache
const TILE_MAX = 4000;  // trần set_fixed_size của native (an toàn OOM)

const TileLayer = React.memo(({ fileKey, pageNum, zoom, dpr, displayWidth, displayHeight, containerRef, getTileUrl, onVisible }: any) => {
    // Vùng nhìn (CSS px, gốc = góc trên-trái trang) — tính lại khi cuộn/zoom/resize.
    const [visRect, setVisRect] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);

    // DEBOUNCE zoom (audit tốc độ 2026-07-06): zoom liên tục sinh HÀNG TRĂM render trung
    // gian (log: 278 render/phiên, mỗi cái ~160ms tuần tự → chờ vài giây). Chỉ render tile
    // SẮC khi zoom ĐÃ DỪNG (~180ms); trong lúc zoom nền mờ lo hiển thị. displayWidth/Height
    // đổi theo zoom nên cũng phải "đóng băng" theo settledZoom để clip/CSS khớp.
    const [settled, setSettled] = useState({ zoom, displayWidth, displayHeight });
    useEffect(() => {
        const id = setTimeout(() => setSettled({ zoom, displayWidth, displayHeight }), 180);
        return () => clearTimeout(id);
    }, [zoom, displayWidth, displayHeight]);
    const sZoom = settled.zoom;
    const sDisplayW = settled.displayWidth;
    const sDisplayH = settled.displayHeight;

    useEffect(() => {
        const pageEl = containerRef?.current as HTMLElement | null;
        if (!pageEl) return;
        // Tìm tổ tiên cuộn được (Virtuoso Scroller) để lấy khung nhìn thực.
        let scrollEl: HTMLElement | null = pageEl.parentElement;
        while (scrollEl) {
            const oy = getComputedStyle(scrollEl).overflowY;
            if (oy === 'auto' || oy === 'scroll') break;
            scrollEl = scrollEl.parentElement;
        }
        const compute = () => {
            const pageRect = pageEl.getBoundingClientRect();
            const vp = scrollEl ? scrollEl.getBoundingClientRect() : null;
            const vpLeft = vp ? vp.left : 0;
            const vpTop = vp ? vp.top : 0;
            const vpRight = vp ? vp.right : window.innerWidth;
            const vpBottom = vp ? vp.bottom : window.innerHeight;
            const left = Math.max(0, vpLeft - pageRect.left);
            const top = Math.max(0, vpTop - pageRect.top);
            const right = Math.min(pageRect.width, vpRight - pageRect.left);
            const bottom = Math.min(pageRect.height, vpBottom - pageRect.top);
            if (right <= left || bottom <= top) { setVisRect(null); return; }
            setVisRect({ left, top, right, bottom });
        };
        compute();
        const target: any = scrollEl || window;
        target.addEventListener('scroll', compute, { passive: true });
        window.addEventListener('resize', compute);
        return () => {
            target.removeEventListener('scroll', compute);
            window.removeEventListener('resize', compute);
        };
    }, [containerRef, sDisplayW, sDisplayH, sZoom]);

    // Trong lúc zoom ĐANG chuyển (live zoom/size ≠ settled đã đóng băng): tile sắc được
    // tính clip/định vị theo settled CŨ nhưng container đã phóng tới size MỚI → tile lệch/
    // vỡ (khung lệch, dải thừa, mảng trắng). Ẩn tile sắc tới khi settle → chỉ nền single-tile
    // (scale CSS theo size sống, luôn phủ đúng, chỉ mờ) hiển thị. Hết chớp trắng khi zoom.
    const zoomSettling = zoom !== sZoom || displayWidth !== sDisplayW || displayHeight !== sDisplayH;
    if (zoomSettling || !visRect) return null;

    const pageDevW = sDisplayW * dpr;
    const pageDevH = sDisplayH * dpr;

    // Vùng nhìn (device px) + PAD quanh mép, rồi SNAP origin/extent về bội số TILE_SNAP.
    // Snap → khi pan nhỏ, clip_x/y/w/h giữ NGUYÊN giá trị → trùng key cache (3 tầng) → khỏi
    // render lại. Clamp trong [0, pageDev] và trần TILE_MAX (giới hạn set_fixed_size native).
    const snapDown = (v: number) => Math.floor(v / TILE_SNAP) * TILE_SNAP;
    const snapUp = (v: number) => Math.ceil(v / TILE_SNAP) * TILE_SNAP;

    let clipX = snapDown(Math.max(0, visRect.left * dpr - TILE_PAD));
    let clipY = snapDown(Math.max(0, visRect.top * dpr - TILE_PAD));
    const rawRight = snapUp(Math.min(pageDevW, visRect.right * dpr + TILE_PAD));
    const rawBottom = snapUp(Math.min(pageDevH, visRect.bottom * dpr + TILE_PAD));

    let clipW = Math.min(TILE_MAX, rawRight - clipX);
    let clipH = Math.min(TILE_MAX, rawBottom - clipY);
    if (clipW <= 0 || clipH <= 0) return null;

    // Nếu viewport vượt TILE_MAX (zoom vừa, vùng nhìn rộng): tile không phủ hết. Không sao —
    // nền single-tile lo phần ngoài; tile sắc phủ TILE_MAX quanh tâm (nơi mắt nhìn). Kẹp origin
    // để tile bám tâm vùng nhìn khi bị trần.
    const viewCxDev = (visRect.left + visRect.right) / 2 * dpr;
    const viewCyDev = (visRect.top + visRect.bottom) / 2 * dpr;
    if (clipW === TILE_MAX) clipX = snapDown(Math.max(0, Math.min(pageDevW - TILE_MAX, viewCxDev - TILE_MAX / 2)));
    if (clipH === TILE_MAX) clipY = snapDown(Math.max(0, Math.min(pageDevH - TILE_MAX, viewCyDev - TILE_MAX / 2)));

    const cssLeft = clipX / dpr;
    const cssTop = clipY / dpr;
    const cssW = clipW / dpr; // khớp bitmap → KHÔNG stretch
    const cssH = clipH / dpr;

    return (
        <LiveTile
            key={`vp_${clipX}_${clipY}_${clipW}_${clipH}`}
            fileKey={fileKey}
            pageNum={pageNum}
            zoom={sZoom * dpr}
            rot={0}
            clipX={clipX} clipY={clipY} clipW={clipW} clipH={clipH}
            cssLeft={cssLeft} cssTop={cssTop} cssW={cssW} cssH={cssH}
            getTileUrl={getTileUrl}
            onVisible={onVisible}
        />
    );
});

// ═══ VDP text preview với AUTO-FIT ═══
// Bóp cỡ chữ (xuống tối thiểu) để text vừa CHIỀU CAO khung, khớp với engine backend
// (ReportLab cũng bóp theo chiều cao). Khi autoFit === false thì giữ nguyên cỡ chữ.
const VdpAutoFitText = ({ field, scale, text }: any) => {
    const ref = useRef<HTMLSpanElement>(null);
    // Backend render fontSize ở pt THẬT, nhưng khung dùng đơn vị CSS (×96/72). Để preview
    // khớp output, cỡ chữ trên màn = fontSize(pt) × scale × (96/72). scale = displayWidth/pageDim.w.
    const fontPx = (field.fontSize || 10) * scale * (96 / 72);
    const [scaleX, setScaleX] = useState<number>(1);
    const align = field.alignment || 'left';

    useLayoutEffect(() => {
        if (field.autoFit === false) { setScaleX(1); return; }
        const el = ref.current;
        if (!el) return;
        // "Tự bóp chữ vừa khung" = NÉN BỀ RỘNG (scaleX), GIỮ NGUYÊN cỡ chữ/chiều cao.
        // Đo bề rộng tự nhiên (scrollWidth khi whitespace:pre — không xuống dòng) so với
        // bề rộng khung (clientWidth). Nếu tràn ngang → nén ngang cho vừa. Chỉ ngắt dòng
        // ở '\n' người dùng gõ. Parity với backend (canvas scale(sx,1)).
        const natural = el.scrollWidth;
        const avail = el.clientWidth;
        const sx = natural > avail && natural > 0 ? Math.max(0.05, avail / natural) : 1;
        setScaleX(sx);
    }, [text, fontPx, field.width, field.height, field.autoFit, field.fontName, field.fontStyle, field.lineHeight, align]);

    // Nén từ mép TRÁI để khớp backend (canvas scale(sx,1) sau translate về mép trái
    // khung, map [0, bề_rộng_tự_nhiên] → [0, bề_ngang_khung]). Text-align vẫn xử lý
    // vị trí chữ trong khung khi KHÔNG nén (sx=1).
    return (
        <span
            className="overflow-hidden w-full h-full"
            style={{ display: 'flex', alignItems: 'center' }}
        >
            <span
                ref={ref}
                className="whitespace-pre"
                style={{
                    display: 'block',
                    width: '100%',
                    color: field.fontColor || '#1e293b',
                    fontSize: `${fontPx}px`,
                    fontFamily: field.fontName === 'Helvetica' ? 'Arial, sans-serif' : field.fontName === 'Times-Roman' ? '"Times New Roman", serif' : field.fontName === 'Courier' ? 'Courier, monospace' : (field.fontName ? `"${field.fontName}", sans-serif` : 'inherit'),
                    fontWeight: field.fontStyle === 'bold' || field.fontStyle === 'bolditalic' ? 'bold' : 'normal',
                    fontStyle: field.fontStyle === 'italic' || field.fontStyle === 'bolditalic' ? 'italic' : 'normal',
                    lineHeight: field.lineHeight ? `${field.lineHeight}em` : 1,
                    // Backend (ReportLab Paragraph) chưa hỗ trợ tracking → preview cũng bỏ qua để khớp output.
                    letterSpacing: 0,
                    textAlign: align,
                    // NÉN NGANG khi chữ tràn; neo theo hướng căn lề để chữ không trôi khỏi khung.
                    transform: field.autoFit === false ? 'none' : `scaleX(${scaleX})`,
                    transformOrigin: 'left center',
                }}
            >
                {text}
            </span>
        </span>
    );
};

// Một DÒNG text vô hình để QUÉT + COPY (như Acrobat). Đặt span đúng vị trí bbox
// (point → px qua scale), fontSize theo CHIỀU CAO dòng, rồi NÉN NGANG (scaleX) cho
// bề rộng render KHỚP bề rộng thật của dòng trên trang. KHÔNG overflow:hidden/width
// cứng (bản cũ cắt mất chữ tràn + lệch). scaleX đo 1 lần qua offsetWidth (bỏ qua
// transform nên không lặp vô hạn). transformOrigin top-left để neo đúng mép trái-trên.
const SelectableTextLine = ({ line, scale, gapPt }: { line: any; scale: number; gapPt: number }) => {
    const ref = useRef<HTMLSpanElement>(null);
    const [scaleX, setScaleX] = useState(1);
    const text = line.chars?.map((c: any) => c.c).join('') || '';
    const targetW = (line.bbox.w || 0) * scale;
    const h = (line.bbox.h || 0) * scale;
    // KẸP chiều cao khung click ≤ khe tới dòng kế → span KHÔNG chồng mép Y với dòng
    // dưới → kéo 1 dòng không chạm span dòng kề → hết nhảy selection. fontSize vẫn
    // theo h (glyph khớp cỡ chữ gốc); chỉ khung click (height) bị kẹp + overflow ẩn.
    const capH = Math.min(h, gapPt * scale);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || targetW <= 0) { setScaleX(1); return; }
        const natural = el.offsetWidth; // bề rộng tự nhiên (chưa tính transform)
        setScaleX(natural > 0 ? targetW / natural : 1);
    }, [text, h, targetW]);

    return (
        <span
            ref={ref}
            style={{
                position: 'absolute',
                left: line.bbox.x * scale,
                top: line.bbox.y * scale,
                // fontSize = CHIỀU CAO dòng, lineHeight = 1 (KHÔNG px riêng): line-box
                // đúng bằng fontSize nên KHÔNG có "half-leading" đẩy chữ xuống ~9% như
                // bản cũ (fontSize 0.82h < lineHeight h). Đây là cách pdf.js đặt glyph.
                fontSize: `${h}px`,
                lineHeight: 1,
                // Khung click kẹp ≤ khe dòng kế (capH), overflow ẩn phần thừa → span
                // không lấn dòng dưới (fix nhảy dòng 2026-07-07). block để height ăn.
                display: 'block',
                height: capH,
                overflow: 'hidden',
                color: 'transparent',
                whiteSpace: 'pre',
                transform: `scaleX(${scaleX})`,
                transformOrigin: 'left top',
            }}
        >
            {text}
        </span>
    );
};

export const LivePageFrame = (props: any) => {
    //#region Props & State
    const { originalPageNum, actualWidth100, zoom, rotation, bleedView, highlightBoxes, pageDim,
        onObjectDelete,
        getTileUrl, textBlocks, isVdpMode, onVdpBoxCreate, onVdpBoxSelect, onVdpFieldsChange,
        setHoveredPdfPosition, detectedDimension, isBlankDoc, onEditCommit, isActivePage, isImage,
        editSession
    } = props;
    // Trang ĐANG xem (active) trong danh sách ảo (Virtuoso). Chỉ frame active mới
    // đẩy editObjects của mình lên store `currentEditObjects` → panel "Thành phần"
    // luôn khớp ĐÚNG trang người dùng đang chỉnh. Trước đây mọi frame đều ghi đè
    // currentEditObjects (frame chạy sau cùng thắng) nên panel có thể liệt kê object
    // của TRANG KHÁC → tắt mắt một thành phần lại nhắm id không có trên trang active
    // → /edit/preview-hide trả về trang nguyên vẹn → "không có gì thay đổi".
    // Nếu prop không được truyền (consumer cũ) → coi như active để giữ hành vi cũ.
    const isActiveFrame = isActivePage !== false;

    const {
        isObjectEditMode, setCurrentEditObjects, pdfObjectsVersion, selectionFileId, hiddenObjectIds, lockedObjectIds, hiddenOcgLayerIds,
        separationPlates, vdpFields, selectedVdpFieldIds,
        softProofImageUrl, gamutWarningUrl, tacHeatmapUrl, overprintPreviewUrl,
        pdfUrl, setSelectedVdpFieldIds, selectedObjectIds, setSelectedObjectIds,
        isCropMode, editAddMode, setEditAddMode
    } = useWorkspaceStore(useShallow(state => ({
        isObjectEditMode: state.isObjectEditMode,
        editAddMode: state.editAddMode,
        setEditAddMode: state.setEditAddMode,
        setCurrentEditObjects: state.setCurrentEditObjects,
        pdfObjectsVersion: state.pdfObjectsVersion,
        selectionFileId: state.selectionFileId,
        selectedObjectIds: state.selectedObjectIds,
        setSelectedObjectIds: state.setSelectedObjectIds,
        hiddenObjectIds: state.hiddenObjectIds,
        lockedObjectIds: state.lockedObjectIds,
        hiddenOcgLayerIds: state.hiddenOcgLayerIds,
        separationPlates: state.separationPlates,
        vdpFields: state.vdpFields,
        selectedVdpFieldIds: state.selectedVdpFieldIds,
        softProofImageUrl: state.softProofImageUrl,
        gamutWarningUrl: state.gamutWarningUrl,
        tacHeatmapUrl: state.tacHeatmapUrl,
        overprintPreviewUrl: state.overprintPreviewUrl,
        pdfUrl: state.pdfUrl,
        setSelectedVdpFieldIds: state.setSelectedVdpFieldIds,
        isCropMode: state.isCropMode
    })));

    
    const watermarkPreview = useWorkspaceStore(s => s.watermarkPreview);
    // Migrated to imposer store per P1-T03
    const activeDashboardTool = useImposerSettingsStore(s => s.activeDashboardTool);
    const containerRef = useRef<HTMLDivElement>(null);
    const marqueeRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startX: number; startY: number; active: boolean; lastHoverTime?: number }>({ startX: 0, startY: 0, active: false });
    
    const stickPreviewParams = useWorkspaceStore(s => s.stickPreviewParams);
    const viewerNumPages = useWorkspaceStore(s => s.viewerNumPages);

    // VDP Drag/Resize interaction state
    const [vdpInteraction, setVdpInteraction] = useState<{ type: 'move'|'resize', handle?: 'nw'|'ne'|'sw'|'se'|'n'|'s'|'e'|'w', fieldIds: string[], startX: number, startY: number, startFields: Record<string, {x: number, y: number, w: number, h: number, fontSize?: number}> } | null>(null);

    // Menu chuột phải cho khung VDP: xoay nhanh 90° trực tiếp trên khung (song song
    // với dropdown "Xoay (độ)" ở panel). x/y là toạ độ màn hình (fixed), fieldId là
    // field được nhấp phải. Đóng khi click ra ngoài / Escape / chọn xong.
    const [vdpCtxMenu, setVdpCtxMenu] = useState<{ x: number; y: number; fieldId: string } | null>(null);

    // ─── VDP drag/resize: áp dụng theo THỜI GIAN THỰC qua listener WINDOW ───────
    // Bắt sự kiện ở window (không phải div trang) → con trỏ ra ngoài khung vẫn theo
    // dõi (không "dừng giữa chừng"), thả chuột luôn kết thúc (không "dính chuột").
    // Gộp cập nhật store theo requestAnimationFrame để giảm giật.
    // (Đặt ở vùng hooks đầu component để KHÔNG bị các early-return phía dưới làm
    //  lệch số lượng hook giữa các lần render.)
    const vdpRafRef = useRef<number | null>(null);
    const vdpPendingRef = useRef<{ curX: number; curY: number } | null>(null);
    const vdpInteractionRef = useRef(vdpInteraction);
    useEffect(() => { vdpInteractionRef.current = vdpInteraction; }, [vdpInteraction]);

    const applyVdpDrag = (curX: number, curY: number) => {
        const interaction = vdpInteractionRef.current;
        if (!interaction || !onVdpFieldsChange || !pageDim) return;
        const dx = curX - interaction.startX;
        const dy = curY - interaction.startY;
        const scale = (actualWidth100 * zoom) / pageDim.w; // = displayWidth / pageDim.w
        const dxMM = (dx / scale) / 72 * 25.4;
        const dyMM = (dy / scale) / 72 * 25.4;

        // Biên trang theo cùng đơn vị "CSS-mm" với field (pageDim ở px@96).
        const pageWmm = pageDim.w * 25.4 / 72;
        const pageHmm = pageDim.h * 25.4 / 72;
        const clampPos = (v: number, size: number, max: number) => Math.max(0, Math.min(v, Math.max(0, max - size)));

        onVdpFieldsChange((prev: any[]) => prev.map((f: any) => {
            if (!interaction.fieldIds.includes(f.id)) return f;
            const startData = interaction.startFields[f.id];
            if (!startData) return f;

            if (interaction.type === 'move') {
                // Giữ khung nằm trong trang để nội dung không bị MediaBox cắt.
                const x = clampPos(startData.x + dxMM, startData.w, pageWmm);
                const y = clampPos(startData.y + dyMM, startData.h, pageHmm);
                return { ...f, x, y };
            } else if (interaction.type === 'resize') {
                const handle = interaction.handle || 'se';
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
                if (handle.includes('w')) newX = startData.x + (startData.w - newW);
                if (handle.includes('n')) newY = startData.y + (startData.h - newH);
                // Không cho khung vượt biên trang (tránh QR/nội dung tràn rồi bị cắt).
                newX = Math.max(0, newX);
                newY = Math.max(0, newY);
                newW = Math.min(newW, pageWmm - newX);
                newH = Math.min(newH, pageHmm - newY);
                if (f.type === 'qrcode') { const s = Math.max(5, Math.min(newW, newH)); newW = s; newH = s; }
                else { newW = Math.max(5, newW); newH = Math.max(5, newH); }
                // Text + handle GÓC (nw/ne/sw/se): scale cỡ chữ theo khung như Illustrator,
                // thay vì chỉ đổi khung rồi để auto-fit bóp lúc tràn (chữ "kẹt" không co
                // theo khung nữa). Handle CẠNH (n/s/e/w) giữ cỡ chữ — chỉ đổi vùng chảy
                // chữ (giống nới rộng text box). QR/barcode/image không dính.
                if (f.type === 'text' && handle.length === 2 && startData.fontSize) {
                    const ratio = Math.min(newW / startData.w, newH / startData.h);
                    const scaledFs = Math.max(1, Math.round(startData.fontSize * ratio * 10) / 10);
                    return { ...f, x: newX, y: newY, width: newW, height: newH, fontSize: scaledFs };
                }
                return { ...f, x: newX, y: newY, width: newW, height: newH };
            }
            return f;
        }));
    };

    // Xoay field VDP về mức 0/90/180/270 (backend chỉ render 4 mức này). Khi
    // chuyển giữa dọc↔ngang (90/270 vs 0/180) thì hoán width↔height để footprint
    // khung khớp hướng — CÙNG quy ước với updateSelectedField bên DataMergeTool.
    const rotateVdpField = (fieldId: string, newRot: number) => {
        if (!onVdpFieldsChange) return;
        const nr = ((newRot % 360) + 360) % 360;
        onVdpFieldsChange((prev: any[]) => prev.map((f: any) => {
            if (f.id !== fieldId) return f;
            const oldRot = ((Number(f.rotation) || 0) % 360 + 360) % 360;
            const oldVert = oldRot === 90 || oldRot === 270;
            const newVert = nr === 90 || nr === 270;
            if (oldVert !== newVert) {
                return { ...f, rotation: nr, width: f.height, height: f.width };
            }
            return { ...f, rotation: nr };
        }));
    };

    useEffect(() => {
        if (!vdpInteraction) return;
        const flush = () => {
            vdpRafRef.current = null;
            const p = vdpPendingRef.current;
            if (p) applyVdpDrag(p.curX, p.curY);
        };
        const onMove = (e: PointerEvent) => {
            if (!containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
            vdpPendingRef.current = { curX: coords.x, curY: coords.y };
            if (vdpRafRef.current == null) vdpRafRef.current = requestAnimationFrame(flush);
        };
        const onUp = () => {
            if (vdpRafRef.current != null) { cancelAnimationFrame(vdpRafRef.current); vdpRafRef.current = null; }
            const p = vdpPendingRef.current;
            if (p) applyVdpDrag(p.curX, p.curY);
            vdpPendingRef.current = null;
            setVdpInteraction(null);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            if (vdpRafRef.current != null) { cancelAnimationFrame(vdpRafRef.current); vdpRafRef.current = null; }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vdpInteraction]);

    // Đóng menu chuột phải VDP bằng Esc. Click ra ngoài đóng qua BACKDROP (xem
    // phần render) — KHÔNG dùng window 'pointerdown' vì cú chuột phải mở menu có
    // thể tự đóng ngay (race giữa pointerdown mở và listener đóng).
    useEffect(() => {
        if (!vdpCtxMenu) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setVdpCtxMenu(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [vdpCtxMenu]);

    const [editingTextId, setEditingTextId] = useState<string | null>(null);

    // Crop PDF: vùng đã quét (px hệ hiển thị, gốc trên-trái) của TRANG này. Giữ hiển
    // thị tới khi Enter (mở hộp thoại Set Page Boxes) hoặc Esc (huỷ).
    const [cropSel, setCropSel] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
    const [editTextContent, setEditTextContent] = useState<string>('');
    // Font người dùng chọn khi sửa/thêm text (đường dẫn file .ttf/.otf trên máy);
    // rỗng = giữ font gốc nếu được, ngược lại fallback DejaVuSans (hành vi cũ).
    const [editFontPath, setEditFontPath] = useState<string | undefined>(undefined);
    const [editFontName, setEditFontName] = useState<string>('');
    // Danh sách font hệ thống (nạp 1 lần) để TỰ KHỚP font gốc khi mở editor sửa text.
    const systemFontsRef = useRef<{ name: string; path: string }[]>([]);
    // Props text lấy LAZY khi mở editor (tránh trích cho mọi object lúc liệt kê).
    const [editTextColor, setEditTextColor] = useState<number[] | null>(null);
    const [editOrigContent, setEditOrigContent] = useState<string>('');
    const [editOrigFontName, setEditOrigFontName] = useState<string>('');
    const editOpenTokenRef = useRef(0); // chống race khi mở nhanh object khác
    // Thông báo tạm (vd. cảnh báo không giữ được font gốc → dùng font dự phòng).
    const [editNotice, setEditNotice] = useState<string | null>(null);
    useEffect(() => {
        getSystemFonts().then(f => { systemFontsRef.current = Array.isArray(f) ? f : []; }).catch(() => {});
    }, []);
    // Khớp tên font gốc (vd. 'Montserrat-Bold') với một font hệ thống (chuẩn hóa tên).
    const pickFontForName = (name?: string): { name: string; path: string } | null =>
        pickFontForNameUtil(name, systemFontsRef.current);
    // Nội dung trích KHÔNG đáng tin: chứa U+FFFD hoặc ký tự dải mũi tên/kỹ thuật
    // (U+2190–U+23FF) — dấu hiệu glyph→unicode sai (vd. dấu cách → '↔'). Khi đó
    // KHÔNG prefill (tránh ghi lại chữ rác gây thiếu glyph khi đổi font).
    const looksUnreliableText = (s: string): boolean => {
        for (const ch of s) {
            const o = ch.codePointAt(0) ?? 0;
            if (o === 0xFFFD) return true;                 // replacement char
            if (o >= 0x2190 && o <= 0x2BFF) return true;   // arrows, math, technical, box, geometric, misc symbols
            if (o >= 0xE000 && o <= 0xF8FF) return true;   // Private Use Area (font subset remap glyph→PUA)
            if (o >= 0xFFF0 && o <= 0xFFFF) return true;   // specials
            if (o < 0x20 && o !== 0x09 && o !== 0x0A && o !== 0x0D) return true; // control chars
        }
        return false;
    };
    // Thay MỖI ký tự rác (arrow/symbol/PUA/control) bằng DẤU CÁCH — giữ nguyên chữ
    // đọc được. Đa số lỗi là dấu cách giữa từ bị map sai (vd. '↔'), nên thay bằng
    // space cho ra text gần đúng để người dùng sửa nhanh (thay vì để trống).
    const sanitizeText = (s: string): string =>
        Array.from(s).map(c => {
            const o = c.codePointAt(0) ?? 0;
            const bad = o === 0xFFFD
                || (o >= 0x2190 && o <= 0x2BFF)
                || (o >= 0xE000 && o <= 0xF8FF)
                || (o >= 0xFFF0 && o <= 0xFFFF)
                || (o < 0x20 && o !== 0x09 && o !== 0x0A && o !== 0x0D);
            return bad ? ' ' : c;
        }).join('');
    // Mở editor sửa text cho object: mở NGAY (trống) rồi LAZY fetch props
    // (content/màu/font gốc) cho đúng object → điền sẵn + tự khớp font hệ thống.
    const openTextEditor = (o: EditCanvasObj) => {
        const token = ++editOpenTokenRef.current;
        setEditingTextId(o.id);
        setEditTextContent('');
        setEditOrigContent('');
        setEditTextColor(null);
        setEditOrigFontName('');
        setEditFontName('');
        setEditFontPath(undefined);
        if (!selectionFileId) return;
        const page = originalPageNum - 1;
        void (async () => {
            try {
                const res = await authenticatedFetch(`${getApiUrl()}/edit/text-props/${selectionFileId}/${page}/${o.drawIndex}`);
                if (!res.ok) return;
                const p = await res.json();
                if (editOpenTokenRef.current !== token) return; // đã mở object khác → bỏ
                const raw = typeof p.content === 'string' ? p.content : '';
                // Text trích ra có thể chứa ký tự RÁC do font mã hoá riêng (vd. dấu
                // cách → '↔'). Nhưng chữ thường VẪN ĐÚNG → THAY ký tự rác bằng dấu
                // cách rồi PREFILL (giữ phần đọc được) để người dùng sửa nhanh.
                const dirty = raw !== '' && looksUnreliableText(raw);
                const content = dirty ? sanitizeText(raw) : raw;
                setEditTextContent(content);
                setEditOrigContent(content);
                setEditTextColor(Array.isArray(p.color) ? p.color : null);
                setEditOrigFontName(typeof p.fontName === 'string' ? p.fontName : '');
                const m = pickFontForName(p.fontName);
                if (m && m.path) { setEditFontName(m.name); setEditFontPath(m.path); }
                else { setEditFontName(p.fontName || ''); setEditFontPath(undefined); }
            } catch { /* giữ editor trống nếu lỗi */ }
        })();
    };
    
    // Preview image state (driven by hiddenObjectIds prop from parent)
    const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);

    // Overlay xem-trước từ edit-session (/edit/session/op): áp op trong RAM backend →
    // render VÙNG CLIP (hoặc toàn trang nếu full) → dán ĐÈ lên tile TẠI CHỖ, KHÔNG
    // reload file. `rect` = [left,top,right,bottom] px canvas (đã quy đổi từ clipRect
    // point qua clipRectPdfToCanvas); `full=true` → phủ cả trang (inset-0).
    //
    // MẢNG (không phải 1 overlay): mỗi op chỉ vẽ lại VÙNG của nó. Nhiều op liên tiếp
    // TRƯỚC khi commit ngầm (~1.5s) phải CHỒNG lên nhau — nếu chỉ giữ 1 overlay, op
    // sau xóa "bản vá" op trước → nội dung cũ ở vùng trước hiện lại. `full=true` dọn
    // sạch mảng (đã phủ cả trang). Dọn toàn bộ khi pdfUrl đổi (tile thật đã bake).
    type SessionOverlay = { url: string; rect: [number, number, number, number] | null; full: boolean };
    const [sessionPreviews, setSessionPreviews] = useState<SessionOverlay[]>([]);
    // Tăng sau mỗi applyOp để ép effect nạp lại /edit/objects (session-aware → trả
    // trạng thái Live_Document sau op) mà KHÔNG cần đổi selectionFileId → khung chọn
    // bám vị trí MỚI + danh sách object cập nhật cho add/delete, không chờ commit.
    const [editObjectsVersion, setEditObjectsVersion] = useState(0);

    // ─── Edit PDF Object — Hit-test + overlay (task 10.1) ────────────────────
    // Nguồn dữ liệu object lấy từ GET /edit/objects (Geometry_Reader, PDFium read-only).
    // Tách biệt khỏi globalPdfObjectCache (luồng /preflight) vì khác hệ tọa độ + khác
    // id-space → tránh phá vỡ delete/hide preflight hiện có.
    const [editObjects, setEditObjects] = useState<EditCanvasObj[]>([]);

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
    // Gốc CropBox (bx0,by0) point của TRANG hiện tại — dùng cho add-text/image.
    const editCropOriginRef = useRef<[number, number]>([0, 0]);
    // GIỮ ghost ở vị trí vừa thả tới khi overlay cập nhật vị trí MỚI (sau commit)
    // → bỏ hiện tượng khung chọn "giật về chỗ cũ rồi nhảy tới chỗ mới".
    const editGhostHoldRef = useRef<boolean>(false);
    const editGhostHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Giữ targetIds đã chọn qua vòng commit (setSelectionFileId xóa selection) →
    // sau khi /edit/objects refetch, re-select để khung bám chữ vừa kéo (tránh "mất chữ").
    const pendingReselectIdsRef = useRef<string[] | null>(null);
    // Ref cho listener window (tránh stale closure khi pointermove).
    const editInteractionRef = useRef(editInteraction);
    useEffect(() => { editInteractionRef.current = editInteraction; }, [editInteraction]);

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
    // editAddMode: chế độ "đặt object mới" (nay ở STORE dùng chung — nút điều khiển ở
    // panel phải, cú bấm kế tiếp lên BẤT KỲ trang nào sẽ đặt object tại đó). editAddDraft:
    // điểm bấm đã chốt theo hệ CANVAS top-left (point) — convert sang PDF bottom-left khi
    // gửi /edit/add. editFileInputRef: input file ẩn để chọn ảnh khi thêm image.
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
    // trang dù cắt ô, nên tiling chỉ làm chậm gấp N). Render ĐÚNG zoom×dpr (đủ nét cho
    // màn hình, ÍT pixel nhất → mở file nhanh). KHÔNG làm tròn scale lên nấc cao (từng
    // làm tròn lên gây render dư pixel → chậm trên màn HiDPI).
    const computeRenderZoom = (z: number) => {
        const dpr = (window.devicePixelRatio || 1);
        const target = Math.max(dpr, z * dpr);
        const w100 = actualWidth100 || 800;
        const ratio = (pageDim && pageDim.w) ? Math.max(1, pageDim.h / pageDim.w) : 1.414;
        // Cap bộ nhớ: cạnh dài bitmap ≤ 6000px (1 render). Native tự clamp ≤8000.
        // Trần cứng 24 (trước là 7.5): file NHỎ (danh thiếp) zoom sâu bị 7.5 chặn sớm
        // hơn ngân sách RAM thật (6000px) → mờ. Nay để capByBudget (6000px) khống chế
        // → file nhỏ nét hơn ~2.3× mà KHÔNG tăng RAM (file lớn vẫn bị capByBudget chặn
        // trước 24). Native render_scale clamp cũng nâng 10→34 cho khớp (audit render).
        const capByBudget = 6000 / (w100 * ratio);
        return Math.max(dpr, Math.min(24, target, capByBudget));
    };
    const [renderZoom, setRenderZoom] = useState(() => computeRenderZoom(zoom));

    useEffect(() => {
        const timeoutId = setTimeout(() => {
            setRenderZoom(computeRenderZoom(zoom));
        }, 250);
        return () => clearTimeout(timeoutId);
    }, [zoom]);

    // ─── Edit PDF Object: nạp danh sách object từ /edit/objects (task 10.1) ───
    // Khi vào Selection_Mode, gọi GET /edit/objects/{fid}/{pageIndex} (0-based) để lấy
    // ObjMeta (bbox hệ PDF bottom-left) rồi convert sang hệ canvas top-left bằng
    // chiều cao trang (pageDim.h, point) — dùng chung công thức `x * scale` với overlay.
    useEffect(() => {
        if (!isObjectEditMode || originalPageNum === -1 || !selectionFileId || !pageDim?.h) {
            // QUAN TRỌNG (fix vòng lặp "Maximum update depth"): selectedObjectIds là STORE
            // dùng chung MỌI LivePageFrame. Set về `[]` MỚI mỗi lần effect chạy → đổi tham
            // chiếu → useShallow coi là thay đổi → re-render mọi frame → cascade vô hạn
            // (đặc biệt khi nhiều frame ảo Virtuoso + preview re-render liên tục, frame
            // không ở edit-mode liên tục chạy nhánh này). Dùng updater IDEMPOTENT: khi đã
            // rỗng thì giữ NGUYÊN tham chiếu → React/Zustand bail-out, không re-render thừa.
            setEditObjects(prev => (prev.length ? [] : prev));
            setSelectedObjectIds(prev => (prev.length ? [] : prev));
            return;
        }
        const pageIndex = originalPageNum - 1; // /edit dùng chỉ số 0-based
        const cacheKey = `${selectionFileId}:${pageIndex}`;

        // Cache-hit → dùng ngay, KHÔNG fetch lại (bật/tắt chế độ không tải lại).
        // Sau transform, cache bị clear (pdfUrl/fid đổi) nên thường miss; nếu hit
        // vẫn tôn trọng pendingReselectIdsRef.
        const cached = _editObjectsCache.get(cacheKey);
        if (cached) {
            setEditObjects(cached);
            const pending = pendingReselectIdsRef.current;
            pendingReselectIdsRef.current = null;
            if (pending && pending.length) {
                const alive = pending.filter(id => cached.some(o => o.id === id));
                setSelectedObjectIds(alive.length ? alive : []);
            } else {
                setSelectedObjectIds(prev => (prev.length ? [] : prev));
            }
            editCropOriginRef.current = _editCropOriginCache.get(cacheKey) || [0, 0];
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
                // CropBox offset: object bbox từ PDFium ở hệ user-space NATIVE. Trang
                // hiển thị (tile) render theo CropBox → cần TRỪ gốc CropBox (bx0,by0)
                // để overlay khớp ảnh. File thường có gốc (0,0) → no-op; file Illustrator
                // hay có CropBox/MediaBox lệch gốc → fix lệch tọa độ (rủi ro audit #1).
                const pb = Array.isArray(data.pageBox) && data.pageBox.length === 4 ? data.pageBox : null;
                const bx0 = pb ? Number(pb[0]) || 0 : 0;
                const by0 = pb ? Number(pb[1]) || 0 : 0;
                editCropOriginRef.current = [bx0, by0];
                const objs: EditCanvasObj[] = (data.objects || []).map((o: any) => {
                    const cbbox = objectBboxNativeToCanvas(o.bbox as BBox, pageHeightPt, bx0, by0);
                    return {
                        id: o.id,
                        drawIndex: o.drawIndex,
                        type: o.type as ObjType,
                        bbox: cbbox,
                        matrix: o.matrix ?? undefined,
                        content: o.content ?? undefined,
                        color: Array.isArray(o.color) ? o.color : undefined,
                        fontName: o.fontName ?? undefined,
                    };
                });
                _editObjectsCache.set(cacheKey, objs); // Lưu cache cho lần bật/tắt sau.
                _editCropOriginCache.set(cacheKey, [bx0, by0]);
                setEditObjects(objs);
                // Sau move/transform: re-select đúng id (cùng text-0…) để khung bám
                // vị trí MỚI — nếu clear selection, chữ đã dịch dễ bị tưởng "mất".
                const pending = pendingReselectIdsRef.current;
                pendingReselectIdsRef.current = null;
                if (pending && pending.length) {
                    const alive = pending.filter(id => objs.some(o => o.id === id));
                    setSelectedObjectIds(alive.length ? alive : []);
                } else {
                    setSelectedObjectIds(prev => (prev.length ? [] : prev));
                }
                hideEditGhost(); // Overlay đã ở vị trí mới → bỏ ghost giữ.
            } catch (err) {
                if (!cancelled) {
                    console.warn('[edit] Không tải được /edit/objects:', err);
                    setEditObjects(prev => (prev.length ? [] : prev));
                    setSelectedObjectIds(prev => (prev.length ? [] : prev));
                    const m = err instanceof Error ? err.message : String(err);
                    // 404 = fid/file không còn trên backend (thường sau khi RESTART
                    // server, file tải lên cũ đã mất) → hướng dẫn mở lại file.
                    if (/HTTP 404/.test(m)) {
                        setEditNotice('Không tải được đối tượng: file này không còn trên server (có thể do khởi động lại). Hãy MỞ LẠI file để chỉnh sửa.');
                    } else {
                        setEditNotice('Không tải được danh sách đối tượng để chỉnh sửa. Thử mở lại file hoặc khởi động lại app.');
                    }
                    setTimeout(() => setEditNotice(null), 8000);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [isObjectEditMode, originalPageNum, selectionFileId, pageDim?.h, editObjectsVersion]);

    // ─── Edit PDF Object: đồng bộ object của TRANG ACTIVE lên panel (fix tắt mắt) ─
    // Panel "Thành phần" đọc store `currentEditObjects`. Vì danh sách trang là ảo
    // (Virtuoso) nên có nhiều LivePageFrame cùng sống; CHỈ frame đang xem mới được
    // đẩy editObjects của mình lên store → panel liệt kê đúng object trang active,
    // nên khi tắt mắt một thành phần, id nhắm trúng trang active và /edit/preview-hide
    // thực sự ẩn object (overlay preview đắp lên trang). Bỏ chọn cũ của trang khác.
    useEffect(() => {
        if (!isObjectEditMode || !isActiveFrame || !setCurrentEditObjects) return;
        setCurrentEditObjects(editObjects);
    }, [isObjectEditMode, isActiveFrame, editObjects, setCurrentEditObjects]);

    // ─── Edit PDF Object: Ctrl+A chọn tất cả / Esc bỏ chọn / Delete xóa (task 10.1) ─
    // CHỈ frame ĐANG XEM (isActiveFrame) mới xử lý phím: listener gắn trên `window` nên
    // MỌI LivePageFrame còn mount (Virtuoso giữ nhiều frame sống) đều nghe. selectedObjectIds/
    // selectionFileId là store DÙNG CHUNG nhưng originalPageNum RIÊNG mỗi frame → nếu không
    // gate, bấm Delete khiến mọi frame gửi /edit/delete với cùng targetIds lên TRANG KHÁC
    // (nơi id không tồn tại) → backend trả 404 + toast lỗi, dù frame active đã xóa thành công.
    useEffect(() => {
        if (!isObjectEditMode || isVdpMode || !isActiveFrame) return;
        const onKey = (e: KeyboardEvent) => {
            // Bỏ qua khi đang gõ trong input/textarea (vd. editor text inline).
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                setSelectedObjectIds(editObjects.filter(o => !lockedObjectIds.includes(o.id)).map(o => o.id));
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                // Xóa tập object đang chọn → POST /edit/delete → Working_File mới.
                if (editBusy || selectedObjectIds.length === 0) return;
                e.preventDefault();
                const op: EditOp = {
                    page: originalPageNum - 1,
                    kind: 'delete',
                    targetIds: [...selectedObjectIds],
                };
                const idsToClear = [...selectedObjectIds];
                void sendEditAndPreview(op).then(() => {
                    // Bỏ chọn sau khi đã commit (object cũ không còn trên trang mới).
                    setSelectedObjectIds(prev => prev.filter(id => !idsToClear.includes(id)));
                });
            } else if (e.key === 'Escape') {
                setSelectedObjectIds([]);
                // task 10.3: thoát chế độ đặt object mới đang chờ (nếu có).
                setEditAddMode(null);
                setEditAddDraft(null);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isObjectEditMode, isVdpMode, isActiveFrame, editObjects, selectedObjectIds, editBusy, originalPageNum, selectionFileId, onEditCommit, lockedObjectIds]);

    // ─── Edit PDF Object: reset transform tạm + preview khi đổi lựa chọn (10.2) ─
    // Khi tập chọn thay đổi (hoặc bỏ chọn), bỏ transform tạm và ảnh preview cũ để
    // overlay không "dính" trạng thái của lần thao tác trước.
    useEffect(() => {
        editLiveTransformRef.current = null;
    }, [selectedObjectIds]);

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
        // Tile thật (Working_File mới) đã vào sau commit ngầm → bỏ overlay session cũ
        // (nội dung overlay ĐÃ bake vào tile mới; giữ lại sẽ chồng đôi khi op kế tiếp).
        setSessionPreviews(prev => (prev.length ? [] : prev));
        // Bỏ selection cũ (trỏ object của file/trang trước) để không highlight chéo.
        setSelectedObjectIds(prev => (prev.length ? [] : prev));
    }, [pdfUrl]);

    // LƯU Ý: KHÔNG return sớm cho originalPageNum === -1 ở đây. Trước kia khối này
    // đặt TRƯỚC nhiều hook bên dưới (useEffect 845/949/1100/1104...), nên khi một
    // frame đổi originalPageNum giữa -1 và số trang thật, số hook gọi bị lệch →
    // React error #300 crash. Đã dời xuống SAU TẤT CẢ hook (ngay trước Render).

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

                // ─── Edit mode: ẩn HÌNH THẬT của object qua render read-only ───
                // Gọi /edit/preview-hide (pikepdf xóa in-memory → PDFium render, KHÔNG
                // ghi file). Ảnh trả về là TRANG ĐÃ LOẠI object bị ẩn → đắp overlay
                // toàn trang khớp khung trang (objectFit:fill). hiddenObjectIds cùng
                // id-space với /edit/objects nên truyền thẳng làm targetIds.
                if (isObjectEditMode) {
                    const res = await authenticatedFetch(`${getApiUrl()}/edit/preview-hide`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            fid: selectionFileId,
                            page: originalPageNum - 1, // /edit dùng chỉ số 0-based
                            targetIds: hiddenObjectIds,
                        })
                    });
                    if (!res.ok) throw new Error(`/edit/preview-hide HTTP ${res.status}`);
                    const data = await res.json();
                    if (isMounted && data.image) {
                        setPreviewImageUrl(data.image);
                    }
                    return;
                }

                // Fallback to hidden object preview (legacy, ngoài edit mode)
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
                if (isMounted) setPreviewImageUrl(null);
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
    }, [hiddenObjectIds, hiddenOcgLayerIds, selectionFileId, originalPageNum, pdfObjectsVersion, isObjectEditMode]);
    
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

    // Crop PDF: dọn vùng quét khi tắt chế độ crop.
    useEffect(() => { if (!isCropMode) setCropSel(null); }, [isCropMode]);

    // Crop PDF: Enter → mở hộp thoại Set Page Boxes với fractions vùng quét; Esc → huỷ.
    // Chỉ frame ĐANG GIỮ vùng quét (cropSel) mới gắn listener → không trùng lặp.
    useEffect(() => {
        if (!isCropMode || !cropSel) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                if (!pageDim?.w || !pageDim?.h) return;
                const dW = displayWidth || 1;
                const dH = displayHeight || 1;
                const clamp = (v: number) => Math.max(0, Math.min(1, v));
                const frac = {
                    x0: clamp(cropSel.x / dW),
                    y0: clamp(cropSel.y / dH),
                    x1: clamp((cropSel.x + cropSel.w) / dW),
                    y1: clamp((cropSel.y + cropSel.h) / dH),
                };
                e.preventDefault();
                window.dispatchEvent(new CustomEvent('prynx-crop-open', {
                    detail: { pageNum: originalPageNum, frac },
                }));
            } else if (e.key === 'Escape') {
                setCropSel(null);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isCropMode, cropSel, pageDim, displayWidth, displayHeight, originalPageNum]);
    // Panel → canvas: khi selection đổi (vd click dòng trong panel Thành phần), cuộn
    // overlay object đầu được chọn vào tầm nhìn. Chỉ frame CHỨA overlay đó mới cuộn
    // (query data-obj-id trong containerRef; frame khác không có node → bỏ qua). Dùng
    // lastScrolledId để chỉ cuộn khi id đầu ĐỔI, tránh cuộn lặp mỗi render. Khung viền
    // outline đã có sẵn ở overlay (isSelected) nên không cần thêm. (gộp F7↔edit 2026-07-07)
    const lastScrolledIdRef = useRef<string | null>(null);
    useEffect(() => {
        if (!isObjectEditMode) { lastScrolledIdRef.current = null; return; }
        const firstId = selectedObjectIds[0];
        if (firstId == null) { lastScrolledIdRef.current = null; return; }
        if (lastScrolledIdRef.current === firstId) return;
        const node = containerRef.current?.querySelector(`[data-obj-id="${firstId}"]`);
        if (node) {
            lastScrolledIdRef.current = firstId;
            node.scrollIntoView({ block: 'center', inline: 'center' });
        }
    }, [selectedObjectIds, isObjectEditMode]);

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
        const sel = editObjects.filter(o => selectedObjectIds.includes(o.id));
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
        // tiếp qua window pointermove). KHÔNG setState mỗi frame.
        editLiveTransformRef.current = null;
        if (editGhostRef.current) {
            editGhostRef.current.style.transform = 'none';
            editGhostRef.current.style.transformOrigin = 'center center';
            editGhostRef.current.style.display = 'block';
        }
        setEditInteraction({ type, handle, startX: coords.x, startY: coords.y, startBox });
        // KHÔNG releasePointerCapture — listener window vẫn nhận pointermove/up dù
        // kéo ra ngoài khung (trước đây rời khung = hủy, dễ commit dở / ghost mất).
        e.preventDefault();
        e.stopPropagation();
    };

    // ─── Edit PDF Object: áp op qua EDIT-SESSION in-memory (đường DUY NHẤT) ────
    // Thay cho đường legacy (POST /edit/transform|text|add|delete → ghi file mới →
    // reload cả file). Session áp op trong RAM backend + render VÙNG CLIP → dán overlay
    // ĐÈ lên tile TẠI CHỖ (KHÔNG đổi pdfUrl, KHÔNG reload). Debounce-commit của hook tự
    // ghi đĩa ngầm ~1.5s → onCommit đổi pdfUrl sang tile thật MỘT lần (nền).
    //
    // Trả true nếu áp thành công. Session lỗi/410 → hook đã markFailed + báo lỗi (không
    // fallback). Lỗi op (409/422...) → ném để caller hiển thị thông báo phù hợp.
    const applyOpViaSession = async (op: EditOp): Promise<SessionOpOutcome | null> => {
        if (!editSession) {
            setEditNotice('Phiên chỉnh sửa chưa sẵn sàng — hãy mở lại file để chỉnh sửa.');
            setTimeout(() => setEditNotice(null), 6000);
            return null;
        }
        if (!pageDim?.w) return null;
        // Scale render clip: px THIẾT BỊ / point (css px/point × dpr) → ảnh clip đủ nét.
        const cssScale = calcEditScale(displayWidth, pageWidthPtFromDim(pageDim.w));
        const dpr = window.devicePixelRatio || 1;
        setEditBusy(true);
        try {
            const outcome = await editSession.applyOp(op, Math.max(0.5, cssScale * dpr));
            // null = phiên hỏng/410 (hook đã markFailed → onSessionFailed báo lỗi).
            if (!outcome || !outcome.success) return null;

            // Dán overlay preview: full → phủ cả trang; ngược lại định vị theo clipRect
            // (point, Page_Box-relative, gốc dưới-trái) → px canvas qua clipRectPdfToCanvas.
            const pageHeightPt = pageHeightPtFromDim(pageDim.h);
            const [bx0, by0] = editCropOriginRef.current;
            let rect: [number, number, number, number] | null = null;
            if (!outcome.full && outcome.clipRect) {
                const r = clipRectPdfToCanvas(outcome.clipRect as BBox, pageHeightPt, bx0, by0, cssScale);
                rect = [r[0], r[1], r[2], r[3]];
            }
            // Chồng overlay (không thay thế): op sau render TỪ live-bytes đã gồm op trước,
            // nên nếu vùng trùng thì overlay mới (trên cùng) đúng; vùng khác giữ cả hai.
            setSessionPreviews(prev => [...prev, { url: outcome.preview, rect, full: outcome.full }]);

            // Refetch /edit/objects (session-aware → đọc Live_Document) để khung chọn bám
            // vị trí MỚI + danh sách cập nhật (add/delete). Cache clear để chắc chắn miss.
            clearEditObjectsCache();
            setEditObjectsVersion(v => v + 1);
            return outcome;
        } finally {
            setEditBusy(false);
        }
    };

    // Khi MOUSE UP: dựng EditOp từ transform tạm rồi áp qua edit-session (1 lần).
    // Đây là ĐIỂM DUY NHẤT gọi backend (KHÔNG gọi khi đang kéo — Yêu cầu 13.2).
    //
    // CHUYỂN TRỤC tọa độ (canvas top-left, y xuống ↔ PDF bottom-left, y lên):
    //  - move : move_objects mặc định coord_space='pdf', nên FE gửi delta ở hệ PDF:
    //           dx giữ nguyên, dy_pdf = -dy_canvas.
    //  - resize: anchor = góc đối diện handle kéo; nhãn nw/ne/sw/se theo VỊ TRÍ NHÌN
    //           THẤY trùng ngữ nghĩa _anchor_point backend ('n'=mép trên) nên gửi thẳng.
    //  - rotate: rotateDeg backend dương = NGƯỢC chiều kim đồng hồ (hệ PDF y lên);
    //           góc đo trên màn (y xuống) dương theo chiều kim đồng hồ → đảo dấu.
    const commitEditTransform = async (lt: EditLiveTransform | null) => {
        if (!lt || !selectionFileId || !pageDim?.w || selectedObjectIds.length === 0) {
            return;
        }
        // Guard an toàn: nếu MỌI object đang chọn đều bị khóa → KHÔNG transform.
        if (selectedObjectIds.every(id => lockedObjectIds.includes(id))) {
            return;
        }
        const scale = calcEditScale(displayWidth, pageWidthPtFromDim(pageDim.w)); // px canvas / POINT
        const page = originalPageNum - 1;       // /edit dùng 0-based
        let op: EditOp | null = null;

        if (lt.kind === 'move') {
            if (Math.abs(lt.dx) < 0.5 && Math.abs(lt.dy) < 0.5) { return; }
            // Guard: scale hỏng / zoom 0 → delta Infinity → chữ bay khỏi trang ("mất").
            if (!Number.isFinite(scale) || scale < 1e-6) {
                console.warn('[edit] scale không hợp lệ, bỏ move', scale);
                return;
            }
            const delta = moveDeltaCanvasToPdf(lt.dx, lt.dy, scale);
            if (!Number.isFinite(delta.dx) || !Number.isFinite(delta.dy)) {
                console.warn('[edit] delta không hợp lệ, bỏ move', delta);
                return;
            }
            // Chặn delta quá lớn (kéo nhầm / scale lệch) — tối đa 2× khổ trang.
            const pageW = pageWidthPtFromDim(pageDim.w);
            const pageH = pageHeightPtFromDim(pageDim.h);
            const maxD = Math.max(pageW, pageH) * 2;
            if (Math.abs(delta.dx) > maxD || Math.abs(delta.dy) > maxD) {
                console.warn('[edit] delta quá lớn, bỏ move', delta, { pageW, pageH });
                setEditNotice('Độ dịch quá lớn — thử kéo nhẹ hơn hoặc zoom vừa phải rồi kéo lại.');
                setTimeout(() => setEditNotice(null), 5000);
                hideEditGhost();
                return;
            }
            op = { page, kind: 'move', targetIds: selectedObjectIds, delta };
        } else if (lt.kind === 'resize') {
            if (Math.abs(lt.sx - 1) < 0.002 && Math.abs(lt.sy - 1) < 0.002) { return; }
            op = { page, kind: 'resize', targetIds: selectedObjectIds, scale: { sx: lt.sx, sy: lt.sy, anchor: lt.anchor } };
        } else {
            if (Math.abs(lt.rotateDeg) < 0.5) { return; }
            op = { page, kind: 'rotate', targetIds: selectedObjectIds, rotateDeg: rotationScreenToPdf(lt.rotateDeg) };
        }

        // Giữ selection id qua vòng refetch objects (khung chọn bám vị trí MỚI).
        pendingReselectIdsRef.current = [...selectedObjectIds];
        try {
            const outcome = await applyOpViaSession(op);
            if (!outcome) {
                // null = phiên hỏng (hook đã báo lỗi) → bỏ ghost, không kẹt ở chỗ thả.
                hideEditGhost();
                return;
            }
            // Overlay clip đã dán tại chỗ; ghost dashed bỏ đi (overlay là hình thật mới).
            hideEditGhost();
        } catch (err: any) {
            console.warn('[edit] transform (session) thất bại:', err);
            const msg = String(err?.message || err);
            if (msg.includes('409') || msg.includes('ánh xạ') || msg.includes('map')) {
                setEditNotice('Đối tượng quá phức tạp (clip/XObject) — không thể biến đổi an toàn. Thử Delete hoặc sửa ở file nguồn.');
            } else {
                setEditNotice(`Di chuyển thất bại: ${msg.slice(0, 120)}`);
            }
            setTimeout(() => setEditNotice(null), 7000);
            hideEditGhost(); // Commit lỗi → bỏ ghost giữ (tránh kẹt ở vị trí thả).
        }
    };

    // ─── Edit PDF Object (task 10.3): gửi EditOp qua EDIT-SESSION ─────────────
    // Helper dùng chung cho editText/add/delete: áp op qua `applyOpViaSession`
    // (in-memory, render clip → overlay tại chỗ, KHÔNG reload file). Giữ cảnh báo
    // font-fallback (đọc từ `outcome.opResult.detail`) + map lỗi 409/422 sang thông
    // báo thân thiện. `endpoint` không còn dùng (session lo mọi kind) — giữ signature
    // để tối thiểu thay đổi caller.
    const sendEditAndPreview = async (op: EditOp) => {
        if (!selectionFileId) return;
        try {
            const outcome = await applyOpViaSession(op);
            if (!outcome) return; // phiên hỏng/410 — onSessionFailed đã báo lỗi.
            // Cảnh báo khi KHÔNG giữ được font gốc và người dùng CHƯA chọn font →
            // đã âm thầm dùng font dự phòng (DejaVuSans). detail = serialize op_result.
            const r: any = (outcome as any).opResult?.detail;
            const usedFallback = Array.isArray(r) ? r.some((x: any) => x?.used_fallback) : !!r?.used_fallback;
            if (usedFallback && !editFontPath) {
                setEditNotice('Không giữ được font gốc → đã dùng font dự phòng (DejaVuSans). Mở lại để chọn font ở thanh "FONT" nếu muốn đúng kiểu chữ.');
                setTimeout(() => setEditNotice(null), 6000);
            }
        } catch (err) {
            console.warn('[edit] thao tác thất bại:', err);
            const msg = err instanceof Error ? err.message : String(err);
            let friendly: string;
            if (/HTTP 422/.test(msg)) {
                // Thiếu glyph (font đã chọn không có ký tự cần) — thường do nội dung
                // gốc đọc không chuẩn hoặc font thiếu dấu tiếng Việt.
                friendly = 'Không đổi được: font đã chọn THIẾU GLYPH cho một số ký tự. '
                    + 'Hãy gõ lại đúng nội dung, hoặc chọn font khác có đủ dấu tiếng Việt.';
            } else if (/HTTP 409/.test(msg)) {
                friendly = 'Không sửa được: không xác định được đối tượng duy nhất (đã hủy để bảo toàn màu in).';
            } else {
                friendly = 'Thao tác chỉnh sửa thất bại. Thử lại hoặc chọn font/nội dung khác.';
            }
            setEditNotice(friendly);
            setTimeout(() => setEditNotice(null), 7000);
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
        await sendEditAndPreview(op);
    };

    // Thêm cụm text MỚI tại điểm bấm. CONVERT TỌA ĐỘ: draft.{xPt,yPt} ở hệ canvas
    // top-left (point); backend add_text dùng hệ PDF bottom-left → yPDF = pageH - yCanvas.
    // bbox = [x0, pageH - yBottomCanvas, x1, pageH - yTopCanvas].
    const commitAddTextObject = async (content: string, draft: { xPt: number; yPt: number }) => {
        if (!selectionFileId || !pageDim?.w || !pageDim?.h || !content.trim()) return;
        const pageH = pageDim.h * 72 / 96; // px@96 → POINT (draft.{xPt,yPt} đã ở point)
        const hPt = EDIT_ADD_TEXT_SIZE_PT * 1.6;
        const [bx0, by0] = editCropOriginRef.current; // gốc CropBox → quy về PDF NATIVE
        const bbox: BBox = addBboxCanvasToNative(draft.xPt, draft.yPt, EDIT_ADD_TEXT_W_PT, hPt, pageH, bx0, by0);
        const op: EditOp = {
            page: originalPageNum - 1, kind: 'add',
            targetIds: [], text: { content, sizePt: EDIT_ADD_TEXT_SIZE_PT, bbox, font: editFontPath },
        };
        await sendEditAndPreview(op);
    };

    // Thêm ảnh MỚI tại điểm bấm (dataUrl base64). CONVERT TỌA ĐỘ giống add-text:
    // bbox vuông EDIT_ADD_IMAGE_SIZE_PT ở hệ PDF bottom-left (yPDF = pageH - yCanvas).
    const commitAddImageObject = async (dataUrl: string, draft: { xPt: number; yPt: number }) => {
        if (!selectionFileId || !pageDim?.w || !pageDim?.h || !dataUrl) return;
        const pageH = pageDim.h * 72 / 96; // px@96 → POINT (draft.{xPt,yPt} đã ở point)
        const sz = EDIT_ADD_IMAGE_SIZE_PT;
        const [bx0, by0] = editCropOriginRef.current; // gốc CropBox → quy về PDF NATIVE
        const bbox: BBox = addBboxCanvasToNative(draft.xPt, draft.yPt, sz, sz, pageH, bx0, by0);
        const op: EditOp = {
            page: originalPageNum - 1, kind: 'add',
            targetIds: [], image: { dataRef: dataUrl, bbox },
        };
        await sendEditAndPreview(op);
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        if ((!isObjectEditMode && !isVdpMode && !isCropMode) || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        dragRef.current = { startX: coords.x, startY: coords.y, active: true };
        if (isCropMode) setCropSel(null); // bắt đầu quét vùng mới → xoá vùng cũ
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

        // ─── Edit PDF Object (task 10.2): KHI ĐANG KÉO object, listener WINDOW
        // (`onMove` trong useEffect) đã lo TRỌN việc cập nhật ghost (move/resize/
        // rotate) qua DOM ref — nó chỉ active đúng lúc editInteraction bật. Handler
        // React này nếu chạy tiếp sẽ (1) gọi getBoundingClientRect() LẦN NỮA (ép
        // layout thrash 2×/lần di chuột) và (2) bắn setHoveredPdfPosition vào store
        // mỗi 50ms (crosshair vô nghĩa khi kéo) → giật. Return sớm để hết trùng lặp.
        if (editInteraction) return;

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

        if (vdpInteraction) {
            // VDP move/resize được xử lý qua listener WINDOW (xem useEffect bên dưới)
            // để không bị mất sự kiện khi con trỏ rời khung → mượt + không kẹt.
            return;
        }

        if (!dragRef.current.active || (!isObjectEditMode && !isCropMode)) return;
        const { startX, startY } = dragRef.current;
        // Direct DOM update — no React re-render
        if (marqueeRef.current) {
            marqueeRef.current.style.left = `${Math.min(startX, curX)}px`;
            marqueeRef.current.style.top = `${Math.min(startY, curY)}px`;
            marqueeRef.current.style.width = `${Math.abs(curX - startX)}px`;
            marqueeRef.current.style.height = `${Math.abs(curY - startY)}px`;
        }
    };

    const handleMouseUp = (e: React.MouseEvent) => {
        // Edit drag kết thúc ở window pointerup (useEffect) — không commit ở đây
        // để tránh double-commit khi vừa pointerup vừa mouseup.
        if (editInteraction) {
            return;
        }
        if (vdpInteraction) {
            setVdpInteraction(null);
            return;
        }
        if (!dragRef.current.active || (!isObjectEditMode && !isVdpMode && !isCropMode) || !containerRef.current) {
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

        // ─── Crop PDF: chốt vùng quét (giữ hiển thị để nhấn Enter mở hộp thoại) ───
        if (isCropMode) {
            if (x2 - x1 < 5 || y2 - y1 < 5) { setCropSel(null); return; }
            setCropSel({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
            return;
        }
        
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
                setSelectedObjectIds([]); return;
            }
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
            const picked = [...selectedObjectIds];
            editObjects.forEach((obj) => {
                if (lockedObjectIds.includes(obj.id)) return; // object bị khóa: bỏ qua marquee
                const [ox0, oy0, ox1, oy1] = obj.bbox;
                const left = ox0 * editScale, top = oy0 * editScale;
                const right = ox1 * editScale, bottom = oy1 * editScale;
                if (left < x2 && right > x1 && top < y2 && bottom > y1 && !picked.includes(obj.id)) {
                    picked.push(obj.id);
                }
            });
            setSelectedObjectIds(picked);
            return;
        }
    };

    // Edit drag: listener WINDOW (giống VDP) — kéo ra ngoài khung vẫn cập nhật ghost
    // và pointerup vẫn commit. Trước đây chỉ onMouseMove/Up trên container + mouseleave
    // HỦY → dễ mất thao tác / ghost biến mất giữa chừng.
    useEffect(() => {
        if (!editInteraction) return;
        const applyMoveVisual = (curX: number, curY: number) => {
            const inter = editInteractionRef.current;
            if (!inter) return;
            const dxPx = curX - inter.startX;
            const dyPx = curY - inter.startY;
            const box = inter.startBox;
            const ghost = editGhostRef.current;
            if (inter.type === 'move') {
                editLiveTransformRef.current = { kind: 'move', dx: dxPx, dy: dyPx };
                if (ghost) {
                    ghost.style.transformOrigin = 'center center';
                    ghost.style.transform = `translate(${dxPx}px, ${dyPx}px)`;
                    ghost.style.display = 'block';
                }
            } else if (inter.type === 'resize') {
                const handle = inter.handle || 'se';
                let newW = box.width, newH = box.height;
                if (handle.includes('e')) newW = box.width + dxPx;
                if (handle.includes('w')) newW = box.width - dxPx;
                if (handle.includes('s')) newH = box.height + dyPx;
                if (handle.includes('n')) newH = box.height - dyPx;
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
            } else if (inter.type === 'rotate') {
                const cx = box.left + box.width / 2;
                const cy = box.top + box.height / 2;
                const initAng = Math.atan2(-1, 0);
                const curAng = Math.atan2(curY - cy, curX - cx);
                let deg = (curAng - initAng) * 180 / Math.PI;
                // Shift snap không có e ở đây — giữ góc thô; Shift xử lý ở mousemove cũ nếu cần.
                editLiveTransformRef.current = { kind: 'rotate', rotateDeg: deg };
                if (ghost) {
                    ghost.style.transformOrigin = 'center center';
                    ghost.style.transform = `rotate(${deg}deg)`;
                    ghost.style.display = 'block';
                }
            }
        };
        const onMove = (e: PointerEvent) => {
            if (!containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
            applyMoveVisual(coords.x, coords.y);
        };
        const onUp = () => {
            const lt = editLiveTransformRef.current;
            setEditInteraction(null);
            if (lt) {
                editGhostHoldRef.current = true;
                if (editGhostHideTimerRef.current) clearTimeout(editGhostHideTimerRef.current);
                editGhostHideTimerRef.current = setTimeout(() => hideEditGhost(), 4000);
            } else {
                hideEditGhost();
            }
            editLiveTransformRef.current = null;
            void commitEditTransform(lt);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editInteraction]);

    const handleMouseLeave = () => {
        dragRef.current.active = false;
        // KHÔNG huỷ editInteraction / vdpInteraction khi rời khung: listener window
        // quản lý pointerup → kéo ra ngoài vẫn commit được (tránh "kéo chữ bị mất").
        if (marqueeRef.current) marqueeRef.current.style.display = 'none';
    };
    //#endregion

    // Trang trắng placeholder: kiểm tra SAU khi mọi hook đã chạy (xem ghi chú phía trên).
    if (originalPageNum === -1) {
        return (
            <div className="bg-white shadow-[0_4px_30px_rgba(0,0,0,0.15)] ring-1 ring-black/5 relative shrink-0 overflow-hidden">
                <div style={{ width: actualWidth100 * zoom, height: actualWidth100 * zoom * 1.414 }} className="bg-white flex items-center justify-center">
                    <span className="text-slate-200 text-3xl font-bold tracking-[0.5em] -rotate-45">DOCUMENT BLANK PAGE</span>
                </div>
            </div>
        );
    }

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
                // Nền: 1 TILE phủ cả trang ở renderZoom (đã lượng tử hoá, cache tốt). Luôn có
                // ảnh → không bao giờ trắng. Ở zoom cao renderZoom bị cap < zoom×dpr → nền mờ.
                const S = renderZoom;
                // Hybrid gate: chỉ chồng lưới tile SẮC khi nền single-tile thật sự bị cap
                // (renderZoom không theo kịp zoom×dpr) → zoom cao mới nét như Acrobat. Chỉ
                // áp cho PDF, rot===0 (tránh bug toạ độ xoay), tránh trang trắng/ảnh.
                // CHỈ trang ĐANG XEM (isActiveFrame): log profiling cho thấy mọi trang mounted
                // (Virtuoso giữ ~9 trang) đều render tile sắc dù người dùng chỉ nhìn 1 → 9× công
                // thừa xếp hàng tuần tự. Trang khác giữ nền single-tile là đủ (audit tốc độ).
                const dpr = window.devicePixelRatio || 1;
                const needsTiling = isActiveFrame && !isImage && (rotation || 0) % 360 === 0
                    && renderZoom < zoom * dpr * 0.95;
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
                        {needsTiling && (
                            <div className="absolute inset-0 z-[11]">
                                <TileLayer
                                    fileKey={pdfUrl || 'unknown'}
                                    pageNum={originalPageNum}
                                    zoom={zoom}
                                    dpr={dpr}
                                    displayWidth={displayWidth}
                                    displayHeight={displayHeight}
                                    containerRef={containerRef}
                                    getTileUrl={getTileUrl}
                                    onVisible={handleTileVisibility}
                                />
                            </div>
                        )}
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

             {/* Lớp text vô hình để QUÉT + COPY chữ (như Acrobat). CHỈ bật ở chế độ XEM
                 THƯỜNG: edit-object dùng chuột để chọn object, VDP/crop dùng để quét vùng —
                 lớp select-text sẽ nuốt mất cú kéo đó. Nên loại cả 3 chế độ. */}
            {getTileUrl && textBlocks && !isObjectEditMode && !isVdpMode && !isCropMode && (() => {
                // bbox từ /pdf-text ở POINT, gốc trên-trái. pageDim.w là px@96
                // (= point × 96/72) → pageWidthPt = pageDim.w × 72/96. scale =
                // displayWidth / pageWidthPt (px màn trên mỗi POINT).
                const pageWidthPt = pageDim?.w ? pageDim.w * 72 / 96 : 595;
                const scale = displayWidth / pageWidthPt;
                // GOM mọi dòng (mọi block) rồi SORT theo y. bbox.h của pdfplumber là cao
                // chữ (ascent→descent) nhưng khoảng cách dòng (leading) thường NHỎ hơn →
                // đáy span dòng trên lấn đỉnh span dòng dưới → kéo 1 dòng chạm span dòng
                // kề → browser nhảy selection sang. Nên KẸP chiều cao mỗi span ≤ khe tới
                // đỉnh dòng kế (capH) → span không chồng mép Y (fix nhảy dòng 2026-07-07).
                const allLines = (Array.isArray(textBlocks) ? textBlocks : (textBlocks.blocks || []))
                    .flatMap((block: any) => block.lines || [])
                    .filter((ln: any) => ln?.bbox)
                    .sort((a: any, b: any) => a.bbox.y - b.bbox.y);
                return (
                    <div className="absolute inset-0 z-[12] select-text cursor-text" style={{ pointerEvents: 'auto' }}>
                        {allLines.map((line: any, i: number) => {
                            const next = allLines[i + 1];
                            // Khe tới dòng kế (point). Không có dòng kế → không kẹp.
                            const gap = next ? (next.bbox.y - line.bbox.y) : Infinity;
                            return (
                                <SelectableTextLine key={i} line={line} scale={scale} gapPt={gap} />
                            );
                        })}
                     </div>
                );
            })()}
             
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

             {/* Edit-session preview: dán ĐÈ ảnh vùng clip (hoặc cả trang nếu full) lên
                 tile TẠI CHỖ sau mỗi op — trước khi tile thật (pdfUrl mới) vào. full →
                 phủ cả trang (inset-0); ngược lại định vị theo rect px (clipRectPdfToCanvas).
                 z-[16] < overlay object (z-30) để khung chọn vẫn nổi trên preview. */}
             {sessionPreviews.map((sp, i) => (
                 <img
                     key={i}
                     src={sp.url}
                     alt=""
                     className="absolute z-[16] pointer-events-none"
                     style={sp.full || !sp.rect
                         ? { top: 0, left: 0, width: '100%', height: '100%', objectFit: 'fill' }
                         : { left: sp.rect[0], top: sp.rect[1], width: sp.rect[2] - sp.rect[0], height: sp.rect[3] - sp.rect[1], objectFit: 'fill' }}
                 />
             ))}

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
                         {[...editObjects]
                            .filter(obj => !hiddenObjectIds.includes(obj.id))
                            .sort((a, b) => {
                             const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
                             const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
                             return areaB - areaA; // lớn nhất trước (dưới cùng), nhỏ nhất sau (trên cùng)
                         }).map((obj) => {
                             const [x0, y0, x1, y1] = obj.bbox;
                             const isSelected = selectedObjectIds.includes(obj.id);
                             const isLocked = lockedObjectIds.includes(obj.id);
                             // Bộ ba RGB (KHÔNG bọc 'rgb()') để dựng được CẢ màu đặc lẫn rgba()
                             // có alpha. Trước đây dùng `${typeColor}20` với typeColor='rgb(...)'
                             // → ra chuỗi 'rgb(...)20' KHÔNG hợp lệ → trình duyệt BỎ QUA nền + shadow,
                             // chỉ còn viền mảnh ở mép bbox (ảnh/vector lớn gần như vô hình + bị
                             // overflow-hidden cắt). Dùng rgba() hợp lệ + RING INSET (vẽ vào trong,
                             // không bị cắt) để MỌI loại object đều hiện highlight rõ.
                             const typeRgb = obj.type === 'text' ? '59,130,246' : obj.type === 'image' ? '168,85,247' : '234,179,8';
                             const typeColor = `rgb(${typeRgb})`;
                             return (
                                 <div
                                     key={obj.id}
                                     data-obj-id={obj.id}
                                     // HOVER thuần CSS (KHÔNG mutate .style → không bao giờ "kẹt style").
                                     // Màu theo loại object truyền qua biến CSS `--obj` (bộ ba RGB), rồi
                                     // class hover Tailwind arbitrary dựng viền + nền nhạt từ biến đó.
                                     // CHỈ áp hover khi KHÔNG chọn & KHÔNG khóa; khi rời chuột CSS tự gỡ.
                                     className={`absolute pointer-events-auto transition-colors border border-transparent ${isLocked ? 'cursor-not-allowed' : 'cursor-pointer'} ${isSelected ? 'z-[33]' : 'z-30'} ${(!isSelected && !isLocked) ? 'hover:border-[rgb(var(--obj))] hover:bg-[rgba(var(--obj),0.06)]' : ''}`}
                                     style={{
                                         // Biến CSS cho hover (xem className). vd '59,130,246'.
                                         ['--obj' as string]: typeRgb,
                                         left: x0 * scale, top: y0 * scale,
                                         width: (x1 - x0) * scale, height: (y1 - y0) * scale,
                                         // Object bị KHÓA: CHỈ hiện icon ổ khóa — KHÔNG viền, KHÔNG nền.
                                         // Ép border='none' + backgroundColor='transparent' để chắc chắn
                                         // không còn viền/nền nào sót lại (hover đã do CSS, nhưng giữ ép
                                         // này cho rõ ràng trạng thái khóa).
                                         border: isLocked ? 'none' : undefined,
                                         backgroundColor: isLocked ? 'transparent' : undefined,
                                         // Object đang chọn (và KHÔNG khóa): một viền MẢNH (outline vẽ vào
                                         // trong, không đội kích thước). Báo chọn chính vẫn là HỘP TRANSFORM
                                         // xanh (z-40) + handle.
                                         outline: (isSelected && !isLocked) ? `1.5px solid ${typeColor}` : undefined,
                                         outlineOffset: (isSelected && !isLocked) ? '-1.5px' : undefined,
                                     } as React.CSSProperties}
                                     title={isLocked ? `🔒 ĐÃ KHÓA — ${obj.type.toUpperCase()}: ${obj.id}` : `${obj.type.toUpperCase()}: ${obj.id}`}
                                     onClick={(e) => {
                                         e.stopPropagation();
                                         if (isLocked) return; // object bị khóa: KHÔNG cho chọn
                                         if (e.shiftKey) {
                                             setSelectedObjectIds(prev => prev.includes(obj.id) ? prev.filter(id => id !== obj.id) : [...prev, obj.id]);
                                         } else {
                                             setSelectedObjectIds(prev => (prev.length === 1 && prev[0] === obj.id) ? [] : [obj.id]);
                                         }
                                     }}
                                     onDoubleClick={(e) => {
                                         // task 10.3: double-click object TEXT → mở editor inline.
                                         // Chỉ kích hoạt ở chế độ edit-object (KHÔNG VDP) để TÁI DÙNG
                                         // editingTextId/editTextContent mà không xung đột field VDP.
                                         if (isLocked) return; // object bị khóa: KHÔNG mở editor
                                         if (obj.type === 'text' && !isVdpMode) {
                                             e.stopPropagation();
                                             openTextEditor(obj);
                                         }
                                     }}
                                 >
                                     {/* Dấu hiệu khóa nhỏ ở góc trên-phải để người dùng biết object bị khóa. */}
                                     {isLocked && (
                                         <span
                                             className="absolute top-0 right-0 leading-none px-0.5 bg-slate-700/70 text-white rounded-bl pointer-events-none select-none"
                                             style={{ zIndex: 1 }}
                                         >
                                             <Lock className="w-2.5 h-2.5" />
                                         </span>
                                     )}
                                     {/* Editor text inline cho cụm text CÓ SẴN (8.5). Enter=commit,
                                         Shift+Enter=xuống dòng, Esc/blur rỗng=hủy. */}
                                     {editingTextId === obj.id && obj.type === 'text' && !isVdpMode && (
                                       <>
                                         {/* Thanh chọn FONT — gắn NGAY TRÊN ô editor (luôn thấy dù
                                             zoom/cuộn). Chọn font máy → nhúng đúng tiếng Việt + style. */}
                                         <div
                                             data-edit-ui="1"
                                             className="absolute left-0 z-[60] w-[260px] bg-white rounded shadow-lg border border-slate-300 p-1.5 cursor-default"
                                             style={{ bottom: 'calc(100% + 4px)' }}
                                             onMouseDown={(e) => e.stopPropagation()}
                                             onPointerDown={(e) => e.stopPropagation()}
                                             onClick={(e) => e.stopPropagation()}
                                             onDoubleClick={(e) => e.stopPropagation()}
                                         >
                                             <FontSelector
                                                 value={editFontName}
                                                 fontFile={editFontPath}
                                                 onChange={(name, file) => { setEditFontName(name); setEditFontPath(file); }}
                                             />
                                             <div className="flex items-center gap-1 mt-1">
                                                 <button type="button"
                                                     className="px-2 py-0.5 text-[11px] rounded bg-emerald-600 text-white font-semibold inline-flex items-center gap-1"
                                                     onClick={(e) => {
                                                         e.stopPropagation();
                                                         const c = editTextContent;
                                                         setEditingTextId(null);
                                                         if (c.trim()) void commitEditObjectText(obj.id, c);
                                                     }}
                                                 ><Check className="w-3 h-3" /> Áp dụng</button>
                                                 <button type="button"
                                                     className="px-2 py-0.5 text-[11px] rounded border border-slate-300 text-slate-600 inline-flex items-center gap-1"
                                                     onClick={(e) => { e.stopPropagation(); setEditingTextId(null); }}
                                                 ><X className="w-3 h-3" /> Hủy</button>
                                                 {editFontPath && (
                                                     <button type="button" className="ml-auto text-[10px] text-slate-500 hover:text-rose-600 inline-flex items-center gap-1"
                                                         onClick={(e) => { e.stopPropagation(); setEditFontName(''); setEditFontPath(undefined); }}
                                                     ><RotateCcw className="w-3 h-3" /> Bỏ font</button>
                                                 )}
                                             </div>
                                         </div>
                                         <textarea
                                             autoFocus
                                             value={editTextContent}
                                             placeholder="Nhập nội dung…"
                                             onChange={(ev) => setEditTextContent(ev.target.value)}
                                             onBlur={(e) => {
                                                 // Nếu focus chuyển sang thanh FONT (data-edit-ui) thì KHÔNG đóng
                                                 // editor (cho phép chọn font). Chỉ đóng khi bấm ra ngoài hẳn.
                                                 const rt = e.relatedTarget as HTMLElement | null;
                                                 if (rt && rt.closest('[data-edit-ui]')) return;
                                                 const c = editTextContent;
                                                 setEditingTextId(null);
                                                 if (c.trim() && (c !== editOrigContent || !!editFontPath)) void commitEditObjectText(obj.id, c);
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
                                                 color: editTextColor ? `rgb(${editTextColor[0]},${editTextColor[1]},${editTextColor[2]})` : '#111',
                                                 fontWeight: /bold|black|heavy|semibold/i.test(editOrigFontName) ? 700 : 'normal',
                                                 lineHeight: 1.2,
                                                 fontSize: `${Math.max(11, (y1 - y0) * scale * 0.7)}px`,
                                                 // Realtime preview: dùng font ĐÃ CHỌN (FontSelector inject @font-face
                                                 // "<name>_local"). Đổi font ở thanh FONT → editor đổi mặt chữ ngay.
                                                 fontFamily: editFontName
                                                     ? `"${editFontName}_local", "${editFontName}", sans-serif`
                                                     : undefined,
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

             {/* Edit PDF Object (task 10.3): dòng gợi ý khi đang ở chế độ đặt object.
                 Hai nút +Text/Ảnh ĐÃ CHUYỂN sang panel phải (SelectionLayersPanel) để
                 gọn canvas; đây chỉ còn nhắc "bấm lên trang để đặt". editAddMode nay ở
                 store dùng chung → cú bấm kế tiếp lên BẤT KỲ trang nào đặt object tại đó. */}
             {isObjectEditMode && !isVdpMode && editAddMode && (
                 <div className="absolute top-1 left-1 z-[60] pointer-events-none">
                     <span className="px-1.5 py-0.5 text-[11px] rounded bg-black/70 text-white">
                         Bấm lên trang để đặt {editAddMode === 'text' ? 'text' : 'ảnh'}…
                     </span>
                 </div>
             )}
             {editNotice && createPortal(
                 <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] max-w-md px-4 py-2 rounded-lg bg-amber-600 text-white text-[12px] font-medium shadow-2xl flex items-center gap-3">
                     <span className="flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" /> {editNotice}</span>
                     <button onClick={() => setEditNotice(null)} className="text-white/90 hover:text-white"><X className="w-4 h-4" /></button>
                 </div>,
                 document.body
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
             {isObjectEditMode && pageDim && selectedObjectIds.length > 0 && !(editingTextId && editingTextId !== EDIT_ADD_TEXT_ID) && (() => {
                 // scale = px màn / POINT (getEditSelectionBoxPx nhận px/point).
                 const scale = displayWidth / ((pageDim.w || 595) * 72 / 96);
                 const box = getEditSelectionBoxPx(scale);
                 if (!box) return null;
                 const accent = 'rgb(16,185,129)';
                 const accentRgb = '16,185,129';
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
                                 border: `2px dashed ${accent}`, backgroundColor: `rgba(${accentRgb},0.08)`,
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
                                 if (isVdpMode || selectedObjectIds.length !== 1) return;
                                 const sel = editObjects.find(o => o.id === selectedObjectIds[0]);
                                 if (sel && sel.type === 'text') {
                                     e.stopPropagation();
                                     openTextEditor(sel);
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
                             onContextMenu={(e) => {
                                 if (!isVdpMode) return;
                                 e.preventDefault();
                                 e.stopPropagation();
                                 // Chọn field (nếu chưa) rồi mở menu xoay tại vị trí chuột.
                                 if (!safeSelectedIds.includes(field.id)) {
                                     const sel = [field.id];
                                     setSelectedVdpFieldIds(sel);
                                     onVdpBoxSelect?.(sel);
                                 }
                                 setVdpCtxMenu({ x: e.clientX, y: e.clientY, fieldId: field.id });
                             }}
                             onPointerDown={(e) => {
                                 if (editingTextId === field.id) return;
                                 // Nút phải: để onContextMenu xử lý (mở menu xoay), KHÔNG
                                 // khởi động move — nếu không sẽ vừa mở menu vừa kéo nhầm.
                                 if (e.button === 2) return;
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
                                     const startFields: Record<string, {x: number, y: number, w: number, h: number, fontSize?: number}> = {};
                                     
                                     onVdpFieldsChange?.((prev: any[]) => {
                                         const copies: any[] = [];
                                         fieldsToMove.forEach((id: string) => {
                                             const f = prev.find((tf: any) => tf.id === id);
                                             if (!f) return;
                                             
                                             const copyId = `field_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                                             newFieldsToMove.push(copyId);
                                             startFields[copyId] = { x: f.x, y: f.y, w: f.width, h: f.height, fontSize: f.fontSize };
                                             
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
                                     const startFields: Record<string, {x: number, y: number, w: number, h: number, fontSize?: number}> = {};
                                     fieldsToMove.forEach((id: string) => {
                                         const f = vdpFields.find((tf: any) => tf.id === id);
                                         if (f) {
                                             startFields[id] = { x: f.x, y: f.y, w: f.width, h: f.height, fontSize: f.fontSize };
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
                                 
                             }}
                         >
                             <div className={`absolute -top-6 left-0 bg-blue-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow whitespace-nowrap pointer-events-none transition-opacity z-[70] ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                                 {field.fieldName || field.name || 'Chưa đặt tên'} ({field.type})
                             </div>
                             
                             {/* Visual Placeholders — xoay nội dung quanh tâm box theo
                                 field.rotation để khớp backend render_one_record. Box (w,h)
                                 là footprint ĐÃ hoán cho 90/270; nội dung trước xoay có kích
                                 thước hoán NGƯỢC lại (rotContentW/H), rồi rotate() quanh tâm. */}
                             {(() => {
                             // Đang sửa text: KHÔNG xoay wrapper (textarea xoay 90° rất khó gõ);
                             // xoay lại ngay khi blur. Các loại field khác luôn xoay theo rotation.
                             const editingThis = editingTextId === field.id;
                             const rot = editingThis ? 0 : ((Number(field.rotation) || 0) % 360 + 360) % 360;
                             const isVert = rot === 90 || rot === 270;
                             const rotStyle: React.CSSProperties = rot === 0 ? {} : (isVert ? {
                                 // Nội dung trước xoay: hoán w/h so với box footprint, căn giữa.
                                 width: h, height: w, left: (w - h) / 2, top: (h - w) / 2,
                                 transform: `rotate(${rot}deg)`, transformOrigin: 'center center',
                             } : {
                                 transform: `rotate(${rot}deg)`, transformOrigin: 'center center',
                             });
                             return (
                             <div
                                 className={`absolute flex items-center justify-center pointer-events-none overflow-hidden ${rot === 0 ? 'inset-0' : ''} ${(field.type === 'qrcode' || field.type === 'barcode') ? 'opacity-100' : 'mix-blend-multiply ' + (field.type === 'image' ? 'opacity-50' : 'opacity-80')} ${field.type === 'text' ? 'p-1' : ''}`}
                                 style={rotStyle}
                             >
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
                                         />
                                     )
                                 )}
                             </div>
                             );
                             })()}

                             {/* Resize Handles: 4 góc + 4 cạnh (giống Illustrator) */}
                             {isSelected && (() => {
                                 const isQr = field.type === 'qrcode';
                                 // QR khoá tỉ lệ vuông → chỉ cho kéo 4 góc. Còn lại đủ 8 điểm.
                                 const handles = isQr
                                     ? (['nw','ne','sw','se'] as const)
                                     : (['nw','n','ne','e','se','s','sw','w'] as const);
                                 const posMap: Record<string, string> = {
                                     nw: '-left-1.5 -top-1.5 cursor-nw-resize',
                                     n:  'left-1/2 -translate-x-1/2 -top-1.5 cursor-n-resize',
                                     ne: '-right-1.5 -top-1.5 cursor-ne-resize',
                                     e:  '-right-1.5 top-1/2 -translate-y-1/2 cursor-e-resize',
                                     se: '-right-1.5 -bottom-1.5 cursor-se-resize',
                                     s:  'left-1/2 -translate-x-1/2 -bottom-1.5 cursor-s-resize',
                                     sw: '-left-1.5 -bottom-1.5 cursor-sw-resize',
                                     w:  '-left-1.5 top-1/2 -translate-y-1/2 cursor-w-resize',
                                 };
                                 const isEdge = (h: string) => h.length === 1;
                                 return handles.map((handle) => (
                                     <div
                                         key={handle}
                                         className={`absolute ${posMap[handle]} w-3 h-3 bg-white border-2 border-blue-500 ${isEdge(handle) ? 'rounded-sm' : 'rounded-full'} shadow-sm hover:scale-150 transition-transform z-[65]`}
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
                                                     [field.id]: { x: field.x, y: field.y, w: field.width, h: field.height, fontSize: field.fontSize }
                                                 }
                                             });
                                         }}
                                     />
                                 ));
                             })()}
                         </div>
                     );
                 });
             })()}

             {/* Menu chuột phải cho khung VDP: xoay nhanh (dùng chung field.rotation
                 với dropdown "Xoay (độ)" bên panel). Backend chỉ render 0/90/180/270
                 nên chỉ cung cấp các mức đó + xoay tương đối 90° CW/CCW. */}
             {vdpCtxMenu && (() => {
                 const target = vdpFields.find((f: any) => f.id === vdpCtxMenu.fieldId);
                 if (!target) return null;
                 const cur = ((Number(target.rotation) || 0) % 360 + 360) % 360;
                 const items: { label: string; rot: number; active?: boolean }[] = [
                     { label: 'Xoay 90° theo chiều kim đồng hồ', rot: (cur + 90) % 360 },
                     { label: 'Xoay 90° ngược chiều kim đồng hồ', rot: (cur + 270) % 360 },
                 ];
                 const presets = [0, 90, 180, 270];
                 // Portal ra document.body: overlay VDP nằm trong div trang có CSS
                 // `transform` (rotate/scale trang) — position:fixed sẽ neo theo tổ
                 // tiên transform đó chứ KHÔNG phải viewport, khiến menu (định vị bằng
                 // clientX/clientY viewport) văng ra ngoài màn hình. Portal đưa menu ra
                 // body để fixed + toạ độ chuột hoạt động đúng.
                 return createPortal((
                     <>
                     {/* Backdrop bắt click NGOÀI menu để đóng — dùng backdrop thay vì
                         window pointerdown listener để tránh race: cú chuột phải MỞ menu
                         cũng phát pointerdown, listener window sẽ đóng ngay. Backdrop chỉ
                         tồn tại SAU khi menu đã render nên không dính cú mở. */}
                     <div className="fixed inset-0 z-context-menu" onPointerDown={() => setVdpCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setVdpCtxMenu(null); }} />
                     <div
                         className="fixed z-context-menu min-w-[210px] bg-white dark:bg-[#1e1e1e] border border-slate-200 dark:border-white/10 shadow-[0_10px_30px_rgb(0,0,0,0.1)] dark:shadow-xl p-2 rounded-xl flex flex-col gap-0.5"
                         style={{ left: Math.min(vdpCtxMenu.x, window.innerWidth - 220), top: Math.min(vdpCtxMenu.y, window.innerHeight - 260) }}
                         onPointerDown={(e) => e.stopPropagation()}
                         onClick={(e) => e.stopPropagation()}
                         onContextMenu={(e) => e.preventDefault()}
                     >
                         <div className="px-3 py-1 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Xoay khung</div>
                         {items.map((it) => (
                             <button
                                 key={it.label}
                                 onClick={() => { rotateVdpField(vdpCtxMenu.fieldId, it.rot); setVdpCtxMenu(null); }}
                                 className="w-full text-left px-3 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
                             >
                                 {it.label}
                             </button>
                         ))}
                         <div className="h-px bg-slate-100 dark:bg-white/5 my-1 mx-2"></div>
                         <div className="grid grid-cols-4 gap-1 px-1">
                             {presets.map((p) => (
                                 <button
                                     key={p}
                                     onClick={() => { rotateVdpField(vdpCtxMenu.fieldId, p); setVdpCtxMenu(null); }}
                                     className={`px-2 py-1.5 text-[12px] font-semibold rounded-lg outline-none transition-colors ${cur === p ? 'bg-blue-500 text-white' : 'text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-white/5'}`}
                                 >
                                     {p}°
                                 </button>
                             ))}
                         </div>
                     </div>
                     </>
                 ), document.body);
             })()}



             {/* Preview Stick Text & Numbers Tool */}
             {stickPreviewParams && pageDim && (() => {
                 const { fields, margins, startNumber, increment, padLength, fontName, fontSize, fontColor, rotation, targetType, rangeStart, rangeEnd, numberStyle, mirrorMargins } = stickPreviewParams;
                 
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

                 const numStr = formatPageNumber(currentNumber, numberStyle || 'arabic', padLength);
                 const totalStr = String(viewerNumPages || 0);
                 const todayStr = new Date().toLocaleDateString('vi-VN');

                 const pageWidthPt = pageDim.w;
                 const scale = displayWidth / pageWidthPt;
                 const MM_TO_PT = 2.83465;

                 // Lề gương 2 mặt: hoán đổi trái/phải ở trang chẵn (khớp output).
                 const effM = effectiveLR(margins?.left ?? 0, margins?.right ?? 0, originalPageNum, !!mirrorMargins);

                 const fieldList = [
                     { id: 'topLeft', content: fields?.topLeft, top: margins?.top, bottom: null, left: effM.left, right: null, align: 'flex-start', valalign: 'flex-start' },
                     { id: 'topCenter', content: fields?.topCenter, top: margins?.top, bottom: null, left: 0, right: 0, align: 'center', valalign: 'flex-start' },
                     { id: 'topRight', content: fields?.topRight, top: margins?.top, bottom: null, left: null, right: effM.right, align: 'flex-end', valalign: 'flex-start' },
                     { id: 'bottomLeft', content: fields?.bottomLeft, top: null, bottom: margins?.bottom, left: effM.left, right: null, align: 'flex-start', valalign: 'flex-end' },
                     { id: 'bottomCenter', content: fields?.bottomCenter, top: null, bottom: margins?.bottom, left: 0, right: 0, align: 'center', valalign: 'flex-end' },
                     { id: 'bottomRight', content: fields?.bottomRight, top: null, bottom: margins?.bottom, left: null, right: effM.right, align: 'flex-end', valalign: 'flex-end' }
                 ];

                 return fieldList.map(f => {
                     if (!f.content) return null;
                     const drawString = applyTokens(f.content, numStr, totalStr, todayStr);
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
             {(isObjectEditMode || isCropMode) && (
                 <div 
                     ref={marqueeRef}
                     className="absolute border-2 border-blue-500 bg-blue-400/15 z-40 pointer-events-none"
                     style={{ display: 'none' }}
                 />
             )}

             {/* Crop PDF — vùng đã quét, giữ hiển thị chờ Enter/Esc */}
             {isCropMode && cropSel && (
                 <div
                     className="absolute border-2 border-orange-500 bg-orange-400/10 z-40 pointer-events-none"
                     style={{ left: cropSel.x, top: cropSel.y, width: cropSel.w, height: cropSel.h }}
                 >
                     <div className="absolute -top-6 left-0 text-[10px] font-semibold bg-orange-500 text-white px-1.5 py-0.5 rounded shadow whitespace-nowrap">
                         Enter: cắt khổ • Esc: huỷ
                     </div>
                 </div>
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