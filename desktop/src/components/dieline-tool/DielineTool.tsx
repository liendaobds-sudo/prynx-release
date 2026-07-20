// ============================================================
// DielineTool — Prynx Desktop wrapper for Dieline Generator
// 2-step flow: Gallery (pick box type) → Editor (design)
// ============================================================

import React, { useState, Suspense, lazy, Component, ErrorInfo, ReactNode, useCallback, useEffect, useRef } from 'react';
import DielineGallery from './DielineGallery';
import ParamPanel from './ParamPanel';
import MockupPanel from './MockupPanel';
import DielineCanvas2D from './DielineCanvas2D';
import NestingPanel from './NestingPanel';
import NestingCanvas from './NestingCanvas';
import { useBoxStore } from '../../store/useBoxStore';
import { downloadPDF, buildDielinePdfBlob } from '../../lib/dieline/exportPDF';
import { downloadNestingPDF, buildNestingPdfBlob, buildTrayNestingPdfBlob, downloadTrayNestingPDF } from '../../lib/dieline/exportNestingPDF';
import { BoxParams } from '../../lib/dieline/types';
import { downloadProductionDielinePDF, downloadProductionNestingPDF, downloadProductionTrayNestingPDF } from '../../lib/dieline/productionPDF';
import '../../styles/dieline-tool.css';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';
import { usePrintDialog } from '../shared/usePrintDialog';
import { toast } from 'sonner';

// Lazy load 3D scene (heavy Three.js bundle)
const DielineScene3D = lazy(() => import('./DielineScene3D'));

const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 560;
const SIDEBAR_MIN_HEIGHT = 320;
const SIDEBAR_WIDTH_STORAGE_KEY = 'prynx.dieline.sidebarWidth';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function getInitialSidebarWidth() {
    if (typeof window === 'undefined') return 280;
    try {
        const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
        return Number.isFinite(saved) && saved > 0
            ? clamp(saved, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
            : 280;
    } catch {
        return 280;
    }
}

// Error boundary for Three.js / WebGL crashes
class Scene3DErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }> {
    state = { hasError: false, error: undefined as Error | undefined };
    static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
    componentDidCatch(error: Error, info: ErrorInfo) { console.error('3D Scene Error:', error, info); }
    render() {
        if (this.state.hasError) {
            return (
                <div className="dt-scene-loading" style={{ flexDirection: 'column', gap: '0.5rem' }}>
                    <span style={{ fontSize: '2rem' }}>⚠️</span>
                    <p>{tv('Lỗi hiển thị 3D')}</p>
                    <p style={{ fontSize: '0.75rem', opacity: 0.6 }}>{this.state.error?.message}</p>
                    <button
                        className="dt-toolbar-btn"
                        onClick={() => this.setState({ hasError: false, error: undefined })}
                    >
                        {tv('Thử lại')}
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

export default function DielineTool({ tabId, isActive }: { tabId?: string; isActive?: boolean } = {}) {
  const { t } = useTranslation();
    const { openPrintDialog, printDialog } = usePrintDialog();
    const [view, setView] = useState<'gallery' | 'editor'>('gallery');
    const [activeTab, setActiveTab] = useState<'2d' | '3d' | 'split' | 'nesting'>('2d');
    const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
    const [sidebarDetached, setSidebarDetached] = useState(false);
    const [sidebarPosition, setSidebarPosition] = useState({ x: 20, y: 52 });
    const [sidebarHeight, setSidebarHeight] = useState(640);
    const toolRef = useRef<HTMLElement>(null);
    const interactionCleanupRef = useRef<(() => void) | null>(null);
    const sidebarWidthRef = useRef(sidebarWidth);
    const { dieline, nestingResult, sleeveNestingResult, nestingConfig, setParam, regenerate, isGenerating, isModelCurrent, generationError } = useBoxStore();
    const canExport = Boolean(dieline && isModelCurrent && !isGenerating && !generationError);

    // User selects a box type from the gallery → switch to editor
    const handleSelectType = (type: BoxParams['boxType']) => {
        setParam('boxType', type);
        setView('editor');
    };

    // Ctrl+P → in đúng thứ ĐANG XEM: tab Nesting in bản xếp khuôn, còn lại in bản
    // trải khuôn 1:1. Dieline vẽ vector tham số (không có file PDF thường trực) nên
    // generate blob tại thời điểm in. Dùng hạ tầng chung (modal tỉ lệ + print_pdf).
    // autoRotate=true: khuôn bế thường ngang, cho xoay lọt khổ giấy tiện hơn.
    const handlePrint = useCallback(async () => {
        if (!dieline || !canExport) {
            toast.warning(tv('Khuôn đang cập nhật hoặc có lỗi; chưa thể in.'));
            return;
        }
        const toastId = toast.loading(tv('Đang tạo PDF...'));
        try {
            let numPages = 1;
            let blob: Blob | null;
            if (activeTab === 'nesting' && nestingResult) {
                if (dieline.params.boxType === 'tray' && sleeveNestingResult) {
                    blob = await buildTrayNestingPdfBlob(dieline, nestingResult, sleeveNestingResult, nestingConfig);
                    numPages = nestingConfig.trayNestingMode === 'split' ? 2 : 1;
                } else {
                    blob = await buildNestingPdfBlob(dieline, nestingResult, nestingConfig);
                }
            } else blob = await buildDielinePdfBlob(dieline);
            toast.dismiss(toastId);
            if (!blob) { toast.error(tv('Không tạo được PDF để in')); return; }
            await openPrintDialog({ source: blob, numPages, autoRotateDefault: true });
        } catch (error: unknown) {
            toast.dismiss(toastId);
            const message = error instanceof Error ? error.message : String(error);
            toast.error(tv('Không thể in file: ') + message);
        }
    }, [dieline, canExport, activeTab, nestingResult, sleeveNestingResult, nestingConfig, openPrintDialog]);

    useEffect(() => {
        const onTriggerPrint = (event: Event) => {
            const detail = (event as CustomEvent<{ tabId?: string }>).detail;
            if (isActive && detail?.tabId === tabId) handlePrint();
        };
        window.addEventListener('app-trigger-print', onTriggerPrint);
        return () => window.removeEventListener('app-trigger-print', onTriggerPrint);
    }, [isActive, tabId, handlePrint]);

    const beginSidebarInteraction = useCallback((
        event: React.PointerEvent,
        mode: 'resize-width' | 'resize-corner' | 'drag',
    ) => {
        if (mode === 'drag' && !sidebarDetached) return;
        if (event.button !== 0) return;

        event.preventDefault();
        const startX = event.clientX;
        const startY = event.clientY;
        const startWidth = sidebarWidth;
        const startHeight = sidebarHeight;
        const startPosition = sidebarPosition;
        const toolBounds = toolRef.current?.getBoundingClientRect();

        const onPointerMove = (moveEvent: PointerEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            if (mode === 'drag' && toolBounds) {
                setSidebarPosition({
                    x: clamp(startPosition.x + dx, 0, Math.max(0, toolBounds.width - startWidth)),
                    y: clamp(startPosition.y + dy, 0, Math.max(0, toolBounds.height - startHeight)),
                });
                return;
            }

            const availableWidth = toolBounds
                ? toolBounds.width - (sidebarDetached ? startPosition.x : 0) - 16
                : SIDEBAR_MAX_WIDTH;
            const maxWidth = Math.min(
                SIDEBAR_MAX_WIDTH,
                Math.max(SIDEBAR_MIN_WIDTH, availableWidth),
            );
            const nextWidth = clamp(startWidth + dx, SIDEBAR_MIN_WIDTH, maxWidth);
            sidebarWidthRef.current = nextWidth;
            setSidebarWidth(nextWidth);
            if (mode === 'resize-corner') {
                const maxHeight = toolBounds
                    ? Math.max(SIDEBAR_MIN_HEIGHT, toolBounds.height - startPosition.y)
                    : window.innerHeight;
                setSidebarHeight(clamp(startHeight + dy, SIDEBAR_MIN_HEIGHT, maxHeight));
            }
        };

        const finishInteraction = () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', finishInteraction);
            window.removeEventListener('pointercancel', finishInteraction);
            document.body.classList.remove('dt-panel-interacting');
            if (mode !== 'drag') {
                try {
                    window.localStorage.setItem(
                        SIDEBAR_WIDTH_STORAGE_KEY,
                        String(Math.round(sidebarWidthRef.current)),
                    );
                } catch {
                    // Storage may be unavailable; resizing itself remains functional.
                }
            }
            interactionCleanupRef.current = null;
        };

        interactionCleanupRef.current?.();
        interactionCleanupRef.current = finishInteraction;
        document.body.classList.add('dt-panel-interacting');
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', finishInteraction, { once: true });
        window.addEventListener('pointercancel', finishInteraction, { once: true });
    }, [sidebarDetached, sidebarHeight, sidebarPosition, sidebarWidth]);

    useEffect(() => () => interactionCleanupRef.current?.(), []);

    const detachSidebar = () => {
        const bounds = toolRef.current?.getBoundingClientRect();
        const availableHeight = bounds?.height ?? window.innerHeight;
        setSidebarHeight(clamp(
            Math.min(640, availableHeight - 32),
            SIDEBAR_MIN_HEIGHT,
            Math.max(SIDEBAR_MIN_HEIGHT, availableHeight),
        ));
        setSidebarPosition({
            x: bounds ? clamp(20, 0, Math.max(0, bounds.width - sidebarWidth)) : 20,
            y: 20,
        });
        setSidebarDetached(true);
    };

    // ─── Gallery View ───
    if (view === 'gallery') {
        return (
            <main className="dieline-tool">
                <DielineGallery onSelect={handleSelectType} />
            </main>
        );
    }

    // ─── Editor View ───
    return (
        <main className="dieline-tool" ref={toolRef}>
            {printDialog}
            {/* Left Panel — Params or Nesting Config */}
            <aside
                className={`dt-sidebar ${sidebarDetached ? 'dt-sidebar-floating' : ''}`}
                style={sidebarDetached
                    ? { width: sidebarWidth, height: sidebarHeight, left: sidebarPosition.x, top: sidebarPosition.y }
                    : { width: sidebarWidth }}
                aria-label={tv('Bảng tùy chỉnh khuôn')}
            >
                <div
                    className="dt-sidebar-toolbar"
                    onPointerDown={(event) => beginSidebarInteraction(event, 'drag')}
                >
                    <span className="dt-sidebar-toolbar-grip" aria-hidden="true">⠿</span>
                    <span className="dt-sidebar-toolbar-title">{tv('Tùy chỉnh khuôn')}</span>
                    <button
                        type="button"
                        className="dt-sidebar-toolbar-button"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => sidebarDetached ? setSidebarDetached(false) : detachSidebar()}
                        title={sidebarDetached ? tv('Ghim bảng vào cạnh trái') : tv('Tách bảng để di chuyển')}
                        aria-label={sidebarDetached ? tv('Ghim bảng vào cạnh trái') : tv('Tách bảng để di chuyển')}
                    >
                        {sidebarDetached ? '⇤' : '↗'}
                    </button>
                </div>
                <div className="dt-sidebar-scroll">
                    {activeTab === 'nesting' ? (
                        <NestingPanel />
                    ) : activeTab === '3d' || activeTab === 'split' ? (
                        <>
                            <ParamPanel onBack={() => setView('gallery')} />
                            <MockupPanel />
                        </>
                    ) : (
                        <ParamPanel onBack={() => setView('gallery')} />
                    )}
                </div>
                <div
                    className="dt-sidebar-resize-handle"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={tv('Kéo để đổi độ rộng bảng tùy chỉnh')}
                    onPointerDown={(event) => beginSidebarInteraction(event, 'resize-width')}
                />
                {sidebarDetached && (
                    <div
                        className="dt-sidebar-corner-resize"
                        role="separator"
                        aria-label={tv('Kéo để đổi kích thước bảng tùy chỉnh')}
                        onPointerDown={(event) => beginSidebarInteraction(event, 'resize-corner')}
                    />
                )}
            </aside>

            {/* Right Panel — Canvas */}
            <section className="dt-viewport">
                {(isGenerating || generationError) && (
                    <div
                        role="status"
                        className={isGenerating ? 'dt-generation-delayed' : undefined}
                        style={{
                            position: 'absolute', top: 10, right: 12, zIndex: 30,
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '7px 10px', borderRadius: 8,
                            background: generationError ? '#7f1d1d' : 'rgba(15, 23, 42, 0.88)',
                            color: '#fff', fontSize: 12, boxShadow: '0 3px 12px rgba(0,0,0,.2)',
                        }}
                    >
                        {isGenerating ? tv('Đang cập nhật khuôn…') : generationError}
                        {generationError && (
                            <button className="dt-toolbar-btn" onClick={() => regenerate(activeTab === 'nesting')} style={{ color: '#fff' }}>
                                {tv('Thử lại')}
                            </button>
                        )}
                    </div>
                )}
                {/* Tab Switcher */}
                <div className="dt-tab-bar">
                    <button
                        className={`dt-tab ${activeTab === '2d' ? 'active' : ''}`}
                        onClick={() => setActiveTab('2d')}
                    >
                        <span className="dt-tab-icon">📐</span>
                        {t('dieline.dieline:ban_ve_2d')}
                    </button>
                    <button
                        className={`dt-tab ${activeTab === '3d' ? 'active' : ''}`}
                        onClick={() => setActiveTab('3d')}
                    >
                        <span className="dt-tab-icon">📦</span>
                        {t('dieline.dieline:mo_phong_3d')}
                    </button>
                    <button
                        className={`dt-tab ${activeTab === 'split' ? 'active' : ''}`}
                        onClick={() => setActiveTab('split')}
                        title={t('dieline.dieline:xem_dong_thoi_ban_ve_2d_va_mo_phong_3d')}
                    >
                        <span className="dt-tab-icon">🔲</span>
                        {t('dieline.dieline:chia_doi')}
                    </button>
                    <button
                        className={`dt-tab ${activeTab === 'nesting' ? 'active' : ''}`}
                        onClick={() => {
                            setActiveTab('nesting');
                            if (!nestingResult || !isModelCurrent) regenerate(true);
                        }}
                    >
                        <span className="dt-tab-icon">📋</span>
                        {t('dieline.dieline:xep_khuon')}
                    </button>
                    {(activeTab === '2d' || activeTab === 'split') && dieline && (
                        <>
                            <button className="dt-export-tab" disabled={!canExport}
                                onClick={() => { if (canExport) downloadPDF(dieline); }}>
                                PDF kỹ thuật
                            </button>
                            <button className="dt-export-tab" disabled={!canExport}
                                onClick={() => { if (canExport) downloadProductionDielinePDF(dieline); }}
                                title={tv('PDF sạch với màu spot và overprint, không có kích thước/chú thích')}>
                                PDF sản xuất
                            </button>
                        </>
                    )}
                    {activeTab === 'nesting' && dieline && nestingResult && (
                        <>
                            <button className="dt-export-tab" disabled={!canExport}
                                onClick={() => {
                                    if (!canExport) return;
                                    if (dieline.params.boxType === 'tray' && sleeveNestingResult)
                                        downloadTrayNestingPDF(dieline, nestingResult, sleeveNestingResult, nestingConfig);
                                    else downloadNestingPDF(dieline, nestingResult, nestingConfig);
                                }}
                                title={t('dieline.dieline:xuat_pdf_binh_ban_xep_khuon')}>
                                PDF kỹ thuật
                            </button>
                            <button className="dt-export-tab" disabled={!canExport}
                                onClick={() => {
                                    if (!canExport) return;
                                    if (dieline.params.boxType === 'tray' && sleeveNestingResult)
                                        downloadProductionTrayNestingPDF(dieline, nestingResult, sleeveNestingResult, nestingConfig);
                                    else downloadProductionNestingPDF(dieline, nestingResult);
                                }}
                                title={tv('PDF xếp khuôn sạch với màu spot và overprint')}>
                                PDF sản xuất
                            </button>
                        </>
                    )}
                </div>

                {/* Canvas Area */}
                <div className="dt-canvas-area">
                    {dieline && !isModelCurrent && (
                        <div className="dt-stale-overlay dt-generation-delayed" aria-live="polite">
                            {generationError ? tv('Khuôn hiện tại đã cũ — hãy sửa lỗi hoặc thử lại.') : tv('Đang tính lại khuôn…')}
                        </div>
                    )}
                    {activeTab === '2d' ? (
                        <DielineCanvas2D />
                    ) : activeTab === 'nesting' ? (
                        <NestingCanvas />
                    ) : activeTab === 'split' ? (
                        <DielineCanvas2D
                            rightSlot={
                                <Scene3DErrorBoundary>
                                    <Suspense fallback={
                                        <div className="dt-scene-loading">
                                            <div className="dt-loading-spinner" />
                                            <p>{t('dieline.dieline:dang_tai_mo_phong_3d')}</p>
                                        </div>
                                    }>
                                        <DielineScene3D />
                                    </Suspense>
                                </Scene3DErrorBoundary>
                            }
                        />
                    ) : (
                        <Scene3DErrorBoundary>
                            <Suspense fallback={
                                <div className="dt-scene-loading">
                                    <div className="dt-loading-spinner" />
                                    <p>{t('dieline.dieline:dang_tai_mo_phong_3d')}</p>
                                </div>
                            }>
                                <DielineScene3D />
                            </Suspense>
                        </Scene3DErrorBoundary>
                    )}
                </div>
            </section>
        </main>
    );
}
