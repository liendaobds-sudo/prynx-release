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
import { useBoxStore } from '../../stores/useBoxStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { APP_VERSION, copyUiDiagnosticReport } from '../../lib/uiErrorDiagnostics';
import { downloadPDF, buildDielinePdfBlob } from '../../lib/dieline/exportPDF';
import { downloadNestingPDF, buildNestingPdfBlob, buildTrayNestingPdfBlob, downloadTrayNestingPDF } from '../../lib/dieline/exportNestingPDF';
import { downloadProductionDielinePDF, downloadProductionNestingPDF, downloadProductionTrayNestingPDF } from '../../lib/dieline/productionPDF';
import '../../styles/dieline-tool.css';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';
import { usePrintDialog } from '../shared/usePrintDialog';
import { toast } from 'sonner';
import { useFeatureActionGuard } from '../../hooks/useToolActivationGuard';

// Lazy load 3D scene (heavy Three.js bundle)
const DielineScene3D = lazy(() => import('./DielineScene3D'));

const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 560;
const SIDEBAR_MIN_HEIGHT = 320;
const SIDEBAR_WIDTH_STORAGE_KEY = 'prynx.dieline.sidebarWidth';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

// ─────────────────────────────────────────────────────────────────────────────────────
// UIUX (audit 2026-08-26 dieline-engine-unlock): phát hiện sớm bộ máy khuôn bế bị khoá.
//
// Bối cảnh: bản phát hành nhúng engine khuôn bế đã mã hoá theo từng phiên bản; khoá mở
// nằm ở claim `rk` của token license. Khi server giữ lại `rk`, công cụ vẫn mở bình thường
// rồi chỉ báo lỗi lúc người dùng đã bấm tạo khuôn (rc.9: sáu lần liên tiếp, sửa số đo hay
// bấm "Thử lại" đều không hết). `warm_dieline_engine` CỐ Ý no-op ở bản đã khoá nên không
// có gì phát hiện sớm hộ.
//
// Vì sao hỏi lúc MỞ CÔNG CỤ, không phải lúc khởi động app: khởi động sẽ làm ồn với người
// không bao giờ dùng khuôn bế, và dựng lại đúng vấn đề "log lỗi mỗi lần khởi động" mà
// warmup no-op tồn tại để tránh.
// ─────────────────────────────────────────────────────────────────────────────────────

type DielineEngineStatus = { locked: boolean; licenseKeyPresent: boolean };

/** Kết quả dùng chung cho cả phiên app — mở lại công cụ không gọi lại endpoint. */
let engineStatusCache: DielineEngineStatus | null = null;
/**
 * "Thế hệ khoá" đã hỏi rồi. Khoá bộ nhớ đệm theo `dielineKeyStatus` để: bình thường chỉ
 * một lượt hỏi mỗi phiên, nhưng khi nhịp heartbeat 5 phút nhận được câu trả lời khác từ
 * server (vd server vừa được sửa và bắt đầu cấp `rk`) thì tự hỏi lại và banner tự mất.
 */
let engineStatusProbedFor: string | null = null;

/**
 * Truy vấn CHỈ-ĐỌC `GET /api/dieline/engine-status`. Luôn 200 ở bản đủ quyền; người dùng
 * Free bị `require_feature` từ chối ở tầng entitlement (403) — trả `null` để KHÔNG hiện
 * banner, vì họ không cần biết chuyện khoá engine.
 *
 * Mọi lỗi (sidecar chưa lên, mạng nội bộ đứt, wheel cũ) đều trả `null`: banner chỉ được
 * hiện khi CHẮC CHẮN engine đã khoá và token thiếu khoá mở, để không báo động sai.
 */
async function fetchDielineEngineStatus(): Promise<DielineEngineStatus | null> {
    try {
        const { authenticatedFetch, getApiUrl } = await import('../../lib/api');
        const response = await authenticatedFetch(`${getApiUrl()}/dieline/engine-status`);
        if (!response.ok) return null;
        const body = await response.json() as { locked?: unknown; license_key_present?: unknown };
        return {
            locked: body?.locked === true,
            licenseKeyPresent: body?.license_key_present === true,
        };
    } catch {
        return null;
    }
}

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
    const requestFeatureAction = useFeatureActionGuard();
    const [view, setView] = useState<'gallery' | 'editor'>('gallery');
    const [activeTab, setActiveTab] = useState<'2d' | '3d' | 'split' | 'nesting'>('2d');
    const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
    const [sidebarDetached, setSidebarDetached] = useState(false);
    const [sidebarPosition, setSidebarPosition] = useState({ x: 20, y: 52 });
    const [sidebarHeight, setSidebarHeight] = useState(640);
    // UIUX (audit 2026-08-26 dieline-engine-unlock): trạng thái bộ máy khuôn bế + nhãn lý do.
    const [engineStatus, setEngineStatus] = useState<DielineEngineStatus | null>(engineStatusCache);
    const [isRecheckingLicense, setIsRecheckingLicense] = useState(false);
    const dielineKeyStatus = useAuthStore((state) => state.dielineKeyStatus);
    const toolRef = useRef<HTMLElement>(null);
    const interactionCleanupRef = useRef<(() => void) | null>(null);
    const sidebarWidthRef = useRef(sidebarWidth);
    const { dieline, nestingResult, sleeveNestingResult, nestingConfig, setVariant, regenerate, isGenerating, isModelCurrent, generationError } = useBoxStore();
    const canExport = Boolean(dieline && isModelCurrent && !isGenerating && !generationError);
    const runGuardedExport = useCallback((action: () => void): boolean => {
        if (!canExport) return false;
        // SEC (audit 2026-08-04 §UI.03/§BE.02): WebView giữ model sau khi
        // downgrade, vì vậy phải đọc lại quyền ngay trước lúc tạo/xuất file.
        return requestFeatureAction('packaging.dieline', action);
    }, [canExport, requestFeatureAction]);

    // [VARIANT 2026-07-29] Người dùng chọn một BIẾN THỂ trong thư viện → vào editor.
    // Store tự suy boxType từ biến thể và áp thuộc tính đã chốt.
    const handleSelectVariant = (variantId: string) => {
        setVariant(variantId);
        setView('editor');
    };

    // UIUX (audit 2026-08-26 dieline-engine-unlock): hỏi trạng thái engine khi MỞ công cụ
    // (view = editor), một lượt cho mỗi "thế hệ khoá". Không chạy ở màn thư viện và không
    // chạy lúc khởi động app.
    useEffect(() => {
        if (view !== 'editor') return;
        if (engineStatusProbedFor === dielineKeyStatus) {
            setEngineStatus(engineStatusCache);
            return;
        }
        engineStatusProbedFor = dielineKeyStatus;
        let cancelled = false;
        void (async () => {
            const status = await fetchDielineEngineStatus();
            if (status) engineStatusCache = status;
            if (!cancelled) setEngineStatus(engineStatusCache);
        })();
        return () => { cancelled = true; };
    }, [view, dielineKeyStatus]);

    // "Kiểm tra lại bản quyền": lấy token mới rồi hỏi lại ngay. Server đã sửa thì token
    // mới có `rk` và banner tự mất, không cần khởi động lại app.
    const handleRecheckLicense = useCallback(async () => {
        setIsRecheckingLicense(true);
        try {
            await useAuthStore.getState().validateLicense();
            // Chốt "thế hệ khoá" TRƯỚC khi hỏi để effect không gọi endpoint lần thứ hai
            // khi `dielineKeyStatus` vừa đổi.
            engineStatusProbedFor = useAuthStore.getState().dielineKeyStatus;
            const status = await fetchDielineEngineStatus();
            if (status) engineStatusCache = status;
            setEngineStatus(engineStatusCache);
        } finally {
            setIsRecheckingLicense(false);
        }
    }, []);

    // "Liên hệ hỗ trợ": copy phiên bản + lý do dạng enum. KHÔNG có token, license key hay
    // giá trị khoá `rk` — chỉ những gì bộ phận hỗ trợ cần để tra đúng bản phát hành.
    // Nội dung report cố ý KHÔNG đi qua `tv()`: bộ phận hỗ trợ luôn đọc một định dạng duy
    // nhất, không phụ thuộc ngôn ngữ giao diện của khách (giống `buildUiDiagnosticReport`).
    const handleCopySupportInfo = useCallback(async () => {
        const report = [
            `PrynX ${APP_VERSION}`,
            'Bộ máy khuôn bế: chưa mở khoá',
            `Trạng thái khoá bản quyền: ${dielineKeyStatus}`,
        ].join('\n');
        if (await copyUiDiagnosticReport(report)) {
            toast.success(tv('Đã copy thông tin hỗ trợ vào bộ nhớ tạm.'));
        } else {
            toast.error(tv('Không copy được — hãy chụp màn hình gửi bộ phận hỗ trợ.'));
        }
    }, [dielineKeyStatus]);

    // Ctrl+P → in đúng thứ ĐANG XEM: tab Nesting in bản xếp khuôn, còn lại in bản
    // trải khuôn 1:1. Dieline vẽ vector tham số (không có file PDF thường trực) nên
    // generate blob tại thời điểm in. Dùng hạ tầng chung (modal tỉ lệ + print_pdf).
    // autoRotate=true: khuôn bế thường ngang, cho xoay lọt khổ giấy tiện hơn.
    const handlePrint = useCallback(async () => {
        if (!dieline || !canExport) {
            toast.warning(tv('Khuôn đang cập nhật hoặc có lỗi; chưa thể in.'));
            return;
        }
        if (!requestFeatureAction('packaging.dieline', () => undefined)) return;
        const toastId = toast.loading(tv('Đang tạo PDF...'));
        try {
            let numPages = 1;
            let blob: Blob | null;
            if (activeTab === 'nesting' && nestingResult) {
                if ((dieline.params.boxType === 'tray' || dieline.params.boxType === 'double_tray') && sleeveNestingResult) {
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
    }, [dieline, canExport, activeTab, nestingResult, sleeveNestingResult, nestingConfig, openPrintDialog, requestFeatureAction]);

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
                <DielineGallery onSelect={handleSelectVariant} />
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
                {/* UIUX (audit 2026-08-26 dieline-engine-unlock): banner cố định, KHÔNG chặn
                    panel tham số. Người dùng vẫn xem/sửa số đo được; toast 403 lúc tạo khuôn
                    giữ nguyên làm đường cuối. Style inline vì lô này không sửa CSS. */}
                {engineStatus?.locked && !engineStatus.licenseKeyPresent && (
                    <div
                        role="status"
                        aria-live="polite"
                        className="dt-engine-locked-banner"
                        style={{
                            margin: '8px 8px 0',
                            padding: '10px 12px',
                            borderRadius: 8,
                            border: '1px solid #f59e0b',
                            background: 'rgba(245, 158, 11, 0.12)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 8,
                            fontSize: 12,
                            lineHeight: 1.5,
                        }}
                    >
                        <strong>{tv('Chưa mở được bộ máy khuôn bế')}</strong>
                        <span>
                            {tv('Bản quyền của máy này còn hiệu lực nhưng chưa nhận được khoá mở bộ máy khuôn bế cho phiên bản đang chạy. Bạn vẫn sửa thông số được, nhưng bấm tạo khuôn sẽ báo lỗi bản quyền.')}
                        </span>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            <button
                                type="button"
                                className="dt-toolbar-btn"
                                onClick={() => { void handleRecheckLicense(); }}
                                disabled={isRecheckingLicense}
                            >
                                {isRecheckingLicense ? tv('Đang kiểm tra…') : tv('Kiểm tra lại bản quyền')}
                            </button>
                            <button
                                type="button"
                                className="dt-toolbar-btn"
                                onClick={() => { void handleCopySupportInfo(); }}
                            >
                                {tv('Liên hệ hỗ trợ')}
                            </button>
                        </div>
                    </div>
                )}
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
                                onClick={() => runGuardedExport(() => downloadPDF(dieline))}>
                                PDF kỹ thuật
                            </button>
                            <button className="dt-export-tab" disabled={!canExport}
                                onClick={() => runGuardedExport(() => downloadProductionDielinePDF(dieline))}
                                title={tv('PDF sạch với màu spot và overprint, không có kích thước/chú thích')}>
                                PDF sản xuất
                            </button>
                        </>
                    )}
                    {activeTab === 'nesting' && dieline && nestingResult && (
                        <>
                            <button className="dt-export-tab" disabled={!canExport}
                                onClick={() => {
                                    runGuardedExport(() => {
                                        if ((dieline.params.boxType === 'tray' || dieline.params.boxType === 'double_tray') && sleeveNestingResult)
                                            downloadTrayNestingPDF(dieline, nestingResult, sleeveNestingResult, nestingConfig);
                                        else downloadNestingPDF(dieline, nestingResult, nestingConfig);
                                    });
                                }}
                                title={t('dieline.dieline:xuat_pdf_binh_ban_xep_khuon')}>
                                PDF kỹ thuật
                            </button>
                            <button className="dt-export-tab" disabled={!canExport}
                                onClick={() => {
                                    runGuardedExport(() => {
                                        if ((dieline.params.boxType === 'tray' || dieline.params.boxType === 'double_tray') && sleeveNestingResult)
                                            downloadProductionTrayNestingPDF(dieline, nestingResult, sleeveNestingResult, nestingConfig);
                                        else downloadProductionNestingPDF(dieline, nestingResult);
                                    });
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
                    {/* isActive: lệnh menu Xem chỉ áp cho tab đang xem (audit menu 2026-07-28 §MB.1) */}
                    {activeTab === '2d' ? (
                        <DielineCanvas2D isActive={isActive !== false} />
                    ) : activeTab === 'nesting' ? (
                        <NestingCanvas isActive={isActive !== false} />
                    ) : activeTab === 'split' ? (
                        <DielineCanvas2D
                            isActive={isActive !== false}
                            rightSlot={
                                <Scene3DErrorBoundary>
                                    <Suspense fallback={
                                        <div className="dt-scene-loading">
                                            <div className="dt-loading-spinner" />
                                            <p>{t('dieline.dieline:dang_tai_mo_phong_3d')}</p>
                                        </div>
                                    }>
                                        {isActive === false ? (
                                            <div className="dt-scene-loading" data-scene-lifecycle="serialized">3D preview paused</div>
                                        ) : (
                                            <DielineScene3D />
                                        )}
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
                                {isActive === false ? (
                                            <div className="dt-scene-loading" data-scene-lifecycle="serialized">3D preview paused</div>
                                        ) : (
                                            <DielineScene3D />
                                        )}
                            </Suspense>
                        </Scene3DErrorBoundary>
                    )}
                </div>
            </section>
        </main>
    );
}
