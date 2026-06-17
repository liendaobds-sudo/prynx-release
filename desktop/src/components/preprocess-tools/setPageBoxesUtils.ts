/**
 * setPageBoxesUtils — hàm thuần cho tính năng Set Page Boxes.
 *
 * Quy đổi đơn vị (pt/mm/inch/cm ↔ mm), xác thực rectangle, và phân giải phạm vi
 * trang. Tách riêng để property-test (fast-check) độc lập với React.
 *
 * Hệ số quy đổi chuẩn: 1 inch = 25.4 mm; 1 pt = 1/72 inch = 25.4/72 mm.
 */

export type Unit = 'pt' | 'mm' | 'inch' | 'cm';
export type BoxType = 'mediabox' | 'cropbox' | 'trimbox' | 'bleedbox' | 'artbox';

export interface RectUnit {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type PageScope = 'single' | 'range' | 'all';

/** Số mm cho mỗi 1 đơn vị. */
export const MM_PER_UNIT: Record<Unit, number> = {
  mm: 1,
  cm: 10,
  inch: 25.4,
  pt: 25.4 / 72,
};

/** Quy đổi giá trị theo đơn vị `u` sang mm. */
export function toMm(v: number, u: Unit): number {
  return v * MM_PER_UNIT[u];
}

/** Quy đổi giá trị mm sang đơn vị `u`. */
export function fromMm(mm: number, u: Unit): number {
  return mm / MM_PER_UNIT[u];
}

/** Làm tròn mm về 2 chữ số thập phân (khớp backend). */
export function roundMm2(mm: number): number {
  return Math.round(mm * 100) / 100;
}

/**
 * Xác thực rectangle (theo đơn vị đang chọn) (Yêu cầu 13.3, 13.4).
 * Trả thông báo lỗi (string) nếu không hợp lệ, hoặc null nếu hợp lệ.
 */
export function validateRectUnit(r: RectUnit): string | null {
  const vals = [r.x0, r.y0, r.x1, r.y1];
  if (vals.some((n) => Number.isNaN(n) || !Number.isFinite(n))) {
    return 'Giá trị nhập không phải số hợp lệ';
  }
  if (r.x1 <= r.x0) return 'x1 phải lớn hơn x0';
  if (r.y1 <= r.y0) return 'y1 phải lớn hơn y0';
  return null;
}

export type ResolvePagesResult = { pages: number[] | null } | { error: string };

/**
 * Phân giải phạm vi trang thành danh sách 1-indexed hoặc null (tất cả)
 * (Yêu cầu 14.2, 14.3, 14.4, 14.5).
 */
export function resolvePages(
  scope: PageScope,
  start: number,
  end: number,
  total: number,
): ResolvePagesResult {
  if (scope === 'all') return { pages: null };

  if (scope === 'single') {
    if (!Number.isInteger(start) || start < 1 || start > total) {
      return { error: `Trang hợp lệ: 1–${total}` };
    }
    return { pages: [start] };
  }

  // range
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { error: `Trang hợp lệ: 1–${total}` };
  }
  if (start > end) return { error: 'Trang bắt đầu phải ≤ trang kết thúc' };
  if (start < 1 || end > total) return { error: `Trang hợp lệ: 1–${total}` };
  return { pages: Array.from({ length: end - start + 1 }, (_, i) => start + i) };
}
