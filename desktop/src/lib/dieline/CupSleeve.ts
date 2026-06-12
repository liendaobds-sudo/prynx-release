// ============================================================
// CupSleeve — Khuôn bọc ly (Cup Sleeve / Coffee Sleeve)
//
// EXACT CLONE of calculateCupSleeve from useCupSleeveTool.ts
// Same math, same arc approximation, same rotation.
// Only difference: output is DielineModel (PathSegment/Panel)
// instead of SVG pathData strings.
//
// Input (mm): cupD1, cupD2, cupH, G, cupCoverage
// Original used cm — we convert mm→cm internally.
// ============================================================

import {
    BoxParams, DielineModel, PathSegment, Panel, Point2D,
} from './types';
import { computeBoundingBox } from './utils';

// ── Helpers — EXACT CLONE from useCupSleeveTool.ts ──────────

function rad2deg(r: number): number { return r * 180 / Math.PI; }
function deg2rad(d: number): number { return d * Math.PI / 180; }

interface ArcPathPoint {
    anchor: [number, number];
    leftHandle: [number, number];
    rightHandle: [number, number];
}

/** Exact clone of getArcPoints from useCupSleeveTool.ts */
function getArcPoints(
    center: [number, number],
    radius: number,
    startAngleDeg: number,
    endAngleDeg: number
): ArcPathPoint[] {
    const startAngle = deg2rad(startAngleDeg);
    const endAngle = deg2rad(endAngleDeg);
    const sweepAngle = endAngle - startAngle;

    const p1: [number, number] = [
        center[0] + radius * Math.cos(startAngle),
        center[1] + radius * Math.sin(startAngle)
    ];
    const p2: [number, number] = [
        center[0] + radius * Math.cos(endAngle),
        center[1] + radius * Math.sin(endAngle)
    ];

    const halfAngle = Math.abs(sweepAngle) / 2;
    const controlLength = (4.0 / 3.0) * radius * Math.sin(halfAngle) / (1 + Math.cos(halfAngle));

    const h1: [number, number] = [
        p1[0] - controlLength * Math.sin(startAngle) * (sweepAngle > 0 ? 1 : -1),
        p1[1] + controlLength * Math.cos(startAngle) * (sweepAngle > 0 ? 1 : -1)
    ];
    const h2: [number, number] = [
        p2[0] + controlLength * Math.sin(endAngle) * (sweepAngle > 0 ? 1 : -1),
        p2[1] - controlLength * Math.cos(endAngle) * (sweepAngle > 0 ? 1 : -1)
    ];

    return [
        { anchor: p1, leftHandle: p1, rightHandle: h1 },
        { anchor: p2, leftHandle: h2, rightHandle: p2 }
    ];
}

// ── Geometry helpers — giữ nguyên logic gốc ─────────────────

function pt(x: number, y: number): Point2D { return { x, y }; }

/**
 * Rotation for canvas coordinate system.
 * Original tool uses [y, -x] for SVG (Y-down).
 * Canvas renders with scale(s, -s) (Y-up), so we use [y, x]
 * to produce the same visual output.
 */
function rot(x: number, y: number): Point2D {
    return pt(y, x);
}

function makeLine(a: Point2D, b: Point2D, tag: 'CUT' | 'CREASE'): PathSegment {
    return { points: [a, b], tag, type: 'line' };
}

/**
 * Tạo bezier segment.
 * FIX: points[] chứa TẤT CẢ 4 control points (không chỉ 2 endpoint)
 * để PathRenderer nhận diện đúng type='bezier' (không bị fallback thành <line>)
 * và computeBoundingBox tính đúng BB từ control points.
 */
function makeBezier(
    p0: Point2D, cp1: Point2D, cp2: Point2D, p3: Point2D, tag: 'CUT' | 'CREASE'
): PathSegment {
    return {
        points: [p0, cp1, cp2, p3],
        tag,
        type: 'bezier',
        controlPoints: [p0, cp1, cp2, p3],
    };
}

// ── Main Generator ──────────────────────────────────────────

export function generateCupSleeve(params: BoxParams): DielineModel {
    const { cupD1, cupD2, cupH, cupCoverage, cupHeightType, cupFlapPosition, G } = params;

    // Convert mm → cm (original algorithm works in cm)
    const smallDiameter = cupD1 / 10;
    const largeDiameter = cupD2 / 10;
    const height = cupH / 10;
    const coverage = Math.max(10, Math.min(110, cupCoverage));
    const flapWidth = G / 10;

    // Validate
    const d1Valid = Math.max(0.1, smallDiameter);
    const d2Valid = Math.max(d1Valid + 0.1, largeDiameter);
    const hValid = Math.max(0.1, height);

    // ── Same math as original calculateCupSleeve ──

    // Calculate slant height — exact clone from useCupSleeveTool.ts
    const baseHalf = (d2Valid - d1Valid) / 2;
    let slantHeight: number;
    if (cupHeightType === 'slant') {
        slantHeight = hValid;
    } else {
        // vertical height → convert to slant height
        slantHeight = Math.sqrt(hValid * hValid + baseHalf * baseHalf);
    }

    // Radii (cm)
    const r1Cm = (d1Valid * slantHeight) / (d2Valid - d1Valid);
    const r2Cm = r1Cm + slantHeight;

    // Arc angle (degrees) — same formula as original
    const fullCircleTheta = (Math.PI * d1Valid) / r1Cm;
    const thetaDeg = rad2deg(fullCircleTheta * (coverage / 100));

    // Convert to mm for PathSegment coordinates
    const SCALE = 10; // cm → mm
    const r1 = r1Cm * SCALE;
    const r2 = r2Cm * SCALE;

    // Arc angles: symmetric around 0 degrees
    const startAngle = -thetaDeg / 2;
    const endAngle = thetaDeg / 2;

    const outerArc = getArcPoints([0, 0], r2, startAngle, endAngle);
    const innerArc = getArcPoints([0, 0], r1, startAngle, endAngle);

    // ── Build PathSegments (with rotation, same as original) ──

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    const slantMm = slantHeight * SCALE;
    // hasFlapAllowed — same logic as original: flapPosition !== 'none' && coverage >= 100
    const hasFlapAllowed = cupFlapPosition !== 'none' && coverage >= 100;

    if (hasFlapAllowed) {
        const flapHeightMm = flapWidth * SCALE;
        const flapLen = Math.max(0.1 * SCALE, slantMm - 1.0 * SCALE);

        if (cupFlapPosition === 'right') {
            // ── Flap RIGHT — exact clone from useCupSleeveTool.ts lines 150-174 ──
            const pL2 = outerArc[1].anchor;
            const pS2 = innerArc[1].anchor;

            const edgeVec = { x: pL2[0] - pS2[0], y: pL2[1] - pS2[1] };
            const edgeLen = Math.sqrt(edgeVec.x * edgeVec.x + edgeVec.y * edgeVec.y);
            const edgeVecUnit = { x: edgeVec.x / edgeLen, y: edgeVec.y / edgeLen };
            const perpVecUnit = { x: -edgeVecUnit.y, y: edgeVecUnit.x };

            const M1 = { x: (pS2[0] + pL2[0]) / 2, y: (pS2[1] + pL2[1]) / 2 };
            const M2 = { x: M1.x + perpVecUnit.x * flapHeightMm, y: M1.y + perpVecUnit.y * flapHeightMm };

            const flapStart = { x: M2.x - edgeVecUnit.x * (flapLen / 2), y: M2.y - edgeVecUnit.y * (flapLen / 2) };
            const flapEnd = { x: M2.x + edgeVecUnit.x * (flapLen / 2), y: M2.y + edgeVecUnit.y * (flapLen / 2) };

            // Apply rotation
            const rOuterStart = rot(outerArc[0].anchor[0], outerArc[0].anchor[1]);
            const rOuterH1 = rot(outerArc[0].rightHandle[0], outerArc[0].rightHandle[1]);
            const rOuterH2 = rot(outerArc[1].leftHandle[0], outerArc[1].leftHandle[1]);
            const rOuterEnd = rot(outerArc[1].anchor[0], outerArc[1].anchor[1]);

            const rPL2 = rot(pL2[0], pL2[1]);
            const rFlapEnd = rot(flapEnd.x, flapEnd.y);
            const rFlapStart = rot(flapStart.x, flapStart.y);
            const rPS2 = rot(pS2[0], pS2[1]);

            const rInnerH2 = rot(innerArc[1].leftHandle[0], innerArc[1].leftHandle[1]);
            const rInnerH1 = rot(innerArc[0].rightHandle[0], innerArc[0].rightHandle[1]);
            const rInnerStart = rot(innerArc[0].anchor[0], innerArc[0].anchor[1]);

            const outerBezier = makeBezier(rOuterStart, rOuterH1, rOuterH2, rOuterEnd, 'CUT');
            const lineToFlap = makeLine(rPL2, rFlapEnd, 'CUT');
            const flapTop = makeLine(rFlapEnd, rFlapStart, 'CUT');
            const flapBack = makeLine(rFlapStart, rPS2, 'CUT');
            const innerBezier = makeBezier(rPS2, rInnerH2, rInnerH1, rInnerStart, 'CUT');
            const closeLine = makeLine(rInnerStart, rOuterStart, 'CUT');
            const creaseLine = makeLine(rPS2, rPL2, 'CREASE');

            const bodyPaths = [outerBezier, makeLine(rOuterEnd, rPS2, 'CUT'), innerBezier, closeLine];
            allPaths.push(outerBezier, lineToFlap, flapTop, flapBack, innerBezier, closeLine, creaseLine);

            panels.push({
                name: 'body', label: 'Thân bọc ly', paths: bodyPaths,
                parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1,
            });
            panels.push({
                name: 'glue_flap', label: 'Mí dán keo',
                paths: [lineToFlap, flapTop, flapBack],
                parent: 'body', pivotEdge: [rPL2, rPS2], foldAngle: -90, foldDirection: -1,
            });

        } else if (cupFlapPosition === 'left') {
            // ── Flap LEFT — exact clone from useCupSleeveTool.ts lines 176-200 ──
            const pL1 = outerArc[0].anchor;
            const pS1 = innerArc[0].anchor;

            const edgeVec = { x: pL1[0] - pS1[0], y: pL1[1] - pS1[1] };
            const edgeLen = Math.sqrt(edgeVec.x * edgeVec.x + edgeVec.y * edgeVec.y);
            const edgeVecUnit = { x: edgeVec.x / edgeLen, y: edgeVec.y / edgeLen };
            const perpVecUnit = { x: edgeVecUnit.y, y: -edgeVecUnit.x };

            const M1 = { x: (pS1[0] + pL1[0]) / 2, y: (pS1[1] + pL1[1]) / 2 };
            const M2 = { x: M1.x + perpVecUnit.x * flapHeightMm, y: M1.y + perpVecUnit.y * flapHeightMm };

            const flapStart = { x: M2.x - edgeVecUnit.x * (flapLen / 2), y: M2.y - edgeVecUnit.y * (flapLen / 2) };
            const flapEnd = { x: M2.x + edgeVecUnit.x * (flapLen / 2), y: M2.y + edgeVecUnit.y * (flapLen / 2) };

            // Apply rotation
            const rOuterStart = rot(outerArc[0].anchor[0], outerArc[0].anchor[1]);
            const rOuterH1 = rot(outerArc[0].rightHandle[0], outerArc[0].rightHandle[1]);
            const rOuterH2 = rot(outerArc[1].leftHandle[0], outerArc[1].leftHandle[1]);
            const rOuterEnd = rot(outerArc[1].anchor[0], outerArc[1].anchor[1]);

            const rPL1 = rot(pL1[0], pL1[1]);
            const rFlapStart = rot(flapStart.x, flapStart.y);
            const rFlapEnd = rot(flapEnd.x, flapEnd.y);
            const rPS1 = rot(pS1[0], pS1[1]);

            const rInnerEnd = rot(innerArc[1].anchor[0], innerArc[1].anchor[1]);
            const rInnerH2 = rot(innerArc[1].leftHandle[0], innerArc[1].leftHandle[1]);
            const rInnerH1 = rot(innerArc[0].rightHandle[0], innerArc[0].rightHandle[1]);
            const rInnerStart = rot(innerArc[0].anchor[0], innerArc[0].anchor[1]);

            // Path order: flapStart → flapEnd → pL1 → outerArc → innerArc(reverse) → pS1
            const flapStartLine = makeLine(rFlapStart, rFlapEnd, 'CUT');
            const flapToEdge = makeLine(rFlapEnd, rPL1, 'CUT');
            const outerBezier = makeBezier(rOuterStart, rOuterH1, rOuterH2, rOuterEnd, 'CUT');
            const rightEdge = makeLine(rOuterEnd, rInnerEnd, 'CUT');
            const innerBezier = makeBezier(rInnerEnd, rInnerH2, rInnerH1, rInnerStart, 'CUT');
            const backToFlap = makeLine(rPS1, rFlapStart, 'CUT');
            const creaseLine = makeLine(rPS1, rPL1, 'CREASE');

            const bodyPaths = [outerBezier, rightEdge, innerBezier, makeLine(rInnerStart, rOuterStart, 'CUT')];
            allPaths.push(flapStartLine, flapToEdge, outerBezier, rightEdge, innerBezier, backToFlap, creaseLine);

            panels.push({
                name: 'body', label: 'Thân bọc ly', paths: bodyPaths,
                parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1,
            });
            panels.push({
                name: 'glue_flap', label: 'Mí dán keo',
                paths: [flapStartLine, flapToEdge, backToFlap],
                parent: 'body', pivotEdge: [rPL1, rPS1], foldAngle: -90, foldDirection: -1,
            });
        }

    } else {
        // No flap — same as original
        const rOuterStart = rot(outerArc[0].anchor[0], outerArc[0].anchor[1]);
        const rOuterH1 = rot(outerArc[0].rightHandle[0], outerArc[0].rightHandle[1]);
        const rOuterH2 = rot(outerArc[1].leftHandle[0], outerArc[1].leftHandle[1]);
        const rOuterEnd = rot(outerArc[1].anchor[0], outerArc[1].anchor[1]);

        const rInnerEnd = rot(innerArc[1].anchor[0], innerArc[1].anchor[1]);
        const rInnerH2 = rot(innerArc[1].leftHandle[0], innerArc[1].leftHandle[1]);
        const rInnerH1 = rot(innerArc[0].rightHandle[0], innerArc[0].rightHandle[1]);
        const rInnerStart = rot(innerArc[0].anchor[0], innerArc[0].anchor[1]);

        const outerBezier = makeBezier(rOuterStart, rOuterH1, rOuterH2, rOuterEnd, 'CUT');
        const rightEdge = makeLine(rOuterEnd, rInnerEnd, 'CUT');
        const innerBezier = makeBezier(rInnerEnd, rInnerH2, rInnerH1, rInnerStart, 'CUT');
        const leftEdge = makeLine(rInnerStart, rOuterStart, 'CUT');

        allPaths.push(outerBezier, rightEdge, innerBezier, leftEdge);

        panels.push({
            name: 'body', label: 'Thân bọc ly',
            paths: [outerBezier, rightEdge, innerBezier, leftEdge],
            parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1,
        });
    }

    // ── Bounding Box ──
    const bb = computeBoundingBox(allPaths);

    return {
        name: 'Cup Sleeve',
        standardCode: 'CUP-SLEEVE',
        description: 'Khuôn bọc ly giấy — Hình quạt cung',
        panels,
        allPaths,
        boundingBox: bb,
        params,
    };
}

