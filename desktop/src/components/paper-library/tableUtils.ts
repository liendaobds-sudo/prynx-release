import {
    PAPER_STOCKS,
    type PaperFamily,
} from '../../lib/paperLibrary';

/** Định dạng số theo ngôn ngữ: vi dùng dấu phẩy thập phân. */
export function fmt(n: number, digits = 3, lang = 'vi'): string {
    const s = n.toFixed(digits);
    return lang.startsWith('vi') ? s.replace('.', ',') : s;
}

/** Định dạng số giữ đủ chữ số thập phân có nghĩa cho kết quả tính toán. */
export function fmtFull(n: number, minDigits = 3, lang = 'vi', maxDigits = 7): string {
    const raw = n.toFixed(maxDigits);
    const [intPart, decPart] = raw.split('.');
    const trimmed = decPart.replace(/0+$/, '');
    const dec = trimmed.padEnd(minDigits, '0');
    const s = `${intPart}.${dec}`;
    return lang.startsWith('vi') ? s.replace('.', ',') : s;
}

/** Thứ tự họ giấy hiển thị — khớp thứ tự cột trong workbook. */
export const FAMILY_ORDER: PaperFamily[] = [
    'couche',
    'couche_matt',
    'duplex',
    'bristol',
    'ivory',
    'fort',
    'art',
    'kraft',
    'other',
];

/** Đếm số dòng từng họ — dùng cho số bên cạnh mục sidebar. */
export const FAMILY_COUNTS: Record<PaperFamily, number> = FAMILY_ORDER.reduce(
    (acc, family) => {
        acc[family] = PAPER_STOCKS.filter(stock => stock.family === family).length;
        return acc;
    },
    {} as Record<PaperFamily, number>,
);
