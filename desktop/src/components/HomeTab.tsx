import React, { useState, useRef, useEffect, useCallback } from 'react';
import { TOOL_CATEGORIES, getToolsByCategory, toolMatchesQuery, type ToolDefinition, type AppToolId } from '../lib/toolRegistry';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { useRecentFiles } from '../lib/useRecentFiles';
import { useAppSettingsStore } from '../stores/appSettingsStore';
import RecentFilesGrid from './RecentFiles/RecentFilesGrid';

interface Props {
  onOpenApp: (appId: AppToolId, payload?: any) => void;
}

export default function HomeTab({ onOpenApp }: Props) {
    const rightPanelWidth = useAppSettingsStore(state => state.toolMenuWidth);
    const setRightPanelWidth = useAppSettingsStore(state => state.setToolMenuWidth);
    const isExpanded = useAppSettingsStore(state => state.isToolMenuExpanded);
    const setIsExpanded = useAppSettingsStore(state => state.setToolMenuExpanded);
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
    const _q = toolQuery.trim().toLowerCase();
    const matchesQuery = (t: ToolDefinition) => toolMatchesQuery(t, toolQuery);
    const keyOf = (t: ToolDefinition) => t.defaultPayload?.focusFeature || t.defaultPayload?.lockedMode || t.id;

    const startResizing = useCallback((e: React.MouseEvent) => {
        if (isExpanded) return; // Disable drag if expanded
        e.preventDefault();
        setIsResizing(true);
    }, [isExpanded]);

    const stopResizing = useCallback(() => {
        setIsResizing(false);
    }, []);

    const resize = useCallback((e: MouseEvent) => {
        if (isResizing && containerRef.current && !isExpanded) {
            const containerRect = containerRef.current.getBoundingClientRect();
            const newWidth = containerRect.right - e.clientX;
            if (newWidth >= 60 && newWidth <= 600) {
                setRightPanelWidth(newWidth);
            }
        }
    }, [isResizing, isExpanded]);

    useEffect(() => {
        if (isResizing) {
            window.addEventListener('mousemove', resize);
            window.addEventListener('mouseup', stopResizing);
        } else {
            window.removeEventListener('mousemove', resize);
            window.removeEventListener('mouseup', stopResizing);
        }
        return () => {
            window.removeEventListener('mousemove', resize);
            window.removeEventListener('mouseup', stopResizing);
        };
    }, [isResizing, resize, stopResizing]);

    // Computed property: show big cards if forced OR dragged wide enough
    const showCards = isExpanded || (!isExpanded && rightPanelWidth >= 480);
    const isMiniMode = !isExpanded && rightPanelWidth < 120;
    const isCompactMode = !isExpanded && rightPanelWidth < 280 && !isMiniMode;

    // -- COMPACT UI COMPONENTS (Slide Bar mode) --
    const ToolItem = ({ tool, isFavorite }: { tool: ToolDefinition, isFavorite?: boolean }) => {
        const [open, setOpen] = React.useState(false);
        if (isCompactMode || isMiniMode) {
            if (isMiniMode) {
                return (
                    <button
                        onClick={() => onOpenApp(tool.id, tool.defaultPayload)}
                        style={{ padding: '12px 0' }}
                        className={`w-full border ${isFavorite ? 'bg-amber-50/80 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800/50' : 'bg-white dark:bg-zinc-900 border-slate-200 dark:border-white/10'} hover:shadow-sm rounded-lg flex items-center justify-center group`}
                        title={tool.title}
                    >
                        <div className={`text-[26px] flex justify-center group-hover:scale-110 transition-transform origin-center drop-shadow-sm`}>{tool.icon}</div>
                    </button>
                );
            }
            return (
                <button
                    onClick={() => onOpenApp(tool.id, tool.defaultPayload)}
                    className={`w-full h-9 rounded-lg flex items-center transition-colors shrink-0 outline-none justify-start px-2 ${isFavorite ? 'bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/30 dark:hover:bg-amber-900/50 text-amber-900 dark:text-amber-100' : 'hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300'} border border-transparent`}
                    title={tool.title}
                >
                    <span className="text-[18px] shrink-0 flex items-center justify-center w-6">{tool.icon}</span>
                    <span className="ml-2.5 text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">{tool.title}</span>
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
                    title={tool.longDescription || tool.title}
                >
                    <div className="text-[22px] w-8 flex justify-center group-hover:scale-110 transition-transform origin-center drop-shadow-sm">{tool.icon}</div>
                    <div className="flex-1 min-w-0">
                        <div className="font-bold text-[13.5px] text-slate-800 dark:text-white leading-tight truncate">{tool.title}</div>
                    </div>
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleFavoriteTool(keyOf(tool)); }}
                        title={isFavorite ? 'Bỏ khỏi Yêu thích' : 'Thêm vào Yêu thích'}
                        className={`shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors ${isFavorite ? 'text-amber-400' : 'text-slate-300 dark:text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-amber-400'}`}
                    >
                        <svg className="w-4 h-4" fill={isFavorite ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.5a.56.56 0 011.04 0l2.12 4.3 4.75.69c.46.07.64.63.31.95l-3.44 3.35.81 4.73c.08.46-.4.81-.81.59L12 16.98l-4.25 2.23c-.41.22-.89-.13-.81-.59l.81-4.73-3.44-3.35a.56.56 0 01.31-.95l4.75-.69 2.12-4.3z" /></svg>
                    </button>
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
                        title="Giới thiệu công cụ"
                        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </button>
                </div>
                {open && (
                    <>
                        <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
                        <div className="absolute right-2 top-full mt-1 z-50 w-64 max-w-[88vw] p-3 rounded-lg bg-white dark:bg-zinc-800 border border-slate-200 dark:border-white/10 shadow-xl">
                            <div className="font-bold text-[13px] text-slate-800 dark:text-white mb-1">{tool.title}</div>
                            <div className="text-[12px] text-slate-600 dark:text-zinc-300 leading-snug">{tool.longDescription}</div>
                        </div>
                    </>
                )}
            </div>
        );
    };

    const DisabledItem = ({ tool }: { tool: ToolDefinition }) => {
        if (isCompactMode) {
            return (
                <div className="w-full h-9 rounded-lg flex items-center shrink-0 justify-start px-2 opacity-50 cursor-not-allowed grayscale" title={`${tool.title} (Sắp ra)`}>
                    <span className="text-[18px] shrink-0 flex items-center justify-center w-6">{tool.icon}</span>
                    <span className="ml-2.5 text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">{tool.title}</span>
                </div>
            );
        }

        return (
            <div style={{ padding: isMiniMode ? '12px 0' : '4px 6px' }} className={`flex items-center ${isMiniMode ? 'justify-center' : 'gap-2.5 text-left'} w-full bg-slate-50 dark:bg-zinc-900/50 border border-slate-200 dark:border-white/5 rounded-lg opacity-50 cursor-not-allowed grayscale`} title={isMiniMode ? `${tool.title} (Sắp ra)` : undefined}>
                 <div className={`${isMiniMode ? 'text-[26px]' : 'text-[22px] w-8'} flex justify-center`}>{tool.icon}</div>
                {!isMiniMode && (
                    <>
                        <div className="flex-1">
                            <div className="font-bold text-[14px] text-slate-500 dark:text-zinc-400 leading-tight">
                                {tool.title}
                            </div>
                        </div>
                        <div className="text-[11px] text-slate-400 dark:text-zinc-600 font-medium whitespace-nowrap">(sắp ra)</div>
                    </>
                )}
            </div>
        );
    };

    // -- EXPANDED UI COMPONENTS (Card Grid mode) --
    const ExpandedCard = ({ tool, isFavorite }: { tool: ToolDefinition, isFavorite?: boolean }) => (
        <div 
            onClick={() => onOpenApp(tool.id, tool.defaultPayload)}
            className={`group rounded-2xl p-6 border-2 transition-all cursor-pointer transform hover:-translate-y-1 ${tool.hoverBorder} ${tool.hoverShadow} ${isFavorite ? 'bg-gradient-to-br from-amber-50 to-white dark:from-amber-900/20 dark:to-zinc-900 border-amber-200 dark:border-amber-800/50 shadow-sm' : 'bg-white dark:bg-zinc-900 border-transparent'}`}
        >
            <div className={`w-14 h-14 rounded-xl flex items-center justify-center text-2xl mb-5 shadow-sm group-hover:scale-110 transition-transform ${tool.bgIcon} ${tool.textIcon}`}>
            {tool.icon}
            </div>
            <h3 className="text-lg font-bold text-slate-800 dark:text-white mb-2">{tool.title}</h3>
            <p className="text-sm text-slate-500 dark:text-zinc-400 leading-relaxed font-medium">
            {tool.longDescription}
            </p>
        </div>
    );

    const ExpandedDisabledCard = ({ tool }: { tool: ToolDefinition }) => (
        <div className="bg-slate-50 dark:bg-zinc-900/50 rounded-2xl p-6 border-2 border-slate-200 dark:border-zinc-800 opacity-50 cursor-not-allowed">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center text-2xl mb-5 grayscale">
            {tool.icon}
            </div>
            <h3 className="text-lg font-bold text-slate-600 dark:text-zinc-400 mb-2 flex flex-wrap items-center gap-2">
                {tool.title} <span className="text-[10px] font-normal px-2 py-0.5 bg-slate-200 dark:bg-zinc-800 rounded">Sắp ra mắt</span>
            </h3>
            <p className="text-sm text-slate-500 dark:text-zinc-500 leading-relaxed font-medium">
            {tool.longDescription}
            </p>
        </div>
    );

    const SectionHeader = ({ id, title, isCollapsed }: { id: string, title: string, isCollapsed: boolean }) => (
        <div className={`flex justify-between items-center ${isCompactMode ? 'mt-2 mb-1.5 px-2 w-full' : 'mb-3 mt-5 px-1'} first:mt-0`}>
            {isMiniMode ? (
                <div className="w-6 h-[2px] bg-slate-400 dark:bg-zinc-600 opacity-40 mx-auto rounded-full" title={title} />
            ) : isCompactMode ? (
                <div className="w-full flex items-center gap-2">
                    <span className={`text-[10px] font-bold uppercase tracking-widest ${id === 'favorites' ? 'text-amber-500' : 'text-slate-500 dark:text-zinc-400'}`}>{title}</span>
                    <div className={`flex-1 h-px opacity-40 ${id === 'favorites' ? 'bg-amber-500' : 'bg-slate-300 dark:bg-zinc-600'}`} />
                </div>
            ) : (
                <button onClick={() => toggleSection(id)} className="flex items-center gap-2 group outline-none overflow-hidden min-w-0">
                    <div className="text-[11.5px] font-black text-slate-500 dark:text-zinc-400 uppercase tracking-widest group-hover:text-slate-700 dark:group-hover:text-zinc-200 transition-colors truncate">
                        {title}
                    </div>
                    <svg className={`shrink-0 w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-zinc-300 transition-transform ${isCollapsed ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                </button>
            )}
        </div>
    );

    // ── Render tool items dynamically from registry ──
    const renderToolSection = (categoryId: string, isFirst: boolean) => {
        const allTools = getToolsByCategory(categoryId as any);
        const tools = allTools.filter(t => !hiddenTools.includes(keyOf(t)) && matchesQuery(t) && !favoriteTools.includes(keyOf(t)));
        
        if (tools.length === 0) return null;
        
        const enabledTools = tools.filter(t => t.isEnabled);
        const disabledTools = tools.filter(t => !t.isEnabled);

        return (
            <React.Fragment key={categoryId}>
                {!showCards ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: isCompactMode || isMiniMode ? '0' : '8px', marginTop: isCompactMode || isMiniMode ? '0' : '4px' }} className="transition-opacity duration-300">
                        {enabledTools.map((tool, i) => <ToolItem key={`${tool.id}-${i}`} tool={tool} />)}
                        {disabledTools.map((tool, i) => <DisabledItem key={`${tool.id}-dis-${i}`} tool={tool} />)}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4 mb-8 transition-opacity duration-300">
                        {enabledTools.map((tool, i) => <ExpandedCard key={`${tool.id}-${i}`} tool={tool} />)}
                        {disabledTools.map((tool, i) => <ExpandedDisabledCard key={`${tool.id}-dis-${i}`} tool={tool} />)}
                    </div>
                )}
            </React.Fragment>
        );
    };

    return (
        <div ref={containerRef} className="w-full h-full bg-slate-50 dark:bg-zinc-950 flex flex-row overflow-hidden relative selection:bg-indigo-100 dark:selection:bg-indigo-900/50">
            
            {/* LEFT PANE: Dropzone & Recent Files */}
            <div className={`flex-1 h-full overflow-y-auto px-6 lg:px-8 ${isResizing ? 'transition-none' : 'transition-all duration-300 ease-in-out'} ${isExpanded ? 'opacity-80 scale-[0.98]' : 'opacity-100'}`}>
                <div className={`min-h-full w-full mx-auto flex flex-col py-12 ${hasRecentFiles ? 'max-w-7xl justify-start' : 'max-w-2xl items-center justify-center'}`}>
                    
                    {/* BIG DROPZONE / BROWSE BUTTON */}
                    <div 
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                            e.preventDefault();
                            // File dropping is now handled globally via Tauri's native 'tauri://drop' event in SystemIntegrations.tsx
                            // This ensures we have the absolute file path needed by the backend.
                        }}
                        onClick={async () => {
                            if ((window as any).__TAURI_INTERNALS__) {
                                try {
                                    const selected = await open({
                                        multiple: false,
                                        filters: [{ name: 'Tài liệu & Hình ảnh', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }]
                                    });
                                    if (selected && typeof selected === 'string') {
                                        const { stat } = await import('@tauri-apps/plugin-fs');
                                        const fileStat = await stat(selected);
                                        const name = selected.split('\\').pop() || selected.split('/').pop() || 'unknown';
                                        
                                        const lower = name.toLowerCase();
                                        const type = lower.endsWith('.pdf') ? 'application/pdf' : 
                                                    lower.endsWith('.png') ? 'image/png' : 'image/jpeg';
                                                    
                                        const fileObj = new File([], name, { type });
                                        Object.defineProperty(fileObj, 'path', { value: selected }); // Inject path
                                        Object.defineProperty(fileObj, 'size', { value: fileStat.size });
                                        onOpenApp('imposition', { file: fileObj });
                                    }
                                } catch (e) {
                                    document.getElementById('home-generic-pdf-input')?.click();
                                }
                            } else {
                                document.getElementById('home-generic-pdf-input')?.click();
                            }
                        }}
                        className={`w-full relative bg-white dark:bg-zinc-900 rounded-[2rem] border-[3px] border-dashed border-indigo-200 dark:border-indigo-900/60 hover:border-indigo-500 hover:bg-indigo-50/50 dark:hover:bg-indigo-950/20 transition-all cursor-pointer flex flex-col xl:flex-row items-center justify-center gap-6 xl:gap-10 shadow-sm hover:shadow-xl hover:shadow-indigo-500/10 group shrink-0 ${hasRecentFiles ? 'p-6 md:p-8 max-w-2xl mx-auto' : 'p-8 md:p-14'}`}
                    >
                        <input 
                            id="home-generic-pdf-input" 
                            type="file" 
                            accept="application/pdf,image/png,image/jpeg,image/jpg" 
                            className="hidden" 
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) {
                                    onOpenApp('imposition', { file });
                                }
                                e.target.value = ''; // Reset input
                            }} 
                        />
                        {/* ICON */}
                        <div className={`shrink-0 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 rounded-3xl flex items-center justify-center group-hover:scale-110 group-hover:-rotate-3 transition-transform drop-shadow-sm ${hasRecentFiles ? 'w-20 h-20 text-5xl' : 'w-24 h-24 md:w-28 md:h-28 text-6xl md:text-7xl'}`}>
                        📁
                        </div>
                        {/* TEXT */}
                        <div className="text-center xl:text-left flex-1 min-w-0">
                           <h2 className={`font-black text-slate-800 dark:text-white tracking-tight ${hasRecentFiles ? 'text-2xl mb-1' : 'text-2xl md:text-3xl mb-2 md:mb-3'}`}>Mở File PDF</h2>
                           <p className="text-slate-500 dark:text-zinc-400 font-medium text-[13px] md:text-[14px] leading-relaxed w-full">Click chọn hoặc kéo thả File PDF vào vùng này để bắt đầu.<br/>Không gian làm việc (Workspace) sẽ mở ra ngay lập tức.</p>
                        </div>
                    </div>

                    {/* RECENT FILES GRID */}
                    <RecentFilesGrid onOpenFile={(file) => onOpenApp('imposition', { file })} />
                </div>
            </div>

            {/* RESIZER */}
            <div 
                ref={resizerRef}
                onMouseDown={startResizing}
                className={`w-1 hover:w-1.5 transition-all h-full flex flex-col justify-center items-center shrink-0 z-10 ${isExpanded ? 'bg-slate-200 dark:bg-zinc-800 opacity-0 pointer-events-none' : 'bg-slate-200 dark:bg-zinc-800 hover:bg-indigo-500 dark:hover:bg-indigo-500 cursor-col-resize group'}`}
            >
                <div className={`h-12 w-1 rounded-full text-transparent bg-slate-400/30 group-hover:bg-white transition-colors ${isResizing ? 'bg-indigo-500' : ''}`} />
            </div>

            {/* RIGHT PANE: Tools Menu */}
            <div 
                className={`relative h-full bg-slate-50 dark:bg-[#121212] shrink-0 shadow-[-10px_0_30px_rgba(0,0,0,0.03)] flex flex-col border-l border-slate-200 dark:border-zinc-800/50 ${isResizing ? 'select-none pointer-events-none transition-none' : 'transition-all duration-300 ease-in-out'}`}
                style={{ width: isExpanded ? '33.333%' : `${rightPanelWidth}px` }}
            >
                {/* FLOATING EXPAND TOGGLE */}
                <button 
                    onClick={() => setIsExpanded(!isExpanded)}
                    title={isExpanded ? "Thu gọn về Sidebar" : "Mở rộng lưới Card"}
                    className="absolute z-20 top-1/2 -translate-y-1/2 -left-3.5 flex items-center justify-center w-7 h-7 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-full text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 shadow-sm hover:shadow-md transition-all group"
                >
                    <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 5l-7 7 7 7M21 5l-7 7 7 7" /></svg>
                </button>

                <div className={`flex-1 overflow-y-auto ${isExpanded ? 'w-full !p-8' : isCompactMode || isMiniMode ? 'py-2 px-1.5' : 'p-4 md:p-6 lg:p-8'}`}>
                    
                    {/* ── Tool search ── */}
                    {!isMiniMode && (
                        <div className="relative mb-3">
                            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" /></svg>
                            <input
                                value={toolQuery}
                                onChange={e => setToolQuery(e.target.value)}
                                placeholder="Tìm công cụ..."
                                className="w-full h-9 pl-8 pr-7 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-zinc-900 text-[13px] focus:outline-none focus:border-indigo-400"
                            />
                            {toolQuery && (
                                <button onClick={() => setToolQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" title="Xoá tìm kiếm">
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                            )}
                        </div>
                    )}

                    {/* Render Favorite Category */}
                    {(() => {
                        const allTools = TOOL_CATEGORIES.flatMap(c => getToolsByCategory(c.id as any));
                        // Filter out hidden tools and only keep favorites
                        const favTools = allTools.filter(t => {
                            const key = t.defaultPayload?.focusFeature || t.defaultPayload?.lockedMode || t.id;
                            return favoriteTools.includes(key) && !hiddenTools.includes(key) && matchesQuery(t);
                        });
                        
                        if (favTools.length === 0) return null;
                        
                        const enabledTools = favTools.filter(t => t.isEnabled);
                        const disabledTools = favTools.filter(t => !t.isEnabled);
                        const isCollapsed = !_q && !!collapsedSections['favorites'];
                        
                        return (
                            <React.Fragment key="favorites">
                                <SectionHeader 
                                    id="favorites" 
                                    title={isCompactMode ? "⭐ YÊU THÍCH" : "⭐ CÔNG CỤ YÊU THÍCH"} 
                                    isCollapsed={isCollapsed} 
                                />
                                {!isCollapsed && (
                                    !showCards ? (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: isCompactMode || isMiniMode ? '0' : '8px', marginTop: isCompactMode || isMiniMode ? '0' : '4px' }} className="transition-opacity duration-300">
                                            {enabledTools.map((tool, i) => <ToolItem key={`fav-${tool.id}-${i}`} tool={tool} isFavorite={true} />)}
                                            {disabledTools.map((tool, i) => <DisabledItem key={`fav-${tool.id}-dis-${i}`} tool={tool} />)}
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4 mb-8 transition-opacity duration-300">
                                            {enabledTools.map((tool, i) => <ExpandedCard key={`fav-${tool.id}-${i}`} tool={tool} isFavorite={true} />)}
                                            {disabledTools.map((tool, i) => <ExpandedDisabledCard key={`fav-${tool.id}-dis-${i}`} tool={tool} />)}
                                        </div>
                                    )
                                )}
                            </React.Fragment>
                        );
                    })()}

                    {/* Render all categories dynamically from registry */}
                    {TOOL_CATEGORIES.map((cat) => {
                        const catTools = getToolsByCategory(cat.id as any).filter(t => !hiddenTools.includes(keyOf(t)) && !favoriteTools.includes(keyOf(t)) && matchesQuery(t));
                        if (catTools.length === 0) return null;
                        const isCollapsed = !_q && !!collapsedSections[cat.id];
                        return (
                            <React.Fragment key={cat.id}>
                                <SectionHeader 
                                    id={cat.id} 
                                    title={cat.title} 
                                    isCollapsed={isCollapsed} 
                                />
                                {!isCollapsed && renderToolSection(cat.id, false)}
                            </React.Fragment>
                        );
                    })}

                </div>
            </div>

        </div>
    );
}
