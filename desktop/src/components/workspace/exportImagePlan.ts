export type ExportImageFormat = 'png' | 'jpeg' | 'tiff' | 'webp';
export type ExportImageSubFolderMode = 'none' | 'scale' | 'format';

export interface ScaleRow {
    scale: number;
    suffix: string;
    format: ExportImageFormat;
}

export interface ExportPlanJob {
    dpi: number;
    format: ExportImageFormat;
    suffix: string;
    subDir: string;
}

/** Lập và kiểm tra toàn bộ batch trước upload/render để không sinh output dở dang. */
export function buildExportJobs(input: {
    dpi: number;
    format: ExportImageFormat;
    colorMode: 'rgb' | 'gray' | 'cmyk';
    multiScaleEnabled: boolean;
    scaleRows: ScaleRow[];
    subFolderMode: ExportImageSubFolderMode;
}): ExportPlanJob[] {
    const rows = input.multiScaleEnabled && input.scaleRows.length > 0
        ? input.scaleRows
        : [{ scale: 1, suffix: '', format: input.format }];
    if (rows.length > 8) throw new Error('Mỗi batch chỉ được tối đa 8 đầu ra.');

    return rows.map(row => {
        const effectiveDpi = input.dpi * row.scale;
        if (!Number.isInteger(effectiveDpi) || effectiveDpi < 36 || effectiveDpi > 1200) {
            throw new Error(`Độ phân giải ${effectiveDpi} DPI vượt giới hạn 36–1200 DPI.`);
        }
        if (input.colorMode === 'cmyk' && (row.format === 'png' || row.format === 'webp')) {
            throw new Error('PNG/WebP không hỗ trợ CMYK. Hãy dùng TIFF hoặc JPEG.');
        }
        let subDir = '';
        if (input.subFolderMode === 'scale') subDir = `${row.scale}x`;
        else if (input.subFolderMode === 'format') subDir = row.format.toUpperCase();
        return { dpi: effectiveDpi, format: row.format, suffix: row.suffix, subDir };
    });
}

/** Parse "1-3, 5, 8-10" thành danh sách trang hợp lệ, khử trùng và giữ thứ tự. */
export function parsePageRange(input: string, max: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (const partRaw of input.split(',')) {
        const part = partRaw.trim();
        if (!part) continue;
        const match = part.match(/^(\d+)\s*-\s*(\d+)$/);
        if (match) {
            let start = parseInt(match[1], 10);
            let end = parseInt(match[2], 10);
            if (start > end) [start, end] = [end, start];
            // EXPORT (audit 2026-07-30 §IMG-08): clamp trước vòng lặp để range lớn không khóa WebView.
            start = Math.max(1, start);
            end = Math.min(max, end);
            for (let page = start; page <= end; page++) {
                if (!seen.has(page)) { seen.add(page); out.push(page); }
            }
        } else if (/^\d+$/.test(part)) {
            const page = parseInt(part, 10);
            if (page >= 1 && page <= max && !seen.has(page)) { seen.add(page); out.push(page); }
        }
    }
    return out;
}
