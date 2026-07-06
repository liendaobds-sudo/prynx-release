import React from 'react';

interface ViewerContextMenuProps {
    contextMenu: { x: number; y: number; visible: boolean } | null;
    selectedIndices: Set<number>;
    setContextMenu: React.Dispatch<React.SetStateAction<any>>;
    setIsInsertModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setIsExtractModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setExtractPagesStrForModal: React.Dispatch<React.SetStateAction<string>>;
    setIsDeleteModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setActiveDashboardTool: (tool: string) => void;
    setIsSidebarOpen: (open: boolean) => void;
    onQuickDuplicate: () => void;
}

export function ViewerContextMenu(props: ViewerContextMenuProps) {
    const {
        contextMenu, selectedIndices, setContextMenu,
        setIsInsertModalOpen, setIsExtractModalOpen, setExtractPagesStrForModal,
        setIsDeleteModalOpen, setActiveDashboardTool, setIsSidebarOpen,
        onQuickDuplicate,
    } = props;

    if (!contextMenu || !contextMenu.visible) return null;

    return (
        <div
            className="fixed z-context-menu min-w-[220px] bg-white dark:bg-[#1e1e1e] border border-slate-200 dark:border-white/10 shadow-[0_10px_30px_rgb(0,0,0,0.1)] dark:shadow-xl p-2 rounded-xl animate-in fade-in zoom-in-95 duration-100 flex flex-col gap-0.5"
            style={{ left: Math.min(contextMenu.x, window.innerWidth - 220), top: Math.min(contextMenu.y, window.innerHeight - 200) }}
            onClick={e => e.stopPropagation()}
            onContextMenu={e => e.preventDefault()}
        >
            <button
                onClick={() => setIsInsertModalOpen(true)}
                className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
            >
                Chèn trang trắng (Insert)
            </button>

            <button
                onClick={() => {
                    const sortedSel = Array.from(selectedIndices).sort((a, b) => a - b).map(i => i + 1);
                    setExtractPagesStrForModal(sortedSel.join(', '));
                    setIsExtractModalOpen(true);
                }}
                className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
            >
                Trích xuất trang
            </button>

            <button
                onClick={() => onQuickDuplicate()}
                className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
            >
                Nhân bản (Duplicate)
            </button>



            <div className="h-px bg-slate-100 dark:bg-white/5 my-1 mx-2"></div>

            <button
                onClick={() => { setIsDeleteModalOpen(true); setContextMenu(null); }}
                className="w-full flex items-center justify-between px-4 py-2 text-[13px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg outline-none transition-colors group"
            >
                <span>Xóa trang nhanh</span>
                <span className="text-[11px] text-slate-400 group-hover:text-red-400 tracking-wider">Del</span>
            </button>

            <button
                onClick={() => { setActiveDashboardTool('pages'); setIsSidebarOpen(true); setContextMenu(null); }}
                className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
            >
                Quản lý Trang (Xoay, Nhân bản...)
            </button>
        </div>
    );
}
