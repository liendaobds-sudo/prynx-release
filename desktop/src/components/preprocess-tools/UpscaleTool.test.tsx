// @vitest-environment jsdom

import { StrictMode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BatchItem } from './imageBatch/store';
import UpscaleTool, {
    copyUpscaleResultIdentity,
    disposeUpscaleTab,
    isUpscaleInputAlreadyTracked,
    isCurrentUpscaleWorkingResult,
    processUpscaleBatch,
    shouldPromoteUpscaleResult,
    tagUpscaleResultIdentity,
    upscaleOutputName,
} from './UpscaleTool';
import { useUpscaleStore } from './useUpscaleStore';

const apiMocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('../../lib/api', () => ({
    getApiUrl: () => 'http://localhost:8321/api',
    authenticatedFetch: apiMocks.authenticatedFetch,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriMocks.invoke }));
vi.mock('../../i18n', () => ({ tv: (text: string) => text }));
vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../ui/Toast', () => ({
    toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

function item(id: string, file: File, path = 'browser-file'): BatchItem {
    return {
        id,
        path,
        fileName: file.name,
        originalUrl: `blob:${id}`,
        status: 'pending',
        fileObj: file,
    };
}

function successResponse(blob: Blob, artifactLease = '') {
    return {
        ok: true,
        status: 200,
        headers: {
            get: (name: string) => {
                if (name === 'X-Upscale-Output-Size') return '40x24';
                if (name === 'X-Upscale-Working-Pdf-Path') return 'D:\\results\\upscaled.pdf';
                if (name === 'X-Upscale-Artifact-Lease') return artifactLease;
                return '';
            },
        },
        blob: async () => blob,
        text: async () => '',
    };
}

describe('UpscaleTool — dùng kết quả cho công cụ kế tiếp', () => {
    let resultBlob: Blob;

    beforeEach(() => {
        vi.clearAllMocks();
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
        useUpscaleStore.setState({ tabs: {} });
        resultBlob = new Blob(['upscaled-png'], { type: 'image/png' });
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn(() => 'blob:upscaled'),
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        });
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/warmup')) return { ok: true, json: async () => ({ ok: true }) };
            return successResponse(resultBlob);
        });
    });

    it('chỉ tự thay workspace khi kết quả không mơ hồ', () => {
        const source = new File(['source'], 'tem.png', { type: 'image/png' });
        const other = new File(['other'], 'khac.png', { type: 'image/png' });
        const sourceItem = item('source', source);
        const otherItem = item('other', other);

        expect(shouldPromoteUpscaleResult([sourceItem], sourceItem, null)).toBe(true);
        expect(shouldPromoteUpscaleResult([sourceItem, otherItem], sourceItem, source)).toBe(true);
        expect(shouldPromoteUpscaleResult([sourceItem, otherItem], otherItem, source)).toBe(false);
        expect(shouldPromoteUpscaleResult([sourceItem, otherItem], sourceItem, null)).toBe(false);
    });

    it('không va chạm khi hai File browser trùng tên và dung lượng', () => {
        const source = new File(['AAAA'], 'same.png', { type: 'image/png' });
        const collision = new File(['BBBB'], 'same.png', { type: 'image/png' });
        const sourceItem = item('source', source);
        const collisionItem = item('collision', collision);

        expect(shouldPromoteUpscaleResult([sourceItem, collisionItem], sourceItem, source)).toBe(true);
        expect(shouldPromoteUpscaleResult([sourceItem, collisionItem], collisionItem, source)).toBe(false);
        expect(isUpscaleInputAlreadyTracked([sourceItem], collision)).toBe(false);
    });

    it('không thêm ảnh kết quả trở lại batch thành một thumbnail trùng', () => {
        const source = new File(['source'], 'tem.jpg', { type: 'image/jpeg' });
        const sourceItem = {
            ...item('source', source),
            status: 'success' as const,
            resultBlob,
            resultIdentity: tagUpscaleResultIdentity(resultBlob, 'tab', 'source'),
        };
        const applied = new File([resultBlob], upscaleOutputName(source.name), { type: 'image/png' });
        copyUpscaleResultIdentity(resultBlob, applied);

        expect(isUpscaleInputAlreadyTracked([sourceItem], source)).toBe(true);
        expect(isUpscaleInputAlreadyTracked([sourceItem], applied)).toBe(true);
    });

    it('Undo chỉ nhận đúng token tab và item, không dùng tên + dung lượng', () => {
        const original = new File(['source'], 'same.png', { type: 'image/png' });
        const selected = {
            ...item('selected', original),
            status: 'success' as const,
            resultBlob,
            resultIdentity: tagUpscaleResultIdentity(resultBlob, 'tab-a', 'selected'),
        };
        const wrongWorkingFile = new File([resultBlob], 'upscaled_same.png', { type: 'image/png' });
        tagUpscaleResultIdentity(wrongWorkingFile, 'tab-a', 'other');

        expect(isCurrentUpscaleWorkingResult('tab-a', selected, wrongWorkingFile)).toBe(false);
        copyUpscaleResultIdentity(resultBlob, wrongWorkingFile);
        expect(isCurrentUpscaleWorkingResult('tab-a', selected, wrongWorkingFile)).toBe(true);
        expect(isCurrentUpscaleWorkingResult('tab-b', selected, wrongWorkingFile)).toBe(false);
    });

    it('ưu tiên đường dẫn cục bộ, cập nhật đúng tab và phát kết quả đã upscale', async () => {
        const source = new File(['source'], 'tem.jpg', { type: 'image/jpeg' });
        const path = 'D:\\mau\\tem.jpg';
        (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        tauriMocks.invoke.mockResolvedValue({ path, grant: 'v1.payload.signature' });
        useUpscaleStore.getState().initTab('tab-a');
        useUpscaleStore.getState().initTab('tab-b');
        useUpscaleStore.getState().addItems('tab-a', [item('source', source, path)]);
        const onResult = vi.fn(async () => undefined);

        await processUpscaleBatch('tab-a', onResult);

        const request = apiMocks.authenticatedFetch.mock.calls.find(([url]) => String(url).endsWith('/pdf-tools/upscale'));
        const body = request?.[1]?.body as FormData;
        expect(body.get('file_path')).toBe(path);
        expect(body.get('file_grant')).toBe('v1.payload.signature');
        expect(body.get('file_grant_tab_id')).toBe('tab-a');
        expect(body.get('file')).toBeNull();
        expect(body.get('include_working_pdf')).toBe('true');
        expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
            blob: resultBlob,
            name: 'upscaled_tem.png',
            workingPdfPath: 'D:\\results\\upscaled.pdf',
        }));
        expect(useUpscaleStore.getState().getTab('tab-a').batchItems[0].status).toBe('success');
        expect(useUpscaleStore.getState().getTab('tab-b').batchItems).toEqual([]);
    });

    it('grant bị từ chối thì gửi bytes ngay, không thử file_path không có quyền', async () => {
        const source = new File(['source'], 'tem.jpg', { type: 'image/jpeg' });
        (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        tauriMocks.invoke.mockRejectedValue(new Error('path ngoài scope'));
        useUpscaleStore.getState().initTab('tab-fallback');
        useUpscaleStore.getState().addItems('tab-fallback', [
            item('source', source, 'D:\\startup\\tem.jpg'),
        ]);

        await processUpscaleBatch('tab-fallback');

        const request = apiMocks.authenticatedFetch.mock.calls.find(([url]) => String(url).endsWith('/pdf-tools/upscale'));
        const body = request?.[1]?.body as FormData;
        expect(body.get('file_path')).toBeNull();
        expect(body.get('file_grant')).toBeNull();
        expect(body.get('file')).toEqual(expect.objectContaining({
            name: source.name,
            size: source.size,
        }));
    });

    it('grant stale retry đúng một lần bằng bytes và giữ nguyên option', async () => {
        const source = new File(['source'], 'tem.jpg', { type: 'image/jpeg' });
        const path = 'D:\\mau\\tem.jpg';
        (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        tauriMocks.invoke.mockResolvedValue({ path, grant: 'v1.payload.signature' });
        let upscaleAttempt = 0;
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/health')) return { ok: true, status: 200 };
            upscaleAttempt += 1;
            return upscaleAttempt === 1
                ? { ok: false, status: 403 }
                : successResponse(resultBlob);
        });
        useUpscaleStore.getState().initTab('tab-stale');
        useUpscaleStore.getState().addItems('tab-stale', [item('source', source, path)]);

        await processUpscaleBatch('tab-stale', async () => undefined);

        const upscaleRequests = apiMocks.authenticatedFetch.mock.calls.filter(
            ([url]) => String(url).endsWith('/pdf-tools/upscale'),
        );
        expect(upscaleRequests).toHaveLength(2);
        const first = upscaleRequests[0][1]?.body as FormData;
        const retry = upscaleRequests[1][1]?.body as FormData;
        expect(first.get('file_path')).toBe(path);
        expect(retry.get('file_path')).toBeNull();
        expect(retry.get('file')).toEqual(expect.objectContaining({
            name: source.name,
            size: source.size,
        }));
        expect(retry.get('engine')).toBe(first.get('engine'));
        expect(retry.get('scale_factor')).toBe(first.get('scale_factor'));
        expect(retry.get('include_working_pdf')).toBe(first.get('include_working_pdf'));
    });

    it('chờ backend sẵn sàng trước khi gửi đúng một tác vụ Upscale', async () => {
        const source = new File(['source'], 'tem.jpg', { type: 'image/jpeg' });
        useUpscaleStore.getState().initTab('tab-ready');
        useUpscaleStore.getState().addItems('tab-ready', [item('source', source)]);

        await processUpscaleBatch('tab-ready');

        const urls = apiMocks.authenticatedFetch.mock.calls.map(([url]) => String(url));
        const healthIndex = urls.findIndex(url => url.endsWith('/health'));
        const upscaleIndexes = urls
            .map((url, index) => url.endsWith('/pdf-tools/upscale') ? index : -1)
            .filter(index => index >= 0);
        expect(healthIndex).toBeGreaterThanOrEqual(0);
        expect(upscaleIndexes).toHaveLength(1);
        expect(healthIndex).toBeLessThan(upscaleIndexes[0]);
        expect(useUpscaleStore.getState().getTab('tab-ready').batchItems[0].status).toBe('success');
    });

    it('tự dùng kết quả ảnh đơn và không nhân đôi batch khi parent cập nhật ảnh nguồn', async () => {
        const source = new File(['source'], 'tem.jpg', { type: 'image/jpeg' });
        const pdf = new File(['pdf'], 'tem.pdf', { type: 'application/pdf' });
        const onFileFixed = vi.fn(async () => undefined);
        const view = render(
            <StrictMode>
                <UpscaleTool tabId="tab-ui" pdfFile={pdf} sourceImageFile={source} onFileFixed={onFileFixed} />
            </StrictMode>,
        );

        await waitFor(() => expect(useUpscaleStore.getState().getTab('tab-ui').batchItems).toHaveLength(1));
        fireEvent.click(screen.getByRole('button', { name: 'preprocess.common:run' }));
        await waitFor(() => expect(onFileFixed).toHaveBeenCalledWith(
            resultBlob,
            'upscaled_tem.png',
            'D:\\results\\upscaled.pdf',
        ));

        const applied = new File([resultBlob], 'upscaled_tem.png', { type: 'image/png' });
        copyUpscaleResultIdentity(resultBlob, applied);
        view.rerender(
            <StrictMode>
                <UpscaleTool tabId="tab-ui" pdfFile={pdf} sourceImageFile={applied} onFileFixed={onFileFixed} />
            </StrictMode>,
        );
        await waitFor(() => expect(useUpscaleStore.getState().getTab('tab-ui').batchItems).toHaveLength(1));

        fireEvent.click(screen.getByTitle('preprocess.upscale:hoan_tac_de_chinh_sua_lai'));
        await waitFor(() => expect(onFileFixed).toHaveBeenNthCalledWith(2, source, 'tem.jpg', undefined));
        expect(useUpscaleStore.getState().getTab('tab-ui').batchItems[0].status).toBe('pending');
    });

    it('không commit muộn sau khi màn Upscale đã đóng', async () => {
        let resolveRequest!: (value: ReturnType<typeof successResponse>) => void;
        const pending = new Promise<ReturnType<typeof successResponse>>(resolve => { resolveRequest = resolve; });
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/warmup')) return { ok: true, json: async () => ({ ok: true }) };
            if (url.endsWith('/artifact/release')) return { ok: true, status: 200 };
            return pending;
        });
        const source = new File(['source'], 'tem.png', { type: 'image/png' });
        const onFileFixed = vi.fn(async () => undefined);
        const view = render(
            <UpscaleTool tabId="tab-closed" pdfFile={null} sourceImageFile={source} onFileFixed={onFileFixed} />,
        );

        await waitFor(() => expect(useUpscaleStore.getState().getTab('tab-closed').batchItems).toHaveLength(1));
        fireEvent.click(screen.getByRole('button', { name: 'preprocess.common:run' }));
        view.unmount();
        resolveRequest(successResponse(resultBlob, 'lease-unmounted'));

        await waitFor(() => expect(useUpscaleStore.getState().getTab('tab-closed').isProcessing).toBe(false));
        expect(onFileFixed).not.toHaveBeenCalled();
        await waitFor(() => expect(apiMocks.authenticatedFetch.mock.calls.some(
            ([url]) => String(url).endsWith('/artifact/release'),
        )).toBe(true));
    });

    it('dispose tab thu hồi URL và xóa hẳn record khỏi store', () => {
        const revoke = vi.mocked(URL.revokeObjectURL);
        const source = new File(['source'], 'tem.png', { type: 'image/png' });
        useUpscaleStore.getState().initTab('tab-dispose');
        useUpscaleStore.getState().addItems('tab-dispose', [{
            ...item('source', source),
            resultUrl: 'blob:result',
            resultBlob,
        }]);

        disposeUpscaleTab('tab-dispose');

        expect(useUpscaleStore.getState().tabs['tab-dispose']).toBeUndefined();
        expect(revoke).toHaveBeenCalledWith('blob:source');
        expect(revoke).toHaveBeenCalledWith('blob:result');
    });

    it('claim lease sau commit và release khi đóng đúng tab owner', async () => {
        const source = new File(['source'], 'tem.png', { type: 'image/png' });
        useUpscaleStore.getState().initTab('tab-lease');
        useUpscaleStore.getState().addItems('tab-lease', [item('source', source)]);
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/artifact/claim') || url.endsWith('/artifact/release')) {
                return { ok: true, status: 200 };
            }
            return successResponse(resultBlob, 'lease-token-1');
        });

        await processUpscaleBatch('tab-lease', async () => true);

        const claim = apiMocks.authenticatedFetch.mock.calls.find(([url]) => String(url).endsWith('/artifact/claim'));
        expect((claim?.[1]?.body as FormData).get('lease_token')).toBe('lease-token-1');

        disposeUpscaleTab('tab-lease');
        await waitFor(() => {
            const release = apiMocks.authenticatedFetch.mock.calls.find(([url]) => String(url).endsWith('/artifact/release'));
            expect((release?.[1]?.body as FormData).get('lease_token')).toBe('lease-token-1');
        });
    });

    it('shell đóng tab gọi disposer của Upscale', () => {
        const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
        expect(appSource).toContain("import('./components/preprocess-tools/UpscaleTool')");
        expect(appSource).toContain('disposeUpscaleTab(id)');
    });
});
