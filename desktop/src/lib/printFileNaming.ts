/**
 * printFileNaming.ts — Dựng tên file & cây thư mục cho tính năng "Lưu file in".
 * (spec: binh-tem-be-report, Yêu cầu 8). Logic thuần — testable.
 */

const ILLEGAL_RE = /[\\/:*?"<>|]/g;

/** Làm sạch ký tự không hợp lệ cho tên file/thư mục Windows. */
export function sanitizeFilename(name: string): string {
    if (!name) return '';
    let s = name.replace(ILLEGAL_RE, '-');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/\s*-\s*-\s*/g, ' - ');
    return s.replace(/^[\s-]+|[\s-]+$/g, '');
}

export type NameMode = 'report' | 'number' | 'original';
export type FolderMode = 'per_order' | 'flat';

export interface SaveTypeInfo {
    /** Nhãn/tên loại tem (labelName hoặc "Trang N"). */
    label: string;
    /** Số tờ cần in của loại này. */
    sheetCount: number;
}

export interface SavePlanConfig {
    nameMode: NameMode;
    folderMode: FolderMode;
    separateCut: boolean;
    includeOrderCode: boolean;
    includeDate: boolean;
    orderCode?: string;
    originalName?: string;   // tên file gốc (cho nameMode='original')
    dateStr?: string;        // ngày (YYYY-MM-DD); nếu rỗng dùng hôm nay
    /** Bình Bế Rớt CNC: bố cục bộ 3 trang (Trước/Sau/Khuôn) — spec: binh-be-rot-cnc. */
    cncMode?: boolean;
    /** CNC in 2 mặt → mỗi đơn vị 3 trang [Trước, Sau, Khuôn]; tắt → 2 trang [Trước, Khuôn]. */
    cncTwoSided?: boolean;
}

export interface SavePlanItem {
    kind: 'print' | 'cut' | 'front' | 'back';
    folder: string;          // đường dẫn con tương đối ('' = gốc)
    filename: string;        // có đuôi .pdf
    pageIndex: number;       // chỉ số trang trong PDF kết quả
}

function todayStr(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Dựng tên cơ sở (chưa .pdf) cho 1 loại theo cấu hình. */
function buildBaseName(idx: number, t: SaveTypeInfo, cfg: SavePlanConfig): string {
    const seq = idx + 1;
    if (cfg.nameMode === 'number') return String(seq);
    if (cfg.nameMode === 'original') {
        const base = (cfg.originalName || 'output').replace(/\.pdf$/i, '');
        return `${seq} - ${base}`;
    }
    // 'report'
    const parts: string[] = [];
    if (cfg.includeOrderCode && cfg.orderCode) parts.push(cfg.orderCode);
    if (cfg.includeDate) parts.push(cfg.dateStr || todayStr());
    parts.push(t.label || `Trang ${seq}`);
    if (t.sheetCount > 0) parts.push(`${t.sheetCount} tờ`);
    return `${seq} - ${parts.join(' - ')}`;
}

/**
 * Dựng kế hoạch lưu: danh sách file (in + bế) kèm thư mục & chỉ số trang.
 *
 * Bố cục trang PDF kết quả:
 *   - separateCut=false: [in_0, in_1, ...]          (1 trang/loại)
 *   - separateCut=true : [in_0, bế_0, in_1, bế_1...] (2 trang/loại)
 */
export function buildSavePlan(types: SaveTypeInfo[], cfg: SavePlanConfig): SavePlanItem[] {
    const items: SavePlanItem[] = [];
    const orderFolder = cfg.folderMode === 'per_order'
        ? sanitizeFilename(cfg.orderCode || 'DonHang')
        : '';
    const join = (...p: string[]) => p.filter(Boolean).join('/');

    // ── Bố cục CNC: mỗi đơn vị 3 trang [Trước, Sau, Khuôn] (2 mặt) hoặc 2 trang [Trước, Khuôn] ──
    if (cfg.cncMode) {
        const pagesPer = cfg.cncTwoSided ? 3 : 2;
        const perOrder = cfg.folderMode === 'per_order';
        const frontSub = perOrder ? 'MatTruoc' : '';
        const backSub = perOrder ? 'MatSau' : '';
        const cutSub = perOrder ? 'Khuon' : '';
        types.forEach((t, i) => {
            const base = sanitizeFilename(buildBaseName(i, t, cfg));
            const p0 = i * pagesPer;
            items.push({ kind: 'front', folder: join(orderFolder, frontSub), filename: `${base} (front).pdf`, pageIndex: p0 });
            if (cfg.cncTwoSided) {
                items.push({ kind: 'back', folder: join(orderFolder, backSub), filename: `${base} (back).pdf`, pageIndex: p0 + 1 });
            }
            items.push({ kind: 'cut', folder: join(orderFolder, cutSub), filename: `${base} (cut).pdf`, pageIndex: p0 + (cfg.cncTwoSided ? 2 : 1) });
        });
        return items;
    }

    const printSub = cfg.folderMode === 'per_order' && cfg.separateCut ? 'In' : '';
    const cutSub = cfg.folderMode === 'per_order' && cfg.separateCut ? 'Bế' : '';

    types.forEach((t, i) => {
        const base = sanitizeFilename(buildBaseName(i, t, cfg));
        const printPage = cfg.separateCut ? i * 2 : i;
        items.push({
            kind: 'print',
            folder: join(orderFolder, printSub),
            filename: `${base}.pdf`,
            pageIndex: printPage,
        });
        if (cfg.separateCut) {
            items.push({
                kind: 'cut',
                folder: join(orderFolder, cutSub),
                filename: `${base} (cut).pdf`,
                pageIndex: printPage + 1,
            });
        }
    });
    return items;
}
