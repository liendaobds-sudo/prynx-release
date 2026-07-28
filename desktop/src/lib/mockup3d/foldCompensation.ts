// ============================================================
// Fold Thickness Compensation — Mockup 3D Realism (Logic Layer)
//
// Hàm thuần tính lượng bù độ dày khi gập panel. Tách khỏi lớp
// render R3F để kiểm thử thuộc tính bằng `fast-check` mà không
// cần WebGL.
//
// Task 3.1 triển khai `computeFoldThicknessOffset`.
// Task 3.2 triển khai `applyFoldCompensation` + `FoldCompResult`.
// _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
// ============================================================

import * as THREE from 'three';
import type { Panel, Point2D } from './types';

/**
 * Scratch dùng riêng cho một panel trong vòng render; không chia sẻ giữa các panel.
 * [PERF (audit 2026-07-27 §DT3D-004)] Giảm cấp phát Matrix4 trong mỗi frame.
 */
export interface FoldCompensationScratch {
    result: THREE.Matrix4;
    step: THREE.Matrix4;
    temp: THREE.Matrix4;
}

interface FoldLookup {
    byName: Map<string, Panel>;
    chainByPanel: WeakMap<Panel, Panel[]>;
}

// Model dieline bất biến trong suốt một lượt render; cache theo identity của mảng panel.
// WeakMap tránh giữ model cũ sau khi đổi khuôn.
const foldLookupCache = new WeakMap<Panel[], FoldLookup>();

function getFoldLookup(allPanels: Panel[]): FoldLookup {
    const cached = foldLookupCache.get(allPanels);
    if (cached) return cached;

    const byName = new Map<string, Panel>();
    for (const candidate of allPanels) {
        // Giữ đúng semantics của allPanels.find(): tên trùng lấy panel đầu tiên.
        if (!byName.has(candidate.name)) byName.set(candidate.name, candidate);
    }
    const created: FoldLookup = {
        byName,
        chainByPanel: new WeakMap(),
    };
    foldLookupCache.set(allPanels, created);
    return created;
}

function getParentChain(panel: Panel, lookup: FoldLookup): Panel[] {
    const cached = lookup.chainByPanel.get(panel);
    if (cached) return cached;

    const chain: Panel[] = [];
    const visited = new Set<string>();
    let current: Panel | undefined = panel;
    while (current && !visited.has(current.name)) {
        visited.add(current.name);
        chain.push(current);
        current = current.parent ? lookup.byName.get(current.parent) : undefined;
    }
    lookup.chainByPanel.set(panel, chain);
    return chain;
}

/**
 * Cận dưới của miền bù độ dày khi gập (mm).
 * _Requirements: 2.1_
 */
export const MIN_FOLD_COMP_MM = 0.01;

/**
 * Cận trên của miền bù độ dày khi gập (mm).
 * _Requirements: 2.1_
 */
export const MAX_FOLD_COMP_MM = 5.0;

/**
 * Lượng dịch bù tối đa THỰC SỰ ÁP vào ma trận gập (mm). Mỗi panel đã được ép
 * khối dày T nên không cần dịch panel theo cả độ dày (sẽ hở khớp gập). Chỉ giữ
 * một lượng tách rất nhỏ để tránh z-fighting giữa các mặt đồng phẳng.
 */
export const FOLD_COMP_VISUAL_MM = 0.1;

/**
 * Giới hạn lượng bù về miền hợp lệ [0.01, 5.00] mm.
 * Giá trị không hữu hạn (NaN/Infinity) được quy về cận dưới để
 * hàm logic thuần không ném lỗi với dữ liệu đầu vào bất thường.
 */
function clampFoldComp(value: number): number {
    if (!Number.isFinite(value) || value < MIN_FOLD_COMP_MM) {
        return MIN_FOLD_COMP_MM;
    }
    if (value > MAX_FOLD_COMP_MM) {
        return MAX_FOLD_COMP_MM;
    }
    return value;
}

/**
 * Tính lượng dịch bù độ dày cho panel khi gập, CHỈ dựa trên hình học
 * (depth, thickness, foldAngle) — KHÔNG dùng tên panel làm dữ liệu
 * đầu vào (Yêu cầu 2.4).
 *
 * Lượng bù được trả về theo pháp tuyến trục gập (đơn vị mm) và:
 * - Tỉ lệ (đơn điệu không giảm) theo `thickness` (Yêu cầu 2.1).
 * - Tăng theo độ gập: góc gập càng lớn cần bù càng nhiều
 *   (hệ số `|sin(foldAngle/2)|` ∈ [0, 1]).
 * - Tích lũy theo độ sâu `depth` trong cây gập (mỗi tầng gập
 *   cộng thêm bề dày vật liệu).
 * - Luôn được giới hạn về miền hợp lệ [0.01, 5.00] mm (Yêu cầu 2.1).
 *
 * Hàm thuần, không ném lỗi: đầu vào không hữu hạn hoặc thickness ≤ 0
 * trả về cận dưới của miền bù.
 *
 * _Requirements: 2.1, 2.4_
 */
export function computeFoldThicknessOffset(args: {
    /** Độ sâu của panel trong cây gập (số tầng gập tích lũy). */
    depth: number;
    /** Độ dày vật liệu (mm); lượng bù tỉ lệ theo giá trị này. */
    thickness: number;
    /** Góc gập mục tiêu (độ). */
    foldAngleDeg: number;
}): number {
    const { depth, thickness, foldAngleDeg } = args;

    // Độ dày không hợp lệ → bù tối thiểu (không ném lỗi).
    if (!Number.isFinite(thickness) || thickness <= 0) {
        return MIN_FOLD_COMP_MM;
    }

    // Số tầng gập tích lũy: ít nhất 1 tầng cho panel có quan hệ gập.
    const depthFactor = Number.isFinite(depth) && depth > 0 ? depth : 1;

    // Hệ số theo góc gập: |sin(góc/2)| ∈ [0, 1]; góc càng lớn bù càng nhiều.
    const safeAngleDeg = Number.isFinite(foldAngleDeg) ? Math.abs(foldAngleDeg) : 0;
    const halfAngleRad = (safeAngleDeg * Math.PI) / 180 / 2;
    const angleFactor = Math.abs(Math.sin(halfAngleRad));

    // Bù tỉ lệ theo độ dày, hệ số góc gập và độ sâu cây gập.
    const raw = thickness * angleFactor * depthFactor;

    return clampFoldComp(raw);
}

// ============================================================
// applyFoldCompensation — Task 3.2
// _Requirements: 2.2, 2.3, 2.5, 2.6_
// ============================================================

/**
 * Kết quả áp bù độ dày khi gập cho một panel.
 *
 * - `matrix`: ma trận biến đổi tuyệt đối của panel ở tiến trình gập hiện tại
 *   (đã tích lũy biến đổi của các panel cha). Khi `skipped = true`, ma trận
 *   giữ nguyên **vị trí gập cơ bản** (không áp lượng bù độ dày).
 * - `skipped`: `true` nếu panel có quan hệ gập nhưng thiếu/không hợp lệ một
 *   trong các thuộc tính hình học (pivotEdge, parent, depth) → bỏ qua bù
 *   an toàn (Yêu cầu 2.6).
 * - `warning`: thông điệp xác định panel bị bỏ qua (chỉ có khi `skipped`).
 *
 * _Requirements: 2.2, 2.3, 2.6_
 */
export interface FoldCompResult {
    matrix: THREE.Matrix4;
    skipped: boolean;
    warning?: string;
}

/** Đổi độ sang radian. */
const deg2rad = (d: number): number => (d * Math.PI) / 180;

/**
 * Lượng dịch Z (renderZShift) ÁP THỰC TẾ cho panel tại tiến trình gập hiện tại
 * — TỈ LỆ theo mức gập đã hoàn thành của chính panel (0 khi còn phẳng → đẩy
 * đủ khi gập hết). Nhờ vậy mí miệng KHÔNG bị đẩy lùi khỏi mặt phẳng thân khi
 * chưa gập (tránh "nắp gập rời ra khỏi thân"); chỉ lùi dần vào trong khi gập.
 */
function zShiftFor(panel: Panel, currentFoldAngleDeg: number): number {
    const z = panel.renderZShift ?? 0;
    if (z === 0) return 0;
    const fullNet = panel.foldAngle * (panel.foldDirection || 1);
    if (fullNet === 0) return 0;
    const frac = Math.max(0, Math.min(1, currentFoldAngleDeg / fullNet));
    return z * frac;
}

/** Kiểm tra một điểm 2D có tọa độ hữu hạn. */
function isFinitePoint(p: Point2D | undefined | null): p is Point2D {
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * Kiểm tra cạnh bản lề (pivotEdge) hợp lệ: đúng 2 điểm, tọa độ hữu hạn,
 * và hai điểm không trùng nhau (có phương trục gập xác định).
 */
function isValidPivotEdge(
    pivotEdge: [Point2D, Point2D] | null | undefined,
): pivotEdge is [Point2D, Point2D] {
    if (!Array.isArray(pivotEdge) || pivotEdge.length !== 2) return false;
    const [a, b] = pivotEdge;
    if (!isFinitePoint(a) || !isFinitePoint(b)) return false;
    return Math.hypot(b.x - a.x, b.y - a.y) > 1e-9;
}

/**
 * Một panel "có quan hệ gập" khi nó được dự kiến gập: có panel cha, có cạnh
 * bản lề, hoặc có góc gập khác 0. Dùng để phân biệt panel gốc/không gập
 * (không cần bù) với panel gập thiếu dữ liệu (phải bỏ qua + cảnh báo).
 */
function hasFoldRelation(panel: Panel): boolean {
    return (
        panel.parent !== null ||
        panel.pivotEdge !== null ||
        (Number.isFinite(panel.foldAngle) && panel.foldAngle !== 0)
    );
}

/**
 * Lấy độ sâu hợp lệ của panel trong cây gập từ `depthMap`.
 * Trả về `null` nếu thiếu hoặc không hữu hạn.
 */
function getValidDepth(name: string, depthMap: Map<string, number>): number | null {
    if (!depthMap.has(name)) return null;
    const d = depthMap.get(name)!;
    return Number.isFinite(d) && d >= 0 ? d : null;
}

/**
 * Góc gập thực tế tại `foldProgress` cho một panel — CHỈ dựa trên dữ liệu hình
 * học/gập của panel (foldAngle, foldPhase, foldDirection, depth), KHÔNG dùng
 * tên panel (Yêu cầu 2.4). Hàm chỉ đọc, không thay đổi foldPhase/depth (Yêu cầu 2.5).
 */
function effectiveFoldAngle(
    panel: Panel,
    foldProgress: number,
    depth: number,
    maxD: number,
): number {
    if (!Number.isFinite(panel.foldAngle) || panel.foldAngle === 0) return 0;

    let phaseStart: number;
    let phaseEnd: number;
    if (panel.foldPhase) {
        [phaseStart, phaseEnd] = panel.foldPhase;
    } else {
        // Auto-phase theo độ sâu: panel sâu hơn gập muộn hơn.
        const step = maxD > 0 ? 1 / (maxD + 1) : 1;
        phaseStart = depth * step;
        phaseEnd = (depth + 1) * step;
    }

    const span = phaseEnd - phaseStart;
    const localProgress =
        span !== 0 ? Math.max(0, Math.min(1, (foldProgress - phaseStart) / span)) : 0;

    // Ease in-out cho hoạt ảnh mượt.
    const eased =
        localProgress < 0.5
            ? 2 * localProgress * localProgress
            : 1 - Math.pow(-2 * localProgress + 2, 2) / 2;

    return panel.foldAngle * eased * (panel.foldDirection || 1);
}

/**
 * Dựng ma trận gập của MỘT tầng (panel) quanh cạnh bản lề của nó, kèm lượng
 * bù độ dày tùy chọn.
 *
 * Lượng bù `comp` (mm) được áp trong hệ quy chiếu cục bộ của cạnh bản lề
 * (trục bản lề trùng X), theo phương vuông góc với trục bản lập (local Y) — do
 * đó độc lập hoàn toàn với hướng/tên panel (Yêu cầu 2.4). Khi `comp = 0`, ma
 * trận là vị trí gập cơ bản (không bù).
 */
function buildFoldMatrix(
    pivotEdge: [Point2D, Point2D],
    foldAngleDeg: number,
    comp: number,
    zShift: number,
    out: THREE.Matrix4,
    temp: THREE.Matrix4,
): THREE.Matrix4 {
    const [p1, p2] = pivotEdge;
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const foldRad = deg2rad(foldAngleDeg);

    // [PERF (audit 2026-07-27 §DT3D-004)] Dùng một temp Matrix4 cho cả chuỗi phép nhân.
    const mat = out.identity();
    if (zShift !== 0) {
        mat.multiply(temp.makeTranslation(0, 0, zShift));
    }
    mat.multiply(temp.makeTranslation(midX, midY, 0));
    mat.multiply(temp.makeRotationZ(angle));
    mat.multiply(temp.makeRotationX(foldRad));

    // Panel solid đã có bề dày T; chỉ giữ bù thị giác rất nhỏ để tránh z-fighting.
    const visualComp = Math.sign(comp) * Math.min(Math.abs(comp), FOLD_COMP_VISUAL_MM);
    if (visualComp !== 0) {
        mat.multiply(temp.makeTranslation(0, visualComp, 0));
    }
    mat.multiply(temp.makeRotationZ(-angle));
    mat.multiply(temp.makeTranslation(-midX, -midY, 0));
    return mat;
}

/**
 * Áp bù độ dày khi gập cho `panel`, trả về ma trận biến đổi tuyệt đối của nó
 * tại `foldProgress`.
 *
 * Hành vi:
 * - Tính lượng bù CHỈ dựa trên hình học gập (pivotEdge, parent, depth) và độ
 *   dày vật liệu — KHÔNG dùng tên panel (Yêu cầu 2.4). Lượng bù lấy từ
 *   `computeFoldThicknessOffset` (đã clamp về [0.01, 5.00] mm), dấu lấy theo
 *   `foldDirection`.
 * - Giữ nguyên `foldPhase`/`depth` của mọi panel: hàm chỉ ĐỌC dữ liệu, không
 *   thay đổi `panel` hay `depthMap` (Yêu cầu 2.5).
 * - Nếu panel CÓ quan hệ gập nhưng thiếu/không hợp lệ pivotEdge, parent hoặc
 *   depth → trả về `skipped = true`, `warning` xác định panel, và ma trận giữ
 *   nguyên vị trí gập cơ bản (không áp bù) (Yêu cầu 2.6).
 * - Panel gốc/không gập → ma trận đơn vị, `skipped = false`.
 *
 * Ma trận tuyệt đối được tích lũy bằng cách đi ngược lên chuỗi panel cha; mỗi
 * tầng cha hợp lệ đóng góp ma trận gập + bù của riêng nó.
 *
 * _Requirements: 2.2, 2.3, 2.5, 2.6_
 */
export function applyFoldCompensation(
    panel: Panel,
    allPanels: Panel[],
    foldProgress: number,
    depthMap: Map<string, number>,
    maxD: number,
    thickness: number,
    scratch?: FoldCompensationScratch,
): FoldCompResult {
    const matrix = (scratch?.result ?? new THREE.Matrix4()).identity();
    const stepMatrix = scratch?.step ?? new THREE.Matrix4();
    const tempMatrix = scratch?.temp ?? new THREE.Matrix4();

    let skipped = false;
    let warning: string | undefined;

    // Đánh giá tính hợp lệ hình học của panel mục tiêu để quyết định skip/cảnh báo.
    if (hasFoldRelation(panel)) {
        const targetDepth = getValidDepth(panel.name, depthMap);
        const targetGeometryValid =
            isValidPivotEdge(panel.pivotEdge) && panel.parent !== null && targetDepth !== null;
        if (!targetGeometryValid) {
            skipped = true;
            warning = `Panel ${panel.name} thiếu pivotEdge/parent/depth`;
        }
    }

    // [PERF (audit 2026-07-27 §DT3D-004)] Chuỗi cha được cache theo model,
    // không tạo Set và không allPanels.find cho từng panel ở từng frame.
    const chain = getParentChain(panel, getFoldLookup(allPanels));
    for (const current of chain) {
        const pivot = current.pivotEdge;
        if (isValidPivotEdge(pivot) && current.parent !== null) {
            const depth = getValidDepth(current.name, depthMap);
            const foldAngleDeg = effectiveFoldAngle(current, foldProgress, depth ?? 0, maxD);

            let comp = 0;
            if (depth !== null) {
                const offset = computeFoldThicknessOffset({
                    depth,
                    thickness,
                    foldAngleDeg,
                });
                const sign = (current.foldDirection || 1) >= 0 ? 1 : -1;
                comp = offset * sign;
            }

            const mat = buildFoldMatrix(
                pivot,
                foldAngleDeg,
                comp,
                zShiftFor(current, foldAngleDeg),
                stepMatrix,
                tempMatrix,
            );
            // Premultiply để biến đổi của cha áp sau biến đổi của con.
            matrix.premultiply(mat);
        }
    }

    return { matrix, skipped, warning };
}
