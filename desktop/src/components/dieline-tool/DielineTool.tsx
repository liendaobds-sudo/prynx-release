// ============================================================
// DielineTool — Prynx Desktop wrapper for Dieline Generator
// 2-step flow: Gallery (pick box type) → Editor (design)
// ============================================================

import React, { useState, Suspense, lazy, Component, ErrorInfo, ReactNode } from 'react';
import DielineGallery from './DielineGallery';
import ParamPanel from './ParamPanel';
import MockupPanel from './MockupPanel';
import DielineCanvas2D from './DielineCanvas2D';
import NestingPanel from './NestingPanel';
import NestingCanvas from './NestingCanvas';
import { useBoxStore } from '../../store/useBoxStore';
import { downloadPDF } from '../../lib/dieline/exportPDF';
import { downloadNestingPDF } from '../../lib/dieline/exportNestingPDF';
import { BoxParams } from '../../lib/dieline/types';
import '../../styles/dieline-tool.css';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';

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

export default function DielineTool() {
  const { t } = useTranslation();
    const [view, setView] = useState<'gallery' | 'editor'>('gallery');
    const [activeTab, setActiveTab] = useState<'2d' | '3d' | 'split' | 'nesting'>('2d');
    const { dieline, nestingResult, nestingConfig, setParam } = useBoxStore();

    // User selects a box type from the gallery → switch to editor
    const handleSelectType = (type: BoxParams['boxType']) => {
        setParam('boxType', type);
        setView('editor');
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
        <main className="dieline-tool">
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
                        <button
                            className="dt-export-tab"
                            onClick={() => downloadPDF(dieline)}
                        >
                            ⬇ PDF
                        </button>
                    )}
                    {activeTab === 'nesting' && dieline && nestingResult && (
                        <button
                            className="dt-export-tab"
                            onClick={() => downloadNestingPDF(dieline, nestingResult, nestingConfig)}
                            title={t('dieline.dieline:xuat_pdf_binh_ban_xep_khuon')}
                        >
                            {t('dieline.dieline:pdf_xep_khuon')}
                        </button>
                    )}
                </div>

                {/* Canvas Area */}
                <div className="dt-canvas-area">
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
