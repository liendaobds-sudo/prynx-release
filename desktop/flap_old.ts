export function buildSideTriFlapOld(
    xLeft: number, xRight: number,
    yBase: number, panelW: number, dir: 1 | -1,
    overrideH: number = 0, // 0 = auto (h1+h2), >0 = custom, clamp >= slotH+5
): PathSegment[] {
    const paths: PathSegment[] = [];
    const h1 = snap(panelW / 2);
    const h2 = snap(0.9 * h1);
    const defaultH = snap(h1 + h2);
    const slotH = snap(0.85 * h2);
    const minH = snap(slotH + 5);             // Tối thiểu = rãnh + 0.5cm
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

    // === Rnh gi (lock slot)  dọc giữa, bắt ầu từ ường nhấn ===
    const slotW = 3;                          // Rng rnh = 3mm
    const slotR = snap(slotW / 2);            // Bo trn ầu trn = bn nguyt
    const slotKLen = snap(slotR * kappa);

    const sL = pt(snap(xMid - slotW / 2), yBase);  // Gc dưi tri
    const sR = pt(snap(xMid + slotW / 2), yBase);  // Gc dưi phải
    const sTopY = snap(yBase + dir * slotH);
    const sTopL = pt(sL.x, snap(sTopY - dir * slotR));  // Bắt ầu arc tri
    const sTopR = pt(sR.x, snap(sTopY - dir * slotR));  // Bắt ầu arc phải
    const sArcTop = pt(xMid, sTopY);                     // Đnh arc

    // Vẽ rnh: dưi tri  ln  arc trn  xung  dưi phải
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

    return paths;
}