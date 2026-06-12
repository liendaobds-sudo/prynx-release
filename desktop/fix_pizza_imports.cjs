const fs = require('fs');
let content = fs.readFileSync('src/lib/dieline/PizzaBox.ts', 'utf8');

// 1. Restore imports if they are missing
const missingImports = `import {
    pt,
    line,
    snap,
    filletBezier,
    computeBoundingBox,
    arcToBezier,
} from './utils';

import {
    PIZZA_SLOT_OFFSET_MM,
    PIZZA_SLOT_LENGTH_RATIO,
    PIZZA_FAN_FILLET_RATIO,
    PIZZA_FAN_FILLET_MAX,
    PIZZA_LID_FLAP_INSET_RATIO,
    PIZZA_DUST_SKEW_RATIO,
} from './constants';

function getOutlinePoints(paths: PathSegment[]): Point2D[] {
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
}

/**`;

if (!content.includes("from './utils'")) {
    content = content.replace(/\/\*\*/, missingImports);
} else {
    // If it DOES have imports, just insert getOutlinePoints before /** if it doesn't exist
    if (!content.includes('function getOutlinePoints')) {
        content = content.replace(/\/\*\*/, `
function getOutlinePoints(paths: PathSegment[]): Point2D[] {
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
}

/**`);
    }
}

// Remove any inner getOutlinePoints
content = content.replace(/function getOutlinePoints\(paths: PathSegment\[\]\)[\s\S]*?return pts;\n\s*\}\n/g, '');
// Re-insert the global one (the above replace removes all of them, so we insert it back at the top)
content = content.replace(/\/\*\*/, `
function getOutlinePoints(paths: PathSegment[]): Point2D[] {
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
}

/**`);

fs.writeFileSync('src/lib/dieline/PizzaBox.ts', content);
console.log('Fixed imports and getOutlinePoints hoisting!');
