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
