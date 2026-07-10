// ============================================================
// Matchbox Tray — Hộp Diêm / Khay Thành Đôi (FEFCO 0410)
//
// Cấu trúc 5 lớp, mỗi lớp hẹp dần:
//   1. Đáy (L × W) — gốc tại (0,0)
//   2. Vách chính (D) — trước/sau = L-2T, trái/phải = W
//   3. Dầm (G) — cùng rộng vách chính
//   4. Vách phụ — = vách chính - 2G
//   5. Mí gập (TH) — = vách phụ - 2T
//
// Khi zone hẹp hơn zone trước → vẽ notch CUT ở 2 bên.
// ============================================================

import {
    BoxParams, DielineModel, Panel, PathSegment, PathTag, Point2D,
} from './types';
import { pt, line, snap, computeBoundingBox, filletBezier } from './utils';
import { tracePerimeter } from './tracePerimeter';
import { generateMatchboxSleeve } from './MatchboxSleeve';

// ============================================================
// Tray Manufacturing Constants
//
// Các hằng số hình học cho khuôn khay thành đôi.
// Giá trị dựa trên thực tế sản xuất bao bì carton sóng / bìa cứng.
// ============================================================

/** Bán kính bo tối đa cho góc ngoài mí gập (mm).
 *  Quá lớn → mí gập yếu, dễ rách khi gấp. 3mm là giới hạn an toàn
 *  cho bìa 300–350 gsm. */
const TAB_FILLET_MAX_R = 3;

/** Tỷ lệ bán kính bo mí gập so với chiều cao mí.
 *  25% đảm bảo bo tròn vừa đủ mà không chiếm quá nhiều diện tích mí. */
const TAB_FILLET_RATIO = 0.25;

/** Bán kính bo tối đa cho góc ngoài tai khóa (mm).
 *  Tương tự TAB_FILLET_MAX_R — giữ tai khóa cứng cáp. */
const LOCK_FILLET_MAX_R = 3;

/** Tỷ lệ bán kính bo tai khóa so với chiều cao tai.
 *  15% (thấp hơn mí gập) vì tai khóa cần diện tích tiếp xúc lớn
 *  hơn để giữ chặt khi lồng vào vách phụ. */
const LOCK_FILLET_RATIO = 0.15;

/** Chiều rộng tối thiểu nửa rãnh khóa chữ U (mm).
 *  Nếu T < 1mm, rãnh quá hẹp sẽ khó gài → floor ở 1mm. */
const SLOT_MIN_HALF_WIDTH = 1;

/** Bán kính bo tối đa cho đáy rãnh khóa chữ U (mm).
 *  Bo tròn đáy chữ U giảm ứng suất tập trung, tránh rách
 *  khi gài/tháo nhiều lần. 1.5mm = giới hạn cho bìa mỏng. */
const SLOT_CORNER_MAX_R = 1.5;

/** Tỷ lệ bán kính bo đáy rãnh so với nửa rộng rãnh.
 *  80% → bo gần tròn hoàn toàn, chỉ để lại đáy phẳng rất nhỏ. */
const SLOT_CORNER_RATIO = 0.8;

/** Hệ số offset gusset (bội số của T).
 *  Gusset bắt đầu cách góc vuông sec wall 2×T → đường xiên 45°
 *  tạo tam giác vuông cân, phân bố lực đều khi gấp. */
const GUSSET_OFFSET_FACTOR = 2;

/** Hệ số inset chiều cao lock tab từ sec wall (bội số của T).
 *  Lock tab = sec wall height - 4T (inset 2T mỗi đầu).
 *  2T mỗi đầu đảm bảo khoảng cách an toàn với beam/tab fold lines. */
const LOCK_INSET_FACTOR = 4;

/** Khoảng cách giữa tray và sleeve khi hiển thị cạnh nhau (mm).
 *  60mm đảm bảo khoảng cách đủ rộng để 2 khuôn không dính nhau trên bản vẽ. */
const SLEEVE_DISPLAY_GAP = 60;

/** Ngưỡng tối thiểu để lock tab được vẽ (mm).
 *  Nếu kích thước tab < 0.5mm → quá nhỏ để sản xuất, bỏ qua. */
const LOCK_MIN_SIZE = 0.5;

export function generateMatchboxTray(params: BoxParams): DielineModel {
    const { L, W, D, T, G, TH } = params;

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    const beamW = snap(G);
    const secH = snap(D);
    const tabH = snap(TH);
    const tabR = snap(Math.min(TAB_FILLET_MAX_R, tabH * TAB_FILLET_RATIO));

    // ── 1. BOTTOM — Đáy (L × W) ──
    const bottomPaths: PathSegment[] = [
        line(pt(0, 0), pt(L, 0), 'CREASE'),
        line(pt(L, 0), pt(L, W), 'CREASE'),
        line(pt(L, W), pt(0, W), 'CREASE'),
        line(pt(0, W), pt(0, 0), 'CREASE'),
    ];
    allPaths.push(...bottomPaths);
    panels.push({
        name: 'bottom', label: 'Đáy', paths: bottomPaths,
        outline: [pt(0, 0), pt(L, 0), pt(L, W), pt(0, W)],
        parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1,
    });

    // ── Per-zone perpendicular insets ──
    // Vertical strips (front/back): base range [0, L]
    //   Wall/Beam: inset T each side → [T, L-T]       (width = L - 2T)
    //   SecWall:   inset T+G          → [T+G, L-T-G]   (width = L - 2T - 2G)
    //   Tab:       inset 2T+G         → [2T+G, L-2T-G] (width = L - 4T - 2G)
    //
    // Horizontal strips (left/right): base range [0, W]
    //   Wall/Beam: no inset           → [0, W]
    //   SecWall:   inset G            → [G, W-G]       (width = W - 2G)
    //   Tab:       inset G            → [G, W-G]       (width = W - 2G, bằng vách phụ)

    const vertInsets = [T, T, T + G, 2 * T + G]; // front/back
    const horizInsets = [0, 0, G, G];              // left/right (tab = sec wall)

    interface StripCfg {
        prefix: string;
        labels: [string, string, string, string];
        baseA: number; baseB: number; // perpendicular base range
        insets: number[];             // per-zone insets from each side
        stripBase: number;
        dir: 1 | -1;
        vert: boolean;
    }

    const strips: StripCfg[] = [
        {
            prefix: 'front', labels: ['Vách trước', 'Dầm trước', 'Vách phụ trước', 'Mí trước'],
            baseA: 0, baseB: L, insets: vertInsets, stripBase: W, dir: 1, vert: true
        },
        {
            prefix: 'back', labels: ['Vách sau', 'Dầm sau', 'Vách phụ sau', 'Mí sau'],
            baseA: 0, baseB: L, insets: vertInsets, stripBase: 0, dir: -1, vert: true
        },
        {
            prefix: 'right', labels: ['Vách phải', 'Dầm phải', 'Vách phụ phải', 'Mí phải'],
            baseA: 0, baseB: W, insets: horizInsets, stripBase: L, dir: 1, vert: false
        },
        {
            prefix: 'left', labels: ['Vách trái', 'Dầm trái', 'Vách phụ trái', 'Mí trái'],
            baseA: 0, baseB: W, insets: horizInsets, stripBase: 0, dir: -1, vert: false
        },
    ];

    const zoneNames = ['wall', 'beam', 'sec', 'tab'];
    // Vách trước/sau thấp hơn trái/phải = T (để lọt vào khi gấp)
    // Vách phụ nhỏ hơn vách chính = T
    const vertZoneWidths = [snap(D - T), beamW, snap(D - 2 * T), tabH];  // front/back
    const horizZoneWidths = [D, beamW, snap(D - T), tabH];               // left/right
    // Trình tự gập (theo chỉ thị thực tế, dừng dần theo từng bước):
    //   1) Cả 4 vách dựng 90° (0.2–0.4).
    //   2) 4 khóa bẻ ngược ra ngoài (0.4–0.52) — xử lý ở mục lock.
    //   3) Từ 0.52: CHỈ gập vách phụ TRƯỚC/SAU (dầm→gờ rồi vách phụ vào trong);
    //      TRÁI/PHẢI KHÔNG gập (chỉ dựng vách rồi dừng).
    //   Mí (tab) chưa gập — chờ chỉ thị tiếp.
    // foldAngle tách theo chiều strip: vert = front/back, horiz = left/right.
    const vertFoldAngles = [90, 90, 90, -90];  // front/back: wall, dầm, vách phụ, mí
    const horizFoldAngles = [90, 90, 90, -90];  // left/right: GIỜ gập tương tự (sau 80%)
    // foldPhase tách theo chiều: front/back gập sớm (0.2–0.78); left/right gập
    // MUỘN (sau 0.8) tương tự — mí bẻ ra trước, rồi dầm vào, rồi vách phụ vào.
    const vertFoldPhases: [number, number][] = [
        [0.2, 0.4],   // wall — dựng vách
        [0.52, 0.64], // beam (dầm)
        [0.64, 0.78], // sec (vách phụ)
        [0.4, 0.52],  // tab (mí) — bẻ ngược cùng khóa
    ];
    const horizFoldPhases: [number, number][] = [
        [0.2, 0.4],   // wall — dựng vách (cùng lúc 4 vách)
        [0.86, 0.92], // beam (dầm) — gập vào (sau 80%)
        [0.92, 1.0],  // sec (vách phụ) — gập vào, kéo mí nằm sát đáy
        [0.8, 0.86],  // tab (mí) — bẻ ngược ra trước (từ 80%)
    ];

    // Pre-compute: lock tabs tồn tại? (dùng để bỏ CUT cạnh sec wall bị trùng)
    const _tongueW = params.trayTongueW ?? 15;
    const _lockH = snap(snap(D - 2 * T) - LOCK_INSET_FACTOR * T);
    const _lockW = snap((W - 2 * G) / 2 + _tongueW);
    const hasLockTabs = _lockH > LOCK_MIN_SIZE && _lockW > LOCK_MIN_SIZE;

    // Kappa constant for cubic bezier quarter-circle approximation
    const K = 0.5522847498;

    // Helper: tạo quarter-circle bezier arc
    function qArc(p0: Point2D, p3: Point2D, tanDir0: Point2D, tanDir3: Point2D, R: number, tag: PathTag): PathSegment {
        return {
            type: 'bezier',
            tag,
            points: [p0, p3],
            controlPoints: [
                p0,
                pt(p0.x + R * K * tanDir0.x, p0.y + R * K * tanDir0.y),
                pt(p3.x - R * K * tanDir3.x, p3.y - R * K * tanDir3.y),
                p3,
            ],
        };
    }

    for (const s of strips) {
        // Ranh giới dọc theo hướng strip
        const bounds: number[] = [s.stripBase];
        let cur = s.stripBase;
        const zoneWidths = s.vert ? vertZoneWidths : horizZoneWidths;
        for (const w of zoneWidths) { cur = snap(cur + w * s.dir); bounds.push(cur); }

        // Ranh giới ngang (perpendicular) per zone
        const perpAs = s.insets.map(ins => snap(s.baseA + ins));
        const perpBs = s.insets.map(ins => snap(s.baseB - ins));

        const parentNames = [
            'bottom',
            `${s.prefix}_wall`,
            `${s.prefix}_beam`,
            `${s.prefix}_sec`,
        ];

        for (let i = 0; i < 4; i++) {
            const isTab = i === 3;
            const isBeam = i === 1;
            const isSec = i === 2;
            const b0 = bounds[i];
            const b1 = bounds[i + 1];
            const pA = perpAs[i];
            const pB = perpBs[i];

            // Previous zone's perpendicular range (for notch steps)
            const prevPA = i > 0 ? perpAs[i - 1] : s.baseA;
            const prevPB = i > 0 ? perpBs[i - 1] : s.baseB;
            const hasLeftNotch = pA > prevPA + 0.01;
            const hasRightNotch = pB < prevPB - 0.01;

            // Next zone's perpendicular range (for cross edge split)
            const nextPA = i < 3 ? perpAs[i + 1] : pA;
            const nextPB = i < 3 ? perpBs[i + 1] : pB;
            const nextNarrower = i < 3 && (nextPA > pA + 0.01 || nextPB < pB - 0.01);

            // Beam→Sec: use quarter-circle arcs instead of sharp notch
            const useArc = isBeam && nextNarrower;
            const arcR = useArc ? Math.min(Math.abs(nextPA - pA), Math.abs(b1 - b0)) : 0;

            // Sec: skip base notch — beam arcs already handle the transition
            // Tab: skip base notch — sec zone cross edge already drew the same notch CUT
            const skipNotch = (isSec || isTab) && (hasLeftNotch || hasRightNotch);

            const paths: PathSegment[] = [];

            if (s.vert) {
                // ── Vertical strip (x = perp, y = strip direction) ──

                // Left notch at base (skip for sec zone — handled by beam arc)
                if (hasLeftNotch && !skipNotch) paths.push(line(pt(prevPA, b0), pt(pA, b0), i === 0 ? 'CREASE' : 'CUT'));

                if (isTab && tabR > 0.1) {
                    // Tab with rounded outer corners
                    const c1 = pt(pA, b1), c2 = pt(pB, b1);
                    const fil1 = filletBezier(c1, pt(pA, b0), c2, tabR);
                    const fil2 = filletBezier(c2, c1, pt(pB, b0), tabR);
                    const f1s = fil1.controlPoints?.[0] ?? c1;
                    const f1e = fil1.controlPoints?.[3] ?? c1;
                    const f2s = fil2.controlPoints?.[0] ?? c2;
                    const f2e = fil2.controlPoints?.[3] ?? c2;
                    paths.push(
                        line(pt(pA, b0), f1s, 'CUT'), fil1,
                        line(f1e, f2s, 'CUT'), fil2,
                        line(f2e, pt(pB, b0), 'CUT'),
                    );
                } else if (useArc) {
                    // ── Beam with quarter-circle arcs at notch ──
                    const arcStartY = snap(b1 - arcR * s.dir);

                    // Left CUT (shortened — arc takes the rest)
                    if (Math.abs(arcStartY - b0) > 0.01) {
                        paths.push(line(pt(pA, b0), pt(pA, arcStartY), 'CUT'));
                    }
                    // Left quarter arc: beam edge → sec edge
                    paths.push(qArc(
                        pt(pA, arcStartY), pt(nextPA, b1),
                        pt(0, s.dir), pt(1, 0), arcR, 'CUT',
                    ));
                    // CREASE (fold line, only where sec wall exists)
                    paths.push(line(pt(nextPA, b1), pt(nextPB, b1), 'CREASE'));
                    // Right quarter arc: sec edge → beam edge
                    paths.push(qArc(
                        pt(nextPB, b1), pt(pB, arcStartY),
                        pt(1, 0), pt(0, -s.dir), arcR, 'CUT',
                    ));
                    // Right CUT (shortened)
                    if (Math.abs(arcStartY - b0) > 0.01) {
                        paths.push(line(pt(pB, arcStartY), pt(pB, b0), 'CUT'));
                    }
                } else {
                    // Left edge: CREASE for wall zone (corner flap fold), CUT otherwise
                    // Skip cho vertical sec zone khi có lock tabs — gusset + crease thay thế
                    const sideTag: PathTag = i === 0 ? 'CREASE' : 'CUT';
                    const skipSideEdge = isSec && s.vert && hasLockTabs;
                    if (!skipSideEdge) {
                        paths.push(line(pt(pA, b0), pt(pA, b1), sideTag));
                    }
                    // Cross edge (split if next zone is narrower)
                    if (nextNarrower) {
                        paths.push(line(pt(pA, b1), pt(nextPA, b1), 'CUT'));
                        paths.push(line(pt(nextPA, b1), pt(nextPB, b1), 'CREASE'));
                        paths.push(line(pt(nextPB, b1), pt(pB, b1), 'CUT'));
                    } else {
                        const tag: PathTag = isTab ? 'CUT' : 'CREASE';
                        paths.push(line(pt(pA, b1), pt(pB, b1), tag));
                    }
                    // Right edge: CREASE for wall zone (corner flap fold), CUT otherwise
                    if (!skipSideEdge) {
                        paths.push(line(pt(pB, b1), pt(pB, b0), sideTag));
                    }
                }

                // Right notch at base (skip for sec)
                if (hasRightNotch && !skipNotch) paths.push(line(pt(pB, b0), pt(prevPB, b0), i === 0 ? 'CREASE' : 'CUT'));

            } else {
                // ── Horizontal strip (y = perp, x = strip direction) ──

                // Top notch at base (skip for sec)
                if (hasLeftNotch && !skipNotch) paths.push(line(pt(b0, prevPB), pt(b0, pB), 'CUT'));

                if (isTab && tabR > 0.1) {
                    const c1 = pt(b1, pB), c2 = pt(b1, pA);
                    const fil1 = filletBezier(c1, pt(b0, pB), c2, tabR);
                    const fil2 = filletBezier(c2, c1, pt(b0, pA), tabR);
                    const f1s = fil1.controlPoints?.[0] ?? c1;
                    const f1e = fil1.controlPoints?.[3] ?? c1;
                    const f2s = fil2.controlPoints?.[0] ?? c2;
                    const f2e = fil2.controlPoints?.[3] ?? c2;
                    paths.push(
                        line(pt(b0, pB), f1s, 'CUT'), fil1,
                        line(f1e, f2s, 'CUT'), fil2,
                        line(f2e, pt(b0, pA), 'CUT'),
                    );
                } else if (useArc) {
                    // ── Beam with quarter-circle arcs (horizontal) ──
                    const arcStartX = snap(b1 - arcR * s.dir);

                    // Top CUT (shortened)
                    if (Math.abs(arcStartX - b0) > 0.01) {
                        paths.push(line(pt(b0, pB), pt(arcStartX, pB), 'CUT'));
                    }
                    // Top quarter arc
                    paths.push(qArc(
                        pt(arcStartX, pB), pt(b1, nextPB),
                        pt(s.dir, 0), pt(0, -1), arcR, 'CUT',
                    ));
                    // CREASE
                    paths.push(line(pt(b1, nextPB), pt(b1, nextPA), 'CREASE'));
                    // Bottom quarter arc
                    paths.push(qArc(
                        pt(b1, nextPA), pt(arcStartX, pA),
                        pt(0, -1), pt(-s.dir, 0), arcR, 'CUT',
                    ));
                    // Bottom CUT (shortened)
                    if (Math.abs(arcStartX - b0) > 0.01) {
                        paths.push(line(pt(arcStartX, pA), pt(b0, pA), 'CUT'));
                    }
                } else {
                    if (i === 0) {
                        // Wall zone: split edge at D' (2T from far end)
                        // CREASE = corner flap fold area, CUT = beyond D'
                        const splitX = snap(b1 - 2 * T * s.dir);
                        // Top edge: CREASE to D', CUT beyond
                        paths.push(line(pt(b0, pB), pt(splitX, pB), 'CREASE'));
                        paths.push(line(pt(splitX, pB), pt(b1, pB), 'CUT'));
                    } else {
                        paths.push(line(pt(b0, pB), pt(b1, pB), 'CUT'));
                    }
                    // Cross edge
                    if (nextNarrower) {
                        paths.push(line(pt(b1, pB), pt(b1, nextPB), 'CUT'));
                        paths.push(line(pt(b1, nextPB), pt(b1, nextPA), 'CREASE'));
                        paths.push(line(pt(b1, nextPA), pt(b1, pA), 'CUT'));
                    } else {
                        const tag: PathTag = isTab ? 'CUT' : 'CREASE';
                        paths.push(line(pt(b1, pB), pt(b1, pA), tag));
                    }
                    if (i === 0) {
                        // Bottom edge: CUT beyond D', CREASE to start
                        const splitX = snap(b1 - 2 * T * s.dir);
                        paths.push(line(pt(b1, pA), pt(splitX, pA), 'CUT'));
                        paths.push(line(pt(splitX, pA), pt(b0, pA), 'CREASE'));
                    } else {
                        paths.push(line(pt(b1, pA), pt(b0, pA), 'CUT'));
                    }
                }

                // Bottom notch at base (skip for sec)
                if (hasRightNotch && !skipNotch) paths.push(line(pt(b0, pA), pt(b0, prevPA), 'CUT'));
            }

            allPaths.push(...paths);

            // Pivot edge
            const pivotEdge: [Point2D, Point2D] = s.vert
                ? [pt(pA, b0), pt(pB, b0)]
                : [pt(b0, pA), pt(b0, pB)];

            // Outline cho 3D: panel có cạnh cong (bezier — bo góc mí / cung
            // chuyển beam→sec) thì TRUY VẾT chu vi thực (lấy mẫu bezier) để khối
            // 3D bám đúng khuôn 2D (góc bo, không bị nhọn). Panel thẳng (vách/
            // vách phụ) giữ hình chữ nhật gọn (traced sẽ kèm artifact notch góc).
            const hasCurve = paths.some((p) => p.type === 'bezier');
            const rectOutline: Point2D[] = s.vert
                ? [pt(pA, b0), pt(pB, b0), pt(pB, b1), pt(pA, b1)]
                : [pt(b0, pA), pt(b1, pA), pt(b1, pB), pt(b0, pB)];
            const outline = hasCurve ? tracePerimeter(paths) : rectOutline;

            panels.push({
                name: `${s.prefix}_${zoneNames[i]}`,
                label: s.labels[i],
                paths,
                outline,
                parent: parentNames[i],
                pivotEdge,
                foldAngle: (s.vert ? vertFoldAngles[i] : horizFoldAngles[i]),
                // Strip ngang (left/right) bản lề dọc trục Y → cùng dấu fold cho
                // hiệu ứng NGƯỢC so với strip dọc; đảo dấu để cả 4 vách gập LÊN.
                // Print-outward: mockup gán in ở local +Z. Wall (i=0) + beam (i=1)
                // cần gập volume về −Z (đảo baseDir); sec/tab (i≥2) giữ baseDir
                // vì lớp gập kép đã đúng chiều ra ngoài.
                foldDirection: (() => {
                    const base = (s.vert ? s.dir : (-s.dir)) as 1 | -1;
                    return (i <= 1 ? -base : base) as 1 | -1;
                })(),
                foldPhase: (s.vert ? vertFoldPhases[i] : horizFoldPhases[i]),
            });
        }
    }

    // ── Corner flaps (tam giác gia cố góc) ──
    // Tam giác cân: AC = AD = AD', CD = CD'.
    // AB chia đôi góc DAD' (= 90°) → AB nghiêng 45°.
    // C nằm trên AB tại khoảng cách AC = AD → CD = CD' tự động.
    // ab = CUT, bc = CREASE, ab = bc/2.

    const wallH_vert = vertZoneWidths[0]; // D - T
    const CORNER_ANGLE = Math.PI / 4; // 45° — chia đôi góc vuông DAD'

    interface CornerCfg {
        name: string; label: string;
        a: Point2D; d: Point2D;
        dirSign: Point2D; // (sx, sy) hướng mở rộng
        parent: string;
        sideWall: string; // vách hông để gập miếng góc 3D
    }

    const cornerCfgs: CornerCfg[] = [
        {
            name: 'corner_fl', label: 'Góc trước-trái',
            a: pt(T, W), d: pt(T, W + wallH_vert), dirSign: pt(-1, 1), parent: 'front_wall', sideWall: 'left_wall'
        },
        {
            name: 'corner_fr', label: 'Góc trước-phải',
            a: pt(L - T, W), d: pt(L - T, W + wallH_vert), dirSign: pt(1, 1), parent: 'front_wall', sideWall: 'right_wall'
        },
        {
            name: 'corner_bl', label: 'Góc sau-trái',
            a: pt(T, 0), d: pt(T, -wallH_vert), dirSign: pt(-1, -1), parent: 'back_wall', sideWall: 'left_wall'
        },
        {
            name: 'corner_br', label: 'Góc sau-phải',
            a: pt(L - T, 0), d: pt(L - T, -wallH_vert), dirSign: pt(1, -1), parent: 'back_wall', sideWall: 'right_wall'
        },
    ];

    for (const cc of cornerCfgs) {
        const { a, d, dirSign } = cc;
        const H = wallH_vert;

        // Hướng đường a→c (unit vector)
        const ux = dirSign.x * Math.cos(CORNER_ANGLE);
        const uy = dirSign.y * Math.sin(CORNER_ANGLE);

        // ac = AD = H — đảm bảo AC = AD = AD', CD = CD'
        const ac = H;

        // c trên đường trung trực ad, tại y = midpoint(a,d)
        const c = pt(snap(a.x + ac * ux), snap(a.y + ac * uy));

        // b = 1/3 along a→c (ab = ac/3, bc = 2ac/3, ab = bc/2)
        const b = pt(snap(a.x + (ac / 3) * ux), snap(a.y + (ac / 3) * uy));

        // d' = reflection of d across line a→c
        const vx = d.x - a.x, vy = d.y - a.y;
        const vDotU = vx * ux + vy * uy;
        const dP = pt(
            snap(a.x + 2 * vDotU * ux - vx),
            snap(a.y + 2 * vDotU * uy - vy),
        );

        const cPaths: PathSegment[] = [
            line(a, b, 'CUT'),       // a→b: CUT
            line(b, c, 'CREASE'),    // b→c: CREASE
            line(c, d, 'CUT'),       // c→d: diagonal to wall top
            line(c, dP, 'CUT'),      // c→d': diagonal to mirror
        ];

        allPaths.push(...cPaths);
        panels.push({
            name: cc.name, label: cc.label, paths: cPaths,
            outline: [a, d, c, dP],
            parent: cc.parent, pivotEdge: [a, a],
            foldAngle: 45, foldDirection: 1,
            // CHỈ 3D: dữ liệu render miếng đệm góc (gập đôi theo nếp chéo a→c).
            // KHÔNG ảnh hưởng path/outline 2D ở trên.
            gusset: { frontWall: cc.parent, sideWall: cc.sideWall, a, d, c, dP, center: pt(snap(L / 2), snap(W / 2)) },
        });
    }

    // ── Locking tabs (tai khóa vách trước/sau) ──
    // 4 tab: 2 bên vách phụ trước, 2 bên vách phụ sau
    // Chiều cao = vách phụ trước/sau - 4T = D - 2T - 4T = D - 6T
    // Chiều ngang = (W - 2G) / 2 + trayTongueW
    const tongueW = params.trayTongueW ?? 15;
    const secH_vert = snap(D - 2 * T);       // chiều cao vách phụ trước/sau
    const lockH = snap(secH_vert - LOCK_INSET_FACTOR * T);   // chiều cao tab = sec - 4T
    const lockW = snap((W - 2 * G) / 2 + tongueW); // chiều ngang tab
    const lockR = snap(Math.min(LOCK_FILLET_MAX_R, lockH * LOCK_FILLET_RATIO));  // bán kính bo góc

    if (lockH > LOCK_MIN_SIZE && lockW > LOCK_MIN_SIZE) {
        // Tính vị trí zone vách phụ trước/sau
        // Front sec zone: y từ bounds[2] đến bounds[3]
        //   bounds[0] = W, bounds[1] = W + (D-T), bounds[2] = W + (D-T) + G
        //   bounds[3] = W + (D-T) + G + (D-2T)
        // Back sec zone: y từ bounds[2] đến bounds[3] (negative side)
        //   bounds[0] = 0, bounds[1] = -(D-T), bounds[2] = -(D-T) - G
        //   bounds[3] = -(D-T) - G - (D-2T)

        const frontSecY0 = snap(W + (D - T) + G);        // sec zone start (front)
        const frontSecY1 = snap(frontSecY0 + secH_vert);  // sec zone end (front)
        const backSecY0 = snap(-(D - T) - G);             // sec zone start (back)
        const backSecY1 = snap(backSecY0 - secH_vert);    // sec zone end (back)

        // perpAs[2] = T + G, perpBs[2] = L - T - G (inset cho sec zone)
        const secPerpA = snap(T + G);     // x trái vách phụ
        const secPerpB = snap(L - T - G); // x phải vách phụ

        interface LockCfg {
            name: string; label: string;
            // Hình chữ nhật: origin (góc gần vách), mở rộng ra ngoài
            x0: number;  // x cạnh gắn vách
            xDir: -1 | 1; // hướng mở rộng (-1 = sang trái, 1 = sang phải)
            y0: number;  // y dưới (inset 2T từ sec bottom)
            y1: number;  // y trên (inset 2T từ sec top)
            parent: string;
        }

        const lockCfgs: LockCfg[] = [
            {
                name: 'lock_fl', label: 'Khóa trước-trái',
                x0: secPerpA, xDir: -1,
                y0: snap(frontSecY0 + 2 * T), y1: snap(frontSecY1 - 2 * T),
                parent: 'front_sec',
            },
            {
                name: 'lock_fr', label: 'Khóa trước-phải',
                x0: secPerpB, xDir: 1,
                y0: snap(frontSecY0 + 2 * T), y1: snap(frontSecY1 - 2 * T),
                parent: 'front_sec',
            },
            {
                name: 'lock_bl', label: 'Khóa sau-trái',
                x0: secPerpA, xDir: -1,
                y0: snap(backSecY0 - 2 * T), y1: snap(backSecY1 + 2 * T),
                parent: 'back_sec',
            },
            {
                name: 'lock_br', label: 'Khóa sau-phải',
                x0: secPerpB, xDir: 1,
                y0: snap(backSecY0 - 2 * T), y1: snap(backSecY1 + 2 * T),
                parent: 'back_sec',
            },
        ];

        for (const lc of lockCfgs) {
            const { x0, xDir, y0, y1 } = lc;
            const x1 = snap(x0 + lockW * xDir); // cạnh ngoài

            // 4 góc hình chữ nhật
            const pBase0 = pt(x0, y0); // góc dưới-gắn vách
            const pBase1 = pt(x0, y1); // góc trên-gắn vách
            const pOuter0 = pt(x1, y0); // góc dưới-ngoài
            const pOuter1 = pt(x1, y1); // góc trên-ngoài

            // ── Rãnh khóa (slot) — chữ U hướng lên (positive Y) ──
            const tongueStartX = snap(x0 + ((W - 2 * G) / 2) * xDir);
            const slotHalfW = snap(Math.max(SLOT_MIN_HALF_WIDTH, T));
            const slotNearX = snap(tongueStartX - slotHalfW * xDir);
            const slotFarX = snap(tongueStartX + slotHalfW * xDir);
            const midY = snap((y0 + y1) / 2);

            // Slot luôn ở cạnh có y lớn hơn (hướng lên)
            const slotOnY1 = y1 > y0;
            const slotEdgeY = slotOnY1 ? y1 : y0;

            // Bo tròn 2 góc sâu chữ U
            const slotR = snap(Math.min(SLOT_CORNER_MAX_R, slotHalfW * SLOT_CORNER_RATIO));

            // ── Gusset: đường xiên từ corner (góc 90° sec wall) chéo ra điểm trên cạnh ngang lock tab ──
            // Hướng: từ corner đi outward (cùng xDir) 2T, vertical 2T → 45°
            const isFront = lc.parent === 'front_sec';
            const secEdgeY0 = isFront ? frontSecY0 : backSecY0; // sec zone start
            const secEdgeY1 = isFront ? frontSecY1 : backSecY1; // sec zone end
            const gussetX = snap(x0 + GUSSET_OFFSET_FACTOR * T * xDir); // offset 2T ra ngoài (cùng hướng lock tab)

            // Góc vuông 90° — giao cạnh đứng sec wall × ranh giới sec zone
            const corner0 = pt(x0, secEdgeY0); // góc 90° dưới (= điểm trái front_sec[0] phía dưới)
            const corner1 = pt(x0, secEdgeY1); // góc 90° trên (= điểm trái front_sec[0] phía trên)

            // Điểm đích gusset trên cạnh ngang lock tab (y = y0 hoặc y1, x = gussetX)
            const gussetEnd0 = pt(gussetX, y0); // trên cạnh ngang dưới lock tab
            const gussetEnd1 = pt(gussetX, y1); // trên cạnh ngang trên lock tab

            const lPaths: PathSegment[] = [];

            // Gusset dưới: đoạn đứng 2T (corner0→pBase0) + ngang (pBase0→gussetEnd0)
            // Không nối trực tiếp beam — đoạn đứng 2T tách gusset khỏi beam boundary
            lPaths.push(line(corner0, pBase0, 'CUT'));       // đứng 2T
            lPaths.push(line(pBase0, gussetEnd0, 'CUT'));    // ngang ra lock tab
            // Cạnh gắn vách (CREASE — nếp gập)
            lPaths.push(line(corner0, corner1, 'CREASE'));
            // Gusset trên (giao mí): giữ đường xiên gussetEnd1 → corner1
            lPaths.push(line(gussetEnd1, corner1, 'CUT'));

            // Helper: slot U path với bo tròn đáy
            const slotUPath = (nearX: number, farX: number, edgeY: number, botY: number): PathSegment[] => {
                // Hướng slot: near là gần base, far là gần outer
                // 2 góc sâu cần bo: (nearX, botY) và (farX, botY)
                const nearCorner = pt(nearX, botY);
                const farCorner = pt(farX, botY);
                const nearTop = pt(nearX, edgeY);
                const farTop = pt(farX, edgeY);

                if (slotR > 0.05) {
                    // Bo tròn đáy chữ U
                    const filNear = filletBezier(nearCorner, nearTop, farCorner, slotR);
                    const filFar = filletBezier(farCorner, nearCorner, farTop, slotR);
                    const fnS = filNear.controlPoints?.[0] ?? nearCorner;
                    const fnE = filNear.controlPoints?.[3] ?? nearCorner;
                    const ffS = filFar.controlPoints?.[0] ?? farCorner;
                    const ffE = filFar.controlPoints?.[3] ?? farCorner;
                    return [
                        line(nearTop, fnS, 'CUT'),   // wall near → fillet start
                        filNear,                      // bo góc near
                        line(fnE, ffS, 'CUT'),        // đáy giữa 2 bo
                        filFar,                       // bo góc far
                        line(ffE, farTop, 'CUT'),     // fillet end → wall far
                    ];
                }
                return [
                    line(nearTop, nearCorner, 'CUT'),
                    line(nearCorner, farCorner, 'CUT'),
                    line(farCorner, farTop, 'CUT'),
                ];
            };

            if (lockR > 0.1) {
                const fil1 = filletBezier(pOuter1, pBase1, pOuter0, lockR);
                const fil2 = filletBezier(pOuter0, pOuter1, pBase0, lockR);
                const f1s = fil1.controlPoints?.[0] ?? pOuter1;
                const f1e = fil1.controlPoints?.[3] ?? pOuter1;
                const f2s = fil2.controlPoints?.[0] ?? pOuter0;
                const f2e = fil2.controlPoints?.[3] ?? pOuter0;

                if (slotOnY1) {
                    lPaths.push(
                        line(gussetEnd1, pt(slotNearX, slotEdgeY), 'CUT'),
                        ...slotUPath(slotNearX, slotFarX, slotEdgeY, midY),
                        line(pt(slotFarX, slotEdgeY), f1s, 'CUT'),
                        fil1,
                        line(f1e, f2s, 'CUT'),
                        fil2,
                        line(f2e, gussetEnd0, 'CUT'),
                    );
                } else {
                    lPaths.push(
                        line(gussetEnd1, f1s, 'CUT'),
                        fil1,
                        line(f1e, f2s, 'CUT'),
                        fil2,
                        line(f2e, pt(slotFarX, slotEdgeY), 'CUT'),
                        ...slotUPath(slotFarX, slotNearX, slotEdgeY, midY),
                        line(pt(slotNearX, slotEdgeY), gussetEnd0, 'CUT'),
                    );
                }
            } else {
                if (slotOnY1) {
                    lPaths.push(
                        line(gussetEnd1, pt(slotNearX, slotEdgeY), 'CUT'),
                        ...slotUPath(slotNearX, slotFarX, slotEdgeY, midY),
                        line(pt(slotFarX, slotEdgeY), pOuter1, 'CUT'),
                        line(pOuter1, pOuter0, 'CUT'),
                        line(pOuter0, gussetEnd0, 'CUT'),
                    );
                } else {
                    lPaths.push(
                        line(gussetEnd1, pOuter1, 'CUT'),
                        line(pOuter1, pOuter0, 'CUT'),
                        line(pOuter0, pt(slotFarX, slotEdgeY), 'CUT'),
                        ...slotUPath(slotFarX, slotNearX, slotEdgeY, midY),
                        line(pt(slotNearX, slotEdgeY), gussetEnd0, 'CUT'),
                    );
                }
            }

            allPaths.push(...lPaths);
            panels.push({
                name: lc.name, label: lc.label, paths: lPaths,
                // Outline 3D truy vết chu vi thực (rãnh khóa chữ U + bo góc) để
                // khối 3D bám đúng khuôn 2D thay vì hình chữ nhật nhọn không rãnh.
                outline: tracePerimeter(lPaths),
                parent: lc.parent, pivotEdge: [pBase0, pBase1],
                // Khóa BẺ NGƯỢC RA NGOÀI (trái với lòng khay) ngay sau khi vách
                // dựng xong. Chiều phụ thuộc CẢ xDir LẪN trước/sau: vách sau gập
                // −90° làm đảo dấu, nên khóa trước dùng xDir, khóa sau dùng −xDir
                // → cả 4 đều bật ra NGOÀI (trước→+y, sau→−y), KHÔNG cùng 1 hướng.
                foldAngle: 90,
                foldDirection: ((lc.parent === 'front_sec' ? xDir : -xDir)) as 1 | -1,
                foldPhase: [0.4, 0.52],
            });
        }
    }

    // ── Sleeve (Vỏ hộp diêm) — hiển thị bên cạnh khay, căn giữa dọc ──
    const trayBB = computeBoundingBox(allPaths);
    const sleeveGap = SLEEVE_DISPLAY_GAP;
    const sleeveOffsetX = snap(trayBB.maxX + sleeveGap);

    // Tính chiều cao sleeve để căn giữa theo tray
    const clearance = 1; // matches SLEEVE_CLEARANCE in MatchboxSleeve.ts
    const sW_sleeve = snap(W + clearance);
    const sD_sleeve = snap(D + clearance);
    const sG_sleeve = snap(Math.min(params.sleeveGlue ?? 15, sD_sleeve / 2));
    // Canh offsetY để LÒNG ỐNG vỏ trùng tâm Y của khay (W/2) → khay lồng vào
    // theo TRỤC X thẳng (Δy = 0), không bay chéo. Mặt trước vỏ (đáy ống) nằm ở
    // y∈[offsetY+G, offsetY+G+sW]; tâm của nó = offsetY+G+sW/2, đặt = W/2.
    const sleeveOffsetY = snap(W / 2 - sG_sleeve - sW_sleeve / 2);

    const sleeve = generateMatchboxSleeve(params, sleeveOffsetX, sleeveOffsetY);
    allPaths.push(...sleeve.paths);
    panels.push(...sleeve.panels);

    // Vector LỒNG khay vào vỏ (hệ phẳng-đã-gập): đưa tâm hộp khay (L/2,W/2,D/2)
    // trùng tâm lòng ống vỏ. Ống vỏ: mặt trước y∈[G,G+sW] (tâm sW/2), x∈[0,sL]
    // (tâm sL/2), z∈[0,sD] (tâm sD/2) — tất cả cộng offset.
    const sL_sleeve = snap(params.L + clearance);
    const nesting = {
        x: snap(sleeveOffsetX + sL_sleeve / 2 - L / 2),
        y: snap(sleeveOffsetY + sG_sleeve + sW_sleeve / 2 - W / 2),
        z: snap(sD_sleeve / 2 - D / 2),
    };

    return {
        name: 'Matchbox Tray + Sleeve (Hộp Diêm)',
        standardCode: 'FEFCO-0410',
        description: 'Khay thành đôi 5 lớp + vỏ bao ngoài — hiển thị cạnh nhau',
        panels,
        allPaths,
        boundingBox: computeBoundingBox(allPaths),
        params,
        nesting,
    };
}
