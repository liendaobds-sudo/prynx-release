// coverNumberingPlanner.ts
// Nối SORT vị trí cụm (vdpUtils.sortFieldsGeometrically — đã có) với engine sinh số
// (coverNumberingEngine) để ra KẾ HOẠCH bìa: ô nào (trên tờ nhân bản nào) in cuốn nào.
// Engine giữ thuần; planner là lớp wiring (sort + distribution + cover data).

import { sortFieldsGeometrically, type VdpSortMethod } from './vdpUtils';
import { parseRanges } from './preprocessEngine/PdfSplitter';
import {
    type NumberingJob, type CoverRow, type SortMethod,
    deriveJob, generateCoverData, distributionIndex,
} from './coverNumberingEngine';

/** Một cụm bìa người dùng đặt trên tờ template (toạ độ gốc trên-trái như canvas). */
export interface Cluster { id: string; x: number; y: number; }

export interface CoverPlanItem {
    sheet: number;            // tờ in nhân bản thứ mấy (0-based)
    clusterId: string;        // cụm nào (theo vị trí đã sort)
    pos: number;              // thứ tự cụm sau sort (0-based)
    bookletIndex: number;     // -1 = ô trống
    cover: CoverRow | null;   // dữ liệu {X,Y,Z} hoặc null nếu trống
}

/** snake (engine) ↔ ushape (vdpUtils). Còn lại trùng tên. */
function toVdpSort(m: SortMethod): VdpSortMethod {
    return m === 'snake' ? 'ushape' : m;
}

/** Thứ tự cụm theo vị trí + kiểu quét (Z/N/U/C). Trả mảng id theo thứ tự pos. */
export function sortedClusterOrder(clusters: Cluster[], sortMethod: SortMethod): string[] {
    const sorted = sortFieldsGeometrically(
        clusters.map(c => ({ id: c.id, position: { x: c.x, y: c.y } })),
        toVdpSort(sortMethod),
    );
    return sorted.map((s: any) => s.id);
}

/**
 * Kế hoạch đánh số bìa: với mỗi tờ in nhân bản × mỗi ô (đã sort), gán cuốn theo
 * distribution. Bìa & ruột nếu dùng cùng Job + cùng cụm sẽ khớp vị trí (Property 4).
 */
export function planCoverLayout(job: NumberingJob, clusters: Cluster[]): CoverPlanItem[] {
    const d = deriveJob(job);
    if (!d.valid || clusters.length === 0) return [];

    const order = sortedClusterOrder(clusters, job.sortMethod);
    const data = generateCoverData(job);
    const slotsPerSheet = clusters.length;
    const sheets = Math.ceil(job.bookletCount / slotsPerSheet);

    const out: CoverPlanItem[] = [];
    for (let sheet = 0; sheet < sheets; sheet++) {
        for (let pos = 0; pos < slotsPerSheet; pos++) {
            const idx = distributionIndex(pos, sheet, sheets, slotsPerSheet, job.distribution);
            const valid = idx < job.bookletCount;
            out.push({
                sheet, pos, clusterId: order[pos],
                bookletIndex: valid ? idx : -1,
                cover: valid ? data[idx] : null,
            });
        }
    }
    return out;
}

/**
 * Chuyển kế hoạch bìa → bản ghi VDP để render (TÁI DÙNG `run_vdp_engine` đã verify).
 * MỖI TỜ IN = 1 record (1 trang output); mỗi cụm có token riêng theo clusterId:
 *   `${clusterId}.X` / `.Y` / `.Z`. Field trên template đặt textContent khớp các token này.
 * Ô trống (bookletIndex<0) → token rỗng (không in gì cho cụm đó trên tờ cuối).
 */
export function buildCoverRecords(plan: CoverPlanItem[]): Record<string, string>[] {
    const bySheet = new Map<number, Record<string, string>>();
    for (const it of plan) {
        let rec = bySheet.get(it.sheet);
        if (!rec) { rec = {}; bySheet.set(it.sheet, rec); }
        rec[`${it.clusterId}.X`] = it.cover ? it.cover.X : '';
        rec[`${it.clusterId}.Y`] = it.cover ? it.cover.Y : '';
        rec[`${it.clusterId}.Z`] = it.cover ? it.cover.Z : '';
    }
    // Trả theo thứ tự tờ tăng dần (record i = tờ in i).
    return [...bySheet.keys()].sort((a, b) => a - b).map(k => bySheet.get(k)!);
}

/**
 * PA2 (1 file): người dùng GÁN role theo dải trang — trang nào là BÌA (imposed cover sheet).
 * Trả CHỈ SỐ trang bìa 0-based (đã loại trùng + sắp tăng) để trích làm template VDP.
 * KHÔNG tự nhận diện — chỉ phân giải đúng chuỗi người dùng nhập (Requirement 5.3).
 *   resolveCoverPageIndices("3", 10)      → [2]
 *   resolveCoverPageIndices("1-2,5", 10)  → [0,1,4]
 * Chuỗi rỗng/không hợp lệ → [] (UI sẽ chặn).
 */
export function resolveCoverPageIndices(rangeStr: string, totalPages: number): number[] {
    if (!rangeStr || totalPages <= 0) return [];
    const ranges = parseRanges(rangeStr, totalPages);
    const set = new Set<number>();
    for (const [start, end] of ranges) {
        for (let p = start; p <= end; p++) {
            if (p >= 1 && p <= totalPages) set.add(p - 1); // → 0-based
        }
    }
    return [...set].sort((a, b) => a - b);
}
