import { useState, useRef, useEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useAppSettingsStore } from '../../stores/appSettingsStore';
import { useImposerSettingsStore } from '../imposition-tools/useImposerSettingsStore';
import { useTranslation } from 'react-i18next';
import { getShortcutLabel } from '../../lib/keyboardShortcuts';
import { CropIcon } from '../shared/ToolIcons';

interface AcrobatToolbarProps {
    pageOrderLength: number;
    navigatePage: (page: number) => void;
    applyFitWidth: () => void;
    applyFitPage: () => void;
    onOpenRotateModalOrTools: (type: 'tools' | 'delete') => void;
    /** Mép trái: Xuất ảnh, Ghi quy trình… */
    extraActions?: ReactNode;
    /** Mép phải: Mở bằng AI/Corel… */
    extraActionsRight?: ReactNode;
}

export function AcrobatToolbar({ pageOrderLength, navigatePage, applyFitWidth, applyFitPage, onOpenRotateModalOrTools, extraActions, extraActionsRight }: AcrobatToolbarProps) {
  const { t } = useTranslation();
    // PERF (audit 2026-08-22 §UX.S.03): toolbar chỉ cần các field điều khiển
    // bên dưới; subscribe toàn Workspace khiến mọi lần cuộn/render thumbnail
    // kéo theo một render toolbar dù trạng thái nút không đổi.
    const {
        viewerZoom: zoom, setViewerZoom: setZoom,
        viewerFitMode: fitMode, setViewerFitMode: setFitMode,
        viewerToolMode: toolMode, setViewerToolMode: setToolMode,
        viewerPageDisplayMode: pageDisplayMode, setViewerPageDisplayMode: setPageDisplayMode,
        viewerActivePage: activePage,
        isObjectEditMode, setIsObjectEditMode,
       isCropMode, setIsCropMode,
   } = useWorkspaceStore(useShallow(state => ({
        viewerZoom: state.viewerZoom,
        setViewerZoom: state.setViewerZoom,
        viewerFitMode: state.viewerFitMode,
        setViewerFitMode: state.setViewerFitMode,
        viewerToolMode: state.viewerToolMode,
        setViewerToolMode: state.setViewerToolMode,
        viewerPageDisplayMode: state.viewerPageDisplayMode,
        setViewerPageDisplayMode: state.setViewerPageDisplayMode,
        viewerActivePage: state.viewerActivePage,
        isObjectEditMode: state.isObjectEditMode,
        setIsObjectEditMode: state.setIsObjectEditMode,
        isCropMode: state.isCropMode,
        setIsCropMode: state.setIsCropMode,
   })));

    const activeDashboardTool = useImposerSettingsStore(state => state.activeDashboardTool);
    const showRulers = useAppSettingsStore(state => state.showRulers);
    const toggleRulers = useAppSettingsStore(state => state.toggleRulers);

    
    const handleCustomZoom = (newZoom: number | ((z: number) => number)) => {
        setZoom(newZoom);
        setFitMode('custom');
        // GIỮ NGUYÊN chế độ hiển thị (single_fit/two_fit vẫn pan được sau khi safe-center).
        // Trước đây đổi sang *_scroll (Virtuoso) làm reset scroll về góc trên-trái + mất neo tâm.
    };

    const isVdpMode = activeDashboardTool === 'datamerge' || activeDashboardTool === 'numbering';

    // Local-only toolbar state
    const [pageInput, setPageInput] = useState<string>(String(activePage));
    const [isZoomEditing, setIsZoomEditing] = useState(false);
    const [zoomInputVal, setZoomInputVal] = useState('');
    const [isZoomMenuOpen, setIsZoomMenuOpen] = useState(false);
    const [isDisplayMenuOpen, setIsDisplayMenuOpen] = useState(false);

    // Sync pageInput when activePage changes from outside
    const [prevActivePage, setPrevActivePage] = useState(activePage);
    if (activePage !== prevActivePage) {
        setPrevActivePage(activePage);
        setPageInput(String(activePage));
    }

    // Thu hẹp: đo bề rộng THẬT của toolbar (không theo cửa sổ) → khi hẹp thì gắn
    // class 'tb-narrow' để CSS ẩn các nhãn chữ (.tb-label), chỉ còn icon → hết đè.
    const barRef = useRef<HTMLDivElement>(null);
    const [isNarrow, setIsNarrow] = useState(false);
    useEffect(() => {
        const el = barRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect.width ?? 0;
            setIsNarrow(w < 860);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // UIUX (audit 2026-08-01): popup toolbar nổi trên ThumbSidebar; sidebar nằm sau trong DOM.
    return (
        <div ref={barRef} className={`h-12 w-full shrink-0 bg-[#f3f4f6] dark:bg-[#1e1e1e] border-b border-black/10 dark:border-white/10 flex items-center px-4 shadow-sm z-[70] relative overflow-visible gap-2 ${isNarrow ? 'tb-narrow' : ''}`}>
            <style>{`.tb-narrow .tb-label{display:none!important;}`}</style>
            {/* Mép trái: Xuất ảnh / Ghi quy trình (và extra khác từ parent) */}
            <div className="flex items-center gap-1.5 shrink-0 min-w-0">
                {extraActions}
            </div>
            {/* Spacer co được — đẩy nhóm tool navigation/zoom ra giữa */}
            <div className="flex-1 min-w-0" />
            <div className="flex min-w-0 max-w-full shrink-0 items-center gap-1 overflow-x-auto scrollbar-thin">
                <button className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300 transition-colors" onClick={() => navigatePage(activePage - 1)} title={`Previous Page (${getShortcutLabel('pages.previous')})`} aria-label="Previous Page">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16V8m-3 3l3-3 3 3"/></svg>
                </button>
                <button className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300 transition-colors" onClick={() => navigatePage(activePage + 1)} title={`Next Page (${getShortcutLabel('pages.next')})`} aria-label="Next Page">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8m-3-3l3 3 3-3"/></svg>
                </button>
                
                <div className="mx-2 flex items-center text-[13px] font-medium text-slate-600 dark:text-zinc-300">
                   <input 
                      type="text" className="w-9 h-7 text-center border border-black/20 dark:border-white/20 rounded bg-white dark:bg-[#1e1e1e] mx-1 focus:outline-none focus:border-blue-500" 
                      value={pageInput} 
                      onChange={e => setPageInput(e.target.value)}
                      onBlur={() => navigatePage(parseInt(pageInput) || 1)}
                      onKeyDown={e => e.key === 'Enter' && navigatePage(parseInt(pageInput) || 1)}
                   /> 
                   <span className="mx-1">/</span> 
                   <span className="mr-1">{pageOrderLength || '-'}</span>
                </div>
                
                <div className="w-px h-5 bg-black/10 dark:bg-white/10 mx-2"></div>
                
                <button 
                    className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${toolMode === 'pointer' && !isObjectEditMode && !isVdpMode ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300'}`} 
                    onClick={() => setToolMode('pointer')} title={`Pointer Tool (${getShortcutLabel('viewer.pointer')})`} aria-label="Pointer Tool">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="0.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86 2.89 4.8 2.58-1.55-2.89-4.8 4.79-.19c.45-.02.66-.56.34-.86L5.5 3.21z"/></svg>
                </button>
                <button 
                    className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${toolMode === 'hand' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300'}`}
                    onClick={() => setToolMode('hand')} title={`Pan Tool (${getShortcutLabel('viewer.hand')})`} aria-label="Pan Tool">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/>
                        <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/>
                        <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/>
                        <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>
                    </svg>
                </button>

                <button
                    type="button"
                    className={`h-8 min-w-10 px-1.5 flex items-center justify-center rounded text-[11px] font-bold tracking-wide transition-colors ${toolMode === 'dimension' ? 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/30 ring-1 ring-rose-300 dark:ring-rose-700' : 'hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300'}`}
                    // preventDefault trên mousedown: không lấy focus → Space/phím sau không kích hoạt nhầm nút.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                        const next = toolMode === 'dimension' ? 'pointer' : 'dimension';
                        setToolMode(next);
                        if (next === 'dimension') {
                            setIsObjectEditMode(false);
                            setIsCropMode(false);
                            if (!showRulers) toggleRulers();
                        }
                    }}
                    title="DIM — đo khoảng cách thực giữa hai guide (D)"
                    aria-label="Công cụ DIM đo khoảng cách"
                >
                    DIM
                </button>
                {/* Old Selection Tool removed - object management now integrated into Object Edit mode with better PDFium-based listing */}

                {/* Chế độ Chỉnh sửa đối tượng — độc lập Selection Tool. Màu emerald để phân biệt với Selection (cam). */}
                {isObjectEditMode !== undefined && (
                    <button
                        className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${isObjectEditMode ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 ring-1 ring-emerald-300 dark:ring-emerald-700' : 'hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300'}`}
                        onClick={() => {
                           const next = !isObjectEditMode;
                           setIsObjectEditMode(next);
                        }}
                        title={`${t('misc.acrobatToolbar:chinh_sua_doi_tuong_di_chuyen_resize')} (${getShortcutLabel('viewer.object_edit')})`}
                        aria-label={t('misc.acrobatToolbar:chinh_sua_doi_tuong')}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                    </button>
                )}

                {/* Crop PDF: scan a region and edit it in the right-hand panel. */}
                <button
                    className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${isCropMode ? 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/30 ring-1 ring-orange-300 dark:ring-orange-700' : 'hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300'}`}
                    onClick={() => {
                        const next = !isCropMode;
                        setIsCropMode(next);
                       if (next) {
                           setIsObjectEditMode(false); setToolMode('pointer');
                       }
                    }}
                    title={`${t('misc.acrobatToolbar:crop_pdf_quet_chon_vung_roi_nhan_enter')} (${getShortcutLabel('viewer.crop')})`}
                    aria-label="Crop PDF"
                >
                    <CropIcon width="20" height="20" />
                </button>

                <div className="w-px h-5 bg-black/10 dark:bg-white/10 mx-2"></div>

                <button className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300 transition-colors" onClick={() => handleCustomZoom(z => Math.max(0.01, typeof z === 'number' ? z / 1.25 : 1))} title={`Zoom Out (${getShortcutLabel('view.zoom_out')})`} aria-label="Zoom Out">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3M8 11h6"/></svg>
                </button>
                <button className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300 transition-colors" onClick={() => handleCustomZoom(z => Math.min(64, typeof z === 'number' ? z * 1.25 : 1))} title={`Zoom In (${getShortcutLabel('view.zoom_in')})`} aria-label="Zoom In">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3M8 11h6M11 8v6"/></svg>
                </button>
                
                <div className="relative mx-1 flex items-center">
                    {isZoomEditing ? (
                        <input
                            type="text"
                            autoFocus
                            className="w-16 h-7 text-center text-[13px] border border-blue-400 rounded bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 focus:outline-none"
                            value={zoomInputVal}
                            // UIUX (audit 2026-07-27 §C-17): cho phép số thập phân (1 dấu chấm), vd "62.5".
                            onChange={(e) => {
                                const raw = e.target.value.replace(/[^0-9.]/g, '');
                                const firstDot = raw.indexOf('.');
                                setZoomInputVal(firstDot === -1 ? raw : raw.slice(0, firstDot + 1) + raw.slice(firstDot + 1).replace(/\./g, ''));
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    // UIUX (audit 2026-07-27 §C-17): parseFloat + CLAMP về biên 1–6400 (không nuốt im lặng).
                                    const val = parseFloat(zoomInputVal);
                                    if (!isNaN(val)) handleCustomZoom(Math.min(6400, Math.max(1, val)) / 100);
                                    setIsZoomEditing(false);
                                }
                                if (e.key === 'Escape') setIsZoomEditing(false);
                            }}
                            onBlur={() => {
                                // UIUX (audit 2026-07-27 §C-17): parseFloat + CLAMP về biên 1–6400 (không nuốt im lặng).
                                const val = parseFloat(zoomInputVal);
                                if (!isNaN(val)) handleCustomZoom(Math.min(6400, Math.max(1, val)) / 100);
                                setIsZoomEditing(false);
                            }}
                        />
                    ) : (
                        <button
                            className="h-7 px-2 text-[13px] text-slate-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 rounded cursor-text transition-colors tabular-nums"
                            onClick={() => { setZoomInputVal(String(Math.round(zoom * 100))); setIsZoomEditing(true); }}
                            title={t('misc.acrobatToolbar:nhan_de_nhap_ty_le')}
                        >
                            {Math.round(zoom * 100)}%
                        </button>
                    )}
                    {/* UIUX (audit 2026-07-27 §C-10): mở rộng vùng bấm w-4→w-6 + thêm title (tooltip). */}
                    <button
                        className="w-6 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300 focus:outline-none transition-colors"
                        onClick={() => setIsZoomMenuOpen(!isZoomMenuOpen)}
                        title={t('misc.acrobatToolbar:chon_muc_thu_phong')}
                        aria-label={t('misc.acrobatToolbar:chon_muc_thu_phong')}
                    >
                        <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M0 0l5 6 5-6z"/></svg>
                    </button>

                    {isZoomMenuOpen && (
                        <div className="absolute top-full right-0 mt-1 w-20 bg-white dark:bg-zinc-800 rounded shadow-lg py-1 border border-black/10 dark:border-white/10 z-[100] animate-in fade-in zoom-in-95 duration-100 h-64 overflow-y-auto">
                            {[1, 2, 5, 10, 25, 50, 75, 100, 150, 200, 400, 800, 1600, 3200, 6400].map(val => (
                                <button
                                    key={val}
                                    className="w-full text-center px-2 py-1.5 text-[13px] text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors"
                                    onClick={() => { handleCustomZoom(val / 100); setIsZoomMenuOpen(false); }}
                                >
                                    {val}%
                                </button>
                            ))}
                        </div>
                    )}
                    {isZoomMenuOpen && (
                        <div className="fixed inset-0 z-40" onClick={() => setIsZoomMenuOpen(false)} />
                    )}
                </div>

                {/* UIUX (audit 2026-07-27 §C-02, chỉnh theo feedback): 3 nút 1-click Vừa ngang /
                    Vừa cả trang / 1:1 — icon vẽ lại tối giản cho đọc được ở 18px, màu active
                    theo tông XANH DƯƠNG chung của toolbar (Pointer/Hand), không dùng accent
                    tím lạc tông giữa cụm. */}
                <div className="w-px h-5 bg-black/10 dark:bg-white/10 mx-1"></div>
                <button
                    className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${fitMode === 'width' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300'}`}
                    onClick={applyFitWidth}
                    title={`${t('misc.acrobatToolbar:vua_chieu_ngang', 'Vừa chiều ngang')} (${getShortcutLabel('view.fit_width')})`}
                    aria-label={t('misc.acrobatToolbar:vua_chieu_ngang', 'Vừa chiều ngang')}
                >
                    {/* Trang + mũi tên ngang hai đầu */}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="5" width="18" height="14" rx="1.5" />
                        <path d="M7.5 12h9" />
                        <path d="M9.5 9.5L7 12l2.5 2.5" />
                        <path d="M14.5 9.5L17 12l-2.5 2.5" />
                    </svg>
                </button>
                <button
                    className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${fitMode === 'page' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300'}`}
                    onClick={applyFitPage}
                    title={`${t('misc.acrobatToolbar:vua_tron_trang')} (${getShortcutLabel('view.fit_page')})`}
                    aria-label={t('misc.acrobatToolbar:vua_tron_trang')}
                >
                    {/* Trang nằm gọn trong 4 ngoặc góc */}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8" />
                        <path d="M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8" />
                        <path d="M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16" />
                        <path d="M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16" />
                        <rect x="8.5" y="6.5" width="7" height="11" rx="1" />
                    </svg>
                </button>
                <button
                    className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300 transition-colors text-[11px] font-bold tracking-tight"
                    onClick={() => handleCustomZoom(1)}
                    title={`${t('misc.acrobatToolbar:kich_thuoc_that_100', 'Kích thước thật 100%')} (${getShortcutLabel('view.actual_size')})`}
                    aria-label={t('misc.acrobatToolbar:kich_thuoc_that_100', 'Kích thước thật 100%')}
                >
                    {/* Chữ thường như nút DIM — rõ hơn nhét chữ vào SVG 7px */}
                    1:1
                </button>

                <div className="relative mx-1">
                    <button className={`h-8 px-2 flex items-center justify-center gap-1.5 rounded transition-colors ${isDisplayMenuOpen ? 'bg-black/10 dark:bg-white/20' : 'hover:bg-black/5 dark:hover:bg-white/10'} text-slate-700 dark:text-zinc-300`} onClick={() => setIsDisplayMenuOpen(!isDisplayMenuOpen)} title={t('misc.acrobatToolbar:hien_thi_trang')} aria-label={t('misc.acrobatToolbar:hien_thi_trang')}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            {pageDisplayMode === 'single_fit' && <rect x="5" y="3" width="14" height="18" rx="2" />}
                            {pageDisplayMode === 'single_scroll' && <><rect x="5" y="2" width="14" height="9" rx="2" /><rect x="5" y="13" width="14" height="9" rx="2" /></>}
                            {pageDisplayMode === 'two_fit' && <><rect x="2" y="4" width="9" height="16" rx="2" /><rect x="13" y="4" width="9" height="16" rx="2" /></>}
                            {pageDisplayMode === 'two_scroll' && <><rect x="2" y="2" width="9" height="9" rx="2" /><rect x="13" y="2" width="9" height="9" rx="2" /><rect x="2" y="13" width="9" height="9" rx="2" /><rect x="13" y="13" width="9" height="9" rx="2" /></>}
                        </svg>
                        <span className="text-[13px] font-medium tb-label">{t('misc.acrobatToolbar:hien_thi')}</span>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
                    </button>
                    {isDisplayMenuOpen && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setIsDisplayMenuOpen(false)} />
                            <div className="absolute top-10 right-0 w-64 bg-white dark:bg-[#2d3236] border border-black/10 dark:border-white/10 shadow-xl rounded py-1.5 z-50 text-[13px] text-slate-700 dark:text-zinc-200">
                                
                                {/* UIUX (audit 2026-07-27 §C-02, feedback user): bỏ mục "Thu phóng (vừa
                                    màn hình)" — đã có 2 nút fit 1-click ngay cạnh dropdown, giữ bản sao
                                    trong menu chỉ làm dài thêm. Dropdown giờ thuần Bố cục trang. */}
                                <div className="px-4 py-1.5 text-[11px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">{t('misc.acrobatToolbar:bo_cuc_trang')}</div>
                                <button className="w-full text-left px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-3 transition-colors" onClick={() => {setPageDisplayMode('single_fit'); setIsDisplayMenuOpen(false);}}>
                                    {pageDisplayMode === 'single_fit' ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-500"><polyline points="20 6 9 17 4 12"></polyline></svg> : <span className="w-[14px]" />} 
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-slate-500 dark:text-zinc-400"><rect x="5" y="3" width="14" height="18" rx="2" /></svg>
                                    <span>{t('misc.acrobatToolbar:xem_mot_trang')}</span>
                                </button>
                                <button className="w-full text-left px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-3 transition-colors" onClick={() => {setPageDisplayMode('single_scroll'); setIsDisplayMenuOpen(false);}}>
                                    {pageDisplayMode === 'single_scroll' ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-500"><polyline points="20 6 9 17 4 12"></polyline></svg> : <span className="w-[14px]" />} 
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-slate-500 dark:text-zinc-400"><rect x="5" y="2" width="14" height="9" rx="2" /><rect x="5" y="13" width="14" height="9" rx="2" /></svg>
                                    <span>{t('misc.acrobatToolbar:cuon_trang_doc')}</span>
                                </button>
                                <button className="w-full text-left px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-3 transition-colors" onClick={() => {setPageDisplayMode('two_fit'); setIsDisplayMenuOpen(false);}}>
                                    {pageDisplayMode === 'two_fit' ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-500"><polyline points="20 6 9 17 4 12"></polyline></svg> : <span className="w-[14px]" />} 
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-slate-500 dark:text-zinc-400"><rect x="2" y="4" width="9" height="16" rx="2" /><rect x="13" y="4" width="9" height="16" rx="2" /></svg>
                                    <span>{t('misc.acrobatToolbar:xem_hai_trang')}</span>
                                </button>
                                <button className="w-full text-left px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-3 transition-colors" onClick={() => {setPageDisplayMode('two_scroll'); setIsDisplayMenuOpen(false);}}>
                                    {pageDisplayMode === 'two_scroll' ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-500"><polyline points="20 6 9 17 4 12"></polyline></svg> : <span className="w-[14px]" />} 
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-slate-500 dark:text-zinc-400"><rect x="2" y="2" width="9" height="9" rx="2" /><rect x="13" y="2" width="9" height="9" rx="2" /><rect x="2" y="13" width="9" height="9" rx="2" /><rect x="13" y="13" width="9" height="9" rx="2" /></svg>
                                    <span>{t('misc.acrobatToolbar:cuon_hai_trang')}</span>
                                </button>
                            </div>
                        </>
                    )}
                </div>

                <button className="w-8 h-8 flex items-center justify-center rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 transition-colors" onClick={() => onOpenRotateModalOrTools('delete')} title={t('misc.acrobatToolbar:xoa_trang_quick_delete')} aria-label={t('misc.acrobatToolbar:xoa_trang')}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>

            </div>

            {/* Spacer phải + actions mép phải (Mở bằng AI/Corel…) */}
            <div className="flex-1 min-w-0 flex items-center justify-end gap-2">
                {extraActionsRight}
            </div>
        </div>
    );
}
