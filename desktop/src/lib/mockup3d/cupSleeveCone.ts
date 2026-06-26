// ============================================================
// cupSleeveCone.ts — Mockup 3D: thân bọc ly = mặt NÓN CỤT
//
// Bọc ly ở dạng phẳng là HÌNH QUẠT CUNG (annular sector). Khi đóng vào ly
// thật nó CUỘN thành mặt NÓN CỤT khớp d1 (đáy nhỏ) / d2 (miệng lớn).
//
// Mô hình cuốn dùng phép TRẢI KHẢ TRIỂN (developable) ĐÚNG hình học nên GIỮ
// độ cong của cung khuôn 2D: nội suy nửa-góc đỉnh nón β từ 90° (phẳng) →
// β_full (nón). Vì khi trải phẳng, quạt nằm trong mặt phẳng VUÔNG GÓC trục
// nón (nằm ngang), ta thêm một phép NGHIÊNG quanh trục X phụ thuộc `roll` để
// ở trạng thái mở, khuôn ĐỨNG thẳng hướng camera (như xem khuôn 2D), còn khi
// đóng thì nón đứng trục Y. Tất cả nét/tai dán dùng CHUNG `makeConeTransform`
// nên luôn khớp mặt ở mọi mức cuốn.
// ============================================================

import * as THREE from 'three';

/** Tham số mô tả mặt nón cụt đích (đơn vị mm; góc rad). */
export interface ConeWarpParams {
    r1: number;
    r2: number;
    d1: number;
    d2: number;
    fullCircleTheta: number;
    coneVerticalH: number;
    psiMax: number;
}

/** Thông số bọc ly cần để suy ra hình nón (lấy từ `dieline.params`). */
export interface CupSleeveDims {
    cupD1: number;
    cupD2: number;
    cupH: number;
    cupHeightType: 'vertical' | 'slant';
    cupCoverage: number;
}

/** Suy ra tham số nón cụt từ thông số bọc ly (khớp `generateCupSleeve`). */
export function computeConeWarp(dims: CupSleeveDims): ConeWarpParams {
    const smallDiameter = dims.cupD1 / 10;
    const largeDiameter = dims.cupD2 / 10;
    const height = dims.cupH / 10;

    const d1Valid = Math.max(0.1, smallDiameter);
    const d2Valid = Math.max(d1Valid + 0.1, largeDiameter);
    const hValid = Math.max(0.1, height);

    const baseHalf = (d2Valid - d1Valid) / 2;
    const slantHeight =
        dims.cupHeightType === 'slant'
            ? hValid
            : Math.sqrt(hValid * hValid + baseHalf * baseHalf);

    const r1Cm = (d1Valid * slantHeight) / (d2Valid - d1Valid);
    const r2Cm = r1Cm + slantHeight;
    const fullCircleTheta = (Math.PI * d1Valid) / r1Cm;

    const SCALE = 10;
    const r1 = r1Cm * SCALE;
    const r2 = r2Cm * SCALE;
    const d1mm = d1Valid * SCALE;
    const d2mm = d2Valid * SCALE;

    const slantMm = slantHeight * SCALE;
    const dRad = (d2mm - d1mm) / 2;
    const coneVerticalH = Math.sqrt(Math.max(0, slantMm * slantMm - dRad * dRad));

    const coverage = Math.max(10, Math.min(110, dims.cupCoverage));
    const psiMax = 2 * Math.PI * (coverage / 100);

    return { r1, r2, d1: d1mm, d2: d2mm, fullCircleTheta, coneVerticalH, psiMax };
}

/** Chỉ số material: phải khớp SolidPanelMesh ([ngoài, tường, trong]). */
const MAT_OUTER = 0;
const MAT_WALL = 1;
const MAT_INNER = 2;

/**
 * Phép biến đổi cuốn DÙNG CHUNG cho thân/nét/tai dán: ánh xạ điểm khai triển
 * (ρ, α) [hoặc điểm phẳng (x,y) với ρ=hypot, α=atan2] lên mặt nón ở mức `roll`,
 * ĐÃ canh tâm về gốc (recenter theo bbox lưới mẫu) — KHÔNG méo cung khuôn.
 */
export interface ConeTransform {
    half: number;
    thetaFlat: number;
    isFull: boolean;
    Na: number;
    /** (ρ, α, off=cộng bán kính) → điểm 3D đã canh tâm. */
    map: (rho: number, alpha: number, off: number) => [number, number, number];
    /** (x, y khuôn phẳng, off) → điểm 3D đã canh tâm. */
    mapFlat: (x: number, y: number, off: number) => [number, number, number];
}

export function makeConeTransform(
    cone: ConeWarpParams,
    roll: number,
    thickness: number,
): ConeTransform {
    const T = Number.isFinite(thickness) && thickness > 0 ? thickness : 0.5;
    const r1 = cone.r1;
    const r2 = cone.r2;
    const rollC = Math.max(0, Math.min(1, Number.isFinite(roll) ? roll : 1));

    const coverageFrac = cone.psiMax / (2 * Math.PI);
    const thetaFlat = cone.fullCircleTheta * coverageFrac;
    const half = thetaFlat / 2;
    const sinBfull = Math.min(1, cone.fullCircleTheta / (2 * Math.PI));
    const betaFull = Math.asin(sinBfull);
    // β: 90° (phẳng) → β_full (nón). Nghiêng τ: 90° (đứng) → 0° (nón đứng).
    const beta = Math.PI / 2 + rollC * (betaFull - Math.PI / 2);
    const sinB = Math.max(1e-4, Math.sin(beta));
    const cosB = Math.cos(beta);
    const tau = (1 - rollC) * (Math.PI / 2);
    const cosT = Math.cos(tau);
    const sinT = Math.sin(tau);
    const isFull = thetaFlat / sinB >= 2 * Math.PI - 1e-3;
    const Na = Math.max(16, Math.ceil(96 * coverageFrac));

    const projectRaw = (rho: number, alpha: number, off: number): [number, number, number] => {
        const psi = alpha / sinB;
        const radAxis = rho * sinB + off;
        const bx = radAxis * Math.sin(psi);
        const by = (rho - r1) * cosB;
        const bz = radAxis * Math.cos(psi);
        // Nghiêng quanh trục X: đứng dậy khi mở (cung khuôn bulge lên tự nhiên).
        return [bx, by * cosT + bz * sinT, -by * sinT + bz * cosT];
    };

    // Canh tâm theo bbox lưới mẫu (gồm cả mặt trong/ngoài).
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let a = 0; a <= Na; a++) {
        const alpha = (a / Na - 0.5) * thetaFlat;
        for (const j of [0, 1]) {
            const rho = r1 + j * (r2 - r1);
            for (const off of [0, T]) {
                const p = projectRaw(rho, alpha, off);
                if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0];
                if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1];
                if (p[2] < mnz) mnz = p[2]; if (p[2] > mxz) mxz = p[2];
            }
        }
    }
    const cx = (mnx + mxx) / 2;
    const cy = (mny + mxy) / 2;
    const cz = (mnz + mxz) / 2;

    const map = (rho: number, alpha: number, off: number): [number, number, number] => {
        const p = projectRaw(rho, alpha, off);
        return [p[0] - cx, p[1] - cy, p[2] - cz];
    };
    const mapFlat = (x: number, y: number, off: number): [number, number, number] =>
        map(Math.hypot(x, y), Math.atan2(x, y), off);

    return { half, thetaFlat, isFull, Na, map, mapFlat };
}

/**
 * Dựng lưới nón cụt có độ dày cho thân bọc ly (3 nhóm material + UV).
 * `wrap` ∈ [0,1] = mức cuốn (0 = khuôn phẳng đứng, 1 = nón khép kín).
 */
export function buildConeFrustumGeometry(
    cone: ConeWarpParams,
    thickness: number,
    wrap: number = 1,
): THREE.BufferGeometry {
    const T = Number.isFinite(thickness) && thickness > 0 ? thickness : 0.5;
    const tf = makeConeTransform(cone, wrap, thickness);
    const Na = tf.Na;
    const thetaFlat = tf.thetaFlat;
    const isFull = tf.isFull;

    const pos: number[] = [];
    const uvs: number[] = [];

    // Toạ độ (ρ,α) cho ô lưới: a=chỉ số góc, j=mức cao (0 đáy nhỏ,1 miệng lớn),
    // off=bán kính cộng thêm (0 = mặt trong, T = mặt ngoài).
    const V = (a: number, j: number, off: number): [number, number, number] => {
        const alpha = (a / Na - 0.5) * thetaFlat;
        const rho = cone.r1 + j * (cone.r2 - cone.r1);
        return tf.map(rho, alpha, off);
    };
    const push = (p: [number, number, number], u: number, v: number): void => {
        pos.push(p[0], p[1], p[2]);
        uvs.push(u, v);
    };

    const geometry = new THREE.BufferGeometry();
    const groups: Array<[number, number, number]> = [];
    let cursor = 0;
    const vcount = (): number => pos.length / 3;
    const closeGroup = (mat: number): void => {
        const end = vcount();
        if (end > cursor) groups.push([cursor, end - cursor, mat]);
        cursor = end;
    };

    // Mặt ngoài (off=T) — pháp tuyến ra ngoài.
    for (let a = 0; a < Na; a++) {
        const u0 = a / Na, u1 = (a + 1) / Na;
        const o00 = V(a, 0, T), o01 = V(a, 1, T), o10 = V(a + 1, 0, T), o11 = V(a + 1, 1, T);
        push(o00, u0, 0); push(o10, u1, 0); push(o01, u0, 1);
        push(o01, u0, 1); push(o10, u1, 0); push(o11, u1, 1);
    }
    closeGroup(MAT_OUTER);

    // Mặt trong (off=0) — pháp tuyến vào trục (đảo winding).
    for (let a = 0; a < Na; a++) {
        const u0 = a / Na, u1 = (a + 1) / Na;
        const i00 = V(a, 0, 0), i01 = V(a, 1, 0), i10 = V(a + 1, 0, 0), i11 = V(a + 1, 1, 0);
        push(i00, u0, 0); push(i01, u0, 1); push(i10, u1, 0);
        push(i01, u0, 1); push(i11, u1, 1); push(i10, u1, 0);
    }
    closeGroup(MAT_INNER);

    // Vành miệng + vành đáy.
    for (let a = 0; a < Na; a++) {
        const oA = V(a, 1, T), oB = V(a + 1, 1, T), iA = V(a, 1, 0), iB = V(a + 1, 1, 0);
        push(oA, 0, 0); push(oB, 0, 0); push(iA, 0, 0);
        push(iA, 0, 0); push(oB, 0, 0); push(iB, 0, 0);
    }
    for (let a = 0; a < Na; a++) {
        const oA = V(a, 0, T), oB = V(a + 1, 0, T), iA = V(a, 0, 0), iB = V(a + 1, 0, 0);
        push(iA, 0, 0); push(oB, 0, 0); push(oA, 0, 0);
        push(iB, 0, 0); push(oB, 0, 0); push(iA, 0, 0);
    }
    if (!isFull) {
        for (const a of [0, Na]) {
            const ib = V(a, 0, 0), ob = V(a, 0, T), ot = V(a, 1, T), it = V(a, 1, 0);
            push(ib, 0, 0); push(ob, 0, 0); push(ot, 0, 0);
            push(ib, 0, 0); push(ot, 0, 0); push(it, 0, 0);
        }
    }
    closeGroup(MAT_WALL);

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    for (const [start, count, mat] of groups) geometry.addGroup(start, count, mat);
    geometry.computeVertexNormals();
    return geometry;
}

/**
 * Nét khuôn thân TỪ THAM SỐ (vành miệng/đáy = CUT, mép tự do = CUT, đường nhấn
 * mí dán = CREASE). Sạch, không dính outline tai dán. `[cutGeo, creaseGeo]`.
 */
export function buildConeOutlineGeometries(
    cone: ConeWarpParams,
    roll: number,
    thickness: number,
): THREE.BufferGeometry[] {
    const tf = makeConeTransform(cone, roll, thickness);
    const r1 = cone.r1, r2 = cone.r2;
    const half = tf.half;
    const thetaFlat = tf.thetaFlat;
    const T = Number.isFinite(thickness) && thickness > 0 ? thickness : 0.5;
    const LIFT = T + 0.25; // nét nằm ngoài mặt ngoài chút để không bị che
    const N = Math.max(24, tf.Na);

    const toV = (rho: number, alpha: number): THREE.Vector3 => {
        const m = tf.map(rho, alpha, LIFT);
        return new THREE.Vector3(m[0], m[1], m[2]);
    };
    const cut: THREE.Vector3[] = [];
    const crease: THREE.Vector3[] = [];

    for (const rho of [r1, r2]) {
        let prev = toV(rho, -half);
        for (let i = 1; i <= N; i++) {
            const cur = toV(rho, -half + (i / N) * thetaFlat);
            cut.push(prev, cur); prev = cur;
        }
    }
    const seam = (alpha: number, arr: THREE.Vector3[]): void => {
        let prev = toV(r1, alpha);
        for (let i = 1; i <= 8; i++) {
            const cur = toV(r1 + (i / 8) * (r2 - r1), alpha);
            arr.push(prev, cur); prev = cur;
        }
    };
    seam(-half, cut);
    seam(half, crease);

    return [
        new THREE.BufferGeometry().setFromPoints(cut),
        new THREE.BufferGeometry().setFromPoints(crease),
    ];
}

/**
 * Mặt TAI DÁN GẮN LIỀN thân: cạnh bản lề (mép mạch α=±half) trùng mặt TRONG
 * của thân (off=0, không hở); phần lồi ra ngoài cung gài lùi dần vào trong
 * (off âm theo góc vượt mép) → chui dưới mép kia, không hở, không z-fighting.
 */
export function buildConeGluePatchGeometry(
    outline: Array<{ x: number; y: number }>,
    cone: ConeWarpParams,
    roll: number,
    thickness: number,
): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    if (!outline || outline.length < 3) return geometry;

    const tf = makeConeTransform(cone, roll, thickness);
    const half = tf.half;
    const RAMP = 80;
    const MAX_IN = 3;
    const offOf = (x: number, y: number): number => {
        const alpha = Math.atan2(x, y);
        const excess = Math.max(0, Math.abs(alpha) - half);
        return -Math.min(MAX_IN, RAMP * excess);
    };
    const m = (p: { x: number; y: number }): [number, number, number] =>
        tf.mapFlat(p.x, p.y, offOf(p.x, p.y));

    const contour = outline.map((p) => new THREE.Vector2(p.x, p.y));
    let faces: number[][] = [];
    try {
        faces = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
        faces = [];
    }
    const pos: number[] = [];
    for (const f of faces) {
        const A = m(contour[f[0]]), B = m(contour[f[1]]), C = m(contour[f[2]]);
        pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
        pos.push(A[0], A[1], A[2], C[0], C[1], C[2], B[0], B[1], B[2]);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.addGroup(0, pos.length / 3, MAT_INNER);
    geometry.computeVertexNormals();
    return geometry;
}
