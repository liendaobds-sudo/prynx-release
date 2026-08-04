// UIUX (audit 2026-08-04 §DIM.1): mọi số đo sản xuất phải giữ ít nhất 0,1 mm
// và dùng cùng quy tắc ROUND_HALF_UP với formatter report phía backend.
export function roundMeasurement(value: number, digits = 1): number {
    if (!Number.isFinite(value)) return Number.NaN;
    const safeDigits = Math.min(6, Math.max(0, Math.trunc(digits)));
    const factor = 10 ** safeDigits;
    const sign = value < 0 ? -1 : 1;
    const rounded = sign * Math.round((Math.abs(value) + Number.EPSILON) * factor) / factor;
    return Object.is(rounded, -0) ? 0 : rounded;
}

/** Định dạng số đo gọn: giữ chữ số có nghĩa, bỏ `.0` thừa. */
export function formatMeasurement(value: number, digits = 1): string {
    const rounded = roundMeasurement(value, digits);
    if (!Number.isFinite(rounded)) return '';
    const safeDigits = Math.min(6, Math.max(0, Math.trunc(digits)));
    return rounded
        .toFixed(safeDigits)
        .replace(/(?:\.0+|(\.\d+?)0+)$/, '$1');
}

export function formatSizeMm(widthMm: number, heightMm: number, digits = 1): string {
    const width = formatMeasurement(widthMm, digits);
    const height = formatMeasurement(heightMm, digits);
    return width && height ? `${width} × ${height} mm` : '';
}
