// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DataMergeTool from './DataMergeTool';
import { createWorkspaceStore, WorkspaceContext } from '@/stores/useWorkspaceStore';

const api = vi.hoisted(() => ({ detect: vi.fn(), validate: vi.fn(), start: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/lib/api')>(),
    autoDetectVdpTags: api.detect,
    validateVdp: api.validate,
    startVdpJobBackend: api.start,
}));
vi.mock('../ui/Toast', () => ({ toast }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const fields = [{ id: 'f1', name: 'Noidung', type: 'text', x: 1, y: 1, width: 20, height: 10 }];
const detected = {
    detected_count: 1, fields, working_fid: 'cleaned-a', working_pdf_url: '/cleaned.pdf',
    working_pdf_path: 'D:/cleaned.pdf', artifact_lease: 'lease-a',
};

function mount() {
    const store = createWorkspaceStore();
    store.setState({ selectionFileId: 'source-a' });
    const setFields = vi.fn();
    let props: React.ComponentProps<typeof DataMergeTool> = {
        pdfFile: new File(['pdf'], 'a.pdf'), vdpFields: fields, setVdpFields: setFields,
        tabId: 'tab-a', isActive: true,
    };
    const ui = () => <WorkspaceContext.Provider value={store}><DataMergeTool {...props} /></WorkspaceContext.Provider>;
    const view = render(ui());
    return {
        store, setFields, ...view,
        update: (changes: Partial<typeof props>) => { props = { ...props, ...changes }; view.rerender(ui()); },
    };
}

function startValidation() {
    fireEvent.click(screen.getByRole('button', { name: /Kiểm tra trước khi chạy/i }));
    fireEvent.click(screen.getByRole('button', { name: /Kiểm tra \(validate\)/i }));
}

describe('DataMergeTool — phản hồi bất đồng bộ giữ đúng chủ sở hữu', () => {
    beforeEach(() => vi.clearAllMocks());

    it('nhận kết quả quét đúng PDF và phát event kèm lease', async () => {
        const request = deferred<typeof detected>();
        api.detect.mockReturnValueOnce(request.promise);
        const view = mount();
        const listener = vi.fn();
        window.addEventListener('vdp-template-cleaned', listener);
        try {
            fireEvent.click(screen.getByRole('button', { name: 'Quét thẻ {{...}}' }));
            await act(async () => { request.resolve(detected); });
            expect(view.setFields).toHaveBeenCalledOnce();
            expect(listener).toHaveBeenCalledOnce();
            expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
                tabId: 'tab-a', sourceFid: 'source-a', artifact_lease: 'lease-a',
            });
        } finally { window.removeEventListener('vdp-template-cleaned', listener); }
    });

    it.each(['file', 'fid', 'inactive', 'unmount'] as const)('bỏ kết quả quét sau khi đổi %s', async (change) => {
        const request = deferred<typeof detected>();
        api.detect.mockReturnValueOnce(request.promise);
        const view = mount();
        const listener = vi.fn();
        window.addEventListener('vdp-template-cleaned', listener);
        try {
            fireEvent.click(screen.getByRole('button', { name: 'Quét thẻ {{...}}' }));
            if (change === 'file') view.update({ pdfFile: new File(['pdf-b'], 'b.pdf') });
            if (change === 'fid') act(() => view.store.setState({ selectionFileId: 'source-b' }));
            if (change === 'inactive') view.update({ isActive: false });
            if (change === 'unmount') view.unmount();
            await act(async () => { request.resolve(detected); });
            expect(view.setFields).not.toHaveBeenCalled();
            expect(listener).not.toHaveBeenCalled();
            expect(toast.success).not.toHaveBeenCalled();
        } finally { window.removeEventListener('vdp-template-cleaned', listener); }
    });

    it.each(['fields', 'file', 'fid'] as const)('bỏ validate thành công sau khi đổi %s', async (change) => {
        const request = deferred<{ gating: string; issues: { severity: string; reason: string }[] }>();
        api.validate.mockReturnValueOnce(request.promise);
        const view = mount();
        startValidation();
        if (change === 'fields') view.update({ vdpFields: [{ ...fields[0], name: 'Other' }] });
        if (change === 'file') view.update({ pdfFile: new File(['pdf-b'], 'b.pdf') });
        if (change === 'fid') act(() => view.store.setState({ selectionFileId: 'source-b' }));
        await act(async () => { request.resolve({ gating: 'block', issues: [{ severity: 'error', reason: 'STALE-ISSUE' }] }); });
        expect(screen.queryByText(/STALE-ISSUE/)).toBeNull();
        expect((screen.getByRole('button', { name: /Kiểm tra \(validate\)/i }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('lỗi validate cũ không ghi đè trạng thái của cấu hình mới', async () => {
        const request = deferred<never>();
        api.validate.mockReturnValueOnce(request.promise);
        const view = mount();
        startValidation();
        view.update({ vdpFields: [{ ...fields[0], name: 'Other' }] });
        await act(async () => { request.reject(new Error('STALE-ERROR')); });
        expect(screen.queryByText(/STALE-ERROR/)).toBeNull();
    });
});
