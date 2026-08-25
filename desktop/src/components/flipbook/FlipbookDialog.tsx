import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { pdfjs } from 'react-pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { FlipBook } from './FlipBook';
import type { BookData, BookPage } from './types';
import { generateBindingMap } from '../../lib/imposerEngine/VirtualMap';
import { buildTileUrl, trimmedAspectRatio } from './tileUrl';
import { flipbookRenderPurpose, shouldPromoteFlipbookUrl } from './flipbookLoadPolicy';

// Ensure worker is set up
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useTranslation } from 'react-i18next';
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface FlipbookPdfSource {
    path?: string;
}

interface PdfPageDimensions {
    widthPt: number;
    heightPt: number;
}

interface PdfMetadata {
    widthPt: number;
    heightPt: number;
    allDims?: Record<string, PdfPageDimensions>;
}

type FlipbookPage = BookPage & {
    _originalIndex: number;
    _userRotation: number;
};

type FlipbookBookData = Omit<BookData, 'pages'> & {
    pages: FlipbookPage[];
};

interface FlipbookDialogProps {
    isOpen: boolean;
    onClose: () => void;
    pdfUrl: string | null;
    pdfFile?: FlipbookPdfSource | null; // Added for native tile rendering
    pageOrder: number[]; // 1-based indices from thumbnails, -1 for blank
    pageRotations?: number[]; // Rotation by thumbnail position
    bindingMode: 'continuous' | 'saddle' | 'thread' | 'cut_stacks' | 'flush_mount';
    foliosize: number;
    blankPlacement?: 'end' | 'center';
    /** Bleed mỗi cạnh (mm) — cắt khỏi tile để xem trước ĐÚNG khổ thành phẩm. */
    bleed?: number;
}

export const FlipbookDialog: React.FC<FlipbookDialogProps> = ({
    isOpen, onClose, pdfUrl, pdfFile, pageOrder, pageRotations = [], bindingMode, foliosize, bleed = 0, blankPlacement = 'end'
}) => {
  const { t } = useTranslation();
    const [bookData, setBookData] = useState<FlipbookBookData>({ pages: [] });
    const [bookRevision, setBookRevision] = useState(0);
    const [currentPageIndex, setCurrentPageIndex] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [pageAspectRatio, setPageAspectRatio] = useState<number>(0.707); // Default A4
    const pdfRef = useRef<PDFDocumentProxy | null>(null);
    const metaRef = useRef<PdfMetadata | null>(null); // meta.allDims (pdfium): khổ trang/pt để tính clip trừ bleed

    // Load PDF Document when URL changes
    useEffect(() => {
        if (!isOpen || !pdfUrl) return;

        let cancelled = false;
        const loadDoc = async () => {
            setIsLoading(true);
            try {
                const nativePath = window.__TAURI_INTERNALS__ ? pdfFile?.path : undefined;
                if (nativePath) {
                    // pdfium (Rust) đọc số trang + khổ trang, KHÔNG qua pdf.js. File sau bù xén
                    // (CMYK/spot CutContour/SMask) khiến pdf.js throw ngay ở getDocument →
                    // trước đây flipbook sập ở "cửa" dù pdfium render được (bug 2026-07-08).
                    const { invoke } = await import('@tauri-apps/api/core');
                    const meta = await invoke<PdfMetadata>('get_pdf_metadata', { filePath: nativePath });
                    if (!cancelled) {
                        pdfRef.current = null;
                        metaRef.current = meta;
                        await initBookData(null, meta);
                    }
                } else {
                    const doc = await pdfjs.getDocument(pdfUrl).promise;
                    if (!cancelled) {
                        pdfRef.current = doc;
                        await initBookData(doc, null);
                    }
                }
            } catch (err) {
                console.error("Failed to load PDF for Flipbook", err);
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        };

        loadDoc();
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- LINT (audit 2026-08-24 LO140): initBookData là helper theo render; các đầu vào chính đã liệt kê tường minh để tránh vòng nạp lại PDF.
    }, [pdfUrl, pdfFile?.path, isOpen, pageOrder, pageRotations, bindingMode, foliosize, blankPlacement]);

    // Handle ESC key
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    const initBookData = async (doc: PDFDocumentProxy | null, meta: PdfMetadata | null) => {
        setIsLoading(true);

        const effectivePageCount = pageOrder.length;
        const { sheets } = generateBindingMap(effectivePageCount, bindingMode, foliosize, blankPlacement);
        
        const paddedPageCount = bindingMode === 'flush_mount'
            ? Math.ceil(effectivePageCount / 2) * 2
            : Math.ceil(effectivePageCount / 4) * 4;
        const totalPages = paddedPageCount;
        const sourceIndexByLogical = new Map<number, number | null>();
        for (const sheet of sheets) {
            for (const slot of [sheet.front.left, sheet.front.right, sheet.back.left, sheet.back.right]) {
                if (slot.logicalIndex > 0) sourceIndexByLogical.set(slot.logicalIndex, slot.srcIndex);
            }
        }

        const initialPages: FlipbookPage[] = [];

        for (let logical1Based = 1; logical1Based <= totalPages; logical1Based++) {
            const isCover = logical1Based === 1;
            const isBackCover = logical1Based === totalPages;
            const type = isCover ? 'cover' : isBackCover ? 'back-cover' : 'content';
            
            // Find which signature this logical page belongs to
            const sheet = sheets.find(s => 
                s.front.left.logicalIndex === logical1Based || s.front.right.logicalIndex === logical1Based ||
                s.back.left.logicalIndex === logical1Based || s.back.right.logicalIndex === logical1Based
            );
            const signatureIndex = sheet ? sheet.signatureIndex : 1;
            
            const sigInfoStr = bindingMode === 'thread'
                ? t('misc.flipbookDialog:trang_tep', { trang: logical1Based, tep: signatureIndex })
                : t('misc.flipbookDialog:trang_n', { n: logical1Based });

            const srcIndex = sourceIndexByLogical.get(logical1Based) ?? null;
            const originalIndex = srcIndex !== null ? pageOrder[srcIndex] : -1;
            const userRotation = srcIndex !== null ? (pageRotations[srcIndex] || 0) : 0;

            initialPages.push({
                id: `page-${logical1Based}`,
                type,
                pageNumber: logical1Based,
                signatureInfo: sigInfoStr,
                imageUrl: '', // Will be loaded lazily
                _originalIndex: originalIndex, // internal tracker
                _userRotation: userRotation,
            });
        }

        // Get aspect ratio from the first valid page
        if (pageOrder.length > 0) {
            const firstValidPosition = Math.max(0, pageOrder.findIndex(idx => idx !== -1));
            const firstValidIndex = pageOrder[firstValidPosition] || 1;
            const firstRotation = pageRotations[firstValidPosition] || 0;
            try {
                if (meta) {
                    // Native (pdfium): lấy khổ trang từ allDims[trang] (widthPt/heightPt).
                    const dim = meta.allDims?.[String(firstValidIndex)];
                    const w = dim?.widthPt ?? meta.widthPt;
                    const h = dim?.heightPt ?? meta.heightPt;
                    // Tỉ lệ khung theo khổ SAU xén (trừ bleed) để layout không kéo giãn
                    // ảnh đã clip — pages dùng object-fill.
                    if (w > 0 && h > 0) {
                        const ratio = trimmedAspectRatio(w, h, bleed);
                        setPageAspectRatio(Math.abs(firstRotation) % 180 !== 0 ? 1 / ratio : ratio);
                    }
                } else {
                    const page = await doc!.getPage(firstValidIndex);
                    const viewport = page.getViewport({ scale: 1.0, rotation: (page.rotate || 0) + firstRotation });
                    setPageAspectRatio(viewport.width / viewport.height);
                }
            } catch (e) {
                console.warn('Failed to get page aspect ratio', e);
            }
        }

        setBookData({ pages: initialPages });
        // PERF (audit 2026-08-08 §RENDER.2): dialog luôn mounted; mở lại cùng PDF có thể
        // giữ nguyên số trang. Revision buộc effect lazy-load chạy cho bộ URL rỗng mới.
        setBookRevision(revision => revision + 1);
        setCurrentPageIndex(0);
    };

    const renderPageToDataURL = async (
        doc: PDFDocumentProxy | null,
        originalIndex: number,
        userRotation: number = 0,
        purpose: 'interactive' | 'background' = 'interactive',
    ): Promise<string> => {
        if (originalIndex === -1) return ''; // Blank page

        // --- NATIVE TAURI RENDER PIPELINE (ZERO LATENCY) ---
        const nativePath = window.__TAURI_INTERNALS__ ? pdfFile?.path : undefined;
        if (nativePath) {
            const scale = 1.0; // Optimized scale for Flipbook (fast native fetch)
            const rot = userRotation;
            // Clip bleed theo khổ trang nguồn (allDims[trang]) → xem trước ĐÚNG thành phẩm.
            const dim = metaRef.current?.allDims?.[String(originalIndex)];
            // Return the Native tile.localhost URL instantly! The browser will fetch it asynchronously.
            return buildTileUrl({
                path: nativePath,
                page: originalIndex,
                scale,
                rot,
                pageWpt: dim?.widthPt,
                pageHpt: dim?.heightPt,
                bleedMm: bleed,
                purpose,
            });
        }

        try {
            const page = await doc!.getPage(originalIndex);
            const viewport = page.getViewport({ scale: 1.5, rotation: (page.rotate || 0) + userRotation }); // Good resolution for preview
            
            // Create a fresh canvas to prevent transform matrix accumulation
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) return '';

            canvas.width = viewport.width;
            canvas.height = viewport.height;

            await page.render({ canvasContext: ctx, viewport }).promise;
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            
            return dataUrl;
        } catch (e) {
            console.error("Failed to render page", originalIndex, e);
            return '';
        }
    };

    const loadPageImages = async (
        doc: PDFDocumentProxy | null,
        currentPages: FlipbookPage[],
        startIndex: number,
        count: number,
        visibleStartIndex = startIndex,
        visiblePageCount = 2,
    ) => {
        const endIndex = Math.min(startIndex + count, currentPages.length);
        const pagesToUpdate: { index: number, url: string }[] = [];

        for (let i = startIndex; i < endIndex; i++) {
            const p = currentPages[i];
            // PERF (audit 2026-08-08 §RENDER.2): hai trang của spread hiện tại đi lane
            // tương tác; phần nạp trước đi lane nền. Trang đã preload được nâng cấp URL khi
            // lật tới để request mới có quyền preempt thay vì mắc sau hàng thumbnail.
            const purpose = flipbookRenderPurpose(i, visibleStartIndex, visiblePageCount);
            const shouldPromote = shouldPromoteFlipbookUrl(p.imageUrl, purpose);
            if (!p.imageUrl || shouldPromote) {
                const url = await renderPageToDataURL(
                    doc,
                    p._originalIndex,
                    p._userRotation || 0,
                    purpose,
                );
                pagesToUpdate.push({ index: i, url });
            }
        }

        if (pagesToUpdate.length > 0) {
            setBookData(prev => {
                const newPages = [...prev.pages];
                pagesToUpdate.forEach(u => {
                    newPages[u.index] = { ...newPages[u.index], imageUrl: u.url };
                });
                return { ...prev, pages: newPages };
            });
        }
    };

    // Lazy load when page changes
    useEffect(() => {
        // Native (Tauri + path): render qua tile.localhost, KHÔNG cần pdfRef (doc=null).
        // Guard cũ `!pdfRef.current` chặn nhánh native → lật trang không load hình
        // (chỉ 4 trang preload đầu hiện). Cho qua khi native.
        const isNative = !!(window.__TAURI_INTERNALS__ && pdfFile?.path);
        if (!isOpen || bookData.pages.length === 0 || (!isNative && !pdfRef.current)) return;

        // Trang vừa lật tới phải được promote ngay; chỉ bốn trang kế tiếp mới chờ hết
        // animation rồi nạp nền. Nhờ worker riêng, request ảnh không chặn CSS/WebView.
        void loadPageImages(
            pdfRef.current,
            bookData.pages,
            currentPageIndex,
            2,
            currentPageIndex,
            2,
        );
        const timeout = setTimeout(() => {
            void loadPageImages(
                pdfRef.current,
                bookData.pages,
                currentPageIndex + 2,
                4,
                currentPageIndex,
                2,
            );
        }, 750);

        return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- LINT (audit 2026-08-24 LO140): chỉ length/revision được phép kích hoạt; phụ thuộc cả mảng pages hoặc helper theo render sẽ tự nạp lại sau mỗi lần gắn imageUrl.
    }, [currentPageIndex, isOpen, bookData.pages.length, bookRevision, bindingMode, foliosize, pdfFile?.path]);

    if (!isOpen) return null;

    return React.createElement(
        React.Fragment,
        null,
        createPortal(
            <div className="fixed inset-0 z-[9999] bg-slate-900/90 backdrop-blur-sm flex flex-col items-center justify-center p-4">
                <div className="absolute top-4 right-4 flex gap-4 z-[10000]">
                    <button
                        onClick={onClose}
                        className="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer"
                    >
                        {t('misc.flipbookDialog:dong_esc')}
                    </button>
                </div>

            <div className="text-white text-xl font-serif mb-4 flex items-center gap-4">
                {t('misc.flipbookDialog:xem_truoc_thanh_pham')}
                {isLoading && <span className="text-sm bg-indigo-500/20 text-indigo-300 px-2 py-1 rounded">{t('misc.flipbookDialog:dang_nap_du_lieu')}</span>}
            </div>

            <div className="flex-1 w-full flex flex-col items-center justify-center relative">
                <FlipBook
                    data={bookData}
                    currentPageIndex={currentPageIndex}
                    onPageChange={(idx) => setCurrentPageIndex(idx)}
                    pageAspectRatio={pageAspectRatio}
                />
            </div>
            
            </div>,
            document.body
        )
    );
};
