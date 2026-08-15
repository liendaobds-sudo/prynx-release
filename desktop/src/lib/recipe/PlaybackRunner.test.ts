import { describe, it, expect, vi } from 'vitest';
import { runRecipe, type PlaybackDeps, type RecipeRunner } from './PlaybackRunner';
import { createRecipe, type RecipeStep } from './recipeTypes';
import type { ProcessContext } from '../processHandlers';

// ─── ProcessContext giả lập tối thiểu ───
function makeCtx(overrides: Partial<ProcessContext> = {}): ProcessContext {
    return {
        file: new File([new Uint8Array([1])], 'in.pdf', { type: 'application/pdf' }),
        commitWorkingFile: vi.fn(),
        setError: vi.fn(),
        setIsProcessing: vi.fn(),
        setProcessStatus: vi.fn(),
        setReportMsg: vi.fn(),
        setBatchOutput: vi.fn(),
        getWorkingBytes: async () => new Uint8Array([1]),
        ...overrides,
    };
}

function step(opId: RecipeStep['opId'], extra: Partial<RecipeStep> = {}): RecipeStep {
    return { opId, label: opId, params: {}, recordable: true, ...extra };
}

function baseDeps(over: Partial<PlaybackDeps> = {}): PlaybackDeps {
    return {
        buildContext: () => makeCtx(),
        runners: {},
        ...over,
    };
}

const completed = () => ({ status: 'completed' } as const);

describe('PlaybackRunner — thứ tự & tuyến tính (P2/P3/P4)', () => {
    it('gọi runner theo đúng thứ tự steps', async () => {
        const calls: string[] = [];
        const mk = (id: string): RecipeRunner => async () => {
            calls.push(id);
            return completed();
        };
        const recipe = createRecipe('R', [step('convertcolors'), step('booklet'), step('optimize')]);
        const res = await runRecipe(recipe, baseDeps({
            runners: { convertcolors: mk('convertcolors'), booklet: mk('booklet'), optimize: mk('optimize') },
        }));
        expect(calls).toEqual(['convertcolors', 'booklet', 'optimize']);
        expect(res.ok).toBe(true);
        expect(res.completed).toBe(3);
    });

    it('ép onSpawnTab=undefined trong ctx truyền cho runner (P3)', async () => {
        let seenSpawn: unknown = 'unset';
        const recipe = createRecipe('R', [step('booklet')]);
        await runRecipe(recipe, baseDeps({
            buildContext: () => makeCtx({ onSpawnTab: vi.fn() }),
            runners: { booklet: async (ctx) => { seenSpawn = ctx.onSpawnTab; return completed(); } },
        }));
        expect(seenSpawn).toBeUndefined();
    });

    it('await tuần tự: bước kế chỉ bắt đầu sau khi bước trước resolve (P4)', async () => {
        const events: string[] = [];
        const slow: RecipeRunner = async () => {
            events.push('start-A');
            await new Promise(r => setTimeout(r, 20));
            events.push('end-A');
            return completed();
        };
        const fast: RecipeRunner = async () => { events.push('start-B'); return completed(); };
        const recipe = createRecipe('R', [step('booklet'), step('optimize')]);
        await runRecipe(recipe, baseDeps({ runners: { booklet: slow, optimize: fast } }));
        expect(events).toEqual(['start-A', 'end-A', 'start-B']);
    });
});

describe('PlaybackRunner — lọc an toàn (P6/P7)', () => {
    it('bỏ qua step recordable=false + cảnh báo', async () => {
        const onWarn = vi.fn();
        const runner = vi.fn(async () => completed());
        const recipe = createRecipe('R', [
            step('crop', { recordable: false }),
            step('booklet'),
        ]);
        const res = await runRecipe(recipe, baseDeps({ runners: { booklet: runner, crop: runner }, onWarn }));
        expect(runner).toHaveBeenCalledTimes(1); // chỉ booklet chạy
        expect(res.skipped).toBe(1);
        expect(res.skippedSteps[0].reason).toBe('non_recordable');
        expect(onWarn).toHaveBeenCalledWith(expect.objectContaining({ opId: 'crop' }), 'non_recordable');
    });

    it('step cần input ngoài: gọi requestExternalInput; thiếu input → bỏ qua', async () => {
        const runner = vi.fn(async () => completed());
        const recipe = createRecipe('R', [step('merge', { needsExternalInput: 'file' })]);
        const res = await runRecipe(recipe, baseDeps({
            runners: { merge: runner },
            requestExternalInput: async () => null, // người dùng hủy
        }));
        expect(runner).not.toHaveBeenCalled();
        expect(res.skippedSteps[0].reason).toBe('missing_input');
    });

    it('step cần input ngoài: có input → truyền ext vào runner', async () => {
        const f = new File([new Uint8Array([2])], 'b.pdf');
        let seen: unknown = null;
        const recipe = createRecipe('R', [step('merge', { needsExternalInput: 'file' })]);
        await runRecipe(recipe, baseDeps({
            runners: { merge: async (_c, _p, ext) => { seen = ext; return completed(); } },
            requestExternalInput: async () => ({ files: [f] }),
        }));
        expect(seen).toEqual({ files: [f] });
    });

    it('input ngoài đọc lỗi thì trả error, không throw và không chạy runner', async () => {
        const runner = vi.fn(async () => completed());
        const recipe = createRecipe('R', [step('merge', { needsExternalInput: 'file' })]);

        const res = await runRecipe(recipe, baseDeps({
            runners: { merge: runner },
            requestExternalInput: async () => { throw new Error('Không đọc được file ngoài'); },
        }));

        expect(res.status).toBe('error');
        expect(res.failedStep).toMatchObject({ index: 0, error: 'Không đọc được file ngoài' });
        expect(runner).not.toHaveBeenCalled();
    });

    it('hủy hộp chọn input ngoài trả canceled, không biến thành lỗi đỏ', async () => {
        const runner = vi.fn(async () => completed());
        const recipe = createRecipe('R', [step('merge', { needsExternalInput: 'file' })]);

        const res = await runRecipe(recipe, baseDeps({
            runners: { merge: runner },
            requestExternalInput: async () => { throw new DOMException('Đã hủy', 'AbortError'); },
        }));

        expect(res.status).toBe('canceled');
        expect(res.canceledStep?.index).toBe(0);
        expect(res.failedStep).toBeUndefined();
        expect(runner).not.toHaveBeenCalled();
    });

    it('opId không có runner → bỏ qua (unsupported_op)', async () => {
        const recipe = createRecipe('R', [step('ocr')]);
        const res = await runRecipe(recipe, baseDeps({ runners: {} }));
        expect(res.skippedSteps[0].reason).toBe('unsupported_op');
        expect(res.ok).toBe(true);
    });
});

describe('PlaybackRunner — entitlement fail-closed', () => {
    it('kiểm toàn recipe trước mutation đầu tiên', async () => {
        const runner = vi.fn(async () => completed());
        const recipe = createRecipe('R', [step('optimize'), step('booklet')]);
        const res = await runRecipe(recipe, baseDeps({
            runners: { optimize: runner, booklet: runner },
            authorizeStep: (item) => item.opId === 'booklet' ? 'Cần quyền Bình sách' : null,
        }));

        expect(runner).not.toHaveBeenCalled();
        expect(res.ok).toBe(false);
        expect(res.completed).toBe(0);
        expect(res.failedStep?.index).toBe(1);
    });

    it('kiểm lại trước từng runner nếu quyền đổi giữa chuỗi', async () => {
        let revoked = false;
        const first = vi.fn(async () => { revoked = true; return completed(); });
        const second = vi.fn(async () => completed());
        const recipe = createRecipe('R', [step('optimize'), step('booklet')]);
        let preflight = true;
        const res = await runRecipe(recipe, baseDeps({
            runners: { optimize: first, booklet: second },
            authorizeStep: (item) => {
                if (preflight) return null;
                return revoked && item.opId === 'booklet' ? 'Quyền vừa thay đổi' : null;
            },
            onProgress: ({ index }) => { if (index === 0) preflight = false; },
        }));

        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
        expect(res.completed).toBe(1);
        expect(res.failedStep?.error).toContain('thay đổi');
    });
});

describe('PlaybackRunner — dừng sạch khi lỗi (P8)', () => {
    it('runner throw → dừng, các bước kế không chạy', async () => {
        const calls: string[] = [];
        const recipe = createRecipe('R', [step('booklet'), step('optimize')]);
        const res = await runRecipe(recipe, baseDeps({
            runners: {
                booklet: async () => { calls.push('booklet'); throw new Error('boom'); },
                optimize: async () => { calls.push('optimize'); return completed(); },
            },
        }));
        expect(calls).toEqual(['booklet']);
        expect(res.ok).toBe(false);
        expect(res.failedStep?.index).toBe(0);
        expect(res.failedStep?.error).toContain('boom');
    });

    it('runner báo lỗi qua ctx.setError → coi như thất bại, dừng', async () => {
        const calls: string[] = [];
        const recipe = createRecipe('R', [step('booklet'), step('optimize')]);
        const res = await runRecipe(recipe, baseDeps({
            runners: {
                booklet: async (ctx) => { calls.push('booklet'); ctx.setError('Lỗi xử lý'); return completed(); },
                optimize: async () => { calls.push('optimize'); return completed(); },
            },
        }));
        expect(calls).toEqual(['booklet']);
        expect(res.ok).toBe(false);
        expect(res.failedStep?.error).toBe('Lỗi xử lý');
    });

    it('setError("") (xóa lỗi) KHÔNG bị coi là thất bại', async () => {
        const recipe = createRecipe('R', [step('booklet')]);
        const res = await runRecipe(recipe, baseDeps({
            runners: { booklet: async (ctx) => { ctx.setError(''); return completed(); } },
        }));
        expect(res.ok).toBe(true);
        expect(res.completed).toBe(1);
    });

    it('outcome canceled dừng ngay, không tăng completed và không chạy bước kế', async () => {
        const calls: string[] = [];
        const recipe = createRecipe('R', [step('booklet'), step('optimize')]);
        const res = await runRecipe(recipe, baseDeps({
            runners: {
                booklet: async () => {
                    calls.push('booklet');
                    return { status: 'canceled' };
                },
                optimize: async () => {
                    calls.push('optimize');
                    return { status: 'completed' };
                },
            },
        }));

        expect(calls).toEqual(['booklet']);
        expect(res.ok).toBe(false);
        expect(res.status).toBe('canceled');
        expect(res.completed).toBe(0);
        expect(res.canceledStep?.index).toBe(0);
        expect(res.failedStep).toBeUndefined();
    });

    it('outcome error dừng dù runner không gọi ctx.setError', async () => {
        const next = vi.fn(async () => completed());
        const recipe = createRecipe('R', [step('booklet'), step('optimize')]);

        const res = await runRecipe(recipe, baseDeps({
            runners: {
                booklet: async () => ({ status: 'error', error: 'Hỏng artifact' }),
                optimize: next,
            },
        }));

        expect(res.status).toBe('error');
        expect(res.completed).toBe(0);
        expect(res.failedStep?.error).toBe('Hỏng artifact');
        expect(next).not.toHaveBeenCalled();
    });

    it('AbortError được chuẩn hóa thành canceled, không thành lỗi đỏ', async () => {
        const recipe = createRecipe('R', [step('booklet')]);

        const res = await runRecipe(recipe, baseDeps({
            runners: {
                booklet: async () => { throw new DOMException('Đã hủy', 'AbortError'); },
            },
        }));

        expect(res.status).toBe('canceled');
        expect(res.failedStep).toBeUndefined();
        expect(res.canceledStep?.index).toBe(0);
    });
});

describe('PlaybackRunner — tiến trình', () => {
    it('onProgress báo index/total cho mỗi bước chạy', async () => {
        const prog: number[] = [];
        const recipe = createRecipe('R', [step('booklet'), step('crop', { recordable: false }), step('optimize')]);
        await runRecipe(recipe, baseDeps({
            runners: { booklet: async () => completed(), optimize: async () => completed() },
            onProgress: ({ index, total }) => { prog.push(index); expect(total).toBe(3); },
        }));
        // crop (index 1) bị bỏ qua nên không báo progress
        expect(prog).toEqual([0, 2]);
    });
});
