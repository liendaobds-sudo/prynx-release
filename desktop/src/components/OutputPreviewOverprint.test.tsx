// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceStore, WorkspaceContext } from '../stores/useWorkspaceStore';

const apiMocks = vi.hoisted(() => ({
    authenticatedFetch: vi.fn(),
}));

vi.mock('../lib/api', () => ({
    authenticatedFetch: apiMocks.authenticatedFetch,
    getApiUrl: () => 'http://localhost:8321/api',
}));

import { OverprintPreviewToggle } from './OutputPreviewTab';
import SoftProofPanel from './SoftProofPanel';

function Harness() {
    const [active, setActive] = useState(false);
    return (
        <OverprintPreviewToggle
            fileId="file-a"
            pageNum={1}
            profileId="swop"
            intent="perceptual"
            active={active}
            onActiveChange={setActive}
        />
    );
}

function response(overprint: string, diff: string, pageHasOverprint = true) {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            success: true,
            overprint_image: overprint,
            diff_overlay: diff,
            diff_pixel_count: 42,
            has_differences: true,
            page_has_overprint: pageHasOverprint,
        }),
    } as Response;
}

describe('Output Preview — mô phỏng Overprint', () => {
    beforeEach(() => {
        apiMocks.authenticatedFetch.mockReset();
    });

    it('hiển thị composite mặc định và chỉ dùng diff khi bật chẩn đoán', async () => {
        apiMocks.authenticatedFetch.mockResolvedValue(response('data:op', 'data:diff'));
        const store = createWorkspaceStore();
        const { unmount } = render(
            <WorkspaceContext.Provider value={store}>
                <Harness />
            </WorkspaceContext.Provider>,
        );

        fireEvent.click(screen.getByRole('button', { name: /Mô phỏng Overprint/i }));
        await waitFor(() => expect(store.getState().overprintPreviewUrl).toBe('data:op'));
        await waitFor(() => expect(
            screen.getByRole('button', { name: /Tắt Overprint Preview/i }).getAttribute('aria-pressed'),
        ).toBe('true'));
        expect(store.getState().outputPreviewOverprintDiagnosticActive).toBe(false);

        const [, init] = apiMocks.authenticatedFetch.mock.calls[0];
        expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
            profile_id: 'swop',
            intent: 'perceptual',
        });
        expect(screen.getByText(/Trang có Overprint/i).parentElement?.textContent).toContain('Có');

        const diagnostic = screen.getByRole('checkbox', { name: /vùng thay đổi/i });
        fireEvent.click(diagnostic);
        expect(store.getState().overprintPreviewUrl).toBe('data:diff');
        expect(store.getState().outputPreviewOverprintDiagnosticActive).toBe(true);
        fireEvent.click(diagnostic);
        expect(store.getState().overprintPreviewUrl).toBe('data:op');
        expect(store.getState().outputPreviewOverprintDiagnosticActive).toBe(false);
        expect(screen.getByRole('button', { name: /Tắt Overprint Preview/i }).getAttribute('aria-pressed')).toBe('true');

        fireEvent.click(screen.getByRole('button', { name: /Tắt Overprint Preview/i }));
        await waitFor(() => expect(store.getState().overprintPreviewUrl).toBeNull());
        expect(screen.getByRole('button', { name: /Mô phỏng Overprint/i }).getAttribute('aria-pressed')).toBe('false');
        unmount();
        expect(store.getState().overprintPreviewUrl).toBeNull();
        expect(store.getState().outputPreviewOverprintDiagnosticActive).toBe(false);
    });

    it('response cũ không thắng sau khi hủy rồi bật lại', async () => {
        const pending: Array<(value: Response) => void> = [];
        apiMocks.authenticatedFetch.mockImplementation(() => (
            new Promise<Response>(resolve => pending.push(resolve))
        ));
        const store = createWorkspaceStore();
        render(
            <WorkspaceContext.Provider value={store}>
                <Harness />
            </WorkspaceContext.Provider>,
        );

        fireEvent.click(screen.getByRole('button', { name: /Mô phỏng Overprint/i }));
        await waitFor(() => expect(pending).toHaveLength(1));
        const firstSignal = (apiMocks.authenticatedFetch.mock.calls[0][1] as RequestInit).signal;

        fireEvent.click(screen.getByRole('button', { name: /Hủy phân tích Overprint/i }));
        expect(firstSignal?.aborted).toBe(true);
        await waitFor(() => expect(
            screen.getByRole('button', { name: /Mô phỏng Overprint/i }),
        ).toBeTruthy());

        fireEvent.click(screen.getByRole('button', { name: /Mô phỏng Overprint/i }));
        await waitFor(() => expect(pending).toHaveLength(2));
        await act(async () => pending[1](response('data:new', 'data:new-diff')));
        await waitFor(() => expect(store.getState().overprintPreviewUrl).toBe('data:new'));

        await act(async () => pending[0](response('data:old', 'data:old-diff')));
        expect(store.getState().overprintPreviewUrl).toBe('data:new');
    });

    it('Soft-Proof nhận cùng trạng thái Overprint thay vì tự bật riêng', async () => {
        apiMocks.authenticatedFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ success: true, softproof_b64: 'abc' }),
        } as Response);
        const store = createWorkspaceStore();
        render(
            <WorkspaceContext.Provider value={store}>
                <SoftProofPanel
                    fileId="file-a"
                    profileId="swop"
                    intent="perceptual"
                    simulateOverprint={false}
                />
            </WorkspaceContext.Provider>,
        );

        fireEvent.click(screen.getByRole('button', { name: /Soft-Proof/i }));
        await waitFor(() => expect(apiMocks.authenticatedFetch).toHaveBeenCalledTimes(1));
        const [, init] = apiMocks.authenticatedFetch.mock.calls[0];
        expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
            profile_id: 'swop',
            intent: 'perceptual',
            simulate_overprint: false,
        });
    });
});
