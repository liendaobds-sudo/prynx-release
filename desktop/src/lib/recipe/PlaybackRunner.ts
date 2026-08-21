/**
 * PlaybackRunner — Phát lại một Recipe: chạy tuần tự các Step trên file đang mở.
 *
 * Spec: .kiro/specs/recipe-record-playback (Task 6).
 *
 * Thiết kế DI: orchestrator KHÔNG tự build ProcessContext hay gọi handler trực
 * tiếp — nó nhận `buildContext` + `runners` qua deps (Task 7 sẽ nối với
 * ImpositionTab.buildProcessContext). Nhờ vậy test được trọn vẹn với mock.
 *
 * Bất biến (Correctness Properties):
 *  - P2 Thứ tự: gọi runner theo đúng thứ tự steps (sau khi lọc).
 *  - P3 Tuyến tính: mọi bước chạy với ProcessContext ép spawnNewTab=false
 *    (do `buildContext` cung cấp + runner tự ép) → working file chuỗi.
 *  - P4 Tuần tự bất đồng bộ: await từng runner xong mới sang bước kế.
 *  - P6 Lọc an toàn: step.recordable=false luôn bị bỏ qua + cảnh báo.
 *  - P7 Không rò input ngoài: step.needsExternalInput phải re-prompt qua
 *    `requestExternalInput`; thiếu input → bỏ qua + cảnh báo.
 *  - P8 Dừng sạch khi lỗi: lỗi (throw HOẶC ctx.setError) ở bước i → dừng ngay,
 *    các bước >i không chạy.
 */
import type { Recipe, RecipeStep, RecipeOpId, RecipeExternalInput } from './recipeTypes';
import type { ProcessContext, ProcessOutcome } from '../processHandlers';
import { isCanceled } from '../errorMessages';

/** Giá trị input ngoài người dùng cung cấp khi phát lại (không lưu trong recipe). */
export interface ExternalInputValue {
    /** File thứ hai cho ghép/chèn (opId 'merge'). */
    files?: File[];
    /** Nội dung CSV cho VDP (opId 'datamerge'). */
    csvText?: string;
    csvFile?: File;
}

/** Metadata không làm thay đổi trạng thái thành công/thất bại của runner.
 *
 * PREPRESS (audit 2026-08-20 §COLOR.25): backend có thể hoàn tất việc ghi PDF
 * nhưng vẫn trả cảnh báo (ví dụ raster hoá làm mất vector) hoặc tên engine đã
 * dùng. Giữ metadata trong outcome để PlaybackRunner không làm rơi mất thông
 * tin nghiệp vụ khi phát lại qua Recipe.
 */
export interface RecipeRunnerOutcomeMeta {
    warnings?: string[];
    engine?: string;
}

export type RecipeRunnerOutcome = ProcessOutcome & RecipeRunnerOutcomeMeta;

/**
 * Một runner thực thi 1 op. Có thể báo lỗi bằng cách throw HOẶC gọi ctx.setError
 * (các handler hiện có dùng cách sau). PlaybackRunner bắt cả hai.
 */
export type RecipeRunner = (
    ctx: ProcessContext,
    params: Record<string, unknown>,
    ext: ExternalInputValue | null,
) => Promise<RecipeRunnerOutcome>;

export type RecipeRunnerRegistry = Partial<Record<RecipeOpId, RecipeRunner>>;

export type PlaybackSkipReason =
    | 'non_recordable'      // step file-dependent
    | 'missing_input'       // cần input ngoài nhưng người dùng không cung cấp
    | 'unsupported_op';     // không có runner cho opId

export interface PlaybackDeps {
    /** Tạo ProcessContext cho 1 bước (đã ép spawnNewTab=false / onSpawnTab=undefined). */
    buildContext: (step: RecipeStep, index: number) => ProcessContext;
    /** Bảng runner theo opId. */
    runners: RecipeRunnerRegistry;
    /** Hỏi input ngoài (file/CSV) trước khi chạy step tương ứng. */
    requestExternalInput?: (step: RecipeStep, kind: RecipeExternalInput) => Promise<ExternalInputValue | null>;
    /** Báo tiến trình "đang chạy bước i/N". */
    onProgress?: (info: { index: number; total: number; step: RecipeStep }) => void;
    /** Cảnh báo bước bị bỏ qua. */
    onWarn?: (step: RecipeStep, reason: PlaybackSkipReason) => void;
    /** Cảnh báo nghiệp vụ từ bước đã chạy và đã commit artifact. */
    onStepWarning?: (info: PlaybackStepWarning) => void;
    /** Trả lỗi quyền hoặc null. Runner kiểm toàn recipe trước khi chạy và kiểm lại từng bước. */
    authorizeStep?: (step: RecipeStep) => string | null;
}

export interface PlaybackStepWarning {
    index: number;
    step: RecipeStep;
    warnings: string[];
    /** Engine backend (nếu endpoint có trả), để truy vết fidelity. */
    engine?: string;
}

export interface PlaybackResult {
    ok: boolean;
    status: 'completed' | 'canceled' | 'error';
    completed: number;
    skipped: number;
    skippedSteps: { index: number; step: RecipeStep; reason: PlaybackSkipReason }[];
    /** Cảnh báo không được lặng lẽ bỏ qua sau khi bước đã thành công. */
    warnings: PlaybackStepWarning[];
    canceledStep?: { index: number; step: RecipeStep };
    failedStep?: { index: number; step: RecipeStep; error: string };
}

/**
 * Phát lại recipe tuần tự. Trả PlaybackResult; KHÔNG throw (lỗi bước → ok=false).
 */
export async function runRecipe(recipe: Recipe, deps: PlaybackDeps): Promise<PlaybackResult> {
    const steps = recipe.steps;
    const total = steps.length;
    let completed = 0;
    const skippedSteps: PlaybackResult['skippedSteps'] = [];
    const warnings: PlaybackResult['warnings'] = [];

    // Mọi nhánh thoát sớm (quyền, hủy, lỗi) vẫn phải giữ cảnh báo đã nhận ở
    // các bước trước đó; tránh trả một kết quả thiếu metadata rồi UI tưởng là
    // recipe sạch.
    const finish = (
        result: Omit<PlaybackResult, 'warnings'>,
    ): PlaybackResult => ({ ...result, warnings: [...warnings] });

    const skip = (index: number, step: RecipeStep, reason: PlaybackSkipReason) => {
        skippedSteps.push({ index, step, reason });
        deps.onWarn?.(step, reason);
    };

    // SEC (audit 2026-08-04 re-audit UI): kiểm toàn chuỗi trước mutation đầu
    // tiên; tránh chạy xong bước Free rồi mới phát hiện bước Pro ở giữa recipe.
    if (deps.authorizeStep) {
        for (let i = 0; i < total; i++) {
            const step = steps[i];
            if (!step.recordable) continue;
            const accessError = deps.authorizeStep(step);
            if (accessError) {
                return finish({
                    ok: false,
                    status: 'error',
                    completed: 0,
                    skipped: 0,
                    skippedSteps: [],
                    failedStep: { index: i, step, error: accessError },
                });
            }
        }
    }

    for (let i = 0; i < total; i++) {
        const step = steps[i];

        // P6 — bỏ qua bước phụ thuộc file/vị trí.
        if (!step.recordable) {
            skip(i, step, 'non_recordable');
            continue;
        }

        // P7 — input ngoài: phải re-prompt; thiếu → bỏ qua.
        let ext: ExternalInputValue | null = null;
        if (step.needsExternalInput) {
            try {
                ext = (await deps.requestExternalInput?.(step, step.needsExternalInput)) ?? null;
            } catch (error: any) {
                if (error?.message === 'ABORT_BY_USER' || isCanceled(error)) {
                    return finish({
                        ok: false,
                        status: 'canceled',
                        completed,
                        skipped: skippedSteps.length,
                        skippedSteps,
                        canceledStep: { index: i, step },
                    });
                }
                return finish({
                    ok: false,
                    status: 'error',
                    completed,
                    skipped: skippedSteps.length,
                    skippedSteps,
                    failedStep: {
                        index: i,
                        step,
                        error: error?.message || String(error),
                    },
                });
            }
            if (!ext) {
                skip(i, step, 'missing_input');
                continue;
            }
        }

        const runner = deps.runners[step.opId];
        if (!runner) {
            skip(i, step, 'unsupported_op');
            continue;
        }

        // Quyền có thể đổi trong lúc recipe dài đang chạy; kiểm lại ngay trước
        // runner để dừng sạch, không dựa vào snapshot đầu chuỗi.
        const accessError = deps.authorizeStep?.(step);
        if (accessError) {
            return finish({
                ok: false,
                status: 'error',
                completed,
                skipped: skippedSteps.length,
                skippedSteps,
                failedStep: { index: i, step, error: accessError },
            });
        }

        deps.onProgress?.({ index: i, total, step });

        // Bắt lỗi qua CẢ throw lẫn ctx.setError (handler hiện có dùng setError).
        const baseCtx = deps.buildContext(step, i);
        let capturedError = '';
        const ctx: ProcessContext = {
            ...baseCtx,
            onSpawnTab: undefined, // P3 — không tách tab ở bước phát lại
            setError: (msg: string) => {
                if (msg) capturedError = msg;
                baseCtx.setError(msg);
            },
        };

        try {
            const outcome = await runner(ctx, step.params, ext); // P4 — await tuần tự
            const stepWarnings = Array.isArray(outcome.warnings)
                ? [...new Set(outcome.warnings.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))]
                : [];
            const stepEngine = typeof outcome.engine === 'string' && outcome.engine.trim()
                ? outcome.engine.trim()
                : undefined;
            if (stepWarnings.length || stepEngine) {
                const notice: PlaybackStepWarning = {
                    index: i,
                    step,
                    warnings: stepWarnings,
                    ...(stepEngine ? { engine: stepEngine } : {}),
                };
                warnings.push(notice);
                deps.onStepWarning?.(notice);
            }
            if (outcome.status === 'canceled') {
                return finish({
                    ok: false,
                    status: 'canceled',
                    completed,
                    skipped: skippedSteps.length,
                    skippedSteps,
                    canceledStep: { index: i, step },
                });
            }
            if (outcome.status === 'error' && !capturedError) {
                capturedError = outcome.error;
            }
        } catch (e: any) {
            if (e?.message === 'ABORT_BY_USER' || isCanceled(e)) {
                return finish({
                    ok: false,
                    status: 'canceled',
                    completed,
                    skipped: skippedSteps.length,
                    skippedSteps,
                    canceledStep: { index: i, step },
                });
            }
            capturedError = e?.message || String(e);
        }

        if (capturedError) {
            // P8 — dừng sạch: không chạy bước kế.
            return finish({
                ok: false,
                status: 'error',
                completed,
                skipped: skippedSteps.length,
                skippedSteps,
                failedStep: { index: i, step, error: capturedError },
            });
        }

        completed++;
    }

    return finish({
        ok: true,
        status: 'completed',
        completed,
        skipped: skippedSteps.length,
        skippedSteps,
    });
}
