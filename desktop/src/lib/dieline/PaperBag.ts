// ============================================================
// Túi Giấy SOS — Paper Bag (Side-Opening-Side)
// Loại túi giấy phổ biến nhất: cửa hàng, F&B, quà tặng.
//
// Layout trải phẳng — hỗ trợ glueSide + panelOrder:
//
//  glueSide='left', panelOrder='WLWL':
//    G | W | L | W | L
//
//  glueSide='right', panelOrder='WLWL':
//    W | L | W | L | G
//
//  panelOrder='LWLW' → đổi L↔W
//
// Gốc tọa độ (0,0) = góc dưới-trái đáy panel đầu tiên.
// ============================================================

import {
    BoxParams,
    DielineModel,
    Panel,
    PathSegment,
    Point2D,
} from './types';

import {
    pt,
    line,
    snap,
    computeBoundingBox,
} from './utils';

import {
    GLUE_TAPER_RATIO,
    HANDLE_HOLE_RADIUS,
    HANDLE_HOLE_MARGIN,
} from './constants';

// ─── Helper: Hình tròn dạng polygon điểm (cho holes 3D) ────
function circlePoly(cx: number, cy: number, r: number): Point2D[] {
    const N = 32;
    const pts: Point2D[] = [];
    for (let i = 0; i < N; i++) {
        const angle = (2 * Math.PI * i) / N;
        pts.push(pt(snap(cx + r * Math.cos(angle)), snap(cy + r * Math.sin(angle))));
    }
    return pts;
}

// ─── Helper: Clip đoạn thẳng vào bbox (Liang–Barsky) ────────
function clipLineToBox(
    p1: Point2D, p2: Point2D,
    minX: number, maxX: number, minY: number, maxY: number,
): [Point2D, Point2D] | null {
    let t0 = 0, t1 = 1;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const checks = [
        { p: -dx, q: p1.x - minX },
        { p: dx, q: maxX - p1.x },
        { p: -dy, q: p1.y - minY },
        { p: dy, q: maxY - p1.y },
    ];
    for (const { p, q } of checks) {
        if (p === 0) {
            if (q < 0) return null; // song song & ngoài
        } else {
            const r = q / p;
            if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
            else { if (r < t0) return null; if (r < t1) t1 = r; }
        }
    }
    if (t1 - t0 < 1e-6) return null; // đoạn còn lại quá ngắn
    return [
        { x: p1.x + t0 * dx, y: p1.y + t0 * dy },
        { x: p1.x + t1 * dx, y: p1.y + t1 * dy },
    ];
}

// ─── Helper: Vẽ hình tròn (polyline xấp xỉ) ────────────
function circleArcs(cx: number, cy: number, r: number, tag: 'CUT' | 'CREASE'): PathSegment[] {
    const segs: PathSegment[] = [];
    const N = 32;
    const pts: Point2D[] = [];
    for (let i = 0; i <= N; i++) {
        const angle = (2 * Math.PI * i) / N;
        pts.push(pt(snap(cx + r * Math.cos(angle)), snap(cy + r * Math.sin(angle))));
    }
    for (let i = 0; i < N; i++) {
        segs.push(line(pts[i], pts[i + 1], tag));
    }
    return segs;
}

// ─── Panel definition ────────────────────────────────────
interface PanelDef {
    type: 'glue' | 'side' | 'face';
    width: number;
    name: string;
    label: string;
}

/** Build panel sequence based on glueSide + panelOrder */
function buildSequence(
    glueSide: 'left' | 'right',
    panelOrder: 'WLWL' | 'LWLW',
    G: number, W: number, L: number
): PanelDef[] {
    const mainPanels: PanelDef[] = panelOrder === 'WLWL'
        ? [
            { type: 'side', width: W, name: 'side1', label: 'Hông 1' },
            { type: 'face', width: L, name: 'front', label: 'Mặt trước' },
            { type: 'side', width: W, name: 'side2', label: 'Hông 2' },
            { type: 'face', width: L, name: 'back', label: 'Mặt sau' },
        ]
        : [
            { type: 'face', width: L, name: 'front', label: 'Mặt trước' },
            { type: 'side', width: W, name: 'side1', label: 'Hông 1' },
            { type: 'face', width: L, name: 'back', label: 'Mặt sau' },
            { type: 'side', width: W, name: 'side2', label: 'Hông 2' },
        ];

    const glueDef: PanelDef = { type: 'glue', width: G, name: 'glue_flap', label: 'Mí dán' };

    return glueSide === 'left'
        ? [glueDef, ...mainPanels]
        : [...mainPanels, glueDef];
}

/**
 * Sinh bản vẽ khuôn bế Túi Giấy SOS từ thông số đầu vào.
 */
export function generatePaperBag(params: BoxParams): DielineModel {
    const { L, W, D, G, glueSide, panelOrder } = params;

    // Resolved auto-params
    // RULE: độ cao đáy KHÔNG vượt quá 85% độ rộng hông (W). Đáy quá cao so với
    // hông sẽ không gập chụm phẳng được (chồng quá nhiều / cấn). Mặc định 85%W.
    const bottomHMax = snap(W * 0.85);
    const bottomHraw = params.BF > 0 ? params.BF : snap(W * 0.85);
    const bottomH = Math.min(bottomHraw, bottomHMax);
    const topFold = params.TH > 0 ? params.TH : 0;
    const HR = params.HR > 0 ? params.HR : HANDLE_HOLE_RADIUS;
    const HM = params.HM > 0 ? params.HM : HANDLE_HOLE_MARGIN;
    const HS = params.HS > 0 ? params.HS : snap(L * 0.35);
    const showHandleHoles = params.handleHoles;

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    // ============================================================
    // A. Build panel sequence & compute X coordinates
    // ============================================================
    const seq = buildSequence(glueSide, panelOrder, G, W, L);
    const xs: number[] = [0];
    for (const p of seq) {
        xs.push(snap(xs[xs.length - 1] + p.width));
    }
    const xTotal = xs[xs.length - 1]; // Mép phải ngoài cùng

    // Find panel indices by type
    const glueIdx = seq.findIndex(p => p.type === 'glue');
    const sideIndices = seq.map((p, i) => p.type === 'side' ? i : -1).filter(i => i >= 0);
    const faceIndices = seq.map((p, i) => p.type === 'face' ? i : -1).filter(i => i >= 0);

    // ============================================================
    // B. Tọa độ Y — 3 vùng: Đáy | Thân | Nắp
    // ============================================================
    const yBotFlap = 0;
    const yBody = snap(bottomH);
    const yTop = snap(bottomH + D);
    const yTopFold = snap(bottomH + D + topFold);

    // ============================================================
    // C. VẼ THÂN TÚI — từ panel sequence
    // ============================================================
    const glueVat = snap(G * GLUE_TAPER_RATIO);
    // Vát góc mí dán (glueVat) phải nằm GỌN trong vùng mà nó bevel: vát ở ĐÁY
    // chỉ được cao tối đa bằng chiều cao vùng đáy (bottomH), vát ở MIỆNG chỉ
    // được cao tối đa bằng chiều cao mí miệng (topFold). Nếu glueVat vượt quá,
    // đỉnh vát sẽ thò QUA đường gập (yBody / yTop) sang vùng kế bên → tai đáy
    // mí dán (mục C3) và mí miệng mí dán (mục D2) bị tự cắt (bowtie) và CHỒNG
    // LẤN nhau (lỗi hình học thật, không phải nhiễu đo). Kẹp riêng từng đầu để
    // giữ đúng ý nghĩa "vát góc" tối đa mà vẫn hợp lệ. Trường hợp thường gặp
    // (vùng đủ cao) → botVat = topVat = glueVat, hành vi KHÔNG đổi.
    const botVat = snap(Math.min(glueVat, bottomH));
    const topVat = snap(Math.min(glueVat, topFold > 0 ? topFold : D));
    const glueIsLeft = glueSide === 'left';

    for (let i = 0; i < seq.length; i++) {
        const p = seq[i];
        const xL = xs[i];
        const xR = xs[i + 1];

        if (p.type === 'glue') {
            // --- Glue Flap — kéo dài toàn bộ từ đáy đến nắp ---
            const gluePaths: PathSegment[] = [];
            if (glueIsLeft) {
                // Glue bên trái: vát hướng trái
                gluePaths.push(line(pt(xL, yBotFlap + botVat), pt(xL, yTopFold - topVat), 'CUT'));
                gluePaths.push(line(pt(xL, yTopFold - topVat), pt(xR, yTopFold), 'CUT'));
                gluePaths.push(line(pt(xR, yBotFlap), pt(xL, yBotFlap + botVat), 'CUT'));
            } else {
                // Glue bên phải: vát hướng phải
                gluePaths.push(line(pt(xR, yBotFlap + botVat), pt(xR, yTopFold - topVat), 'CUT'));
                gluePaths.push(line(pt(xR, yTopFold - topVat), pt(xL, yTopFold), 'CUT'));
                gluePaths.push(line(pt(xL, yBotFlap), pt(xR, yBotFlap + botVat), 'CUT'));
            }
            allPaths.push(...gluePaths);
            // Crease biên glue ↔ panel kề
            allPaths.push(line(pt(glueIsLeft ? xR : xL, yBotFlap), pt(glueIsLeft ? xR : xL, yTopFold), 'CREASE'));
            // Crease ngang tại giao nắp/đáy với mí dán
            if (topFold > 0) {
                allPaths.push(line(pt(xL, yTop), pt(xR, yTop), 'CREASE'));    // Giao nắp - mí dán
            }
            allPaths.push(line(pt(xL, yBody), pt(xR, yBody), 'CREASE')); // Giao đáy - mí dán
            panels.push({
                name: p.name, label: p.label,
                // paths để RỖNG: nét sẽ do vòng clip (mục H) điền theo bbox đã
                // cắt (body+đáy). Nếu giữ gluePaths (full height) thì nét miệng
                // sẽ lơ lửng ngoài khối mí dán đã cắt ở yTop.
                paths: [],
                // Outline 3D mí dán = CHỈ vùng THÂN [yBody..yTop]. Vùng ĐÁY
                // ([yBotFlap..yBody]) tách thành panel `bottom_glue_flap` (mục
                // C3) để gập VÀO ĐÁY theo cạnh ngang yBody — nếu giữ chung với
                // thân thì phần đáy mí dán chỉ cuốn theo vách (quanh cạnh đứng)
                // và KHÔNG gập vào đáy. Vùng MIỆNG ([yTop..yTopFold]) tách thành
                // `lip_glue_flap` (mục D2). Phần thân là HCN phẳng (vát glueVat
                // nằm dưới yBody nên không ảnh hưởng).
                outline: [
                    pt(xL, yBody), pt(xR, yBody), pt(xR, yTop), pt(xL, yTop),
                ],
                parent: glueIsLeft ? seq[i + 1]?.name ?? null : seq[i - 1]?.name ?? null,
                pivotEdge: [pt(glueIsLeft ? xR : xL, yBody), pt(glueIsLeft ? xR : xL, yTop)],
                // Mép keo cuộn cùng chiều chuỗi tường liền kề: net = −90 (trái) /
                // +90 (phải). net = foldAngle × foldDirection.
                foldAngle: -90,
                foldDirection: glueIsLeft ? 1 : -1,
            });
        } else {
            // --- Side hoặc Face panel ---
            const isLastPanel = i === seq.length - 1;
            const isFirstNonGlue = (glueIsLeft && i === 1) || (!glueIsLeft && i === 0);

            const bodyPaths: PathSegment[] = [
                line(pt(xL, yBody), pt(xR, yBody), 'CREASE'),
                line(pt(xR, yBody), pt(xR, yTop), isLastPanel ? 'CUT' : 'CREASE'),
            ];
            // Chỉ vẽ CREASE tại yTop nếu có mí gập
            if (topFold > 0) {
                bodyPaths.push(line(pt(xR, yTop), pt(xL, yTop), 'CREASE'));
            }
            // Cạnh trái CUT nếu là panel đầu tiên (không có glue bên trái)
            if (isFirstNonGlue && !glueIsLeft) {
                bodyPaths.push(line(pt(xL, yBody), pt(xL, yTop), 'CUT'));
            }
            allPaths.push(...bodyPaths);

            // Determine parent & pivot
            let parent: string | null = null;
            let pivotEdge: [Point2D, Point2D] | null = null;
            let foldAngle = 0;
            let foldDir: 1 | -1 = 1;

            if (i === (glueIsLeft ? 2 : 1)) {
                // ROOT panel (2nd main panel = first face in WLWL)
                parent = null;
                pivotEdge = null;
            } else if (i < (glueIsLeft ? 2 : 1)) {
                // Chuỗi panel BÊN TRÁI gốc — phải cuộn CÙNG CHIỀU với chuỗi phải
                // (về phía −Z) để khép thành ống kín. (Trước đây +90 khiến hông
                // trái xòe ngược về +Z → ống hở, "gấp sai".)
                parent = seq[i + 1]?.name ?? null;
                pivotEdge = [pt(xR, yBody), pt(xR, yTop)];
                // Net = foldAngle × foldDirection = −90 (ngược chiều chuỗi phải
                // vốn +90) để hai hông cùng chụm về −Z, khép ống kín.
                foldAngle = -90;
                foldDir = 1;
            } else {
                parent = seq[i - 1]?.name ?? null;
                pivotEdge = [pt(xL, yBody), pt(xL, yTop)];
                foldAngle = -90;
                foldDir = -1;
            }

            panels.push({
                name: p.name, label: p.label, paths: bodyPaths,
                // Outline 3D CHỈ vùng THÂN [yBody..yTop] — KHÔNG gồm vùng đáy
                // (tách thành tai đáy mục C2) và KHÔNG gồm mí miệng (tách thành
                // panel lip mục D2 để gập mép trên).
                outline: [
                    pt(xL, yBody), pt(xR, yBody), pt(xR, yTop), pt(xL, yTop)
                ],
                parent, pivotEdge, foldAngle, foldDirection: foldDir,
            });
        }
    }

    // ============================================================
    // C2. PANEL GẬP ĐÁY SOS — tách vùng đáy thành 4 tai gập riêng
    //
    // Mỗi mặt tường (hông/mặt) có một tai đáy [xL..xR]×[yBotFlap..yBody]
    // bản lề tại cạnh đáy thân (yBody). Khi mô phỏng 3D, sau khi 4 tường
    // đã gập thành ống, các tai đáy gập 90° vào trong để CHỤM thành đáy
    // hộp — thay vì lòi ra như váy phẳng (lỗi cũ). Tai hông tuck trước,
    // tai mặt trước/sau gập đè lên sau (foldPhase so le).
    //
    // foldAngle/foldDirection đã đo bằng test tạm: gập VÀO LÒNG ống ứng với
    // net −90° (foldAngle 90 + foldDirection −1) cho mọi tường, vì tai nằm
    // ở phía −Y cục bộ và lòng ống ở phía +Z cục bộ của mỗi tường.
    // ============================================================
    for (let i = 0; i < seq.length; i++) {
        const p = seq[i];
        if (p.type === 'glue') continue;
        const xL = xs[i];
        const xR = xs[i + 1];
        const isSide = p.type === 'side';
        panels.push({
            name: `bottom_${p.name}`,
            label: `Đáy ${p.label}`,
            // Cạnh biên tai đáy: mép bản lề (yBody) là CREASE, ba mép còn lại CUT.
            // (Chỉ gắn vào panel để hợp lệ + vẽ overlay 3D; KHÔNG thêm vào allPaths
            // nên không đổi biên cắt 2D / contour.)
            paths: [
                line(pt(xL, yBody), pt(xR, yBody), 'CREASE'),
                line(pt(xR, yBody), pt(xR, yBotFlap), 'CUT'),
                line(pt(xR, yBotFlap), pt(xL, yBotFlap), 'CUT'),
                line(pt(xL, yBotFlap), pt(xL, yBody), 'CUT'),
            ],
            outline: [
                pt(xL, yBotFlap), pt(xR, yBotFlap), pt(xR, yBody), pt(xL, yBody),
            ],
            parent: p.name,
            pivotEdge: [pt(xL, yBody), pt(xR, yBody)],
            // Net = foldAngle × foldDirection = +90 → gập VÀO LÒNG ống (đo bằng
            // test tạm: net −90 gập ra ngoài, +90 gập vào trong cho cả 4 tường).
            foldAngle: 90,
            foldDirection: 1,
            // Tai hông tuck trước [0.78..0.9]; tai mặt trước/sau đè lên [0.9..1.0].
            foldPhase: isSide ? [0.78, 0.9] : [0.9, 1.0],
            // 4 tai đáy gập về CÙNG mặt phẳng đáy → đồng phẳng gây z-fighting.
            // Phân lớp (polygonOffset) theo thứ tự xếp: hông dưới cùng, mặt
            // trước/sau đè lên trên — như đáy SOS chồng lớp thật.
            stackZ: isSide ? (p.name === 'side1' ? 1 : 2) : (p.name === 'front' ? 3 : 4),
        });
    }

    // ============================================================
    // C3. TAI ĐÁY CỦA MÍ DÁN — phần đáy mí dán cũng gập VÀO ĐÁY
    //
    // Mí dán cuốn quanh cạnh ĐỨNG để dán lên vách kề; nhưng phần ĐÁY của nó
    // ([yBotFlap..yBody]) phải gập VÀO ĐÁY hộp theo cạnh ngang yBody — y như
    // các tai đáy tường. Parent = glue_flap nên nó thừa hưởng phép cuốn của mí
    // dán rồi mới gập tiếp vào đáy (đúng trình tự thật). Giữ vát glueVat ở góc.
    // ============================================================
    {
        const gi = glueIdx;
        const gxL = xs[gi];
        const gxR = xs[gi + 1];
        const botOutline = glueIsLeft
            ? [pt(gxR, yBotFlap), pt(gxL, yBotFlap + botVat), pt(gxL, yBody), pt(gxR, yBody)]
            : [pt(gxL, yBotFlap), pt(gxR, yBotFlap + botVat), pt(gxR, yBody), pt(gxL, yBody)];
        panels.push({
            name: 'bottom_glue_flap',
            label: 'Đáy mí dán',
            // Mép bản lề (yBody) = CREASE; biên còn lại do vòng clip điền.
            paths: [
                line(pt(gxL, yBody), pt(gxR, yBody), 'CREASE'),
            ],
            outline: botOutline,
            parent: 'glue_flap',
            pivotEdge: [pt(gxL, yBody), pt(gxR, yBody)],
            // Gập VÀO ĐÁY net +90 như tai đáy tường (đo cùng quy ước).
            foldAngle: 90,
            foldDirection: 1,
            // Gập cùng nhịp tai hông (mí dán dán lên vách hông kề).
            foldPhase: [0.78, 0.9],
            // Dán đè lên tai đáy của vách kề (side1/last) → cùng lớp dưới.
            stackZ: 1,
        });
    }

    // ============================================================
    // D2. PANEL MÍ MIỆNG (lip) — gập mép trên xuống ốp vào thân
    //
    // Mỗi tường (hông/mặt) có một mí miệng [xL..xR]×[yTop..yTopFold] bản lề tại
    // cạnh trên thân (yTop), gập 180° ốp PHẲNG xuống mặt trong tường (hem mép
    // trên). stackZ phân lớp tránh z-fighting với tường. Gập muộn, sau khi ống
    // đã cuốn (phase ~0.55–0.7), trước khi gập đáy.
    // ============================================================
    if (topFold > 0) {
        let lipStack = 5;
        // Lượng đẩy mí miệng vào TRONG lòng túi (mm, ÂM = về phía sau tường).
        // ≥ 2 lớp giấy để mép mí nằm hẳn sau mặt trong tường → nhìn từ ngoài
        // chỉ thấy mặt ngoài (finish) của tường, không lộ mặt sau giấy của mí.
        const lipInsetZ = -(params.T * 2 + 0.3);
        for (let i = 0; i < seq.length; i++) {
            const p = seq[i];
            // GỒM CẢ mí dán (glue): vùng miệng của mí dán cũng phải gập vào
            // trong như các mí vách (nếu bỏ sẽ mất phần để dán ở nắp).
            const xL = xs[i];
            const xR = xs[i + 1];
            // Góc TRÊN của mí miệng: với MÍ DÁN, cạnh trên VÁT XIÊN theo glueVat
            // (đúng đường cắt 2D mục C) — nếu để vuông thì nền solid vuông góc
            // trong khi nét khuôn lại vát, lệch nhau. Các panel khác giữ vuông.
            let topL = pt(xL, yTopFold);
            let topR = pt(xR, yTopFold);
            if (p.type === 'glue') {
                if (glueIsLeft) topL = pt(xL, yTopFold - topVat);
                else topR = pt(xR, yTopFold - topVat);
            }
            panels.push({
                name: `lip_${p.name}`,
                label: `Mí miệng ${p.label}`,
                paths: [
                    line(pt(xL, yTop), pt(xR, yTop), 'CREASE'),
                    line(pt(xR, yTop), topR, 'CUT'),
                    line(topR, topL, 'CUT'),
                    line(topL, pt(xL, yTop), 'CUT'),
                ],
                outline: [
                    pt(xL, yTop), pt(xR, yTop), topR, topL,
                ],
                parent: p.name,
                pivotEdge: [pt(xL, yTop), pt(xR, yTop)],
                // Mí miệng gập VÀO PHÍA TRONG túi (−z) TRƯỚC TIÊN (sớm nhất),
                // rồi vách mới cuộn lại dán hông. net = 180×(−1) = lật vào trong.
                foldAngle: 180,
                foldDirection: -1,
                foldPhase: [0.05, 0.2],
                // Mí hem gập vào TRONG → phải nằm SAU mặt tường (ẩn trong lòng)
                // để nhìn từ ngoài thấy mặt ngoài tường, KHÔNG thấy mặt sau giấy
                // của mí. stackZ ÂM → polygonOffset đẩy mí ra sau (xa camera);
                // CỘNG THÊM dịch hình học THẬT renderZShift (vào −z cục bộ tường)
                // để mép mí nằm hẳn sau mặt trong tường, không còn đồng phẳng
                // gây z-fighting / lộ mặt sau.
                stackZ: -(lipStack++),
                renderZShift: lipInsetZ,
            });
        }
    }

    // ============================================================
    // D. MÍ GẤP MIỆNG — custom hoặc 0 = ko gập
    // ============================================================
    const topLeft = glueIsLeft ? xs[1] : xs[0];
    const topRight = glueIsLeft ? xs[seq.length] : xs[seq.length - 1];

    if (topFold > 0) {
        // Có mí gập: crease tại yTop, HCN mí gập phía trên
        allPaths.push(line(pt(0, yTop), pt(xTotal, yTop), 'CREASE'));  // Đường gấp miệng
        allPaths.push(line(pt(topLeft, yTopFold), pt(topRight, yTopFold), 'CUT'));  // Cạnh trên
        if (glueIsLeft) {
            allPaths.push(line(pt(topRight, yTop), pt(topRight, yTopFold), 'CUT'));
        } else {
            allPaths.push(line(pt(topLeft, yTop), pt(topLeft, yTopFold), 'CUT'));
        }
        // Crease dọc kéo lên nắp
        for (let i = 1; i < seq.length; i++) {
            if (i === glueIdx || i === glueIdx + 1) continue;
            allPaths.push(line(pt(xs[i], yTop), pt(xs[i], yTopFold), 'CREASE'));
        }
    } else {
        // Ko gập (TH=0): yTop = cạnh trên CUT, ko có mí gập
        allPaths.push(line(pt(topLeft, yTop), pt(topRight, yTop), 'CUT'));  // Cạnh trên = CUT
    }

    // ============================================================
    // E. ĐÁY TÚI — HCN cao = 85% × W
    // ============================================================
    const botLeft = topLeft;
    const botRight = topRight;

    allPaths.push(line(pt(0, yBody), pt(xTotal, yBody), 'CREASE'));     // Đường gấp đáy
    allPaths.push(line(pt(botLeft, yBotFlap), pt(botRight, yBotFlap), 'CUT'));  // Cạnh dưới
    if (glueIsLeft) {
        allPaths.push(line(pt(botRight, yBody), pt(botRight, yBotFlap), 'CUT'));    // Cạnh phải (CUT vì ko có glue)
    } else {
        allPaths.push(line(pt(botLeft, yBody), pt(botLeft, yBotFlap), 'CUT'));      // Cạnh trái (CUT vì ko có glue)
    }

    // Crease dọc kéo xuống đáy
    for (let i = 1; i < seq.length; i++) {
        if (i === glueIdx || i === glueIdx + 1) continue;
        allPaths.push(line(pt(xs[i], yBody), pt(xs[i], yBotFlap), 'CREASE'));
    }

    // ============================================================
    // F. ĐƯỜNG NHẤN DỌC GIỮA HÔNG + ĐƯỜNG CHÉO 45°
    //
    // Đường chéo bắt đầu tại (mid, yBody + W/2) trên center crease,
    // ĐI QUA giao điểm mặt chính / hông tại yBody,
    // kết thúc tại yBotFlap hoặc mép ngoài mí dán (clamp).
    // ============================================================
    const halfW = snap(W / 2);
    const diagStartY = snap(yBody + halfW);

    for (const si of sideIndices) {
        const sxL = xs[si];
        const mid = snap(sxL + W / 2);

        // Đường nhấn dọc giữa hông (kéo từ nắp → đáy)
        allPaths.push(line(pt(mid, yTopFold), pt(mid, yBotFlap), 'CREASE'));

        // --- Đường chéo 45° bên trái ---
        // Từ (mid, diagStartY) → qua (sxL, yBody) → đến yBotFlap
        // Clamp tại x=0 (mép ngoài mí dán)
        const rawLeftX = snap(mid - (diagStartY - yBotFlap));
        const clampedLeftX = Math.max(0, rawLeftX);
        const clampedLeftY = snap(diagStartY - (mid - clampedLeftX));
        allPaths.push(line(pt(mid, diagStartY), pt(clampedLeftX, clampedLeftY), 'CREASE'));

        // --- Đường chéo 45° bên phải ---
        // Từ (mid, diagStartY) → qua (sxR, yBody) → đến yBotFlap
        // Clamp tại xTotal (mép ngoài cùng)
        const rawRightX = snap(mid + (diagStartY - yBotFlap));
        const clampedRightX = Math.min(xTotal, rawRightX);
        const clampedRightY = snap(diagStartY - (clampedRightX - mid));
        allPaths.push(line(pt(mid, diagStartY), pt(clampedRightX, clampedRightY), 'CREASE'));
    }

    // --- Đường nhấn ngang nối 2 điểm bắt đầu đường chéo ---
    // KHÔNG đi qua mặt chính nằm trực tiếp giữa 2 hông.
    // Đi hướng ngược lại → qua mặt chính chỉ giáp 1 hông.
    // Trên dieline phẳng = 2 đoạn: mid1→mép trái, mid2→mép phải.
    if (sideIndices.length === 2) {
        const mid1 = snap(xs[sideIndices[0]] + W / 2);
        const mid2 = snap(xs[sideIndices[1]] + W / 2);
        const [mLeft, mRight] = mid1 < mid2 ? [mid1, mid2] : [mid2, mid1];
        // Đoạn trái: từ mid gần mép trái → mép trái (x=0)
        allPaths.push(line(pt(mLeft, diagStartY), pt(0, diagStartY), 'CREASE'));
        // Đoạn phải: từ mid gần mép phải → mép phải (xTotal)
        allPaths.push(line(pt(mRight, diagStartY), pt(xTotal, diagStartY), 'CREASE'));
    }

    // --- Đường chéo mép ngoài — mặt chính ko giáp hông ---
    // Đi QUA giao điểm mặt-đáy, kéo lên vào thân (giống hông).
    // Nếu bên cạnh là mí dán → kéo tới mép ngoài mí dán.
    for (const fi of faceIndices) {
        const fxL = xs[fi];
        const fxR = xs[fi + 1];

        // Kiểm tra bên trái
        const leftNeighbor = fi > 0 ? seq[fi - 1] : null;
        if (!leftNeighbor || leftNeighbor.type !== 'side') {
            // Mép trái: giao điểm tại (fxL, yBody)
            // Mép ngoài mí dán nếu bên trái là glue
            const outerX = (leftNeighbor?.type === 'glue') ? xs[fi - 1] : fxL;
            // Kéo lên 45° vào thân: từ (outerX, yBody + (fxL - outerX))
            const upperY = snap(yBody + (fxL - outerX));
            // Kéo xuống 45° vào đáy: từ (fxL, yBody) đi xuống-phải
            const lowerX = snap(fxL + bottomH);
            allPaths.push(line(pt(outerX, upperY), pt(lowerX, yBotFlap), 'CREASE'));
        }

        // Kiểm tra bên phải
        const rightNeighbor = fi < seq.length - 1 ? seq[fi + 1] : null;
        if (!rightNeighbor || rightNeighbor.type !== 'side') {
            // Mép phải: giao điểm tại (fxR, yBody)
            const outerX = (rightNeighbor?.type === 'glue') ? xs[fi + 2] : fxR;
            // Kéo lên 45° vào thân: từ (outerX, yBody + (outerX - fxR))
            const upperY = snap(yBody + (outerX - fxR));
            // Kéo xuống 45° vào đáy: từ (fxR, yBody) đi xuống-trái
            const lowerX = snap(fxR - bottomH);
            allPaths.push(line(pt(outerX, upperY), pt(lowerX, yBotFlap), 'CREASE'));
        }
    }

    // ============================================================
    // G. LỖ XỎ DÂY QUAI (Handle Holes) — trên các mặt chính
    // ============================================================
    if (showHandleHoles) {
        const holeY = snap(yTop - HM);
        const panelByName = new Map(panels.map((pn) => [pn.name, pn]));

        for (const fi of faceIndices) {
            const fxL = xs[fi];
            const faceCx = snap(fxL + L / 2);
            const holeL = circleArcs(snap(faceCx - HS / 2), holeY, HR, 'CUT');
            const holeR = circleArcs(snap(faceCx + HS / 2), holeY, HR, 'CUT');
            allPaths.push(...holeL, ...holeR);

            // Lỗ quai THẬT (holes) trên panel mặt → 3D khoét lỗ.
            const facePanel = panelByName.get(seq[fi].name);
            if (facePanel) {
                facePanel.holes = facePanel.holes ?? [];
                facePanel.holes.push(circlePoly(snap(faceCx - HS / 2), holeY, HR));
                facePanel.holes.push(circlePoly(snap(faceCx + HS / 2), holeY, HR));
            }

            // --- Lỗ đối xứng trên mí gập miệng ---
            // Khi gập, lỗ trên mí gập phải trùng với lỗ trên thân.
            // Vị trí đối xứng qua yTop: mirrorY = yTop + HM
            // Chỉ vẽ nếu: topFold > 0 VÀ lỗ nằm trong mí gập (HM + HR <= topFold - 5)
            if (topFold > 0 && (HM + HR) <= (topFold - 5)) {
                const mirrorY = snap(yTop + HM);
                const mirrorL = circleArcs(snap(faceCx - HS / 2), mirrorY, HR, 'CUT');
                const mirrorR = circleArcs(snap(faceCx + HS / 2), mirrorY, HR, 'CUT');
                allPaths.push(...mirrorL, ...mirrorR);
                // Lỗ trên mí miệng (lip) tương ứng.
                const lipPanel = panelByName.get(`lip_${seq[fi].name}`);
                if (lipPanel) {
                    lipPanel.holes = lipPanel.holes ?? [];
                    lipPanel.holes.push(circlePoly(snap(faceCx - HS / 2), mirrorY, HR));
                    lipPanel.holes.push(circlePoly(snap(faceCx + HS / 2), mirrorY, HR));
                }
            }
        }
    }

    // ============================================================
    // H. CLIP nét khuôn vào từng panel + Bounding Box & Trả về
    //
    // Mỗi đoạn nét trong allPaths được CẮT (clip) theo outline-bbox của từng
    // panel; phần nằm trong panel được thêm vào paths panel đó (gập theo panel,
    // KHÔNG thò ra ngoài). Nhờ vậy đường chéo SOS cắt qua ranh body↔đáy vẫn
    // hiện đúng phần của nó trên từng panel. Bezier (viền lỗ quai) chỉ thêm khi
    // toàn bộ control points nằm trong panel.
    // ============================================================
    const TOL = 0.5;
    for (const panel of panels) {
        const ol = panel.outline;
        if (!ol || ol.length < 3) continue;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const q of ol) {
            if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
            if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
        }
        const bMinX = minX - TOL, bMaxX = maxX + TOL, bMinY = minY - TOL, bMaxY = maxY + TOL;
        const have = new Set(panel.paths);
        for (const s of allPaths) {
            if (have.has(s)) continue;
            if (s.type === 'bezier' && s.controlPoints) {
                const allIn = s.controlPoints.every((q) =>
                    q.x >= bMinX && q.x <= bMaxX && q.y >= bMinY && q.y <= bMaxY);
                if (allIn) panel.paths.push(s);
                continue;
            }
            // Đoạn thẳng (có thể nhiều điểm): clip từng đoạn con, gom lại.
            for (let k = 0; k < s.points.length - 1; k++) {
                const clip = clipLineToBox(s.points[k], s.points[k + 1], bMinX, bMaxX, bMinY, bMaxY);
                if (clip) panel.paths.push(line(clip[0], clip[1], s.tag));
            }
        }
    }

    const bb = computeBoundingBox(allPaths);

    return {
        name: 'Paper Bag SOS',
        standardCode: 'SOS-STANDARD',
        description: 'Túi giấy SOS — Cửa hàng, F&B, Quà tặng',
        panels,
        allPaths,
        boundingBox: bb,
        params,
    };
}
