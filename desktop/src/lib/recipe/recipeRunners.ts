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
import type { RecipeRunner, RecipeRunnerRegistry } from './PlaybackRunner';
import { isLinearRecipeSplitMode, type RecipeOpId } from './recipeTypes';
import type { ProcessContext, ProcessOutcome } from '../processHandlers';
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
import i18n from '../../i18n';

// ─────────────── Imposition (qua runProcessEngine, ép spawnNewTab=false) ───────────────

const runImposition: RecipeRunner = async (ctx, params) => {
    return runProcessEngine(ctx, params as any, /* spawnNewTab */ false);
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
    const files = ext?.files ?? [];
    // mode mặc định 'merge_files'; chèn file ngoài vào filesToMerge.
    return runMerge(ctx, { ...params, spawnNewTab: false, filesToMerge: files });
};

function failedStep(setError: ProcessContext['setError'], message: string): ProcessOutcome {
    setError(message);
    return { status: 'error', error: message };
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
            const workingFile = new File([workingBytes as any], file.name, { type: 'application/pdf' });
            const up = await uploadPDF(workingFile);

            const res = await authenticatedFetch(`${getApiUrl()}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // ID upload của working revision luôn thắng dữ liệu cũ/imported.
                body: JSON.stringify({ ...params, file_id: up.id }),
            });
            const data = await res.json().catch(() => ({} as any));
            if (res.ok === false || (!data.success && !data.output_filename)) {
                return failedStep(
                    setError,
                    data.error || data.detail || i18n.t('recipe.recipeRunners:buoc_prepress_that_bai'),
                );
            }
            if (data.output_filename) {
                const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
                if (dl.ok === false) {
                    return failedStep(
                        setError,
                        i18n.t('recipe.recipeRunners:buoc_prepress_that_bai'),
                    );
                }
                const blob = await dl.blob();
                await commitWorkingFile(blob, data.output_filename);
            }
            return PROCESS_COMPLETED;
        } catch (e: any) {
            return failedStep(
                setError,
                i18n.t('recipe.recipeRunners:loi_prepress') + ' ' + (e?.message || e),
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
        const p = params as any;
        const workingBytes = await getWorkingBytes();
        const workingFile = new File([workingBytes as any], file.name, { type: 'application/pdf' });
        const realFile = await prepareFileForUpload(workingFile);

        const formData = new FormData();
        formData.append('file', realFile, file.name);
        formData.append('preset', p.preset ?? 'ebook');
        formData.append('image_dpi', String(p.image_dpi ?? 300));
        formData.append('strip_metadata', p.strip_metadata === false ? 'false' : 'true');
        formData.append('grayscale', p.grayscale ? 'true' : 'false');

        const res = await authenticatedFetch(`${getApiUrl()}/pdf-tools/optimize`, { method: 'POST', body: formData });
        if (!res.ok) {
            const err = await res.json().catch(() => null);
            return failedStep(
                setError,
                err?.detail || i18n.t('recipe.recipeRunners:nen_pdf_that_bai_res_status', { status: res.status }),
            );
        }
        const blob = await res.blob();
        await commitWorkingFile(blob, `optimized_${file.name}`);
        return PROCESS_COMPLETED;
    } catch (e: any) {
        return failedStep(
            setError,
            i18n.t('recipe.recipeRunners:loi_nen_pdf') + ' ' + (e?.message || e),
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
        const workingFile = new File([workingBytes as any], file.name, { type: 'application/pdf' });
        const up = await uploadPDF(workingFile);

        const res = await authenticatedFetch(`${getApiUrl()}/imposition/detect-shape`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId: up.id }),
        });
        const data = await res.json().catch(() => ({} as any));
        if (res.ok === false || data.success === false || !Array.isArray(data.shapes)) {
            throw new Error(
                data.error || data.detail || i18n.t('recipe.recipeRunners:loi_binh_tem_phat_lai'),
            );
        }

        const detectedShapesByPage: Record<number, string> = {};
        const detectedShapeParamsByPage: Record<number, any> = {};
        if (Array.isArray(data.shapes)) data.shapes.forEach((s: string, i: number) => { detectedShapesByPage[i] = s; });
        if (Array.isArray(data.shapeParams)) data.shapeParams.forEach((p: any, i: number) => { detectedShapeParamsByPage[i] = p; });

        // Ghép hình MỚI vào tham số đã ghi (khổ/grid/pont giữ nguyên) rồi bình.
        const merged = { ...params, detectedShapesByPage, detectedShapeParamsByPage };
        // Giữ `await` trong try để mọi rejection bất ngờ vẫn đi qua thông báo
        // chuyên biệt của bước dò/bình tem; outcome Hủy bình thường được trả nguyên.
        const outcome = await runProcessEngine(ctx, merged as any, false);
        return outcome;
    } catch (e: any) {
        const outcome = failedStep(
            setError,
            i18n.t('recipe.recipeRunners:loi_binh_tem_phat_lai') + ' ' + (e?.message || e),
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

// ─── Tạo đường cắt / bù xén tem (dò contour server-side mỗi file) ───
const runStickerDieline: RecipeRunner = async (ctx, params) => {
    const { file, commitWorkingFile, setError, setIsProcessing, setProcessStatus, getWorkingBytes } = ctx;
    const p = params as any;
    const productType: 'sticker' | 'rectangle' = p.productType === 'rectangle' ? 'rectangle' : 'sticker';
    setError(''); setIsProcessing(true); setProcessStatus(i18n.t('recipe.recipeRunners:dang_tao_duong_cat_bu_xen'));
    try {
        const workingBytes = await getWorkingBytes();
        const targetFile = new File([workingBytes as any], file.name, { type: 'application/pdf' });
        let resultBlob: Blob;

        if (productType === 'rectangle' && p.bleedColorType === 'mirror') {
            // Khổ trang hiện tại luôn là khổ thành phẩm; recipe cũ không còn được phép auto-trim đổi khổ.
            const working = targetFile;
            const up = await uploadPDF(working);
            const bleedRes = await authenticatedFetch(`${getApiUrl()}/preflight/mirror-bleed`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: up.id,
                    bleed_mm: p.bleedMm || 0,
                    pages: null,
                    bleed_sides: recipeBleedSideNames(p.bleedSides),
                }),
            });
            const bleedData = await bleedRes.json();
            if (bleedRes.ok === false || !bleedData.success) throw new Error(bleedData.detail || i18n.t('recipe.recipeRunners:loi_tao_bu_xen_vector'));
            const finalRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${bleedData.output_filename}`);
            if (finalRes.ok === false) throw new Error(i18n.t('recipe.recipeRunners:loi_tao_bu_xen_vector'));
            resultBlob = await finalRes.blob();
        } else {
            const up = await uploadPDF(targetFile);
            const fd = new FormData();
            fd.append('file_id', up.id);
            fd.append('cut_mode', productType === 'rectangle' ? 'none' : (p.cutMode || 'original'));
            fd.append('offset_mm', productType === 'rectangle' ? '0' : String(p.offsetMm ?? 0));
            const effectiveCornerStyle = productType === 'rectangle' ? 'miter' : (p.cornerStyle || 'preserve');
            fd.append('corner_style', effectiveCornerStyle);
            fd.append('bleed_mm', String(p.bleedMm ?? 0));
            fd.append('fill_holes', productType === 'rectangle' ? 'true' : (p.fillHoles ? 'true' : 'false'));
            fd.append('remove_white_bg', productType === 'rectangle' ? 'false' : (p.removeWhiteBg ? 'true' : 'false'));
            fd.append('draw_cut_contour', productType === 'rectangle' ? 'false' : ((p.cutMode && p.cutMode !== 'none') ? 'true' : 'false'));
            fd.append('bleed_color_type', p.bleedColorType || 'image');
            fd.append('bleed_color_hex', p.bleedColorHex || '#FFFFFF');
            // Lẹm mép chỉ Xén vuông. Bế tem dùng “Bỏ nền trắng” + sample viền tự động.
            fd.append('edge_bite_mm', productType === 'rectangle' ? String(p.edgeBiteMm ?? 0) : '0');
            fd.append(
                'bleed_sides',
                productType === 'rectangle'
                    ? (recipeBleedSideNames(p.bleedSides).join(',') || 'none')
                    : 'all',
            );
            fd.append('cut_first_page_only', productType === 'sticker' && p.cutFirstPageOnly ? 'true' : 'false');
            // Recipe cũ không có field này phải giữ hành vi cũ: không crop.
            fd.append('crop_to_sticker', productType === 'sticker' && p.cutMode !== 'none' && p.cropToSticker === true ? 'true' : 'false');
            fd.append(
                'shape_mode',
                productType === 'sticker'
                    ? (effectiveCornerStyle === 'preserve' ? 'contour' : (p.shapeMode || 'auto_safe'))
                    : 'contour',
            );
            fd.append('rectangle_mode', productType === 'rectangle' ? 'true' : 'false');
            const response = await authenticatedFetch(`${getApiUrl()}/pdf-tools/sticker-dieline`, { method: 'POST', body: fd });
            if (!response.ok) {
                const err = await response.json().catch(() => null);
                throw new Error(err?.detail || i18n.t('recipe.recipeRunners:loi_server_response_status', { status: response.status }));
            }
            resultBlob = await response.blob();
        }

        const baseName = file.name.replace(/\.[^/.]+$/, '');
        const prefix = productType === 'rectangle' ? 'autobleed' : 'sticker';
        await commitWorkingFile(resultBlob, `${prefix}_${baseName}.pdf`);
        return PROCESS_COMPLETED;
    } catch (e: any) {
        return failedStep(
            setError,
            i18n.t('recipe.recipeRunners:loi_tao_duong_cat') + ' ' + (e?.message || e),
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
