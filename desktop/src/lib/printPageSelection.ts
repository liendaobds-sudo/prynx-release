import type { PrintPageSubset } from './nativePrint';

export type PageSelectionError =
    | { code: 'empty' }
    | { code: 'invalid_token'; token: string }
    | { code: 'out_of_range'; page: number; maxPage: number };

export interface ParsedPageSelection {
    pages: number[];
    error: PageSelectionError | null;
}

/**
 * Parse cú pháp trang kiểu Acrobat: `27-28,30-33`.
 * Range đảo chiều được chuẩn hóa tăng dần; trang trùng chỉ giữ lần xuất hiện đầu.
 */
export function parsePageSelection(value: string, maxPage: number): ParsedPageSelection {
    const text = value.trim();
    if (!text) return { pages: [], error: { code: 'empty' } };

    const safeMax = Math.max(1, Math.trunc(maxPage));
    const pages: number[] = [];
    const seen = new Set<number>();

    for (const rawToken of text.split(',')) {
        const token = rawToken.trim();
        const match = /^(\d+)(?:\s*[-–—]\s*(\d+))?$/.exec(token);
        if (!match) {
            return { pages: [], error: { code: 'invalid_token', token } };
        }

        const first = Number.parseInt(match[1], 10);
        const last = match[2] ? Number.parseInt(match[2], 10) : first;
        for (const page of [first, last]) {
            if (page < 1 || page > safeMax) {
                return {
                    pages: [],
                    error: { code: 'out_of_range', page, maxPage: safeMax },
                };
            }
        }

        const start = Math.min(first, last);
        const end = Math.max(first, last);
        for (let page = start; page <= end; page += 1) {
            if (!seen.has(page)) {
                seen.add(page);
                pages.push(page);
            }
        }
    }

    return { pages, error: null };
}

/** Nén danh sách tăng liên tiếp về dạng `27-28,30-33`, giữ thứ tự nhóm đã chọn. */
export function formatPageSelection(input: readonly number[]): string {
    const pages: number[] = [];
    const seen = new Set<number>();
    for (const value of input) {
        const page = Math.trunc(value);
        if (page >= 1 && !seen.has(page)) {
            seen.add(page);
            pages.push(page);
        }
    }
    if (pages.length === 0) return '';

    const groups: string[] = [];
    let start = pages[0];
    let end = start;
    for (let index = 1; index < pages.length; index += 1) {
        const page = pages[index];
        if (page === end + 1) {
            end = page;
            continue;
        }
        groups.push(start === end ? String(start) : `${start}-${end}`);
        start = page;
        end = page;
    }
    groups.push(start === end ? String(start) : `${start}-${end}`);
    return groups.join(',');
}

/** Snapshot index thumbnail 0-based thành trang 1-based theo đúng thứ tự PDF đang hiển thị. */
export function pageIndicesToPageNumbers(
    indices: readonly number[],
    maxPage: number,
): number[] {
    const safeMax = Math.max(0, Math.trunc(maxPage));
    return Array.from(new Set(indices.map(Math.trunc)))
        .filter(index => index >= 0 && index < safeMax)
        .sort((a, b) => a - b)
        .map(index => index + 1);
}

/** Cùng thứ tự áp dụng với Rust: danh sách gốc → lọc lẻ/chẵn → đảo thứ tự. */
export function applyPageSubsetAndReverse(
    input: readonly number[],
    subset: PrintPageSubset,
    reverse: boolean,
): number[] {
    const pages = input.filter(page => (
        subset === 'all'
        || (subset === 'odd' && page % 2 === 1)
        || (subset === 'even' && page % 2 === 0)
    ));
    return reverse ? [...pages].reverse() : pages;
}
