export interface StickerBleedGeometry {
    cutOffsetMm: number | null;
    outerOffsetMm: number;
    bleedOutsideCutMm: number | null;
}

/**
 * UIUX (audit 2026-07-28 §BX.6): phản chiếu đúng công thức backend để UI nói rõ
 * các khoảng cách đang được đo từ mép hình gốc hay từ đường cắt cuối cùng.
 */
export function computeStickerBleedGeometry(
    cutMode: string,
    offsetMm: number,
    bleedMm: number,
): StickerBleedGeometry {
    const safeOffset = Number.isFinite(offsetMm) ? offsetMm : 0;
    const safeBleed = Number.isFinite(bleedMm) ? Math.max(0, bleedMm) : 0;

    if (cutMode === 'none') {
        return {
            cutOffsetMm: null,
            outerOffsetMm: safeBleed,
            bleedOutsideCutMm: null,
        };
    }
    if (cutMode === 'bleed' && safeBleed > 0) {
        const edge = safeOffset + safeBleed;
        return {
            cutOffsetMm: edge,
            outerOffsetMm: edge,
            bleedOutsideCutMm: 0,
        };
    }

    const outerOffsetMm = safeOffset + safeBleed;
    return {
        cutOffsetMm: safeOffset,
        outerOffsetMm,
        bleedOutsideCutMm: safeBleed,
    };
}

export function formatSignedMm(value: number): string {
    const rounded = Number(value.toFixed(2));
    if (rounded > 0) return `+${rounded}`;
    return String(rounded);
}

