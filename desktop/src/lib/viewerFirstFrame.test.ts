// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    adoptViewerFirstFrame, isViewerFirstFramePending, peekViewerFirstFrame,
    primeViewerFirstFrame, releaseViewerFirstFrame, subscribeViewerFirstFrame,
    type ViewerFirstFrame,
} from './viewerFirstFrame';

const invoke = vi.fn();
let token: string;
let serial = 0;
let path: string;
let requests: Array<{ resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>;
let frames: ViewerFirstFrame[];
let disposers: Array<() => void>;

function file(modified = 1) {
    return Object.assign(new File(['test'], 'prime.pdf', {
        type: 'application/pdf', lastModified: modified,
    }), { path });
}
async function expectRequests(count: number) {
    await vi.waitFor(() => expect(requests).toHaveLength(count));
}
async function finish(promise: Promise<ViewerFirstFrame | null>, index: number) {
    requests[index].resolve(new ArrayBuffer(8));
    const frame = await promise;
    if (frame) frames.push(frame);
    return frame;
}

describe('Viewer first frame — request chia sẻ và vòng đời snapshot', () => {
    beforeEach(() => {
        path = `D:\\test\\prime-${++serial}.pdf`;
        token = '4:100:100';
        requests = [];
        frames = [];
        disposers = [];
        invoke.mockReset();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        vi.stubGlobal('Image', class {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            naturalWidth = 640;
            naturalHeight = 480;
            set src(_value: string) { queueMicrotask(() => this.onload?.()); }
            decode() { return Promise.resolve(); }
        });
        let blob = 0;
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:prime-${serial}-${++blob}`);
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        invoke.mockImplementation((command: string) => {
            if (command === 'get_pdf_viewer_bootstrap') return Promise.resolve({
                numPages: 2, widthPt: 612, heightPt: 792,
                fileIdentity: token, viewerEngineMode: 'ppe-only',
            });
            if (command === 'get_current_display_metrics') return Promise.resolve({ rawDpiX: 96 });
            if (command === 'render_ppe_page') return new Promise<ArrayBuffer>((resolve, reject) => {
                requests.push({ resolve, reject });
            });
            return Promise.resolve(false);
        });
    });
    afterEach(() => {
        for (const frame of frames) releaseViewerFirstFrame(frame);
        for (const dispose of disposers) dispose();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('hai object File cùng identity chỉ gửi một request; báo pending/ready đúng token', async () => {
        const listener = vi.fn();
        const foreign = vi.fn();
        disposers.push(subscribeViewerFirstFrame(path.toLowerCase(), listener));
        disposers.push(subscribeViewerFirstFrame('D:\\other.pdf', foreign));
        const first = primeViewerFirstFrame(file());
        expect(primeViewerFirstFrame(file())).toBe(first);
        await expectRequests(1);
        expect(isViewerFirstFramePending(path, token)).toBe(true);
        expect(isViewerFirstFramePending(path, '4:101:100')).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);
        const frame = await finish(first, 0);
        expect(peekViewerFirstFrame(path, token)).toBe(frame);
        expect(isViewerFirstFramePending(path, token)).toBe(false);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(foreign).not.toHaveBeenCalled();
        expect(primeViewerFirstFrame(file())).toBe(first);
    });

    it('adopt nhả promise cũ, mở lại cùng file không nhận Blob đã chuyển quyền', async () => {
        const first = primeViewerFirstFrame(file());
        await expectRequests(1);
        const frame = (await finish(first, 0))!;
        adoptViewerFirstFrame(frame);
        expect(peekViewerFirstFrame(path, token)).toBeNull();
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(frame.url);
        const reopened = primeViewerFirstFrame(file());
        expect(reopened).not.toBe(first);
        await expectRequests(2);
        const next = (await finish(reopened, 1))!;
        expect(next.url).not.toBe(frame.url);
        releaseViewerFirstFrame(frame); // Cleanup frame cũ không được xóa frame mới.
        expect(peekViewerFirstFrame(path, token)).toBe(next);
    });

    it('prime thất bại mở lại cổng và cho phép thử lại cùng file', async () => {
        const first = primeViewerFirstFrame(file());
        await expectRequests(1);
        requests[0].reject(new Error('Lỗi render thử nghiệm'));
        expect(await first).toBeNull();
        expect(isViewerFirstFramePending(path, token)).toBe(false);
        const retry = primeViewerFirstFrame(file());
        expect(retry).not.toBe(first);
        await expectRequests(2);
        expect(await finish(retry, 1)).not.toBeNull();
    });

    it('save-over: request revision cũ xong muộn không đè snapshot mới', async () => {
        const oldToken = token;
        const older = primeViewerFirstFrame(file(1));
        await expectRequests(1);
        token = '4:200:100';
        const newer = primeViewerFirstFrame(file(2));
        await expectRequests(2);
        expect(isViewerFirstFramePending(path, oldToken)).toBe(false);
        expect(isViewerFirstFramePending(path, token)).toBe(true);
        const current = await finish(newer, 1);
        expect(await finish(older, 0)).toBeNull();
        expect(peekViewerFirstFrame(path, token)).toBe(current);
        expect(peekViewerFirstFrame(path, oldToken)).toBeNull();
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    });

    it('frame không được nhận hết TTL phải nhả cả Blob lẫn promise để mở lại', async () => {
        vi.useFakeTimers();
        const first = primeViewerFirstFrame(file());
        await expectRequests(1);
        const frame = (await finish(first, 0))!;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(peekViewerFirstFrame(path, token)).toBeNull();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(frame.url);
        const reopened = primeViewerFirstFrame(file());
        expect(reopened).not.toBe(first);
        await expectRequests(2);
        expect(await finish(reopened, 1)).not.toBeNull();
    });
});
