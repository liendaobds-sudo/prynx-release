import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GripVertical, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { VdpLivePreviewState } from '../../stores/useWorkspaceStore';

export interface VdpRecordNavigatorBarProps {
    vdpLivePreview?: VdpLivePreviewState | null;
    setVdpLivePreview: (updater: Partial<VdpLivePreviewState> | ((prev: VdpLivePreviewState) => VdpLivePreviewState)) => void;
}

/**
 * Thanh điều hướng record xem trước dữ liệu biến đổi (VDP) trên View chính.
 * Hỗ trợ kéo thả (draggable) thay đổi vị trí tự do và thích ứng giao diện Sáng / Tối (Light / Dark mode).
 */
export const VdpRecordNavigatorBar: React.FC<VdpRecordNavigatorBarProps> = ({
    vdpLivePreview,
    setVdpLivePreview,
}) => {
    const { t } = useTranslation();

    const [isDragging, setIsDragging] = useState(false);
    const [currentOffset, setCurrentOffset] = useState<{ x: number; y: number }>(
        vdpLivePreview?.toolbarOffset ?? { x: 0, y: 0 }
    );
    const dragStartRef = useRef<{ clientX: number; clientY: number; startX: number; startY: number } | null>(null);

    // Đồng bộ vị trí từ store/props khi không trong trạng thái kéo
    useEffect(() => {
        if (!isDragging) {
            setCurrentOffset(vdpLivePreview?.toolbarOffset ?? { x: 0, y: 0 });
        }
    }, [vdpLivePreview?.toolbarOffset?.x, vdpLivePreview?.toolbarOffset?.y, isDragging]);

    const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        // Bỏ qua nếu bấm vào nút tương tác hoặc input
        if (target.closest('button') || target.closest('input')) {
            return;
        }
        e.stopPropagation();
        if (e.currentTarget.setPointerCapture) {
            try {
                e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
                // ignore
            }
        }
        setIsDragging(true);
        dragStartRef.current = {
            clientX: e.clientX,
            clientY: e.clientY,
            startX: currentOffset.x,
            startY: currentOffset.y,
        };
    }, [currentOffset.x, currentOffset.y]);

    const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragStartRef.current) return;
        e.stopPropagation();
        const dx = e.clientX - dragStartRef.current.clientX;
        const dy = e.clientY - dragStartRef.current.clientY;
        const nextX = Math.round(dragStartRef.current.startX + dx);
        const nextY = Math.round(dragStartRef.current.startY + dy);
        setCurrentOffset({ x: nextX, y: nextY });
    }, []);

    const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragStartRef.current) return;
        e.stopPropagation();
        if (e.currentTarget.releasePointerCapture) {
            try {
                e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
                // bỏ qua nếu đã nhả
            }
        }
        const dx = e.clientX - dragStartRef.current.clientX;
        const dy = e.clientY - dragStartRef.current.clientY;
        const finalX = Math.round(dragStartRef.current.startX + dx);
        const finalY = Math.round(dragStartRef.current.startY + dy);
        dragStartRef.current = null;
        setIsDragging(false);
        setVdpLivePreview((prev: VdpLivePreviewState) => ({
            ...prev,
            toolbarOffset: { x: finalX, y: finalY },
        }));
    }, [setVdpLivePreview]);

    const handleResetPosition = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setCurrentOffset({ x: 0, y: 0 });
        setVdpLivePreview((prev: VdpLivePreviewState) => ({
            ...prev,
            toolbarOffset: { x: 0, y: 0 },
        }));
    }, [setVdpLivePreview]);

    if (!vdpLivePreview || vdpLivePreview.totalRecords <= 0) {
        return null;
    }

    const hasCustomPosition = currentOffset.x !== 0 || currentOffset.y !== 0;

    return (
        <div
            data-testid="vdp-record-navigator-bar"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{
                transform: `translate(calc(-50% + ${currentOffset.x}px), ${currentOffset.y}px)`,
                touchAction: 'none',
            }}
            className={`absolute top-3 left-1/2 z-[80] pointer-events-auto flex items-center gap-2.5 px-3 py-1.5 rounded-lg shadow-xl border backdrop-blur-md whitespace-nowrap select-none transition-shadow ${
                isDragging
                    ? 'cursor-grabbing shadow-2xl ring-2 ring-teal-500/50'
                    : 'cursor-grab hover:shadow-2xl'
            } bg-white/95 text-slate-800 border-slate-200/90 dark:bg-zinc-900/95 dark:text-zinc-100 dark:border-zinc-700/80`}
        >
            {/* Tay nắm kéo (Grip Handle) */}
            <div
                data-testid="vdp-toolbar-grip"
                className="flex items-center justify-center p-0.5 -ml-1 text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors"
                title={t('Kéo để di chuyển thanh điều hướng (Nhấp đúp để đặt lại vị trí)')}
                onDoubleClick={handleResetPosition}
            >
                <GripVertical className="w-3.5 h-3.5" />
            </div>

            {/* Toggle Bật/Tắt xem trước */}
            <button
                type="button"
                data-testid="vdp-toggle-preview-btn"
                onClick={(e) => {
                    e.stopPropagation();
                    setVdpLivePreview((prev: VdpLivePreviewState) => ({ ...prev, enabled: !prev.enabled }));
                }}
                className={`px-2.5 py-1 rounded font-semibold text-[11px] flex items-center gap-1.5 transition-all cursor-pointer shadow-sm active:scale-95 ${
                    vdpLivePreview.enabled
                        ? 'bg-teal-600 hover:bg-teal-500 text-white ring-1 ring-teal-400'
                        : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300/80 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-300 dark:border-zinc-700'
                }`}
                title={vdpLivePreview.enabled ? t('Đang xem dữ liệu thật (Bấm để tắt)') : t('Bật xem trước dữ liệu biến đổi thời gian thực')}
            >
                <span className={`w-2 h-2 rounded-full ${vdpLivePreview.enabled ? 'bg-white animate-pulse' : 'bg-slate-400 dark:bg-zinc-500'}`} />
                <span>{vdpLivePreview.enabled ? t('workspace.vdpRecordNavigator:live_data_on') : t('workspace.vdpRecordNavigator:preview_off')}</span>
            </button>

            <div className="h-4 w-px bg-slate-200 dark:bg-zinc-700" />

            {/* Điều hướng record: Trước / ô nhập / Sau */}
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    data-testid="vdp-prev-record-btn"
                    disabled={vdpLivePreview.recordIndex <= 1}
                    onClick={(e) => {
                        e.stopPropagation();
                        const next = Math.max(1, vdpLivePreview.recordIndex - 1);
                        setVdpLivePreview((prev: VdpLivePreviewState) => ({ ...prev, recordIndex: next }));
                        window.dispatchEvent(new CustomEvent('vdp-preview-index-change', { detail: { index: next } }));
                    }}
                    className="h-6 w-6 flex items-center justify-center rounded bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300/80 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-slate-100 transition-colors text-[10px] dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-200 dark:border-zinc-700 dark:disabled:hover:bg-zinc-800 cursor-pointer"
                    title={t('Record trước (phím [)')}
                >
                    ◀
                </button>

                <div className="flex items-center gap-1 px-1 text-[11px] font-mono">
                    <span className="text-slate-600 dark:text-zinc-300 font-sans text-[11px]">Record</span>
                    <input
                        type="number"
                        data-testid="vdp-record-index-input"
                        min={1}
                        max={vdpLivePreview.totalRecords}
                        value={vdpLivePreview.recordIndex}
                        onChange={(e) => {
                            const val = Math.max(1, Math.min(vdpLivePreview.totalRecords, Number(e.target.value) || 1));
                            setVdpLivePreview((prev: VdpLivePreviewState) => ({ ...prev, recordIndex: val }));
                            window.dispatchEvent(new CustomEvent('vdp-preview-index-change', { detail: { index: val } }));
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-12 h-6 text-center bg-white border border-slate-300 rounded text-slate-800 font-bold text-xs focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 dark:bg-zinc-800 dark:border-zinc-600 dark:text-white dark:focus:border-teal-400"
                    />
                    <span className="text-slate-500 dark:text-zinc-400">/ {vdpLivePreview.totalRecords.toLocaleString('vi-VN')}</span>
                </div>

                <button
                    type="button"
                    data-testid="vdp-next-record-btn"
                    disabled={vdpLivePreview.recordIndex >= vdpLivePreview.totalRecords}
                    onClick={(e) => {
                        e.stopPropagation();
                        const next = Math.min(vdpLivePreview.totalRecords, vdpLivePreview.recordIndex + 1);
                        setVdpLivePreview((prev: VdpLivePreviewState) => ({ ...prev, recordIndex: next }));
                        window.dispatchEvent(new CustomEvent('vdp-preview-index-change', { detail: { index: next } }));
                    }}
                    className="h-6 w-6 flex items-center justify-center rounded bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300/80 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-slate-100 transition-colors text-[10px] dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-200 dark:border-zinc-700 dark:disabled:hover:bg-zinc-800 cursor-pointer"
                    title={t('Record sau (phím ])')}
                >
                    ▶
                </button>
            </div>

            {vdpLivePreview.sourceTitle && (
                <span
                    data-testid="vdp-source-title"
                    className="text-[10px] max-w-[150px] truncate border-l border-slate-200 dark:border-zinc-700 pl-2 text-teal-700 dark:text-teal-400/90 font-medium"
                    title={vdpLivePreview.sourceTitle}
                >
                    {vdpLivePreview.sourceTitle}
                </span>
            )}

            {/* Nút đặt lại vị trí về giữa (hiện khi đã kéo khỏi vị trí mặc định) */}
            {hasCustomPosition && (
                <button
                    type="button"
                    data-testid="vdp-reset-position-btn"
                    onClick={handleResetPosition}
                    className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:text-zinc-500 dark:hover:text-zinc-300 dark:hover:bg-zinc-800 transition-colors ml-0.5 cursor-pointer"
                    title={t('Đặt lại vị trí giữa')}
                >
                    <RotateCcw className="w-3 h-3" />
                </button>
            )}
        </div>
    );
};
