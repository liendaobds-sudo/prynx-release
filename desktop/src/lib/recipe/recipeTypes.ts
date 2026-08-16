import { tv } from '../../i18n';
/**
 * recipeTypes — Mô hình dữ liệu cho tính năng Recipe (Ghi & Phát lại quy trình).
 *
 * Spec: .kiro/specs/recipe-record-playback (Task 1).
 * File CỐ Ý thuần (không import store/component) để test & tái dùng dễ.
 *
 * Recipe = quy trình tuyến tính đã lưu = danh sách RecipeStep có thứ tự.
 * Phát lại chạy tuần tự, output bước trước là input bước sau (chain working file).
 */

export const RECIPE_SCHEMA_VERSION = 1;

/** Recipe tuyến tính chỉ nhận mode Split luôn tạo đúng một working PDF. */
export function isLinearRecipeSplitMode(mode: unknown): mode is 'extract_pages' {
    return mode === 'extract_pages';
}

/**
 * RECIPE (audit 2026-08-16 §PLAY.5): v1 chỉ ghi/phát được Ghép nối tiếp.
 *
 * `interleave` cần đủ HAI nguồn (`oddFile`+`evenFile`) và `insert_pages` cần
 * `insertFile` + `afterPageNum` là chỉ số trang tuyệt đối — hợp đồng input ngoài
 * hiện tại chỉ mang được một file vô danh nên hai mode đó không thể tái lập.
 * Kiểm TƯỜNG MINH thay vì mặc định cho qua: `mode` thiếu/lạ sẽ khiến engine
 * không khớp nhánh nào và trả về một PDF RỖNG.
 */
export function isLinearRecipeMergeMode(mode: unknown): mode is 'merge_files' {
    return mode === 'merge_files';
}

/**
 * Tài liệu có thứ tự trang đã sắp lại hoặc có trang bị xoay hay không.
 *
 * RECIPE (audit 2026-08-16 §PLAY.3R): `pageOrder`/`pageRotations` là dữ liệu của
 * đúng tài liệu đang mở nên bị tước khỏi Step. Lượt chạy tay vẫn dùng chúng, vì
 * vậy người dùng phải được cảnh báo là Step ghi ra KHÔNG mang theo phần đó.
 */
export function hasDocumentBoundPageState(
    pageOrder?: number[] | null,
    pageRotations?: Record<number, number> | number[] | null,
): boolean {
    const reordered = Array.isArray(pageOrder)
        && pageOrder.some((pageNumber, index) => pageNumber !== index + 1);
    if (reordered) return true;
    const rotations = pageRotations
        ? Object.values(pageRotations as Record<string, number>)
        : [];
    return rotations.some((deg) => (((Number(deg) % 360) + 360) % 360) !== 0);
}

/** Định danh thao tác — khớp handler/tool key trong processHandlers + PreprocessingRouter. */
export type RecipeOpId =
    // Bình bài
    | 'booklet' | 'nup' | 'sticker_imposer' | 'cnc_imposer'
    // Tiền xử lý (engine pdf-lib / backend)
    | 'shuffle' | 'resize' | 'trim_shift' | 'split' | 'merge'
    // Tạo đường cắt / bù xén tem (dò contour server-side per-file → phát lại được)
    | 'sticker_dieline'
    // Prepress (backend REST)
    | 'convertcolors' | 'hairlines' | 'trapping' | 'pdfx' | 'ocr' | 'optimize' | 'spot_cmyk'
    // Overlay (FE)
    | 'watermark' | 'stick_text_number'
    // AI
    | 'bgremover' | 'upscale'
    // VDP (phụ thuộc XY → recordable=false ở v1)
    | 'datamerge' | 'numbering' | 'cover_numbering'
    // File/position-dependent (recordable=false)
    | 'object_edit' | 'crop' | 'page_index_op';

/** Loại input ngoài cần cung cấp lại khi phát lại. */
export type RecipeExternalInput = 'csv' | 'file';

export interface RecipeStep {
    /** Định danh thao tác. */
    opId: RecipeOpId;
    /** Nhãn hiển thị + tóm tắt tham số (cho UI danh sách). */
    label: string;
    /** Snapshot tham số đủ để phát lại độc lập với file gốc. */
    params: Record<string, unknown>;
    /** false = phụ thuộc file/vị trí → sẽ bị BỎ QUA + cảnh báo khi phát lại. */
    recordable: boolean;
    /** Cần input ngoài (CSV / file thứ hai) trước khi chạy khi phát lại. */
    needsExternalInput?: RecipeExternalInput | null;
    /** RECIPE (audit 2026-08-17 §PLAY.5R): số file ngoài cần cung cấp lại theo THỨ TỰ
     *  (vd Ghép nối tiếp A+B+C ghi trên A → cần 2 file B,C). Thiếu (recipe cũ) coi như 1. */
    externalInputCount?: number;
    /** Chụp thứ tự trang tại thời điểm ghi (1-based; -1 = trang trắng). */
    viewerPageOrder?: number[];
    /** Chụp góc xoay THEO VỊ TRÍ tại thời điểm ghi (out[i]=góc trang ở vị trí i trong
     *  viewerPageOrder). Đổi từ Record<pageNum,deg> để khớp per-instance rotation
     *  (bản nhân bản xoay độc lập). Recipe cũ dạng Record vẫn parse (JSON), nhưng phát
     *  lại chỉ đúng khi khớp thứ tự — recipe không mang instance-id. */
    viewerPageRotations?: number[];
}

export interface Recipe {
    id: string;
    name: string;
    description: string;
    /** ISO timestamp. */
    createdAt: string;
    /** ISO timestamp. */
    updatedAt: string;
    steps: RecipeStep[];
    /** Gợi ý áp dụng (vd số trang nguồn dự kiến). */
    hints?: { sourcePageCount?: number };
    /** Phiên bản schema để migrate sau này. */
    schemaVersion: number;
}

// ─────────────────────────── Helpers ───────────────────────────

function generateId(): string {
    return Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
}

/** Tạo Recipe mới từ danh sách step (gán id + timestamps + schemaVersion). */
export function createRecipe(
    name: string,
    steps: RecipeStep[],
    opts?: { description?: string; hints?: Recipe['hints'] },
): Recipe {
    const now = new Date().toISOString();
    return {
        id: generateId(),
        name,
        description: opts?.description ?? '',
        createdAt: now,
        updatedAt: now,
        steps: steps.map(cloneStep),
        hints: opts?.hints,
        schemaVersion: RECIPE_SCHEMA_VERSION,
    };
}

function cloneStep(s: RecipeStep): RecipeStep {
    return {
        opId: s.opId,
        label: s.label,
        // Deep-clone params (luôn JSON-serializable theo thiết kế) để Recipe độc lập nguồn.
        params: JSON.parse(JSON.stringify(s.params ?? {})),
        recordable: s.recordable,
        ...(s.needsExternalInput !== undefined ? { needsExternalInput: s.needsExternalInput } : {}),
        ...(typeof s.externalInputCount === 'number' ? { externalInputCount: s.externalInputCount } : {}),
        ...(s.viewerPageOrder ? { viewerPageOrder: [...s.viewerPageOrder] } : {}),
        ...(s.viewerPageRotations ? { viewerPageRotations: [...s.viewerPageRotations] } : {}),
    };
}

// ─────────────────────────── Type guards ───────────────────────────

export function isRecipeStep(x: unknown): x is RecipeStep {
    if (!x || typeof x !== 'object') return false;
    const s = x as Record<string, unknown>;
    return (
        typeof s.opId === 'string' &&
        typeof s.label === 'string' &&
        typeof s.recordable === 'boolean' &&
        !!s.params && typeof s.params === 'object' && !Array.isArray(s.params)
    );
}

export function isRecipe(x: unknown): x is Recipe {
    if (!x || typeof x !== 'object') return false;
    const r = x as Record<string, unknown>;
    return (
        typeof r.id === 'string' &&
        typeof r.name === 'string' &&
        typeof r.description === 'string' &&
        typeof r.createdAt === 'string' &&
        typeof r.updatedAt === 'string' &&
        typeof r.schemaVersion === 'number' &&
        Array.isArray(r.steps) &&
        r.steps.every(isRecipeStep)
    );
}

// ─────────────────────────── Serialize / Deserialize ───────────────────────────

/** Serialize Recipe ra chuỗi JSON (cho lưu trữ / export). */
export function serializeRecipe(recipe: Recipe): string {
    return JSON.stringify(recipe);
}

/**
 * Parse + validate Recipe từ chuỗi JSON.
 * @throws Error nếu JSON sai hoặc không đúng cấu trúc Recipe.
 */
export function deserializeRecipe(json: string): Recipe {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (e) {
        throw new Error('Recipe JSON không hợp lệ: ' + ((e as Error)?.message || e));
    }
    if (!isRecipe(parsed)) {
        throw new Error(tv('Dữ liệu không đúng cấu trúc Recipe.'));
    }
    return parsed;
}
