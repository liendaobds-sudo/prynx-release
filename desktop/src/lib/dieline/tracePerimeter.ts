import { Point2D, PathSegment } from './types';

function ptDistSq(p1: Point2D, p2: Point2D) {
    return (p1.x - p2.x) * (p1.x - p2.x) + (p1.y - p2.y) * (p1.y - p2.y);
}

// Convert all PathSegments into small 2-point line segments (sampling beziers)
function getLineSegments(paths: PathSegment[]): [Point2D, Point2D][] {
    const result: [Point2D, Point2D][] = [];
    for (const seg of paths) {
        if (seg.type === 'bezier' && seg.controlPoints) {
            const [p0, cp1, cp2, p3] = seg.controlPoints;
            const steps = 12; // Mức độ mịn khi render curve sang 3D
            let lastPt = p0;
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const it = 1 - t;
                const x = it * it * it * p0.x + 3 * it * it * t * cp1.x + 3 * it * t * t * cp2.x + t * t * t * p3.x;
                const y = it * it * it * p0.y + 3 * it * it * t * cp1.y + 3 * it * t * t * cp2.y + t * t * t * p3.y;
                const pt = { x, y };
                result.push([lastPt, pt]);
                lastPt = pt;
            }
        } else {
            const pts = seg.points;
            for (let i = 0; i < pts.length - 1; i++) {
                result.push([pts[i], pts[i+1]]);
            }
        }
    }
    return result;
}

export function tracePerimeter(inputPaths: PathSegment[]): Point2D[] {
    if (!inputPaths || inputPaths.length === 0) return [];
    
    // Bỏ qua các đường gập (CREASE) để chỉ truy vết đường cắt ngoài cùng (CUT/BLEED)
    // Các nắp (flap) luôn có biên ngoài là đường cắt.
    let cutPaths = inputPaths.filter(p => p.tag !== 'CREASE');
    
    // Nếu không đủ đường CUT để tạo thành chu vi (ví dụ: panel đáy toàn đường CREASE)
    // thì lấy toàn bộ các đường (bao gồm cả CREASE).
    if (cutPaths.length < 3) {
        cutPaths = inputPaths;
    }
    
    // 1. Phân rã tất cả PathSegment thành các đoạn thẳng con
    const segments = getLineSegments(cutPaths);
    if (segments.length === 0) return [];

    // 2. Thuật toán nối chuỗi (Chaining Algorithm) thay thế Turf.polygonize
    // Turf.polygonize thường xuyên lỗi khi đồ thị không đóng kín tuyệt đối hoặc có sai số.
    // Vì inputPaths của dieline panel đa số chỉ chứa chu vi, ta nối chúng lại end-to-end.
    const used = new Array(segments.length).fill(false);
    const chain: Point2D[] = [segments[0][0], segments[0][1]];
    used[0] = true;
    
    let added = true;
    while(added) {
        added = false;
        const head = chain[0];
        const tail = chain[chain.length - 1];
        
        for (let i = 0; i < segments.length; i++) {
            if (used[i]) continue;
            
            const pA = segments[i][0];
            const pB = segments[i][1];
            
            // Nếu đoạn thẳng khớp với đuôi chuỗi
            if (ptDistSq(tail, pA) < 1e-4) {
                chain.push(pB); used[i] = true; added = true; break;
            } else if (ptDistSq(tail, pB) < 1e-4) {
                chain.push(pA); used[i] = true; added = true; break;
            } 
            // Nếu đoạn thẳng khớp với đầu chuỗi
            else if (ptDistSq(head, pA) < 1e-4) {
                chain.unshift(pB); used[i] = true; added = true; break;
            } else if (ptDistSq(head, pB) < 1e-4) {
                chain.unshift(pA); used[i] = true; added = true; break;
            }
        }
    }
    
    // 3. Lọc bỏ các điểm thẳng hàng (collinear points) để tối ưu Earcut của Three.js
    const optimizedCoords: Point2D[] = [];
    for (let i = 0; i < chain.length; i++) {
        const prev = chain[(i - 1 + chain.length) % chain.length];
        const curr = chain[i];
        const next = chain[(i + 1) % chain.length];
        
        const area = (curr.x - prev.x) * (next.y - prev.y) - (curr.y - prev.y) * (next.x - prev.x);
        // Giữ lại điểm đầu và cuối, và các điểm tạo góc bẻ
        if (Math.abs(area) > 1e-4 || i === 0 || i === chain.length - 1) {
            optimizedCoords.push(curr);
        }
    }

    return optimizedCoords.length >= 3 ? optimizedCoords : chain;
}
