import { describe, expect, it, vi } from 'vitest';
import { SupersededTileRenderError, TileRenderScheduler } from './tileRenderScheduler';
import {
    RenderCoordinator,
    getRenderDocumentIdentity,
    registerRenderDocumentIdentity,
    renderDocumentIdentity,
    type RenderCoordinatorRequest,
    type RenderCoordinatorRequestInput,
} from './renderCoordinator';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(accept => { resolve = accept; });
    return { promise, resolve };
}

function requestInput(overrides: Partial<RenderCoordinatorRequestInput> = {}): RenderCoordinatorRequestInput {
    return {
        ownerId: 'viewer:tab-a:1',
        groupKey: 'page:1:page',
        generationKey: 'frame-a',
        purpose: 'interactive',
        priority: 10,
        document: renderDocumentIdentity(
            'D:\\jobs\\sample.pdf',
            null,
            '90071992547409931:1777777777777777777:1666666666666666666',
        ),
        page: 1,
        rotation: 0,
        raster: { kind: 'scale', scale: 1.25, clip: null },
        color: { pipeline: 'display', profileId: null, intent: null },
        pipelineIdentity: 'pdfium-display-png-v1',
        soundness: 'display-preview',
        ...overrides,
    };
}

function immediateScheduler() {
    return {
        enqueue: async (task: { run: () => Promise<ArrayBuffer> }) => task.run(),
        cancelOwner: vi.fn(),
        cancelGroup: vi.fn(),
    };
}

describe('RenderCoordinator — contract và vòng đời bitmap', () => {
    it('giữ identity nanosecond dạng chuỗi và thay token khi file cùng path bị ghi đè', () => {
        const path = 'D:\\jobs\\same-path.pdf';
        registerRenderDocumentIdentity(path, '10:20:30');
        expect(getRenderDocumentIdentity(path, null)).toMatchObject({
            sizeBytes: '10',
            modifiedNanos: '20',
            createdNanos: '30',
            token: '10:20:30',
        });

        registerRenderDocumentIdentity(path, '11:21:31');
        expect(getRenderDocumentIdentity(path, null).token).toBe('11:21:31');
    });

    it('đo queue/wait/decode nhưng không bịa render/encode chưa có trong raw IPC', async () => {
        let now = 0;
        const report = vi.fn();
        let capturedRequest!: RenderCoordinatorRequest;
        const coordinator = new RenderCoordinator({
            scheduler: immediateScheduler(),
            now: () => now,
            report,
        });

        const source = await coordinator.renderPng({
            request: requestInput(),
            render: async request => {
                capturedRequest = request;
                now = 20;
                return new Uint8Array([137, 80, 78, 71]).buffer;
            },
            encode: bytes => {
                now = 23;
                return { url: 'blob:contract', byteLength: bytes.byteLength };
            },
        });
        now = 25;
        coordinator.markDecodeStarted(source);
        now = 32;
        coordinator.markDecoded(source, { width: 1200, height: 800, current: true });

        expect(capturedRequest).toMatchObject({
            protocolVersion: 1,
            ownerId: 'viewer:tab-a:1',
            generation: 1,
            purpose: 'interactive',
            page: 1,
            rotation: 0,
            raster: { kind: 'scale', scale: 1.25, clip: null },
            color: { pipeline: 'display', profileId: null, intent: null },
        });
        expect(capturedRequest.requestId).toBeTruthy();
        expect(report).toHaveBeenCalledWith('result', expect.objectContaining({
            status: 'ready',
            queue_ms: 0,
            wait_ms: 20,
            render_ms: null,
            encode_ms: null,
            source_ms: 3,
            decode_ms: 7,
            bitmap_width: 1200,
            bitmap_height: 800,
        }));
    });

    it('resultKey chỉ phụ thuộc pixel kết quả và tách đúng identity/color/clip x=0', async () => {
        const captured: RenderCoordinatorRequest[] = [];
        const renderOnce = async (input: RenderCoordinatorRequestInput) => {
            const coordinator = new RenderCoordinator({ scheduler: immediateScheduler() });
            await coordinator.renderPng({
                request: input,
                render: async request => {
                    captured.push(request);
                    return new ArrayBuffer(1);
                },
                encode: () => ({ url: `blob:${captured.length}`, byteLength: 1 }),
            });
            return captured.at(-1)!;
        };

        const base = await renderOnce(requestInput());
        const otherOwner = await renderOnce(requestInput({
            ownerId: 'viewer:tab-b:9',
            purpose: 'background',
            priority: 900,
        }));
        const replacedFile = await renderOnce(requestInput({
            document: renderDocumentIdentity('D:\\jobs\\sample.pdf', null, '2:3:4'),
        }));
        const accurate = await renderOnce(requestInput({
            raster: { kind: 'dpi', dpi: 120, clip: null },
            color: { pipeline: 'accurate', profileId: 'fogra39', intent: 'relative' },
            pipelineIdentity: 'ppe-fogra39-relative-png-v2-soundness',
            soundness: 'color-verified',
        }));
        const swopAccurate = await renderOnce(requestInput({
            raster: { kind: 'dpi', dpi: 120, clip: null },
            color: { pipeline: 'accurate', profileId: 'swop', intent: 'perceptual' },
            pipelineIdentity: 'ppe-swop-perceptual-view-knockout-png-v5-backend',
            soundness: 'color-verified',
        }));
        const topLeftTile = await renderOnce(requestInput({
            raster: { kind: 'scale', scale: 1.25, clip: { x: 0, y: 0, width: 400, height: 300 } },
        }));

        expect(otherOwner.resultKey).toBe(base.resultKey);
        expect(otherOwner.requestKey).not.toBe(base.requestKey);
        expect(replacedFile.resultKey).not.toBe(base.resultKey);
        expect(accurate.resultKey).not.toBe(base.resultKey);
        expect(swopAccurate.resultKey).not.toBe(accurate.resultKey);
        expect(topLeftTile.resultKey).not.toBe(base.resultKey);
    });

    it('dùng chung request vật lý giống hệt nhưng không tạo Blob cho generation cũ', async () => {
        let now = 0;
        const report = vi.fn();
        const scheduler = new TileRenderScheduler<ArrayBuffer>();
        const coordinator = new RenderCoordinator({ scheduler, now: () => now, report });
        const gate = deferred<ArrayBuffer>();
        const oldEncode = vi.fn(() => ({ url: 'blob:old', byteLength: 1 }));
        const newEncode = vi.fn(() => ({ url: 'blob:new', byteLength: 1 }));

        const oldOutcome = coordinator.renderPng({
            request: requestInput({ generationKey: 'frame-old', priority: 100 }),
            render: () => gate.promise,
            encode: oldEncode,
        }).catch(error => error);
        await Promise.resolve();
        await Promise.resolve();

        now = 10;
        const newest = coordinator.renderPng({
            request: requestInput({ generationKey: 'frame-new', priority: 100 }),
            render: vi.fn(async () => new ArrayBuffer(1)),
            encode: newEncode,
        });
        now = 30;
        gate.resolve(new ArrayBuffer(1));

        const [oldError, newestSource] = await Promise.all([oldOutcome, newest]);
        expect(oldError).toBeInstanceOf(SupersededTileRenderError);
        expect(oldEncode).not.toHaveBeenCalled();
        expect(newEncode).toHaveBeenCalledTimes(1);
        expect(newestSource.url).toBe('blob:new');
        expect(report).toHaveBeenCalledWith('stale-work', expect.objectContaining({
            generation: 1,
            stale_ms: 20,
        }));
    });

    it('gửi cancel vật lý đúng request đang chạy khi pixel mục tiêu đã đổi', async () => {
        let now = 0;
        const scheduler = new TileRenderScheduler<ArrayBuffer>();
        const cancelPhysical = vi.fn();
        const coordinator = new RenderCoordinator({
            scheduler,
            now: () => now,
            report: vi.fn(),
            cancelPhysical,
        });
        const gate = deferred<ArrayBuffer>();
        const oldOutcome = coordinator.renderPng({
            request: requestInput({ generationKey: 'zoom-100', priority: 100 }),
            render: () => gate.promise,
            encode: () => ({ url: 'blob:zoom-100', byteLength: 1 }),
        }).catch(error => error);
        await Promise.resolve();
        await Promise.resolve();

        now = 5;
        const newest = coordinator.renderPng({
            request: requestInput({
                generationKey: 'zoom-200',
                priority: 100,
                raster: { kind: 'scale', scale: 2, clip: null },
            }),
            render: async () => new ArrayBuffer(1),
            encode: () => ({ url: 'blob:zoom-200', byteLength: 1 }),
        });
        expect(cancelPhysical).toHaveBeenCalledTimes(1);
        expect(cancelPhysical).toHaveBeenCalledWith(expect.objectContaining({
            generation: 1,
            raster: { kind: 'scale', scale: 1.25, clip: null },
        }));

        gate.resolve(new ArrayBuffer(1));
        await expect(oldOutcome).resolves.toBeInstanceOf(SupersededTileRenderError);
        await expect(newest).resolves.toMatchObject({ url: 'blob:zoom-200' });
    });

    it('đánh dấu stale nếu generation đổi trong lúc trình duyệt đang decode', async () => {
        let now = 0;
        const report = vi.fn();
        const coordinator = new RenderCoordinator({
            scheduler: immediateScheduler(),
            now: () => now,
            report,
        });
        const first = await coordinator.renderPng({
            request: requestInput({ generationKey: 'decode-old' }),
            render: async () => new ArrayBuffer(1),
            encode: () => ({ url: 'blob:decode-old', byteLength: 1 }),
        });
        coordinator.markDecodeStarted(first);

        now = 5;
        await coordinator.renderPng({
            request: requestInput({ generationKey: 'decode-new' }),
            render: async () => new ArrayBuffer(1),
            encode: () => ({ url: 'blob:decode-new', byteLength: 1 }),
        });
        now = 17;
        expect(coordinator.isSourceCurrent(first)).toBe(false);
        coordinator.markDecoded(first, { width: 100, height: 100, current: true });

        expect(report).toHaveBeenCalledWith('result', expect.objectContaining({
            generation: 1,
            status: 'stale',
            decode_ms: 17,
            stale_ms: 12,
        }));
    });
});
