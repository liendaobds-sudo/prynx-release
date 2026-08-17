import { describe, expect, it, vi } from 'vitest';
import {
    createWorkingArtifactController,
    createWorkingArtifactProcessContext,
} from './workingArtifact';
import { createPlaybackPublisher } from './playbackPublisher';
import { runRecipe, type RecipeRunner } from './PlaybackRunner';
import { PROCESS_COMPLETED } from '../processHandlers';
import type { ProcessContext } from '../processHandlers';
import { createRecipe, type RecipeStep } from './recipeTypes';

/**
 * §TEST.1 (audit 2026-08-17): dựng đúng cách playRecipe compose
 * runRecipe + WorkingArtifactController + playbackPublisher, KHÔNG cần ImpositionTab.
 * Kiểm: output bước N là input bước N+1; publisher chỉ giữ một blob URL trung gian
 * (§PLAY.14); revision cuối đúng.
 */
function baseContext(): ProcessContext {
    return {
        file: new File([new Uint8Array([0])], 'base.pdf', { type: 'application/pdf' }),
        commitWorkingFile: vi.fn(),
        setError: vi.fn(),
        setIsProcessing: vi.fn(),
        setProcessStatus: vi.fn(),
        setReportMsg: vi.fn(),
        setBatchOutput: vi.fn(),
        getWorkingBytes: vi.fn(async () => new Uint8Array([0])),
        getWorkingSourcePath: vi.fn(async () => undefined),
    };
}

const step = (opId: RecipeStep['opId']): RecipeStep => ({ opId, label: opId, params: {}, recordable: true });

describe('Playback chain integration — §TEST.1 / §PLAY.13-14', () => {
    it('output bước N là input bước N+1 và publisher chỉ giữ một blob URL', async () => {
        // Controller khởi tạo từ bytes gốc [0].
        const controller = createWorkingArtifactController(
            { kind: 'bytes', name: 'base.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([0]) },
            { readPath: async () => new Uint8Array() },
        );

        const created: string[] = [];
        const revoked: string[] = [];
        let seq = 0;
        const revisions: string[] = [];
        const publisher = createPlaybackPublisher({
            createObjectUrl: () => { const u = `blob:${++seq}`; created.push(u); return u; },
            revokeObjectUrl: (u) => revoked.push(u),
            localFileUrl: (p) => `localfile://${p}`,
            onRevision: (r) => revisions.push(r.name),
        });

        const base = baseContext();
        const seenInputs: number[][] = [];

        // Runner "cộng 1 byte": đọc working bytes hiện tại, commit bytes mới.
        const bumpRunner: RecipeRunner = async (ctx) => {
            const bytes = await ctx.getWorkingBytes();
            seenInputs.push([...bytes]);
            const next = new Uint8Array([...bytes, bytes.length]);
            await ctx.commitWorkingFile(new Blob([next], { type: 'application/pdf' }), `step-${bytes.length}.pdf`);
            return PROCESS_COMPLETED;
        };

        const recipe = createRecipe('chain', [step('convertcolors'), step('hairlines'), step('optimize')]);

        const res = await runRecipe(recipe, {
            buildContext: () => createWorkingArtifactProcessContext(base, controller, publisher.publish),
            runners: { convertcolors: bumpRunner, hairlines: bumpRunner, optimize: bumpRunner },
        });

        expect(res.ok).toBe(true);
        expect(res.completed).toBe(3);
        // Chuỗi: bước 1 thấy [0]; bước 2 thấy [0,1]; bước 3 thấy [0,1,2].
        expect(seenInputs).toEqual([[0], [0, 1], [0, 1, 2]]);
        // 3 blob URL tạo, 2 cái trung gian bị thu hồi, cái cuối còn sống (§PLAY.14).
        expect(created).toHaveLength(3);
        expect(revoked).toEqual([created[0], created[1]]);
        expect(publisher.currentObjectUrl).toBe(created[2]);
        expect(revisions).toEqual(['step-1.pdf', 'step-2.pdf', 'step-3.pdf']);
    });

    it('commit path native thu hồi blob URL trung gian và bước sau đọc đúng bytes từ path', async () => {
        const controller = createWorkingArtifactController(
            { kind: 'bytes', name: 'base.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1]) },
            { readPath: async () => new Uint8Array([9, 9, 9]) }, // path đọc ra bytes [9,9,9]
        );
        const created: string[] = [];
        const revoked: string[] = [];
        let seq = 0;
        const publisher = createPlaybackPublisher({
            createObjectUrl: () => { const u = `blob:${++seq}`; created.push(u); return u; },
            revokeObjectUrl: (u) => revoked.push(u),
            localFileUrl: (p) => `localfile://${p}`,
            onRevision: () => undefined,
        });
        const base = baseContext();

        const blobRunner: RecipeRunner = async (ctx) => {
            await ctx.commitWorkingFile(new Blob([new Uint8Array([2])], { type: 'application/pdf' }), 'b.pdf');
            return PROCESS_COMPLETED;
        };
        // Runner native: commit kèm existingPath → controller chuyển sang revision path.
        const nativeRunner: RecipeRunner = async (ctx) => {
            await ctx.commitWorkingFile(new Blob([], { type: 'application/pdf' }), 'n.pdf', 'D:\\out\\n.pdf');
            return PROCESS_COMPLETED;
        };
        let lastSeen: number[] = [];
        const readerRunner: RecipeRunner = async (ctx) => {
            lastSeen = [...(await ctx.getWorkingBytes())];
            await ctx.commitWorkingFile(new Blob([new Uint8Array([3])], { type: 'application/pdf' }), 'r.pdf');
            return PROCESS_COMPLETED;
        };

        const recipe = createRecipe('chain2', [step('convertcolors'), step('nup'), step('optimize')]);
        const res = await runRecipe(recipe, {
            buildContext: () => createWorkingArtifactProcessContext(base, controller, publisher.publish),
            runners: { convertcolors: blobRunner, nup: nativeRunner, optimize: readerRunner },
        });

        expect(res.ok).toBe(true);
        // Sau commit path native, blob URL trung gian đầu tiên bị thu hồi.
        expect(revoked).toContain(created[0]);
        // Bước sau đọc bytes materialize TỪ path (không phải carrier rỗng của bước native).
        expect(lastSeen).toEqual([9, 9, 9]);
    });
});
