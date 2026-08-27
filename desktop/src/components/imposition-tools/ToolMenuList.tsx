import React, { useEffect, useRef } from 'react';
import { ToolItem } from './SharedUI';
import { TOOL_CATEGORIES, getToolsByCategory, getToolUniqueKey, toolMatchesQuery, type ToolDefinition } from '../../lib/toolRegistry';
import { useAppSettingsStore } from '../../stores/appSettingsStore';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';
import { useToolActivationGuard } from '../../hooks/useToolActivationGuard';
import { isWorkspaceTool } from './types';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

// UIUX (audit 2026-08-22 §UX.MT.13): catalog và panel thiết lập có thể tồn tại
// song song; catalog phải phản ánh đúng công cụ đang hoạt động.
interface ToolMenuListProps {
    setActiveTool: (tool: string) => void;
    setTaskMode: (mode: string) => void;
    onActiveToolChange?: (tool: string) => void;
    activeTool?: string;
}

const SectionToggle = ({ sectionKey, label, collapsed, onToggle }: { sectionKey: string; label: string; collapsed: boolean; onToggle: (key: string) => void }) => (
    <div className="mb-3 mt-5 flex items-center justify-between px-1 first:mt-0">
        <button
            type="button"
            onClick={() => onToggle(sectionKey)}
            aria-expanded={!collapsed}
            className="group flex min-w-0 items-center gap-2 overflow-hidden rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
        >
            <span className="truncate text-[11.5px] font-black uppercase tracking-widest text-slate-500 transition-colors group-hover:text-slate-700 dark:text-zinc-400 dark:group-hover:text-zinc-200">{label}</span>
            <svg className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-hover:text-slate-600 dark:group-hover:text-zinc-300 ${collapsed ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
        </button>
    </div>
);

// UIUX (feedback 2026-08-27 §MENU.PARITY): dùng cùng nhịp card/nhóm với Home;
// catalog trong PDF chỉ khác chiều rộng vì còn phải chia chỗ cho panel thiết lập.
const TOOL_LIST_CLASS_NAME = 'mt-1 mb-2 flex flex-col gap-[6px] transition-opacity duration-300';

export default function ToolMenuList({
    setActiveTool,
    setTaskMode,
    onActiveToolChange,
    activeTool = 'none',
}: ToolMenuListProps) {
  const { t } = useTranslation();
    const hiddenTools = useAppSettingsStore(state => state.hiddenTools);
    const favoriteTools = useAppSettingsStore(state => state.favoriteTools);
    const toggleFavoriteTool = useAppSettingsStore(state => state.toggleFavoriteTool);
    const collapsedSections = useAppSettingsStore(state => state.collapsedSections);
    const toggleSection = useAppSettingsStore(state => state.toggleSection);
    const query = useWorkspaceStore(state => state.toolMenuQuery);
    const setQuery = useWorkspaceStore(state => state.setToolMenuQuery);
    const toolMenuScrollTop = useWorkspaceStore(state => state.toolMenuScrollTop);
    const setToolMenuScrollTop = useWorkspaceStore(state => state.setToolMenuScrollTop);
    const menuScrollRef = useRef<HTMLDivElement>(null);
    const pendingScrollTopRef = useRef<number | null>(null);
    const scrollFrameRef = useRef<number | null>(null);
    useEffect(() => {
        const element = menuScrollRef.current;
        if (!element) return;
        if (Math.abs(element.scrollTop - toolMenuScrollTop) <= 1) return;
        if (typeof element.scrollTo === 'function') {
            element.scrollTo({ top: toolMenuScrollTop });
        } else {
            element.scrollTop = toolMenuScrollTop;
        }
    }, [toolMenuScrollTop]);
    useEffect(() => () => {
        if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    }, []);
    const flushScrollTop = () => {
        scrollFrameRef.current = null;
        const next = pendingScrollTopRef.current;
        pendingScrollTopRef.current = null;
        if (next === null) return;
        // PERF (audit 2026-08-22 §UX.S.04): chỉ công bố vị trí cuộn mới nhất
        // một lần mỗi frame; không ghi store theo từng event pixel.
        setToolMenuScrollTop(next);
    };
    const handleMenuScroll = (event: React.UIEvent<HTMLDivElement>) => {
        pendingScrollTopRef.current = event.currentTarget.scrollTop;
        if (scrollFrameRef.current !== null) return;
        if (typeof requestAnimationFrame === 'function') {
            scrollFrameRef.current = requestAnimationFrame(flushScrollTop);
        } else {
            flushScrollTop();
        }
    };
    const requestActivation = useToolActivationGuard();

    const q = query.trim().toLowerCase();
    const matches = (tool: ToolDefinition) => toolMatchesQuery(tool, query);
    const showFavoritesInOriginalCategory = Boolean(q);

    const keyOf = getToolUniqueKey;
    const isDashboardTool = (tool: ToolDefinition) => isWorkspaceTool(keyOf(tool)) && keyOf(tool) !== 'none';
    const open = (tool: ToolDefinition) => {
        const toolKey = keyOf(tool);
        // UIUX (feedback 2026-08-23 §MENU.TOGGLE): click lại đúng công cụ đang
        // mở phải đóng panel thiết lập. Parent có thể dọn thêm crop/object-edit;
        // các dashboard cũ không truyền callback thì fallback về setter trực tiếp.
        if (activeTool === toolKey) {
            if (onActiveToolChange) onActiveToolChange('none');
            else setActiveTool('none');
            return;
        }
        requestActivation(tool, () => {
            // Chỉ đổi tool — switchToolProfile (ImposerDashboard) lưu/nạp taskMode
            // theo từng công cụ. Không setTaskMode(lockedMode) ở đây (trước đây ép
            // sticker_imposer/cnc → mất Bình trang; và race với snapshot profile).
            setActiveTool(toolKey);
            // Booklet không qua LAYOUT_TASK profile restore khi prev='none' đã set
            // taskMode booklet trong switchToolProfile; các tool preprocess không cần.
            if (tool.defaultPayload?.lockedMode === 'booklet') {
                setTaskMode('booklet');
            }
        });
    };

    // Filter out standalone apps (category: 'qc')
    const dashboardCategories = TOOL_CATEGORIES.filter(cat => cat.id !== 'qc');

    return (
        <div
            ref={menuScrollRef}
            onScroll={handleMenuScroll}
            className="min-h-0 flex-1 select-none overflow-x-hidden overflow-y-auto px-3 py-4"
        >
            {/* ── Search ── */}
            <div className="relative mb-3">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" /></svg>
                <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder={t('imposition.toolMenuList:tim_cong_cu')}
                    aria-label={t('imposition.toolMenuList:tim_cong_cu')}
                    className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-8 pr-7 text-[13px] focus:border-indigo-400 focus:outline-none dark:border-white/10 dark:bg-zinc-900"
                />
                {query && (
                    <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" title={t('imposition.toolMenuList:xoa_tim_kiem')}>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                )}
            </div>

            {/* ── Favorite Section ── */}
            {(() => {
                const allTools = dashboardCategories.flatMap(cat => getToolsByCategory(cat.id));
                const favTools = allTools.filter(t => isDashboardTool(t) && favoriteTools.includes(keyOf(t)) && !hiddenTools.includes(keyOf(t)) && matches(t));
                if (q || favTools.length === 0) return null;
                const isCollapsed = !q && !!collapsedSections['favorites'];
                return (
                    <React.Fragment key="favorites">
                        <SectionToggle sectionKey="favorites" label={t('imposition.toolMenuList:cong_cu_yeu_thich')} collapsed={isCollapsed} onToggle={toggleSection} />
                        {!isCollapsed && (
                            <div className={TOOL_LIST_CLASS_NAME}>
                                {favTools.map(tool => (
                                    <ToolItem
                                        key={`fav-${keyOf(tool)}`}
                                        icon={tool.icon}
                                        label={tv(tool.title)}
                                        info={tv(tool.longDescription)}
                                        helpKey={keyOf(tool)}
                                        featureId={tool.featureId}
                                        active={keyOf(tool) === activeTool}
                                        isFavorite
                                        onToggleFavorite={() => toggleFavoriteTool(keyOf(tool))}
                                        onClick={() => open(tool)}
                                        hoverColor={tool.hoverColor.replace(' text-slate-800 dark:text-white', '')}
                                        variant="tool-catalog"
                                    />
                                ))}
                            </div>
                        )}
                    </React.Fragment>
                );
            })()}

            {dashboardCategories.map((category) => {
                // UIUX (feedback 2026-08-27 §MENU.EMPTY): quyết định render header
                // bằng đúng danh sách item cuối cùng; không để nhóm gốc rỗng sau
                // khi toàn bộ công cụ đã chuyển sang Yêu thích.
                const visibleToolsInCategory = getToolsByCategory(category.id).filter(t => {
                    if (!isDashboardTool(t)) return false;
                    const featureId = keyOf(t);
                    if (hiddenTools.includes(featureId)) return false;
                    return matches(t);
                });
                const toolsInCategory = visibleToolsInCategory.filter(
                    tool => showFavoritesInOriginalCategory || !favoriteTools.includes(keyOf(tool)),
                );
                if (toolsInCategory.length === 0) return null;

                const isCollapsed = !q && !!collapsedSections[category.id];

                return (
                    <React.Fragment key={category.id}>
                        <SectionToggle sectionKey={category.id} label={tv(category.title)} collapsed={isCollapsed} onToggle={toggleSection} />
                        {!isCollapsed && (
                            <div className={TOOL_LIST_CLASS_NAME}>
                                {toolsInCategory.map(tool => (
                                    <ToolItem
                                        key={keyOf(tool)}
                                        icon={tool.icon}
                                        label={tv(tool.title)}
                                        info={tv(tool.longDescription)}
                                        helpKey={keyOf(tool)}
                                        featureId={tool.featureId}
                                        active={keyOf(tool) === activeTool}
                                        isFavorite={favoriteTools.includes(keyOf(tool))}
                                        onToggleFavorite={() => toggleFavoriteTool(keyOf(tool))}
                                        onClick={() => open(tool)}
                                        hoverColor={tool.hoverColor.replace(' text-slate-800 dark:text-white', '')}
                                        variant="tool-catalog"
                                    />
                                ))}
                            </div>
                        )}
                    </React.Fragment>
                );
            })}
        </div>
    );
}
