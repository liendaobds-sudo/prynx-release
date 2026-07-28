import React, { useEffect, useMemo, useRef, useState } from "react";
import { authenticatedFetch, getApiUrl, uploadPDF } from "../../../lib/api";
import { previewPerfLog } from "../../../lib/previewPerfLog";
import { getFileArrayBuffer } from "../../../lib/utils";
import type { NupSettings } from "../types";
import { inheritedSingleMoldMaster } from "../shapeDetectionPolicy";
import { materializePreviewViewerPdf, parsePreviewViewerState, resolvePreviewCellType, resolvePreviewPageCount, shouldDeferPreviewLayout } from "../previewSourcePolicy";
import { useTranslation } from 'react-i18next';
// UIUX (audit 2026-07-27 §B-05): lỗi kỹ thuật → câu Việt + hướng khắc phục
import { formatError } from "../../../lib/errorMessages";

export interface GridPreviewProps {
  taskMode: string;
  isDieCut?: boolean;
  pageSheetMode?: boolean;
  /** Cách thức ráp N-Up: sequential | cut_stacks | ratio_stack | repeat */
  layoutType?: NupSettings["layoutType"] | string;
  /** 1 mặt / 2 mặt — sequential 2 mặt ghép cặp trang trước/sau */
  duplexFlow?: string;
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
  /** Tổng số mẫu nguồn hiện có — dùng để phân bổ và tự động lấp đầy preview. */
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
  filePath?: string;
  pageIdx?: number;
  bleed?: number; // in mm
  groupingStrategy?: string;
  clusterCombineMode?: string;
  clusterNesting?: boolean;
  clusterSizingMode?: string;
  clusterCols?: number;
  clusterRows?: number;
  clusterTileW?: number;
  clusterTileH?: number;
  tileGapX?: number;
  tileGapY?: number;
  // ── Chia cọc theo loại (ratio_stack + clusterDistribution='type') ──
  clusterMode?: string;
  clusterCount?: number;
  clusterGap?: number;
  clusterDistribution?: string;
  // ── Bình Bế Rớt (CNC) ghép nhiều mẫu ──
  imposerMode?: string;
  cncTwoSided?: boolean;
  cncFlipEdge?: "long" | "short";
  cutType?: string;
  fillBlockGap?: number;
  dieSizeMode?: "die" | "page";
  dieOffsetMm?: number;
  /** PDF đã bake chỉnh sửa viewer — parity preview≡output (không đọc file gốc). */
  getWorkingFile?: () => Promise<File>;
  /** Đổi khi xoay/xóa/sắp trang → invalidate cache path preview. */
  previewSourceKey?: string;
}

// =====================================================================
// Layout result interface (matches backend PreviewLayoutResponse)
// =====================================================================
interface BackendLayoutCell {
  x: number;
  y: number;
  // Toạ độ TUYỆT ĐỐI cuối cùng (sau căn giữa + va chạm) — gốc dưới-trái tờ, Y hướng
  // lên. Có khi absPlacement=true. Frontend vẽ trực tiếp: svgY=sheetHeight-absY-h.
  absX?: number;
  absY?: number;
  width: number;
  height: number;
  isRotated: boolean;
  isRotated180: boolean;
  blockId: number;
  /** ratio_stack / mixed: chỉ số trang nguồn gán cho ô này */
  pageIdx?: number;
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
  // Backend đã trả toạ độ tuyệt đối (SSOT, khớp output) → frontend CHỈ vẽ, KHÔNG
  // canh giữa lại. false/thiếu → đường lưới tương đối cũ (N-Up không die-cut).
  absPlacement?: boolean;
  // Đường bế THẬT của tem (phân số 0..1, Y-up) — dùng vẽ búa/tạ đúng outline (Bug A).
  diePolygon?: number[][] | null;
  /** ratio_stack / CNC: số tờ logic cần in (PDF có thể chỉ 1 trang mẫu). */
  sheetsNeeded?: number;
  /** Chế độ 1 khuôn dùng chung cho mọi trang nội dung. */
  isHomogeneousPreview?: boolean;
  /** Tổng số mẫu của toàn bộ job; có thể lớn hơn số ô của tờ đang xem. */
  totalContentItems?: number;
  /** ratio_stack: chỉ số mẫu có SL>0 nhưng không đủ chỗ trên tờ. */
  ratioUnplaced?: number[];
  /** chia cụm: kiểu ghép đã dùng (replicate_mixed / zone_per_type / zone_ratio). */
  clusterCombineMode?: string;
  /** chia cụm: đường xén guillotine giữa các cụm/vùng (pt, cùng không gian abs với cells). */
  cutLines?: { v: number[]; h: number[] };
  /** chia cụm zone modes: MỌI tờ (mỗi tờ 1 bộ loại) để lật ◄ n/N ► không fetch lại. */
  sheets?: Array<{
    cells: BackendLayoutCell[];
    overallWidth: number;
    overallHeight: number;
    totalItems: number;
    cutLines?: { v: number[]; h: number[] };
  }>;
}

// =====================================================================
// ratio_stack client fallback — largest-remainder (khớp imposition_core)
// Dùng khi backend vẫn trả nhiều pageIdx hơn số trang viewer (file gốc
// chưa bake / total_pages bị bỏ qua).
// =====================================================================
function ratioStackCellsPerPage(capacity: number, qtys: number[]): number[] {
  const n = qtys.length;
  const cells = new Array(n).fill(0);
  if (capacity <= 0 || n <= 0) return cells;
  const totalQ = qtys.reduce((a, q) => a + Math.max(0, q), 0);
  if (totalQ === 0) {
    const base = Math.floor(capacity / n);
    const rem = capacity % n;
    for (let i = 0; i < n; i++) cells[i] = base + (i < rem ? 1 : 0);
    return cells;
  }
  const remainders: { frac: number; i: number; q: number }[] = [];
  let assigned = 0;
  for (let i = 0; i < n; i++) {
    const q = Math.max(0, qtys[i]);
    if (q === 0) continue;
    const ideal = (capacity * q) / totalQ;
    const fl = Math.floor(ideal);
    cells[i] = fl;
    assigned += fl;
    remainders.push({ frac: ideal - fl, i, q });
  }
  let leftover = Math.max(0, capacity - assigned);
  remainders.sort((a, b) => b.frac - a.frac || b.q - a.q);
  let ri = 0;
  while (leftover > 0 && remainders.length > 0) {
    cells[remainders[ri % remainders.length].i] += 1;
    leftover -= 1;
    ri += 1;
  }
  // Min 1 ô cho mẫu SL>0 (mượn từ donor lớn nhất).
  for (;;) {
    const need = cells.findIndex((_, i) => qtys[i] > 0 && cells[i] === 0);
    if (need < 0) break;
    let donor = -1;
    let donorCells = 1;
    for (let j = 0; j < n; j++) {
      if (cells[j] > donorCells) {
        donorCells = cells[j];
        donor = j;
      }
    }
    if (donor < 0 || cells[donor] <= 1) break;
    cells[donor] -= 1;
    cells[need] += 1;
  }
  return cells;
}

function reassignRatioStackPageIdx<T extends { pageIdx?: number }>(
  cells: T[],
  nTypes: number,
  qtysByPage: Record<number, number> | undefined,
  globalQty: number,
): T[] {
  if (nTypes <= 0 || cells.length === 0) return cells;
  const qtys = Array.from({ length: nTypes }, (_, i) => {
    const v = qtysByPage?.[i];
    if (v !== undefined && v !== null) return Math.max(0, Number(v) || 0);
    return Math.max(0, Number(globalQty) || 0);
  });
  const cpp = ratioStackCellsPerPage(cells.length, qtys);
  const slot: number[] = [];
  cpp.forEach((cnt, mi) => {
    for (let k = 0; k < cnt; k++) slot.push(mi);
  });
  return cells.map((c, j) => ({ ...c, pageIdx: slot[j] ?? 0 }));
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
  diePolygon?: number[][] | null,
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

  // Đường vẽ SCHEMATIC (hình mẫu không có đường bế thật). Die-cut/CUSTOM giờ đi đường
  // diePolylines (backend dùng CHUNG transform với file xuất) nên KHÔNG qua rotDeg này.
  // Giữ nguyên công thức gốc cho các hình schematic để không đổi hành vi chế độ khác.
  let rotDeg = (isRotated ? 90 : 0) + (is180 ? 180 : 0);

  if (shapeProps) {
    if (shapeKey === "PENTAGON") {
      if (isRotated) {
        rotDeg = 90 + (is180 ? 0 : 180);
      }
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
      // ── Đường bế THẬT (backend trả diePolygon, phân số 0..1 Y-up) → vẽ ĐÚNG outline
      // của tem, áp đúng phép xoay như output. Khắc phục Bug A (hình tổng hợp đoán hướng
      // sai khi bigEndFirst / tem tạ-bị-nhận-là-búa). Không cần bigEndFirst nữa vì
      // polygon đã mang hướng THẬT.
      if (diePolygon && diePolygon.length >= 3) {
        const realPts = diePolygon
          .map(([fx, fy]) => `${ox + fx * ow},${oy + (1 - fy) * oh}`)
          .join(" ");
        return (
          <g key={idx} opacity={opacity} transform={transform}>
            <polygon
              points={realPts}
              fill={color.fill}
              stroke={color.stroke}
              strokeWidth={0.8}
              strokeLinejoin="round"
            />
          </g>
        );
      }
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
      // Đường bế THẬT (diePolygon) → vẽ ĐÚNG contour mũi tên (đầu/cán/hướng thật,
      // kể cả bất đối xứng). Trước đây vẽ mũi tên TỔNG HỢP tỉ lệ cố định → sai hình.
      if (diePolygon && diePolygon.length >= 3) {
        const realPts = diePolygon
          .map(([fx, fy]) => `${ox + fx * ow},${oy + (1 - fy) * oh}`)
          .join(" ");
        shapeNode = (
          <polygon
            points={realPts}
            fill={color.fill}
            stroke={color.stroke}
            strokeWidth={0.8}
            strokeLinejoin="round"
          />
        );
        break;
      }
      const aw = ow * 0.35,
        ah = oh * 0.4;
      // Base arrow pointing UP (fallback khi không có đường bế thật)
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
      // CUSTOM / hình tự do: nếu backend trả đường bế THẬT (diePolygon, phân số
      // 0..1 Y-up) → vẽ ĐÚNG contour (vd khuôn 'bù xén' trace từ raster). Trước đây
      // luôn vẽ bounding box → preview sai hình. Không có polygon → mới fallback rect.
      if (diePolygon && diePolygon.length >= 3) {
        const realPts = diePolygon
          .map(([fx, fy]) => `${ox + fx * ow},${oy + (1 - fy) * oh}`)
          .join(" ");
        shapeNode = (
          <polygon
            points={realPts}
            fill={color.fill}
            stroke={color.stroke}
            strokeWidth={0.8}
            strokeLinejoin="round"
          />
        );
      } else {
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
      }
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
  const { t } = useTranslation();
  const {
    taskMode,
    isDieCut,
    pageSheetMode = false,
    layoutType,
    duplexFlow = "normal",
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
    filePath,
    pageIdx = 0,
    bleed = 0,
    groupingStrategy,
    clusterCombineMode,
    clusterNesting,
    clusterSizingMode,
    clusterCols,
    clusterRows,
    clusterTileW,
    clusterTileH,
    tileGapX,
    tileGapY,
    clusterMode,
    clusterCount,
    clusterGap,
    clusterDistribution,
    imposerMode,
    cncTwoSided,
    cncFlipEdge,
    cutType,
    fillBlockGap,
    dieSizeMode,
    dieOffsetMm,
    getWorkingFile,
    previewSourceKey,
  } = props;

  const [expanded, setExpanded] = useState(false);
  const [layoutResult, setLayoutResult] = useState<BackendLayoutResult | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // chia cụm zone modes: tờ đang xem (0-based) để lật ◄ n/N ►.
  const [activeSheet, setActiveSheet] = useState(0);
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

  // getWorkingFile được tạo mới mỗi lần parent render (không useCallback ở
  // ImpositionTab) → nếu để trong dep array của effect fetch preview thì MỌI
  // re-render của parent (vd kéo resize sidebar → sidebarWidth đổi) sẽ fetch lại
  // bố cục oan. Giữ trong ref, đọc .current trong effect, KHÔNG cho vào deps.
  const getWorkingFileRef = useRef(getWorkingFile);
  useEffect(() => {
    getWorkingFileRef.current = getWorkingFile;
  }, [getWorkingFile]);

  const previewPathCacheRef = useRef<{ key: string; path?: string; fileId?: string } | null>(null);
  /** Max order length đã thấy — giảm length = đã xóa trang → ưu tiên bake. */
  const maxOrderLenSeenRef = useRef(0);

  const resolvePreviewSource = async (): Promise<{ path?: string; file_id?: string }> => {
    const cacheKey = previewSourceKey ?? "default";
    const viewerState = parsePreviewViewerState(cacheKey);
    // Đổi pageOrder (xóa/sắp trang) → bỏ cache path/fileId cũ.
    if (previewPathCacheRef.current && previewPathCacheRef.current.key !== cacheKey) {
      previewPathCacheRef.current = null;
    } else if (previewPathCacheRef.current?.key === cacheKey) {
      if (previewPathCacheRef.current.path) return { path: previewPathCacheRef.current.path };
      if (previewPathCacheRef.current.fileId) return { file_id: previewPathCacheRef.current.fileId };
    }

    // Có xóa/sắp trang? → cố bake; nếu bake/ghi temp lỗi vẫn fallback path
    // (đúng số loại nhờ total_pages + reassign client).
    let mustBake = false;
    const order = viewerState.order;
    if (order.length > 0) {
      if (order.length > maxOrderLenSeenRef.current) {
        maxOrderLenSeenRef.current = order.length;
      }
      if (!order.every((p, i) => p === i + 1)) mustBake = true;
      if (maxOrderLenSeenRef.current > 0 && order.length < maxOrderLenSeenRef.current) {
        mustBake = true;
      }
    }
    if (
      typeof sourceTotalPages === "number" &&
      sourceTotalPages > 0 &&
      maxOrderLenSeenRef.current > sourceTotalPages
    ) {
      mustBake = true;
    }

    if (getWorkingFileRef.current) {
      try {
        const wf = await getWorkingFileRef.current();
        const nativePath = (wf as any)?.path as string | undefined;

        // Chưa sửa trang + có path đĩa → dùng luôn (nhanh).
        if (nativePath && !mustBake) {
          previewPathCacheRef.current = { key: cacheKey, path: nativePath };
          return { path: nativePath };
        }

        // Ưu tiên materialize bytes (file bake không có .path, hoặc cần bản đã xóa trang).
        let bytes: Uint8Array<ArrayBuffer> | null = null;
        try {
          const sourceBuffer = await getFileArrayBuffer(wf);
          if (nativePath && mustBake && viewerState.order.length > 0) {
            bytes = await materializePreviewViewerPdf(sourceBuffer, viewerState) as Uint8Array<ArrayBuffer>;
            void previewPerfLog("preview-source MATERIALIZED", {
              pages: viewerState.order.length,
              duplicates: viewerState.order.length - new Set(viewerState.order.filter((p) => p > 0)).size,
            });
          } else if (sourceBuffer && sourceBuffer.byteLength > 64) {
            bytes = new Uint8Array(sourceBuffer);
          }
        } catch (e) {
          console.warn("[GridPreview] materialize source failed:", e);
        }

        if (bytes) {
          if ((window as any).__TAURI_INTERNALS__) {
            try {
              const { tempDir, join } = await import("@tauri-apps/api/path");
              const { writeFile } = await import("@tauri-apps/plugin-fs");
              const tDir = await tempDir();
              const tempPath = await join(tDir, `prynx_preview_${Date.now()}.pdf`);
              await writeFile(tempPath, bytes);
              previewPathCacheRef.current = { key: cacheKey, path: tempPath };
              return { path: tempPath };
            } catch (e) {
              console.warn("[GridPreview] write temp failed:", e);
            }
          } else {
            try {
              const up = await uploadPDF(new File([bytes], "preview.pdf", { type: "application/pdf" }));
              if (up?.id) {
                previewPathCacheRef.current = { key: cacheKey, fileId: up.id };
                return { file_id: up.id };
              }
            } catch (e) {
              console.warn("[GridPreview] upload preview failed:", e);
            }
          }
        }

        // Fallback: path gốc (có thể còn 10 trang) — total_pages + client reassign lo số loại.
        if (nativePath) {
          previewPathCacheRef.current = { key: cacheKey, path: nativePath };
          return { path: nativePath };
        }
      } catch (e) {
        console.warn("[GridPreview] resolvePreviewSource getWorkingFile failed:", e);
      }
    }

    // Fallback cuối: prop từ dashboard.
    if (filePath) return { path: filePath };
    if (fileId) return { file_id: fileId };
    return {};
  };

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

  // Generation id — chặn response cũ (10 trang) ghi đè response mới (4 trang).
  const previewGenRef = useRef(0);
  /** Cache layout theo khóa ổn định — cuộn trang view KHÔNG đụng cache/API. */
  const layoutKeyRef = useRef("");
  const layoutCacheRef = useRef<BackendLayoutResult | null>(null);

  // ── Khi nào cuộn trang view KHÔNG được refetch layout ──
  // • 1 khuôn (mọi trang cùng type / master inherit) → 1 layout, cuộn chỉ xem.
  // • Multi-pack (ratio_stack / sequential / cluster / CNC) → 1 tờ xếp nhiều loại.
  // • MỖI TEM MỘT KHUÔN khác nhau + step_repeat/repeat → PHẢI tính theo trang view
  //   (die size/type khác → capacity khác). Không gộp với case 1 khuôn.
  const _isClusterPreview = groupingStrategy === "cluster_tile"
    && layoutType !== "repeat"
    && taskMode !== "step_repeat";
  const _multiPage =
    typeof sourceTotalPages === "number" && sourceTotalPages > 1;
  const _singleMoldMaster = useMemo(
    () => inheritedSingleMoldMaster(shapeParamsByPage, sourceTotalPages || 0),
    [shapeParamsByPage, sourceTotalPages],
  );
  const _geometryPageIdx = _singleMoldMaster ?? 0;
  /** Chỉ inheritance tường minh mới được coi là một khuôn. */
  const _singleMoldFamily =
    !!isDieCut && _multiPage && _singleMoldMaster !== null;
  /** Xếp nhiều mẫu trên 1 (hoặc N) tờ — page view không đổi geometry layout. */
  const _multiPackLayout =
    _isClusterPreview ||
    (_multiPage &&
      (layoutType === "ratio_stack" ||
        layoutType === "sequential" ||
        layoutType === "cut_stacks")) ||
    (_multiPage && imposerMode === "cnc") ||
    // Die-cut multi nhưng không phải step_repeat “một loại/tờ”: pack chung
    (_multiPage &&
      !!isDieCut &&
      taskMode !== "step_repeat" &&
      layoutType !== "repeat");
  const _layoutIgnoresViewPage =
    _singleMoldFamily || _multiPackLayout;

  const _pageIdxDep = _singleMoldFamily
    ? _geometryPageIdx
    : (_layoutIgnoresViewPage ? 0 : pageIdx);
  const _shapesByPageKey = useMemo(() => {
    if (!shapesByPage || typeof shapesByPage !== "object") return "";
    try {
      return JSON.stringify(shapesByPage);
    } catch {
      return "";
    }
  }, [shapesByPage]);
  const _shapeParamsByPageKey = useMemo(() => {
    if (!shapeParamsByPage || typeof shapeParamsByPage !== "object") return "";
    try {
      return JSON.stringify(shapeParamsByPage);
    } catch {
      return "";
    }
  }, [shapeParamsByPage]);
  // Master shape fingerprint — dùng đúng inherited master, không theo trang đang xem.
  const _masterShapeKey = useMemo(() => {
    if (!_layoutIgnoresViewPage) return `${shapeType}|${itemW}|${itemH}|${shapeParams || ""}`;
    let st = "CUSTOM";
    if (shapesByPage) {
      const preferred = (shapesByPage as any)[_geometryPageIdx]
        ?? (shapesByPage as any)[String(_geometryPageIdx)];
      if (preferred && preferred !== "CUSTOM") st = String(preferred);
      else {
        for (const k of Object.keys(shapesByPage)) {
          const v = (shapesByPage as any)[k];
          if (v && v !== "CUSTOM") {
            st = String(v);
            break;
          }
        }
      }
    } else if (shapeType && shapeType !== "CUSTOM") st = shapeType;
    return `${st}|${_shapesByPageKey}|${_shapeParamsByPageKey}`;
  }, [
    _layoutIgnoresViewPage,
    shapeType,
    itemW,
    itemH,
    shapeParams,
    shapesByPage,
    _shapesByPageKey,
    _geometryPageIdx,
    _shapeParamsByPageKey,
  ]);

  const _shapeTypeDep = _layoutIgnoresViewPage ? _masterShapeKey : shapeType;
  const _shapeParamsDep = _layoutIgnoresViewPage ? _shapeParamsByPageKey : shapeParams;
  // Guillotine layout has no die master: resized page dimensions always affect
  // grid capacity, including multi-design layouts that ignore active-page labels.
  const _itemWDep = _layoutIgnoresViewPage && isDieCut ? 0 : itemW;
  const _itemHDep = _layoutIgnoresViewPage && isDieCut ? 0 : itemH;
  const _pageIdxForRequest = _singleMoldFamily
    ? _geometryPageIdx
    : (_layoutIgnoresViewPage ? 0 : pageIdx);

  /** Khóa layout: mọi thứ ảnh hưởng xếp tem — KHÔNG gồm pageIdx view. */
  const layoutFetchKey = useMemo(() => {
    return JSON.stringify({
      uw: Math.round(usableW * 100) / 100,
      uh: Math.round(usableH * 100) / 100,
      iw: Math.round((_itemWDep || 0) * 100) / 100,
      ih: Math.round((_itemHDep || 0) * 100) / 100,
      gx: gapX,
      gy: gapY,
      sg: splitGap,
      gs: gridStrategy,
      cols: columns,
      rows: rows,
      st: _shapeTypeDep,
      sp: _shapeParamsDep,
      pont: pontType,
      pontC: pontType && pontType !== "none" ? pontConfig : null,
      tm: taskMode,
      lt: layoutType,
      df: duplexFlow,
      die: !!isDieCut,
      psm: pageSheetMode,
      n: sourceTotalPages || 0,
      sw: sheetWidth,
      sh: sheetHeight,
      ml: marginLeft,
      mb: marginBottom,
      mr: marginRight,
      mt: marginTop,
      al: align,
      fid: fileId || "",
      fp: filePath || "",
      bl: bleed,
      grp: groupingStrategy,
      ccm: clusterCombineMode,
      cn: clusterNesting !== false,
      csm: clusterSizingMode,
      cc: clusterCols,
      cr: clusterRows,
      ctw: clusterTileW,
      cth: clusterTileH,
      tgx: tileGapX,
      tgy: tileGapY,
      cm: clusterMode,
      ccnt: clusterCount,
      cg: clusterGap,
      cd: clusterDistribution,
      tq: targetQuantity,
      tqbp: targetQuantitiesByPage || {},
      im: imposerMode || "",
      c2: !!cncTwoSided,
      cfe: cncFlipEdge || "",
      ct: cutType || "",
      fbg: fillBlockGap,
      dsm: dieSizeMode,
      dom: dieOffsetMm,
      psk: previewSourceKey || "",
      detecting: shouldDeferPreviewLayout(!!isDieCut, !!isDetectingShape),
    });
  }, [
    usableW,
    usableH,
    _layoutIgnoresViewPage,
    _itemWDep,
    _itemHDep,
    gapX,
    gapY,
    splitGap,
    gridStrategy,
    columns,
    rows,
    _shapeTypeDep,
    _shapeParamsDep,
    pontType,
    pontConfig,
    taskMode,
    layoutType,
    duplexFlow,
    isDieCut,
    pageSheetMode,
    sourceTotalPages,
    sheetWidth,
    sheetHeight,
    marginLeft,
    marginBottom,
    marginRight,
    marginTop,
    align,
    fileId,
    filePath,
    bleed,
    groupingStrategy,
    clusterCombineMode,
    clusterNesting,
    clusterSizingMode,
    clusterCols,
    clusterRows,
    clusterTileW,
    clusterTileH,
    tileGapX,
    tileGapY,
    clusterMode,
    clusterCount,
    clusterGap,
    clusterDistribution,
    targetQuantity,
    targetQuantitiesByPage,
    imposerMode,
    cncTwoSided,
    cncFlipEdge,
    cutType,
    fillBlockGap,
    dieSizeMode,
    dieOffsetMm,
    previewSourceKey,
    isDetectingShape,
  ]);

  useEffect(() => {
    // Clear any pending debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // A changed layout key makes the running response stale. Abort immediately
    // instead of waiting for the next debounce callback to do it.
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    // Never launch an expensive CUSTOM/NFP preview while its shape is still
    // being detected. Detection completion changes the key and fetches once
    // with the final geometry. Rectangular page-sheet preview is not deferred.
    if (shouldDeferPreviewLayout(!!isDieCut, !!isDetectingShape)) {
      setIsLoading(false);
      setPreviewError(null);
      return;
    }

    // Multi-sheet: không require itemW/itemH trang view (có thể 0 lúc scroll chưa detect).
    if (usableW <= 0 || usableH <= 0) {
      return;
    }
    if (!_layoutIgnoresViewPage && (itemW <= 0 || itemH <= 0)) {
      return;
    }

    // ── CACHE HIT: cùng khuôn/settings → giữ nguyên layout, 0 API, 0 loading ──
    if (
      layoutKeyRef.current === layoutFetchKey &&
      layoutCacheRef.current
    ) {
      setIsLoading(false);
      setPreviewError(null);
      setLayoutResult((prev) =>
        prev === layoutCacheRef.current ? prev : layoutCacheRef.current,
      );
      return;
    }

    // Stale-while-revalidate: GIỮ preview cũ trên màn hình, chỉ bật loading nhẹ.
    // KHÔNG setLayoutResult(null) → hết giật trắng khi detect/settings đổi.
    setIsLoading(true);
    setPreviewError(null);
    const gen = ++previewGenRef.current;

    // Số trang viewer (SSOT cho ratio_stack) — luôn gửi, không để backend đoán từ file gốc.
    const viewerPageCount = resolvePreviewPageCount(previewSourceKey, sourceTotalPages || 0);

    debounceRef.current = setTimeout(async () => {
      // Abort previous in-flight request
      if (abortRef.current) {
        abortRef.current.abort();
      }
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const _tPrev = performance.now();
        const previewSrc = await resolvePreviewSource();
        void previewPerfLog("preview-layout START", {
          taskMode: taskMode || "",
          isDieCut: !!isDieCut,
          grouping: groupingStrategy || "",
          imposerMode: imposerMode || "",
          pageIdx: _pageIdxForRequest,
          ignoreViewPage: _layoutIgnoresViewPage,
          hasPath: !!(previewSrc.path || filePath),
        });
        // Multi-sheet: shape/props theo master (trang 0 / fingerprint), không theo trang view.
        const _reqShapeType = (() => {
          if (!_layoutIgnoresViewPage) {
            return shapeType && shapeType !== "CUSTOM" ? shapeType : "CUSTOM";
          }
          if (shapesByPage && typeof shapesByPage === "object") {
            const preferred = (shapesByPage as any)[_geometryPageIdx]
              ?? (shapesByPage as any)[String(_geometryPageIdx)];
            if (preferred && preferred !== "CUSTOM") return String(preferred);
            for (const k of Object.keys(shapesByPage)) {
              const v = (shapesByPage as any)[k];
              if (v && v !== "CUSTOM") return String(v);
            }
          }
          return shapeType && shapeType !== "CUSTOM" ? shapeType : "CUSTOM";
        })();
        const _reqShapeProps = (() => {
          if (!_layoutIgnoresViewPage) return shapePropsParsed || {};
          if (shapeParamsByPage && typeof shapeParamsByPage === "object") {
            const preferred = (shapeParamsByPage as any)[_geometryPageIdx]
              ?? (shapeParamsByPage as any)[String(_geometryPageIdx)];
            if (preferred && typeof preferred === "object") return preferred;
          }
          return shapePropsParsed || {};
        })();
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
          shape_type: pageSheetMode ? "RECTANGLE" : _reqShapeType,
          shape_props: pageSheetMode ? {} : _reqShapeProps,
          pont_config: pontType && pontType !== "none" ? pontConfig : null,
          sheet_w: sheetWidth * MM_TO_PT,
          sheet_h: sheetHeight * MM_TO_PT,
          margin_left: marginLeft * MM_TO_PT,
          margin_bottom: marginBottom * MM_TO_PT,
          margin_top: marginTop * MM_TO_PT,
          margin_right: marginRight * MM_TO_PT,
          align: align || "center",
          ...(previewSrc.path
            ? { path: previewSrc.path }
            : previewSrc.file_id
              ? { file_id: previewSrc.file_id }
              : filePath
                ? { path: filePath }
                : fileId
                  ? { file_id: fileId }
                  : {}),
          page_idx: _pageIdxForRequest,
          bleed: bleed * MM_TO_PT, // bleed in points to match nup_engine
          cut_type: pageSheetMode ? undefined : (cutType || "default"),
          fill_block_gap: pageSheetMode ? undefined : (fillBlockGap ?? 0),
          die_size_mode: pageSheetMode ? undefined : (dieSizeMode || "die"),
          die_offset_mm: pageSheetMode ? undefined : (dieOffsetMm ?? 0),
          grouping_strategy: groupingStrategy,
          cluster_combine_mode: clusterCombineMode,
          cluster_nesting: clusterNesting !== false,
          cluster_sizing_mode: clusterSizingMode,
          cluster_cols: clusterCols,
          cluster_rows: clusterRows,
          cluster_w: clusterTileW ? clusterTileW * MM_TO_PT : undefined,
          cluster_h: clusterTileH ? clusterTileH * MM_TO_PT : undefined,
          tile_gap_x: tileGapX ? tileGapX * MM_TO_PT : undefined,
          tile_gap_y: tileGapY ? tileGapY * MM_TO_PT : undefined,
          task_mode: taskMode,
          is_die_cut: pageSheetMode ? false : !!isDieCut,
          page_sheet_mode: pageSheetMode,
          // N-Up cách thức ráp — backend nhánh ratio_stack / sequential cần field này.
          layout_type: layoutType || undefined,
          duplex_flow: duplexFlow || "normal",
          // Chia cọc theo loại (ratio_stack + clusterDistribution='type'): gửi để preview
          // dựng đa cọc KHỚP nup_engine. cluster_gap → points (backend không nhân lại).
          cluster_mode: clusterMode || "none",
          cluster_count: clusterCount || 2,
          cluster_gap: (clusterGap || 0) * MM_TO_PT,
          cluster_distribution: clusterDistribution || "default",
          // BẮT BUỘC: số trang viewer sau xóa thumbnail (vd 4) — không tin doc.page_count.
          total_pages: viewerPageCount > 0 ? viewerPageCount : 0,
          split_gap: splitGap * MM_TO_PT,
          target_quantity: Number(targetQuantity) || 0,
          // Chỉ gửi SL cho các trang còn lại (0..viewerPageCount-1), bỏ key trang đã xóa.
          target_quantities_by_page: Object.fromEntries(
            Object.entries(targetQuantitiesByPage || {})
              .filter(([k]) => {
                if (viewerPageCount <= 0) return true;
                const idx = Number(k);
                return !Number.isNaN(idx) && idx >= 0 && idx < viewerPageCount;
              })
              .map(([k, v]) => [String(k), Number(v) || 0]),
          ),
          // Chế độ ĐỒNG NHẤT (sticker-homogeneous-nup): backend tự bật khi đúng 1 trang
          // có khuôn + còn lại không. Gửi hình/nội-suy nhận diện theo trang để detect.
          detected_shapes_by_page: pageSheetMode ? {} : (shapesByPage || {}),
          detected_shape_params_by_page: pageSheetMode ? {} : (shapeParamsByPage || {}),
          imposer_mode: pageSheetMode ? undefined : imposerMode,
          cnc_two_sided: pageSheetMode ? false : !!cncTwoSided,
          cnc_flip_edge: pageSheetMode ? undefined : (cncFlipEdge || "long"),
        };

        const res = await authenticatedFetch(`${getApiUrl()}/imposition/preview-layout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text();
          let message = `Không thể tính preview (${res.status}).`;
          try {
            const parsed = JSON.parse(errText);
            if (typeof parsed?.detail === "string") message = parsed.detail;
            else if (typeof parsed?.error === "string") message = parsed.error;
          } catch {
            if (errText.trim()) message = errText.trim();
          }
          console.error(
            "Preview layout API error:",
            res.status,
            "Payload:",
            JSON.stringify(body, null, 2),
            "Response:",
            errText,
          );
          void previewPerfLog("preview-layout FAIL", {
            ms: Math.round(performance.now() - _tPrev),
            status: res.status,
          });
          if (gen === previewGenRef.current) {
            setLayoutResult(null);
            setIsLoading(false);
            setPreviewError(message);
            if (onCapacityChangeRef.current) onCapacityChangeRef.current(0);
          }
          return;
        }

        const data: BackendLayoutResult = await res.json();
        void previewPerfLog("preview-layout OK", {
          ms: Math.round(performance.now() - _tPrev),
          items: data.totalItems ?? (data.cells?.length ?? 0),
          strategy: data.strategyUsed || "",
          mixed: !!(data as any).isMixedPreview,
        });

        // Only apply if this request wasn't aborted AND still latest generation
        if (!controller.signal.aborted && gen === previewGenRef.current) {
          if (data.success) {
            // Convert response from points → mm for SVG rendering
            // Frontend does NOT modify rotation flags — backend is single source of truth
            let cells = data.cells.map((cell) => ({
              ...cell,
              x: cell.x * PT_TO_MM,
              y: cell.y * PT_TO_MM,
              absX: cell.absX != null ? cell.absX * PT_TO_MM : undefined,
              absY: cell.absY != null ? cell.absY * PT_TO_MM : undefined,
              width: cell.width * PT_TO_MM,
              height: cell.height * PT_TO_MM,
              // Đường bế THẬT (backend đã áp đúng transform của file xuất) — pt→mm,
              // toạ độ TOP-DOWN trang. Frontend chỉ vẽ y nguyên, KHÔNG tự xoay/lật.
              diePolylines: (cell as any).diePolylines
                ? (cell as any).diePolylines.map((pl: number[][]) =>
                    pl.map(([px, py]) => [px * PT_TO_MM, py * PT_TO_MM]),
                  )
                : undefined,
            }));

            // Failsafe ratio_stack: backend vẫn trả > viewerPageCount loại
            // (file 10 trang + total_pages bị bỏ) → gán lại pageIdx theo viewer.
            if (
              layoutType === "ratio_stack" &&
              viewerPageCount > 0 &&
              (data.isMixedPreview || cells.some((c) => c.pageIdx != null))
            ) {
              const uniq = new Set(
                cells.map((c) => (c as any).pageIdx).filter((p) => typeof p === "number"),
              );
              if (uniq.size > viewerPageCount) {
                console.warn(
                  `[GridPreview] ratio_stack backend ${uniq.size} loại > viewer ${viewerPageCount} — gán lại client`,
                );
                cells = reassignRatioStackPageIdx(
                  cells,
                  viewerPageCount,
                  targetQuantitiesByPage,
                  Number(targetQuantity) || 0,
                );
              }
            }

            const convertedResult: BackendLayoutResult = {
              ...data,
              overallWidth: data.overallWidth * PT_TO_MM,
              overallHeight: data.overallHeight * PT_TO_MM,
              cells,
              // cutLines (chia cụm) — pt→mm, cùng không gian abs với cells.
              cutLines: data.cutLines
                ? {
                    v: (data.cutLines.v || []).map((x: number) => x * PT_TO_MM),
                    h: (data.cutLines.h || []).map((y: number) => y * PT_TO_MM),
                  }
                : undefined,
              // sheets (chia cụm zone modes) — convert MỌI tờ pt→mm để lật không fetch lại.
              sheets: Array.isArray((data as any).sheets)
                ? (data as any).sheets.map((sh: any) => ({
                    overallWidth: (sh.overallWidth || 0) * PT_TO_MM,
                    overallHeight: (sh.overallHeight || 0) * PT_TO_MM,
                    totalItems: sh.totalItems || 0,
                    cells: (sh.cells || []).map((cell: any) => ({
                      ...cell,
                      x: cell.x * PT_TO_MM,
                      y: cell.y * PT_TO_MM,
                      absX: cell.absX != null ? cell.absX * PT_TO_MM : undefined,
                      absY: cell.absY != null ? cell.absY * PT_TO_MM : undefined,
                      width: cell.width * PT_TO_MM,
                      height: cell.height * PT_TO_MM,
                      // diePolylines (đường bế THẬT, pt top-down) → mm, KHỚP đơn vị cells.
                      diePolylines: cell.diePolylines
                        ? cell.diePolylines.map((pl: number[][]) =>
                            pl.map(([px, py]) => [px * PT_TO_MM, py * PT_TO_MM]),
                          )
                        : undefined,
                    })),
                    cutLines: sh.cutLines
                      ? {
                          v: (sh.cutLines.v || []).map((x: number) => x * PT_TO_MM),
                          h: (sh.cutLines.h || []).map((y: number) => y * PT_TO_MM),
                        }
                      : undefined,
                  }))
                : undefined,
            };
            setActiveSheet(0);
            layoutKeyRef.current = layoutFetchKey;
            layoutCacheRef.current = convertedResult;
            setLayoutResult(convertedResult);
            setPreviewError(null);
            if (onCapacityChangeRef.current)
              onCapacityChangeRef.current(convertedResult.totalItems);
            if (onMixedPlacedByPageRef.current) {
              const pbp = (data as any).placedByPage;
              if (
                layoutType === "ratio_stack" &&
                viewerPageCount > 0 &&
                cells.some((c) => c.pageIdx != null)
              ) {
                // Đếm từ cells đã (có thể) gán lại.
                const m: Record<number, number> = {};
                for (const cell of cells) {
                  const pi = (cell as any).pageIdx;
                  if (typeof pi === "number" && pi < viewerPageCount) {
                    m[pi] = (m[pi] || 0) + 1;
                  }
                }
                onMixedPlacedByPageRef.current(m);
              } else if (pbp && typeof pbp === "object") {
                const m: Record<number, number> = {};
                Object.keys(pbp).forEach((k) => {
                  m[Number(k)] = pbp[k];
                });
                onMixedPlacedByPageRef.current(m);
              } else if (data.isMixedPreview && Array.isArray(data.cells)) {
                const m: Record<number, number> = {};
                for (const cell of data.cells) {
                  const pi = (cell as any).pageIdx;
                  if (typeof pi === "number") m[pi] = (m[pi] || 0) + 1;
                }
                onMixedPlacedByPageRef.current(m);
              } else {
                onMixedPlacedByPageRef.current({});
              }
            }
          } else {
            setLayoutResult(null);
            if (onCapacityChangeRef.current) onCapacityChangeRef.current(0);
            // UIUX (audit 2026-07-27 §B-05): giữ nội dung lỗi backend, nối gợi ý khắc phục khi lỗi quá khổ/không vừa
            const beMsg = data.error || t('imposition.gridPreview:khong_the_tinh_bo_cuc_preview', 'Không thể tính bố cục preview.');
            const oversizeHint = /không vừa|quá khổ|exceed|too large/i.test(beMsg)
              ? t('imposition.gridPreview:goi_y_qua_kho', ' — thử giảm số hàng/cột, tăng khổ giấy hoặc giảm lề.')
              : '';
            setPreviewError(beMsg + oversizeHint);
          }
          setIsLoading(false);
        }
      } catch (err: any) {
        if (err.name !== "AbortError" && gen === previewGenRef.current) {
          console.error("Preview layout fetch error:", err);
          setLayoutResult(null);
          setIsLoading(false);
          // UIUX (audit 2026-07-27 §B-05): formatError thay vì err.message thô
          setPreviewError(formatError(err, t('imposition.gridPreview:khong_dung_duoc_preview_bo_cuc', 'Không dựng được preview bố cục')));
          if (onCapacityChangeRef.current) onCapacityChangeRef.current(0);
        }
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
    // Một khóa layoutFetchKey gộp toàn bộ input xếp tem (không gồm pageIdx view).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional single-key cache
  }, [layoutFetchKey]);

  // LƯU Ý: kiểm tra sheetWidth/sheetHeight <= 0 được dời xuống SAU svgCells useMemo
  // (hook cuối) để không gọi hook có điều kiện → tránh React #300 crash.

  // ── N-Up "Dàn nhiều mẫu": tổng con cần = SL mỗi loại × số mẫu (SL trống → lấp đầy 1 tờ).
  //    "Cần in" theo tổng con; căn giữa CHỈ khi đúng 1 tờ (nhiều tờ giữ vị trí full layout).
  //    ratio_stack: backend trả sheetsNeeded (mọi mẫu chung 1 số tờ) — ưu tiên dùng.
  const _cap = layoutResult?.totalItems ?? 0;
  const _isRatioStack = layoutType === "ratio_stack";
  const _isCutStacks = layoutType === "cut_stacks";
  const _isNupFill = !isDieCut && taskMode === "nup" && _cap > 0 && !_isRatioStack && !_isCutStacks;
  const _qtyPerType = Number(targetQuantity) || 0;
  const _nupTotal = _isNupFill
    ? (() => {
        // Ưu tiên tổng SL từng trang nếu có; không thì qty global × số mẫu.
        const byPage = targetQuantitiesByPage || {};
        const count = Math.max(1, sourceTotalPages || 1);
        let sum = 0;
        let hasRequestedQuantity = false;
        for (let idx = 0; idx < count; idx++) {
          const hasOverride = Object.prototype.hasOwnProperty.call(byPage, idx);
          const value = Number(hasOverride ? (byPage as any)[idx] : _qtyPerType);
          if (Number.isFinite(value) && value > 0) {
            sum += value;
            hasRequestedQuantity = true;
          } else if (hasOverride) {
            // Explicit zero stays zero instead of inheriting the global value.
            hasRequestedQuantity = true;
          }
        }
        return hasRequestedQuantity ? sum : _cap;
      })()
    : null;

  let totalSheets = 1;
  if (layoutResult && layoutResult.totalItems > 0) {
    if (layoutResult.sheetsNeeded != null && layoutResult.sheetsNeeded > 0) {
      totalSheets = layoutResult.sheetsNeeded;
    } else if (_nupTotal != null) {
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

    // SSOT: backend đã trả toạ độ TUYỆT ĐỐI (sau căn giữa + va chạm). Frontend CHỈ vẽ.
    const useAbs = !!layoutResult.absPlacement;

    // Chia cụm zone modes: lật giữa nhiều tờ → lấy cells tờ đang chọn (nếu có).
    const _sheetArr = layoutResult.sheets;
    const _cellsForSheet = (_sheetArr && _sheetArr[activeSheet]?.cells)
      ? _sheetArr[activeSheet].cells
      : layoutResult.cells;

    return _cellsForSheet.map((cell, idx) => {
      let svgX_mm: number;
      let svgY_mm: number;

      if (useAbs && cell.absX != null && cell.absY != null) {
        // abs gốc dưới-trái tờ, Y hướng lên → SVG (Y hướng xuống):
        //   svgX = absX ; svgY = sheetHeight − absY − height
        svgX_mm = cell.absX;
        svgY_mm = sheetHeight - cell.absY - cell.height;
      } else {
        // Đường lưới tương đối (N-Up không die-cut): PDF coords → SVG (y-flip).
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
        blockId: resolvePreviewCellType(
          (cell as any).pageIdx ?? cell.blockId,
          pageIdx,
          taskMode,
          !!isDieCut,
        ),
        // Đường bế THẬT → pixel (mm top-down * scale). Vẽ y nguyên, không xoay/lật.
        diePolylinesPx: (cell as any).diePolylines
          ? (cell as any).diePolylines.map((pl: number[][]) =>
              pl.map(([xm, ym]) => [pad + xm * scale, pad + ym * scale]),
            )
          : undefined,
        idx,
      };
    });
  }, [
    layoutResult,
    activeSheet,
    svgBaseX,
    svgBaseYConst,
    scale,
    pad,
    sheetHeight,
    pageIdx,
    taskMode,
    isDieCut,
  ]);

  // Sau khi MỌI hook đã chạy mới được return sớm (xem ghi chú phía trên).
  if (sheetWidth <= 0 || sheetHeight <= 0) return null;

  // Usable area in SVG pixels
  const uaX = pad + marginLeft * scale;
  const uaY = pad + marginTop * scale;
  const uaW = usableW * scale;
  const uaH = usableH * scale;

  // ── Đường xén cụm (chia cụm / zone) → pixel. cutLines (mm) gốc dưới-trái Y-up:
  //   v = hoành độ (x), h = tung độ (y). SVG: x = pad + v*scale ; y = pad + (H - y)*scale.
  const _sheetArrCuts = layoutResult?.sheets;
  const _cutLines = ((_sheetArrCuts && _sheetArrCuts[activeSheet]?.cutLines)
    ? _sheetArrCuts[activeSheet].cutLines
    : (layoutResult as any)?.cutLines) as { v?: number[]; h?: number[] } | undefined;
  const cutVpx = (_cutLines?.v || []).map((v) => pad + v * scale);
  const cutHpx = (_cutLines?.h || []).map((h) => pad + (sheetHeight - h) * scale);

  // Lật gương Mặt sau theo cạnh lật (CNC). Mặc định long-edge = lật ngang.
  const _isCncPreview = !!(layoutResult as any)?.isCncPreview;
  const _cncShortFlip =
    _isCncPreview &&
    ((layoutResult as any)?.cncFlipEdge || cncFlipEdge) === "short";
  // CNC mặt sau = PHẢN CHIẾU thật, KHỚP output cnc_render (mirror_x/mirror_y):
  //   long-edge → lật NGANG quanh tâm tờ; short-edge → lật DỌC.
  // Phép scale ở mức GROUP phản chiếu CẢ vị trí lẫn nội dung (giống duplex thường),
  // text được un-flip để vẫn đọc xuôi. KHÔNG lật vị trí / đảo xoay từng ô nữa
  // (mô hình cũ làm preview lệch output & mặt sau mất đối xứng).
  const backGroupTransform = _cncShortFlip
    ? `translate(0, ${svgH}) scale(1, -1)`
    : `translate(${svgW}, 0) scale(-1, 1)`;
  const backTextUnflip = (cx: number, cy: number) =>
    _cncShortFlip
      ? `translate(${cx}, ${cy}) scale(1, -1) translate(-${cx}, -${cy})`
      : `translate(${cx}, ${cy}) scale(-1, 1) translate(-${cx}, -${cy})`;

  // Nhãn ô: 2 mặt (ratio_stack HOẶC sequential) → đánh cặp "1a/1b" theo SỐ LOẠI
  // (a=mặt trước, b=mặt sau). Mỗi loại = cặp trang trước/sau; blockId là trang chẵn 2u
  // (0-based) nên loại = floor(blockId/2)+1. Không đổi → hiện số trang thô gây hiểu lầm
  // (loại 7 hiện "13" thay vì "7a"). Các mode 1 mặt giữ số trang thô.
  const _isPairDuplex =
    duplexFlow === "double" &&
    (_isRatioStack || layoutType === "sequential");
  const cellLabel = (blockId: number, isBack: boolean): string | number => {
    if (_isPairDuplex)
      return `${Math.floor(blockId / 2) + 1}${isBack ? "b" : "a"}`;
    if (isBack && _isCncPreview && (layoutResult as any)?.cncTwoSided)
      return blockId + 2;
    return blockId + 1;
  };

  // Mặt sau dùng CHÍNH ô mặt trước — phản chiếu do backGroupTransform đảm nhiệm.
  const cncBackCells = svgCells;

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
          <div className="flex items-center gap-4 text-[13px] font-medium flex-wrap justify-center">
            <div className="text-slate-600 dark:text-zinc-400">
              {t('imposition.gridPreview:suc_chua')}{" "}
              <span className="font-bold text-slate-800 dark:text-zinc-200">
                {/* Homogeneous: totalItems là SỨC CHỨA hình học; cells.length chỉ là
                    số mẫu hiện có. Hai khái niệm này tuyệt đối không được trộn. */}
                {layoutResult.isHomogeneousPreview
                  ? layoutResult.totalItems
                  : layoutResult.sheets && layoutResult.sheets.length > 1
                    ? svgCells.length
                    : _showCount < layoutResult.totalItems
                      ? `${_showCount} / ${layoutResult.totalItems}`
                      : layoutResult.totalItems}
              </span>{" "}
              {t('imposition.gridPreview:tem_to')}
            </div>
            {layoutResult.isHomogeneousPreview &&
              typeof layoutResult.totalContentItems === "number" && (
                <>
                  <div className="w-px h-4 bg-slate-300 dark:bg-zinc-700"></div>
                  <div className="text-slate-600 dark:text-zinc-400">
                    {t('imposition.gridPreview:dang_ghep')}{" "}
                    <span className="font-bold text-emerald-600 dark:text-emerald-400">
                      {layoutResult.totalContentItems}
                    </span>{" "}
                    {t('imposition.gridPreview:mau')}
                  </div>
                </>
              )}
            {!_isCutStacks &&
              (Number(targetQuantity) > 0 ||
              _isRatioStack ||
              Object.values(targetQuantitiesByPage || {}).some((v) => Number(v) > 0)) && (
              <>
                <div className="w-px h-4 bg-slate-300 dark:bg-zinc-700"></div>
                <div className="text-slate-600 dark:text-zinc-400">
                  {t('imposition.gridPreview:can_in')}{" "}
                  <span className="font-bold text-indigo-600 dark:text-indigo-400">
                    {totalSheets}
                  </span>{" "}
                  {t('imposition.gridPreview:to')}
                  {_isRatioStack && (
                    <span className="text-[11px] text-slate-400 ml-1">
                      {t('imposition.gridPreview:1_to_mau_x_ban', { n: totalSheets })}
                    </span>
                  )}
                </div>
              </>
            )}
            {/* Kích thước tem thành phẩm — CHỈ bình cắt xén (N-Up guillotine).
                Ẩn tem bế + CNC (isDieCut): kích thước ô SVG không phải “tem thành phẩm” xén. */}
            {!isDieCut && visibleCells.length > 0 && scale > 0 && (
              <>
                <div className="w-px h-4 bg-slate-300 dark:bg-zinc-700"></div>
                <div className="text-slate-600 dark:text-zinc-400">
                  {t('imposition.gridPreview:tem_thanh_pham')}{" "}
                  <span className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                    {(visibleCells[0].sw / scale).toFixed(1)} × {(visibleCells[0].sh / scale).toFixed(1)} mm
                  </span>
                </div>
              </>
            )}
          </div>
          {/* Chia cụm zone modes: nút lật giữa các tờ (mỗi tờ 1 bộ loại khác nhau). */}
          {layoutResult.sheets && layoutResult.sheets.length > 1 && (
            <div className="flex items-center gap-3 text-[13px] font-medium">
              <button
                type="button"
                onClick={() => setActiveSheet((s) => Math.max(0, s - 1))}
                disabled={activeSheet <= 0}
                className="w-7 h-7 flex items-center justify-center rounded border border-slate-300 dark:border-white/20 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-300 disabled:opacity-40 hover:border-indigo-500 disabled:hover:border-slate-300"
              >
                ◄
              </button>
              <span className="text-slate-700 dark:text-zinc-200 tabular-nums">
                {t('imposition.gridPreview:to')} {activeSheet + 1} / {layoutResult.sheets.length}
              </span>
              <button
                type="button"
                onClick={() => setActiveSheet((s) => Math.min((layoutResult.sheets?.length || 1) - 1, s + 1))}
                disabled={activeSheet >= (layoutResult.sheets.length - 1)}
                className="w-7 h-7 flex items-center justify-center rounded border border-slate-300 dark:border-white/20 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-300 disabled:opacity-40 hover:border-indigo-500 disabled:hover:border-slate-300"
              >
                ►
              </button>
            </div>
          )}
          {/* Chú thích động: người dùng học bằng mắt — 1 câu tiếng người mô tả preview.
              _isClusterType = dàn nhiều loại (ratio_stack) + đã chọn chia cọc → mỗi cọc
              1 loại riêng, bề rộng theo SL. */}
          {(() => {
            const _isClusterType =
              _isRatioStack && clusterMode && clusterMode !== "none";
            const _nTypes = layoutResult.isHomogeneousPreview &&
              typeof layoutResult.totalContentItems === "number"
              ? layoutResult.totalContentItems
              : new Set(
                  (layoutResult.cells || [])
                    .map((c) => (c as any).pageIdx)
                    .filter((p) => typeof p === "number"),
                ).size;
            if (_isClusterType && _nTypes > 0) {
              const _dir = clusterMode === "row" ? t('imposition.gridPreview:hang_ngang') : t('imposition.gridPreview:cot_doc');
              return (
                <div className="text-[12px] text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 rounded px-2 py-1 w-full text-center">
                  {t('imposition.gridPreview:n_loai_moi_loai_1_coc_rieng_in_to', { n: _nTypes, dir: _dir, sheets: totalSheets })}
                </div>
              );
            }
            if (_isRatioStack && _nTypes > 0) {
              return (
                <div className="text-[12px] text-slate-500 dark:text-zinc-400 text-center w-full">
                  {t('imposition.gridPreview:n_loai_tron_theo_ty_le_in_to', { n: _nTypes, sheets: totalSheets })}
                </div>
              );
            }
            return null;
          })()}
          {_isRatioStack &&
            Array.isArray(layoutResult.ratioUnplaced) &&
            layoutResult.ratioUnplaced.length > 0 && (
              <div className="text-[12px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded px-2 py-1 w-full text-center">
                {t('imposition.gridPreview:khong_du_cho_tren_to_cho_trang_tach', { pages: layoutResult.ratioUnplaced.map((i) => i + 1).join(", ") })}
              </div>
            )}

          {/* SVG Wireframe */}
          {layoutResult.cells.length > 0 && (
            <div className="flex gap-6 items-center justify-center w-full overflow-x-auto pb-2 custom-scrollbar">
              {/* Front Side */}
              <div
                className="relative cursor-pointer group flex-shrink-0"
                onClick={() => setExpanded(!expanded)}
                title={expanded ? t('imposition.gridPreview:thu_gon') : t('imposition.gridPreview:phong_to_xem_chi_tiet')}
              >
                {duplexFlow === "double" && (
                  <div className="text-center text-[11px] font-bold text-slate-500 mb-2">
                    {t('imposition.gridPreview:mat_truoc')}
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

                  {/* Đường xén guillotine giữa các cụm/vùng (chia cụm) */}
                  {(cutVpx.length > 0 || cutHpx.length > 0) && (
                    <g stroke="#0ea5e9" strokeWidth={0.7} strokeDasharray="5,3" opacity={0.85}>
                      {cutVpx.map((x, i) => (
                        <line key={`cv${i}`} x1={x} y1={pad} x2={x} y2={pad + sheetHeight * scale} />
                      ))}
                      {cutHpx.map((y, i) => (
                        <line key={`ch${i}`} x1={pad} y1={y} x2={pad + sheetWidth * scale} y2={y} />
                      ))}
                    </g>
                  )}

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
                    // Đường bế THẬT theo trang (mixed) → vẽ đúng contour mỗi ô (kể cả CUSTOM).
                    const itemDiePoly =
                      (isMixed && (layoutResult as any)?.diePolygonsByPage
                        ? (layoutResult as any).diePolygonsByPage[String(c.blockId)]
                        : null) ?? (layoutResult as any)?.diePolygon;
                    return (
                      <g key={c.idx}>
                        {(c as any).diePolylinesPx ? (
                          <polygon
                            points={(c as any).diePolylinesPx
                              .flat()
                              .map((pt: number[]) => `${pt[0]},${pt[1]}`)
                              .join(" ")}
                            fill={color.fill}
                            stroke={color.stroke}
                            strokeWidth={0.8}
                            strokeLinejoin="round"
                          />
                        ) : (
                          renderCellShape(
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
                            itemDiePoly,
                          )
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
                            {cellLabel(c.blockId, false)}
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
                  {expanded ? t('imposition.gridPreview:thu_gon_2') : t('imposition.gridPreview:phong_to')}
                </div>
              </div>

              {/* Back Side */}
              {duplexFlow === "double" && (
                <div
                  className="relative cursor-pointer group flex-shrink-0"
                  onClick={() => setExpanded(!expanded)}
                  title={expanded ? t('imposition.gridPreview:thu_gon') : t('imposition.gridPreview:phong_to_xem_chi_tiet')}
                >
                  <div className="text-center text-[11px] font-bold text-slate-500 mb-2">
                    {t('imposition.gridPreview:mat_sau')}
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

                        // Đường bế THẬT theo trang (CNC mixed) → contour đúng mỗi ô.
                        const itemDiePoly =
                          (isMixed && (layoutResult as any)?.diePolygonsByPage
                            ? (layoutResult as any).diePolygonsByPage[String(c.blockId)]
                            : null) ?? (layoutResult as any)?.diePolygon;

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
                              itemDiePoly,
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
                                {cellLabel(c.blockId, true)}
                              </text>
                            )}
                          </g>
                        );
                      })}
                    </g>
                  </svg>

                  <div className="absolute bottom-1 right-1 bg-white/80 dark:bg-zinc-800/80 rounded px-1.5 py-0.5 text-[9px] text-slate-400 dark:text-zinc-500 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                    {expanded ? t('imposition.gridPreview:thu_gon_2') : t('imposition.gridPreview:phong_to')}
                  </div>
                </div>
              )}
            </div>
          )}

          {isDetectingShape && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400 animate-pulse font-medium">
              {t('imposition.gridPreview:dang_nhan_dien_hinh_dang_tem')}
            </div>
          )}
        </div>
      ) : (
        <div className="text-sm text-slate-500 flex items-center gap-2">
          {previewError ? (
            <span className="text-red-600 dark:text-red-400 text-center">{previewError}</span>
          ) : isDetectingShape ? (
            t('imposition.gridPreview:dang_nhan_dien_hinh_dang_tem')
          ) : isLoading ? (
            <>
              <div className="w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              {t('imposition.gridPreview:dang_tinh_toan_bo_cuc')}
            </>
          ) : (
            t('imposition.gridPreview:chua_co_du_lieu_bo_cuc')
          )}
        </div>
      )}
    </div>
  );
}
