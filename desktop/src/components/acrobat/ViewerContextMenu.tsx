import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Scissors } from 'lucide-react';
import { listOtherOpenPdfTargets } from './viewerContextMenuUtils';
import { canUse } from '../../lib/license/features';
import { useAuthStore } from '../../stores/useAuthStore';
import ProFeatureBadge from '../license/ProFeatureBadge';
import { toast } from '../ui/Toast';

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
    /** Tổng số trang trong tài liệu */
    numPages?: number;
    /** Mở sửa tài liệu trực tiếp bằng Illustrator hoặc CorelDRAW (mode: 'selection' | 'all') */
    onEditInApp?: (which: 'illustrator' | 'corel', mode?: 'selection' | 'all') => void;
    /** Mở hộp thoại xuất khuôn bế */
    onOpenDieCutModal?: () => void;
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
        onEditInApp, onOpenDieCutModal, numPages,
    } = props;

    const [openSub, setOpenSub] = useState<'copy' | 'move' | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const transferButtonRefs = useRef<Partial<Record<'copy' | 'move', HTMLButtonElement | null>>>({});

    useEffect(() => {
        if (!contextMenu?.visible) return;
        const first = menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not([disabled])');
        first?.focus();

        const handleGlobalKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeContextMenu();
            }
        };
        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, [contextMenu?.visible]);

    const closeContextMenu = () => {
        setOpenSub(null);
        setContextMenu(null);
    };

    const plan = useAuthStore((state) => state.licensePlan);
    const features = useAuthStore((state) => state.licenseFeatures);
    const isBridgeAllowed = canUse('prepress.app_bridge', plan, features);

    const triggerEditInApp = (which: 'illustrator' | 'corel', mode?: 'selection' | 'all') => {
        closeContextMenu();
        if (!isBridgeAllowed) {
            toast.info(t('misc.viewerContextMenu:tinh_nang_pro_notice', 'Tính năng Liên kết Illustrator & CorelDRAW dành cho gói PrynX Pro.'));
            return;
        }
        onEditInApp?.(which, mode);
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
        <>
            {/* Backdrop bắt click/touch NGOÀI menu để đóng */}
            <div
                data-testid="viewer-context-menu-backdrop"
                aria-hidden="true"
                className="fixed inset-0 z-context-menu"
                onPointerDown={closeContextMenu}
                onClick={closeContextMenu}
                onContextMenu={(e) => {
                    e.preventDefault();
                    closeContextMenu();
                }}
            />
            {/* UIUX (audit 2026-07-27 §A-03): hex nền/viền → bg-app-2/border-app-line; rounded-xl → rounded-app-lg (thang 12px) */}
            <div
                ref={menuRef}
                role="menu"
                aria-label={t('misc.viewerContextMenu:thao_tac_trang', 'Thao tác trang')}
                className="fixed z-context-menu min-w-[250px] bg-app-2 border border-app-line shadow-[0_10px_30px_rgb(0,0,0,0.1)] dark:shadow-xl p-2 rounded-app-lg animate-in fade-in zoom-in-95 duration-100 flex flex-col gap-0.5"
                style={{ left: Math.min(contextMenu.x, window.innerWidth - 270), top: Math.min(contextMenu.y, window.innerHeight - 440) }}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
                onContextMenu={e => e.preventDefault()}
                onMouseLeave={() => setOpenSub(null)}
                onKeyDown={handleMenuKeyDown}
            >
            {onEditInApp && (() => {
                const sortedSel = Array.from(selectedIndices).sort((a, b) => a - b);
                const totalPages = numPages ?? 1;
                const isPartialSelection = totalPages > 1 && sortedSel.length > 0 && sortedSel.length < totalPages;
                const selectionLabel = sortedSel.length === 1
                    ? t('misc.viewerContextMenu:rieng_trang', { page: sortedSel[0] + 1, defaultValue: `riêng trang ${sortedSel[0] + 1}` })
                    : t('misc.viewerContextMenu:cac_trang_da_chon', { pages: sortedSel.map(i => i + 1).join(', '), defaultValue: `các trang đã chọn (${sortedSel.map(i => i + 1).join(', ')})` });

                const aiTitle = isPartialSelection
                    ? t('misc.viewerContextMenu:tooltip_sua_trang_chon_ai', { selection: selectionLabel, defaultValue: `Chỉ trích xuất ${selectionLabel} để mở sửa trong Adobe Illustrator. Khi lưu (Ctrl+S), PrynX sẽ tự động gộp lại vào file gốc.` })
                    : t('misc.viewerContextMenu:tooltip_sua_toan_bo_ai', { total: totalPages, defaultValue: `Mở toàn bộ tài liệu (${totalPages} trang) trong Adobe Illustrator.` });

                const cdrTitle = isPartialSelection
                    ? t('misc.viewerContextMenu:tooltip_sua_trang_chon_corel', { selection: selectionLabel, defaultValue: `Chỉ trích xuất ${selectionLabel} để mở sửa trong CorelDRAW. Khi lưu (Ctrl+S), PrynX sẽ tự động gộp lại vào file gốc.` })
                    : t('misc.viewerContextMenu:tooltip_sua_toan_bo_corel', { total: totalPages, defaultValue: `Mở toàn bộ tài liệu (${totalPages} trang) trong CorelDRAW.` });

                return (
                    <>
                        <button
                            type="button"
                            role="menuitem"
                            title={aiTitle}
                            onClick={() => triggerEditInApp('illustrator', isPartialSelection ? 'selection' : 'all')}
                            className="w-full flex items-center justify-between px-3 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-400 rounded-lg outline-none transition-colors group"
                        >
                            <span className="flex items-center gap-2.5">
                                <span className="w-5 h-5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[11px] font-extrabold flex items-center justify-center border border-amber-500/30">Ai</span>
                                <span>
                                    {isPartialSelection
                                        ? t('misc.viewerContextMenu:sua_trang_chon_illustrator', { selection: selectionLabel, defaultValue: `Sửa ${selectionLabel} trong Illustrator` })
                                        : t('misc.viewerContextMenu:sua_bang_illustrator', 'Sửa bằng Adobe Illustrator')}
                                </span>
                            </span>
                            <span className="flex items-center gap-1.5">
                                <ProFeatureBadge featureId="prepress.app_bridge" />
                                <span className="text-[10px] text-slate-400 group-hover:text-amber-500 font-mono">Live</span>
                            </span>
                        </button>

                        <button
                            type="button"
                            role="menuitem"
                            title={cdrTitle}
                            onClick={() => triggerEditInApp('corel', isPartialSelection ? 'selection' : 'all')}
                            className="w-full flex items-center justify-between px-3 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-400 rounded-lg outline-none transition-colors group"
                        >
                            <span className="flex items-center gap-2.5">
                                <span className="w-5 h-5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px] font-extrabold flex items-center justify-center border border-emerald-500/30">Cdr</span>
                                <span>
                                    {isPartialSelection
                                        ? t('misc.viewerContextMenu:sua_trang_chon_corel', { selection: selectionLabel, defaultValue: `Sửa ${selectionLabel} trong CorelDRAW` })
                                        : t('misc.viewerContextMenu:sua_bang_corel', 'Sửa bằng CorelDRAW')}
                                </span>
                            </span>
                            <span className="flex items-center gap-1.5">
                                <ProFeatureBadge featureId="prepress.app_bridge" />
                                <span className="text-[10px] text-slate-400 group-hover:text-emerald-500 font-mono">Live</span>
                            </span>
                        </button>

                        {isPartialSelection && (
                            <div className="flex flex-col gap-0.5 pt-0.5 pb-1 border-t border-dashed border-slate-200 dark:border-zinc-800">
                                <button
                                    type="button"
                                    role="menuitem"
                                    title={t('misc.viewerContextMenu:tooltip_mo_toan_bo_ai', { total: totalPages, defaultValue: `Mở toàn bộ ${totalPages} trang của tài liệu gốc trong Adobe Illustrator để chỉnh sửa tổng thể` })}
                                    onClick={() => triggerEditInApp('illustrator', 'all')}
                                    className="w-full text-left px-3 py-1.5 text-[11px] text-slate-500 dark:text-zinc-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-50/50 dark:hover:bg-amber-500/5 rounded transition-colors flex items-center justify-between"
                                >
                                    <span>{t('misc.viewerContextMenu:mo_toan_bo_file_ai', { total: totalPages, defaultValue: `↳ Mở toàn bộ file trong Illustrator (${totalPages} trang)...` })}</span>
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    title={t('misc.viewerContextMenu:tooltip_mo_toan_bo_corel', { total: totalPages, defaultValue: `Mở toàn bộ ${totalPages} trang của tài liệu gốc trong CorelDRAW để chỉnh sửa tổng thể` })}
                                    onClick={() => triggerEditInApp('corel', 'all')}
                                    className="w-full text-left px-3 py-1.5 text-[11px] text-slate-500 dark:text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-500/5 rounded transition-colors flex items-center justify-between"
                                >
                                    <span>{t('misc.viewerContextMenu:mo_toan_bo_file_corel', { total: totalPages, defaultValue: `↳ Mở toàn bộ file trong CorelDRAW (${totalPages} trang)...` })}</span>
                                </button>
                            </div>
                        )}

                        {onOpenDieCutModal && (
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => { closeContextMenu(); onOpenDieCutModal(); }}
                                className="w-full flex items-center justify-between px-3 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-indigo-600 dark:hover:text-indigo-400 rounded-lg outline-none transition-colors"
                            >
                                <span className="flex items-center gap-2.5">
                                    <Scissors className="w-4 h-4 text-slate-400 ml-0.5" />
                                    <span>{t('misc.viewerContextMenu:xuat_trang_khuon_be', 'Xuất trang khuôn bế...')}</span>
                                </span>
                            </button>
                        )}

                        <div className="h-px bg-slate-100 dark:bg-white/5 my-1 mx-2" />
                    </>
                );
            })()}

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
        </>
    );
}
