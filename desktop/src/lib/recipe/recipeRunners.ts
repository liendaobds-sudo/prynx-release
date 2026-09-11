/**
 * recipeRunners — Bảng runner mặc định cho PlaybackRunner.
 *
 * Spec: .kiro/specs/recipe-record-playback (Task 6/7 — lớp nối handler thật).
 *
 * Mỗi runner TÁI DÙNG đường xử lý hiện có (processHandlers.run* hoặc endpoint
 * backend mà tool prepress đang gọi) → KHÔNG tạo đường ghi PDF mới (giữ invariant
 * an toàn màu: pikepdf là đường ghi duy nhất; không ghi đè file gốc).
 *
 * Quy ước params:
 *  - Imposition (booklet/nup/sticker/cnc): params = ProcessingSettings của runProcessEngine.
 *  - Preprocess (shuffle/resize/split): params = settings của run* (ép spawnNewTab=false).
 *  - Merge: params = settings; file thứ hai lấy từ ExternalInputValue.files.
 *  - Prepress JSON (convertcolors/hairlines/trapping/pdfx/spot_cmyk): params = body POST
 *    (KHÔNG gồm file_id — runner tự upload working file để lấy file_id).
 *
 * Ranh giới MVP: OCR (multipart) chưa nối; AI ảnh (bgremover/upscale) là công cụ
 * tương tác theo lô ẢNH (store + preview riêng), KHÔNG nằm trong chuỗi working PDF
 * nên không thuộc recipe tuyến tính (đã đánh recordable=false); overlay
 * (watermark/stick_text_number) chưa nối. Các op vắng mặt trong registry sẽ được
 * PlaybackRunner tự bỏ qua + cảnh báo (reason='unsupported_op').
 *
 * Tem bế (sticker_imposer/cnc_imposer/sticker_dieline) PHÁT LẠI ĐƯỢC: thay vì lưu
 * hình, runner DÒ LẠI hình trên file mới mỗi lần phát (/imposition/detect-shape,
 * /pdf-tools/sticker-dieline) → đúng trên sản phẩm tem mới.
 */
import type { RecipeRunner, RecipeRunnerRegistry, RecipeRunnerOutcome } from './PlaybackRunner';
import { isLinearRecipeMergeMode, isLinearRecipeSplitMode, type RecipeOpId } from './recipeTypes';
import type { ProcessContext, ProcessOutcome } from '../processHandlers';
import type { ProcessingSettings } from '../pdfImposer';
import {
    PROCESS_COMPLETED,
    runProcessEngine,
    runShuffle,
    runResize,
    runTrimShift,
    runSplit,
    runMerge,
} from '../processHandlers';
import { authenticatedFetch, getApiUrl, uploadPDF, prepareFileForUpload } from '../api';
import {
    buildStickerDielineFields,
    clampStickerMm,
    STICKER_PARAM_LIMITS,
} from '../../components/preprocess-tools/stickerToolPolicy';
import i18n from '../../i18n';

type JsonRecord = Record<string, unknown>;
interface OptimizeRecipeParams extends JsonRecord { preset?: string; image_dpi?: number | string; strip_metadata?: boolean; grayscale?: boolean; }
interface StickerDielineRecipeParams extends JsonRecord { productType?: string; cutMode?: string; cornerStyle?: string; bleedColorType?: string; bleedColorHex?: string; cropToSticker?: boolean; forceContour?: boolean; fillHoles?: boolean; removeWhiteBg?: boolean; cutFirstPageOnly?: boolean; bleedMm?: unknown; offsetMm?: unknown; curveTension?: unknown; edgeBiteMm?: unknown; mirrorEdgeBiteMm?: unknown; cutlineDenoise?: unknown; cutlineSimplifyMm?: unknown; cutlineSimplifyAuto?: boolean; bleedSides?: unknown; }
function isRecord(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function asRecord(value: unknown): JsonRecord { return isRecord(value) ? value : {}; }
function describeError(error: unknown): string { if (error instanceof Error && error.message) return error.message; if (isRecord(error) && typeof error.message === 'string' && error.message) return error.message; return String(error); }
function stringValue(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function responseError(data: JsonRecord, fallback: string): string { return stringValue(data.error) || stringValue(data.detail) || fallback; }
// LINT (audit 2026-08-23 LO67): cầu nối kiểu DOM BlobPart, không sao chép bytes.
function bytesAsBlobPart(bytes: Uint8Array): BlobPart { return bytes as unknown as BlobPart; }

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}
function isJsonRecordArray(value: unknown): value is JsonRecord[] {
    return Array.isArray(value) && value.every(isRecord);
}
async function uploadPdfId(file: File, errorMessage: string): Promise<string> {
    const data = asRecord(await uploadPDF(file));
    const id = stringValue(data.id);
    if (!id) throw new Error(errorMessage);
    return id;
}

// ─────────────── Imposition (qua runProcessEngine, ép spawnNewTab=false) ───────────────

const runImposition: RecipeRunner = async (ctx, params) => {
    return runProcessEngine(ctx, params as unknown as ProcessingSettings, /* spawnNewTab */ false);
};

// ─────────────── Preprocess engine (ép spawnNewTab=false) ───────────────

const runShuffleStep: RecipeRunner = async (ctx, params) => {
    return runShuffle(ctx, { ...params, spawnNewTab: false });
};
const runResizeStep: RecipeRunner = async (ctx, params) => {
    return runResize(ctx, { ...params, spawnNewTab: false });
};
const runTrimShiftStep: RecipeRunner = async (ctx, params) => {
    return runTrimShift(ctx, { ...params, spawnNewTab: false });
};
const runSplitStep: RecipeRunner = async (ctx, params) => {
    // RECIPE (audit 2026-08-15 §PLAY.4): Recipe là chuỗi một working PDF.
    // by_count/by_range có thể tạo nhiều file (ZIP), nên không được âm thầm chạy
    // bước sau trên PDF cũ. Chỉ extract_pages luôn tạo đúng một PDF.
    if (!isLinearRecipeSplitMode(params.mode)) {
        return failedStep(
            ctx.setError,
            i18n.t('lib.processHandlers:split_nhieu_file_khong_the_phat_noi_tiep', {
                defaultValue: 'Bước Tách tạo nhiều file nên không thể phát nối tiếp trong quy trình. Chỉ chế độ Trích xuất trang được hỗ trợ.',
            }),
        );
    }
    return runSplit(ctx, { ...params, spawnNewTab: false });
};

// ─────────────── Merge (file thứ hai từ input ngoài) ───────────────

const runMergeStep: RecipeRunner = async (ctx, params, ext) => {
    // RECIPE (audit 2026-08-16 §PLAY.5): recipe cũ có thể mang mode Trộn xen kẽ /
    // Chèn trang. Hai mode đó không tái lập được: engine sẽ ném "chọn đủ 2 file
    // nguồn", hoặc vỡ TypeError vì `insertFile` đã bị JSON hoá thành `{}`. Mode
    // thiếu/lạ còn tệ hơn — engine không khớp nhánh nào và trả PDF rỗng.
    if (!isLinearRecipeMergeMode(params.mode)) {
        return failedStep(
            ctx.setError,
            i18n.t('lib.processHandlers:merge_mode_khong_the_phat_noi_tiep', {
                defaultValue: 'Bước Ghép này cần nhiều nguồn theo vai trò (trộn xen kẽ / chèn trang) nên không thể phát lại trong quy trình. Chỉ chế độ Ghép nối tiếp được hỗ trợ.',
            }),
        );
    }
    const files = ext?.files ?? [];
    // Chỉ chèn file ngoài vừa được hỏi lại; KHÔNG tin dữ liệu file trong params.
    const mergeParams = { ...(params as Record<string, unknown>) };
    delete mergeParams.insertFile;
    delete mergeParams.oddFile;
    delete mergeParams.evenFile;
    return runMerge(ctx, { ...mergeParams, spawnNewTab: false, filesToMerge: files });
};

function failedStep(setError: ProcessContext['setError'], message: string): ProcessOutcome {
    setError(message);
    return { status: 'error', error: message };
}

/**
 * PREPRESS (audit 2026-08-20 §COLOR.25): gom cảnh báo từ mọi hình dạng response
 * preflight. Convert Colors hiện đặt cảnh báo trong `log[].message`, còn PDF/X
 * trả `warnings[]`; cả hai phải đi cùng working artifact khi phát lại Recipe.
 */
function collectPreflightMetadata(data: unknown): Pick<RecipeRunnerOutcome, 'warnings' | 'engine'> {
    const warnings: string[] = [];
    const add = (value: unknown) => {
        if (typeof value !== 'string' || !value.trim()) return;
        const clean = value
            .replace(/(?:[a-z]:[\\/]|\\\\)[^;\r\n]*/gi, '[đường dẫn đã ẩn]')
            .replace(/[\r\n]+/g, ' ')
            .trim()
            .slice(0, 240);
        if (clean && !warnings.includes(clean)) warnings.push(clean);
    };

    const record = asRecord(data);
    if (Array.isArray(record.warnings)) record.warnings.forEach(add);
    if (Array.isArray(record.log)) {
        record.log.forEach((entry: unknown) => {
            const entryRecord = asRecord(entry);
            const message = stringValue(entryRecord.message);
            const status = stringValue(entryRecord.status).toLowerCase();
            const marker = message.match(/(?:cảnh báo|warning)\s*:\s*(.*)$/i);
            if (marker?.[1]) add(marker[1]);
            else if (status === 'warning' || status === 'warn') add(message);
        });
    }

    const engineValue = stringValue(record.engine).trim();
    const engine = engineValue || undefined;
    return {
        ...(warnings.length ? { warnings } : {}),
        ...(engine ? { engine } : {}),
    };
}

// ─────────────── Prepress JSON (upload → POST → download → commit) ───────────────

/** Endpoint preflight theo opId (kiểu "POST {file_id, ...params} → output_filename"). */
const PREFLIGHT_ENDPOINT: Partial<Record<RecipeOpId, string>> = {
    convertcolors: 'preflight/convert-colors',
    hairlines: 'preflight/fix-hairlines',
    trapping: 'preflight/set-overprint',
    pdfx: 'preflight/export-pdfx',
    spot_cmyk: 'preflight/convert-spot',
};

function makePreflightRunner(endpoint: string): RecipeRunner {
    return async (ctx: ProcessContext, params: Record<string, unknown>) => {
        const { file, commitWorkingFile, setError, setIsProcessing, setProcessStatus, getWorkingBytes } = ctx;
        setError(''); setIsProcessing(true); setProcessStatus(i18n.t('recipe.recipeRunners:dang_xu_ly_prepress'));
        try {
            // Upload bản working hiện tại để lấy file_id (KHÔNG đụng file gốc trên đĩa).
            const workingBytes = await getWorkingBytes();
            const workingFile = new File([bytesAsBlobPart(workingBytes)], file.name, { type: 'application/pdf' });
            const uploadId = await uploadPdfId(workingFile, i18n.t('recipe.recipeRunners:buoc_prepress_that_bai'));

            const res = await authenticatedFetch(`${getApiUrl()}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // ID upload của working revision luôn thắng dữ liệu cũ/imported.
                body: JSON.stringify({ ...params, file_id: uploadId }),
            });
            const data = asRecord(await res.json().catch(() => ({})));
            const outputFilename = stringValue(data.output_filename);
            if (res.ok === false || !outputFilename) {
                return failedStep(
                    setError,
                    responseError(data, i18n.t('recipe.recipeRunners:buoc_prepress_that_bai')),
                );
            }
            if (outputFilename) {
                const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${outputFilename}`);
                if (dl.ok === false) {
                    return failedStep(
                        setError,
                        i18n.t('recipe.recipeRunners:buoc_prepress_that_bai'),
                    );
                }
                const blob = await dl.blob();
                await commitWorkingFile(blob, outputFilename);
            }
            const metadata = collectPreflightMetadata(data);
            return metadata.warnings?.length || metadata.engine
                ? { status: 'completed', ...metadata }
                : PROCESS_COMPLETED;
        } catch (error: unknown) {
            return failedStep(
                setError,
                i18n.t('recipe.recipeRunners:loi_prepress') + ' ' + describeError(error),
            );
        } finally {
            setIsProcessing(false); setProcessStatus('');
        }
    };
}

// ─────────────── Optimize (multipart /pdf-tools/optimize → blob trực tiếp) ───────────────

const runOptimizeStep: RecipeRunner = async (ctx, params) => {
    const { file, commitWorkingFile, setError, setIsProcessing, setProcessStatus, getWorkingBytes } = ctx;
    setError(''); setIsProcessing(true); setProcessStatus(i18n.t('recipe.recipeRunners:dang_nen_toi_uu_pdf'));
    try {
        const p = params as OptimizeRecipeParams;
        const workingBytes = await getWorkingBytes();
        const workingFile = new File([bytesAsBlobPart(workingBytes)], file.name, { type: 'application/pdf' });
        const realFile = await prepareFileForUpload(workingFile);

        const formData = new FormData();
        formData.append('file', realFile, file.name);
        formData.append('preset', p.preset ?? 'ebook');
        formData.append('image_dpi', String(p.image_dpi ?? 300));
        formData.append('strip_metadata', p.strip_metadata === false ? 'false' : 'true');
        formData.append('grayscale', p.grayscale ? 'true' : 'false');

        const res = await authenticatedFetch(`${getApiUrl()}/pdf-tools/optimize`, { method: 'POST', body: formData });
        if (!res.ok) {
            const err = asRecord(await res.json().catch(() => null));
            return failedStep(
                setError,
                stringValue(err.detail) || i18n.t('recipe.recipeRunners:nen_pdf_that_bai_res_status', { status: res.status }),
            );
        }
        const blob = await res.blob();
        await commitWorkingFile(blob, `optimized_${file.name}`);
        return PROCESS_COMPLETED;
    } catch (error: unknown) {
        return failedStep(
            setError,
            i18n.t('recipe.recipeRunners:loi_nen_pdf') + ' ' + describeError(error),
        );
    } finally {
        setIsProcessing(false); setProcessStatus('');
    }
};

// ─── Bình tem/CNC: DÒ LẠI hình trên file mới rồi mới bình (không đóng băng hình cũ) ───
// Chìa khoá phát lại tem ĐÚNG trên sản phẩm mới: /imposition/detect-shape là endpoint
// tất định theo từng ảnh → mỗi lần phát lại sinh shape mới cho file mới.
const runStickerImposition: RecipeRunner = async (ctx, params) => {
    const { file, setError, setProcessStatus, getWorkingBytes } = ctx;
    try {
        setProcessStatus(i18n.t('recipe.recipeRunners:dang_do_lai_hinh_tem_tren_file_moi'));
        const workingBytes = await getWorkingBytes();
        const workingFile = new File([bytesAsBlobPart(workingBytes)], file.name, { type: 'application/pdf' });
        const uploadId = await uploadPdfId(workingFile, i18n.t('recipe.recipeRunners:loi_binh_tem_phat_lai'));

        const res = await authenticatedFetch(`${getApiUrl()}/imposition/detect-shape`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId: uploadId }),
        });
        const data = asRecord(await res.json().catch(() => ({})));
        const shapes = data.shapes;
        const shapeParams = data.shapeParams;
        if (res.ok === false || data.success === false || !isStringArray(shapes) || !isJsonRecordArray(shapeParams) || shapeParams.length !== shapes.length) {
            throw new Error(
                responseError(data, i18n.t('recipe.recipeRunners:loi_binh_tem_phat_lai')),
            );
        }

        const detectedShapesByPage: Record<number, string> = {};
        const detectedShapeParamsByPage: Record<number, Record<string, unknown>> = {};
        shapes.forEach((shape, index) => {
            detectedShapesByPage[index] = shape;
        });
        shapeParams.forEach((paramsForShape, index) => {
            detectedShapeParamsByPage[index] = paramsForShape;
        });

        // Ghép hình MỚI vào tham số đã ghi (khổ/grid/pont giữ nguyên) rồi bình.
        const merged = { ...params, detectedShapesByPage, detectedShapeParamsByPage };
        // Giữ `await` trong try để mọi rejection bất ngờ vẫn đi qua thông báo
        // chuyên biệt của bước dò/bình tem; outcome Hủy bình thường được trả nguyên.
        const outcome = await runProcessEngine(ctx, merged as unknown as ProcessingSettings, false);
        return outcome;
    } catch (error: unknown) {
        const outcome = failedStep(
            setError,
            i18n.t('recipe.recipeRunners:loi_binh_tem_phat_lai') + ' ' + describeError(error),
        );
        setProcessStatus('');
        return outcome;
    }
};

// Recipe cũ (ghi trước khi có tính năng chọn cạnh) KHÔNG có bleedSides → phải trả
// đủ 4 cạnh để phát lại ra đúng file như lúc ghi.
const RECIPE_BLEED_SIDE_KEYS = ['top', 'right', 'bottom', 'left'] as const;

function recipeBleedSideNames(saved: unknown): string[] {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
        return [...RECIPE_BLEED_SIDE_KEYS];
    }
    const raw = saved as Record<string, unknown>;
    const enabled = RECIPE_BLEED_SIDE_KEYS.filter(side => raw[side] !== false);
    return enabled.length > 0 ? enabled : [...RECIPE_BLEED_SIDE_KEYS];
}

/** Cùng dữ liệu trên, dạng map để đưa vào builder payload dùng chung. */
function recipeBleedSides(saved: unknown): Record<string, boolean> {
    const names = recipeBleedSideNames(saved);
    return Object.fromEntries(RECIPE_BLEED_SIDE_KEYS.map(side => [side, names.includes(side)]));
}

// ─── Tạo đường cắt / bù xén tem (dò contour server-side mỗi file) ───
const runStickerDieline: RecipeRunner = async (ctx, params) => {
    const { file, commitWorkingFile, setError, setIsProcessing, setProcessStatus, getWorkingBytes } = ctx;
    const p = params as StickerDielineRecipeParams;
    const productType: 'sticker' | 'rectangle' = p.productType === 'rectangle' ? 'rectangle' : 'sticker';
    setError(''); setIsProcessing(true); setProcessStatus(i18n.t('recipe.recipeRunners:dang_tao_duong_cat_bu_xen'));
    try {
        const workingBytes = await getWorkingBytes();
        const targetFile = new File([bytesAsBlobPart(workingBytes)], file.name, { type: 'application/pdf' });
        let resultBlob: Blob;
        // RECIPE (audit 2026-08-17 §PLAY.PATH): giữ native output path để bước sau đi
        // fast-path (không sao chép/upload/nạp bytes lớn vào WebView), như lượt chạy tay.
        let outputPath: string | undefined;

        if (productType === 'rectangle' && p.bleedColorType === 'mirror') {
            // Khổ trang hiện tại luôn là khổ thành phẩm; recipe cũ không còn được phép auto-trim đổi khổ.
            const working = targetFile;
            const uploadId = await uploadPdfId(working, i18n.t('recipe.recipeRunners:loi_tao_bu_xen_vector'));
            const bleedRes = await authenticatedFetch(`${getApiUrl()}/preflight/mirror-bleed`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: uploadId,
                    // RECIPE (audit 2026-08-17 §PLAY.BX-MIRROR): backend không đặt ge/le
                    // và RecipePanel cho nhập số không giới hạn → clamp đúng như UI chạy
                    // tay (0–10mm) để recipe sửa tay không gửi 999mm/NaN xuống engine.
                    bleed_mm: clampStickerMm(p.bleedMm, STICKER_PARAM_LIMITS.bleedMm),
                    pages: null,
                    bleed_sides: recipeBleedSideNames(p.bleedSides),
                    // MIRROR (audit 2026-09-11 §MIRROR.BITE.4): field riêng; recipe
                    // cũ có thể có edgeBiteMm ẩn của mode ảnh nhưng không được dùng.
                    edge_bite_mm: clampStickerMm(p.mirrorEdgeBiteMm, STICKER_PARAM_LIMITS.edgeBiteMm),
                }),
            });
            const bleedData = asRecord(await bleedRes.json());
            const outputFilename = stringValue(bleedData.output_filename);
            if (bleedRes.ok === false || !bleedData.success || !outputFilename) {
                throw new Error(stringValue(bleedData.detail) || i18n.t('recipe.recipeRunners:loi_tao_bu_xen_vector'));
            }
            const finalRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${outputFilename}`);
            if (finalRes.ok === false) throw new Error(i18n.t('recipe.recipeRunners:loi_tao_bu_xen_vector'));
            resultBlob = await finalRes.blob();
        } else {
            const uploadId = await uploadPdfId(targetFile, i18n.t('recipe.recipeRunners:loi_tao_duong_cat'));
            const fd = new FormData();
            fd.append('file_id', uploadId);
            // AUDIT (2026-08-16 §BX.F01/F07/F13): dùng ĐÚNG builder mà StickerTool dùng
            // lúc chạy tay. Ba công thức song song trước đây làm recipe phát lại đổi
            // shape_mode, bỏ hai nhánh riêng của `cutMode='alpha'`, và bỏ qua toàn bộ
            // clamp của UI (recipe sửa tay có thể mang NaN/Infinity).
            const dielineFields = buildStickerDielineFields({
                productType,
                cutMode: productType === 'rectangle' ? 'none' : (p.cutMode || 'original'),
                offsetMm: p.offsetMm,
                cornerStyle: p.cornerStyle || 'preserve',
                // Recipe cũ thiếu field được builder đưa về mốc tương thích 50.
                curveTension: p.curveTension,
                fillHoles: !!p.fillHoles,
                bleedMm: p.bleedMm,
                removeWhiteBg: !!p.removeWhiteBg,
                bleedColorType: p.bleedColorType || 'image',
                bleedColorHex: p.bleedColorHex || '#FFFFFF',
                edgeBiteMm: p.edgeBiteMm,
                cutFirstPageOnly: !!p.cutFirstPageOnly,
                // Recipe cũ không có field này phải giữ hành vi cũ: không crop.
                cropToSticker: p.cropToSticker === true,
                bleedSides: recipeBleedSides(p.bleedSides),
                // RECIPE (audit 2026-08-17 §PLAY.BX01-LEGACY — FAIL-CLOSED): recipe cũ
                // ghi `shapeMode:'contour'` cho cả trường hợp người dùng chạy tay bằng
                // auto_safe, nên KHÔNG thể suy ngược ý định. Chỉ ép contour khi bản ghi
                // MỚI mang cờ tường minh `forceContour===true`; recipe cũ (thiếu cờ) đi
                // theo mặc định an toàn của builder, không âm thầm ép contour.
                forceContour: p.forceContour === true,
                // §CUTJAG.3: recipe cũ không có field này → `undefined` → 0 (tắt),
                // đúng hành vi của bản ghi đã duyệt trước khi có thanh kéo.
                cutlineDenoise: p.cutlineDenoise,
                cutlineSimplifyMm: p.cutlineSimplifyMm,
                // AUTO mới phải được phát lại theo từng trang; nếu bỏ cờ này,
                // recipe của tài liệu lẫn raster/vector sẽ áp .10 mm lên cả vector.
                cutlineSimplifyAuto: p.cutlineSimplifyAuto === true,
            });
            for (const [field, value] of Object.entries(dielineFields)) {
                fd.append(field, value);
            }
            const response = await authenticatedFetch(`${getApiUrl()}/pdf-tools/sticker-dieline`, { method: 'POST', body: fd });
            if (!response.ok) {
                const err = asRecord(await response.json().catch(() => null));
                throw new Error(stringValue(err.detail) || i18n.t('recipe.recipeRunners:loi_server_response_status', { status: response.status }));
            }
            resultBlob = await response.blob();
            // Header có thể vắng khi fetch cũ không expose; chỉ dùng khi có giá trị thật.
            outputPath = response.headers?.get?.('X-Sticker-Output-Path') || undefined;
        }

        const baseName = file.name.replace(/\.[^/.]+$/, '');
        const prefix = productType === 'rectangle' ? 'autobleed' : 'sticker';
        await commitWorkingFile(resultBlob, `${prefix}_${baseName}.pdf`, outputPath);
        return PROCESS_COMPLETED;
    } catch (error: unknown) {
        return failedStep(
            setError,
            i18n.t('recipe.recipeRunners:loi_tao_duong_cat') + ' ' + describeError(error),
        );
    } finally {
        setIsProcessing(false); setProcessStatus('');
    }
};

// ─────────────── Registry ───────────────

export const RECIPE_RUNNERS: RecipeRunnerRegistry = {
    // Imposition page-based (tất định, phát lại được)
    booklet: runImposition,
    nup: runImposition,
    // Tem/CNC: phát lại bằng cách DÒ LẠI hình trên file mới (không đóng băng hình cũ).
    sticker_imposer: runStickerImposition,
    cnc_imposer: runStickerImposition,
    // Tạo đường cắt / bù xén tem (dò contour server-side mỗi file)
    sticker_dieline: runStickerDieline,
    // Preprocess
    shuffle: runShuffleStep,
    resize: runResizeStep,
    trim_shift: runTrimShiftStep,
    split: runSplitStep,
    // Merge
    merge: runMergeStep,
    // Prepress JSON
    convertcolors: makePreflightRunner(PREFLIGHT_ENDPOINT.convertcolors!),
    hairlines: makePreflightRunner(PREFLIGHT_ENDPOINT.hairlines!),
    trapping: makePreflightRunner(PREFLIGHT_ENDPOINT.trapping!),
    pdfx: makePreflightRunner(PREFLIGHT_ENDPOINT.pdfx!),
    spot_cmyk: makePreflightRunner(PREFLIGHT_ENDPOINT.spot_cmyk!),
    // Optimize (multipart)
    optimize: runOptimizeStep,
    // OCR (multipart), AI ảnh (bgremover/upscale), overlay: ngoài phạm vi chuỗi PDF v1.
};

/** Danh sách opId đã có runner thật (để UI hiển thị "phát lại được"). */
export function isPlayableOp(opId: RecipeOpId): boolean {
    return !!RECIPE_RUNNERS[opId];
}
