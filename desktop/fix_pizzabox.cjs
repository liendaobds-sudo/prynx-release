const fs = require('fs');
let content = fs.readFileSync('src/lib/dieline/PizzaBox.ts', 'utf8');

const helper = `
    const getOutlinePoints = (paths: PathSegment[]) => {
        const pts: Point2D[] = [];
        for (const p of paths.filter(x => x.tag === 'CUT')) {
            if (p.type === 'bezier' && p.controlPoints) {
                const [p0, cp1, cp2, p3] = p.controlPoints;
                const steps = 12;
                for (let i = 0; i < steps; i++) {
                    const t = i / steps;
                    const it = 1 - t;
                    const x = it * it * it * p0.x + 3 * it * it * t * cp1.x + 3 * it * t * t * cp2.x + t * t * t * p3.x;
                    const y = it * it * it * p0.y + 3 * it * it * t * cp1.y + 3 * it * t * t * cp2.y + t * t * t * p3.y;
                    pts.push(pt(x, y));
                }
            } else {
                pts.push(p.points[0]);
            }
        }
        return pts;
    };

    // ============================================================
    // 5. TẠO DANH SÁCH PANELS (CÁC MẶT PHẲNG 3D)`;

content = content.replace(/\/\/ ============================================================\r?\n\s*\/\/ 5\. TẠO DANH SÁCH PANELS \(CÁC MẶT PHẲNG 3D\)/, helper);

// 1. Bottom
content = content.replace(/name: 'bottom', label: 'Đáy', paths: bottomPaths,\s*parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1,/,
`name: 'bottom', label: 'Đáy', paths: bottomPaths,
        parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1,
        outline: [pt(0, 0), pt(L, 0), pt(L, W), pt(0, W)],`);

// 2. Front
content = content.replace(/name: 'front', label: 'Vách trước', paths: frontPaths,\s*parent: 'bottom', pivotEdge: \[pt\(xFrontL, 0\), pt\(xFrontR, 0\)\],\s*foldAngle: 90, foldDirection: 1,/,
`name: 'front', label: 'Vách trước', paths: frontPaths,
        parent: 'bottom', pivotEdge: [pt(xFrontL, 0), pt(xFrontR, 0)],
        foldAngle: -90, foldDirection: 1,
        outline: [pt(xFrontL, 0), pt(xFrontL, snap(-D)), pt(xFrontR, snap(-D)), pt(xFrontR, 0)],`);

// 3. Back
content = content.replace(/name: 'back', label: 'Vách sau', paths: backPaths,\s*parent: 'bottom', pivotEdge: \[pt\(xFrontL, W\), pt\(xFrontR, W\)\],\s*foldAngle: -90, foldDirection: -1,/,
`name: 'back', label: 'Vách sau', paths: backPaths,
        parent: 'bottom', pivotEdge: [pt(xFrontL, W), pt(xFrontR, W)],
        foldAngle: 90, foldDirection: 1,
        outline: [pt(xFrontL, W), pt(xFrontR, W), pt(xFrontR, snap(W + D)), pt(xFrontL, snap(W + D))],`);

// 4. Lid
content = content.replace(/name: 'lid', label: 'Nắp chính', paths: lidPaths,\s*parent: 'back', pivotEdge: \[pt\(xLidL, yLidBot\), pt\(xLidR, yLidBot\)\],\s*foldAngle: -90, foldDirection: -1,/,
`name: 'lid', label: 'Nắp chính', paths: lidPaths,
        parent: 'back', pivotEdge: [pt(xLidL, yLidBot), pt(xLidR, yLidBot)],
        foldAngle: 90, foldDirection: 1,
        outline: [pt(xLidL, yLidBot), pt(xLidR, yLidBot), pt(xLidR, yLidTop), pt(xLidL, yLidTop)],`);

// 5. Secondary Lid
content = content.replace(/name: 'secondary_lid', label: 'Nắp phụ', paths: secPaths,\s*parent: 'lid',\s*\/\/ FIX: pivot tại crease thực \(ySecBot = yLidTop\), không phải yTabTop\s*pivotEdge: \[pt\(0, ySecBot\), pt\(L, ySecBot\)\],\s*foldAngle: -90, foldDirection: -1,/,
`name: 'secondary_lid', label: 'Nắp phụ', paths: secPaths,
            parent: 'lid',
            pivotEdge: [pt(0, ySecBot), pt(L, ySecBot)],
            foldAngle: 90, foldDirection: 1,
            outline: [pt(0, ySecBot), pt(L, ySecBot), pt(L, yTabTop), pt(snap(L - taperX), ySecTop), pt(snap(taperX), ySecTop), pt(0, yTabTop)],`);

// Sec Tab Right
content = content.replace(/name: 'sec_tab_right', label: 'Tai quạt phải', paths: tabSegs,\s*parent: 'secondary_lid',\s*pivotEdge: \[pt\(cx, cy\), pt\(cx, snap\(cy \+ tabR\)\)\],\s*foldAngle: -90, foldDirection: -1,/,
`name: 'sec_tab_right', label: 'Tai quạt phải', paths: tabSegs,
                parent: 'secondary_lid',
                pivotEdge: [pt(cx, cy), pt(cx, snap(cy + tabR))],
                foldAngle: -90, foldDirection: 1,
                outline: [pt(L, ySecBot), pt(L, snap(ySecBot + tabR)), ...getOutlinePoints(tabSegs)],`);
// wait, sec_tab_right original foldAngle is what? -90, -1 or 90, 1?
// Let's check original. In original PizzaBox.ts, sec_tab_right has `foldAngle: 90, foldDirection: 1,`
// Sec Tab Right (Original was 90, 1)
content = content.replace(/name: 'sec_tab_right', label: 'Tai quạt phải', paths: tabSegs,\s*parent: 'secondary_lid',\s*pivotEdge: \[pt\(cx, cy\), pt\(cx, snap\(cy \+ tabR\)\)\],\s*foldAngle: 90, foldDirection: 1,/,
`name: 'sec_tab_right', label: 'Tai quạt phải', paths: tabSegs,
                parent: 'secondary_lid',
                pivotEdge: [pt(cx, cy), pt(cx, snap(cy + tabR))],
                foldAngle: -90, foldDirection: 1,
                outline: [pt(L, ySecBot), pt(L, snap(ySecBot + tabR)), ...getOutlinePoints(tabSegs)],`);

// Sec Tab Left (Original was -90, -1)
content = content.replace(/name: 'sec_tab_left', label: 'Tai quạt trái', paths: tabSegs,\s*parent: 'secondary_lid',\s*pivotEdge: \[pt\(cx, cy\), pt\(cx, snap\(cy \+ tabR\)\)\],\s*foldAngle: -90, foldDirection: -1,/,
`name: 'sec_tab_left', label: 'Tai quạt trái', paths: tabSegs,
                parent: 'secondary_lid',
                pivotEdge: [pt(cx, cy), pt(cx, snap(cy + tabR))],
                foldAngle: 90, foldDirection: 1,
                outline: [pt(0, ySecBot), pt(0, snap(ySecBot + tabR)), ...getOutlinePoints(tabSegs)],`);

// Dust Flaps
content = content.replace(/name: 'dust_front_left', label: 'Tai trước‑trái', paths: dfFL,\s*parent: 'front', pivotEdge: \[pt\(xFrontL, snap\(-D\)\), pt\(xFrontL, 0\)\],\s*foldAngle: 90, foldDirection: 1,/,
`name: 'dust_front_left', label: 'Tai trước‑trái', paths: dfFL,
        parent: 'front', pivotEdge: [pt(xFrontL, snap(-D)), pt(xFrontL, 0)],
        foldAngle: 90, foldDirection: 1,
        outline: [pt(xFrontL, 0), pt(xFrontL, snap(-D)), ...getOutlinePoints(dfFL)],`);

content = content.replace(/name: 'dust_front_right', label: 'Tai trước‑phải', paths: dfFR,\s*parent: 'front', pivotEdge: \[pt\(xFrontR, snap\(-D\)\), pt\(xFrontR, 0\)\],\s*foldAngle: -90, foldDirection: -1,/,
`name: 'dust_front_right', label: 'Tai trước‑phải', paths: dfFR,
        parent: 'front', pivotEdge: [pt(xFrontR, snap(-D)), pt(xFrontR, 0)],
        foldAngle: -90, foldDirection: 1,
        outline: [pt(xFrontR, 0), pt(xFrontR, snap(-D)), ...getOutlinePoints(dfFR)],`);

content = content.replace(/name: 'dust_back_left', label: 'Tai sau‑trái', paths: dfBL,\s*parent: 'back', pivotEdge: \[pt\(xFrontL, W\), pt\(xFrontL, snap\(W \+ D\)\)\],\s*foldAngle: 90, foldDirection: 1,/,
`name: 'dust_back_left', label: 'Tai sau‑trái', paths: dfBL,
        parent: 'back', pivotEdge: [pt(xFrontL, W), pt(xFrontL, snap(W + D))],
        foldAngle: 90, foldDirection: 1,
        outline: [pt(xFrontL, W), pt(xFrontL, snap(W + D)), ...getOutlinePoints(dfBL)],`);

content = content.replace(/name: 'dust_back_right', label: 'Tai sau‑phải', paths: dfBR,\s*parent: 'back', pivotEdge: \[pt\(xFrontR, W\), pt\(xFrontR, snap\(W \+ D\)\)\],\s*foldAngle: -90, foldDirection: -1,/,
`name: 'dust_back_right', label: 'Tai sau‑phải', paths: dfBR,
        parent: 'back', pivotEdge: [pt(xFrontR, W), pt(xFrontR, snap(W + D))],
        foldAngle: -90, foldDirection: 1,
        outline: [pt(xFrontR, W), pt(xFrontR, snap(W + D)), ...getOutlinePoints(dfBR)],`);

content = content.replace(/name: 'dust_lid_left', label: 'Tai nắp‑trái', paths: dfLL,\s*parent: 'lid', pivotEdge: \[pt\(xLidL, yLidBot\), pt\(xLidL, yLidTop\)\],\s*foldAngle: 90, foldDirection: 1,/,
`name: 'dust_lid_left', label: 'Tai nắp‑trái', paths: dfLL,
            parent: 'lid', pivotEdge: [pt(xLidL, yLidBot), pt(xLidL, yLidTop)],
            foldAngle: 90, foldDirection: 1,
            outline: [pt(xLidL, yLidBot), pt(xLidL, yLidTop), ...getOutlinePoints(dfLL)],`);

content = content.replace(/name: 'dust_lid_right', label: 'Tai nắp‑phải', paths: dfLR,\s*parent: 'lid', pivotEdge: \[pt\(xLidR, yLidBot\), pt\(xLidR, yLidTop\)\],\s*foldAngle: -90, foldDirection: -1,/,
`name: 'dust_lid_right', label: 'Tai nắp‑phải', paths: dfLR,
            parent: 'lid', pivotEdge: [pt(xLidR, yLidBot), pt(xLidR, yLidTop)],
            foldAngle: -90, foldDirection: 1,
            outline: [pt(xLidR, yLidBot), pt(xLidR, yLidTop), ...getOutlinePoints(dfLR)],`);

content = content.replace(/name: 'side_left', label: 'Hông trái', paths: swLeftPaths,\s*parent: 'bottom', pivotEdge: \[pt\(0, 0\), pt\(0, W\)\],\s*foldAngle: 90, foldDirection: 1,/,
`name: 'side_left', label: 'Hông trái', paths: swLeftPaths,
        parent: 'bottom', pivotEdge: [pt(0, 0), pt(0, W)],
        foldAngle: 90, foldDirection: 1,
        outline: [pt(0, 0), pt(xFrontL, 0), ...getOutlinePoints(swLeftPaths), pt(xFrontL, W), pt(0, W)],`);

content = content.replace(/name: 'side_right', label: 'Hông phải', paths: swRightPaths,\s*parent: 'bottom', pivotEdge: \[pt\(L, 0\), pt\(L, W\)\],\s*foldAngle: -90, foldDirection: -1,/,
`name: 'side_right', label: 'Hông phải', paths: swRightPaths,
        parent: 'bottom', pivotEdge: [pt(L, 0), pt(L, W)],
        foldAngle: -90, foldDirection: 1,
        outline: [pt(L, 0), pt(xFrontR, 0), ...getOutlinePoints(swRightPaths), pt(xFrontR, W), pt(L, W)],`);

fs.writeFileSync('src/lib/dieline/PizzaBox.ts', content);
console.log('Successfully re-applied all fixes to PizzaBox.ts!');
