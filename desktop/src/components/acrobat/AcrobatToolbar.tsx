import { useState, useRef, useEffect, type ReactNode } from 'react';
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
    const {
        viewerZoom: zoom, setViewerZoom: setZoom,
        viewerFitMode: fitMode, setViewerFitMode: setFitMode,
        viewerToolMode: toolMode, setViewerToolMode: setToolMode,
        viewerPageDisplayMode: pageDisplayMode, setViewerPageDisplayMode: setPageDisplayMode,
        viewerActivePage: activePage,
        viewerNumPages: numPages,
        isObjectEditMode, setIsObjectEditMode,
        isCropMode, setIsCropMode,
    } = useWorkspaceStore();

    const { activeDashboardTool } = useImposerSettingsStore();
    const { showRulers, toggleRulers } = useAppSettingsStore();
    
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
    const [isFitMenuOpen, setIsFitMenuOpen] = useState(false);

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

    return (
        <div ref={barRef} className={`h-12 w-full shrink-0 bg-[#f3f4f6] dark:bg-[#1e1e1e] border-b border-black/10 dark:border-white/10 flex items-center px-4 shadow-sm z-50 relative overflow-visible gap-2 ${isNarrow ? 'tb-narrow' : ''}`}>
            <style>{`.tb-narrow .tb-label{display:none!important;}`}</style>
            {/* Mép trái: Xuất ảnh / Ghi quy trình (và extra khác từ parent) */}
            <div className="flex items-center gap-1.5 shrink-0 min-w-0">
                {extraActions}
            </div>
            {/* Spacer co được — đẩy nhóm tool navigation/zoom ra giữa */}
            <div className="flex-1 min-w-0" />
            <div className="flex items-center gap-1 min-w-max">
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
                        onClick={() => setIsObjectEditMode(!isObjectEditMode)}
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
                        if (next) { setIsObjectEditMode(false); setToolMode('pointer'); }
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
                            onChange={(e) => setZoomInputVal(e.target.value.replace(/[^0-9]/g, ''))}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    const val = parseInt(zoomInputVal);
                                    if (val >= 1 && val <= 6400) handleCustomZoom(val / 100);
                                    setIsZoomEditing(false);
                                }
                                if (e.key === 'Escape') setIsZoomEditing(false);
                            }}
                            onBlur={() => {
                                const val = parseInt(zoomInputVal);
                                if (val >= 1 && val <= 6400) handleCustomZoom(val / 100);
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
                    <button
                        className="w-4 h-7 flex items-center justify-center text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300 focus:outline-none transition-colors"
                        onClick={() => setIsZoomMenuOpen(!isZoomMenuOpen)}
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
                                
                                <div className="px-4 py-1.5 text-[11px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">{t('misc.acrobatToolbar:thu_phong_vua_man_hinh')}</div>
                                <button className="w-full text-left px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-3 transition-colors" onClick={() => {applyFitWidth(); setIsDisplayMenuOpen(false);}}>
                                    {fitMode === 'width' ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-500"><polyline points="20 6 9 17 4 12"></polyline></svg> : <span className="w-[14px]" />} 
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500 dark:text-zinc-400">
                                      <polyline points="4 3 4 8 20 8 20 3" />
                                      <path d="M16 11H4v11h16v-8z" />
                                      <path d="M16 11v4h4" />
                                      <path d="M7 18h10M9 16l-2 2 2 2M15 16l2 2-2 2" />
                                    </svg>
                                    <span>{t('misc.acrobatToolbar:vua_chieu_ngang')}</span>
                                </button>
                                <button className="w-full text-left px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-3 transition-colors" onClick={() => {applyFitPage(); setIsDisplayMenuOpen(false);}}>
                                    {fitMode === 'page' ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-500"><polyline points="20 6 9 17 4 12"></polyline></svg> : <span className="w-[14px]" />} 
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500 dark:text-zinc-400">
                                      <path d="M15 2H5v20h14V8z" />
                                      <path d="M15 2v6h6" />
                                      <path d="M8.5 11.5l2.5 2.5M8.5 11.5h2M8.5 11.5v2M15.5 11.5l-2.5 2.5M15.5 11.5h-2M15.5 11.5v2M8.5 18.5l2.5-2.5M8.5 18.5h2M8.5 18.5v-2M15.5 18.5l-2.5-2.5M15.5 18.5h-2M15.5 18.5v-2" />
                                    </svg>
                                    <span>{t('misc.acrobatToolbar:vua_tron_trang')}</span>
                                </button>

                                <div className="w-full h-px bg-black/10 dark:bg-white/10 my-1.5" />

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
