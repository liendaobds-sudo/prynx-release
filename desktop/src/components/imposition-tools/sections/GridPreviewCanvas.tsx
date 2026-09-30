import React, { useEffect, useRef } from "react";
import type { CutBorderConfig } from "../types";
import {
  resolveCellDirectionDegrees,
  resolveTrapezoidPreviewRatios,
  type CellDirectionDegrees,
} from "./gridPreviewHelpers";

export const CANVAS_BLOCK_COLORS = [
  { fill: "rgba(99, 102, 241, 0.20)", stroke: "rgba(99, 102, 241, 0.7)", text: "#4f46e5" },
  { fill: "rgba(16, 185, 129, 0.20)", stroke: "rgba(16, 185, 129, 0.7)", text: "#059669" },
  { fill: "rgba(245, 158, 11, 0.20)", stroke: "rgba(245, 158, 11, 0.7)", text: "#d97706" },
  { fill: "rgba(236, 72, 153, 0.20)", stroke: "rgba(236, 72, 153, 0.7)", text: "#db2777" },
  { fill: "rgba(139, 92, 246, 0.20)", stroke: "rgba(139, 92, 246, 0.7)", text: "#7c3aed" },
  { fill: "rgba(6, 182, 212, 0.20)", stroke: "rgba(6, 182, 212, 0.7)", text: "#0891b2" },
  { fill: "rgba(244, 63, 94, 0.20)", stroke: "rgba(244, 63, 94, 0.7)", text: "#e11d48" },
  { fill: "rgba(34, 197, 94, 0.20)", stroke: "rgba(34, 197, 94, 0.7)", text: "#16a34a" },
  { fill: "rgba(251, 146, 60, 0.20)", stroke: "rgba(251, 146, 60, 0.7)", text: "#ea580c" },
  { fill: "rgba(168, 85, 247, 0.20)", stroke: "rgba(168, 85, 247, 0.7)", text: "#9333ea" },
];

const CELL_DIRECTION_STYLES: Record<
  CellDirectionDegrees,
  { arrow: string; background: string }
> = {
  0: { arrow: "#047857", background: "rgba(209, 250, 229, 0.96)" },
  90: { arrow: "#1d4ed8", background: "rgba(219, 234, 254, 0.96)" },
  180: { arrow: "#c2410c", background: "rgba(255, 237, 213, 0.96)" },
  270: { arrow: "#7e22ce", background: "rgba(243, 232, 255, 0.96)" },
};

export interface CanvasPreviewCell {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  isRotated: boolean;
  is180: boolean;
  blockId: number;
  diePolylinesPx?: number[][][];
  idx: number;
}

export interface GridPreviewCanvasProps {
  width: number;
  height: number;
  cells: CanvasPreviewCell[];
  isMixed?: boolean;
  shapesByPage?: Record<number, string>;
  shapeParamsByPage?: Record<number, Record<string, unknown>>;
  shapeType: string;
  shapePropsParsed: Record<string, unknown> | null;
  diePolygon?: number[][] | null;
  diePolygonsByPage?: Record<string, number[][]>;
  effectiveAlternateRotation: string;
  side: "front" | "back";
  cellLabel: (blockId: number, isBack: boolean) => string | number;
  colorIndexFor: (blockId: number) => number;
  cutBorder?: CutBorderConfig;
  canUseBorder?: boolean;
  borderBleedPx?: number;
  borderThicknessPx?: number;
  isCncShortFlip?: boolean;
}

function numericShapeProp(
  props: Record<string, unknown> | null,
  key: string,
  fallback: number,
): number {
  const value = props?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export const GridPreviewCanvas: React.FC<GridPreviewCanvasProps> = ({
  width,
  height,
  cells,
  isMixed = false,
  shapesByPage,
  shapeParamsByPage,
  shapeType,
  shapePropsParsed,
  diePolygon,
  diePolygonsByPage,
  effectiveAlternateRotation,
  side,
  cellLabel,
  colorIndexFor,
  cutBorder,
  canUseBorder = false,
  borderBleedPx = 0,
  borderThicknessPx = 0.5,
  isCncShortFlip = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Hỗ trợ HiDPI / Retina sắc nét
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    ctx.save();
    if (side === "back") {
      if (isCncShortFlip) {
        ctx.translate(0, height);
        ctx.scale(1, -1);
      } else {
        ctx.translate(width, 0);
        ctx.scale(-1, 1);
      }
    }

    const showDirection = effectiveAlternateRotation !== "none";

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const color =
        CANVAS_BLOCK_COLORS[
          (Math.abs(colorIndexFor(c.blockId)) || 0) % CANVAS_BLOCK_COLORS.length
        ] || CANVAS_BLOCK_COLORS[0];
      const itemShape =
        isMixed && shapesByPage ? shapesByPage[c.blockId] || shapeType : shapeType;
      const itemShapeParams =
        isMixed && shapeParamsByPage
          ? shapeParamsByPage[c.blockId] || null
          : shapePropsParsed;
      const parsedItemParams =
        isMixed &&
        itemShapeParams &&
        typeof itemShapeParams === "object" &&
        !Array.isArray(itemShapeParams)
          ? itemShapeParams
          : shapePropsParsed;
      const itemDiePoly =
        (isMixed && diePolygonsByPage
          ? diePolygonsByPage[String(c.blockId)]
          : null) ?? diePolygon;

      ctx.save();

      // 1. Vẽ polylines hoặc shape
      if (c.diePolylinesPx && c.diePolylinesPx.length > 0) {
        ctx.fillStyle = color.fill;
        ctx.strokeStyle = color.stroke;
        ctx.lineWidth = 0.8;
        ctx.lineJoin = "round";

        for (const pl of c.diePolylinesPx) {
          if (pl.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(pl[0][0], pl[0][1]);
          for (let j = 1; j < pl.length; j++) {
            ctx.lineTo(pl[j][0], pl[j][1]);
          }
          const isClosed =
            pl.length >= 3 &&
            Math.hypot(
              pl[0][0] - pl[pl.length - 1][0],
              pl[0][1] - pl[pl.length - 1][1],
            ) <= 0.05;
          if (isClosed) {
            ctx.closePath();
            ctx.fill("evenodd");
          }
          ctx.stroke();
        }
      } else {
        // Vẽ hình học chuẩn
        const cx = c.sx + c.sw / 2;
        const cy = c.sy + c.sh / 2;
        const ow = c.isRotated ? c.sh : c.sw;
        const oh = c.isRotated ? c.sw : c.sh;
        const ox = cx - ow / 2;
        const oy = cy - oh / 2;

        let rotDeg = (c.isRotated ? 90 : 0) + (c.is180 ? 180 : 0);
        const sKey = (itemShape || "RECTANGLE").toUpperCase();

        if (parsedItemParams) {
          if (sKey === "PENTAGON") {
            if (c.isRotated) rotDeg = 90 + (c.is180 ? 0 : 180);
            if (parsedItemParams.pentagonOrientation === "down") rotDeg += 180;
          } else if (
            sKey === "HEXAGON" &&
            parsedItemParams.hexOrientation === "pointy-top"
          ) {
            rotDeg += 90;
          } else if (sKey === "TRIANGLE") {
            if (parsedItemParams.triangleApex === "down") rotDeg += 180;
            else if (parsedItemParams.triangleApex === "right") rotDeg += 90;
            else if (parsedItemParams.triangleApex === "left") rotDeg -= 90;
          } else if (sKey === "ARROW" && parsedItemParams.arrowDirection === "down") {
            rotDeg += 180;
          }
        }

        ctx.translate(cx, cy);
        if (rotDeg % 360 !== 0) {
          ctx.rotate((rotDeg * Math.PI) / 180);
        }
        ctx.translate(-cx, -cy);

        ctx.fillStyle = color.fill;
        ctx.strokeStyle = color.stroke;
        ctx.lineWidth = 0.8;
        ctx.lineJoin = "round";

        if (itemDiePoly && itemDiePoly.length >= 3) {
          ctx.beginPath();
          ctx.moveTo(ox + itemDiePoly[0][0] * ow, oy + (1 - itemDiePoly[0][1]) * oh);
          for (let k = 1; k < itemDiePoly.length; k++) {
            ctx.lineTo(
              ox + itemDiePoly[k][0] * ow,
              oy + (1 - itemDiePoly[k][1]) * oh,
            );
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else if (sKey === "CIRCLE_ELLIPSE") {
          ctx.beginPath();
          ctx.ellipse(cx, cy, ow / 2, oh / 2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (sKey === "HEXAGON") {
          const hw = ow / 2;
          ctx.beginPath();
          ctx.moveTo(cx - hw * 0.5, oy);
          ctx.lineTo(cx + hw * 0.5, oy);
          ctx.lineTo(ox + ow, cy);
          ctx.lineTo(cx + hw * 0.5, oy + oh);
          ctx.lineTo(cx - hw * 0.5, oy + oh);
          ctx.lineTo(ox, cy);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else if (sKey === "TRIANGLE") {
          ctx.beginPath();
          ctx.moveTo(cx, oy);
          ctx.lineTo(ox + ow, oy + oh);
          ctx.lineTo(ox, oy + oh);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          // Default / RECTANGLE
          ctx.fillRect(ox, oy, ow, oh);
          ctx.strokeRect(ox, oy, ow, oh);
        }
      }

      ctx.restore();

      // 2. Direction indicator
      if (showDirection) {
        const direction = resolveCellDirectionDegrees(c.isRotated, c.is180);
        const style = CELL_DIRECTION_STYLES[direction];
        const cx = c.sx + c.sw / 2;
        const cy = c.sy + c.sh / 2;
        const shortSide = Math.min(c.sw, c.sh);
        const radius = Math.min(
          9.5,
          Math.max(1, shortSide / 2 - 0.75),
          Math.max(3.5, shortSide * 0.32),
        );

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((direction * Math.PI) / 180);

        ctx.fillStyle = style.background;
        ctx.strokeStyle = style.arrow;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.strokeStyle = style.arrow;
        ctx.lineWidth = 1.65;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(0, radius * 0.57);
        ctx.lineTo(0, -radius * 0.34);
        ctx.stroke();

        ctx.fillStyle = style.arrow;
        ctx.beginPath();
        ctx.moveTo(0, -radius * 0.76);
        ctx.lineTo(-radius * 0.39, -radius * 0.12);
        ctx.lineTo(radius * 0.39, -radius * 0.12);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
      }

      // 3. Mixed Label
      if (isMixed) {
        const cx = c.sx + c.sw / 2;
        const cy = c.sy + c.sh / 2;
        const label = String(cellLabel(c.blockId, side === "back"));
        const fontSize = Math.max(Math.min(c.sw, c.sh) * 0.4, 6);

        ctx.save();
        if (side === "back") {
          // Un-flip text on back side so it reads upright
          if (isCncShortFlip) {
            ctx.translate(cx, cy);
            ctx.scale(1, -1);
            ctx.translate(-cx, -cy);
          } else {
            ctx.translate(cx, cy);
            ctx.scale(-1, 1);
            ctx.translate(-cx, -cy);
          }
        }
        ctx.font = `700 ${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = color.text;
        ctx.globalAlpha = 0.85;
        ctx.fillText(label, cx, cy);
        ctx.restore();
      }

      // 4. Cut border
      if (canUseBorder && cutBorder?.enabled) {
        ctx.save();
        ctx.strokeStyle = cutBorder.color || "#000000";
        ctx.lineWidth = borderThicknessPx;
        ctx.strokeRect(
          c.sx - borderBleedPx,
          c.sy - borderBleedPx,
          c.sw + borderBleedPx * 2,
          c.sh + borderBleedPx * 2,
        );
        ctx.restore();
      }
    }

    ctx.restore();
  }, [
    width,
    height,
    cells,
    isMixed,
    shapesByPage,
    shapeParamsByPage,
    shapeType,
    shapePropsParsed,
    diePolygon,
    diePolygonsByPage,
    effectiveAlternateRotation,
    side,
    cellLabel,
    colorIndexFor,
    cutBorder,
    canUseBorder,
    borderBleedPx,
    borderThicknessPx,
    isCncShortFlip,
  ]);

  return (
    <canvas
      ref={canvasRef}
      data-testid={`grid-cells-canvas-${side}`}
      className="absolute inset-0 pointer-events-none z-10"
      style={{ width: `${width}px`, height: `${height}px` }}
    />
  );
};
