// ============================================================
// Shared Geometry Module — Logic nối chuỗi dùng chung
//
// Module dùng chung (single source of truth) chứa logic nối
// chuỗi segment + chuyển đổi SVG để cả Export_Module
// (exportPDF.ts) và Canvas_Module (DielineCanvas2D.tsx) dùng
// lại, tránh phân kỳ mã (drift) — Requirement 4.1.
//
// Các hàm ptEq / segEndpoints / buildChains / chainToSvgD và
// kiểu Chain được di chuyển nguyên trạng (verbatim) từ
// exportPDF.ts, giữ nguyên thuật toán và dung sai 0.01mm.
// ============================================================

import { PathSegment, Point2D, PathTag, DielineModel, BoxParams } from './types';

/**
 * Dung sai khớp endpoint khi nối chuỗi — DUY NHẤT một hằng số dùng chung.
 * Cùng giá trị mà Contour_Validator và Chain_Builder sử dụng (Requirement 1.5).
 */
export const SNAP_TOLERANCE = 0.01; // mm

/** Một chuỗi segment liên tục cùng tag */
export interface Chain {
    tag: PathTag;
    segs: PathSegment[];
}

/** Tolerance cho so sánh điểm (0.01mm) */
export function ptEq(a: Point2D, b: Point2D): boolean {
    return Math.abs(a.x - b.x) < SNAP_TOLERANCE && Math.abs(a.y - b.y) < SNAP_TOLERANCE;
}

/** Lấy điểm đầu/cuối của segment */
export function segEndpoints(seg: PathSegment): [Point2D, Point2D] {
    if (seg.type === 'bezier' && seg.controlPoints) {
        return [seg.controlPoints[0], seg.controlPoints[3]];
    }
    return [seg.points[0], seg.points[seg.points.length - 1]];
}

/**
 * Chuyển 1 segment thành SVG commands (KHÔNG có M ở đầu — dùng khi nối chuỗi).
 * Trả về chuỗi bắt đầu bằng L hoặc C.
 */
function segmentContinuation(seg: PathSegment): string {
    if (seg.type === 'bezier' && seg.controlPoints) {
        const [, cp1, cp2, p3] = seg.controlPoints;
        return `C ${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${p3.x},${p3.y}`;
    }
    // Bỏ điểm đầu (đã là current point)
    return seg.points.slice(1)
        .map(p => `L ${p.x},${p.y}`)
        .join(' ');
}

/**
 * Gom segments nối tiếp nhau (cùng tag, endpoint trùng)
 * thành các chains. Mỗi chain → 1 SVG `<path>` liên tục.
 * Dùng global search (không chỉ sequential) để tìm segment kế tiếp.
 */
export function buildChains(segments: PathSegment[]): Chain[] {
    const chains: Chain[] = [];
    const used = new Set<number>();

    for (let i = 0; i < segments.length; i++) {
        if (used.has(i)) continue;
        const chain: PathSegment[] = [segments[i]];
        used.add(i);

        // Mở rộng chain: tìm segment bất kỳ có endpoint trùng + cùng tag
        let extended = true;
        while (extended) {
            extended = false;
            const [, chainEnd] = segEndpoints(chain[chain.length - 1]);
            for (let j = 0; j < segments.length; j++) {
                if (used.has(j)) continue;
                if (segments[j].tag !== chain[0].tag) continue;
                const [jStart] = segEndpoints(segments[j]);
                if (ptEq(chainEnd, jStart)) {
                    chain.push(segments[j]);
                    used.add(j);
                    extended = true;
                    break;
                }
            }
        }
        chains.push({ tag: chain[0].tag, segs: chain });
    }

    return chains;
}

/**
 * Chuyển 1 chain thành SVG `d` attribute liên tục.
 * Ví dụ: "M 10,20 L 30,40 C ... L ... Z"
 */
export function chainToSvgD(chain: PathSegment[]): string {
    if (chain.length === 0) return '';

    // Segment đầu tiên: bắt đầu bằng M
    const first = chain[0];
    const [start] = segEndpoints(first);
    let d = `M ${start.x},${start.y} ` + segmentContinuation(first);

    // Các segment tiếp theo: chỉ thêm continuation (L/C)
    for (let i = 1; i < chain.length; i++) {
        d += ' ' + segmentContinuation(chain[i]);
    }

    // Kiểm tra đóng kín
    const [chainStart] = segEndpoints(chain[0]);
    const [, chainEnd] = segEndpoints(chain[chain.length - 1]);
    if (ptEq(chainStart, chainEnd) && chain.length > 1) {
        d += ' Z';
    }

    return d;
}

// ============================================================
// Công thức kích thước dùng chung (Requirement 4.2)
//
// Rút công thức FH/SF của Envelope đang lặp lại ở
// buildDimensionSvg (exportPDF.ts) và DimensionAnnotations
// (DielineCanvas2D.tsx) về một nơi duy nhất để tránh drift.
// ============================================================

/** Kích thước dẫn xuất của Envelope (seal flap height / side flap) */
export interface EnvelopeDims {
    /** Chiều cao nắp dán (seal flap height), mm */
    FH: number;
    /** Rộng tai hông (side flap), mm */
    SF: number;
}

/**
 * Tính FH (seal flap height) và SF (side flap) của Envelope.
 * Công thức giữ nguyên hành vi của export & canvas:
 *   - flapRef = envH
 *   - FH = envFH nếu > 0; ngược lại 30 (nắp thẳng) hoặc round(flapRef * 0.45)
 *   - SF = envSF nếu > 0; ngược lại clamp(round(flapRef * 0.12), 10, 15)
 */
export function computeEnvelopeDims(params: BoxParams): EnvelopeDims {
    const { envH, envFH, envSF, envFlapShape } = params;
    const flapRef = envH;
    const FH = envFH > 0
        ? envFH
        : (envFlapShape === 'straight' ? 30 : Math.round(flapRef * 0.45));
    const SF = envSF > 0
        ? envSF
        : Math.max(10, Math.min(15, Math.round(flapRef * 0.12)));
    return { FH, SF };
}

// ============================================================
// Dẫn xuất legend từ tag thực có trong file (Requirement 5.1, 5.4)
//
// Legend là dẫn xuất, không phải hằng số: tập tag hiển thị
// luôn bằng đúng tập tag thực sự xuất hiện trong allPaths.
// ============================================================

/**
 * Trả về tập các PathTag thực sự xuất hiện trên ít nhất một
 * PathSegment trong model.allPaths. Dùng để render legend ở
 * cả Canvas và Export (phương án B — gỡ tag không có đoạn nào).
 */
export function deriveLegendTags(model: DielineModel): Set<PathTag> {
    const tags = new Set<PathTag>();
    if (model && Array.isArray(model.allPaths)) {
        for (const seg of model.allPaths) {
            tags.add(seg.tag);
        }
    }
    return tags;
}

// ============================================================
// Guard model không hợp lệ (Requirement 4.7)
//
// Module dùng chung phải từ chối model không hợp lệ (thiếu
// segment hoặc chứa chuỗi cắt không khép kín vượt SNAP_TOLERANCE)
// và KHÔNG tạo ra SVG / giá trị kích thước một phần.
// ============================================================

/** Lỗi báo hiệu DielineModel không hợp lệ cho phía gọi */
export class InvalidDielineModelError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidDielineModelError';
    }
}

/**
 * Kiểm tra tính hợp lệ hình học của model trước khi dựng SVG /
 * tính kích thước. Ném `InvalidDielineModelError` nếu:
 *   - model thiếu `allPaths` hoặc rỗng (thiếu segment)
 *   - bất kỳ segment nào thiếu điểm (< 2 điểm)
 *   - bất kỳ chuỗi cắt (CUT/BLEED) nào không khép kín, khoảng hở
 *     đầu-cuối vượt SNAP_TOLERANCE
 *
 * Hàm fail loud — không bao giờ trả về đầu ra một phần.
 */
export function assertValidGeometryModel(model: DielineModel): void {
    if (!model || !Array.isArray(model.allPaths) || model.allPaths.length === 0) {
        throw new InvalidDielineModelError(
            'DielineModel không hợp lệ: thiếu segment (allPaths rỗng hoặc không tồn tại)',
        );
    }

    for (const seg of model.allPaths) {
        const pts = seg.type === 'bezier' && seg.controlPoints
            ? seg.controlPoints
            : seg.points;
        if (!pts || pts.length < 2) {
            throw new InvalidDielineModelError(
                `DielineModel không hợp lệ: segment (tag=${seg.tag}) thiếu điểm`,
            );
        }
    }

    // Các chuỗi biên ngoài (CUT/BLEED) phải khép kín trong SNAP_TOLERANCE.
    const perimeterSegs = model.allPaths.filter(s => s.tag === 'CUT' || s.tag === 'BLEED');
    const chains = buildChains(perimeterSegs);
    for (const chain of chains) {
        const [start] = segEndpoints(chain.segs[0]);
        const [, end] = segEndpoints(chain.segs[chain.segs.length - 1]);
        const gap = Math.hypot(start.x - end.x, start.y - end.y);
        if (gap > SNAP_TOLERANCE) {
            throw new InvalidDielineModelError(
                `DielineModel không hợp lệ: chuỗi cắt không khép kín ` +
                `(khoảng hở ${gap.toFixed(4)}mm > ${SNAP_TOLERANCE}mm)`,
            );
        }
    }
}
