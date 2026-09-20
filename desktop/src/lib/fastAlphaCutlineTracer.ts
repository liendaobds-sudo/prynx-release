import ClipperLib from 'clipper-lib';
import type { StickerCutlinePreview } from './stickerSheetApi';

export interface Point2D {
    x: number;
    y: number;
}

type ClipperPoint = { X: number; Y: number };
const CLIPPER_SCALE = 1000;

export interface FastAlphaTraceOptions {
    threshold?: number;
    simplifyEpsilonPx?: number;
    minAreaPx?: number;
    maxContourCount?: number;
}

const DEFAULT_OPTIONS: Required<FastAlphaTraceOptions> = {
    threshold: 10,
    simplifyEpsilonPx: 1.2,
    minAreaPx: 50,
    maxContourCount: 20,
};

/**
 * Tính diện tích có dấu (Shoelace formula).
 */
export function polygonSignedArea(points: readonly Point2D[]): number {
    let sum = 0;
    const len = points.length;
    for (let i = 0; i < len; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % len];
        sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
}

/**
 * Thuật toán Ramer-Douglas-Peucker (RDP) để giảm bớt số điểm bậc thang pixel
 * mà vẫn giữ nguyên hình dạng và các góc nhọn của tem.
 */
export function ramerDouglasPeucker(points: readonly Point2D[], epsilon: number): Point2D[] {
    if (points.length <= 2) return [...points];

    let maxDist = 0;
    let index = 0;
    const start = points[0];
    const end = points[points.length - 1];

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lenSq = dx * dx + dy * dy;

    for (let i = 1; i < points.length - 1; i += 1) {
        const p = points[i];
        let dist = 0;
        if (lenSq === 0) {
            dist = Math.hypot(p.x - start.x, p.y - start.y);
        } else {
            const t = Math.max(0, Math.min(1, ((p.x - start.x) * dx + (p.y - start.y) * dy) / lenSq));
            const projX = start.x + t * dx;
            const projY = start.y + t * dy;
            dist = Math.hypot(p.x - projX, p.y - projY);
        }
        if (dist > maxDist) {
            maxDist = dist;
            index = i;
        }
    }

    if (maxDist > epsilon) {
        const left = ramerDouglasPeucker(points.slice(0, index + 1), epsilon);
        const right = ramerDouglasPeucker(points.slice(index), epsilon);
        return left.slice(0, -1).concat(right);
    }
    return [start, end];
}

/**
 * Moore-Neighbor Border Tracing (Jacob's stopping condition).
 * Dò tìm các đường viền ngoài khép kín từ mảng pixel kênh Alpha.
 * Chạy O(perimeter), cực nhanh (< 5ms cho ảnh 1000x1000).
 */
export function traceAlphaContours(
    alpha: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    options: FastAlphaTraceOptions = {},
): Point2D[][] {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const { threshold, simplifyEpsilonPx, minAreaPx, maxContourCount } = opts;

    if (width <= 2 || height <= 2) return [];

    const DX = [0, 1, 1, 1, 0, -1, -1, -1];
    const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

    const visited = new Uint8Array(width * height);
    const contours: Point2D[][] = [];

    const isSolid = (x: number, y: number): boolean => {
        if (x < 0 || x >= width || y < 0 || y >= height) return false;
        return alpha[y * width + x] >= threshold;
    };

    for (let y = 1; y < height - 1; y += 1) {
        let inside = false;
        for (let x = 1; x < width - 1; x += 1) {
            const idx = y * width + x;
            const solid = alpha[idx] >= threshold;

            if (solid && !inside) {
                if (visited[idx] === 0) {
                    const ring: Point2D[] = [];
                    let currX = x;
                    let currY = y;
                    let enterDir = 6;

                    ring.push({ x: currX, y: currY });
                    visited[idx] = 1;

                    let startDir = (enterDir + 2) % 8;
                    let foundNext = false;
                    let nextX = currX;
                    let nextY = currY;
                    let nextDir = startDir;

                    for (let step = 0; step < 8; step += 1) {
                        const d = (startDir + step) % 8;
                        const nx = currX + DX[d];
                        const ny = currY + DY[d];
                        if (isSolid(nx, ny)) {
                            nextX = nx;
                            nextY = ny;
                            nextDir = d;
                            foundNext = true;
                            break;
                        }
                    }

                    if (foundNext) {
                        let prevX = currX;
                        let prevY = currY;
                        currX = nextX;
                        currY = nextY;
                        enterDir = (nextDir + 4) % 8;

                        const maxSteps = width * height;
                        let stepCount = 0;

                        while (!(currX === x && currY === y) && stepCount < maxSteps) {
                            stepCount += 1;
                            ring.push({ x: currX, y: currY });
                            visited[currY * width + currX] = 1;

                            startDir = (enterDir + 2) % 8;
                            let stepped = false;
                            for (let step = 0; step < 8; step += 1) {
                                const d = (startDir + step) % 8;
                                const nx = currX + DX[d];
                                const ny = currY + DY[d];
                                if (isSolid(nx, ny)) {
                                    enterDir = (d + 4) % 8;
                                    currX = nx;
                                    currY = ny;
                                    stepped = true;
                                    break;
                                }
                            }
                            if (!stepped) break;
                        }

                        if (ring.length >= 4) {
                            const area = Math.abs(polygonSignedArea(ring));
                            if (area >= minAreaPx) {
                                const simplified = ramerDouglasPeucker(ring, simplifyEpsilonPx);
                                if (simplified.length >= 3) {
                                    contours.push(simplified);
                                    if (contours.length >= maxContourCount) {
                                        return contours;
                                    }
                                }
                            }
                        }
                    }
                }
                inside = true;
            } else if (!solid && inside) {
                inside = false;
            }
        }
    }

    return contours;
}

/**
 * Co/Giãn đa giác viền bằng Clipper-lib theo kích thước mm thật.
 */
export function offsetContoursMm(
    contoursMm: readonly Point2D[][],
    offsetMm: number,
    cornerStyle: 'round' | 'preserve' | 'miter' = 'preserve',
): Point2D[][] {
    if (contoursMm.length === 0) return [];
    if (Math.abs(offsetMm) < 0.001) {
        return contoursMm.map(c => c.map(p => ({ ...p })));
    }

    const paths: ClipperPoint[][] = contoursMm
        .filter(c => c.length >= 3)
        .map(c => c.map(p => ({
            X: Math.round(p.x * CLIPPER_SCALE),
            Y: Math.round(p.y * CLIPPER_SCALE),
        })));

    if (paths.length === 0) return [];

    for (const path of paths) {
        if (!ClipperLib.Clipper.Orientation(path)) path.reverse();
    }

    const cleaned = ClipperLib.Clipper.CleanPolygons(paths, 0.002 * CLIPPER_SCALE) as ClipperPoint[][];
    const solution: ClipperPoint[][] = [];

    const joinType = cornerStyle === 'round'
        ? ClipperLib.JoinType.jtRound
        : cornerStyle === 'miter'
            ? ClipperLib.JoinType.jtMiter
            : ClipperLib.JoinType.jtRound;

    const offsetter = new ClipperLib.ClipperOffset(2, 0.25 * CLIPPER_SCALE);
    offsetter.AddPaths(cleaned, joinType, ClipperLib.EndType.etClosedPolygon);
    offsetter.Execute(solution, offsetMm * CLIPPER_SCALE);

    return solution
        .map(path => path.map(point => ({
            x: point.X / CLIPPER_SCALE,
            y: point.Y / CLIPPER_SCALE,
        })))
        .filter(ring => ring.length >= 3 && Math.abs(polygonSignedArea(ring)) > 0.01);
}

/**
 * Chuyển đổi danh sách polygon thành chuỗi SVG Path `d`.
 */
export function contoursToSvgPath(contours: readonly Point2D[][]): string {
    return contours
        .filter(c => c.length >= 3)
        .map(ring => {
            const first = ring[0];
            const rest = ring.slice(1).map(p => `L ${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ');
            return `M ${first.x.toFixed(3)} ${first.y.toFixed(3)} ${rest} Z`;
        })
        .join(' ');
}

// ── Cache nội bộ cho các đa giác gốc đã trích xuất từ pixel ──
interface CachedBaseContour {
    key: string;
    contoursMm: Point2D[][];
    widthMm: number;
    heightMm: number;
    timestamp: number;
}
const _baseContourCache = new Map<string, CachedBaseContour>();
const MAX_CACHE_ENTRIES = 50;

/**
 * Trích xuất kênh Alpha từ đối tượng ImageData (RGBA 4 kênh).
 */
export function extractAlphaChannel(imageData: ImageData): Uint8Array {
    const { width, height, data } = imageData;
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i += 1) {
        alpha[i] = data[i * 4 + 3];
    }
    return alpha;
}

/**
 * Tạo Preview đường bế cục bộ tức thì (< 20ms) từ kênh Alpha và khổ vật lý mm.
 */
export function buildInstantAlphaCutlinePreview(input: {
    pageNumber: number;
    pageWidthMm: number;
    pageHeightMm: number;
    alphaData: Uint8Array | Uint8ClampedArray;
    bitmapWidth: number;
    bitmapHeight: number;
    offsetMm: number;
    cornerStyle?: 'round' | 'preserve' | 'miter';
    cacheKey?: string;
}): StickerCutlinePreview | null {
    const {
        pageNumber,
        pageWidthMm,
        pageHeightMm,
        alphaData,
        bitmapWidth,
        bitmapHeight,
        offsetMm,
        cornerStyle = 'preserve',
        cacheKey,
    } = input;

    if (pageWidthMm <= 0 || pageHeightMm <= 0 || bitmapWidth <= 0 || bitmapHeight <= 0) {
        return null;
    }

    let baseContoursMm: Point2D[][] | null = null;

    if (cacheKey && _baseContourCache.has(cacheKey)) {
        const entry = _baseContourCache.get(cacheKey)!;
        if (Math.abs(entry.widthMm - pageWidthMm) < 0.1 && Math.abs(entry.heightMm - pageHeightMm) < 0.1) {
            baseContoursMm = entry.contoursMm;
        }
    }

    if (!baseContoursMm) {
        const rawContoursPx = traceAlphaContours(alphaData, bitmapWidth, bitmapHeight);
        if (rawContoursPx.length === 0) return null;

        const scaleX = pageWidthMm / bitmapWidth;
        const scaleY = pageHeightMm / bitmapHeight;

        baseContoursMm = rawContoursPx.map(contour =>
            contour.map(p => ({
                x: p.x * scaleX,
                y: p.y * scaleY,
            }))
        );

        if (cacheKey) {
            if (_baseContourCache.size >= MAX_CACHE_ENTRIES) {
                const oldest = [..._baseContourCache.entries()]
                    .sort(([, a], [, b]) => a.timestamp - b.timestamp)[0];
                if (oldest) _baseContourCache.delete(oldest[0]);
            }
            _baseContourCache.set(cacheKey, {
                key: cacheKey,
                contoursMm: baseContoursMm,
                widthMm: pageWidthMm,
                heightMm: pageHeightMm,
                timestamp: Date.now(),
            });
        }
    }

    const finalContoursMm = offsetContoursMm(baseContoursMm, offsetMm, cornerStyle);
    if (finalContoursMm.length === 0) return null;

    const d = contoursToSvgPath(finalContoursMm);
    if (!d) return null;

    const segmentCount = finalContoursMm.reduce((acc, c) => acc + c.length, 0);

    return {
        page_number: pageNumber,
        mask_revision: 1,
        preview_width_px: pageWidthMm,
        preview_height_px: pageHeightMm,
        paths: [{
            instance_id: 1,
            d,
            segment_count: segmentCount,
        }],
        fingerprint: `fast-alpha-${pageNumber}-${offsetMm}-${cornerStyle}`,
        segment_count: segmentCount,
    };
}
