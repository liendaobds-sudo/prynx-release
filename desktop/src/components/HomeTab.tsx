import React, { useState, useRef, useEffect, useCallback } from 'react';
import { TOOL_CATEGORIES, getToolsByCategory, getToolUniqueKey, toolMatchesQuery, type ToolDefinition, type AppToolId } from '../lib/toolRegistry';
import { OFFICE_EXTENSIONS } from '../lib/officeFileTypes';
import { IMAGE_ACCEPT_ATTR, SUPPORTED_IMAGE_EXTENSIONS } from '../lib/imageFileTypes';
import { createPathBackedFile, dispatchSupportedSystemFiles } from '../lib/nativeFileAccess';
import { open } from '@tauri-apps/plugin-dialog';
import { useRecentFiles } from '../lib/useRecentFiles';
import { useAppSettingsStore } from '../stores/appSettingsStore';
import RecentFilesGrid from './RecentFiles/RecentFilesGrid';
import { useTranslation } from 'react-i18next';
import { tv } from '../i18n';
import { appPerf } from '../lib/perfMarks';
import ProFeatureBadge from './license/ProFeatureBadge';

/** accept= dùng cùng nguồn chân lý với dispatcher và converter ảnh. */
const HOME_FILE_ACCEPT = [
  '.pdf',
  IMAGE_ACCEPT_ATTR,
  ...OFFICE_EXTENSIONS.map((ext) => `.${ext}`),
].join(',');

interface Props {
  onOpenApp: (appId: AppToolId, payload?: any) => void;
  isActive?: boolean;
}

// Khoá định danh duy nhất của 1 tool (nhiều tool dùng chung id 'imposition' nên
// phân biệt theo focusFeature / lockedMode trước).
const toolKey = getToolUniqueKey;

// Style khối danh sách (gom 1 chỗ thay vì lặp inline nhiều nơi).
const listWrapStyle = (tight: boolean): React.CSSProperties => ({
  display: 'flex', flexDirection: 'column', gap: '6px',
  marginBottom: tight ? '0' : '8px', marginTop: tight ? '0' : '4px',
});

// ───────────────────────── Module-level components ─────────────────────────
// Khai báo NGOÀI HomeTab để giữ ổn định type → KHÔNG remount cả danh sách mỗi
// lần HomeTab re-render (vd gõ ô tìm kiếm); popover info giữ được trạng thái.

interface ToolItemProps {
  tool: ToolDefinition;
  isFavorite?: boolean;
  isMiniMode: boolean;
  isCompactMode: boolean;
  onOpenApp: (id: AppToolId, payload?: any) => void;
  onToggleFavorite: (key: string) => void;
}

function ToolItem({ tool, isFavorite, isMiniMode, isCompactMode, onOpenApp, onToggleFavorite }: ToolItemProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (isMiniMode) {
    return (
      <button
        onClick={() => onOpenApp(tool.id, tool.defaultPayload)}
        style={{ padding: '12px 0' }}
        className={`relative w-full border ${isFavorite ? 'bg-amber-50/80 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800/50' : 'bg-white dark:bg-zinc-900 border-slate-200 dark:border-white/10'} hover:shadow-sm rounded-lg flex items-center justify-center group`}
        title={tv(tool.title)}
      >
        <div className="text-[26px] flex justify-center group-hover:scale-110 transition-transform origin-center drop-shadow-sm">{tool.icon}</div>
        <ProFeatureBadge featureId={tool.featureId} className="absolute right-1 top-1" />
      </button>
    );
  }

  if (isCompactMode) {
    return (
      <button
        onClick={() => onOpenApp(tool.id, tool.defaultPayload)}
        className={`w-full h-9 rounded-lg flex items-center transition-colors shrink-0 outline-none justify-start px-2 ${isFavorite ? 'bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/30 dark:hover:bg-amber-900/50 text-amber-900 dark:text-amber-100' : 'hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300'} border border-transparent`}
        title={tv(tool.title)}
      >
        <span className="text-[18px] shrink-0 flex items-center justify-center w-6">{tool.icon}</span>
        <span className="ml-2.5 text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">{tv(tool.title)}</span>
        <ProFeatureBadge featureId={tool.featureId} className="ml-auto" />
      </button>
    );
  }

  return (
    <div className="relative">
      <div
        onClick={() => onOpenApp(tool.id, tool.defaultPayload)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenApp(tool.id, tool.defaultPayload); } }}
        style={{ padding: '4px 6px' }}
        className={`flex items-center gap-2.5 text-left w-full ${isFavorite ? 'bg-gradient-to-r from-amber-50/80 to-white dark:from-amber-900/20 dark:to-zinc-900 border border-amber-200 dark:border-amber-800/50 shadow-sm' : 'bg-white dark:bg-zinc-900 border border-slate-200 dark:border-white/10'} ${tool.hoverColor} hover:shadow-sm rounded-lg transition-all group cursor-pointer`}
        title={tv(tool.longDescription) || tv(tool.title)}
      >
        <div className="text-[22px] w-8 flex justify-center group-hover:scale-110 transition-transform origin-center drop-shadow-sm">{tool.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-[13.5px] text-slate-800 dark:text-white leading-tight truncate">{tv(tool.title)}</div>
        </div>
        <ProFeatureBadge featureId={tool.featureId} />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(toolKey(tool)); }}
          title={isFavorite ? t('tabs.home:bo_khoi_yeu_thich') : t('tabs.home:them_vao_yeu_thich')}
          className={`shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors ${isFavorite ? 'text-amber-400' : 'text-slate-300 dark:text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-amber-400'}`}
        >
          <svg className="w-4 h-4" fill={isFavorite ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.5a.56.56 0 011.04 0l2.12 4.3 4.75.69c.46.07.64.63.31.95l-3.44 3.35.81 4.73c.08.46-.4.81-.81.59L12 16.98l-4.25 2.23c-.41.22-.89-.13-.81-.59l.81-4.73-3.44-3.35a.56.56 0 01.31-.95l4.75-.69 2.12-4.3z" /></svg>
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
          title={t('tabs.home:gioi_thieu_cong_cu')}
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        </button>
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="absolute right-2 top-full mt-1 z-50 w-64 max-w-[88vw] p-3 rounded-lg bg-white dark:bg-zinc-800 border border-slate-200 dark:border-white/10 shadow-xl">
            <div className="font-bold text-[13px] text-slate-800 dark:text-white mb-1">{tv(tool.title)}</div>
            <div className="text-[12px] text-slate-600 dark:text-zinc-300 leading-snug">{tv(tool.longDescription)}</div>
          </div>
        </>
      )}
    </div>
  );
}

function DisabledItem({ tool, isMiniMode, isCompactMode }: { tool: ToolDefinition; isMiniMode: boolean; isCompactMode: boolean }) {
  const { t } = useTranslation();
  if (isCompactMode) {
    return (
      <div className="w-full h-9 rounded-lg flex items-center shrink-0 justify-start px-2 opacity-50 cursor-not-allowed grayscale" title={`${tv(tool.title)} (Sắp ra)`}>
        <span className="text-[18px] shrink-0 flex items-center justify-center w-6">{tool.icon}</span>
        <span className="ml-2.5 text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">{tv(tool.title)}</span>
      </div>
    );
  }
  return (
    <div style={{ padding: isMiniMode ? '12px 0' : '4px 6px' }} className={`flex items-center ${isMiniMode ? 'justify-center' : 'gap-2.5 text-left'} w-full bg-slate-50 dark:bg-zinc-900/50 border border-slate-200 dark:border-white/5 rounded-lg opacity-50 cursor-not-allowed grayscale`} title={isMiniMode ? `${tv(tool.title)} (Sắp ra)` : undefined}>
      <div className={`${isMiniMode ? 'text-[26px]' : 'text-[22px] w-8'} flex justify-center`}>{tool.icon}</div>
      {!isMiniMode && (
        <>
          <div className="flex-1">
            <div className="font-bold text-[14px] text-slate-500 dark:text-zinc-400 leading-tight">{tv(tool.title)}</div>
          </div>
          <div className="text-[11px] text-slate-400 dark:text-zinc-600 font-medium whitespace-nowrap">{t('tabs.home:sap_ra')}</div>
        </>
      )}
    </div>
  );
}

function SectionHeader({ id, title, isCollapsed, isMiniMode, isCompactMode, onToggle }: {
  id: string; title: string; isCollapsed: boolean; isMiniMode: boolean; isCompactMode: boolean; onToggle: (id: string) => void;
}) {
  return (
    <div className={`flex justify-between items-center ${isCompactMode ? 'mt-2 mb-1.5 px-2 w-full' : 'mb-3 mt-5 px-1'} first:mt-0`}>
      {isMiniMode ? (
        <div className="w-6 h-[2px] bg-slate-400 dark:bg-zinc-600 opacity-40 mx-auto rounded-full" title={title} />
      ) : isCompactMode ? (
        <div className="w-full flex items-center gap-2">
          <span className={`text-[10px] font-bold uppercase tracking-widest ${id === 'favorites' ? 'text-amber-500' : 'text-slate-500 dark:text-zinc-400'}`}>{title}</span>
          <div className={`flex-1 h-px opacity-40 ${id === 'favorites' ? 'bg-amber-500' : 'bg-slate-300 dark:bg-zinc-600'}`} />
        </div>
      ) : (
        <button onClick={() => onToggle(id)} className="flex items-center gap-2 group outline-none overflow-hidden min-w-0">
          <div className="text-[11.5px] font-black text-slate-500 dark:text-zinc-400 uppercase tracking-widest group-hover:text-slate-700 dark:group-hover:text-zinc-200 transition-colors truncate">{title}</div>
          <svg className={`shrink-0 w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-zinc-300 transition-transform ${isCollapsed ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
        </button>
      )}
    </div>
  );
}

// Guard module-level: mốc "Home dùng được" chỉ ghi một lần cho cold-launch,
// dù HomeTab remount khi chuyển tab.
let homeInteractiveMarked = false;

export default function HomeTab({ onOpenApp, isActive = true }: Props) {
  const { t } = useTranslation();
    const rightPanelWidth = useAppSettingsStore(state => state.homeToolMenuWidth);
    const setRightPanelWidth = useAppSettingsStore(state => state.setHomeToolMenuWidth);
    const collapsedSections = useAppSettingsStore(state => state.collapsedSections);
    const toggleSection = useAppSettingsStore(state => state.toggleSection);
    const [isResizing, setIsResizing] = useState(false);
    const resizerRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const hasRecentFiles = useRecentFiles(state => state.files.length > 0);
    const hiddenTools = useAppSettingsStore(state => state.hiddenTools);
    const favoriteTools = useAppSettingsStore(state => state.favoriteTools);
    const toggleFavoriteTool = useAppSettingsStore(state => state.toggleFavoriteTool);
    const [toolQuery, setToolQuery] = useState('');
    // UIUX (audit 2026-07-27 §D-17): trạng thái đang kéo file lên dropzone → đổi viền/nền sang accent
    const [isDragOver, setIsDragOver] = useState(false);

    // UIUX (audit 2026-07-27 §D-17) fix-verify: trong app Tauri thật (dragDropEnabled)
    // webview NUỐT DOM drag events → onDragOver/onDragLeave KHÔNG BAO GIỜ bắn; đường
    // drop thật là event Tauri (SystemIntegrations lắng tauri://drag-drop). Nghe
    // onDragDropEvent của webview để bật/tắt highlight; DOM handler bên dưới giữ làm
    // fallback khi chạy browser dev.
    useEffect(() => {
        // FILEIO (audit 2026-08-02 §OPEN.3): App giữ tab nền mounted; Home ẩn
        // không được tiếp tục đổi highlight theo native drag của tab đang hoạt động.
        if (!isActive) {
            setIsDragOver(false);
            return;
        }
        if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return;
        let isUnmounted = false;
        let unlistenDrag: (() => void) | null = null;
        import('@tauri-apps/api/webview').then(m =>
            m.getCurrentWebview().onDragDropEvent(ev => {
                const ty = ev.payload.type; // 'enter' | 'over' | 'drop' | 'leave'
                setIsDragOver(ty === 'enter' || ty === 'over');
            })
        ).then(unlisten => {
            if (isUnmounted) unlisten();
            else unlistenDrag = unlisten;
        }).catch(() => { /* API không sẵn có → giữ fallback DOM */ });
        return () => {
            isUnmounted = true;
            if (unlistenDrag) unlistenDrag();
        };
    }, [isActive]);
    const _q = toolQuery.trim().toLowerCase();
    const matchesQuery = (t: ToolDefinition) => toolMatchesQuery(t, toolQuery);

    const startResizing = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);
    }, []);

    const stopResizing = useCallback(() => setIsResizing(false), []);

    const resize = useCallback((e: MouseEvent) => {
        if (isResizing && containerRef.current) {
            const containerRect = containerRef.current.getBoundingClientRect();
            const newWidth = containerRect.right - e.clientX;
            // Tối thiểu 200px để nhãn chữ luôn hiển thị (không thu về icon-only).
            if (newWidth >= 200 && newWidth <= 600) setRightPanelWidth(newWidth);
        }
    }, [isResizing, setRightPanelWidth]);

    useEffect(() => {
        if (isResizing) {
            window.addEventListener('mousemove', resize);
            window.addEventListener('mouseup', stopResizing);
        }
        return () => {
            window.removeEventListener('mousemove', resize);
            window.removeEventListener('mouseup', stopResizing);
        };
    }, [isResizing, resize, stopResizing]);

    // Mốc "Home dùng được" cho baseline khởi động (P0-0). Chỉ đo LẦN MOUNT ĐẦU:
    // HomeTab có thể remount khi chuyển tab, nhưng cold-launch chỉ quan tâm lần đầu.
    useEffect(() => {
        if (homeInteractiveMarked) return;
        homeInteractiveMarked = true;
        appPerf.mark('home-interactive');
        appPerf.measure('startup-to-home-interactive', 'app-mounted', 'home-interactive');
    }, []);

    // Trang Home: KHÔNG thu gọn sang chế độ icon-only (nhìn tệ) — LUÔN hiển thị dạng
    // có chữ. Bỏ isMiniMode (icon); chỉ còn full / compact (đều kèm nhãn chữ).
    const isMiniMode = false;
    const isCompactMode = rightPanelWidth < 280;
    const tight = isCompactMode;

    // ── Render danh sách tool của 1 category (chỉ chế độ list) ──
    const renderToolSection = (categoryId: string) => {
        const allTools = getToolsByCategory(categoryId as any);
        const tools = allTools.filter(t => !hiddenTools.includes(toolKey(t)) && matchesQuery(t) && !favoriteTools.includes(toolKey(t)));
        if (tools.length === 0) return null;
        const enabledTools = tools.filter(t => t.isEnabled);
        const disabledTools = tools.filter(t => !t.isEnabled);
        return (
            <div style={listWrapStyle(tight)} className="transition-opacity duration-300">
                {enabledTools.map((tool, i) => (
                    <ToolItem key={`${toolKey(tool)}-${i}`} tool={tool} isMiniMode={isMiniMode} isCompactMode={isCompactMode} onOpenApp={onOpenApp} onToggleFavorite={toggleFavoriteTool} />
                ))}
                {disabledTools.map((tool, i) => (
                    <DisabledItem key={`${toolKey(tool)}-dis-${i}`} tool={tool} isMiniMode={isMiniMode} isCompactMode={isCompactMode} />
                ))}
            </div>
        );
    };

    return (
        <div ref={containerRef} className="w-full h-full bg-slate-50 dark:bg-zinc-950 flex flex-row overflow-hidden relative selection:bg-indigo-100 dark:selection:bg-indigo-900/50">

            {/* LEFT PANE: Dropzone & Recent Files */}
            <div className={`flex-1 h-full overflow-y-auto px-6 lg:px-8 ${isResizing ? 'transition-none' : 'transition-all duration-300 ease-in-out'}`}>
                <div className={`min-h-full w-full mx-auto flex flex-col py-12 ${hasRecentFiles ? 'max-w-7xl justify-start' : 'max-w-2xl items-center justify-center'}`}>

                    {/* BIG DROPZONE / BROWSE BUTTON */}
                    <div
                        // UIUX (audit 2026-07-27 §D-17) fix-verify: phản hồi thị giác khi kéo file
                        // (fallback browser dev; app Tauri dùng onDragDropEvent ở effect trên).
                        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                        // Guard chống nhấp nháy: dragleave bắn cả khi rê qua phần tử CON —
                        // chỉ tắt highlight khi con trỏ RỜI HẲN dropzone.
                        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false); }}
                        // FILEIO (audit 2026-08-02 §OPEN.3): DOM fallback phải tự dispatch;
                        // preventDefault khiến listener window chủ động nhường quyền cho dropzone này.
                        onDrop={(e) => {
                            e.preventDefault();
                            setIsDragOver(false);
                            dispatchSupportedSystemFiles(Array.from(e.dataTransfer.files));
                        }}
                        onClick={async () => {
                            if ((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
                                try {
                                    const selected = await open({
                                        multiple: false,
                                        filters: [
                                            { name: t('tabs.home:tai_lieu_hinh_anh'), extensions: ['pdf', ...SUPPORTED_IMAGE_EXTENSIONS, ...OFFICE_EXTENSIONS] },
                                            { name: 'Word / Excel', extensions: [...OFFICE_EXTENSIONS] },
                                            { name: 'PDF', extensions: ['pdf'] },
                                        ]
                                    });
                                    if (selected && typeof selected === 'string') {
                                        // FILEIO (audit 2026-08-02 §OPEN.1/§OPEN.3): picker
                                        // dùng cùng probe native và cùng router với Open With/drop.
                                        const { file } = await createPathBackedFile(selected);
                                        dispatchSupportedSystemFiles([file]);
                                    }
                                } catch {
                                    document.getElementById('home-generic-pdf-input')?.click();
                                }
                            } else {
                                document.getElementById('home-generic-pdf-input')?.click();
                            }
                        }}
                        // UIUX (audit 2026-07-27 §D-17): khi isDragOver → viền + nền accent
                        className={`w-full relative rounded-[2rem] border-[3px] border-dashed transition-all cursor-pointer flex flex-col xl:flex-row items-center justify-center gap-6 xl:gap-10 shadow-sm hover:shadow-xl hover:shadow-indigo-500/10 group shrink-0 ${isDragOver ? 'border-app-accent bg-app-accent-soft' : 'bg-white dark:bg-zinc-900 border-indigo-200 dark:border-indigo-900/60 hover:border-indigo-500 hover:bg-indigo-50/50 dark:hover:bg-indigo-950/20'} ${hasRecentFiles ? 'p-6 md:p-8 max-w-2xl mx-auto' : 'p-8 md:p-14'}`}
                    >
                        <input
                            id="home-generic-pdf-input"
                            type="file"
                            accept={HOME_FILE_ACCEPT}
                            className="hidden"
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) dispatchSupportedSystemFiles([file]);
                                e.target.value = '';
                            }}
                        />
                        {/* ICON */}
                        <div className={`shrink-0 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 rounded-3xl flex items-center justify-center group-hover:scale-110 group-hover:-rotate-3 transition-transform drop-shadow-sm ${hasRecentFiles ? 'w-20 h-20 text-5xl' : 'w-24 h-24 md:w-28 md:h-28 text-6xl md:text-7xl'}`}>
                            📁
                        </div>
                        {/* TEXT */}
                        <div className="text-center xl:text-left flex-1 min-w-0">
                            <h2 className={`font-black text-slate-800 dark:text-white tracking-tight ${hasRecentFiles ? 'text-2xl mb-1' : 'text-2xl md:text-3xl mb-2 md:mb-3'}`}>{t('tabs.home:mo_file_pdf')}</h2>
                            <p className="text-slate-500 dark:text-zinc-400 font-medium text-[13px] md:text-[14px] leading-relaxed w-full">{t('tabs.home:click_chon_hoac_keo_tha_file_pdf_vao')}</p>
                            <p className="mt-2 text-[12px] md:text-[13px] text-slate-400 dark:text-zinc-500 font-medium flex items-center gap-1.5 justify-center xl:justify-start">
                                <span>{t('tabs.home:nhan')}</span>
                                <kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-white/15 text-[11px] font-semibold text-slate-600 dark:text-zinc-300">Ctrl + N</kbd>
                                <span>{t('tabs.home:de_tao_trang_trang_moi')}</span>
                            </p>
                        </div>
                    </div>

                    {/* RECENT FILES GRID */}
                    <RecentFilesGrid onOpenFile={(file) => dispatchSupportedSystemFiles([file])} active={isActive} />
                </div>
            </div>

            {/* RESIZER */}
            {/* UIUX (audit 2026-07-27 §A-11): vùng bắt chuột rộng w-2.5 trong suốt, vạch nhìn thấy chỉ 1px */}
            <div
                ref={resizerRef}
                onMouseDown={startResizing}
                className="w-2.5 h-full flex flex-col justify-center items-center shrink-0 z-10 bg-transparent cursor-col-resize group"
            >
                <div className={`w-px h-full mx-auto pointer-events-none transition-colors ${isResizing ? 'bg-app-accent' : 'bg-app-line group-hover:bg-app-accent'}`} />
            </div>

            {/* RIGHT PANE: Tools Menu */}
            <div
                className={`relative h-full bg-slate-50 dark:bg-[#121212] shrink-0 shadow-[-10px_0_30px_rgba(0,0,0,0.03)] flex flex-col border-l border-slate-200 dark:border-zinc-800/50 ${isResizing ? 'select-none pointer-events-none transition-none' : 'transition-all duration-300 ease-in-out'}`}
                style={{ width: `${Math.max(rightPanelWidth, 200)}px` }}
            >
                <div className={`flex-1 overflow-y-auto ${tight ? 'py-2 px-1.5' : 'p-4 md:p-6 lg:p-8'}`}>

                    {/* ── Tool search ── */}
                    {!isMiniMode && (
                        <div className="relative mb-3">
                            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" /></svg>
                            <input
                                value={toolQuery}
                                onChange={e => setToolQuery(e.target.value)}
                                placeholder={t('tabs.home:tim_cong_cu')}
                                aria-label={t('tabs.home:tim_cong_cu_2')}
                                className="w-full h-9 pl-8 pr-7 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-zinc-900 text-[13px] focus:outline-none focus:border-indigo-400"
                            />
                            {toolQuery && (
                                <button onClick={() => setToolQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" title={t('tabs.home:xoa_tim_kiem')}>
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                            )}
                        </div>
                    )}

                    {/* Render Favorite Category */}
                    {(() => {
                        const allTools = TOOL_CATEGORIES.flatMap(c => getToolsByCategory(c.id as any));
                        const favTools = allTools.filter(t => favoriteTools.includes(toolKey(t)) && !hiddenTools.includes(toolKey(t)) && matchesQuery(t));
                        if (favTools.length === 0) return null;
                        const enabledTools = favTools.filter(t => t.isEnabled);
                        const disabledTools = favTools.filter(t => !t.isEnabled);
                        const isCollapsed = !_q && !!collapsedSections['favorites'];
                        return (
                            <React.Fragment key="favorites">
                                <SectionHeader
                                    id="favorites"
                                    title={isCompactMode ? t('tabs.home:yeu_thich') : t('tabs.home:cong_cu_yeu_thich')}
                                    isCollapsed={isCollapsed}
                                    isMiniMode={isMiniMode}
                                    isCompactMode={isCompactMode}
                                    onToggle={toggleSection}
                                />
                                {!isCollapsed && (
                                    <div style={listWrapStyle(tight)} className="transition-opacity duration-300">
                                        {enabledTools.map((tool, i) => (
                                            <ToolItem key={`fav-${toolKey(tool)}-${i}`} tool={tool} isFavorite isMiniMode={isMiniMode} isCompactMode={isCompactMode} onOpenApp={onOpenApp} onToggleFavorite={toggleFavoriteTool} />
                                        ))}
                                        {disabledTools.map((tool, i) => (
                                            <DisabledItem key={`fav-${toolKey(tool)}-dis-${i}`} tool={tool} isMiniMode={isMiniMode} isCompactMode={isCompactMode} />
                                        ))}
                                    </div>
                                )}
                            </React.Fragment>
                        );
                    })()}

                    {/* Render all categories dynamically from registry */}
                    {TOOL_CATEGORIES.map((cat) => {
                        const catTools = getToolsByCategory(cat.id as any).filter(t => !hiddenTools.includes(toolKey(t)) && !favoriteTools.includes(toolKey(t)) && matchesQuery(t));
                        if (catTools.length === 0) return null;
                        const isCollapsed = !_q && !!collapsedSections[cat.id];
                        return (
                            <React.Fragment key={cat.id}>
                                <SectionHeader
                                    id={cat.id}
                                    title={tv(cat.title)}
                                    isCollapsed={isCollapsed}
                                    isMiniMode={isMiniMode}
                                    isCompactMode={isCompactMode}
                                    onToggle={toggleSection}
                                />
                                {!isCollapsed && renderToolSection(cat.id)}
                            </React.Fragment>
                        );
                    })}

                </div>
            </div>

        </div>
    );
}
