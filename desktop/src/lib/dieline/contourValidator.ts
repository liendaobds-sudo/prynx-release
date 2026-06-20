// ============================================================
// Contour_Validator — Kiểm tra biên dạng cắt khép kín
//
// Thành phần kiểm tra mỗi Cut_Piece của một DielineModel có
// tạo thành Closed_Contour hay không TRƯỚC khi xuất file
// (Requirement 1).
//
// ─── ĐỊNH NGHĨA Cut_Piece (đã hiệu chỉnh) ───────────────────
// Một Cut_Piece KHÔNG phải một panel đơn lẻ. Từng panel KHÔNG
// khép kín khi đứng riêng vì cạnh gập chung giữa hai panel được
// gắn tag CREASE (vẽ một lần) hoặc bị lược bỏ — nên chuỗi CUT
// của mỗi panel hở đúng bằng chiều dài cạnh gập thiếu. Vì vậy
// một Cut_Piece được định nghĩa là một THÀNH PHẦN LIÊN THÔNG
// (connected component) của HỢP tất cả các đoạn CUT/BLEED trên
// TOÀN model.
//
// ─── ĐỊNH NGHĨA "khép kín" (crease-aware) ───────────────────
// Trên một tờ phôi phẳng, đường gập (CREASE) là nơi vật liệu
// vẫn liền mạch: một đầu mút CUT trùng với một đầu mút CREASE
// không phải biên hở mà là chỗ chuyển tiếp sang nếp gập. Do đó
// một Cut_Piece được coi là KHÉP KÍN khi MỌI đầu mút của các
// đoạn CUT/BLEED trong thành phần trùng (trong SNAP_TOLERANCE)
// với ít nhất một đầu mút khác của BẤT KỲ đoạn nào trong model
// (CUT, BLEED hoặc CREASE). Nếu tồn tại một đầu mút CUT/BLEED
// không có đầu mút bạn nào → đó là đầu cắt hở (biên dạng hở),
// đánh dấu Cut_Piece là HỞ (Requirement 1.1, 1.2, 1.5).
//
// Khoảng hở `gapMm` được đo bằng cách TÁI DÙNG `tracePerimeter`
// (Requirement 1.6 — không hiện thực thuật toán nối chuỗi thứ
// hai): với một vòng cắt bị tách một điểm, hai đầu chuỗi truy
// vết chính là điểm bị dịch và điểm bạn cũ của nó, nên khoảng
// cách Euclid đầu-cuối bằng đúng độ dời.
//
// ─── Phạm vi của bộ generator ───────────────────────────────
// 5/8 generator (GableBox, PaperBag, CupSleeve, PizzaBox,
// MatchboxTray) phát ra biên cắt ngoài khép kín hoàn toàn theo
// định nghĩa crease-aware ở trên. 3 generator còn lại
// (ReverseTuckEnd, SnapLockBottom, Envelope) CỐ Ý chứa đặc
// trưng cắt hở nội bộ — rãnh gài/relief slit của lưỡi đút (đường
// cắt kết thúc giữa vật liệu) và vết cắt ngón (thumb-cut) dạng
// cung hở trên nắp bì thư — vốn KHÔNG phải "biên ngoài" theo
// định nghĩa Cut_Piece. Validator vẫn báo các đặc trưng này là
// đầu cắt hở; việc xác nhận khi xuất với các loại hộp đó nằm
// ngoài phạm vi Giai đoạn 1.
// ============================================================

import { DielineModel, Panel, PathSegment, Point2D } from './types';
import { tracePerimeter } from './tracePerimeter';
import { SNAP_TOLERANCE, segEndpoints, ptEq } from './sharedGeometry';

/**
 * Cảnh báo cho một biên dạng cắt hở: xác định Cut_Piece chứa
 * biên hở kèm khoảng hở đo được tính bằng mm (Requirement 1.2).
 */
export interface OpenContourWarning {
    /** Tên panel đại diện (panel sở hữu segment đầu của Cut_Piece) */
    panelName: string;
    /** Nhãn hiển thị tiếng Việt của panel đại diện */
    panelLabel: string;
    /** Khoảng hở đầu-cuối đo được (mm) */
    gapMm: number;
    /** Chỉ số Cut_Piece — chỉ số của thành phần liên thông (định danh) */
    cutPieceIndex: number;
}

/** Kết quả kiểm tra biên dạng khép kín của một DielineModel */
export interface ContourValidationResult {
    /** true nếu 0 biên hở (mọi Cut_Piece đều khép kín) */
    allClosed: boolean;
    /** Danh sách biên hở (rỗng nếu tất cả khép kín) */
    openContours: OpenContourWarning[];
}

/**
 * Tìm gốc của phần tử `i` trong cấu trúc union-find (đệ quy +
 * nén đường đi). Dùng đệ quy để tránh vòng lặp `while` (giữ
 * smoke test Requirement 1.6 — không có vòng nối chuỗi trùng lặp).
 */
function findRoot(parent: number[], i: number): number {
    if (parent[i] !== i) {
        parent[i] = findRoot(parent, parent[i]);
    }
    return parent[i];
}

/** Hợp nhất hai tập chứa `a` và `b`. */
function unite(parent: number[], a: number, b: number): void {
    const ra = findRoot(parent, a);
    const rb = findRoot(parent, b);
    if (ra !== rb) parent[rb] = ra;
}

/**
 * Hai segment thuộc cùng một thành phần liên thông nếu chúng
 * chia sẻ ít nhất một endpoint trong dung sai SNAP_TOLERANCE.
 */
function sharesEndpoint(a: [Point2D, Point2D], b: [Point2D, Point2D]): boolean {
    const [a0, a1] = a;
    const [b0, b1] = b;
    return ptEq(a0, b0) || ptEq(a0, b1) || ptEq(a1, b0) || ptEq(a1, b1);
}

/**
 * Đếm số đầu mút (trong toàn bộ `allEnds`) trùng với `e`. Trả về
 * true nếu có ≥ 2 (chính `e` + ít nhất một đầu mút bạn) → `e`
 * được "khớp" (matched), tức không phải đầu cắt hở.
 */
function isMatched(e: Point2D, allEnds: Point2D[]): boolean {
    let count = 0;
    for (const p of allEnds) {
        if (ptEq(e, p)) {
            count++;
            if (count >= 2) return true;
        }
    }
    return false;
}

/** Khoảng cách tới đầu mút gần nhất khác `e` trong `allEnds`. */
function nearestEndpointDist(e: Point2D, allEnds: Point2D[]): number {
    let best = Infinity;
    for (const p of allEnds) {
        const dd = Math.hypot(e.x - p.x, e.y - p.y);
        if (dd > 1e-9 && dd < best) best = dd;
    }
    return best;
}

/** Khoảng cách nhỏ nhất giữa hai điểm bất kỳ trong danh sách. */
function minPairwiseDist(pts: Point2D[]): number {
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
            const dd = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
            if (dd < best) best = dd;
        }
    }
    return best;
}

/**
 * Kiểm tra tính khép kín của mọi Cut_Piece trong model.
 *
 * Quy trình:
 *   1. Gom tất cả segment CUT/BLEED trên TOÀN model.
 *   2. Phân nhóm thành các thành phần liên thông theo endpoint
 *      trùng (SNAP_TOLERANCE) — mỗi thành phần là một Cut_Piece.
 *   3. Với mỗi Cut_Piece: tái dùng `tracePerimeter` để nối chuỗi;
 *      đánh dấu HỞ nếu tồn tại đầu mút CUT/BLEED không khớp với
 *      bất kỳ đầu mút nào khác (kể cả CREASE) trong model. Khoảng
 *      hở `gapMm` lấy từ khoảng cách đầu-cuối chuỗi truy vết.
 *
 * Các góc bị Connect_Corner biến đổi tọa độ nằm trong biên ngoài
 * nên được kiểm tra cùng cơ chế này (Requirement 1.7).
 */
export function validateClosedContours(model: DielineModel): ContourValidationResult {
    const openContours: OpenContourWarning[] = [];

    if (!model || !Array.isArray(model.allPaths)) {
        return { allClosed: true, openContours };
    }

    // Tập đầu mút của TẤT CẢ segment (kể cả CREASE) — để kiểm tra
    // tính "khớp" crease-aware của từng đầu mút CUT/BLEED.
    const allEnds: Point2D[] = [];
    for (const s of model.allPaths) {
        const [a, b] = segEndpoints(s);
        allEnds.push(a, b);
    }

    // 1. Gom tất cả segment CUT/BLEED (biên ngoài) trên TOÀN model.
    const segs: PathSegment[] = model.allPaths.filter(
        (p) => p.tag === 'CUT' || p.tag === 'BLEED',
    );
    const n = segs.length;
    if (n === 0) {
        return { allClosed: true, openContours };
    }

    // Bản đồ segment → panel sở hữu (theo tham chiếu) để gán panel
    // đại diện cho mỗi Cut_Piece.
    const segToPanel = new Map<PathSegment, Panel>();
    if (Array.isArray(model.panels)) {
        for (const panel of model.panels) {
            const paths = Array.isArray(panel.paths) ? panel.paths : [];
            for (const p of paths) {
                if (!segToPanel.has(p)) segToPanel.set(p, panel);
            }
        }
    }

    // 2. Dựng quan hệ liên thông CUT/BLEED theo endpoint trùng.
    const ends = segs.map((s) => segEndpoints(s));
    const parent: number[] = segs.map((_, i) => i);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (sharesEndpoint(ends[i], ends[j])) {
                unite(parent, i, j);
            }
        }
    }

    // Nhóm chỉ số segment theo gốc, duyệt theo thứ tự allPaths để
    // chỉ số thành phần ổn định và xác định.
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
        const r = findRoot(parent, i);
        const bucket = groups.get(r);
        if (bucket) bucket.push(i);
        else groups.set(r, [i]);
    }

    // 3. Xét từng Cut_Piece.
    let cutPieceIndex = 0;
    for (const memberIdx of groups.values()) {
        const componentSegs = memberIdx.map((i) => segs[i]);

        // Panel đại diện = panel sở hữu segment đầu của thành phần.
        const repSeg = componentSegs[0];
        const repPanel = segToPanel.get(repSeg);
        const panelName = repPanel ? repPanel.name : `cut_piece_${cutPieceIndex}`;
        const panelLabel = repPanel ? repPanel.label : `Cut piece ${cutPieceIndex}`;

        // Tái dùng tracePerimeter để nối chuỗi đỉnh (Requirement 1.6).
        const perimeter = tracePerimeter(componentSegs);

        // Đầu mút CUT/BLEED không khớp với bất kỳ đầu mút nào khác
        // (kể cả CREASE) → đầu cắt hở.
        const unmatched: Point2D[] = [];
        for (const idx of memberIdx) {
            const [p0, p1] = ends[idx];
            if (!isMatched(p0, allEnds)) unmatched.push(p0);
            if (!isMatched(p1, allEnds)) unmatched.push(p1);
        }

        if (unmatched.length > 0) {
            // Khoảng hở giữa các đầu cắt hở. Đo TRỰC TIẾP giữa các đầu
            // hở phát hiện được để bền vững với hình học suy biến (một
            // số mẫu khiến tracePerimeter trả điểm không hợp lệ). Khi có
            // ≥ 2 đầu hở (vòng cắt bị tách → đúng 2 đầu), khoảng cách nhỏ
            // nhất giữa chúng bằng đúng độ dời. Khi chỉ có 1 đầu hở (góc
            // CUT–CREASE), dùng khoảng hở từ chuỗi truy vết nếu hợp lệ,
            // ngược lại lấy đầu mút gần nhất.
            let gapMm: number;
            if (unmatched.length >= 2) {
                gapMm = minPairwiseDist(unmatched);
            } else {
                let traceGap = Infinity;
                if (perimeter.length >= 2) {
                    const start = perimeter[0];
                    const end = perimeter[perimeter.length - 1];
                    const g = Math.hypot(start.x - end.x, start.y - end.y);
                    if (Number.isFinite(g)) traceGap = g;
                }
                gapMm = traceGap > SNAP_TOLERANCE && Number.isFinite(traceGap)
                    ? traceGap
                    : nearestEndpointDist(unmatched[0], allEnds);
            }

            openContours.push({ panelName, panelLabel, gapMm, cutPieceIndex });
        }

        cutPieceIndex++;
    }

    return {
        allClosed: openContours.length === 0,
        openContours,
    };
}
