/**
 * savePrintFiles.ts — Ghi file in ra ổ cứng (Tauri fs).
 *
 * NGUỒN CHÂN LÝ DUY NHẤT cho việc tách + ghi file in: dùng chung bởi
 *   - SavePrintFilesModal (lưu thủ công)
 *   - processHandlers (tự động lưu sau khi bình)
 * → tránh phân kỳ logic.
 */
import { buildSavePlan, type SaveTypeInfo, type SavePlanConfig } from './printFileNaming';

export interface SavePrintOptions {
    /** Danh sách loại (label + số tờ). Nếu rỗng, tự suy từ số trang PDF. */
    types?: SaveTypeInfo[];
    /** Số trang mỗi đơn vị để suy số loại khi không truyền types. */
    pagesPerType: number;
    /** Nhãn mặc định khi tự suy. */
    labelName?: string;
    /** Callback tiến trình (tuỳ chọn). */
    onProgress?: (done: number, total: number) => void;
}

/** Tách PDF kết quả theo kế hoạch và ghi từng file ra `folder`. */
export async function savePrintFilesToFolder(
    resultBlob: Blob,
    folder: string,
    cfg: SavePlanConfig,
    opts: SavePrintOptions,
): Promise<{ ok: number; total: number }> {
    const { PDFDocument } = await import('pdf-lib');
    const fs = await import('@tauri-apps/plugin-fs');
    const { invoke } = await import('@tauri-apps/api/core');
    // Ghi NGUYÊN TỬ qua lệnh Rust (temp+rename) — nhất quán với đường lưu chính, chống
    // file in cụt/hỏng nếu crash giữa lúc ghi.
    const atomicWrite = (p: string, data: Uint8Array) =>
        invoke('write_file_atomic', { path: p, contents: data });

    const srcBytes = new Uint8Array(await resultBlob.arrayBuffer());
    const srcDoc = await PDFDocument.load(srcBytes);
    const pageCount = srcDoc.getPageCount();

    let types = opts.types;
    if (!types || !types.length) {
        const per = Math.max(1, opts.pagesPerType || 1);
        const count = Math.max(1, Math.floor(pageCount / per));
        types = Array.from({ length: count }, (_, i) => ({
            label: opts.labelName || `Trang ${i + 1}`,
            sheetCount: 0,
        }));
    }

    const plan = buildSavePlan(types, cfg);
    const sep = folder.includes('\\') ? '\\' : '/';
    const joined = (...p: string[]) => p.filter(Boolean).join(sep);

    const dirs = new Set(plan.map(it => it.folder).filter(Boolean));
    for (const d of dirs) {
        try { await fs.mkdir(joined(folder, d.split('/').join(sep)), { recursive: true }); } catch { /* đã tồn tại */ }
    }

    const used = new Set<string>();
    let ok = 0;
    for (const it of plan) {
        if (it.pageIndex >= srcDoc.getPageCount()) continue;
        const out = await PDFDocument.create();
        const [pg] = await out.copyPages(srcDoc, [it.pageIndex]);
        out.addPage(pg);
        const bytes = await out.save();

        let name = it.filename;
        let full = joined(folder, it.folder.split('/').join(sep), name);
        let n = 1;
        // Chống trùng CẢ trong lượt lưu này (used) LẪN file đã tồn tại trên đĩa → không
        // ghi đè im lặng lên file người dùng có sẵn cùng tên.
        while (used.has(full) || await fileExists(fs, full)) {
            name = it.filename.replace(/\.pdf$/i, ` (${++n}).pdf`);
            full = joined(folder, it.folder.split('/').join(sep), name);
        }
        used.add(full);
        await atomicWrite(full, bytes);
        ok++;
        if (opts.onProgress) opts.onProgress(ok, plan.length);
    }
    return { ok, total: plan.length };
}

/** Kiểm tra file tồn tại trên đĩa (an toàn nếu plugin không có `exists`). */
async function fileExists(fs: any, path: string): Promise<boolean> {
    try {
        if (typeof fs.exists === 'function') return await fs.exists(path);
    } catch { /* coi như chưa tồn tại */ }
    return false;
}

/** Số trang mỗi đơn vị theo chế độ (để suy số loại khi không có types). */
export function pagesPerTypeFor(opts: { cncMode?: boolean; cncTwoSided?: boolean; separateCut?: boolean }): number {
    if (opts.cncMode) return opts.cncTwoSided ? 3 : 2;
    return opts.separateCut ? 2 : 1;
}
