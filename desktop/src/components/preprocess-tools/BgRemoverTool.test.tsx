// @vitest-environment jsdom

import { StrictMode } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_BATCH_DROP_EVENTS } from '../../lib/tabNavigation';
import BgRemoverTool from './BgRemoverTool';
import { useBgRemoverStore } from './useBgRemoverStore';

const apiMocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));

vi.mock('../../lib/api', () => ({
    getApiUrl: () => 'http://localhost:8321/api',
    authenticatedFetch: apiMocks.authenticatedFetch,
}));
vi.mock('../../i18n', () => ({ tv: (text: string) => text }));
vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../ui/Toast', () => ({
    toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

describe('BgRemoverTool — nhận ảnh đang mở trong Viewer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useBgRemoverStore.setState({ tabs: {} });
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn(() => 'blob:bg-source'),
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        });
        apiMocks.authenticatedFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ ok: true }),
        });
    });

    it('tự thêm ảnh nguồn dù Viewer đang hiển thị PDF đã chuẩn hóa', async () => {
        const source = new File(['source'], 'anh-goc.png', { type: 'image/png' });
        const normalizedPdf = new File(['pdf'], 'anh-goc.pdf', { type: 'application/pdf' });

        const renderTool = () => (
            <StrictMode>
                <BgRemoverTool
                    tabId="tab-bg"
                    pdfFile={normalizedPdf}
                    sourceImageFile={source}
                />
            </StrictMode>
        );
        const view = render(renderTool());

        await waitFor(() => {
            expect(useBgRemoverStore.getState().getTab('tab-bg').batchItems).toHaveLength(1);
        });
        expect(useBgRemoverStore.getState().getTab('tab-bg').batchItems[0]).toMatchObject({
            fileName: source.name,
            fileObj: source,
            sourceOrigin: 'workspace',
        });

        view.unmount();
        render(renderTool());
        await waitFor(() => {
            expect(useBgRemoverStore.getState().getTab('tab-bg').batchItems).toHaveLength(1);
        });
    });

    it('thay nguồn Viewer nhưng giữ nguyên ảnh người dùng chọn thêm', async () => {
        const firstSource = new File(['first'], 'anh-cu.png', { type: 'image/png' });
        const nextSource = new File(['next'], 'anh-moi.png', { type: 'image/png' });
        const explicitSource = new File(['explicit'], 'anh-chon-them.png', { type: 'image/png' });
        const normalizedPdf = new File(['pdf'], 'anh-goc.pdf', { type: 'application/pdf' });
        const renderTool = (sourceImageFile: File | null) => (
            <BgRemoverTool
                tabId="tab-bg-update"
                pdfFile={normalizedPdf}
                sourceImageFile={sourceImageFile}
            />
        );
        const view = render(renderTool(firstSource));

        await waitFor(() => {
            expect(useBgRemoverStore.getState().getTab('tab-bg-update').batchItems).toHaveLength(1);
        });
        act(() => {
            window.dispatchEvent(new CustomEvent(IMAGE_BATCH_DROP_EVENTS.bgremover, {
                detail: { tabId: 'tab-bg-update', files: [explicitSource] },
            }));
        });
        await waitFor(() => {
            expect(useBgRemoverStore.getState().getTab('tab-bg-update').batchItems).toHaveLength(2);
        });

        view.rerender(renderTool(nextSource));

        await waitFor(() => {
            const items = useBgRemoverStore.getState().getTab('tab-bg-update').batchItems;
            expect(items).toHaveLength(2);
            expect(items.some(item => item.fileName === firstSource.name)).toBe(false);
            expect(items.find(item => item.fileName === nextSource.name)?.sourceOrigin).toBe('workspace');
            expect(items.find(item => item.fileName === explicitSource.name)?.sourceOrigin).toBe('explicit');
        });

        view.rerender(renderTool(null));
        await waitFor(() => {
            const items = useBgRemoverStore.getState().getTab('tab-bg-update').batchItems;
            expect(items).toHaveLength(1);
            expect(items[0]).toMatchObject({
                fileName: explicitSource.name,
                sourceOrigin: 'explicit',
            });
        });
    });
});
