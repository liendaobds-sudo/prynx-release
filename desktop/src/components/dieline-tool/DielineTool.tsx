// ============================================================
// DielineTool — Prynx Desktop wrapper for Dieline Generator
// 2-step flow: Gallery (pick box type) → Editor (design)
// ============================================================

import React, { useState, Suspense, lazy, Component, ErrorInfo, ReactNode, useCallback, useEffect } from 'react';
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
        } catch (e: any) {
            toast.dismiss(toastId);
            toast.error(tv('Không thể in file: ') + (e?.message || e));
        }
    }, [dieline, canExport, activeTab, nestingResult, sleeveNestingResult, nestingConfig, openPrintDialog]);

    useEffect(() => {
        const onTriggerPrint = (e: any) => {
            if (isActive && e.detail?.tabId === tabId) handlePrint();
        };
        window.addEventListener('app-trigger-print', onTriggerPrint);
        return () => window.removeEventListener('app-trigger-print', onTriggerPrint);
    }, [isActive, tabId, handlePrint]);

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
        <main className="dieline-tool">
            {printDialog}
            {/* Left Panel — Params or Nesting Config */}
            <aside className="dt-sidebar">
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
            </aside>

            {/* Right Panel — Canvas */}
            <section className="dt-viewport">
                {(isGenerating || generationError) && (
                    <div
                        role="status"
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
                            <button className="dt-toolbar-btn" onClick={regenerate} style={{ color: '#fff' }}>
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
                        onClick={() => setActiveTab('nesting')}
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
                        <div className="dt-stale-overlay" aria-live="polite">
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
