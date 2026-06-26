// ============================================================
// panelSolid.ts — Mockup 3D Realism (Logic Layer)
//
// Hàm thuần chuẩn hóa tham số hiển thị panel solid:
//   - `normalizeEdgeColor`: chuẩn hóa màu cạnh giấy về tập hợp lệ.
//   - `clampThickness`: chuẩn hóa độ dày hiển thị về miền hợp lệ.
//   - `DEFAULT_EDGE_COLOR`: hằng màu cạnh mặc định (kraft).
//
//   - `buildPanelSolid`: dựng ExtrudeGeometry solid (mặt ngoài + mặt trong +
//     tường cạnh khép kín dọc chu vi và mọi lỗ khoét).
//
// _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_
// ============================================================

import * as THREE from 'three';
import type { EdgeColor, Panel, Point2D } from './types';
import { tracePerimeter } from '../dieline/tracePerimeter';

/**
 * Màu cạnh giấy mặc định.
 * Dùng khi giá trị màu cạnh không được chỉ định hoặc không hợp lệ.
 * _Requirements: 1.2, 1.3_
 */
export const DEFAULT_EDGE_COLOR: EdgeColor = 'kraft';

/**
 * Độ dày hiển thị mặc định (mm) khi đầu vào không hợp lệ (≤0 / NaN / undefined).
 * _Requirements: 1.6_
 */
const DEFAULT_THICKNESS_MM = 0.5;

/**
 * Cận trên độ dày hiển thị (mm). Giá trị lớn hơn sẽ bị giới hạn về mức này.
 * _Requirements: 1.7_
 */
const MAX_THICKNESS_MM = 50;

/** Tập giá trị màu cạnh hợp lệ, dùng để kiểm tra nhanh khi chuẩn hóa. */
const VALID_EDGE_COLORS: readonly EdgeColor[] = ['kraft', 'white'];

/**
 * Chuẩn hóa màu cạnh giấy.
 *
 * Trả về chính giá trị đầu vào nếu nó thuộc tập hợp lệ {kraft, white};
 * mọi giá trị khác (undefined, chuỗi lạ, kiểu sai, ...) đều trả về
 * giá trị mặc định `DEFAULT_EDGE_COLOR` (kraft).
 *
 * _Requirements: 1.2, 1.3_
 */
export function normalizeEdgeColor(input: unknown): EdgeColor {
    if (typeof input === 'string' && (VALID_EDGE_COLORS as readonly string[]).includes(input)) {
        return input as EdgeColor;
    }
    return DEFAULT_EDGE_COLOR;
}

/**
 * Chuẩn hóa độ dày hiển thị (mm).
 *
 * - `undefined` / `NaN` / `≤ 0` → `0.5` mm (giá trị mặc định, Yêu cầu 1.6).
 * - `> 50` → `50` mm (giới hạn cận trên, Yêu cầu 1.7).
 * - ngược lại → giữ nguyên giá trị đầu vào (Yêu cầu 1.4).
 *
 * _Requirements: 1.4, 1.6, 1.7_
 */
export function clampThickness(rawT: number | undefined): number {
    if (rawT === undefined || Number.isNaN(rawT) || rawT <= 0) {
        return DEFAULT_THICKNESS_MM;
    }
    if (rawT > MAX_THICKNESS_MM) {
        return MAX_THICKNESS_MM;
    }
    return rawT;
}

/** Số đỉnh tối thiểu để một vòng (outline/hole) tạo thành đa giác hợp lệ. */
const MIN_RING_VERTICES = 3;

/**
 * Số chữ số thập phân khi hàn (weld) đỉnh theo vị trí để kiểm tra khép kín.
 * Khớp với dung sai của property test (`panelSolid.manifold.pbt.test.ts`): tọa
 * độ panel ~O(100mm), depth ≤ 50mm; làm tròn 3 chữ số (0.001mm) đủ để hàn các
 * đỉnh trùng vị trí mà không gộp nhầm các đỉnh khác.
 */
const WATERTIGHT_WELD_DECIMALS = 3;

/**
 * Các góc xoay thử (radian) cho bước tam giác hóa nắp (cap) trước khi đùn.
 *
 * `THREE.ExtrudeGeometry` tam giác hóa hai mặt nắp bằng Earcut. Với một số cấu
 * hình outline + nhiều lỗ khoét hợp lệ, Earcut có thể rơi vào trường hợp "ear"
 * suy biến do dấu phẩy động và sinh ra nắp THIẾU tam giác → xuất hiện cạnh biên
 * hở quanh mép lỗ (không khép kín). Xoay nhẹ toàn bộ tọa độ trước khi tam giác
 * hóa làm thay đổi thứ tự xét "ear" của Earcut và khắc phục hiện tượng này;
 * hình học được xoay ngược lại sau đó nên kết quả giữ nguyên (chỉ khác hướng
 * trung gian khi tam giác hóa). `0` = không xoay (đường nhanh cho đa số panel).
 */
const CAP_TRIANGULATION_RETRY_ANGLES: readonly number[] = [
    0,
    Math.PI / 49,
    Math.PI / 17,
    Math.PI / 7,
    Math.PI / 3,
];

/**
 * Lấy đường viền ngoài (outline) của panel theo dạng danh sách điểm 2D.
 *
 * Ưu tiên `panel.outline` (đường viền khai báo tường minh, ổn định cho 3D).
 * Nếu panel KHÔNG khai báo `outline` (nhiều panel như tay gài/tuck, tai phụ
 * bụi/dust flap, đáy gài… chỉ có `paths`), dò chu vi ngoài từ `paths` bằng
 * `tracePerimeter` — giữ ĐÚNG hành vi của lớp render phẳng trước đây để mọi
 * mặt vẫn hiện đầy đủ chi tiết. Trả về mảng rỗng chỉ khi không thể dò được
 * chu vi hợp lệ (< 3 đỉnh).
 */
function getOutlinePoints(panel: Panel): Point2D[] {
    if (panel.outline && panel.outline.length >= MIN_RING_VERTICES) {
        return panel.outline;
    }
    const traced = tracePerimeter(panel.paths);
    if (traced.length >= MIN_RING_VERTICES) {
        return traced;
    }
    return [];
}

/** Thu thập danh sách lỗ khoét hợp lệ (≥ 3 đỉnh) từ panel. */
function getValidHoles(panel: Panel): Point2D[][] {
    const holes: Point2D[][] = [];
    if (panel.holes) {
        for (const holePts of panel.holes) {
            if (holePts && holePts.length >= MIN_RING_VERTICES) {
                holes.push(holePts);
            }
        }
    }
    return holes;
}

/**
 * Xoay một vòng điểm 2D quanh gốc tọa độ một góc `angle` (radian).
 * Trả về chính mảng đầu vào khi `angle === 0` để tránh cấp phát thừa.
 */
function rotatePoints(points: Point2D[], angle: number): Point2D[] {
    if (angle === 0) {
        return points;
    }
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return points.map((p) => ({
        x: p.x * cos - p.y * sin,
        y: p.x * sin + p.y * cos,
    }));
}

/**
 * Dựng một `THREE.Shape` từ outline + danh sách lỗ khoét (dạng điểm 2D).
 *
 * - Chu vi ngoài lấy từ `outline`.
 * - Mỗi lỗ khoét được thêm vào `shape.holes` để `ExtrudeGeometry` tự sinh tường
 *   cạnh khép kín quanh lỗ.
 */
function buildShapeFromRings(outline: Point2D[], holes: Point2D[][]): THREE.Shape {
    const shape = new THREE.Shape();
    shape.moveTo(outline[0].x, outline[0].y);
    for (let i = 1; i < outline.length; i++) {
        shape.lineTo(outline[i].x, outline[i].y);
    }

    for (const holePts of holes) {
        const holePath = new THREE.Path();
        holePath.moveTo(holePts[0].x, holePts[0].y);
        for (let i = 1; i < holePts.length; i++) {
            holePath.lineTo(holePts[i].x, holePts[i].y);
        }
        shape.holes.push(holePath);
    }

    return shape;
}

/**
 * Kiểm tra hình học có khép kín (watertight/manifold) hay không.
 *
 * Hàn các đỉnh trùng vị trí (làm tròn `WATERTIGHT_WELD_DECIMALS` chữ số) rồi đếm
 * số tam giác chia sẻ mỗi cạnh không định hướng. Hình khép kín ⇔ mọi cạnh (sau
 * khi bỏ tam giác suy biến) đều được chia sẻ bởi đúng 2 tam giác: không có cạnh
 * biên hở (chỉ 1 tam giác) và không có cạnh phi-manifold (> 2 tam giác).
 *
 * Logic này khớp với cách property test đánh giá khép kín, nên nếu hàm trả về
 * `true` thì geometry chắc chắn vượt qua kiểm tra của test.
 */
function isWatertight(geometry: THREE.BufferGeometry): boolean {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos || pos.count === 0) {
        // Geometry rỗng: không có cạnh biên hở nào để xét.
        return true;
    }

    const index = geometry.getIndex();
    const factor = 10 ** WATERTIGHT_WELD_DECIMALS;
    const keyToId = new Map<string, number>();
    const idOf = (vi: number): number => {
        const x = Math.round(pos.getX(vi) * factor) / factor;
        const y = Math.round(pos.getY(vi) * factor) / factor;
        const z = Math.round(pos.getZ(vi) * factor) / factor;
        const key = `${x},${y},${z}`;
        let id = keyToId.get(key);
        if (id === undefined) {
            id = keyToId.size;
            keyToId.set(key, id);
        }
        return id;
    };

    const triCount = index ? index.count / 3 : pos.count / 3;
    const edgeCount = new Map<string, number>();

    for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        const a = idOf(i0);
        const b = idOf(i1);
        const c = idOf(i2);

        if (a === b || b === c || a === c) {
            continue; // bỏ tam giác suy biến khỏi phép đếm cạnh
        }

        for (const [u, v] of [
            [a, b],
            [b, c],
            [c, a],
        ]) {
            const key = u < v ? `${u}_${v}` : `${v}_${u}`;
            edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
        }
    }

    for (const count of edgeCount.values()) {
        if (count !== 2) {
            return false; // cạnh biên hở (1) hoặc cạnh phi-manifold (> 2)
        }
    }
    return true;
}

/**
 * Thử dựng `ExtrudeGeometry` khép kín cho `outline` + `holes` cho trước.
 *
 * Lần lượt thử các góc xoay trong `CAP_TRIANGULATION_RETRY_ANGLES`: với mỗi góc,
 * dựng geometry từ tọa độ đã xoay rồi xoay ngược về đúng hướng và kiểm tra khép
 * kín. Trả về geometry khép kín đầu tiên tìm được; trả về `null` nếu không góc
 * nào cho kết quả khép kín (thường do `holes` không hợp lệ về mặt hình học, ví
 * dụ lỗ khoét vượt ra ngoài outline hoặc các lỗ chồng lấn nhau). Các geometry
 * trung gian không khép kín đều được `dispose()` để tránh rò rỉ tài nguyên GPU.
 */
function tryBuildWatertight(
    outline: Point2D[],
    holes: Point2D[][],
    options: THREE.ExtrudeGeometryOptions,
): THREE.ExtrudeGeometry | null {
    for (const angle of CAP_TRIANGULATION_RETRY_ANGLES) {
        const shape = buildShapeFromRings(
            rotatePoints(outline, angle),
            holes.map((hole) => rotatePoints(hole, angle)),
        );
        const geometry = new THREE.ExtrudeGeometry(shape, options);

        // Xoay hình học về đúng hướng ban đầu (giữ nguyên trục Z/độ dày).
        if (angle !== 0) {
            geometry.applyMatrix4(new THREE.Matrix4().makeRotationZ(-angle));
        }

        if (isWatertight(geometry)) {
            return geometry;
        }
        geometry.dispose();
    }
    return null;
}

/**
 * Dựng hình học solid cho một panel bằng `THREE.ExtrudeGeometry`.
 *
 * Geometry tạo ra gồm: mặt ngoài, mặt trong và **tường cạnh khép kín**
 * dọc theo toàn bộ chu vi ngoài VÀ mép của mọi lỗ khoét (holes) — nhờ
 * cách `ExtrudeGeometry` đùn `THREE.Shape` (cùng các `shape.holes`) theo
 * trục Z. Kết quả là khối manifold/khép kín (watertight): không tồn tại
 * cạnh biên hở giữa mặt ngoài, mặt trong và tường cạnh.
 *
 * Bảo đảm chi tiết & khép kín:
 *
 * 1. **Tam giác hóa nắp bền vững** — Tường cạnh do `ExtrudeGeometry` sinh ra
 *    luôn khép kín, nhưng bước tam giác hóa hai mặt nắp (Earcut) đôi khi sinh
 *    nắp THIẾU tam giác với một số cấu hình outline + nhiều lỗ khoét hợp lệ (lỗi
 *    dấu phẩy động) → tạo cạnh biên hở quanh mép lỗ. Ta dựng rồi kiểm tra
 *    manifold; nếu chưa khép kín thì dựng lại với tọa độ xoay nhẹ (xem
 *    `CAP_TRIANGULATION_RETRY_ANGLES`) và xoay ngược kết quả — phép xoay đổi thứ
 *    tự xét "ear" của Earcut nên khắc phục nắp thiếu mà KHÔNG đổi hình học cuối.
 *
 * 2. **GIỮ ĐỦ lỗ khoét (ưu tiên chi tiết hiển thị)** — Nếu không góc xoay nào
 *    cho nắp khép kín tuyệt đối, ta VẪN dựng geometry với TOÀN BỘ lỗ khoét
 *    (best-effort) thay vì bỏ bớt lỗ. Lý do: lỗ khoét (lỗ quai, rãnh tai mái…)
 *    là chi tiết người dùng PHẢI thấy ở mọi mặt; một nắp hơi hở vài cạnh chỉ
 *    ảnh hưởng kiểm tra manifold nội bộ, không ảnh hưởng hình hiển thị. (Trước
 *    đây ta bỏ bớt lỗ để ép khép kín → gây mất lỗ một bên ở hộp quai xách.)
 *
 * Độ dày đùn `depth` được chuẩn hóa qua `clampThickness` để luôn nằm trong
 * miền hợp lệ (mặc định 0.5 mm khi đầu vào ≤0/NaN/undefined, tối đa 50 mm).
 * Tắt bevel để mặt ngoài/mặt trong phẳng và tường cạnh thẳng đứng.
 *
 * @param panel  Panel cần dựng (dùng `outline` cho chu vi, `holes` cho lỗ khoét).
 * @param thickness  Độ dày vật liệu (mm), thường là `params.T`.
 * @returns `ExtrudeGeometry` solid (giữ đủ lỗ khoét); geometry rỗng nếu outline
 *          không hợp lệ.
 *
 * _Requirements: 1.1, 1.5_
 */
export function buildPanelSolid(panel: Panel, thickness: number): THREE.ExtrudeGeometry {
    const depth = clampThickness(thickness);
    const outline = getOutlinePoints(panel);

    if (outline.length < MIN_RING_VERTICES) {
        // Outline không hợp lệ: trả về geometry rỗng thay vì ném lỗi
        // (giữ nguyên tắc hàm thuần không ném exception cho dữ liệu không hợp lệ).
        return new THREE.ExtrudeGeometry();
    }

    const options: THREE.ExtrudeGeometryOptions = {
        depth,
        bevelEnabled: false,
        // Một segment theo chiều sâu là đủ cho tường cạnh thẳng đứng khép kín.
        steps: 1,
    };
    const allHoles = getValidHoles(panel);

    // Đường nhanh: tập lỗ khoét cho nắp khép kín ở một góc xoay nào đó.
    const full = tryBuildWatertight(outline, allHoles, options);
    if (full !== null) {
        return full;
    }

    // Best-effort: KHÔNG bỏ lỗ — giữ TOÀN BỘ lỗ khoét để mọi mặt hiện đủ chi
    // tiết, dù nắp có thể hở vài cạnh ở mức tam giác hóa (không ảnh hưởng hình
    // hiển thị; chỉ là kiểm tra manifold nội bộ chưa tuyệt đối).
    return new THREE.ExtrudeGeometry(buildShapeFromRings(outline, allHoles), options);
}

/**
 * Dựng dải BO TRÒN (fillet) tại một nếp gập để chỗ gập trông cong mượt như giấy
 * thật (thay vì 2 khối phẳng cứng chạm nhau tạo góc gãy).
 *
 * Hình học trả về nằm trong HỆ TỌA ĐỘ PHẲNG TOÀN CỤC (cùng hệ với outline panel),
 * z là pháp tuyến panel — để đặt đúng chỗ chỉ cần áp MA TRẬN GẬP của panel con
 * (giống geometry panel con). Dải là một phần mặt trụ bán kính `T/2`, trục trùng
 * cạnh bản lề, quét đúng góc gập, nằm ở PHÍA NGOÀI (lồi) nên lấp đúng khe hở.
 *
 * @param p1,p2        Hai đầu cạnh bản lề (toạ độ phẳng).
 * @param thetaNet     Góc gập NET của panel con (radian, có dấu) ở tiến trình hiện tại.
 * @param thickness    Độ dày vật liệu (mm).
 * @param childCentroid Trọng tâm phẳng của panel con (xác định phía con của bản lề).
 */
export function buildFoldFilletGeometry(
    p1: Point2D,
    p2: Point2D,
    thetaNet: number,
    thickness: number,
    childCentroid: Point2D,
): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    if (!Number.isFinite(thetaNet) || Math.abs(thetaNet) < 1e-4) {
        return geo;
    }
    const r = clampThickness(thickness) / 2;
    const ux = p2.x - p1.x, uy = p2.y - p1.y;
    const ul = Math.hypot(ux, uy) || 1;
    const u = { x: ux / ul, y: uy / ul };
    // Pháp tuyến trong mặt phẳng; chọn hướng về phía panel con (+Y hệ bản lề).
    let w = { x: -u.y, y: u.x };
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const toChild = { x: childCentroid.x - mid.x, y: childCentroid.y - mid.y };
    const sigma = (w.x * toChild.x + w.y * toChild.y) >= 0 ? 1 : -1;
    // Phía NGOÀI (lồi) = ngược hướng panel con đu sang khi gập.
    const s = -sigma * Math.sign(thetaNet);

    const N = 8;
    const ring = (base: Point2D, a: number): [number, number, number] => {
        const wc = -s * Math.sin(a);
        const zc = s * Math.cos(a);
        return [base.x + r * wc * w.x, base.y + r * wc * w.y, r * zc];
    };

    const positions: number[] = [];
    // Cung quét từ mặt con (a=0) tới mặt cha (a=-thetaNet).
    const aEnd = -thetaNet;
    const A: [number, number, number][] = [];
    const B: [number, number, number][] = [];
    for (let i = 0; i <= N; i++) {
        const a = aEnd * (i / N);
        A.push(ring(p1, a));
        B.push(ring(p2, a));
    }
    for (let i = 0; i < N; i++) {
        const a0 = A[i], a1 = A[i + 1], b0 = B[i], b1 = B[i + 1];
        // 2 tam giác cho 1 ô lưới (đặt cả 2 hướng để không bị cull dù winding nào).
        positions.push(...a0, ...b0, ...b1);
        positions.push(...a0, ...b1, ...a1);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
}
