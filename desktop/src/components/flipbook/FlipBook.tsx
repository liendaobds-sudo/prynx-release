import React, { useRef, useState, useCallback, forwardRef, useEffect } from 'react';
import HTMLFlipBook from 'react-pageflip';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { BookData, BookPage } from './types';
import { tv } from '../../i18n';

const FlipBookComponent = HTMLFlipBook;

interface FlipBookHandle {
    pageFlip: () => {
        turnToPage: (pageIndex: number) => void;
        flipPrev: () => void;
        flipNext: () => void;
    };
}

interface FlipPageEvent {
    data: number;
}

interface FlipBookProps {
    data: BookData;
    onPageChange?: (pageIndex: number) => void;
    currentPageIndex: number;
    pageAspectRatio?: number;
}

// Page component for react-pageflip (must use forwardRef)
const Page = forwardRef<HTMLDivElement, { page: BookPage; number: number }>(
    ({ page, number }, ref) => {
        const [loaded, setLoaded] = useState(false);
        const isEmpty = page._originalIndex === -1 || page.id.toString().startsWith('empty-');

        return (
            <div ref={ref} className="page bg-white shadow-lg">
                <div className="relative w-full h-full overflow-hidden">
                    {isEmpty ? (
                        <div className="w-full h-full bg-slate-50 flex items-center justify-center">
                            <span className="text-slate-300 text-sm font-medium">{tv('Trang trống')}</span>
                        </div>
                    ) : (
                        <>
                            {/* Loading skeleton */}
                            {!loaded && (
                                <div className="absolute inset-0 bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center">
                                    <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
                                </div>
                            )}
                            <img
                                src={page.imageUrl || undefined}
                                alt={`${tv('Trang')} ${number}`}
                                className={`w-full h-full object-fill transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
                                onLoad={() => setLoaded(true)}
                                draggable={false}
                            />
                        </>
                    )}
                </div>
            </div>
        );
    }
);
Page.displayName = 'Page';

// Cover page component
const CoverPage = forwardRef<HTMLDivElement, { page: BookPage; isFront?: boolean }>(
    ({ page, isFront }, ref) => {
        const [loaded, setLoaded] = useState(false);
        const isEmpty = page._originalIndex === -1 || page.id.toString().startsWith('empty-');

        return (
            <div ref={ref} className={`page ${isFront ? "page-cover page-cover-top" : "page-cover page-cover-bottom"}`}>
                <div className="relative w-full h-full overflow-hidden bg-white shadow-2xl">
                    {isEmpty ? (
                        <div className="w-full h-full bg-slate-50 flex items-center justify-center">
                            <span className="text-slate-300 text-sm font-medium">{tv('Trang trống')}</span>
                        </div>
                    ) : (
                        <>
                            {!loaded && (
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
                                </div>
                            )}
                            <img
                                src={page.imageUrl || undefined}
                                alt={tv('Trang bìa')}
                                className={`w-full h-full object-fill transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
                                onLoad={() => setLoaded(true)}
                                draggable={false}
                            />
                        </>
                    )}
                </div>
            </div>
        );
    }
);
CoverPage.displayName = 'CoverPage';

export const FlipBook: React.FC<FlipBookProps> = ({
    data,
    currentPageIndex,
    onPageChange,
    pageAspectRatio = 0.707
}) => {
    const bookRef = useRef<FlipBookHandle | null>(null);
    const [isFlipping, setIsFlipping] = useState(false);
    const [dimensions, setDimensions] = useState({ width: 500, height: 700 });
    const [isMobile, setIsMobile] = useState(false);
    const [bookPosition, setBookPosition] = useState<'cover' | 'spread' | 'back'>('cover');
    const [isInitial, setIsInitial] = useState(true);

    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const updateDimensions = () => {
            const viewportHeight = window.innerHeight;
            const viewportWidth = window.innerWidth;
            const mobile = viewportWidth < 768;
            setIsMobile(mobile);

            const headerOffset = mobile ? 100 : 120; // Room for top header + bottom controls
            const availableHeight = viewportHeight - headerOffset;
            const availableWidth = mobile ? viewportWidth * 0.92 : viewportWidth * 0.45; // 45% for desktop spread

            // Use the dynamic aspect ratio passed from the PDF
            const aspectRatio = pageAspectRatio;

            let height: number;
            let width: number;

            if (mobile) {
                width = availableWidth;
                height = width / aspectRatio;

                if (height > availableHeight) {
                    height = availableHeight;
                    width = height * aspectRatio;
                }
                width = Math.max(width, 280);
                height = Math.max(height, 400);
            } else {
                height = availableHeight;
                width = height * aspectRatio;

                if (width > availableWidth) {
                    width = availableWidth;
                    height = width / aspectRatio;
                }
                width = Math.max(width, 300);
                height = Math.max(height, 400);
            }

            setDimensions({ width: Math.floor(width), height: Math.floor(height) });
        };

        updateDimensions();
        window.addEventListener('resize', updateDimensions);
        return () => window.removeEventListener('resize', updateDimensions);
    }, [pageAspectRatio]);

    const handleStateChange = useCallback((state: { data: string }) => {
        if (state.data === 'flipping') {
            setIsFlipping(true);
        } else {
            setIsFlipping(false);
        }
    }, []);

    const internalPageRef = useRef<number>(currentPageIndex);

    useEffect(() => {
        if (currentPageIndex !== internalPageRef.current) {
            if (bookRef.current && bookRef.current.pageFlip) {
                try {
                    bookRef.current.pageFlip().turnToPage(currentPageIndex);
                    internalPageRef.current = currentPageIndex;
                } catch (error) {
                    console.error('turnToPage error:', error);
                }
            }
        }
    }, [currentPageIndex]);

    const handleFlipWithRef = useCallback((e: FlipPageEvent) => {
        internalPageRef.current = e.data;
        if (onPageChange) onPageChange(e.data);

        if (e.data === 0) {
            setBookPosition('cover');
        } else if (e.data >= data.pages.length - 1) {
            setBookPosition('back');
        } else {
            setBookPosition('spread');
        }

        if (isInitial) {
            setIsInitial(false);
        }
    }, [onPageChange, data.pages.length, isInitial]);

    const handlePrev = () => {
        if (bookRef.current && bookRef.current.pageFlip) {
            bookRef.current.pageFlip().flipPrev();
        }
    };

    const handleNext = () => {
        if (bookRef.current && bookRef.current.pageFlip) {
            bookRef.current.pageFlip().flipNext();
        }
    };

    if (data.pages.length === 0) return null;

    // Ensure we have an even number of pages for HTMLFlipBook
    const paddedPages = [...data.pages];
    if (paddedPages.length % 2 !== 0) {
        paddedPages.push({
            id: `empty-padding`,
            type: 'content',
            pageNumber: paddedPages.length + 1,
            imageUrl: '',
            _originalIndex: -1
        });
    }

    return (
        <div ref={containerRef} className="relative w-full h-[75vh] flex items-center justify-center select-none my-4">
            
            {/* Left Nav */}
            <button
                onClick={handlePrev}
                disabled={isFlipping || currentPageIndex === 0}
                className={`absolute left-4 top-1/2 -translate-y-1/2 z-20 p-3 rounded-full bg-slate-800/80 backdrop-blur-sm transition-all duration-200 text-white shadow-lg hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed`}
            >
                <ChevronLeft className="w-8 h-8" />
            </button>

            {/* FlipBook wrapper */}
            <div
                className={`flipbook-wrapper ${bookPosition === 'cover' ? 'on-cover' : ''} ${bookPosition === 'back' ? 'on-back' : ''} ${isInitial ? 'initial' : ''}`}
                style={{ '--page-width': `${dimensions.width}px` } as React.CSSProperties}
            >
                <div className="relative transition-transform duration-300 origin-center">
                    <FlipBookComponent
                        ref={bookRef}
                        width={dimensions.width}
                        height={dimensions.height}
                        size="fixed"
                        minWidth={200}
                        maxWidth={2000}
                        minHeight={300}
                        maxHeight={2000}
                        maxShadowOpacity={0.5}
                        showCover={true}
                        mobileScrollSupport={true}
                        onFlip={handleFlipWithRef}
                        onChangeState={handleStateChange}
                        className="flipbook-container"
                        style={{}}
                        startPage={0}
                        drawShadow={true}
                        flippingTime={800}
                        usePortrait={isMobile}
                        startZIndex={0}
                        autoSize={false}
                        clickEventForward={true}
                        useMouseEvents={true}
                        swipeDistance={30}
                        showPageCorners={true}
                        disableFlipByClick={false}
                    >
                        {paddedPages.map((page, index) => (
                            index === 0 ? (
                                <CoverPage key={page.id} page={page} isFront={true} />
                            ) : index === paddedPages.length - 1 ? (
                                <CoverPage key={page.id} page={page} isFront={false} />
                            ) : (
                                <Page key={page.id} page={page} number={page.pageNumber || index + 1} />
                            )
                        ))}
                    </FlipBookComponent>

                    {/* Bottom Info Bar below the pages */}
                    <div className="flex w-full mt-6 pointer-events-none" style={{ width: isMobile ? dimensions.width : dimensions.width * 2 }}>
                        {isMobile ? (
                            <div className="flex-1 text-center text-slate-400 text-sm font-medium">
                                {paddedPages[currentPageIndex]?.signatureInfo}
                            </div>
                        ) : (
                            <>
                                <div className="flex-1 text-center text-slate-400 text-sm font-medium">
                                    {currentPageIndex > 0 ? paddedPages[currentPageIndex]?.signatureInfo : ''}
                                </div>
                                <div className="flex-1 text-center text-slate-400 text-sm font-medium">
                                    {currentPageIndex === 0 ? paddedPages[0]?.signatureInfo : 
                                     currentPageIndex < paddedPages.length - 1 ? paddedPages[currentPageIndex + 1]?.signatureInfo : ''}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Right Nav */}
            <button
                onClick={handleNext}
                disabled={isFlipping || currentPageIndex >= paddedPages.length - 1}
                className={`absolute right-4 top-1/2 -translate-y-1/2 z-20 p-3 rounded-full bg-slate-800/80 backdrop-blur-sm transition-all duration-200 text-white shadow-lg hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed`}
            >
                <ChevronRight className="w-8 h-8" />
            </button>
        </div>
    );
};
