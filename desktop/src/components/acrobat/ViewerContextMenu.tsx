import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type CrossFileTarget = { pdfUrl: string; name: string; tabId?: string; numPages?: number };

/**
 * Các PDF đang mở khác (mọi tab Imposition vẫn mount trong DOM).
 * Ưu tiên marker root viewer (`data-prynx-open-pdf`) — luôn có kể cả khi đóng panel thumbnail.
 * Fallback: `.acro-thumb-scroll[data-pdf-url]` (kéo-thả cross-file).
 */
export function listOtherOpenPdfTargets(currentPdfUrl: string | null | undefined): CrossFileTarget[] {
    if (!currentPdfUrl) return [];
    const seen = new Set<string>();
    const out: CrossFileTarget[] = [];

    const add = (url: string | null, name: string | null, tabId: string | null, numPagesRaw: string | null) => {
        if (!url || url === currentPdfUrl || seen.has(url)) return;
        seen.add(url);
        const np = numPagesRaw ? parseInt(numPagesRaw, 10) : NaN;
        out.push({
            pdfUrl: url,
            name: name || 'PDF',
            tabId: tabId || undefined,
            numPages: Number.isFinite(np) && np >= 0 ? np : undefined,
        });
    };

    document.querySelectorAll('[data-prynx-open-pdf]').forEach((node) => {
        const el = node as HTMLElement;
        add(
            el.getAttribute('data-prynx-open-pdf'),
            el.getAttribute('data-file-name'),
            el.getAttribute('data-prynx-tab-id'),
            el.getAttribute('data-prynx-num-pages'),
        );
    });
    document.querySelectorAll('.acro-thumb-scroll[data-pdf-url]').forEach((node) => {
        const el = node as HTMLElement;
        const root = el.closest('[data-prynx-open-pdf]') as HTMLElement | null;
        add(
            el.getAttribute('data-pdf-url'),
            el.getAttribute('data-file-name') || root?.getAttribute('data-file-name') || null,
            root?.getAttribute('data-prynx-tab-id') || null,
            root?.getAttribute('data-prynx-num-pages') || null,
        );
    });
    return out;
}

interface ViewerContextMenuProps {
    contextMenu: { x: number; y: number; visible: boolean } | null;
    selectedIndices: Set<number>;
    currentPdfUrl?: string | null;
    setContextMenu: React.Dispatch<React.SetStateAction<any>>;
    setIsInsertModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setIsExtractModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setExtractPagesStrForModal: React.Dispatch<React.SetStateAction<string>>;
    setIsDeleteModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setActiveDashboardTool: (tool: string) => void;
    setIsSidebarOpen: (open: boolean) => void;
    onQuickDuplicate: () => void;
    /** Copy/Move trang đang chọn sang file khác (kéo-thả giữ nguyên — chỉ qua menu). */
    onTransferToOtherFile?: (
        targetPdfUrl: string,
        mode: 'copy' | 'move',
        targetTabId?: string,
        targetNumPages?: number,
        targetName?: string,
    ) => void;
}

export function ViewerContextMenu(props: ViewerContextMenuProps) {
    const { t } = useTranslation();
    const {
        contextMenu, selectedIndices, currentPdfUrl, setContextMenu,
        setIsInsertModalOpen, setIsExtractModalOpen, setExtractPagesStrForModal,
        setIsDeleteModalOpen, setActiveDashboardTool, setIsSidebarOpen,
        onQuickDuplicate, onTransferToOtherFile,
    } = props;

    const [openSub, setOpenSub] = useState<'copy' | 'move' | null>(null);

    // Làm mới danh sách khi menu mở (contextMenu đổi) — tab khác vẫn mount trong DOM.
    const otherTargets = useMemo(
        () => listOtherOpenPdfTargets(currentPdfUrl),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [currentPdfUrl, contextMenu?.x, contextMenu?.y, contextMenu?.visible],
    );

    if (!contextMenu || !contextMenu.visible) return null;

    const hasSelection = selectedIndices.size > 0;
    const canTransfer = hasSelection && !!onTransferToOtherFile;
    const openLeft = contextMenu.x > window.innerWidth - 420;

    const transferRow = (mode: 'copy' | 'move', label: string) => {
        const isOpen = openSub === mode;
        return (
            <div
                className="relative"
                onMouseEnter={() => setOpenSub(mode)}
                onMouseLeave={() => setOpenSub((cur) => (cur === mode ? null : cur))}
            >
                <button
                    type="button"
                    disabled={!canTransfer}
                    className={`w-full flex items-center justify-between px-4 py-2 text-[13px] font-medium rounded-lg outline-none transition-colors ${
                        canTransfer
                            ? 'text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400'
                            : 'text-slate-400 dark:text-zinc-600 cursor-not-allowed'
                    }`}
                >
                    <span>{label}</span>
                    <span className="text-[11px] text-slate-400 ml-2">{openLeft ? '‹' : '›'}</span>
                </button>

                {isOpen && canTransfer && (
                    // UIUX (audit 2026-07-27 §A-03): hex nền/viền → bg-app-2/border-app-line; rounded-xl → rounded-app-lg (thang 12px)
                    <div
                        className={`absolute top-0 z-[1] min-w-[200px] max-w-[280px] bg-app-2 border border-app-line shadow-[0_10px_30px_rgb(0,0,0,0.12)] dark:shadow-xl p-1.5 rounded-app-lg flex flex-col gap-0.5 ${
                            openLeft ? 'right-full mr-1' : 'left-full ml-1'
                        }`}
                    >
                        {otherTargets.length === 0 ? (
                            <div className="px-3 py-2 text-[12px] text-slate-400 dark:text-zinc-500">
                                {t('misc.viewerContextMenu:khong_co_file_khac')}
                            </div>
                        ) : (
                            otherTargets.map((target) => (
                                <button
                                    key={target.pdfUrl}
                                    type="button"
                                    title={target.name}
                                    onClick={() => {
                                        onTransferToOtherFile?.(target.pdfUrl, mode, target.tabId, target.numPages, target.name);
                                        setOpenSub(null);
                                    }}
                                    className="w-full text-left px-3 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors truncate"
                                >
                                    {target.name}
                                </button>
                            ))
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        // UIUX (audit 2026-07-27 §A-03): hex nền/viền → bg-app-2/border-app-line; rounded-xl → rounded-app-lg (thang 12px)
        <div
            className="fixed z-context-menu min-w-[240px] bg-app-2 border border-app-line shadow-[0_10px_30px_rgb(0,0,0,0.1)] dark:shadow-xl p-2 rounded-app-lg animate-in fade-in zoom-in-95 duration-100 flex flex-col gap-0.5"
            style={{ left: Math.min(contextMenu.x, window.innerWidth - 260), top: Math.min(contextMenu.y, window.innerHeight - 320) }}
            onClick={e => e.stopPropagation()}
            onContextMenu={e => e.preventDefault()}
            onMouseLeave={() => setOpenSub(null)}
        >
            <button
                onClick={() => setIsInsertModalOpen(true)}
                className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
            >
                {t('misc.viewerContextMenu:chen_trang_trang_insert')}
            </button>

            <button
                onClick={() => {
                    const sortedSel = Array.from(selectedIndices).sort((a, b) => a - b).map(i => i + 1);
                    setExtractPagesStrForModal(sortedSel.join(', '));
                    setIsExtractModalOpen(true);
                }}
                className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
            >
                {t('misc.viewerContextMenu:trich_xuat_trang')}
            </button>

            <button
                onClick={() => onQuickDuplicate()}
                className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
            >
                {t('misc.viewerContextMenu:nhan_ban_duplicate')}
            </button>

            <div className="h-px bg-slate-100 dark:bg-white/5 my-1 mx-2" />

            {transferRow('copy', t('misc.viewerContextMenu:copy_sang_file'))}
            {transferRow('move', t('misc.viewerContextMenu:di_chuyen_sang_file'))}

            <div className="h-px bg-slate-100 dark:bg-white/5 my-1 mx-2" />

            <button
                onClick={() => { setIsDeleteModalOpen(true); setContextMenu(null); }}
                className="w-full flex items-center justify-between px-4 py-2 text-[13px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg outline-none transition-colors group"
            >
                <span>{t('misc.viewerContextMenu:xoa_trang_nhanh')}</span>
                <span className="text-[11px] text-slate-400 group-hover:text-red-400 tracking-wider">Del</span>
            </button>

            <button
                onClick={() => { setActiveDashboardTool('pages'); setIsSidebarOpen(true); setContextMenu(null); }}
                className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
            >
                {t('misc.viewerContextMenu:quan_ly_trang_xoay_nhan_ban')}
            </button>
        </div>
    );
}
