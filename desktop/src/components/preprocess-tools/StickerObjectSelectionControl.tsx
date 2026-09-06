import { useContext, useEffect, useRef, useState } from 'react';
import { MousePointer2, X } from 'lucide-react';

import { tv } from '../../i18n';
import { WorkspaceContext, useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { resolveStickerObjectSelection } from '../../lib/stickerObjectSelection';
import { toast } from '../ui/Toast';
import { useStickerSheetStore, type PrepareStickerWorkspaceSource } from './stickerSheetStore';

interface Props {
    tabId: string;
    workingPage: number;
    isActive: boolean;
    disabled?: boolean;
    prepareWorkspaceSource: PrepareStickerWorkspaceSource;
    onSelectionActiveChange?: (active: boolean) => void;
    onProcessingChange?: (processing: boolean) => void;
}

/** CUSTOM (2026-09-06): chọn trên PDF, tạo mask/CUT trong chính workspace đang dùng. */
export default function StickerObjectSelectionControl({
    tabId, workingPage, isActive, disabled = false, prepareWorkspaceSource,
    onSelectionActiveChange, onProcessingChange,
}: Props) {
    const workspaceStore = useContext(WorkspaceContext)!;
    const workspace = useWorkspaceStore();
    const [ownsSelection, setOwnsSelection] = useState(false);
    const [processing, setProcessing] = useState(false);
    const activeRef = useRef({ isActive, workingPage });
    activeRef.current = { isActive, workingPage };
    const selecting = ownsSelection && workspace.isObjectEditMode;
    const objectIds = resolveStickerObjectSelection(workspace, workingPage);

    useEffect(() => {
        onSelectionActiveChange?.(isActive && selecting);
        return () => onSelectionActiveChange?.(false);
    }, [isActive, onSelectionActiveChange, selecting]);

    useEffect(() => {
        if (isActive || !ownsSelection) return;
        workspaceStore.getState().setIsObjectEditMode(false);
        setOwnsSelection(false);
    }, [isActive, ownsSelection, workspaceStore]);

    useEffect(() => () => {
        activeRef.current.isActive = false;
        onProcessingChange?.(false);
    }, [onProcessingChange]);

    useEffect(() => () => {
        if (ownsSelection) workspaceStore.getState().setIsObjectEditMode(false);
    }, [ownsSelection, workspaceStore]);

    const endSelection = () => {
        workspaceStore.getState().setIsObjectEditMode(false);
        setOwnsSelection(false);
    };

    const applySelection = async () => {
        if (!isActive || disabled || processing || !objectIds?.length) return;
        const actions = useStickerSheetStore.getState();
        const before = actions.getTab(tabId);
        const page = before.pages[workingPage] || before;
        if (page.edits.length && !window.confirm(tv('Thay vùng tem sẽ bỏ nét sửa trên trang này. Tiếp tục?'))) return;
        const expectedIds = [...objectIds].sort().join('|');
        const selectionIsCurrent = () => {
            const current = activeRef.current;
            const ids = resolveStickerObjectSelection(workspaceStore.getState(), workingPage);
            return current.isActive && current.workingPage === workingPage
                && ids !== null && [...ids].sort().join('|') === expectedIds;
        };
        setProcessing(true);
        onProcessingChange?.(true);
        endSelection();
        try {
            // Chọn trực tiếp trên Viewer phải nhắm tài liệu đó, không dùng nguồn
            // kéo thả riêng còn lưu trong phiên nhận diện trước.
            if (before.sourceOrigin !== 'workspace') {
                const file = workspaceStore.getState().file;
                if (!file) throw new Error(tv('Không tìm thấy tài liệu đang mở.'));
                actions.selectSource(tabId, file, 'workspace');
            }
            const prepareSelectedSource: PrepareStickerWorkspaceSource = async () => {
                if (!selectionIsCurrent()) throw new Error(tv('Tài liệu hoặc lựa chọn đã đổi. Hãy chọn lại tem.'));
                const lease = await prepareWorkspaceSource();
                if (!selectionIsCurrent() || !lease.isCurrent()) {
                    throw new Error(tv('Tài liệu hoặc lựa chọn đã đổi. Hãy chọn lại tem.'));
                }
                return { ...lease, isCurrent: () => lease.isCurrent() && selectionIsCurrent() };
            };
            await actions.detectStickers(tabId, 'auto', workingPage, prepareSelectedSource, objectIds);
            if (!activeRef.current.isActive) return;
            const latest = actions.getTab(tabId);
            const detected = latest.pages[workingPage] || latest;
            if (detected.status === 'mask-review' && !detected.error
                && detected.manifest && !detected.manifest.needs_review) {
                await actions.confirmMask(tabId, workingPage);
            }
        } catch (error) {
            if (activeRef.current.isActive) toast.error(error instanceof Error ? error.message : tv('Không áp dụng được lựa chọn.'));
        } finally {
            setProcessing(false);
            onProcessingChange?.(false);
        }
    };

    return (
        <div className="flex items-center gap-2">
            {selecting ? (
                <>
                    <button type="button" disabled={disabled || processing || !objectIds?.length}
                        onClick={() => { void applySelection(); }}
                        className="h-9 flex-1 rounded-lg bg-violet-600 px-3 text-xs font-semibold text-white disabled:opacity-50">
                        {tv('Dùng phần đã chọn')}{objectIds?.length ? ` (${objectIds.length})` : ''}
                    </button>
                    <button type="button" aria-label={tv('Hủy chọn tem')} onClick={endSelection}
                        className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 dark:border-zinc-700">
                        <X size={15} />
                    </button>
                </>
            ) : (
                <button type="button" disabled={!isActive || disabled || processing}
                    onClick={() => {
                        useStickerSheetStore.getState().setMaskEditingEnabled(tabId, false);
                        workspace.setIsCropMode(false);
                        workspace.setViewerToolMode('pointer');
                        workspace.setIsObjectEditMode(true);
                        setOwnsSelection(true);
                    }}
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 text-xs font-semibold disabled:opacity-50 dark:border-zinc-700">
                    <MousePointer2 size={14} />{tv('Chọn tem')}
                </button>
            )}
        </div>
    );
}
