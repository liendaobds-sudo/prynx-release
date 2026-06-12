import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { pdfjs } from 'react-pdf';
import { FlipBook } from './FlipBook';
import { BookData, BookPage } from './types';
import { generateBindingMap } from '../../lib/imposerEngine/VirtualMap';

// Ensure worker is set up
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface FlipbookDialogProps {
    isOpen: boolean;
    onClose: () => void;
    pdfUrl: string | null;
    pdfFile?: any; // Added for native tile rendering
    pageOrder: number[]; // 1-based indices from thumbnails, -1 for blank
    bindingMode: 'continuous' | 'saddle' | 'thread' | 'cut_stacks';
    foliosize: number;
}

export const FlipbookDialog: React.FC<FlipbookDialogProps> = ({ 
    isOpen, onClose, pdfUrl, pdfFile, pageOrder, bindingMode, foliosize 
}) => {
    const [bookData, setBookData] = useState<BookData>({ pages: [] });
    const [currentPageIndex, setCurrentPageIndex] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [pageAspectRatio, setPageAspectRatio] = useState<number>(0.707); // Default A4
    const pdfRef = useRef<any>(null);

    // Load PDF Document when URL changes
    useEffect(() => {
        if (!isOpen || !pdfUrl) return;

        let cancelled = false;
        const loadDoc = async () => {
            setIsLoading(true);
            try {
                const doc = await pdfjs.getDocument(pdfUrl).promise;
                if (!cancelled) {
                    pdfRef.current = doc;
                    initBookData(doc);
                }
            } catch (err) {
                console.error("Failed to load PDF for Flipbook", err);
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        };

        loadDoc();
        return () => { cancelled = true; };
    }, [pdfUrl, isOpen, pageOrder]);

    // Handle ESC key
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    const initBookData = async (doc: any) => {
        setIsLoading(true);

        const effectivePageCount = pageOrder.length;
        const { sheets } = generateBindingMap(effectivePageCount, bindingMode, foliosize);
        
        const paddedPageCount = Math.ceil(effectivePageCount / 4) * 4;
        const totalPages = paddedPageCount;

        const initialPages: BookPage[] = [];

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
                ? `Trang ${logical1Based} | Tép ${signatureIndex}` 
                : `Trang ${logical1Based}`;

            const srcIndex = logical1Based <= effectivePageCount ? logical1Based - 1 : null;
            const originalIndex = srcIndex !== null ? pageOrder[srcIndex] : -1;

            initialPages.push({
                id: `page-${logical1Based}`,
                type,
                pageNumber: logical1Based,
                signatureInfo: sigInfoStr,
                imageUrl: '', // Will be loaded lazily
                _originalIndex: originalIndex // internal tracker
            } as BookPage & { _originalIndex: number });
        }

        // Get aspect ratio from the first valid page
        if (pageOrder.length > 0) {
            const firstValidIndex = pageOrder.find(idx => idx !== -1) || 1;
            try {
                const page = await doc.getPage(firstValidIndex);
                const viewport = page.getViewport({ scale: 1.0 });
                setPageAspectRatio(viewport.width / viewport.height);
            } catch (e) {
                console.warn('Failed to get page aspect ratio', e);
            }
        }

        setBookData({ pages: initialPages });
        setCurrentPageIndex(0);

        // Pre-load first few pages
        await loadPageImages(doc, initialPages, 0, 4);
    };

    const renderPageToDataURL = async (doc: any, originalIndex: number): Promise<string> => {
        if (originalIndex === -1) return ''; // Blank page

        // --- NATIVE TAURI RENDER PIPELINE (ZERO LATENCY) ---
        if ((window as any).__TAURI_INTERNALS__ && pdfFile && (pdfFile as any).path) {
            const encodedPath = encodeURIComponent((pdfFile as any).path);
            const scale = 1.0; // Optimized scale for Flipbook (fast native fetch)
            const rot = 0; // Page rotation handled by Flipbook
            // Return the Native tile.localhost URL instantly! The browser will fetch it asynchronously.
            return `http://tile.localhost/${encodedPath}/${originalIndex}/${scale}/${rot}/0/0/0/0`;
        }

        try {
            const page = await doc.getPage(originalIndex);
            const viewport = page.getViewport({ scale: 1.5 }); // Good resolution for preview
            
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

    const loadPageImages = async (doc: any, currentPages: any[], startIndex: number, count: number) => {
        const endIndex = Math.min(startIndex + count, currentPages.length);
        const pagesToUpdate: { index: number, url: string }[] = [];

        for (let i = startIndex; i < endIndex; i++) {
            const p = currentPages[i];
            if (!p.imageUrl) {
                const url = await renderPageToDataURL(doc, p._originalIndex);
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
        if (!isOpen || !pdfRef.current || bookData.pages.length === 0) return;
        
        // Delay rendering by 750ms so it doesn't block the 700ms CSS flip animation
        const timeout = setTimeout(() => {
            loadPageImages(pdfRef.current, bookData.pages as any, currentPageIndex, 6);
        }, 750);
        
        return () => clearTimeout(timeout);
    }, [currentPageIndex, isOpen, bookData.pages.length, bindingMode, foliosize]);

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
                        Đóng (ESC)
                    </button>
                </div>

            <div className="text-white text-xl font-serif mb-4 flex items-center gap-4">
                📖 Xem Trước Thành Phẩm
                {isLoading && <span className="text-sm bg-indigo-500/20 text-indigo-300 px-2 py-1 rounded">Đang nạp dữ liệu...</span>}
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
