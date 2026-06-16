import React, { useEffect, useMemo, useRef, useState } from "react";
import { authenticatedFetch, getApiUrl } from "../../../lib/api";
import type { NupSettings } from "../types";

export interface GridPreviewProps {
  taskMode: string;
  isDieCut?: boolean;
  gridStrategy: NupSettings["gridStrategy"];
  splitGap?: number;
  columns: number;
  rows: number;
  gapX: number;
  gapY: number;
  sheetWidth: number; // in mm
  sheetHeight: number; // in mm
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  align: string;
  shapeType: string;
  itemW?: number;
  itemH?: number;
  targetQuantity?: number | string;
  targetQuantitiesByPage?: Record<number, number>;
  /** Tổng số trang nguồn — để N-Up vẽ preview đúng số ô thực sự lấp (mỗi trang 1 lần). */
  sourceTotalPages?: number;
  shapeParams?: string | null;
  shapesByPage?: Record<number, string>;
  shapeParamsByPage?: Record<number, any>;
  isDetectingShape?: boolean;
  pontType?: string;
  pontConfig?: any;
  onCapacityChange?: (capacity: number) => void;
  onMixedPlacedByPage?: (m: Record<number, number>) => void;
  fileId?: string;
  pageIdx?: number;
  bleed?: number; // in mm
  groupingStrategy?: string;
  clusterSizingMode?: string;
  clusterCols?: number;
  clusterRows?: number;
  clusterTileW?: number;
  clusterTileH?: number;
  tileGapX?: number;
  tileGapY?: number;
  duplexFlow?: string;
  // ── Bình Bế Rớt (CNC) ghép nhiều mẫu ──
  imposerMode?: string;
  cncTwoSided?: boolean;
  cncFlipEdge?: "long" | "short";
}

// =====================================================================
// Layout result interface (matches backend PreviewLayoutResponse)
// =====================================================================
interface BackendLayoutCell {
  x: number;
  y: number;
  width: number;
  height: number;
  isRotated: boolean;
  isRotated180: boolean;
  blockId: number;
}

interface BackendLayoutResult {
  success: boolean;
  totalItems: number;
  overallWidth: number;
  overallHeight: number;
  strategyUsed: string;
  cells: BackendLayoutCell[];
  error?: string;
  isMixedPreview?: boolean;
}

// =====================================================================
// Visual constants
// =====================================================================
const BLOCK_COLORS = [
  {
    fill: "rgba(99, 102, 241, 0.20)",
    stroke: "rgba(99, 102, 241, 0.7)",
    text: "#4f46e5",
  },
  {
    fill: "rgba(16, 185, 129, 0.20)",
    stroke: "rgba(16, 185, 129, 0.7)",
    text: "#059669",
  },
  {
    fill: "rgba(245, 158, 11, 0.20)",
    stroke: "rgba(245, 158, 11, 0.7)",
    text: "#d97706",
  },
  {
    fill: "rgba(236, 72, 153, 0.20)",
    stroke: "rgba(236, 72, 153, 0.7)",
    text: "#db2777",
  },
  {
    fill: "rgba(139, 92, 246, 0.20)",
    stroke: "rgba(139, 92, 246, 0.7)",
    text: "#7c3aed",
  },
  {
    fill: "rgba(6, 182, 212, 0.20)",
    stroke: "rgba(6, 182, 212, 0.7)",
    text: "#0891b2",
  },
  {
    fill: "rgba(244, 63, 94, 0.20)",
    stroke: "rgba(244, 63, 94, 0.7)",
    text: "#e11d48",
  },
  {
    fill: "rgba(34, 197, 94, 0.20)",
    stroke: "rgba(34, 197, 94, 0.7)",
    text: "#16a34a",
  },
  {
    fill: "rgba(251, 146, 60, 0.20)",
    stroke: "rgba(251, 146, 60, 0.7)",
    text: "#ea580c",
  },
  {
    fill: "rgba(168, 85, 247, 0.20)",
    stroke: "rgba(168, 85, 247, 0.7)",
    text: "#9333ea",
  },
];

const ROTATED180_OPACITY = 0.55;

// =====================================================================
// Debounce delay for API calls (ms)
// =====================================================================
const DEBOUNCE_MS = 250;

// =====================================================================
// Shape rendering helpers
// =====================================================================

/**
 * Render a shape outline for a single cell in SVG space.
 *
 * Inputs `sx, sy, sw, sh` are the final SVG pixel coordinates of this cell's bounding box.
 */
function renderCellShape(
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  isRotated: boolean,
  is180: boolean,
  blockId: number,
  shapeType: string,
  shapeProps: Record<string, any> | null,
  idx: number,
) {
  const color = BLOCK_COLORS[blockId % BLOCK_COLORS.length];
  const opacity = is180 && !isRotated ? ROTATED180_OPACITY : 1; // Subtle hint for 180 flip

  const cx = sx + sw / 2;
  const cy = sy + sh / 2;

  // Original unrotated dimensions
  const ow = isRotated ? sh : sw;
  const oh = isRotated ? sw : sh;

  // Top-left of the unrotated shape centered at cx, cy
  const ox = cx - ow / 2;
  const oy = cy - oh / 2;

  const shapeKey = shapeType?.toUpperCase() || "RECTANGLE";

  // Backend PDF rotation (CCW in PDF Y-up coords) appears as CW on screen (SVG Y-down):
  //   isRotated only        → PDF rotate=90  → visually 90° CW on screen → SVG rotate(90)
  //   isRotated180 only     → PDF rotate=180 → visually 180°             → SVG rotate(180)
  //   isRotated+isRotated180→ PDF rotate=270 → visually 270° CW on screen→ SVG rotate(270)
  let rotDeg = (isRotated ? 90 : 0) + (is180 ? 180 : 0);

  // PENTAGON: When isRotated=true (90° rotation), the SVG and PDF backend interpret
  // the combined is180 flip differently, causing peaks to point opposite directions.
  // Fix: invert the is180 visual for the rotated pentagon case.
  if (shapeProps) {
    if (shapeKey === "PENTAGON") {
      if (isRotated) {
        // Invert is180 effect for rotated pentagons to match renderer
        rotDeg = 90 + (is180 ? 0 : 180);
      }
      // Also apply orientation correction
      if (shapeProps.pentagonOrientation === "down") {
        rotDeg += 180;
      }
    } else if (
      shapeKey === "HEXAGON" &&
      shapeProps.hexOrientation === "pointy-top"
    ) {
      rotDeg += 90;
    } else if (shapeKey === "TRIANGLE") {
      if (shapeProps.triangleApex === "down") rotDeg += 180;
      else if (shapeProps.triangleApex === "right") rotDeg += 90;
      else if (shapeProps.triangleApex === "left") rotDeg -= 90;
    } else if (shapeKey === "ARROW" && shapeProps.arrowDirection === "down") {
      rotDeg += 180;
    }
    // Note: HAMMER/DUMBBELL bigEndFirst is already handled by the solver
    // via isRotated180 on each cell — do NOT add extra rotation here.
  }

  const transform =
    rotDeg % 360 !== 0 ? `rotate(${rotDeg}, ${cx}, ${cy})` : undefined;

  let shapeNode = null;

  switch (shapeKey) {
    case "CIRCLE_ELLIPSE": {
      shapeNode = (
        <ellipse
          cx={cx}
          cy={cy}
          rx={ow / 2}
          ry={oh / 2}
          fill={color.fill}
          stroke={color.stroke}
          strokeWidth={0.8}
        />
      );
      break;
    }

    case "HEXAGON": {
      // Base hexagon (flat-top). If hexOrientation='pointy-top', rotDeg handles it.
      const hw = ow / 2;
      const pts = [
        `${cx - hw * 0.5},${oy}`,
        `${cx + hw * 0.5},${oy}`,
        `${ox + ow},${cy}`,
        `${cx + hw * 0.5},${oy + oh}`,
        `${cx - hw * 0.5},${oy + oh}`,
        `${ox},${cy}`,
      ].join(" ");
      shapeNode = (
        <polygon
          points={pts}
          fill={color.fill}
          stroke={color.stroke}
          strokeWidth={0.8}
        />
      );
      break;
    }

    case "PENTAGON": {
      const peakH =
        shapeProps?.peakHeightRatio !== undefined
          ? shapeProps.peakHeightRatio
          : 0.25;
      // House shape pointing UP. Peak is at TOP.
      const pts = [
        `${cx},${oy}`,
        `${ox + ow},${oy + oh * peakH}`,
        `${ox + ow * 0.8},${oy + oh}`,
        `${ox + ow * 0.2},${oy + oh}`,
        `${ox},${oy + oh * peakH}`,
      ].join(" ");
      shapeNode = (
        <polygon
          points={pts}
          fill={color.fill}
          stroke={color.stroke}
          strokeWidth={0.8}
        />
      );
      break;
    }

    case "TRIANGLE": {
      // Pointing UP
      const pts = [
        `${cx},${oy}`,
        `${ox + ow},${oy + oh}`,
        `${ox},${oy + oh}`,
      ].join(" ");
      shapeNode = (
        <polygon
          points={pts}
          fill={color.fill}
          stroke={color.stroke}
          strokeWidth={0.8}
        />
      );
      break;
    }

    case "TRAPEZOID": {
      // Use precise geometric proportions from shapeProps if available
      if (shapeProps && shapeProps.longBase && shapeProps.shortBase) {
        const isH = shapeProps.isHorizontal;
        // Determine base sizes relative to bounding box
        const longRatio =
          shapeProps.longBase / (isH ? shapeProps.bbW : shapeProps.bbH);
        const shortRatio =
          shapeProps.shortBase / (isH ? shapeProps.bbW : shapeProps.bbH);

        // If it is horizontal, the parallel bases are top and bottom.
        if (isH) {
          const topW = ow * shortRatio;
          const botW = ow * longRatio;
          const leftInsetTop = (ow - topW) / 2;
          const rightInsetTop = (ow - topW) / 2;
          const leftInsetBot = (ow - botW) / 2;
          const rightInsetBot = (ow - botW) / 2;
          const pts = [
            `${ox + leftInsetTop},${oy}`,
            `${ox + ow - rightInsetTop},${oy}`,
            `${ox + ow - rightInsetBot},${oy + oh}`,
            `${ox + leftInsetBot},${oy + oh}`,
          ].join(" ");
          shapeNode = (
            <polygon
              points={pts}
              fill={color.fill}
              stroke={color.stroke}
              strokeWidth={0.8}
            />
          );
        } else {
          const leftH = oh * shortRatio;
          const rightH = oh * longRatio;
          const topInsetLeft = (oh - leftH) / 2;
          const topInsetRight = (oh - rightH) / 2;
          const botInsetLeft = (oh - leftH) / 2;
          const botInsetRight = (oh - rightH) / 2;
          const pts = [
            `${ox},${oy + topInsetLeft}`,
            `${ox + ow},${oy + topInsetRight}`,
            `${ox + ow},${oy + oh - botInsetRight}`,
            `${ox},${oy + oh - botInsetLeft}`,
          ].join(" ");
          shapeNode = (
            <polygon
              points={pts}
              fill={color.fill}
              stroke={color.stroke}
              strokeWidth={0.8}
            />
          );
        }
      } else {
        // Base: Flat top, wider bottom (horizontal trapezoid)
        const inset = ow * 0.2;
        const pts = [
          `${ox + inset},${oy}`,
          `${ox + ow - inset},${oy}`,
          `${ox + ow},${oy + oh}`,
          `${ox},${oy + oh}`,
        ].join(" ");
        shapeNode = (
          <polygon
            points={pts}
            fill={color.fill}
            stroke={color.stroke}
            strokeWidth={0.8}
          />
        );
      }
      break;
    }

    case "DUMBBELL":
    case "HAMMER": {
      const isHorizontal = ow > oh;
      const isDumbbell = shapeKey === "DUMBBELL";

      // Use actual shape proportions from classifier when available
      const waistRatio = shapeProps?.waistRatio ?? (isDumbbell ? 0.35 : 0.4);
      const bigEndFrac =
        shapeProps?.bigDAlongAxisFrac ?? (isDumbbell ? 0.3 : 0.37);

      let pts = "";
      if (isHorizontal) {
        // Horizontal: big head on LEFT, handle extends RIGHT
        const headW = ow * bigEndFrac; // length of the big head along axis
        const handleH = oh * waistRatio; // handle cross-section width
        const hTop = oy + (oh - handleH) / 2;
        const hBot = oy + (oh + handleH) / 2;

        if (isDumbbell) {
          // Both ends are big heads
          pts = [
            `${ox},${oy}`,
            `${ox + headW},${oy}`,
            `${ox + headW},${hTop}`,
            `${ox + ow - headW},${hTop}`,
            `${ox + ow - headW},${oy}`,
            `${ox + ow},${oy}`,
            `${ox + ow},${oy + oh}`,
            `${ox + ow - headW},${oy + oh}`,
            `${ox + ow - headW},${hBot}`,
            `${ox + headW},${hBot}`,
            `${ox + headW},${oy + oh}`,
            `${ox},${oy + oh}`,
          ].join(" ");
        } else {
          // Hammer: only LEFT end is big head, right is narrow handle
          pts = [
            `${ox},${oy}`,
            `${ox + headW},${oy}`,
            `${ox + headW},${hTop}`,
            `${ox + ow},${hTop}`,
            `${ox + ow},${hBot}`,
            `${ox + headW},${hBot}`,
            `${ox + headW},${oy + oh}`,
            `${ox},${oy + oh}`,
          ].join(" ");
        }
      } else {
        // Vertical: big head on TOP, handle extends DOWN
        const headH = oh * bigEndFrac;
        const handleW = ow * waistRatio;
        const hLeft = ox + (ow - handleW) / 2;
        const hRight = ox + (ow + handleW) / 2;

        if (isDumbbell) {
          pts = [
            `${ox},${oy}`,
            `${ox + ow},${oy}`,
            `${ox + ow},${oy + headH}`,
            `${hRight},${oy + headH}`,
            `${hRight},${oy + oh - headH}`,
            `${ox + ow},${oy + oh - headH}`,
            `${ox + ow},${oy + oh}`,
            `${ox},${oy + oh}`,
            `${ox},${oy + oh - headH}`,
            `${hLeft},${oy + oh - headH}`,
            `${hLeft},${oy + headH}`,
            `${ox},${oy + headH}`,
          ].join(" ");
        } else {
          pts = [
            `${ox},${oy}`,
            `${ox + ow},${oy}`,
            `${ox + ow},${oy + headH}`,
            `${hRight},${oy + headH}`,
            `${hRight},${oy + oh}`,
            `${hLeft},${oy + oh}`,
            `${hLeft},${oy + headH}`,
            `${ox},${oy + headH}`,
          ].join(" ");
        }
      }

      shapeNode = (
        <g>
          <polygon
            points={pts}
            fill={color.fill}
            stroke={color.stroke}
            strokeWidth={0.8}
            strokeLinejoin="round"
          />
          {isHorizontal ? (
            <line
              x1={cx - ow * 0.15}
              y1={cy}
              x2={cx + ow * 0.15}
              y2={cy}
              stroke={color.stroke}
              strokeWidth={1}
              opacity={0.5}
              markerEnd="url(#arrowHead)"
            />
          ) : (
            <line
              x1={cx}
              y1={cy - oh * 0.15}
              x2={cx}
              y2={cy + oh * 0.15}
              stroke={color.stroke}
              strokeWidth={1}
              opacity={0.5}
              markerEnd="url(#arrowHead)"
            />
          )}
        </g>
      );
      break;
    }

    case "PARALLELOGRAM": {
      const skew = ow * 0.2;
      const pts = `${ox + skew},${oy} ${ox + ow},${oy} ${ox + ow - skew},${oy + oh} ${ox},${oy + oh}`;
      shapeNode = (
        <polygon
          points={pts}
          fill={color.fill}
          stroke={color.stroke}
          strokeWidth={0.8}
        />
      );
      break;
    }

    case "ARROW": {
      const aw = ow * 0.35,
        ah = oh * 0.4;
      // Base arrow pointing UP
      const pts = `${cx},${oy} ${ox + ow},${oy + ah} ${ox + ow - aw},${oy + ah} ${ox + ow - aw},${oy + oh} ${ox + aw},${oy + oh} ${ox + aw},${oy + ah} ${ox},${oy + ah}`;
      shapeNode = (
        <polygon
          points={pts}
          fill={color.fill}
          stroke={color.stroke}
          strokeWidth={0.8}
        />
      );
      break;
    }

    default: {
      shapeNode = (
        <rect
          x={ox}
          y={oy}
          width={ow}
          height={oh}
          fill={color.fill}
          stroke={color.stroke}
          strokeWidth={0.8}
          rx={0.5}
          ry={0.5}
        />
      );
      break;
    }
  }

  return (
    <g key={idx} opacity={opacity} transform={transform}>
      {shapeNode}
    </g>
  );
}

// =====================================================================
// GridPreview Component
// =====================================================================
export default function GridPreview(props: GridPreviewProps) {
  const {
    taskMode,
    isDieCut,
    gridStrategy,
    splitGap = 0,
    columns,
    rows,
    gapX,
    gapY,
    sheetWidth,
    sheetHeight,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
    align,
    shapeType,
    targetQuantity,
    targetQuantitiesByPage,
    sourceTotalPages,
    itemW = 90,
    itemH = 55,
    shapeParams,
    isDetectingShape,
    shapesByPage,
    shapeParamsByPage,
    pontType,
    pontConfig,
    onCapacityChange,
    onMixedPlacedByPage,
    fileId,
    pageIdx = 0,
    bleed = 0,
    groupingStrategy,
    clusterSizingMode,
    clusterCols,
    clusterRows,
    clusterTileW,
    clusterTileH,
    tileGapX,
    tileGapY,
    duplexFlow,
    imposerMode,
    cncTwoSided,
    cncFlipEdge,
  } = props;

  const [expanded, setExpanded] = useState(false);
  const [layoutResult, setLayoutResult] = useState<BackendLayoutResult | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCapacityChangeRef = useRef(onCapacityChange);

  useEffect(() => {
    onCapacityChangeRef.current = onCapacityChange;
  }, [onCapacityChange]);
  const onMixedPlacedByPageRef = useRef(onMixedPlacedByPage);
  useEffect(() => {
    onMixedPlacedByPageRef.current = onMixedPlacedByPage;
  }, [onMixedPlacedByPage]);

  const usableW = Math.max(0, sheetWidth - marginLeft - marginRight);
  const usableH = Math.max(0, sheetHeight - marginTop - marginBottom);

  // Parse shape props if provided as JSON string
  const shapePropsParsed = useMemo(() => {
    if (!shapeParams) return null;
    try {
      return JSON.parse(shapeParams);
    } catch (e) {
      return null;
    }
  }, [shapeParams]);

  // ==========================================
  // Fetch layout from backend (debounced)
  //
  // CRITICAL: shapeParams from detect-shape API are in PDF POINTS.
  // We must convert ALL inputs to points before sending to ensure
  // unit consistency with shape_props (bodyW, smallD, etc.).
  // Then convert the response back to mm for SVG rendering.
  // ==========================================
  const MM_TO_PT = 2.83465;
  const PT_TO_MM = 1 / MM_TO_PT;

  useEffect(() => {
    // Clear any pending debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    // Don't fetch if dimensions are invalid
    if (usableW <= 0 || usableH <= 0 || itemW <= 0 || itemH <= 0) {
      setLayoutResult(null);
      return;
    }

    setIsLoading(true);

    debounceRef.current = setTimeout(async () => {
      // Abort previous in-flight request
      if (abortRef.current) {
        abortRef.current.abort();
      }
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // Convert ALL dimensions from mm → points to match shapeParams units
        const body = {
          usable_w: usableW * MM_TO_PT,
          usable_h: usableH * MM_TO_PT,
          item_w: itemW * MM_TO_PT,
          item_h: itemH * MM_TO_PT,
          gap_x: gapX * MM_TO_PT,
          gap_y: gapY * MM_TO_PT,
          strategy: gridStrategy || "optimal_auto",
          cols: columns || 0,
          rows: rows || 0,
          shape_type:
            shapeType && shapeType !== "CUSTOM" ? shapeType : "CUSTOM",
          shape_props: shapePropsParsed || {},
          pont_config: pontType && pontType !== "none" ? pontConfig : null,
          sheet_w: sheetWidth * MM_TO_PT,
          sheet_h: sheetHeight * MM_TO_PT,
          margin_left: marginLeft * MM_TO_PT,
          margin_bottom: marginBottom * MM_TO_PT,
          ...(fileId ? { file_id: fileId } : {}),
          page_idx: pageIdx,
          bleed: bleed * MM_TO_PT, // bleed in points to match nup_engine
          grouping_strategy: groupingStrategy,
          cluster_sizing_mode: clusterSizingMode,
          cluster_cols: clusterCols,
          cluster_rows: clusterRows,
          cluster_w: clusterTileW ? clusterTileW * MM_TO_PT : undefined,
          cluster_h: clusterTileH ? clusterTileH * MM_TO_PT : undefined,
          tile_gap_x: tileGapX ? tileGapX * MM_TO_PT : undefined,
          tile_gap_y: tileGapY ? tileGapY * MM_TO_PT : undefined,
          task_mode: taskMode,
          is_die_cut: isDieCut,
          split_gap: splitGap * MM_TO_PT,
          target_quantity: Number(targetQuantity) || 0,
          target_quantities_by_page: targetQuantitiesByPage || {},
          imposer_mode: imposerMode,
          cnc_two_sided: !!cncTwoSided,
          cnc_flip_edge: cncFlipEdge || "long",
        };

        const res = await authenticatedFetch(`${getApiUrl()}/imposition/preview-layout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text();
          console.error(
            "Preview layout API error:",
            res.status,
            "Payload:",
            JSON.stringify(body, null, 2),
            "Response:",
            errText,
          );
          setLayoutResult(null);
          setIsLoading(false);
          if (onCapacityChangeRef.current) onCapacityChangeRef.current(0);
          return;
        }

        const data: BackendLayoutResult = await res.json();

        // Only apply if this request wasn't aborted
        if (!controller.signal.aborted) {
          if (data.success) {
            // Convert response from points → mm for SVG rendering
            // Frontend does NOT modify rotation flags — backend is single source of truth
            const cells = data.cells.map((cell) => ({
              ...cell,
              x: cell.x * PT_TO_MM,
              y: cell.y * PT_TO_MM,
              width: cell.width * PT_TO_MM,
              height: cell.height * PT_TO_MM,
            }));

            const convertedResult: BackendLayoutResult = {
              ...data,
              overallWidth: data.overallWidth * PT_TO_MM,
              overallHeight: data.overallHeight * PT_TO_MM,
              cells,
            };
            setLayoutResult(convertedResult);
            if (onCapacityChangeRef.current)
              onCapacityChangeRef.current(convertedResult.totalItems);
            if (onMixedPlacedByPageRef.current) {
              const pbp = (data as any).placedByPage;
              if (pbp && typeof pbp === "object") {
                const m: Record<number, number> = {};
                Object.keys(pbp).forEach((k) => {
                  m[Number(k)] = pbp[k];
                });
                onMixedPlacedByPageRef.current(m);
              } else {
                onMixedPlacedByPageRef.current({});
              }
            }
          } else {
            setLayoutResult(null);
            if (onCapacityChangeRef.current) onCapacityChangeRef.current(0);
          }
          setIsLoading(false);
        }
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.error("Preview layout fetch error:", err);
          setLayoutResult(null);
          setIsLoading(false);
          if (onCapacityChangeRef.current) onCapacityChangeRef.current(0);
        }
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [
    usableW,
    usableH,
    itemW,
    itemH,
    gapX,
    gapY,
    splitGap,
    gridStrategy,
    columns,
    rows,
    shapeType,
    shapeParams,
    pontConfig,
    pontType,
    taskMode,
    sheetWidth,
    sheetHeight,
    marginLeft,
    marginBottom,
    fileId,
    pageIdx,
    bleed,
    groupingStrategy,
    clusterSizingMode,
    clusterCols,
    clusterRows,
    clusterTileW,
    clusterTileH,
    tileGapX,
    tileGapY,
    targetQuantity,
    targetQuantitiesByPage,
    imposerMode,
    cncTwoSided,
    cncFlipEdge,
  ]);

  if (sheetWidth <= 0 || sheetHeight <= 0) return null;

  // ── N-Up "Dàn nhiều mẫu": tổng con cần = SL mỗi loại × số mẫu (SL trống → lấp đầy 1 tờ).
  //    "Cần in" theo tổng con; căn giữa CHỈ khi đúng 1 tờ (nhiều tờ giữ vị trí full layout).
  const _cap = layoutResult?.totalItems ?? 0;
  const _isNupFill = !isDieCut && taskMode === "nup" && _cap > 0;
  const _qtyPerType = Number(targetQuantity) || 0;
  const _nupTotal = _isNupFill
    ? (_qtyPerType > 0 ? _qtyPerType * Math.max(1, sourceTotalPages || 1) : _cap)
    : null;

  let totalSheets = 1;
  if (layoutResult && layoutResult.totalItems > 0) {
    if (_nupTotal != null) {
      totalSheets = Math.max(1, Math.ceil(_nupTotal / layoutResult.totalItems));
    } else {
      const qty = Number(targetQuantity) || 0;
      if (qty > 0) {
        totalSheets = Math.ceil(qty / layoutResult.totalItems);
      }
    }
  }

  // ==========================================
  // SVG sizing
  // ==========================================
  const svgMaxW = expanded ? 380 : 260;
  const svgMaxH = expanded ? 260 : 160;
  const pad = 8;

  const scaleX = (svgMaxW - pad * 2) / sheetWidth;
  const scaleY = (svgMaxH - pad * 2) / sheetHeight;
  const scale = Math.min(scaleX, scaleY);

  const svgW = sheetWidth * scale + pad * 2;
  const svgH = sheetHeight * scale + pad * 2;

  // ==========================================
  // Replicate EXACT alignment logic from NupRenderer.ts
  // The renderer uses PDF coordinates (Y=0 at bottom, Y increases upward).
  // We compute the PDF-space baseX/baseY, then convert each cell to SVG.
  // ==========================================

  // All values in mm (matching preview input units).
  // The solver also receives mm, so its output cells are in mm.
  const gridW = layoutResult?.overallWidth ?? 0;
  const gridH = layoutResult?.overallHeight ?? 0;

  const alignStr = align || "center";

  // --- X alignment (same direction in both PDF and SVG) ---
  // Renderer: superBaseX = marginLeft (default=left)
  //           if 'center': marginLeft + (usableW - gridW) / 2
  //           if 'right': sheetWidth - marginRight - gridW
  let pdfBaseX = marginLeft;
  if (alignStr.includes("center"))
    pdfBaseX = marginLeft + (usableW - gridW) / 2;
  if (alignStr.includes("right")) pdfBaseX = sheetWidth - marginRight - gridW;

  // --- Y alignment (PDF: Y=0 at bottom) ---
  // Renderer: superBaseY = marginBottom (default=bottom)
  //           if 'center': marginBottom + (usableH - gridH) / 2
  //           if 'top': sheetHeight - marginTop - gridH
  let pdfBaseY = marginBottom;
  if (alignStr.includes("center"))
    pdfBaseY = marginBottom + (usableH - gridH) / 2;
  if (alignStr.includes("top")) pdfBaseY = sheetHeight - marginTop - gridH;

  // ==========================================
  // Convert each cell from PDF coords → SVG coords
  //
  // In the renderer (PDF space):
  //   visualY = gridH - cell.y - cell.height   (flip Y within grid)
  //   pdfX = pdfBaseX + cell.x
  //   pdfY = pdfBaseY + visualY                 (bottom of cell in PDF)
  //   The cell occupies pdfY to pdfY+cellH (upward in PDF)
  //
  // SVG conversion (Y flipped for entire sheet):
  //   svgX = pdfX                               (X is same direction)
  //   svgY = sheetHeight - pdfY - cell.height   (flip Y, cell top in SVG)
  //
  // Substituting:
  //   svgY = sheetHeight - (pdfBaseY + gridH - cell.y - cell.height) - cell.height
  //        = sheetHeight - pdfBaseY - gridH + cell.y + cell.height - cell.height
  //        = sheetHeight - pdfBaseY - gridH + cell.y
  // ==========================================

  const svgBaseX = pdfBaseX; // X direction is same in PDF and SVG
  const svgBaseYConst = sheetHeight - pdfBaseY - gridH; // Constant part of svgY

  // Build SVG cells with final pixel coordinates
  const svgCells = useMemo(() => {
    if (!layoutResult || !layoutResult.cells) return [];

    const isMixed = !!(layoutResult as any).isMixedPreview;

    return layoutResult.cells.map((cell, idx) => {
      let svgX_mm: number;
      let svgY_mm: number;

      if (isMixed) {
        // Bin-packing coords are already screen/SVG space (y=0 top, y↓)
        // Just center within the usable area + add margins
        const offsetX = marginLeft + (usableW - gridW) / 2;
        const offsetY = marginTop + (usableH - gridH) / 2;
        svgX_mm = offsetX + cell.x;
        svgY_mm = offsetY + cell.y;
      } else {
        // PDF coords → SVG conversion (y-flip)
        svgX_mm = svgBaseX + cell.x;
        svgY_mm = svgBaseYConst + cell.y;
      }

      return {
        sx: pad + svgX_mm * scale,
        sy: pad + svgY_mm * scale,
        sw: cell.width * scale,
        sh: cell.height * scale,
        isRotated: !!cell.isRotated,
        is180: !!cell.isRotated180,
        blockId: (cell as any).pageIdx ?? cell.blockId ?? 0,
        idx,
      };
    });
  }, [
    layoutResult,
    svgBaseX,
    svgBaseYConst,
    scale,
    pad,
    marginLeft,
    marginTop,
    usableW,
    usableH,
    gridW,
    gridH,
  ]);

  // Usable area in SVG pixels
  const uaX = pad + marginLeft * scale;
  const uaY = pad + marginTop * scale;
  const uaW = usableW * scale;
  const uaH = usableH * scale;

  // Lật gương Mặt sau theo cạnh lật (CNC). Mặc định long-edge = lật ngang.
  const _isCncPreview = !!(layoutResult as any)?.isCncPreview;
  const _cncShortFlip =
    _isCncPreview &&
    ((layoutResult as any)?.cncFlipEdge || cncFlipEdge) === "short";
  // CNC: KHÔNG phản chiếu nội dung — lật VỊ TRÍ + ĐẢO CHIỀU XOAY ở mức từng ô
  // (khớp output cnc_render). Duplex thường (booklet/nup) giữ scale(-1,1).
  const backGroupTransform = _isCncPreview
    ? ""
    : `translate(${svgW}, 0) scale(-1, 1)`;
  const backTextUnflip = (cx: number, cy: number) =>
    _isCncPreview
      ? ""
      : `translate(${cx}, ${cy}) scale(-1, 1) translate(-${cx}, -${cy})`;

  // Map 1 ô Mặt trước (SVG px) → ô Mặt sau cho CNC: lật vị trí quanh trục giữa tờ
  // + đảo chiều xoay 90° (toggle is180 khi isRotated). 180° giữ nguyên.
  const _sheetWpx = sheetWidth * scale;
  const _sheetHpx = sheetHeight * scale;
  const toCncBackCell = (c: any) => {
    let bsx = c.sx;
    let bsy = c.sy;
    if (_cncShortFlip) {
      bsy = 2 * pad + _sheetHpx - c.sy - c.sh;
    } else {
      bsx = 2 * pad + _sheetWpx - c.sx - c.sw;
    }
    const bIs180 = c.isRotated ? !c.is180 : c.is180;
    return { ...c, sx: bsx, sy: bsy, is180: bIs180 };
  };
  const cncBackCells = _isCncPreview ? svgCells.map(toCncBackCell) : svgCells;

  // ── N-Up "Dàn nhiều mẫu": số ô vẽ trên tờ (đại diện) = min(tổng con, sức chứa). ──
  const _showCount =
    _nupTotal != null ? Math.min(_nupTotal, svgCells.length) : svgCells.length;
  let visibleCells =
    _nupTotal != null && _showCount < svgCells.length
      ? svgCells.slice(0, _showCount)
      : svgCells;
  // Căn giữa CHỈ khi đúng 1 tờ (tổng < sức chứa). NHIỀU tờ → giữ vị trí full layout
  // (mọi tờ cùng vị trí ô → chồng giấy in ra xén THẲNG HÀNG).
  if (
    _nupTotal != null && _nupTotal < svgCells.length &&
    align === "center" && visibleCells.length
  ) {
    const minX = Math.min(...visibleCells.map((c) => c.sx));
    const maxX = Math.max(...visibleCells.map((c) => c.sx + c.sw));
    const minY = Math.min(...visibleCells.map((c) => c.sy));
    const maxY = Math.max(...visibleCells.map((c) => c.sy + c.sh));
    const dx = uaX + uaW / 2 - (minX + maxX) / 2;
    const dy = uaY + uaH / 2 - (minY + maxY) / 2;
    visibleCells = visibleCells.map((c) => ({ ...c, sx: c.sx + dx, sy: c.sy + dy }));
  }

  return (
    <div className="flex flex-col items-center bg-slate-50 dark:bg-zinc-900/50 rounded-lg p-3 border border-slate-200 dark:border-white/10 mt-2">
      {layoutResult ? (
        <div className="flex flex-col items-center gap-2 w-full">
          {/* Stats */}
          <div className="flex items-center gap-4 text-[13px] font-medium">
            <div className="text-slate-600 dark:text-zinc-400">
              Sức chứa:{" "}
              <span className="font-bold text-slate-800 dark:text-zinc-200">
                {_showCount < layoutResult.totalItems
                  ? `${_showCount} / ${layoutResult.totalItems}`
                  : layoutResult.totalItems}
              </span>{" "}
              tem/tờ
            </div>
            {Number(targetQuantity) > 0 && (
              <>
                <div className="w-px h-4 bg-slate-300 dark:bg-zinc-700"></div>
                <div className="text-slate-600 dark:text-zinc-400">
                  Cần in:{" "}
                  <span className="font-bold text-indigo-600 dark:text-indigo-400">
                    {totalSheets}
                  </span>{" "}
                  tờ
                </div>
              </>
            )}
          </div>

          {/* SVG Wireframe */}
          {layoutResult.cells.length > 0 && (
            <div className="flex gap-6 items-center justify-center w-full overflow-x-auto pb-2 custom-scrollbar">
              {/* Front Side */}
              <div
                className="relative cursor-pointer group flex-shrink-0"
                onClick={() => setExpanded(!expanded)}
                title={expanded ? "Thu gọn" : "Phóng to xem chi tiết"}
              >
                {duplexFlow === "double" && (
                  <div className="text-center text-[11px] font-bold text-slate-500 mb-2">
                    MẶT TRƯỚC
                  </div>
                )}
                <svg
                  width={svgW}
                  height={svgH}
                  viewBox={`0 0 ${svgW} ${svgH}`}
                  className="transition-all duration-300"
                >
                  <defs>
                    <marker
                      id="arrowHead"
                      markerWidth="6"
                      markerHeight="4"
                      refX="5"
                      refY="2"
                      orient="auto"
                    >
                      <polygon
                        points="0 0, 6 2, 0 4"
                        fill="rgba(99,102,241,0.5)"
                      />
                    </marker>
                  </defs>

                  {/* Sheet */}
                  <rect
                    x={pad}
                    y={pad}
                    width={sheetWidth * scale}
                    height={sheetHeight * scale}
                    fill="white"
                    stroke="#cbd5e1"
                    strokeWidth={1}
                    rx={2}
                    ry={2}
                    className="dark:fill-zinc-800 dark:stroke-zinc-600"
                  />

                  {/* Margin boundary (Usable Area) */}
                  {(marginTop > 0 ||
                    marginBottom > 0 ||
                    marginLeft > 0 ||
                    marginRight > 0) && (
                    <g>
                      <rect
                        x={uaX}
                        y={uaY}
                        width={uaW}
                        height={uaH}
                        fill="none"
                        stroke="#94a3b8"
                        strokeWidth={0.5}
                        strokeDasharray="3,2"
                        rx={1}
                        ry={1}
                      />

                      {/* Crop Marks (Boong/Ốc) Visuals */}
                      <g
                        stroke="#ef4444"
                        strokeWidth={0.8}
                        fill="none"
                        opacity={0.7}
                      >
                        {pontConfig?.shape === "circle" ? (
                          <>
                            <circle cx={uaX} cy={uaY} r={3} />
                            <line
                              x1={uaX - 6}
                              y1={uaY}
                              x2={uaX + 6}
                              y2={uaY}
                              strokeWidth={0.4}
                            />
                            <line
                              x1={uaX}
                              y1={uaY - 6}
                              x2={uaX}
                              y2={uaY + 6}
                              strokeWidth={0.4}
                            />

                            <circle cx={uaX + uaW} cy={uaY} r={3} />
                            <line
                              x1={uaX + uaW - 6}
                              y1={uaY}
                              x2={uaX + uaW + 6}
                              y2={uaY}
                              strokeWidth={0.4}
                            />
                            <line
                              x1={uaX + uaW}
                              y1={uaY - 6}
                              x2={uaX + uaW}
                              y2={uaY + 6}
                              strokeWidth={0.4}
                            />

                            <circle cx={uaX} cy={uaY + uaH} r={3} />
                            <line
                              x1={uaX - 6}
                              y1={uaY + uaH}
                              x2={uaX + 6}
                              y2={uaY + uaH}
                              strokeWidth={0.4}
                            />
                            <line
                              x1={uaX}
                              y1={uaY + uaH - 6}
                              x2={uaX}
                              y2={uaY + uaH + 6}
                              strokeWidth={0.4}
                            />

                            <circle cx={uaX + uaW} cy={uaY + uaH} r={3} />
                            <line
                              x1={uaX + uaW - 6}
                              y1={uaY + uaH}
                              x2={uaX + uaW + 6}
                              y2={uaY + uaH}
                              strokeWidth={0.4}
                            />
                            <line
                              x1={uaX + uaW}
                              y1={uaY + uaH - 6}
                              x2={uaX + uaW}
                              y2={uaY + uaH + 6}
                              strokeWidth={0.4}
                            />
                          </>
                        ) : (
                          <>
                            {/* Top-Left */}
                            <line
                              x1={uaX - 10}
                              y1={uaY}
                              x2={uaX - 2}
                              y2={uaY}
                            />
                            <line
                              x1={uaX}
                              y1={uaY - 10}
                              x2={uaX}
                              y2={uaY - 2}
                            />
                            {/* Top-Right */}
                            <line
                              x1={uaX + uaW + 2}
                              y1={uaY}
                              x2={uaX + uaW + 10}
                              y2={uaY}
                            />
                            <line
                              x1={uaX + uaW}
                              y1={uaY - 10}
                              x2={uaX + uaW}
                              y2={uaY - 2}
                            />
                            {/* Bottom-Left */}
                            <line
                              x1={uaX - 10}
                              y1={uaY + uaH}
                              x2={uaX - 2}
                              y2={uaY + uaH}
                            />
                            <line
                              x1={uaX}
                              y1={uaY + uaH + 2}
                              x2={uaX}
                              y2={uaY + uaH + 10}
                            />
                            {/* Bottom-Right */}
                            <line
                              x1={uaX + uaW + 2}
                              y1={uaY + uaH}
                              x2={uaX + uaW + 10}
                              y2={uaY + uaH}
                            />
                            <line
                              x1={uaX + uaW}
                              y1={uaY + uaH + 2}
                              x2={uaX + uaW}
                              y2={uaY + uaH + 10}
                            />
                          </>
                        )}
                      </g>
                    </g>
                  )}

                  {/* Cells */}
                  {visibleCells.map((c) => {
                    const isMixed = !!layoutResult?.isMixedPreview;
                    const color = BLOCK_COLORS[c.blockId % BLOCK_COLORS.length];
                    // Per-page shape: use pageIdx to get correct shape for this item
                    const itemShape =
                      isMixed && shapesByPage
                        ? shapesByPage[c.blockId] || shapeType
                        : shapeType;
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
                    return (
                      <g key={c.idx}>
                        {renderCellShape(
                          c.sx,
                          c.sy,
                          c.sw,
                          c.sh,
                          c.isRotated,
                          c.is180,
                          c.blockId,
                          itemShape,
                          parsedItemParams,
                          c.idx,
                        )}
                        {isMixed && (
                          <text
                            x={c.sx + c.sw / 2}
                            y={c.sy + c.sh / 2}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fontSize={Math.max(Math.min(c.sw, c.sh) * 0.4, 6)}
                            fontWeight="700"
                            fill={color.text}
                            opacity={0.85}
                          >
                            {c.blockId + 1}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>

                {/* Loading overlay */}
                {isLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-zinc-900/50 rounded mt-[20px]">
                    <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}

                <div className="absolute bottom-1 right-1 bg-white/80 dark:bg-zinc-800/80 rounded px-1.5 py-0.5 text-[9px] text-slate-400 dark:text-zinc-500 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                  {expanded ? "⊖ Thu gọn" : "⊕ Phóng to"}
                </div>
              </div>

              {/* Back Side */}
              {duplexFlow === "double" && (
                <div
                  className="relative cursor-pointer group flex-shrink-0"
                  onClick={() => setExpanded(!expanded)}
                  title={expanded ? "Thu gọn" : "Phóng to xem chi tiết"}
                >
                  <div className="text-center text-[11px] font-bold text-slate-500 mb-2">
                    MẶT SAU
                  </div>
                  <svg
                    width={svgW}
                    height={svgH}
                    viewBox={`0 0 ${svgW} ${svgH}`}
                    className="transition-all duration-300"
                  >
                    <g transform={backGroupTransform}>
                      <rect
                        x={pad}
                        y={pad}
                        width={sheetWidth * scale}
                        height={sheetHeight * scale}
                        fill="white"
                        stroke="#cbd5e1"
                        strokeWidth={1}
                        rx={2}
                        ry={2}
                        className="dark:fill-zinc-800 dark:stroke-zinc-600"
                      />

                      {(marginTop > 0 ||
                        marginBottom > 0 ||
                        marginLeft > 0 ||
                        marginRight > 0) && (
                        <g>
                          <rect
                            x={uaX}
                            y={uaY}
                            width={uaW}
                            height={uaH}
                            fill="none"
                            stroke="#94a3b8"
                            strokeWidth={0.5}
                            strokeDasharray="3,2"
                            rx={1}
                            ry={1}
                          />

                          {/* Crop Marks */}
                          <g
                            stroke="#ef4444"
                            strokeWidth={0.8}
                            fill="none"
                            opacity={0.7}
                          >
                            {pontConfig?.shape === "circle" ? (
                              <>
                                <circle cx={uaX} cy={uaY} r={3} />
                                <line
                                  x1={uaX - 6}
                                  y1={uaY}
                                  x2={uaX + 6}
                                  y2={uaY}
                                  strokeWidth={0.4}
                                />
                                <line
                                  x1={uaX}
                                  y1={uaY - 6}
                                  x2={uaX}
                                  y2={uaY + 6}
                                  strokeWidth={0.4}
                                />

                                <circle cx={uaX + uaW} cy={uaY} r={3} />
                                <line
                                  x1={uaX + uaW - 6}
                                  y1={uaY}
                                  x2={uaX + uaW + 6}
                                  y2={uaY}
                                  strokeWidth={0.4}
                                />
                                <line
                                  x1={uaX + uaW}
                                  y1={uaY - 6}
                                  x2={uaX + uaW}
                                  y2={uaY + 6}
                                  strokeWidth={0.4}
                                />

                                <circle cx={uaX} cy={uaY + uaH} r={3} />
                                <line
                                  x1={uaX - 6}
                                  y1={uaY + uaH}
                                  x2={uaX + 6}
                                  y2={uaY + uaH}
                                  strokeWidth={0.4}
                                />
                                <line
                                  x1={uaX}
                                  y1={uaY + uaH - 6}
                                  x2={uaX}
                                  y2={uaY + uaH + 6}
                                  strokeWidth={0.4}
                                />

                                <circle cx={uaX + uaW} cy={uaY + uaH} r={3} />
                                <line
                                  x1={uaX + uaW - 6}
                                  y1={uaY + uaH}
                                  x2={uaX + uaW + 6}
                                  y2={uaY + uaH}
                                  strokeWidth={0.4}
                                />
                                <line
                                  x1={uaX + uaW}
                                  y1={uaY + uaH - 6}
                                  x2={uaX + uaW}
                                  y2={uaY + uaH + 6}
                                  strokeWidth={0.4}
                                />
                              </>
                            ) : (
                              <>
                                {/* Top-Left */}
                                <line
                                  x1={uaX - 10}
                                  y1={uaY}
                                  x2={uaX - 2}
                                  y2={uaY}
                                />
                                <line
                                  x1={uaX}
                                  y1={uaY - 10}
                                  x2={uaX}
                                  y2={uaY - 2}
                                />
                                {/* Top-Right */}
                                <line
                                  x1={uaX + uaW + 2}
                                  y1={uaY}
                                  x2={uaX + uaW + 10}
                                  y2={uaY}
                                />
                                <line
                                  x1={uaX + uaW}
                                  y1={uaY - 10}
                                  x2={uaX + uaW}
                                  y2={uaY - 2}
                                />
                                {/* Bottom-Left */}
                                <line
                                  x1={uaX - 10}
                                  y1={uaY + uaH}
                                  x2={uaX - 2}
                                  y2={uaY + uaH}
                                />
                                <line
                                  x1={uaX}
                                  y1={uaY + uaH + 2}
                                  x2={uaX}
                                  y2={uaY + uaH + 10}
                                />
                                {/* Bottom-Right */}
                                <line
                                  x1={uaX + uaW + 2}
                                  y1={uaY + uaH}
                                  x2={uaX + uaW + 10}
                                  y2={uaY + uaH}
                                />
                                <line
                                  x1={uaX + uaW}
                                  y1={uaY + uaH + 2}
                                  x2={uaX + uaW}
                                  y2={uaY + uaH + 10}
                                />
                              </>
                            )}
                          </g>
                        </g>
                      )}

                      {/* Cells */}
                      {cncBackCells.map((c) => {
                        const isMixed = !!layoutResult?.isMixedPreview;
                        const color =
                          BLOCK_COLORS[c.blockId % BLOCK_COLORS.length];
                        const itemShape =
                          isMixed && shapesByPage
                            ? shapesByPage[c.blockId] || shapeType
                            : shapeType;
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

                        // Calculate center of cell to un-mirror text
                        const cx = c.sx + c.sw / 2;
                        const cy = c.sy + c.sh / 2;

                        return (
                          <g key={c.idx}>
                            {renderCellShape(
                              c.sx,
                              c.sy,
                              c.sw,
                              c.sh,
                              c.isRotated,
                              c.is180,
                              c.blockId,
                              itemShape,
                              parsedItemParams,
                              c.idx,
                            )}
                            {isMixed && (
                              <text
                                x={cx}
                                y={cy}
                                textAnchor="middle"
                                dominantBaseline="central"
                                fontSize={Math.max(
                                  Math.min(c.sw, c.sh) * 0.4,
                                  6,
                                )}
                                fontWeight="700"
                                fill={color.text}
                                opacity={0.85}
                                transform={backTextUnflip(cx, cy)}
                              >
                                {_isCncPreview &&
                                (layoutResult as any)?.cncTwoSided
                                  ? c.blockId + 2
                                  : c.blockId + 1}
                              </text>
                            )}
                          </g>
                        );
                      })}
                    </g>
                  </svg>

                  <div className="absolute bottom-1 right-1 bg-white/80 dark:bg-zinc-800/80 rounded px-1.5 py-0.5 text-[9px] text-slate-400 dark:text-zinc-500 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                    {expanded ? "⊖ Thu gọn" : "⊕ Phóng to"}
                  </div>
                </div>
              )}
            </div>
          )}

          {isDetectingShape && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400 animate-pulse font-medium">
              🔍 Đang nhận diện hình dạng tem...
            </div>
          )}
        </div>
      ) : (
        <div className="text-sm text-slate-500 flex items-center gap-2">
          {isDetectingShape ? (
            "🔍 Đang nhận diện hình dạng tem..."
          ) : isLoading ? (
            <>
              <div className="w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              Đang tính toán bố cục...
            </>
          ) : (
            "Chưa có dữ liệu bố cục"
          )}
        </div>
      )}
    </div>
  );
}
