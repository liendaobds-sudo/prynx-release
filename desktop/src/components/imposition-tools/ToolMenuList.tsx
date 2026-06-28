import React, { useState } from 'react';
import { ToolItem } from './SharedUI';
import { TOOL_CATEGORIES, getToolsByCategory, toolMatchesQuery } from '../../lib/toolRegistry';
import { useAppSettingsStore } from '../../stores/appSettingsStore';

interface ToolMenuListProps {
    setActiveTool: (tool: string) => void;
    setTaskMode: (mode: string) => void;
    onActiveToolChange?: (tool: string) => void;
}

const SectionToggle = ({ sectionKey, label, collapsed, onToggle }: { sectionKey: string; label: string; collapsed: boolean; onToggle: (key: string) => void }) => (
    <button onClick={() => onToggle(sectionKey)} className="flex items-center justify-between w-full mt-2 pl-1 pr-1 group cursor-pointer overflow-hidden gap-2">
        <span className="text-[11.5px] font-black text-slate-500 dark:text-zinc-400 uppercase tracking-widest truncate">{label}</span>
        <svg className={`shrink-0 w-3.5 h-3.5 text-slate-400 transition-transform ${collapsed ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
    </button>
);

export default function ToolMenuList({ setActiveTool, setTaskMode }: ToolMenuListProps) {
    const hiddenTools = useAppSettingsStore(state => state.hiddenTools);
    const favoriteTools = useAppSettingsStore(state => state.favoriteTools);
    const toggleFavoriteTool = useAppSettingsStore(state => state.toggleFavoriteTool);
    const collapsedSections = useAppSettingsStore(state => state.collapsedSections);
    const toggleSection = useAppSettingsStore(state => state.toggleSection);
    const [query, setQuery] = useState('');

    const q = query.trim().toLowerCase();
    const matches = (t: any) => toolMatchesQuery(t, query);

    const keyOf = (t: any) => t.defaultPayload?.focusFeature || t.defaultPayload?.lockedMode || t.id;
    const open = (tool: any) => {
        const featureId = keyOf(tool);
        setActiveTool(featureId);
        if (tool.defaultPayload?.lockedMode) setTaskMode(tool.defaultPayload.lockedMode);
    };

    // Filter out standalone apps (category: 'qc')
    const dashboardCategories = TOOL_CATEGORIES.filter(cat => cat.id !== 'qc');

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }} className="pb-4 px-1 select-none">
            {/* ── Search ── */}
            <div className="relative mb-1">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" /></svg>
                <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Tìm công cụ..."
                    className="w-full h-8 pl-8 pr-7 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-zinc-900 text-[13px] focus:outline-none focus:border-indigo-400"
                />
                {query && (
                    <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" title="Xoá tìm kiếm">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                )}
            </div>

            {/* ── Favorite Section ── */}
            {(() => {
                const allTools = dashboardCategories.flatMap(cat => getToolsByCategory(cat.id));
                const favTools = allTools.filter(t => t.id !== 'combine_pdf' && favoriteTools.includes(keyOf(t)) && !hiddenTools.includes(keyOf(t)) && matches(t));
                if (favTools.length === 0) return null;
                const isCollapsed = !q && !!collapsedSections['favorites'];
                return (
                    <React.Fragment key="favorites">
                        <SectionToggle sectionKey="favorites" label="⭐ CÔNG CỤ YÊU THÍCH" collapsed={isCollapsed} onToggle={toggleSection} />
                        {!isCollapsed && favTools.map(tool => (
                            <ToolItem
                                key={`fav-${keyOf(tool)}`}
                                icon={tool.icon}
                                label={tool.title}
                                info={tool.longDescription}
                                helpKey={keyOf(tool)}
                                isFavorite
                                onToggleFavorite={() => toggleFavoriteTool(keyOf(tool))}
                                onClick={() => open(tool)}
                                hoverColor={tool.hoverColor.replace(' text-slate-800 dark:text-white', '')}
                            />
                        ))}
                    </React.Fragment>
                );
            })()}

            {dashboardCategories.map((category) => {
                const toolsInCategory = getToolsByCategory(category.id).filter(t => {
                    if (t.id === 'combine_pdf') return false;
                    const featureId = keyOf(t);
                    if (hiddenTools.includes(featureId)) return false;
                    if (favoriteTools.includes(featureId)) return false;
                    return matches(t);
                });
                if (toolsInCategory.length === 0) return null;

                const isCollapsed = !q && !!collapsedSections[category.id];

                return (
                    <React.Fragment key={category.id}>
                        <SectionToggle sectionKey={category.id} label={category.title} collapsed={isCollapsed} onToggle={toggleSection} />
                        {!isCollapsed && toolsInCategory.map(tool => (
                            <ToolItem
                                key={keyOf(tool)}
                                icon={tool.icon}
                                label={tool.title}
                                info={tool.longDescription}
                                helpKey={keyOf(tool)}
                                isFavorite={favoriteTools.includes(keyOf(tool))}
                                onToggleFavorite={() => toggleFavoriteTool(keyOf(tool))}
                                onClick={() => open(tool)}
                                hoverColor={tool.hoverColor.replace(' text-slate-800 dark:text-white', '')}
                            />
                        ))}
                    </React.Fragment>
                );
            })}
        </div>
    );
}
