// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
// GS-SUNSET (audit 2026-07-28 §FL.2): cảnh báo raster hoá phải xuất hiện trên UI.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    confirmDialog: vi.fn(),
    toastInfo: vi.fn(),
    workspaceState: {
        pdfUrl: null,
        selectedObjectIds: [] as string[],
        setSelectedObjectIds: vi.fn(),
        hiddenObjectIds: [],
        setHiddenObjectIds: vi.fn(),
        lockedObjectIds: [],
        setLockedObjectIds: vi.fn(),
        pdfOcgLayers: [],
        hiddenOcgLayerIds: [],
        setHiddenOcgLayerIds: vi.fn(),
        lockedOcgLayerIds: [],
        setLockedOcgLayerIds: vi.fn(),
        expandedOcgLayerIds: [],
        setExpandedOcgLayerIds: vi.fn(),
        viewerActivePage: 1,
        viewerPageOrder: undefined as number[] | undefined,
        setError: vi.fn(),
        editAddMode: null,
        setEditAddMode: vi.fn(),
    },
}));

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: (selector: unknown) => selector }));
vi.mock('../../stores/useWorkspaceStore', () => ({
    useWorkspaceStore: (selector: (state: typeof mocks.workspaceState) => unknown) =>
        selector(mocks.workspaceState),
}));
vi.mock('../../stores/pdfObjectCache', () => ({
    globalPdfObjectCache: { getAllObjects: () => ({}) },
}));
vi.mock('../ui/confirmDialog', () => ({ confirmDialog: mocks.confirmDialog }));
vi.mock('../ui/Toast', () => ({ toast: { info: mocks.toastInfo } }));

import EditLayersPanel from './SelectionLayersPanel';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirmDialog.mockResolvedValue(true);
});

describe('SelectionLayersPanel — cảnh báo Flatten', () => {
    it('hiện toast khi backend báo Working File đã bị raster hoá', async () => {
        const flatten = vi.fn().mockResolvedValue({
            success: true,
            output_fid: 'fid-moi',
            warning: 'Đã raster hoá 300 DPI RGB; mất vector, Pantone và kênh bế.',
        });

        render(
            <EditLayersPanel
                handleDeleteObjects={vi.fn()}
                editObjects={[]}
                isEditMode
                editSession={{ sessionId: 'session-test', flatten } as any}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Flatten' }));

        await waitFor(() => expect(flatten).toHaveBeenCalledTimes(1));
        expect(mocks.toastInfo).toHaveBeenCalledWith(
            expect.stringContaining('mất vector, Pantone và kênh bế'),
        );
    });
});

describe('SelectionLayersPanel — xóa thành phần nhiều trang', () => {
    it('ánh xạ vị trí thumbnail sang trang nguồn sau reorder, không gọi đường legacy', async () => {
        const originalPage = mocks.workspaceState.viewerActivePage;
        const originalOrder = mocks.workspaceState.viewerPageOrder;
        const originalSelected = mocks.workspaceState.selectedObjectIds;
        mocks.workspaceState.viewerActivePage = 1;
        mocks.workspaceState.viewerPageOrder = [3, 1, 2];
        mocks.workspaceState.selectedObjectIds = ['obj-page-3'];
        const applyOp = vi.fn().mockResolvedValue({ success: true });
        const legacyDelete = vi.fn();

        try {
            render(
                <EditLayersPanel
                    handleDeleteObjects={legacyDelete}
                    editObjects={[{
                        id: 'obj-page-3',
                        type: 'text',
                        drawIndex: 1,
                        bbox: [0, 0, 10, 10],
                    }]}
                    isEditMode
                    editSession={{
                        sessionId: 'session-page-3',
                        applyOp,
                    } as any}
                />,
            );

            fireEvent.click(screen.getByRole('button', {
                name: 'misc.selectionLayers:xoa_n_thanh_phan_da_chon',
            }));

            await waitFor(() => expect(applyOp).toHaveBeenCalledWith({
                page: 2,
                kind: 'delete',
                targetIds: ['obj-page-3'],
            }));
            expect(legacyDelete).not.toHaveBeenCalled();
            expect(mocks.workspaceState.setSelectedObjectIds).toHaveBeenCalled();
        } finally {
            mocks.workspaceState.viewerActivePage = originalPage;
            mocks.workspaceState.viewerPageOrder = originalOrder;
            mocks.workspaceState.selectedObjectIds = originalSelected;
        }
    });
});
