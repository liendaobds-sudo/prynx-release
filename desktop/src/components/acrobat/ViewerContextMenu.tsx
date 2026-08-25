import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listOtherOpenPdfTargets } from './viewerContextMenuUtils';

export type CrossFileTarget = { pdfUrl: string; name: string; tabId?: string; numPages?: number };
export type ViewerContextMenuState = { x: number; y: number; visible: boolean } | null;

interface ViewerContextMenuProps {
    contextMenu: ViewerContextMenuState;
    selectedIndices: Set<number>;
    currentPdfUrl?: string | null;
    setContextMenu: React.Dispatch<React.SetStateAction<ViewerContextMenuState>>;
    setIsInsertModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setIsExtractModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setExtractPagesStrForModal: React.Dispatch<React.SetStateAction<string>>;
    setIsDeleteModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    onOpenPageTools: () => void;
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
        setIsDeleteModalOpen, onOpenPageTools,
        onQuickDuplicate, onTransferToOtherFile,
    } = props;

    const [openSub, setOpenSub] = useState<'copy' | 'move' | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const transferButtonRefs = useRef<Partial<Record<'copy' | 'move', HTMLButtonElement | null>>>({});

    useEffect(() => {
        if (!contextMenu?.visible) return;
        const first = menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not([disabled])');
        first?.focus();
    }, [contextMenu?.visible]);

    const closeContextMenu = () => {
        setOpenSub(null);
        setContextMenu(null);
    };

    const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeContextMenu();
            return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>(
            'button[role="menuitem"]:not([disabled])',
        ) || []);
        if (items.length === 0) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const next = items[(current + delta + items.length) % items.length];
        event.preventDefault();
        next?.focus();
    };

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
                    ref={(element) => { transferButtonRefs.current[mode] = element; }}
                    disabled={!canTransfer}
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    onFocus={() => canTransfer && setOpenSub(mode)}
                    onClick={() => canTransfer && setOpenSub(isOpen ? null : mode)}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowRight' && canTransfer) {
                            event.preventDefault();
                            setOpenSub(mode);
                        } else if (event.key === 'ArrowLeft' && isOpen) {
                            event.preventDefault();
                            setOpenSub(null);
                        }
                    }}
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
                        role="menu"
                        onKeyDown={(event) => {
                            if (event.key === 'ArrowLeft') {
                                event.preventDefault();
                                setOpenSub(null);
                                transferButtonRefs.current[mode]?.focus();
                            }
                        }}
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
                                    role="menuitem"
                                    title={target.name}
                                    onClick={() => {
                                        onTransferToOtherFile?.(target.pdfUrl, mode, target.tabId, target.numPages, target.name);
                                        closeContextMenu();
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
            ref={menuRef}
            role="menu"
            aria-label="Thao tác trang"
            className="fixed z-context-menu min-w-[240px] bg-app-2 border border-app-line shadow-[0_10px_30px_rgb(0,0,0,0.1)] dark:shadow-xl p-2 rounded-app-lg animate-in fade-in zoom-in-95 duration-100 flex flex-col gap-0.5"
            style={{ left: Math.min(contextMenu.x, window.innerWidth - 260), top: Math.min(contextMenu.y, window.innerHeight - 320) }}
            onClick={e => e.stopPropagation()}
            onContextMenu={e => e.preventDefault()}
            onMouseLeave={() => setOpenSub(null)}
            onKeyDown={handleMenuKeyDown}
        >
            <button
                type="button"
                role="menuitem"
                onClick={() => { closeContextMenu(); setIsInsertModalOpen(true); }}
                className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
            >
                {t('misc.viewerContextMenu:chen_trang_trang_insert')}
            </button>

            <button
                type="button"
                role="menuitem"
                onClick={() => {
                    const sortedSel = Array.from(selectedIndices).sort((a, b) => a - b).map(i => i + 1);
                    setExtractPagesStrForModal(sortedSel.join(', '));
                    closeContextMenu();
                    setIsExtractModalOpen(true);
                }}
                className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
            >
                {t('misc.viewerContextMenu:trich_xuat_trang')}
            </button>

            <button
                type="button"
                role="menuitem"
                onClick={() => { onQuickDuplicate(); closeContextMenu(); }}
                className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
            >
                {t('misc.viewerContextMenu:nhan_ban_duplicate')}
            </button>

            <div className="h-px bg-slate-100 dark:bg-white/5 my-1 mx-2" />

            {transferRow('copy', t('misc.viewerContextMenu:copy_sang_file'))}
            {transferRow('move', t('misc.viewerContextMenu:di_chuyen_sang_file'))}

            <div className="h-px bg-slate-100 dark:bg-white/5 my-1 mx-2" />

            <button
                type="button"
                role="menuitem"
                onClick={() => { setIsDeleteModalOpen(true); setContextMenu(null); }}
                className="w-full flex items-center justify-between px-4 py-2 text-[13px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg outline-none transition-colors group"
            >
                <span>{t('misc.viewerContextMenu:xoa_trang_nhanh')}</span>
                <span className="text-[11px] text-slate-400 group-hover:text-red-400 tracking-wider">Del</span>
            </button>

            <button
                type="button"
                role="menuitem"
                onClick={() => { onOpenPageTools(); setContextMenu(null); }}
                className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
            >
                {t('misc.viewerContextMenu:quan_ly_trang_xoay_nhan_ban')}
            </button>
        </div>
    );
}
