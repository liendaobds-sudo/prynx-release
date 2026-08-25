import { describe, expect, it, vi } from 'vitest';
import {
    createWorkingArtifactController,
    createWorkingArtifactProcessContext,
    resolveInitialWorkingArtifact,
} from './workingArtifact';
import type { ProcessContext } from '../processHandlers';
import { runRecipe } from './PlaybackRunner';
import { createRecipe, type RecipeStep } from './recipeTypes';
import { readArtifactLeaseToken, tagArtifactLeaseToken } from '../artifactLease';

function makeContext(): ProcessContext {
    return {
        file: new File([new Uint8Array([0])], 'base.pdf', { type: 'application/pdf' }),
        commitWorkingFile: vi.fn(),
        setError: vi.fn(),
        setIsProcessing: vi.fn(),
        setProcessStatus: vi.fn(),
        setReportMsg: vi.fn(),
        setBatchOutput: vi.fn(),
        getWorkingBytes: vi.fn(async () => new Uint8Array([0])),
        getWorkingSourcePath: vi.fn(async () => 'D:\\jobs\\base.pdf'),
    };
}

function recipeStep(opId: RecipeStep['opId']): RecipeStep {
    return { opId, label: opId, params: {}, recordable: true };
}

const LEASE_A = 'a'.repeat(64);
const LEASE_B = 'b'.repeat(64);

describe('WorkingArtifact — chuỗi nguồn phát Recipe', () => {
    it('khởi tạo từ Working bytes và fail-closed khi materialize lỗi', async () => {
        const backingFile = new File([new Uint8Array([99])], 'backing.pdf', {
            type: 'application/pdf',
        });
        const backingRead = vi.spyOn(backingFile, 'arrayBuffer');
        const materializeError = new Error('Không materialize được revision');

        await expect(resolveInitialWorkingArtifact({
            getWorkingSourcePath: vi.fn(async () => undefined),
            getWorkingBytes: vi.fn(async () => { throw materializeError; }),
        }, backingFile)).rejects.toBe(materializeError);

        expect(backingRead).not.toHaveBeenCalled();
    });

    it('path native lỗi vẫn được phép materialize bytes của cùng revision', async () => {
        const workingBytes = new Uint8Array([7, 8, 9]);
        const artifact = await resolveInitialWorkingArtifact({
            getWorkingSourcePath: vi.fn(async () => { throw new Error('path unavailable'); }),
            getWorkingBytes: vi.fn(async () => workingBytes),
        }, new File([], 'working.pdf', { type: 'application/pdf' }));

        expect(artifact).toEqual({
            kind: 'bytes',
            name: 'working.pdf',
            mimeType: 'application/pdf',
            bytes: workingBytes,
        });
    });

    it('giữ lease token qua initial bytes, commit bytes và facade của bước kế', async () => {
        const source = tagArtifactLeaseToken(
            new File([new Uint8Array([1])], 'working.pdf', { type: 'application/pdf' }),
            LEASE_A,
        );
        const initial = await resolveInitialWorkingArtifact({
            getWorkingSourcePath: vi.fn(async () => undefined),
            getWorkingBytes: vi.fn(async () => new Uint8Array([1])),
        }, source);
        const controller = createWorkingArtifactController(initial, {
            readPath: vi.fn(),
        });

        expect(readArtifactLeaseToken(controller.toFile())).toBe(LEASE_A);

        const output = tagArtifactLeaseToken(
            new Blob([new Uint8Array([2])], { type: 'application/pdf' }),
            LEASE_B,
        );
        await controller.commit(output, 'step-1.pdf', undefined, async () => undefined);

        const nextContext = createWorkingArtifactProcessContext(
            makeContext(),
            controller,
            vi.fn(),
        );
        expect(readArtifactLeaseToken(controller.toFile())).toBe(LEASE_B);
        expect(readArtifactLeaseToken(nextContext.file)).toBe(LEASE_B);
    });

    it('giữ lease token trên path-backed sentinel khi carrier không chứa bytes PDF', async () => {
        const controller = createWorkingArtifactController({
            kind: 'bytes',
            name: 'input.pdf',
            mimeType: 'application/pdf',
            bytes: new Uint8Array([1]),
        }, { readPath: vi.fn() });
        const carrier = tagArtifactLeaseToken(
            new Blob([], { type: 'application/pdf' }),
            LEASE_A,
        );

        await controller.commit(
            carrier,
            'nup.pdf',
            'D:\\results\\nup.pdf',
            async () => undefined,
        );

        const nextFile = controller.toFile() as File & { path?: string };
        expect(nextFile.path).toBe('D:\\results\\nup.pdf');
        expect(nextFile.size).toBe(Number.MAX_SAFE_INTEGER);
        expect(readArtifactLeaseToken(nextFile)).toBe(LEASE_A);
    });

    it('giữ native path làm nguồn chân lý và không đọc carrier 0 byte', async () => {
        const readPath = vi.fn(async () => new Uint8Array([8, 9]));
        const statPath = vi.fn(async () => 987_654);
        const controller = createWorkingArtifactController({
            kind: 'path',
            name: 'input.pdf',
            mimeType: 'application/pdf',
            path: 'D:\\jobs\\input.pdf',
            size: 123,
        }, { readPath, statPath });

        const carrier = new Blob([], { type: 'application/pdf' });
        const carrierRead = vi.spyOn(carrier, 'arrayBuffer');
        const publish = vi.fn(async () => undefined);

        await controller.commit(
            carrier,
            'Imposed_input.pdf',
            'D:\\results\\imposed.pdf',
            publish,
        );

        expect(publish).toHaveBeenCalledWith(
            carrier,
            'Imposed_input.pdf',
            'D:\\results\\imposed.pdf',
        );
        expect(carrierRead).not.toHaveBeenCalled();
        expect(controller.current).toEqual({
            kind: 'path',
            name: 'Imposed_input.pdf',
            mimeType: 'application/pdf',
            path: 'D:\\results\\imposed.pdf',
            size: 987_654,
        });
        expect(await controller.getSourcePath()).toBe('D:\\results\\imposed.pdf');

        const nextFile = controller.toFile() as File & { path?: string };
        expect(nextFile.name).toBe('Imposed_input.pdf');
        expect(nextFile.path).toBe('D:\\results\\imposed.pdf');
        expect(nextFile.size).toBe(987_654);
    });

    it('đọc bytes lười từ đúng path mới, không quay lại path ban đầu', async () => {
        const readPath = vi.fn(async artifact => (
            artifact.path.endsWith('step-1.pdf')
                ? new Uint8Array([1, 1, 1])
                : new Uint8Array([9])
        ));
        const controller = createWorkingArtifactController({
            kind: 'path',
            name: 'input.pdf',
            mimeType: 'application/pdf',
            path: 'D:\\jobs\\input.pdf',
            size: 500_000_000,
        }, { readPath });

        expect(readPath).not.toHaveBeenCalled();
        await controller.commit(
            new Blob(['native-path'], { type: 'application/pdf' }),
            'step-1.pdf',
            'D:\\results\\step-1.pdf',
            async () => undefined,
        );

        expect(await controller.getBytes()).toEqual(new Uint8Array([1, 1, 1]));
        expect(await controller.getBytes()).toEqual(new Uint8Array([1, 1, 1]));
        expect(readPath).toHaveBeenCalledTimes(1);
        expect(readPath).toHaveBeenCalledWith(expect.objectContaining({
            path: 'D:\\results\\step-1.pdf',
        }));
    });

    it('commit bytes thật xóa path cũ để bước sau không đọc lại file gốc', async () => {
        const controller = createWorkingArtifactController({
            kind: 'path',
            name: 'input.pdf',
            mimeType: 'application/pdf',
            path: 'D:\\jobs\\input.pdf',
            size: 123,
        }, { readPath: vi.fn() });
        const output = new Uint8Array([3, 4, 5]);

        await controller.commit(
            new Blob([output], { type: 'application/pdf' }),
            'converted.pdf',
            undefined,
            async () => undefined,
        );

        expect(await controller.getSourcePath()).toBeUndefined();
        expect(await controller.getBytes()).toEqual(output);
        expect(controller.current.kind).toBe('bytes');
        expect((controller.toFile() as File & { path?: string }).path).toBeUndefined();
    });

    it('facade truyền đủ path commit và bước kế nhận đúng path mới', async () => {
        const publish = vi.fn(async () => undefined);
        const controller = createWorkingArtifactController({
            kind: 'path',
            name: 'input.pdf',
            mimeType: 'application/pdf',
            path: 'D:\\jobs\\input.pdf',
            size: 500_000_000,
        }, {
            readPath: vi.fn(async () => new Uint8Array([4])),
            statPath: vi.fn(async () => 600_000_000),
        });

        const first = createWorkingArtifactProcessContext(makeContext(), controller, publish);
        const carrier = new Blob(['native-path'], { type: 'application/pdf' });
        await first.commitWorkingFile(carrier, 'step-1.pdf', 'D:\\results\\step-1.pdf');

        const second = createWorkingArtifactProcessContext(makeContext(), controller, publish);
        expect(publish).toHaveBeenCalledWith(
            carrier,
            'step-1.pdf',
            'D:\\results\\step-1.pdf',
        );
        expect(await second.getWorkingSourcePath?.()).toBe('D:\\results\\step-1.pdf');
        expect((second.file as File & { path?: string }).path).toBe('D:\\results\\step-1.pdf');
        expect(second.file.size).toBe(600_000_000);
    });

    it('stat path lỗi dùng size bảo thủ để không chọn nhánh đọc PDF lớn', async () => {
        const controller = createWorkingArtifactController({
            kind: 'bytes',
            name: 'input.pdf',
            mimeType: 'application/pdf',
            bytes: new Uint8Array([1]),
        }, {
            readPath: vi.fn(),
            statPath: vi.fn(async () => { throw new Error('stat failed'); }),
        });

        await controller.commit(
            new Blob([], { type: 'application/pdf' }),
            'native.pdf',
            'D:\\results\\native.pdf',
            async () => undefined,
        );

        expect(controller.toFile().size).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('publisher lỗi thì giữ nguyên revision trước đó', async () => {
        const initial = {
            kind: 'bytes' as const,
            name: 'input.pdf',
            mimeType: 'application/pdf',
            bytes: new Uint8Array([7]),
        };
        const controller = createWorkingArtifactController(initial, {
            readPath: vi.fn(),
        });

        await expect(controller.commit(
            new Blob([new Uint8Array([8])], { type: 'application/pdf' }),
            'broken.pdf',
            undefined,
            async () => { throw new Error('publish failed'); },
        )).rejects.toThrow('publish failed');

        expect(controller.current).toBe(initial);
        expect(await controller.getBytes()).toEqual(new Uint8Array([7]));
    });

    it('runRecipe truyền path/bytes đúng revision qua từng bước', async () => {
        const readPath = vi.fn(async artifact => {
            if (artifact.path === 'D:\\results\\nup.pdf') return new Uint8Array([2, 2]);
            throw new Error(`Đọc nhầm path: ${artifact.path}`);
        });
        const publish = vi.fn(async () => undefined);
        const controller = createWorkingArtifactController({
            kind: 'path',
            name: 'input.pdf',
            mimeType: 'application/pdf',
            path: 'D:\\jobs\\input.pdf',
            size: 500_000_000,
        }, { readPath, statPath: vi.fn(async () => 600_000_000) });
        const events: string[] = [];

        const result = await runRecipe(createRecipe('chain', [
            recipeStep('nup'),
            recipeStep('optimize'),
            recipeStep('resize'),
        ]), {
            buildContext: () => createWorkingArtifactProcessContext(
                makeContext(),
                controller,
                publish,
            ),
            runners: {
                nup: async (ctx) => {
                    events.push(`nup:${await ctx.getWorkingSourcePath?.()}`);
                    await ctx.commitWorkingFile(
                        new Blob(['native-path'], { type: 'application/pdf' }),
                        'nup.pdf',
                        'D:\\results\\nup.pdf',
                    );
                    return { status: 'completed' };
                },
                optimize: async (ctx) => {
                    events.push(`optimize:${Array.from(await ctx.getWorkingBytes()).join(',')}`);
                    await ctx.commitWorkingFile(
                        new Blob([new Uint8Array([3, 3, 3])], { type: 'application/pdf' }),
                        'optimized.pdf',
                    );
                    return { status: 'completed' };
                },
                resize: async (ctx) => {
                    events.push(`resize-path:${await ctx.getWorkingSourcePath?.()}`);
                    events.push(`resize-bytes:${Array.from(await ctx.getWorkingBytes()).join(',')}`);
                    return { status: 'completed' };
                },
            },
        });

        expect(result.status).toBe('completed');
        expect(events).toEqual([
            'nup:D:\\jobs\\input.pdf',
            'optimize:2,2',
            'resize-path:undefined',
            'resize-bytes:3,3,3',
        ]);
        expect(readPath).toHaveBeenCalledTimes(1);
    });

    it('runRecipe không chạy bước kế trước khi publisher hoàn tất', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const publish = vi.fn(() => gate);
        const controller = createWorkingArtifactController({
            kind: 'bytes',
            name: 'input.pdf',
            mimeType: 'application/pdf',
            bytes: new Uint8Array([1]),
        }, { readPath: vi.fn() });
        const second = vi.fn(async () => ({ status: 'completed' } as const));

        const pending = runRecipe(createRecipe('chain', [
            recipeStep('optimize'),
            recipeStep('resize'),
        ]), {
            buildContext: () => createWorkingArtifactProcessContext(
                makeContext(),
                controller,
                publish,
            ),
            runners: {
                optimize: async (ctx) => {
                    await ctx.commitWorkingFile(
                        new Blob([new Uint8Array([2])], { type: 'application/pdf' }),
                        'optimized.pdf',
                    );
                    return { status: 'completed' };
                },
                resize: second,
            },
        });

        await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
        expect(second).not.toHaveBeenCalled();
        release();
        await expect(pending).resolves.toMatchObject({ status: 'completed', completed: 2 });
        expect(second).toHaveBeenCalledOnce();
    });
});
