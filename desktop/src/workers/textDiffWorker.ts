/// <reference lib="webworker" />
/**
 * Web Worker so sánh văn bản — chạy NGOÀI main thread để không khoá UI.
 *
 * - Mặc định diff cấp TỪ (diffWordsWithSpace): nhanh hơn nhiều so với cấp ký tự,
 *   sinh ít part hơn → ít DOM node hơn, kết quả hợp lý cho QC chữ.
 * - mode='line' (diffLines): cho tài liệu lớn, nhanh nhất.
 * - ignoreSpaces: chuẩn hoá khoảng trắng (gộp về 1 space, trim) thay vì xoá hết
 *   để kết quả vẫn đọc được.
 */
import { diffWordsWithSpace, diffLines } from 'diff';

interface DiffRequest {
    a: string;
    b: string;
    mode: 'word' | 'line';
    ignoreSpaces: boolean;
}

interface DiffPart {
    value: string;
    added: boolean;
    removed: boolean;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<DiffRequest>) => {
    const { a, b, mode, ignoreSpaces } = e.data;
    try {
        const norm = (s: string) => (ignoreSpaces ? s.replace(/\s+/g, ' ').trim() : s);
        const aa = norm(a);
        const bb = norm(b);
        const result = mode === 'line' ? diffLines(aa, bb) : diffWordsWithSpace(aa, bb);
        const parts: DiffPart[] = result.map((p) => ({
            value: p.value,
            added: !!p.added,
            removed: !!p.removed,
        }));
        ctx.postMessage({ ok: true, parts });
    } catch (err: any) {
        ctx.postMessage({ ok: false, error: String(err?.message || err) });
    }
};
