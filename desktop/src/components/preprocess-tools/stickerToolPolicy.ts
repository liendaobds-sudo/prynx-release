// BUILD (audit 2026-08-03 §REL.05): policy thuần nằm ngoài component để test và
// Fast Refresh không phải nạp lại toàn bộ công cụ Bế tem.
export const ALPHA_CONTOUR_INSET_MM = 0.15;
export const DEFAULT_CROP_TO_STICKER = true;

export const CUT_MODES_RICH = [
    { value: 'original', title: '✂️ Theo hình gốc', desc: 'Cắt bám theo viền ảnh hoặc vector.' },
    { value: 'alpha', title: '🧩 Theo biên trong suốt PNG', desc: 'Dùng kênh trong suốt còn lưu trong PDF, giữ viền trắng và tự lùi đường cắt 0,15 mm để tránh mép bán trong suốt.' },
    { value: 'bleed', title: '🩸 Theo mép tràn lề', desc: 'Đường cắt = mép ngoài lề bù xén (bao luôn tràn màu). Không cắt giữa vành.' },
    { value: 'none', title: '🚫 Không vẽ đường cắt', desc: 'Chỉ mở nền (tràn màu).' },
];

export const BLEED_COLOR_MODES_STICKER = [
    { value: 'image', title: '🖼️ Lấy theo màu viền tem', desc: 'Lấy đúng màu dọc viền tem (bỏ AA/trắng mép), kéo ra vùng bù xén. Bật “Bỏ nền trắng” khi file có nền trắng quanh tem.' },
    { value: 'trajectory', title: '🧭 Theo quỹ đạo dải màu', desc: 'Tem chữ nhật tiếp tục dải màu theo hướng tại mép. Contour khác tự lấy theo màu viền tem để giữ bù xén an toàn.' },
    { value: 'inpaint', title: '✨ Làm mượt thông minh', desc: 'CHỈ hợp mép ảnh chụp/gradient mềm. KHÔNG hợp dải màu phẳng (logo, tem chữ) — sẽ loang, mất nét. Dải màu phẳng nên chọn "Lấy theo màu viền tem".' },
    { value: 'solid', title: '🎨 Đổ màu trơn', desc: 'Bo viền nền bằng hệ màu in ấn chuyên nghiệp (CMYK).' },
];

// UIUX (audit 2026-08-02 §CROP-STICKER.2): chỉ crop khi đang ở tab Bế tem
// và có đường cắt; chế độ "Không vẽ đường cắt" không được tự đổi khổ trang.
export function shouldCropStickerPage(
    productType: 'sticker' | 'rectangle',
    cutMode: string,
    cropToSticker: boolean,
): boolean {
    return productType === 'sticker' && cutMode !== 'none' && cropToSticker;
}

export function normalizeStickerBleedColorType(
    bleedColorType: string,
    productType: 'sticker' | 'rectangle',
): string {
    // UIUX (audit 2026-08-01 §BT.1): mirror chưa có hình học contour;
    // trajectory được giữ lại vì backend tự nhận tem chữ nhật và fallback an toàn.
    return productType === 'sticker' && bleedColorType === 'mirror' ? 'image' : bleedColorType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hợp đồng payload dùng chung — AUDIT (2026-08-16 §BX.F01/F02/F07/F13)
//
// Trước đợt này có BA công thức khác nhau cho cùng một thao tác: `StickerTool`
// lúc chạy tay, `StickerTool` lúc ghi recipe, và `recipeRunners` lúc phát lại.
// Với mặc định `cornerStyle='preserve'` thì chạy tay gửi `auto_safe` còn phát lại
// gửi `contour` → khuôn bế phát lại KHÁC bản người dùng đã duyệt. Mọi nơi phải
// gọi các hàm thuần dưới đây, không tự viết lại điều kiện.
// ─────────────────────────────────────────────────────────────────────────────

export type StickerProductType = 'sticker' | 'rectangle';

/** Cạnh nào được bù xén (chỉ có nghĩa với Xén vuông góc). */
export type StickerBleedSideKey = 'top' | 'right' | 'bottom' | 'left';
export const STICKER_BLEED_SIDE_KEYS: readonly StickerBleedSideKey[] = ['top', 'right', 'bottom', 'left'];

/** Giới hạn PHẢI trùng với `min`/`max` của các ô nhập trong StickerTool. */
export const STICKER_PARAM_LIMITS = {
    bleedMm: { min: 0, max: 10 },
    offsetMm: { min: -10, max: 10 },
    edgeBiteMm: { min: 0, max: 5 },
} as const;

/** Ép về số hữu hạn trong khoảng cho phép. Recipe sửa tay / build cũ có thể mang NaN. */
export function clampStickerMm(
    value: unknown,
    limit: { min: number; max: number },
    fallback = 0,
): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(limit.max, Math.max(limit.min, numeric));
}

/**
 * Hình học đường cắt gửi xuống backend.
 *
 * `alpha` luôn `contour` (biên trong suốt không được ép về hình chuẩn).
 * QUALITY (audit 2026-08-07 §NOODLE.2): "Giữ góc" chỉ chọn cách xuất góc của
 * contour custom, KHÔNG được âm thầm tắt nhận dạng hình chuẩn — chỉ van an toàn
 * `forceContour` của người dùng mới ép `contour`.
 */
export function resolveStickerShapeMode(input: {
    productType: StickerProductType;
    cutMode: string;
    forceContour?: boolean;
}): 'contour' | 'auto_safe' {
    if (input.productType !== 'sticker') return 'contour';
    if (input.cutMode === 'alpha') return 'contour';
    return input.forceContour ? 'contour' : 'auto_safe';
}

/**
 * "Độ lẹm mép" chỉ có ô nhập với ba kiểu màu lấy từ ảnh. Ô ẩn mà vẫn gửi giá trị cũ
 * thì engine vẫn clip artwork → mất nội dung sát mép mà không chỗ nào nói ra
 * (AUDIT 2026-08-16 §BX.F02).
 */
export const STICKER_EDGE_BITE_COLOR_TYPES: readonly string[] = ['image', 'trajectory', 'inpaint'];

export function resolveStickerEdgeBiteMm(input: {
    productType: StickerProductType;
    bleedColorType: string;
    edgeBiteMm: unknown;
}): number {
    if (input.productType !== 'rectangle') return 0;
    if (!STICKER_EDGE_BITE_COLOR_TYPES.includes(input.bleedColorType)) return 0;
    return clampStickerMm(input.edgeBiteMm, STICKER_PARAM_LIMITS.edgeBiteMm);
}

/** Kiểu góc gửi xuống backend. `alpha` phải giữ nguyên góc để không bo mất mép mềm. */
export function resolveStickerCornerStyle(input: {
    productType: StickerProductType;
    cutMode: string;
    cornerStyle: string;
}): string {
    if (input.productType === 'rectangle') return 'miter';
    if (input.cutMode === 'alpha') return 'preserve';
    return input.cornerStyle || 'preserve';
}

/** "Bỏ nền trắng" vô nghĩa khi đã có kênh alpha thật, và không dùng ở Xén vuông góc. */
export function resolveStickerRemoveWhiteBg(input: {
    productType: StickerProductType;
    cutMode: string;
    removeWhiteBg: boolean;
}): boolean {
    if (input.productType === 'rectangle') return false;
    if (input.cutMode === 'alpha') return false;
    return !!input.removeWhiteBg;
}

/** Payload backend: danh sách cạnh ĐANG bật. Thiếu field = nở đều 4 cạnh. */
export function stickerBleedSidesToParam(
    sides: Partial<Record<StickerBleedSideKey, boolean>> | undefined,
): string {
    const active = STICKER_BLEED_SIDE_KEYS.filter(side => sides?.[side] !== false);
    // Không bao giờ gửi rỗng: UI đã chặn trạng thái 0 cạnh, muốn tắt bù xén thì đặt
    // Bù xén = 0. Rơi vào đây nghĩa là dữ liệu hỏng → nở đều như mặc định cũ.
    return (active.length > 0 ? active : STICKER_BLEED_SIDE_KEYS).join(',');
}

export interface StickerDielineFormInput {
    productType: StickerProductType;
    cutMode: string;
    offsetMm: unknown;
    cornerStyle: string;
    /** Độ bo 0–100. Recipe cũ không có field này phải giữ artifact mặc định 50. */
    curveTension?: unknown;
    fillHoles: boolean;
    bleedMm: unknown;
    removeWhiteBg: boolean;
    bleedColorType: string;
    bleedColorHex: string;
    edgeBiteMm: unknown;
    cutFirstPageOnly: boolean;
    cropToSticker: boolean;
    bleedSides?: Partial<Record<StickerBleedSideKey, boolean>>;
    forceContour?: boolean;
    /**
     * Thanh "Khử răng cưa" 0–100 (§CUTJAG.3). Recipe cũ không có field này nên
     * `undefined` phải giữ đúng hành vi cũ: 0 = tắt.
     */
    cutlineDenoise?: unknown;
}

/** Kẹp thanh khử răng cưa về 0–100; giá trị lạ hoặc thiếu trả 0 (tắt). */
export function resolveStickerCutlineDenoise(value: unknown): number {
    const resolved = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(resolved)) return 0;
    return Math.round(Math.max(0, Math.min(100, resolved)));
}

/** Kẹp độ bo về 0–100; dữ liệu cũ/không hợp lệ dùng mốc tương thích 50. */
export function resolveStickerCurveTension(value: unknown): number {
    if (value === null || value === undefined) return 50;
    if (typeof value !== 'number' && typeof value !== 'string') return 50;
    if (typeof value === 'string' && value.trim() === '') return 50;
    const resolved = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(resolved)) return 50;
    return Math.round(Math.max(0, Math.min(100, resolved)));
}

/**
 * Dựng đủ các field hình học của `POST /pdf-tools/sticker-dieline`.
 *
 * KHÔNG gắn `file_id`/`file_path`/`selection_json` — caller tự thêm vì mỗi luồng
 * lấy nguồn khác nhau. Trả về map để caller nạp vào `FormData` và cũng để test so
 * sánh payload chạy tay với payload phát lại recipe.
 */
export function buildStickerDielineFields(
    input: StickerDielineFormInput,
): Record<string, string> {
    const isRectangle = input.productType === 'rectangle';
    const cutMode = isRectangle ? 'none' : (input.cutMode || 'original');
    const shapeMode = resolveStickerShapeMode({
        productType: input.productType,
        cutMode: input.cutMode,
        forceContour: input.forceContour,
    });
    const cornerStyle = resolveStickerCornerStyle({
        productType: input.productType,
        cutMode: input.cutMode,
        cornerStyle: input.cornerStyle,
    });
    // Hidden-state invariant: Alpha/Xén vuông/Không vẽ đường cắt và các kiểu góc
    // không bo không được nhận mức cũ của thanh kéo. Mốc 50 giữ artifact tương thích.
    const curveTension = (
        !isRectangle
        && cutMode !== 'none'
        && cornerStyle === 'round'
    ) ? resolveStickerCurveTension(input.curveTension) : 50;
    return {
        cut_mode: cutMode,
        offset_mm: isRectangle
            ? '0'
            : String(clampStickerMm(input.offsetMm, STICKER_PARAM_LIMITS.offsetMm)),
        corner_style: cornerStyle,
        curve_tension: String(curveTension),
        bleed_mm: String(clampStickerMm(input.bleedMm, STICKER_PARAM_LIMITS.bleedMm)),
        fill_holes: isRectangle ? 'true' : (input.fillHoles ? 'true' : 'false'),
        remove_white_bg: resolveStickerRemoveWhiteBg({
            productType: input.productType,
            cutMode: input.cutMode,
            removeWhiteBg: input.removeWhiteBg,
        }) ? 'true' : 'false',
        draw_cut_contour: isRectangle ? 'false' : (cutMode !== 'none' ? 'true' : 'false'),
        bleed_color_type: normalizeStickerBleedColorType(input.bleedColorType, input.productType),
        bleed_color_hex: input.bleedColorHex || '#FFFFFF',
        edge_bite_mm: String(resolveStickerEdgeBiteMm({
            productType: input.productType,
            bleedColorType: input.bleedColorType,
            edgeBiteMm: input.edgeBiteMm,
        })),
        // Bế tem nhãn bù xén quanh đường contour nên "trên/dưới/trái/phải" không có
        // nghĩa hình học ở đó → luôn "all" để backend nở đều như build cũ.
        bleed_sides: isRectangle ? stickerBleedSidesToParam(input.bleedSides) : 'all',
        cut_first_page_only: (!isRectangle && input.cutFirstPageOnly) ? 'true' : 'false',
        crop_to_sticker: shouldCropStickerPage(input.productType, input.cutMode, input.cropToSticker)
            ? 'true'
            : 'false',
        shape_mode: shapeMode,
        rectangle_mode: isRectangle ? 'true' : 'false',
        // §CUTJAG.3: Xén vuông góc không dò contour nên thanh khử răng cưa vô nghĩa.
        cutline_denoise: (isRectangle || cutMode === 'none')
            ? '0'
            : String(resolveStickerCutlineDenoise(input.cutlineDenoise)),
    };
}
