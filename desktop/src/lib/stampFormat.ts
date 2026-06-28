/**
 * stampFormat — Bộ định dạng số trang & lề dùng CHUNG cho Header/Footer.
 *
 * Dùng ở CẢ hai nơi để đảm bảo PARITY preview (LivePageFrame) ≡ output
 * (StickTextNumberTool): nếu chỉ sửa một bên, preview sẽ lệch output.
 */

export type NumberStyle =
  | 'arabic'        // 1, 2, 3
  | 'roman_lower'   // i, ii, iii
  | 'roman_upper'   // I, II, III
  | 'alpha_lower'   // a, b, c
  | 'alpha_upper';  // A, B, C

export const NUMBER_STYLES: { value: NumberStyle; label: string }[] = [
  { value: 'arabic', label: 'Số (1, 2, 3)' },
  { value: 'roman_lower', label: 'La Mã thường (i, ii)' },
  { value: 'roman_upper', label: 'La Mã hoa (I, II)' },
  { value: 'alpha_lower', label: 'Chữ thường (a, b)' },
  { value: 'alpha_upper', label: 'Chữ hoa (A, B)' },
];

function toRoman(n: number): string {
  if (n <= 0) return String(n);
  const map: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  let v = n;
  for (const [val, sym] of map) {
    while (v >= val) { out += sym; v -= val; }
  }
  return out;
}

function toAlpha(n: number): string {
  // 1→a, 26→z, 27→aa, 28→ab… (bijective base-26)
  if (n <= 0) return String(n);
  let out = '';
  let v = n;
  while (v > 0) {
    v--;
    out = String.fromCharCode(97 + (v % 26)) + out;
    v = Math.floor(v / 26);
  }
  return out;
}

/** Định dạng một số trang theo kiểu chọn. padLength chỉ áp dụng cho kiểu Số (Ả Rập). */
export function formatPageNumber(n: number, style: NumberStyle = 'arabic', padLength = 1): string {
  switch (style) {
    case 'roman_lower': return toRoman(n);
    case 'roman_upper': return toRoman(n).toUpperCase();
    case 'alpha_lower': return toAlpha(n);
    case 'alpha_upper': return toAlpha(n).toUpperCase();
    case 'arabic':
    default: return String(n).padStart(Math.max(1, padLength || 1), '0');
  }
}

/** Thay token [page]/[date]/[total] trong một ô. */
export function applyTokens(content: string, numStr: string, totalStr: string, dateStr: string): string {
  return content
    .replace(/\[page\]/gi, numStr)
    .replace(/\[total\]/gi, totalStr)
    .replace(/\[date\]/gi, dateStr);
}

/**
 * Lề TRÁI/PHẢI hiệu lực khi bật "lề gương 2 mặt" (inside/outside).
 * Quy ước đóng cuốn: trang LẺ (1-based) = trang phải (recto), gáy bên TRÁI
 * → inside = left. Trang CHẴN = trang trái (verso), gáy bên PHẢI → hoán đổi
 * left/right để lề trong luôn nằm phía gáy. Tắt mirror → giữ nguyên.
 */
export function effectiveLR(
  left: number, right: number, pageNum1Based: number, mirror: boolean
): { left: number; right: number } {
  if (mirror && pageNum1Based % 2 === 0) return { left: right, right: left };
  return { left, right };
}
