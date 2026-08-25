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
import type { DiffPart, TextDiffRequest, TextDiffWorkerResponse } from './textDiffProtocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<TextDiffRequest>) => {
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
        const response: TextDiffWorkerResponse = { ok: true, parts };
        ctx.postMessage(response);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const response: TextDiffWorkerResponse = { ok: false, error: message };
        ctx.postMessage(response);
    }
};
