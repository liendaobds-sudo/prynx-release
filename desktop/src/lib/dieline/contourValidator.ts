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
 * Outer_Silhouette — biên ngoài cùng của một Cut_Piece (Giai đoạn 2).
 *
 * Cấu trúc thuần dữ liệu, chỉ-đọc, là nền tảng dùng chung cho CẢ hai
 * workstream (kiểm tra khép kín & lồng khuôn). KHÔNG lưu vào model.
 */
export interface OuterSilhouette {
    /** Chuỗi đỉnh biên ngoài cùng (khép kín nếu gapMm ≤ SNAP_TOLERANCE) */
    vertices: Point2D[];
    /** Khoảng hở đầu-cuối đo được của biên ngoài (mm) */
    gapMm: number;
    /** Diện tích bao (shoelace, trị tuyệt đối) của biên ngoài, mm² */
    area: number;
    /** true nếu gapMm ≤ SNAP_TOLERANCE */
    closed: boolean;
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
 * Thu thập các ĐẦU MÚT KHÔNG CÓ BUDDY (crease-aware) của một Cut_Piece.
 *
 * Một đầu mút CUT/BLEED được coi là KHÉP KÍN khi nó trùng (trong SNAP_TOLERANCE)
 * với ít nhất một đầu mút KHÁC của BẤT KỲ đoạn nào trong model — kể cả CREASE:
 * trên phôi phẳng, đầu cắt gặp đường gập là chỗ chuyển tiếp sang nếp gập, KHÔNG
 * phải biên hở. Đây là lý do các đoạn CUT đơn lẻ (vd: gusset/khóa của khay) mà
 * hai đầu nối vào CREASE vẫn khép kín.
 *
 * Trả về danh sách (đã loại trùng) các đầu mút CUT/BLEED của thành phần mà KHÔNG
 * có buddy nào trên toàn model. Với một Cut_Piece khép kín hoàn toàn, danh sách
 * rỗng. Khi một đầu mút biên ngoài bị tách (vd: dịch một góc đi `d`), đúng hai
 * đầu mút mất buddy và cách nhau `d` (Requirement 2.1, 3.4).
 */
function collectUnbuddiedEndpoints(
    componentSegs: PathSegment[],
    allEndpoints: Point2D[],
): Point2D[] {
    const result: Point2D[] = [];
    for (const seg of componentSegs) {
        const [a, b] = segEndpoints(seg);
        for (const e of [a, b]) {
            let count = 0;
            for (const q of allEndpoints) {
                if (ptEq(e, q)) {
                    count++;
                    if (count >= 2) break;
                }
            }
            if (count >= 2) continue; // có buddy (CUT/BLEED/CREASE) → khép kín tại đây
            if (!result.some((r) => ptEq(r, e))) result.push(e); // loại trùng
        }
    }
    return result;
}

/**
 * Chọn Panel đại diện cho một biên ngoài hở (Requirement 2.3).
 *
 * Panel đại diện = Panel chứa NHIỀU đoạn `CUT`/`BLEED` của biên
 * ngoài (Outer_Silhouette) đó NHẤT; khi đồng hạng → Panel có chỉ
 * số (index trong `model.panels`) THẤP NHẤT. Đoạn "thuộc biên
 * ngoài" là đoạn KHÔNG phải Interior_Cut_Feature so với vòng đỉnh
 * `ring`. Hàm chỉ-đọc.
 */
function pickRepresentativePanel(
    componentSegs: PathSegment[],
    ring: Point2D[],
    segToPanel: Map<PathSegment, Panel>,
    panels: Panel[],
    fallbackIdx: number,
): { name: string; label: string } {
    // Đoạn thuộc biên ngoài = không phải Interior_Cut_Feature (Req 1.3).
    const pieceEndpoints: Point2D[] = [];
    for (const s of componentSegs) {
        const [a, b] = segEndpoints(s);
        pieceEndpoints.push(a, b);
    }
    let boundarySegs =
        ring.length >= 3
            ? componentSegs.filter((s) => !isInteriorFeature(s, ring, pieceEndpoints))
            : componentSegs;
    if (boundarySegs.length === 0) boundarySegs = componentSegs;

    // Đếm số đoạn biên ngoài theo từng chỉ số panel.
    const countByIdx = new Map<number, number>();
    for (const seg of boundarySegs) {
        const panel = segToPanel.get(seg);
        if (!panel) continue;
        const idx = panels.indexOf(panel);
        if (idx < 0) continue;
        countByIdx.set(idx, (countByIdx.get(idx) ?? 0) + 1);
    }

    // Nhiều nhất; đồng hạng → chỉ số thấp nhất (so sánh không phụ thuộc
    // thứ tự duyệt Map).
    let bestIdx = -1;
    let bestCount = -1;
    for (const [idx, count] of countByIdx) {
        if (count > bestCount || (count === bestCount && idx < bestIdx)) {
            bestCount = count;
            bestIdx = idx;
        }
    }

    if (bestIdx >= 0) {
        const panel = panels[bestIdx];
        return { name: panel.name, label: panel.label };
    }
    return { name: `cut_piece_${fallbackIdx}`, label: `Cut piece ${fallbackIdx}` };
}

/**
 * Kiểm tra tính khép kín của mọi Cut_Piece trong model — dựa TRÊN
 * biên ngoài cùng (Outer_Silhouette), bỏ qua các đặc trưng cắt hở
 * nội bộ hợp lệ (relief slit, thumb-cut) — Giai đoạn 2.
 *
 * Quy trình:
 *   1. Gom tất cả segment CUT/BLEED trên TOÀN model.
 *   2. Phân nhóm thành các thành phần liên thông theo endpoint
 *      trùng (SNAP_TOLERANCE) bằng union-find — mỗi thành phần là
 *      một Cut_Piece (giữ nguyên logic Giai đoạn 1).
 *   3. Với mỗi Cut_Piece: gọi `extractOuterSilhouette`:
 *        - `null` (chỉ-CREASE) → bỏ qua, không cảnh báo (Req 1.5).
 *        - `closed === true` → khép kín, kể cả khi còn
 *          Interior_Cut_Feature hở bên trong (Req 2.2). Không cảnh báo.
 *        - `closed === false` (Open_Outer_Boundary) → tạo
 *          `OpenContourWarning` với `gapMm` của biên ngoài, và Panel
 *          đại diện theo Req 2.3 (Req 2.3, 3.4).
 *
 * Dùng đúng `SNAP_TOLERANCE` (0,01 mm) của `sharedGeometry`
 * (Req 2.4). Chỉ-đọc model, không biến đổi (Req 4.2). Lặp lại nhiều
 * lần cho kết quả giống hệt (Req 2.5).
 */
export function validateClosedContours(model: DielineModel): ContourValidationResult {
    const openContours: OpenContourWarning[] = [];

    if (!model || !Array.isArray(model.allPaths)) {
        return { allClosed: true, openContours };
    }

    // 1. Gom tất cả segment CUT/BLEED (biên ngoài) trên TOÀN model.
    const segs: PathSegment[] = model.allPaths.filter(
        (p) => p.tag === 'CUT' || p.tag === 'BLEED',
    );
    const n = segs.length;
    if (n === 0) {
        return { allClosed: true, openContours };
    }

    // Bản đồ segment → panel sở hữu (theo tham chiếu) để chọn panel
    // đại diện; `panels` giữ thứ tự index dùng cho quy tắc đồng hạng.
    const panels: Panel[] = Array.isArray(model.panels) ? model.panels : [];
    const segToPanel = new Map<PathSegment, Panel>();
    for (const panel of panels) {
        const paths = Array.isArray(panel.paths) ? panel.paths : [];
        for (const p of paths) {
            if (!segToPanel.has(p)) segToPanel.set(p, panel);
        }
    }

    // Mọi đầu mút của TOÀN BỘ đoạn (CUT/BLEED/CREASE) — dùng cho phép kiểm
    // khép kín crease-aware: một đầu cắt trùng đầu mút CREASE là chỗ chuyển
    // tiếp sang nếp gập, không phải biên hở (Requirement 2.1, 2.2).
    const allEndpoints: Point2D[] = [];
    for (const p of model.allPaths) {
        const [a, b] = segEndpoints(p);
        allEndpoints.push(a, b);
    }

    // 2. Dựng quan hệ liên thông CUT/BLEED theo endpoint trùng (union-find).
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

    // 3a. Trích xuất biên ngoài (Outer_Silhouette) của TỪNG Cut_Piece một lần
    //     (chỉ-đọc, tái dùng tracePerimeter). Giữ thứ tự ổn định để chỉ số
    //     Cut_Piece xác định (Req 2.5).
    const pieces = [...groups.values()].map((memberIdx) => {
        const componentSegs = memberIdx.map((i) => segs[i]);
        return { componentSegs, silhouette: extractOuterSilhouette(componentSegs) };
    });

    // 3b. Vùng vật liệu để nhận diện Interior_Cut_Feature (Req 1.3, 2.2): một
    //     đầu mút CUT/BLEED mất buddy nằm hẳn (strictly) BÊN TRONG một vùng vật
    //     liệu là đặc trưng cắt hở nội bộ hợp lệ (relief slit / lock slit /
    //     thumb-cut), KHÔNG phải biên ngoài hở. Nguồn vùng vật liệu (chỉ-đọc):
    //       - `Panel.outline` (vùng vật liệu sạch của panel chứa relief/lock slit),
    //       - biên ngoài (silhouette) KHÉP KÍN của Cut_Piece KHÁC (vd thân bì thư
    //         khép kín bao quanh vết cắt ngón thumb-cut).
    //     KHÔNG dùng đường gập toàn cục (CREASE/pivot mọi panel) làm tiêu chí
    //     "đóng": điều đó sẽ nuốt nhầm điểm bạn của một góc biên ngoài bị dịch
    //     (góc gãy nằm trên một nếp gập). Khép kín theo nếp gập đã được phép kiểm
    //     buddy (collectUnbuddiedEndpoints) xử lý — đầu mút trùng đầu mút CREASE
    //     có buddy nên không xuất hiện ở đây.
    const panelOutlines: Point2D[][] = [];
    for (const panel of panels) {
        const o = panel.outline;
        if (Array.isArray(o) && o.length >= 3 && ringAreaAbs(o) > 0) {
            panelOutlines.push(o);
        }
    }
    const closedSils: { idx: number; ring: Point2D[] }[] = [];
    pieces.forEach((pc, idx) => {
        const s = pc.silhouette;
        if (s && s.closed && s.vertices.length >= 3 && s.area > 0) {
            closedSils.push({ idx, ring: s.vertices });
        }
    });

    const strictlyInside = (e: Point2D, poly: Point2D[]): boolean =>
        pointInPolygon(e, poly) && !pointOnBoundary(e, poly);

    // Cạnh gập (pivotEdge) của mọi panel — dùng cho luật "miệng gập theo CẶP":
    // một MIỆNG GẬP của nắp (tuck flap, seal flap…) có CẢ HAI đầu mút mất buddy
    // cùng nằm trên một pivotEdge (cạnh gập). Trái lại, một góc biên ngoài bị
    // dịch chỉ có MỘT đầu mút nằm trên nếp gập (điểm bị dịch lệch trục ra khỏi
    // cạnh gập), nên KHÔNG bị nhận nhầm là miệng gập (Req 2.2, an toàn cho
    // phát hiện biên hở thật).
    const allPivots: [Point2D, Point2D][] = [];
    for (const panel of panels) {
        const pe = panel.pivotEdge;
        if (Array.isArray(pe) && pe.length === 2) allPivots.push([pe[0], pe[1]]);
    }

    // 3c. Xét từng Cut_Piece dựa TRÊN biên ngoài (Outer_Silhouette).
    let cutPieceIndex = 0;
    for (let pIdx = 0; pIdx < pieces.length; pIdx++) {
        const { componentSegs, silhouette } = pieces[pIdx];
        if (!silhouette) {
            cutPieceIndex++;
            continue; // chỉ-CREASE / không có CUT/BLEED → không kiểm (Req 1.5)
        }

        // Tập đầu mút CUT/BLEED mất buddy của Cut_Piece này (crease-aware): đã
        // loại các đầu mút có buddy (kể cả trùng đầu mút CREASE) — chúng là chỗ
        // chuyển tiếp nếp gập, không phải biên hở.
        const unbuddied = collectUnbuddiedEndpoints(componentSegs, allEndpoints);

        // Nắp gập độc lập (standalone foldable flap): TOÀN BỘ đoạn của Cut_Piece
        // thuộc cùng MỘT panel có `pivotEdge` (panel gập được). Đó là một nắp
        // (tuck/seal/dust…) gập vào thân theo cạnh gập; các đầu cắt tự do của nó
        // khép kín khi gập, KHÔNG phải biên ngoài hở (Req 2.2). Bao gồm cả nắp
        // dán cong (rounded seal flap) mà cung không chạm đúng cạnh gập. An toàn
        // cho phát hiện biên hở thật: một biên ngoài lớn (nhiều panel) bị dịch
        // góc gồm đoạn của NHIỀU panel ⇒ KHÔNG phải nắp độc lập; còn mô hình
        // tổng hợp (panel không có `pivotEdge`) cũng không bị nhận nhầm.
        const ownerPanels = new Set(
            componentSegs.map((s) => segToPanel.get(s)).filter((p): p is Panel => !!p),
        );
        // Cả Cut_Piece thuộc MỘT panel gắn vào thân: panel có cạnh gập
        // (`pivotEdge`, vd tuck/seal/dust flap) HOẶC là panel con của một panel
        // khác (`parent` != null, vd vết cắt ngón thumb-cut, cửa sổ window — đặc
        // trưng cắt nội bộ). Đầu cắt tự do của các mảnh này khép kín theo nếp
        // gập / nằm trong vật liệu, KHÔNG phải biên ngoài hở (Req 2.2).
        const lonePanel = ownerPanels.size === 1 ? [...ownerPanels][0] : null;
        const isStandaloneFlap =
            !!lonePanel &&
            ((Array.isArray(lonePanel.pivotEdge) && lonePanel.pivotEdge.length === 2) ||
                lonePanel.parent != null);

        // Miệng gập theo CẶP: đầu mút `e` thuộc miệng gập nếu nó nằm trên một
        // pivotEdge VÀ có MỘT đầu mút mất buddy KHÁC của cùng Cut_Piece cũng nằm
        // trên đúng pivotEdge đó (hai mép của miệng gập). Bắt được nắp gài
        // (tuck) mà KHÔNG nuốt nhầm góc biên ngoài bị dịch (chỉ một đầu nằm trên
        // nếp gập).
        const onFoldMouth = (e: Point2D): boolean => {
            for (const pe of allPivots) {
                if (!pointOnSegment(e, pe[0], pe[1])) continue;
                if (
                    unbuddied.some(
                        (e2) => e2 !== e && pointOnSegment(e2, pe[0], pe[1]),
                    )
                ) {
                    return true;
                }
            }
            return false;
        };

        const isInteriorOrFold = (e: Point2D): boolean => {
            // (i) Nằm hẳn trong biên ngoài (đã lọc đặc trưng nội bộ) của CHÍNH
            //     Cut_Piece này — đầu cắt nội bộ sau khi lọc nằm trong vòng; góc
            //     biên ngoài bị dịch vẫn là đỉnh của vòng (nằm trên biên) nên
            //     KHÔNG bị nuốt nhầm.
            if (silhouette.vertices.length >= 3 && strictlyInside(e, silhouette.vertices)) {
                return true;
            }
            // (ii) Nằm hẳn trong outline vật liệu của một panel (relief/lock slit
            //      của generator thân-nhiều-mảnh như rte/slb).
            for (const poly of panelOutlines) {
                if (strictlyInside(e, poly)) return true;
            }
            // (iii) Nằm hẳn trong biên ngoài KHÉP KÍN của Cut_Piece KHÁC (thumb-cut
            //       nằm trong thân bì thư khép kín).
            for (const cs of closedSils) {
                if (cs.idx !== pIdx && strictlyInside(e, cs.ring)) return true;
            }
            // (iv) Thuộc miệng gập của một nắp (cặp đầu mút cùng nằm trên pivotEdge).
            if (onFoldMouth(e)) return true;
            // (v) Là đầu cắt tự do của một nắp gập độc lập (cả Cut_Piece thuộc
            //     một panel gập được).
            if (isStandaloneFlap) return true;
            return false;
        };

        // Các đầu mút mất buddy là Interior_Cut_Feature (relief slit/thumb-cut
        // nằm trong vùng vật liệu) hoặc miệng/đầu nắp gập → bỏ qua (Req 2.2). Chỉ
        // cảnh báo khi có đầu cắt hở thật trên biên ngoài (Open_Outer_Boundary).
        const genuineOpen = unbuddied.some((e) => !isInteriorOrFold(e));

        if (genuineOpen) {
            const { name, label } = pickRepresentativePanel(
                componentSegs,
                silhouette.vertices,
                segToPanel,
                panels,
                cutPieceIndex,
            );
            // Khoảng hở biên ngoài (Req 2.1, 3.4): khi đúng HAI đầu mút mất buddy
            // (vd: dịch một góc đi `d`), khoảng hở bằng khoảng cách Euclid giữa
            // chúng — đúng bằng độ dời, ổn định kể cả khi chuỗi truy vết suy biến.
            // Trường hợp khác, đo end-to-end trên chuỗi truy vết đầy đủ của
            // Cut_Piece (tái dùng tracePerimeter).
            let gapMm: number;
            if (unbuddied.length === 2) {
                gapMm = Math.hypot(
                    unbuddied[0].x - unbuddied[1].x,
                    unbuddied[0].y - unbuddied[1].y,
                );
            } else {
                const traced = ringGap(tracePerimeter(componentSegs));
                gapMm = Number.isFinite(traced) ? traced : silhouette.gapMm;
            }
            openContours.push({
                panelName: name,
                panelLabel: label,
                gapMm,
                cutPieceIndex,
            });
        }

        cutPieceIndex++;
    }

    return {
        allClosed: openContours.length === 0,
        openContours,
    };
}

// ============================================================
// Outer_Silhouette — Trích xuất biên ngoài cùng (Giai đoạn 2)
//
// Hàm thuần `extractOuterSilhouette` trích xuất đường bao ngoài
// cùng của một Cut_Piece bằng cách TÁI DÙNG `tracePerimeter`
// (Requirement 1.2 — KHÔNG hiện thực thuật toán nối chuỗi thứ
// hai). Phần thêm mới chỉ là chọn lọc vòng ngoài (theo diện tích
// bao) và LỌC Interior_Cut_Feature theo quy tắc khách quan
// (Requirement 1.1, 1.3, 1.4). Hàm chỉ-đọc, không biến đổi đầu
// vào (Requirement 4.2).
// ============================================================

/**
 * Diện tích có dấu (shoelace) của một vòng đỉnh; vòng được đóng
 * ảo bằng cạnh nối đỉnh cuối ↔ đỉnh đầu.
 */
function signedArea(ring: Point2D[]): number {
    let sum = 0;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
}

/**
 * Khoảng hở đầu-cuối (Euclid, mm) của một vòng đỉnh — khoảng cách giữa đỉnh
 * đầu và đỉnh cuối. Vòng < 2 đỉnh coi như hở vô hạn.
 */
function ringGap(ring: Point2D[]): number {
    const n = ring.length;
    if (n < 2) return Infinity;
    return Math.hypot(ring[0].x - ring[n - 1].x, ring[0].y - ring[n - 1].y);
}

/** Diện tích bao (shoelace, trị tuyệt đối) của một vòng đỉnh; 0 nếu < 3 đỉnh. */
function ringAreaAbs(ring: Point2D[]): number {
    return ring.length >= 3 ? Math.abs(signedArea(ring)) : 0;
}

/**
 * `p` có nằm trong dung sai SNAP_TOLERANCE của đoạn thẳng [a, b]
 * không (khoảng cách điểm-đoạn, kẹp tham số chiếu trong [0, 1]).
 */
function pointOnSegment(p: Point2D, a: Point2D, b: Point2D): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-12) {
        return Math.hypot(p.x - a.x, p.y - a.y) <= SNAP_TOLERANCE;
    }
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return Math.hypot(p.x - projX, p.y - projY) <= SNAP_TOLERANCE;
}

/**
 * `p` nằm TRÊN biên ngoài `ring` (một đỉnh hoặc một cạnh, kể cả
 * cạnh đóng vòng ảo cuối↔đầu) trong dung sai SNAP_TOLERANCE
 * (Requirement 1.4).
 */
function pointOnBoundary(p: Point2D, ring: Point2D[]): boolean {
    const n = ring.length;
    for (let i = 0; i < n - 1; i++) {
        if (pointOnSegment(p, ring[i], ring[i + 1])) return true;
    }
    if (n >= 2 && pointOnSegment(p, ring[n - 1], ring[0])) return true;
    return false;
}

/**
 * Ray-casting: `p` nằm BÊN TRONG vùng đa giác mà `ring` bao quanh
 * (vòng được đóng ảo cuối↔đầu).
 */
function pointInPolygon(p: Point2D, ring: Point2D[]): boolean {
    let inside = false;
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[i].x;
        const yi = ring[i].y;
        const xj = ring[j].x;
        const yj = ring[j].y;
        const intersect =
            (yi > p.y) !== (yj > p.y) &&
            p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

/**
 * Một segment là Interior_Cut_Feature nếu nó có đầu mút vừa KHÔNG nằm trên biên
 * ngoài `ring` (ngoài SNAP_TOLERANCE), vừa nằm BÊN TRONG vùng diện tích biên
 * ngoài bao quanh, VÀ là một ĐẦU CẮT CHẾT (dead-end) — tức không trùng đầu mút
 * CUT/BLEED nào khác của chính Cut_Piece (`pieceEndpoints`) — Requirement 1.3, 1.4.
 *
 * Yêu cầu "đầu cắt chết" (unbuddied) là then chốt: đỉnh biên ngoài hợp lệ luôn
 * nối tiếp một đoạn CUT/BLEED kề (có buddy) nên KHÔNG bị nhận nhầm là đặc trưng
 * nội bộ; chỉ relief slit/thumb-cut (kết thúc giữa vật liệu) mới có đầu mút chết
 * nằm trong vùng bao.
 */
function isInteriorFeature(seg: PathSegment, ring: Point2D[], pieceEndpoints: Point2D[]): boolean {
    const [a, b] = segEndpoints(seg);
    for (const e of [a, b]) {
        if (pointOnBoundary(e, ring)) continue;      // nằm trên biên ngoài → không nội bộ
        if (!pointInPolygon(e, ring)) continue;       // nằm ngoài vùng bao → không nội bộ
        // Bên trong & ngoài biên: chỉ là đặc trưng nội bộ nếu là đầu cắt chết.
        let count = 0;
        for (const q of pieceEndpoints) {
            if (ptEq(e, q)) {
                count++;
                if (count >= 2) break;
            }
        }
        if (count < 2) return true; // đầu cắt chết trong vật liệu → Interior_Cut_Feature
    }
    return false;
}

/**
 * Trích xuất Outer_Silhouette từ các đoạn CUT/BLEED của một
 * Cut_Piece (Giai đoạn 2).
 *
 * - Tái dùng `tracePerimeter` để nối chuỗi (Requirement 1.2);
 *   KHÔNG biến đổi đầu vào (Requirement 4.2 — chỉ-đọc).
 * - Trả về `null` khi không có đoạn CUT/BLEED (Cut_Piece
 *   chỉ-CREASE → không có biên ngoài cần kiểm) — Requirement 1.5.
 * - Chọn vòng ngoài cùng theo diện tích bao (shoelace) và LỌC
 *   Interior_Cut_Feature theo quy tắc khách quan rồi nối lại biên
 *   ngoài (Requirement 1.1, 1.3, 1.4).
 * - Đo `gapMm = Euclid(vertices[0], vertices[n-1])`,
 *   `closed = gapMm ≤ SNAP_TOLERANCE`; giữ chuỗi đỉnh hở xác định
 *   khi không khép được (Requirement 1.6, 2.1).
 */
export function extractOuterSilhouette(cutBleedSegs: PathSegment[]): OuterSilhouette | null {
    if (!Array.isArray(cutBleedSegs) || cutBleedSegs.length === 0) {
        return null;
    }

    // Chỉ xét đoạn CUT/BLEED — Cut_Piece chỉ-CREASE không có biên ngoài
    // cần kiểm (Requirement 1.5).
    const segs = cutBleedSegs.filter((s) => s.tag === 'CUT' || s.tag === 'BLEED');
    if (segs.length === 0) {
        return null;
    }

    // Tái dùng tracePerimeter để nối chuỗi (Requirement 1.2) — đây là vòng
    // ứng viên cho biên ngoài cùng.
    const candidate = tracePerimeter(segs);

    // Tập hợp các vòng ứng viên cho biên ngoài cùng. Vòng đầu tiên là vòng
    // truy vết đầy đủ (mọi đoạn CUT/BLEED). Khi vòng ứng viên đủ ≥ 3 đỉnh,
    // thử LỌC Interior_Cut_Feature (đầu mút trong vùng bao & ngoài biên) rồi
    // nối lại biên ngoài bằng chính tracePerimeter — đây là ứng viên thứ hai
    // (Requirement 1.1, 1.3, 1.4). KHÔNG thay thế vô điều kiện: với generator
    // khép kín hoàn toàn (pizza/tray…), vòng đầy đủ đã khép kín và việc lọc có
    // thể loại nhầm đoạn biên ngoài hợp lệ, tạo vòng re-trace HỞ — nên ta CHỌN
    // vòng tốt nhất thay vì ghi đè (sửa hồi quy Workstream A).
    const rings: Point2D[][] = [candidate];
    if (candidate.length >= 3) {
        const pieceEndpoints: Point2D[] = [];
        for (const s of segs) {
            const [a, b] = segEndpoints(s);
            pieceEndpoints.push(a, b);
        }
        const outerSegs = segs.filter((s) => !isInteriorFeature(s, candidate, pieceEndpoints));
        if (outerSegs.length > 0 && outerSegs.length < segs.length) {
            const reTraced = tracePerimeter(outerSegs);
            if (reTraced.length >= 2) {
                rings.push(reTraced);
            }
        }
    }

    // Chọn Outer_Silhouette (Requirement 1.1): vòng có DIỆN TÍCH BAO LỚN NHẤT
    // chứa trọn các đỉnh CUT/BLEED còn lại. Với generator khép kín hoàn toàn
    // (pizza/tray…), vòng truy vết đầy đủ chính là biên ngoài có diện tích lớn
    // nhất; vòng re-trace bị loại nhầm đoạn biên sẽ có diện tích NHỎ HƠN nên
    // KHÔNG được chọn (sửa hồi quy). Với rte/slb/envelope, vòng re-trace (đã loại
    // relief slit/thumb-cut) có diện tích biên ngoài ≥ vòng đầy đủ bị nhiễu nên
    // được chọn (bảo toàn việc bỏ qua đặc trưng nội bộ). Tie-break: giữ vòng đầu
    // (candidate đầy đủ) để xác định (Requirement 2.5).
    let vertices = rings[0];
    let bestArea = ringAreaAbs(rings[0]);
    for (let i = 1; i < rings.length; i++) {
        const r = rings[i];
        const rArea = ringAreaAbs(r);
        if (rArea > bestArea) {
            vertices = r;
            bestArea = rArea;
        }
    }

    // Đo khoảng hở đầu-cuối của biên ngoài (Requirement 2.1). Khi không khép
    // được (chuỗi đỉnh hở), giữ chuỗi xác định và khoảng hở đo được
    // (Requirement 1.6).
    const n = vertices.length;
    const gapMm = ringGap(vertices);
    const closed = Number.isFinite(gapMm) && gapMm <= SNAP_TOLERANCE;
    const area = n >= 3 ? Math.abs(signedArea(vertices)) : 0;

    return { vertices, gapMm, area, closed };
}
