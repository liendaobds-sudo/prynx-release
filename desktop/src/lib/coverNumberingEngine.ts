// coverNumberingEngine.ts
// Engine sinh số dùng chung cho "Mẹc Số ⇄ Mẹc Bìa" (spec: .kiro/specs/mec-so-bia).
// Pure TS — không phụ thuộc UI/PDF. Là NGUỒN CHÂN LÝ chung cho cả ruột (số chạy) và
// bìa ({X,Y,Z}) để hai bên LUÔN khớp dải (bất biến đồng bộ — Property 1).

export type SortMethod = 'rows' | 'cols' | 'snake' | 'clockwise'; // Z / N(ngược) / U / C(ngược)
export type Distribution = 'stack' | 'sequential';               // cắt chồng / tuần tự
export type InnerMode = 'continuous' | 'reset';

export interface NumberingJob {
    startNum: number;
    endNum: number;
    padding: number;            // độ dài đệm 0 (0 = không đệm)
    prefix?: string;
    suffix?: string;
    bookletCount: number;
    bookletOffset: number;      // số cuốn bắt đầu (→ {X})
    innerMode: InnerMode;
    distribution: Distribution;
    sortMethod: SortMethod;
}

export type JobError = 'bad_range' | 'not_divisible' | 'too_large';

export interface JobDerived {
    totalNumbers: number;
    perBooklet: number;
    valid: boolean;
    error?: JobError;
    suggestion?: number;        // bookletCount hợp lệ gần nhất (khi not_divisible)
}

export interface CoverRow {
    bookletIndex: number;       // 0-based
    X: string;                  // số cuốn (không đệm)
    Y: string;                  // ruột đầu (đã đệm)
    Z: string;                  // ruột cuối (đã đệm)
}

/** Trần an toàn số phần tử sinh ra — chống treo (đồng bộ với guard chạy số). */
export const MAX_NUMBERS = 1_000_000;

function pad(n: number, padding: number, prefix = '', suffix = ''): string {
    let s = Math.trunc(n).toString();
    if (padding > 0) s = s.padStart(padding, '0');
    return `${prefix}${s}${suffix}`;
}

/** Ước số của `total` gần `target` nhất (để gợi ý bookletCount hợp lệ khi không chia hết). */
function nearestDivisor(total: number, target: number): number {
    if (total <= 0) return 1;
    let best = 1;
    let bestDist = Infinity;
    for (let d = 1; d <= total; d++) {
        if (total % d === 0) {
            const dist = Math.abs(d - target);
            if (dist < bestDist) { bestDist = dist; best = d; }
        }
    }
    return best;
}

/** Validate Job + tính perBooklet. KHÔNG ném — trả cờ valid + error để UI hiển thị. */
export function deriveJob(job: NumberingJob): JobDerived {
    const totalNumbers = job.endNum - job.startNum + 1;
    if (!Number.isFinite(totalNumbers) || totalNumbers <= 0 || job.bookletCount <= 0
        || !Number.isFinite(job.bookletCount)) {
        return { totalNumbers, perBooklet: 0, valid: false, error: 'bad_range' };
    }
    if (totalNumbers > MAX_NUMBERS) {
        return { totalNumbers, perBooklet: 0, valid: false, error: 'too_large' };
    }
    if (totalNumbers % job.bookletCount !== 0) {
        return {
            totalNumbers, perBooklet: 0, valid: false, error: 'not_divisible',
            suggestion: nearestDivisor(totalNumbers, job.bookletCount),
        };
    }
    return { totalNumbers, perBooklet: totalNumbers / job.bookletCount, valid: true };
}

/**
 * Dải số ruột THỰC TẾ của cuốn thứ `i` (0-based) — NGUỒN CHÂN LÝ chung.
 * continuous: cuốn nối tiếp (i*perBooklet); reset: mọi cuốn cùng dải.
 */
export function innerRange(job: NumberingJob, i: number): { start: number; end: number } {
    const d = deriveJob(job);
    if (!d.valid) return { start: NaN, end: NaN };
    const base = job.innerMode === 'continuous'
        ? job.startNum + i * d.perBooklet
        : job.startNum;
    return { start: base, end: base + d.perBooklet - 1 };
}

/** Dữ liệu bìa cho TỪNG cuốn (thứ tự cuốn tự nhiên 0..bookletCount-1). */
export function generateCoverData(job: NumberingJob): CoverRow[] {
    const d = deriveJob(job);
    if (!d.valid) return [];
    const rows: CoverRow[] = [];
    for (let i = 0; i < job.bookletCount; i++) {
        const r = innerRange(job, i);
        rows.push({
            bookletIndex: i,
            X: String(job.bookletOffset + i),
            Y: pad(r.start, job.padding, job.prefix, job.suffix),
            Z: pad(r.end, job.padding, job.prefix, job.suffix),
        });
    }
    return rows;
}

/**
 * Ánh xạ (vị trí cụm `pos` đã sort, tờ `sheet`) → chỉ số cuốn (bookletIndex).
 * Dùng CHUNG cho ruột & bìa nên hai bên luôn khớp vị trí.
 *   stack      = pos*sheets + sheet  (cắt chồng: chồng tờ + cắt theo vị trí ra dải liên tiếp)
 *   sequential = sheet*slotsPerSheet + pos  (tuần tự: lấp đầy từng tờ)
 */
export function distributionIndex(
    pos: number, sheet: number, sheets: number, slotsPerSheet: number, mode: Distribution,
): number {
    return mode === 'stack' ? pos * sheets + sheet : sheet * slotsPerSheet + pos;
}

export interface SlotAssign {
    sheet: number;
    pos: number;            // vị trí cụm đã sort trong tờ (0-based)
    bookletIndex: number;   // -1 = ô trống (vượt số cuốn)
}

/**
 * Gán cuốn cho từng ô trên từng tờ in, theo `distribution`.
 * `slotsPerSheet` = số cụm bìa/tờ (do người dùng bình sẵn). Vị trí `pos` GIẢ ĐỊNH đã được
 * sort theo sortMethod TRƯỚC đó (sort là bước upstream — Task 2 / vdpUtils).
 */
export function assignBooklets(job: NumberingJob, slotsPerSheet: number): SlotAssign[] {
    const d = deriveJob(job);
    if (!d.valid || slotsPerSheet <= 0) return [];
    const sheets = Math.ceil(job.bookletCount / slotsPerSheet);
    const out: SlotAssign[] = [];
    for (let sheet = 0; sheet < sheets; sheet++) {
        for (let pos = 0; pos < slotsPerSheet; pos++) {
            const idx = distributionIndex(pos, sheet, sheets, slotsPerSheet, job.distribution);
            out.push({ sheet, pos, bookletIndex: idx < job.bookletCount ? idx : -1 });
        }
    }
    return out;
}
