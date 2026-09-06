// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    WorkspaceContext, createWorkspaceStore, captureWorkspaceDocumentRevision,
} from '../../stores/useWorkspaceStore';
import { stickerObjectSourceIdentity } from '../../lib/stickerObjectSelection';
import StickerObjectSelectionControl from './StickerObjectSelectionControl';
import { useStickerSheetStore, type PrepareStickerWorkspaceSource } from './stickerSheetStore';
import { toast } from '../ui/Toast';

vi.mock('../ui/Toast', () => ({ toast: { error: vi.fn() } }));

let workspace = createWorkspaceStore();
const pdf = new File(['pdf'], 'tem.pdf', { type: 'application/pdf' });

function selectObjects(page = 1) {
    const state = workspace.getState();
    act(() => workspace.setState({ objectSelectionContext: {
        fileId: 'file-id', pageIndex: page - 1, objectIds: ['vector-2'], viewerPage: page,
        pageInstanceId: `instance-${page}`, revision: captureWorkspaceDocumentRevision(state),
    } }));
}

function view(prepare: PrepareStickerWorkspaceSource = vi.fn(async () => ({
    file: pdf, revision: captureWorkspaceDocumentRevision(workspace.getState()), isCurrent: () => true,
})), isActive = true) {
    return render(<WorkspaceContext.Provider value={workspace}>
        <StickerObjectSelectionControl tabId="custom" workingPage={1} isActive={isActive}
            prepareWorkspaceSource={prepare} />
    </WorkspaceContext.Provider>);
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    workspace = createWorkspaceStore();
    workspace.setState({ file: pdf, viewerNumPages: 2, viewerPageOrder: [1, 2],
        viewerPageRotations: [0, 0], viewerPageInstanceIds: ['instance-1', 'instance-2'],
        selectionFileId: 'file-id', selectionDocumentIdentity: stickerObjectSourceIdentity(pdf),
    });
    useStickerSheetStore.setState({ tabs: {} });
    useStickerSheetStore.getState().selectSource('custom', pdf, 'workspace');
});

describe('chọn tem trong workspace chung', () => {
    it('chọn trên canvas rồi chuyển ID vào cùng action nhận diện', async () => {
        const apply = vi.fn();
        const detect = vi.spyOn(useStickerSheetStore.getState(), 'detectStickers')
            .mockImplementation(async (_tab, _strategy, _page, prepare) => { await prepare?.(); apply(); });
        view();
        fireEvent.click(screen.getByRole('button', { name: 'Chọn tem' }));
        expect(workspace.getState().isObjectEditMode).toBe(true);
        expect((screen.getByRole('button', { name: 'Dùng phần đã chọn' }) as HTMLButtonElement).disabled).toBe(true);
        selectObjects();
        fireEvent.click(screen.getByRole('button', { name: 'Dùng phần đã chọn (1)' }));
        await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
        expect(detect).toHaveBeenCalledWith('custom', 'auto', 1, expect.any(Function), ['vector-2']);
        expect(workspace.getState().isObjectEditMode).toBe(false);
    });

    it('đổi revision lúc chuẩn bị không gửi lựa chọn sang PDF mới', async () => {
        const apply = vi.fn();
        vi.spyOn(useStickerSheetStore.getState(), 'detectStickers')
            .mockImplementation(async (_tab, _strategy, _page, prepare) => { await prepare?.(); apply(); });
        view(vi.fn(async () => {
            workspace.setState({ editGeneration: 1 });
            return { file: pdf, revision: {}, isCurrent: () => true };
        }));
        fireEvent.click(screen.getByRole('button', { name: 'Chọn tem' }));
        selectObjects();
        fireEvent.click(screen.getByRole('button', { name: 'Dùng phần đã chọn (1)' }));
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(apply).not.toHaveBeenCalled();
    });

    it('không áp dụng lựa chọn của trang khác và hủy không nhận diện', () => {
        const detect = vi.spyOn(useStickerSheetStore.getState(), 'detectStickers').mockResolvedValue();
        view();
        fireEvent.click(screen.getByRole('button', { name: 'Chọn tem' }));
        selectObjects(2);
        expect((screen.getByRole('button', { name: 'Dùng phần đã chọn' }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Hủy chọn tem' }));
        expect(workspace.getState().isObjectEditMode).toBe(false);
        expect(detect).not.toHaveBeenCalled();
    });

    it('tab nền không mở chọn và tháo component trả quyền canvas', () => {
        const hidden = view(undefined, false);
        fireEvent.click(screen.getByRole('button', { name: 'Chọn tem' }));
        expect(workspace.getState().isObjectEditMode).toBe(false);
        hidden.unmount();
        const active = view();
        fireEvent.click(screen.getByRole('button', { name: 'Chọn tem' }));
        expect(workspace.getState().isObjectEditMode).toBe(true);
        active.unmount();
        expect(workspace.getState().isObjectEditMode).toBe(false);
    });
});
