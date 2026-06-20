/**
 * recipeOps — NGUỒN CHÂN LÝ phân loại & nhãn cho từng thao tác Recipe.
 *
 * Spec: .kiro/specs/recipe-record-playback (Task 2).
 * File CỐ Ý thuần (không import store/component/processHandlers) để test trọn vẹn.
 * Việc ĐỌC params từ store xảy ra ở call-site (recorder/handlers, Task 5) rồi
 * truyền vào `buildRecipeStep`. Việc CHẠY lại (run) thuộc PlaybackRunner (Task 6).
 */
import type { RecipeOpId, RecipeExternalInput, RecipeStep } from './recipeTypes';

export type RecipeOpGroup =
    | 'imposition' | 'preprocess' | 'merge' | 'prepress' | 'overlay' | 'ai' | 'vdp' | 'edit';

export interface RecipeOpMeta {
    /** Nhãn cơ sở (tiếng Việt) hiển thị trong danh sách bước. */
    label: string;
    /** false = phụ thuộc file/vị trí → BỎ QUA + cảnh báo khi phát lại (v1). */
    recordable: boolean;
    /** Cần input ngoài khi phát lại (CSV / file thứ hai). */
    needsExternalInput: RecipeExternalInput | null;
    group: RecipeOpGroup;
}

/**
 * Bảng metadata cho TOÀN BỘ RecipeOpId. `Record<RecipeOpId, …>` ép TypeScript
 * kiểm tra ĐỦ KHÓA lúc biên dịch → thêm op mới mà quên phân loại sẽ lỗi build.
 *
 * Phân loại v1 theo audit:
 *  - Bình bài / tiền xử lý / prepress / overlay / AI → recordable (param-based).
 *  - merge cần file thứ hai; datamerge cần CSV.
 *  - VDP (đặt field theo XY) + edit/crop/page-index → recordable=false (v1).
 */
export const RECIPE_OP_META: Record<RecipeOpId, RecipeOpMeta> = {
    // ── Bình bài ──
    // booklet/nup page-based (hình học suy từ page box → tất định).
    booklet: { label: 'Bình sách', recordable: true, needsExternalInput: null, group: 'imposition' },
    nup: { label: 'Bình cắt xén (N-Up)', recordable: true, needsExternalInput: null, group: 'imposition' },
    // sticker/cnc né va chạm theo HÌNH dò per-file. PHÁT LẠI ĐƯỢC vì khi phát lại
    // runner DÒ LẠI hình trên file mới (/imposition/detect-shape) rồi mới bình →
    // không đóng băng hình cũ. Params chỉ lưu khổ/grid/pont, KHÔNG lưu shape.
    sticker_imposer: { label: 'Bình tem bế', recordable: true, needsExternalInput: null, group: 'imposition' },
    cnc_imposer: { label: 'Bình bế rớt (CNC)', recordable: true, needsExternalInput: null, group: 'imposition' },
    // ── Tiền xử lý (engine) ──
    shuffle: { label: 'Xáo trộn trang', recordable: true, needsExternalInput: null, group: 'preprocess' },
    resize: { label: 'Co giãn trang', recordable: true, needsExternalInput: null, group: 'preprocess' },
    split: { label: 'Tách file', recordable: true, needsExternalInput: null, group: 'preprocess' },
    // Tạo đường cắt / bù xén tem: dò contour server-side mỗi file → tất định, phát lại được.
    sticker_dieline: { label: 'Tạo đường cắt (bù xén)', recordable: true, needsExternalInput: null, group: 'preprocess' },
    // ── Ghép (cần file thứ hai) ──
    merge: { label: 'Ghép & Trộn PDF', recordable: true, needsExternalInput: 'file', group: 'merge' },
    // ── Prepress (backend) ──
    convertcolors: { label: 'Chuyển hệ màu', recordable: true, needsExternalInput: null, group: 'prepress' },
    hairlines: { label: 'Sửa nét mảnh', recordable: true, needsExternalInput: null, group: 'prepress' },
    trapping: { label: 'Chồng tràn (Trapping)', recordable: true, needsExternalInput: null, group: 'prepress' },
    pdfx: { label: 'Xuất PDF/X', recordable: true, needsExternalInput: null, group: 'prepress' },
    ocr: { label: 'OCR', recordable: true, needsExternalInput: null, group: 'prepress' },
    optimize: { label: 'Nén / Tối ưu', recordable: true, needsExternalInput: null, group: 'prepress' },
    spot_cmyk: { label: 'Spot → CMYK', recordable: true, needsExternalInput: null, group: 'prepress' },
    // ── Overlay (FE) ──
    watermark: { label: 'Chèn nền & đóng dấu', recordable: true, needsExternalInput: null, group: 'overlay' },
    stick_text_number: { label: 'Header & Footer', recordable: true, needsExternalInput: null, group: 'overlay' },
    // ── AI (công cụ ảnh tương tác, KHÔNG nằm trong chuỗi PDF) — v1 không phát lại ──
    // bgremover/upscale chạy theo lô ẢNH với store + preview riêng (useBgRemoverStore),
    // không đi qua commitWorkingFile của working PDF → không ghép được vào recipe tuyến tính.
    bgremover: { label: 'Tách nền AI', recordable: false, needsExternalInput: null, group: 'ai' },
    upscale: { label: 'AI Upscale', recordable: false, needsExternalInput: null, group: 'ai' },
    // ── VDP (đặt field theo XY) — v1 chưa phát lại được ──
    datamerge: { label: 'Trộn dữ liệu VDP', recordable: false, needsExternalInput: 'csv', group: 'vdp' },
    numbering: { label: 'Nhảy số tự động', recordable: false, needsExternalInput: null, group: 'vdp' },
    cover_numbering: { label: 'Mẹc bìa', recordable: false, needsExternalInput: null, group: 'vdp' },
    // ── File/position-dependent ──
    object_edit: { label: 'Sửa đối tượng', recordable: false, needsExternalInput: null, group: 'edit' },
    crop: { label: 'Cắt khổ / Set Page Boxes', recordable: false, needsExternalInput: null, group: 'edit' },
    page_index_op: { label: 'Thao tác trang theo vị trí', recordable: false, needsExternalInput: null, group: 'edit' },
};

// ─────────────────────────── Helpers ───────────────────────────

export function isRecordableOp(opId: RecipeOpId): boolean {
    return RECIPE_OP_META[opId]?.recordable ?? false;
}

export function externalInputFor(opId: RecipeOpId): RecipeExternalInput | null {
    return RECIPE_OP_META[opId]?.needsExternalInput ?? null;
}

export function opBaseLabel(opId: RecipeOpId): string {
    return RECIPE_OP_META[opId]?.label ?? opId;
}

/** Tóm tắt ngắn gọn tham số cho nhãn hiển thị (không bắt buộc đầy đủ). */
export function summarizeParams(opId: RecipeOpId, params: Record<string, unknown> = {}): string {
    const p = params as any;
    switch (opId) {
        case 'booklet':
        case 'nup':
        case 'sticker_imposer':
        case 'cnc_imposer': {
            const w = p.sheetWidth, h = p.sheetHeight;
            const sheet = (w && h) ? `${w}×${h}mm` : '';
            const grid = (p.cols && p.rows) ? `${p.cols}×${p.rows}` : (p.gridStrategy || '');
            return [sheet, grid].filter(Boolean).join(' · ');
        }
        case 'convertcolors':
            return Array.isArray(p.conversions) ? p.conversions.join(', ') : '';
        case 'pdfx':
            return p.standard ? String(p.standard).toUpperCase() : '';
        case 'resize':
            return (p.targetW && p.targetH) ? `${p.targetW}×${p.targetH}mm` : (p.scaleMode || '');
        case 'split':
            return p.mode || '';
        case 'sticker_dieline':
            return [p.productType === 'rectangle' ? 'Xén vuông' : 'Bế tem',
                    p.bleedMm ? `bù ${p.bleedMm}mm` : ''].filter(Boolean).join(' · ');
        case 'optimize':
            return p.preset || '';
        case 'shuffle':
            return p.specialAction || p.presetId || '';
        case 'merge':
            return p.mode || '';
        case 'watermark':
            return p.watermarkType || '';
        default:
            return '';
    }
}

/**
 * Dựng một RecipeStep từ opId + params (đã chụp ở call-site), tự gán
 * recordable/needsExternalInput theo metadata. Deep-clone params để độc lập nguồn.
 */
export function buildRecipeStep(
    opId: RecipeOpId,
    params: Record<string, unknown>,
    extras?: { viewerPageOrder?: number[]; viewerPageRotations?: Record<number, number> },
): RecipeStep {
    const meta = RECIPE_OP_META[opId];
    const summary = summarizeParams(opId, params);
    return {
        opId,
        label: summary ? `${meta.label} — ${summary}` : meta.label,
        params: JSON.parse(JSON.stringify(params ?? {})),
        recordable: meta.recordable,
        needsExternalInput: meta.needsExternalInput,
        ...(extras?.viewerPageOrder ? { viewerPageOrder: [...extras.viewerPageOrder] } : {}),
        ...(extras?.viewerPageRotations ? { viewerPageRotations: { ...extras.viewerPageRotations } } : {}),
    };
}
