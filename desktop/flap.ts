function buildSideTriFlap(
    xLeft: number, xRight: number,
    yBase: number, sideW: number, panelW: number, dir: 1 | -1,
    overrideH: number = 0, // 0 = auto (h1+h2), >0 = custom, clamp >= slotH+5
    gableStyle: 'flat' | 'pitched' = 'flat',
    slotW: number = 3,
    ratioSLH: number = 85,
    overrideTRW: number = 0
): { paths: PathSegment[], holes: PathSegment[], annotations: any[] } {

    const paths: PathSegment[] = [];
    const holes: PathSegment[] = [];
    const annotations: any[] = [];
    
    const h1 = snap(gableStyle === 'pitched' ? sideW / Math.sqrt(3) : sideW / 2);
    const h2 = snap(0.9 * h1);
    const defaultH = snap(h1 + h2);
    
    const gableFold = gableStyle === 'pitched' ? 60 : 90;
    const insetA = snap(gableStyle === 'pitched' ? (panelW - 5 / 6 * panelW) / 2 : 0);
    const rectH = snap((ratioSLH / 100) * h2);
    
    const Z_height = h1 * Math.cos(gableFold * Math.PI / 180);
    const minH = snap(Math.sqrt(insetA * insetA + Z_height * Z_height) + 15);
    const triH = snap(Math.max(overrideH > 0 ? overrideH : defaultH, minH));
    const xMid = snap((xLeft + xRight) / 2);
    const yTip = snap(yBase + dir * triH);

    // Bo tròn đỉnh
    const halfBase = (xRight - xLeft) / 2;
    const sideLen = Math.sqrt(halfBase * halfBase + triH * triH);
    const tipR = snap(Math.min(panelW * 0.40, triH * 0.30));
    const kappa = 4 * (Math.sqrt(2) - 1) / 3;
    const kLenT = snap(tipR * kappa);

    const uLx = (xLeft - xMid) / sideLen;
    const uLy = (dir * (yBase - yTip)) / sideLen;
    const uRx = (xRight - xMid) / sideLen;
    const uRy = (dir * (yBase - yTip)) / sideLen;

    const tL = pt(snap(xMid + uLx * tipR), snap(yTip + uLy * tipR));
    const tR = pt(snap(xMid + uRx * tipR), snap(yTip + uRy * tipR));

    paths.push(line(pt(xLeft, yBase), tL, 'CUT'));
    paths.push(bezierSegment(tL,
        pt(snap(tL.x - uLx * kLenT), snap(tL.y - uLy * kLenT)),
        pt(snap(tR.x - uRx * kLenT), snap(tR.y - uRy * kLenT)),
        tR, 'CUT'));
    paths.push(line(tR, pt(xRight, yBase), 'CUT'));

    // === Rãnh gài (lock slot) theo code cũ ===
    const slotR = snap(slotW / 2);
    const slotKLen = snap(slotR * kappa);

    // slotH ở code cũ là 0.85 * h2. Hiện tại rectH = ratioSLH * h2
    // Tôi sẽ dùng rectH để tương thích với tham số của component mới
    const slotH = rectH;

    const sL = pt(snap(xMid - slotW / 2), yBase);
    const sR = pt(snap(xMid + slotW / 2), yBase);
    const sTopY = snap(yBase + dir * slotH);
    const sTopL = pt(sL.x, snap(sTopY - dir * slotR));
    const sTopR = pt(sR.x, snap(sTopY - dir * slotR));
    const sArcTop = pt(xMid, sTopY);

    // Vẽ rãnh hình chữ U hở đáy:
    paths.push(line(sL, sTopL, 'CUT'));
    paths.push(bezierSegment(sTopL,
        pt(sTopL.x, snap(sTopL.y + dir * slotKLen)),
        pt(snap(sArcTop.x - slotKLen), sArcTop.y),
        sArcTop, 'CUT'));
    paths.push(bezierSegment(sArcTop,
        pt(snap(sArcTop.x + slotKLen), sArcTop.y),
        pt(sTopR.x, snap(sTopR.y + dir * slotKLen)),
        sTopR, 'CUT'));
    paths.push(line(sTopR, sR, 'CUT'));

    annotations.push({ point: pt(xMid, yBase), text: 'Chân rãnh (yBase)', anchor: 'middle', baseline: 'hanging' });
    annotations.push({ point: pt(xMid, sTopY), text: 'Đỉnh rãnh (slotH)', anchor: 'middle', baseline: 'bottom' });

    return { paths, holes, annotations };
}
