import React, { useEffect, useMemo, useRef, useState } from "react";
import { authenticatedFetch, getApiUrl, uploadPDF } from "../../../lib/api";
import { previewPerfLog } from "../../../lib/previewPerfLog";
import { getFileArrayBuffer } from "../../../lib/utils";
import type { ActiveToolType, CutBorderConfig, NupSettings, PontConfig } from "../types";
import { inheritedSingleMoldMaster } from "../shapeDetectionPolicy";
import { materializePreviewViewerPdf, parsePreviewViewerState, previewViewerStateRequiresMaterialization, resolvePreviewCellType, resolvePreviewPageCount, shouldDeferPreviewLayout } from "../previewSourcePolicy";
import { canUseCutBorder } from "../cutBorderPolicy";
import { useTranslation } from 'react-i18next';
import { ImposerSettingsContext } from "../useImposerSettingsStore";
// UIUX (audit 2026-07-27 §B-05): lỗi kỹ thuật → câu Việt + hướng khắc phục
import { formatError } from "../../../lib/errorMessages";
import {
  cancelNestingPreviewJob,
  createNestingPreviewJob,
  getNestingPreviewJobResult,
  waitForNestingPreviewJob,
  type NestingPreviewJobProgress,
} from "../../../lib/mixed-nesting/api";
// §B10: preview PHẢI quyết định true-shape giống backend route_true_shape (auto-route theo
// phân loại hình), không còn theo option thủ công gridStrategy==='true_shape_nesting'.
import {
  TRUE_SHAPE_NESTING_ENABLED,
  shouldUseTrueShapeNesting,
  trueShapeJobMembershipKey,
} from "../trueShapeNestingRollout";
import { resolveCellDirectionDegrees, resolveTrapezoidPreviewRatios, shouldAutoSwitchToMixedGuillotine, type CellDirectionDegrees } from "./gridPreviewHelpers";

// UIUX (audit 2026-09-05 §PV26.2): nhận mã job hoặc status chưa có số đo
// chỉ cho biết phase; không được biến thành 0%/100% do frontend tự đặt.
type PreviewNestingProgress = Omit<NestingPreviewJobProgress, "progress"> & {
  progress?: number;
};

export interface GridPreviewProps {
  /** Tab nền vẫn mounted; false phải dừng job và cấm kết quả cũ ghi vào store. */
  isActive?: boolean;
  activeTool?: ActiveToolType | string;
  taskMode: string;
  isDieCut?: boolean;
  pageSheetMode?: boolean;
  /** Cách thức ráp N-Up: sequential | cut_stacks | ratio_stack | repeat */
  layoutType?: NupSettings["layoutType"] | string;
  /** 1 mặt / 2 mặt — sequential 2 mặt ghép cặp trang trước/sau */
  duplexFlow?: string;
  /** Cạnh lật của mặt sau khi Dàn nhiều kích thước. */
  duplexFlipEdge?: "long" | "short";
  /** §MG-A2: % in dư cho phép để gom bản kẽm (Dàn nhiều kích thước). */
  mixedExcessPercent?: number;
  gridStrategy: NupSettings["gridStrategy"];
  /** Xoay 180° xen kẽ theo hàng/cột; chỉ áp dụng cho bình cắt xén cùng khổ. */
  alternateRotation?: NupSettings["alternateRotation"];
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
  /** [PREVIEW-UNIT FIX 2026-08-06] Kích thước tem theo ĐIỂM (pt) lấy thẳng từ trang nguồn.
   *  itemW/itemH đã qua vòng pt→mm→pt (0.352778 × 2.83465 ≈ 1.0000021) nên nở thêm
   *  ~0.003 pt; với khổ vừa khít (500×330 vào 1500×990) mức nở đó vượt dung sai
   *  EPS=0.01pt của solver → mất hẳn một cột (9 con thành 7). Có pt thì dùng pt. */
  itemWPt?: number;
  itemHPt?: number;
  targetQuantity?: number | string;
  targetQuantitiesByPage?: Record<number, number>;
  /** Tổng số mẫu nguồn hiện có — dùng để phân bổ và tự động lấp đầy preview. */
  sourceTotalPages?: number;
  shapeParams?: string | null;
  shapesByPage?: Record<number, string>;
  shapeParamsByPage?: Record<number, Record<string, unknown>>;
  isDetectingShape?: boolean;
  pontType?: string;
  pontConfig?: PontConfig;
  /** Cấu hình gia công phải đi cùng phiên nesting để export render đúng manifest preview. */
  separateCutPage?: boolean;
  pontsOnCutFile?: boolean;
  exportUniqueSheets?: boolean;
  reportDisplay?: NupSettings["reportDisplay"];
  reportMaterial?: string;
  reportLamination?: number;
  reportLaminationSides?: number;
  reportOrderCode?: string;
  /** Admission true-shape: override OCG chưa materialize phải giữ lane legacy. */
  hiddenOcgLayerIds?: readonly (string | number)[];
  saveByReport?: boolean;
  onCapacityChange?: (capacity: number) => void;
  onMixedPlacedByPage?: (m: Record<number, number>) => void;
  fileId?: string;
  filePath?: string;
  pageIdx?: number;
  bleed?: number; // in mm
  cutBorder?: CutBorderConfig;
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
  cncDuplexMarks?: boolean;
  cutType?: string;
  fillBlockGap?: number;
  dieSizeMode?: "die" | "page";
  dieOffsetMm?: number;
  /** PDF đã bake chỉnh sửa viewer — parity preview≡output (không đọc file gốc). */
  getWorkingFile?: () => Promise<File>;
  /** OCG explicit bắt buộc resolver thành công; cấm fallback source path/file ID. */
  requiresWorkingSource?: boolean;
  /** Đổi khi xoay/xóa/sắp trang hoặc OCG → invalidate cache path preview. */
  previewSourceKey?: string;
  /** Mã đối chiếu cục bộ của một tab/tài liệu; không chứa tên hay đường dẫn file. */
  diagnosticTraceId?: string;
  onDiagnosticEvent?: (event: GridPreviewDiagnosticEvent) => void;
}

export interface GridPreviewDiagnosticEvent {
  traceId: string;
  requestId: string;
  generation: number;
  phase: "pending" | "applied" | "failed" | "aborted" | "stale";
  capacity?: number;
  /** Quyết định engine lưới đã chốt; được giữ cả khi probe per-view pending/failed. */
  forceLegacyGrid?: boolean;
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
  /** Đường bế thật theo polyline (vòng hoàn chỉnh hoặc mảnh l/c), cùng hệ tọa độ backend. */
  diePolylines?: number[][][];
}
interface BackendCutSegment {
  axis: "x" | "y";
  coordinate: number;
  start: number;
  end: number;
  kind?: string;
}

interface BackendLayoutSheet {
  cells: BackendLayoutCell[];
  overallWidth: number;
  overallHeight: number;
  totalItems: number;
  /** S&R hybrid: engine đã chọn riêng cho chính tờ này. */
  strategyUsed?: string;
  absPlacement?: boolean;
  cutLines?: { v: number[]; h: number[] };
  cutSegments?: BackendCutSegment[];
  cutTree?: { rect?: { x: number; y: number; width: number; height: number } };
  side?: "front" | "back";
  physicalSheetIndex?: number;
  runCount?: number;
  planHash?: string;
  planVersion?: string;
  coordinateSpace?: string;
  usableRect?: { x: number; y: number; width: number; height: number };
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
  diePolygonsByPage?: Record<string, number[][]>;
  isCncPreview?: boolean;
  cncFlipEdge?: "long" | "short";
  cncTwoSided?: boolean;
  /** ratio_stack / CNC: số tờ logic cần in (PDF có thể chỉ 1 trang mẫu). */
  sheetsNeeded?: number;
  /** Chế độ 1 khuôn dùng chung cho mọi trang nội dung. */
  isHomogeneousPreview?: boolean;
  /** Tổng số mẫu của toàn bộ job; có thể lớn hơn số ô của tờ đang xem. */
  totalContentItems?: number;
  /** ratio_stack: chỉ số mẫu có SL>0 nhưng không đủ chỗ trên tờ. */
  ratioUnplaced?: number[];
  /** Số ô đã gán theo trang nguồn trên tờ đại diện. */
  placedByPage?: Record<string, number>;
  /** chia cụm: kiểu ghép đã dùng (replicate_mixed / zone_per_type / zone_ratio). */
  clusterCombineMode?: string;
  /** chia cụm: đường xén guillotine giữa các cụm/vùng (pt, cùng không gian abs với cells). */
  cutLines?: { v: number[]; h: number[] };
  cutSegments?: BackendCutSegment[];
  planHash?: string;
  planVersion?: string;
  coordinateSpace?: string;
  duplex?: boolean;
  flipEdge?: "long" | "short";
  /** §MG-A2: ngưỡng in dư backend đã dùng để gom bản kẽm. */
  excessTolerance?: number;
  /** §MG-B2: cảnh báo nghiệp vụ (lề bất đối xứng khi lật) — không phải lỗi. */
  warnings?: string[];
  /** chia cụm zone modes: MỌI tờ (mỗi tờ 1 bộ loại) để lật ◄ n/N ► không fetch lại. */
  sheets?: BackendLayoutSheet[];
}

/**
 * B10-6: chỉ publication true-shape có đủ danh tính trang nguồn mới được tái dùng
 * khi viewer cuộn trang. `physicalSheetIndex` là thứ tự tờ đã nén, không phải pageIdx.
 */
function hasReusableStepRepeatSheets(result: BackendLayoutResult): boolean {
  return ["true_shape_nesting", "per_design_best"].includes(result.strategyUsed)
    && Array.isArray(result.sheets)
    && result.sheets.length > 0
    && result.sheets.every((sheet) => (
      Array.isArray(sheet.cells)
      && sheet.cells.length > 0
      && sheet.cells.every((cell) => Number.isInteger(cell.pageIdx))
    ));
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

type WorkspaceFileLike = File & { path?: string };
type RuntimeWindow = Window & { __TAURI_INTERNALS__?: unknown };
type SvgPreviewCell = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  isRotated: boolean;
  is180: boolean;
  blockId: number;
  diePolylinesPx?: number[][][];
  idx: number;
};

function numericShapeProp(props: Record<string, unknown> | null, key: string, fallback: number): number {
  const value = props?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pageValue<T>(map: Record<number, T> | undefined, page: number): T | undefined {
  if (!map) return undefined;
  const byString = map as unknown as Record<string, T>;
  return map[page] ?? byString[String(page)];
}

/**
 * Chuẩn hóa số lượng/capacity trước khi đưa vào phép chia hiển thị.
 *
 * UI có thể nhận chuỗi rỗng hoặc giá trị thập phân từ input number; S&R luôn
 * tính theo số tem nguyên và không cho phép số âm. Giữ helper thuần để tránh
 * một giá trị bất thường làm NaN lan vào dòng "Cần in".
 */
function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/** Lấy SL của đúng trang đang xem; override hiện diện (kể cả 0) thắng SL chung. */
function quantityForPage(
  pageIdx: number,
  targetQuantity: number | string | undefined,
  targetQuantitiesByPage: Record<number, number> | undefined,
): number {
  const hasOverride = targetQuantitiesByPage
    && Object.prototype.hasOwnProperty.call(targetQuantitiesByPage, pageIdx);
  const override = hasOverride ? pageValue(targetQuantitiesByPage, pageIdx) : undefined;
  return nonNegativeInteger(override !== undefined ? override : targetQuantity);
}

/**
 * Sức chứa của một mẫu trong Bình trang S&R.
 *
 * True-shape nhiều mẫu trả mỗi mẫu một `sheet`; `totalItems` là capacity hình
 * học của mẫu đó, còn `cells.length` chỉ là fallback cho payload cũ. Khi trang
 * đang xem không có sheet đại diện (SL=0), giữ tờ hiện hành/ tờ đầu để vẫn cho
 * người dùng một capacity hữu ích thay vì lấy `sheetsNeeded` của cả batch.
 */
function stepRepeatCapacityForPage(
  result: BackendLayoutResult,
  pageIdx: number,
  activeSheet: number,
): number {
  const sheets = result.sheets;
  if (Array.isArray(sheets) && sheets.length > 0) {
    const matching = sheets.find((sheet) => (
      Array.isArray(sheet.cells)
      && sheet.cells.some((cell) => cell.pageIdx === pageIdx)
    ));
    const selected = matching
      ?? sheets[activeSheet]
      ?? sheets.find((sheet) => Array.isArray(sheet.cells) && sheet.cells.length > 0)
      ?? sheets[0];
    const sheetCapacity = nonNegativeInteger(selected?.totalItems);
    if (sheetCapacity > 0) return sheetCapacity;
    const cellCapacity = nonNegativeInteger(selected?.cells?.length);
    if (cellCapacity > 0) return cellCapacity;
  }

  // Legacy/grid S&R không có `sheets`; placedByPage vẫn là capacity theo mẫu.
  const placed = result.placedByPage?.[String(pageIdx)];
  const placedCapacity = nonNegativeInteger(placed);
  if (placedCapacity > 0) return placedCapacity;
  return nonNegativeInteger(result.totalItems) || nonNegativeInteger(result.cells?.length);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "AbortError";
  if (error instanceof Error) return error.name === "AbortError";
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

interface LayoutConversionOptions {
  ptToMm: number;
  layoutType?: string;
  viewerPageCount: number;
  targetQuantitiesByPage?: Record<number, number>;
  targetQuantity: number;
}

/** B10-6: một đường đổi đơn vị dùng chung cho preview tạm và kết quả cuối. */
function convertLayoutResultToMm(
  data: BackendLayoutResult,
  options: LayoutConversionOptions,
): BackendLayoutResult {
  const { ptToMm, layoutType, viewerPageCount, targetQuantitiesByPage, targetQuantity } = options;
  const convertCell = (cell: BackendLayoutCell): BackendLayoutCell => ({
    ...cell,
    x: cell.x * ptToMm,
    y: cell.y * ptToMm,
    absX: cell.absX != null ? cell.absX * ptToMm : undefined,
    absY: cell.absY != null ? cell.absY * ptToMm : undefined,
    width: cell.width * ptToMm,
    height: cell.height * ptToMm,
    // Đường bế thật dùng đúng transform backend; frontend chỉ đổi đơn vị, không tự xoay/lật.
    diePolylines: cell.diePolylines
      ? cell.diePolylines.map((polyline) =>
          polyline.map(([x, y]) => [x * ptToMm, y * ptToMm]),
        )
      : undefined,
  });

  let cells = data.cells.map(convertCell);
  // Failsafe ratio_stack: backend cũ có thể trả nhiều loại hơn số trang viewer còn sống.
  if (
    layoutType === "ratio_stack"
    && viewerPageCount > 0
    && (data.isMixedPreview || cells.some((cell) => cell.pageIdx != null))
  ) {
    const uniquePages = new Set(
      cells.map((cell) => cell.pageIdx).filter((page): page is number => typeof page === "number"),
    );
    if (uniquePages.size > viewerPageCount) {
      console.warn(
        `[GridPreview] ratio_stack backend ${uniquePages.size} loại > viewer ${viewerPageCount} — gán lại client`,
      );
      cells = reassignRatioStackPageIdx(
        cells,
        viewerPageCount,
        targetQuantitiesByPage,
        targetQuantity,
      );
    }
  }

  return {
    ...data,
    overallWidth: data.overallWidth * ptToMm,
    overallHeight: data.overallHeight * ptToMm,
    cells,
    cutLines: data.cutLines
      ? {
          v: (data.cutLines.v || []).map((x) => x * ptToMm),
          h: (data.cutLines.h || []).map((y) => y * ptToMm),
        }
      : undefined,
    cutSegments: data.cutSegments
      ? data.cutSegments.map((line) => ({
          ...line,
          coordinate: line.coordinate * ptToMm,
          start: line.start * ptToMm,
          end: line.end * ptToMm,
        }))
      : undefined,
    // Đổi mọi tờ một lần để pager lật tức thì, không fetch lại.
    sheets: Array.isArray(data.sheets)
      ? data.sheets.map((sheet) => ({
          ...sheet,
          overallWidth: (sheet.overallWidth || 0) * ptToMm,
          overallHeight: (sheet.overallHeight || 0) * ptToMm,
          totalItems: sheet.totalItems || 0,
          usableRect: sheet.cutTree?.rect
            ? {
                x: Number(sheet.cutTree.rect.x) * ptToMm,
                y: Number(sheet.cutTree.rect.y) * ptToMm,
                width: Number(sheet.cutTree.rect.width) * ptToMm,
                height: Number(sheet.cutTree.rect.height) * ptToMm,
              }
            : undefined,
          cells: (sheet.cells || []).map(convertCell),
          cutLines: sheet.cutLines
            ? {
                v: (sheet.cutLines.v || []).map((x) => x * ptToMm),
                h: (sheet.cutLines.h || []).map((y) => y * ptToMm),
              }
            : undefined,
          cutSegments: Array.isArray(sheet.cutSegments)
            ? sheet.cutSegments.map((line) => ({
                ...line,
                coordinate: line.coordinate * ptToMm,
                start: line.start * ptToMm,
                end: line.end * ptToMm,
              }))
            : undefined,
        }))
      : undefined,
  };
}

function placedByPageForLayout(
  result: BackendLayoutResult,
  options: { layoutType?: string; viewerPageCount: number },
): Record<number, number> {
  const { layoutType, viewerPageCount } = options;
  if (
    layoutType === "ratio_stack"
    && viewerPageCount > 0
    && result.cells.some((cell) => cell.pageIdx != null)
  ) {
    const sourceCells = Array.isArray(result.sheets)
      ? result.sheets.flatMap((sheet) => sheet.cells || [])
      : result.cells;
    const counts: Record<number, number> = {};
    for (const cell of sourceCells) {
      const page = cell.pageIdx;
      if (typeof page === "number" && page < viewerPageCount) {
        counts[page] = (counts[page] || 0) + 1;
      }
    }
    return counts;
  }
  if (result.placedByPage && typeof result.placedByPage === "object") {
    const counts: Record<number, number> = {};
    for (const [key, value] of Object.entries(result.placedByPage)) {
      counts[Number(key)] = value;
    }
    return counts;
  }
  if (result.isMixedPreview) {
    const counts: Record<number, number> = {};
    for (const cell of result.cells) {
      if (typeof cell.pageIdx === "number") {
        counts[cell.pageIdx] = (counts[cell.pageIdx] || 0) + 1;
      }
    }
    return counts;
  }
  return {};
}

function waitForAbortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Đã hủy preview.", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Đã hủy preview.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const CELL_DIRECTION_STYLES: Record<
  CellDirectionDegrees,
  { arrow: string; background: string }
> = {
  0: { arrow: "#047857", background: "rgba(209, 250, 229, 0.96)" },
  90: { arrow: "#1d4ed8", background: "rgba(219, 234, 254, 0.96)" },
  180: { arrow: "#c2410c", background: "rgba(255, 237, 213, 0.96)" },
  270: { arrow: "#7e22ce", background: "rgba(243, 232, 255, 0.96)" },
};

/**
 * INKING (2026-08-12): hướng đầu nội dung sau khi cộng xoay bố cục (90°)
 * và xoay đối đầu (180°). Marker preview phải đọc đúng cả trường hợp 270°.
 */
function renderCellDirectionIndicator(
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  isRotated: boolean,
  isRotated180: boolean,
  side: "front" | "back",
) {
  const direction = resolveCellDirectionDegrees(isRotated, isRotated180);
  const directionStyle = CELL_DIRECTION_STYLES[direction];
  const cx = sx + sw / 2;
  const cy = sy + sh / 2;
  const shortSide = Math.min(sw, sh);
  const availableRadius = Math.max(1, shortSide / 2 - 0.75);
  // Marker lớn hơn bản cũ nhưng luôn chừa mép, kể cả ô tem rất mỏng.
  const radius = Math.min(
    9.5,
    availableRadius,
    Math.max(3.5, shortSide * 0.32),
  );
  const shaftTop = cy - radius * 0.34;
  const shaftBottom = cy + radius * 0.57;
  const tipY = cy - radius * 0.76;
  const wingY = cy - radius * 0.12;
  const wingX = radius * 0.39;

  return (
    <g
      data-testid="cell-direction-indicator"
      data-rotation={direction}
      data-direction-color={directionStyle.arrow}
      data-indicator-diameter={(radius * 2).toFixed(2)}
      data-side={side}
      aria-hidden="true"
      pointerEvents="none"
      transform={`rotate(${direction} ${cx} ${cy})`}
    >
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill={directionStyle.background}
        stroke={directionStyle.arrow}
        strokeWidth={0.9}
      />
      <line
        x1={cx}
        y1={shaftBottom}
        x2={cx}
        y2={shaftTop}
        stroke="white"
        strokeWidth={3.1}
        strokeLinecap="round"
      />
      <line
        x1={cx}
        y1={shaftBottom}
        x2={cx}
        y2={shaftTop}
        stroke={directionStyle.arrow}
        strokeWidth={1.65}
        strokeLinecap="round"
      />
      <path
        d={`M ${cx} ${tipY} L ${cx - wingX} ${wingY} L ${cx + wingX} ${wingY} Z`}
        fill={directionStyle.arrow}
        stroke="white"
        strokeWidth={0.45}
        strokeLinejoin="round"
      />
    </g>
  );
}

// =====================================================================
// Debounce delay for API calls (ms)
// =====================================================================
const DEBOUNCE_MS = 250;
// PERF (audit 2026-08-29 §NEST-SINGLEFLIGHT): solver sync không dừng chỉ vì browser
// abort request. Debounce dài hơn khi nesting gom chuỗi gõ report/mã đơn thành một lượt,
// tránh mỗi ký tự tạo một identity khác và khởi chạy thêm cold solve 16–40 giây.
const NESTING_DEBOUNCE_MS = 750;
const NESTING_CANCEL_MAX_ATTEMPTS = 3;
const NESTING_CANCEL_RETRY_MS = 120;
// B10-6: localhost treo cũng phải nhả trạng thái hủy trong thời gian hữu hạn.
const NESTING_CANCEL_ATTEMPT_TIMEOUT_MS = 2_000;

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
  shapeProps: Record<string, unknown> | null,
  idx: number,
  diePolygon?: number[][] | null,
  showInkingDirection = false,
) {
  const color = BLOCK_COLORS[blockId % BLOCK_COLORS.length];
  // Khi marker hướng đang hiển thị, giữ mọi ô cùng độ đậm; nếu vẫn làm mờ riêng
  // góc 180° thì người dùng dễ hiểu nhầm đó là ô bị vô hiệu hóa.
  const opacity = showInkingDirection
    ? 1
    : is180 && !isRotated
      ? ROTATED180_OPACITY
      : 1;

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
      const peakH = numericShapeProp(shapeProps, "peakHeightRatio", 0.25);
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
      const trapezoidRatios = resolveTrapezoidPreviewRatios(shapeProps);
      if (trapezoidRatios) {
        const {
          isHorizontal: isH,
          longRatio,
          shortRatio,
        } = trapezoidRatios;

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
      const waistRatio = numericShapeProp(shapeProps, "waistRatio", isDumbbell ? 0.35 : 0.4);
      const bigEndFrac =
        numericShapeProp(shapeProps, "bigDAlongAxisFrac", isDumbbell ? 0.3 : 0.37);

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

function renderCellDiePolylines(
  diePolylinesPx: number[][][] | undefined,
  blockId: number,
  side: "front" | "back",
) {
  type Point = [number, number];
  // Sai số rất nhỏ sau pt→mm→px; không nới rộng vì hai lỗ gần nhau vẫn phải
  // là hai vòng riêng, không được nối nhầm thành một contour.
  const endpointEpsilon = 0.05;
  const closeEnough = (a: Point, b: Point) =>
    Math.hypot(a[0] - b[0], a[1] - b[1]) <= endpointEpsilon;
  const reverse = (points: Point[]) => [...points].reverse();
  const withoutJoinEndpoint = (points: Point[]) => points.slice(1);
  const withoutPrependEndpoint = (points: Point[]) => points.slice(0, -1);

  const polylines = (diePolylinesPx || [])
    .map((polyline): Point[] => {
      const cleaned: Point[] = [];
      for (const point of polyline) {
        if (
          point.length < 2 ||
          !Number.isFinite(point[0]) ||
          !Number.isFinite(point[1])
        ) {
          continue;
        }
        const current: Point = [point[0], point[1]];
        // Chỉ bỏ điểm lặp thực sự; không dùng endpointEpsilon ở đây vì cung
        // Bézier sampled có thể có bước nhỏ khi preview thu nhỏ.
        if (
          !cleaned.length ||
          Math.hypot(
            cleaned[cleaned.length - 1][0] - current[0],
            cleaned[cleaned.length - 1][1] - current[1],
          ) > 1e-6
        ) {
          cleaned.push(current);
        }
      }
      return cleaned;
    })
    .filter((polyline) => polyline.length >= 2);

  const rings: Point[][] = [];
  const openCandidates: Point[][] = [];
  for (const polyline of polylines) {
    // re/qu đã khép vòng bằng điểm đầu lặp lại; bỏ điểm lặp để Z không tạo
    // thêm một đoạn zero-length. Vòng contour true-shape cũ không lặp điểm,
    // được giữ nguyên và khép ở bước dựng path bên dưới.
    if (polyline.length >= 3 && closeEnough(polyline[0], polyline[polyline.length - 1])) {
      rings.push(polyline.slice(0, -1));
    } else {
      openCandidates.push(polyline);
    }
  }

  // Backend nup_artwork trả từng lệnh l/c (line chỉ có 2 điểm, Bézier được
  // lấy mẫu thành 11 điểm). Nối các mảnh theo endpoint trước khi vẽ; nếu tô
  // từng mảnh và tự thêm Z thì khuôn cong biến thành các tam giác vụn.
  const connected = openCandidates.filter((polyline, index) =>
    openCandidates.some((other, otherIndex) =>
      index !== otherIndex && (
        closeEnough(polyline[0], other[0]) ||
        closeEnough(polyline[0], other[other.length - 1]) ||
        closeEnough(polyline[polyline.length - 1], other[0]) ||
        closeEnough(polyline[polyline.length - 1], other[other.length - 1])
      ),
    ),
  );
  const isolated = openCandidates.filter((polyline) => !connected.includes(polyline));
  const openChains: Point[][] = [];
  const remaining = [...connected];

  while (remaining.length) {
    let chain = remaining.shift()!;
    let extended = true;
    while (extended && remaining.length) {
      extended = false;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const candidateReversed = reverse(candidate);
        const chainStart = chain[0];
        const chainEnd = chain[chain.length - 1];
        if (closeEnough(chainEnd, candidate[0])) {
          chain = [...chain, ...withoutJoinEndpoint(candidate)];
        } else if (closeEnough(chainEnd, candidate[candidate.length - 1])) {
          chain = [...chain, ...withoutJoinEndpoint(candidateReversed)];
        } else if (closeEnough(chainStart, candidate[candidate.length - 1])) {
          chain = [...withoutPrependEndpoint(candidate), ...chain];
        } else if (closeEnough(chainStart, candidate[0])) {
          chain = [...withoutPrependEndpoint(candidateReversed), ...chain];
        } else {
          continue;
        }
        remaining.splice(index, 1);
        extended = true;
        break;
      }
    }

    if (chain.length >= 3 && closeEnough(chain[0], chain[chain.length - 1])) {
      rings.push(chain.slice(0, -1));
    } else {
      openChains.push(chain);
    }
  }

  // Một polyline cô lập dài 11 điểm là một Bézier sampled (đoạn hở), còn
  // contour true-shape dạng 3+ điểm là vòng hoàn chỉnh dù không lặp điểm đầu.
  // Đoạn hở chỉ stroke, tuyệt đối không đóng giả bằng Z.
  for (const polyline of isolated) {
    if (polyline.length === 2 || polyline.length === 11) {
      openChains.push(polyline);
    } else if (polyline.length >= 3) {
      rings.push(polyline);
    }
  }

  if (rings.length === 0 && openChains.length === 0) return null;

  const color = BLOCK_COLORS[blockId % BLOCK_COLORS.length];
  const pathData = (paths: Point[][], close: boolean) =>
    paths
      .map((path) =>
        `M ${path.map(([x, y]) => `${x} ${y}`).join(" L ")}${close ? " Z" : ""}`,
      )
      .join(" ");
  const nodes: React.ReactNode[] = [];

  // UIUX (audit 2026-09-05 §NEST26.2): mỗi vòng contour là một subpath riêng;
  // evenodd giữ đúng lỗ rỗng. Các mảnh hở tách thành stroke-only path để SVG
  // không tự fill/khép ngầm chúng.
  if (rings.length > 0) {
    nodes.push(
      <path
        key="closed"
        data-testid="true-shape-contour"
        data-side={side}
        data-ring-count={rings.length}
        d={pathData(rings, true)}
        fill={color.fill}
        fillRule="evenodd"
        clipRule="evenodd"
        stroke={color.stroke}
        strokeWidth={0.8}
        strokeLinejoin="round"
      />,
    );
  }
  if (openChains.length > 0) {
    nodes.push(
      <path
        key="open"
        data-testid="true-shape-open-contour"
        data-side={side}
        d={pathData(openChains, false)}
        fill="none"
        stroke={color.stroke}
        strokeWidth={0.8}
        strokeLinejoin="round"
      />,
    );
  }

  return nodes.length === 1 ? nodes[0] : <g>{nodes}</g>;
}

// =====================================================================
// GridPreview Component
// =====================================================================
export default function GridPreview(props: GridPreviewProps) {
  const { t } = useTranslation();
  const {
    isActive = true,
    activeTool = "nup",
    taskMode,
    isDieCut,
    pageSheetMode = false,
    layoutType,
    duplexFlow = "normal",
    duplexFlipEdge = "long",
    mixedExcessPercent = 0,
    gridStrategy,
    alternateRotation = "none",
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
    itemWPt,
    itemHPt,
    shapeParams,
    isDetectingShape,
    shapesByPage,
    shapeParamsByPage,
    pontType,
    pontConfig,
    separateCutPage = true,
    pontsOnCutFile = true,
    exportUniqueSheets = true,
    reportDisplay,
    reportMaterial,
    reportLamination,
    reportLaminationSides,
    reportOrderCode,
    hiddenOcgLayerIds,
    saveByReport,
    onCapacityChange,
    onMixedPlacedByPage,
    fileId,
    filePath,
    pageIdx = 0,
    bleed = 0,
    cutBorder,
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
    cncDuplexMarks,
    cutType,
    fillBlockGap,
    dieSizeMode,
    dieOffsetMm,
    getWorkingFile,
    requiresWorkingSource = false,
    previewSourceKey,
    diagnosticTraceId = "",
    onDiagnosticEvent,
  } = props;

  // INKING (audit 2026-08-12 §INK-DIE-03): tem vuông/chữ nhật dùng cùng cờ
  // xoay với PDF; hình khác/CNC/nguyên tấm vẫn bị khóa phòng thủ tại đây.
  const rectangleStickerInking = activeTool === "sticker_imposer"
    && isDieCut
    && !pageSheetMode
    && imposerMode !== "cnc"
    && String(shapeType || "").trim().toUpperCase() === "RECTANGLE";
  const effectiveAlternateRotation: NupSettings["alternateRotation"] = (
    (
      activeTool === "nup"
      && !isDieCut
      && !pageSheetMode
      && imposerMode !== "cnc"
      && layoutType !== "mixed_guillotine"
    ) || rectangleStickerInking
  ) ? alternateRotation : "none";

  // §B10: auto-route true-shape theo phân loại hình — bản sao FRONTEND của route_true_shape
  // backend. TÍNH MỘT LẦN rồi dùng khắp nơi (cache key, chọn nhánh fetch, debounce, render)
  // để preview và export KHÔNG THỂ lệch quyết định. Chỉ hình đặc biệt (CUSTOM) + "Xếp tối ưu"
  // trên die-cut/CNC (loại 1 Dao / nguyên tấm / dàn nhiều kích thước) mới đi true-shape.
  const usesTrueShape = useMemo(
    () =>
      shouldUseTrueShapeNesting({
        enabled: TRUE_SHAPE_NESTING_ENABLED,
        imposerMode,
        isDieCut,
        pageSheetMode,
        taskMode,
        layoutType,
        gridStrategy,
        cutType,
        groupingStrategy,
        clusterMode,
        alternateRotation: effectiveAlternateRotation,
        cutBorderEnabled: cutBorder?.enabled === true,
        hiddenOcgLayerIds,
        saveByReport,
        cncTwoSided,
        cncDuplexMarks,
        shapesByPage,
        targetQuantity,
        targetQuantitiesByPage,
        shapeParamsByPage,
      }),
    [
      imposerMode,
      isDieCut,
      pageSheetMode,
      taskMode,
      layoutType,
      gridStrategy,
      cutType,
      groupingStrategy,
      clusterMode,
      effectiveAlternateRotation,
      cutBorder?.enabled,
      hiddenOcgLayerIds,
      saveByReport,
      cncTwoSided,
      cncDuplexMarks,
      shapesByPage,
      targetQuantity,
      targetQuantitiesByPage,
      shapeParamsByPage,
    ],
  );

  const normalizedTaskMode = String(taskMode || "").trim().toLowerCase();
  const isStepRepeatLayout = ["step_repeat", "sr"].includes(normalizedTaskMode)
    || String(layoutType || "").trim().toLowerCase() === "repeat";
  const usesProgressiveStepRepeat = usesTrueShape && isStepRepeatLayout;

  // PERF (audit 2026-09-02 §PREVIEW-SEMANTIC-KEY): Bình trang luôn xếp đầy một
  // tờ đại diện cho mỗi mẫu. Số lượng chỉ quyết định mẫu nào tham gia; đổi 100 →
  // 200 không đổi một pose nào và không được hủy/solve lại preview đang dùng được.
  const stepRepeatQuantityLayoutKey = useMemo(
    () => isStepRepeatLayout
      ? trueShapeJobMembershipKey({
          shapesByPage,
          targetQuantity,
          targetQuantitiesByPage,
          shapeParamsByPage,
        })
      : "",
    [
      isStepRepeatLayout,
      shapesByPage,
      targetQuantity,
      targetQuantitiesByPage,
      shapeParamsByPage,
    ],
  );

  const settingsStore = React.useContext(ImposerSettingsContext);

  const [expanded, setExpanded] = useState(false);
  const [layoutResult, setLayoutResult] = useState<BackendLayoutResult | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [nestingProgress, setNestingProgress] = useState<PreviewNestingProgress | null>(null);
  const [isCancellingNesting, setIsCancellingNesting] = useState(false);
  // chia cụm zone modes: tờ đang xem (0-based) để lật ◄ n/N ►.
  const [activeSheet, setActiveSheet] = useState(0);
  // B10-6: quality gate/cancel có thể chốt lưới theo toàn job S&R. Chỉ khi
  // identity này còn khớp mới cho đổi trang gọi probe lưới nhẹ thay vì nesting.
  const [legacyStepRepeatDecisionKey, setLegacyStepRepeatDecisionKey] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeNestingJobRef = useRef<{
    jobId: string;
    generation: number;
    requestId: string;
    traceId: string;
  } | null>(null);
  // Request frontend tồn tại từ lúc phát `pending`, trước khi server trả job_id.
  const activePreviewRequestRef = useRef<{
    generation: number;
    requestId: string;
    traceId: string;
    terminal: boolean;
    forceLegacyGrid: boolean;
  } | null>(null);
  const cancellingNestingJobsRef = useRef(new Map<string, Promise<void>>());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCapacityChangeRef = useRef(onCapacityChange);

  useEffect(() => {
    onCapacityChangeRef.current = onCapacityChange;
  }, [onCapacityChange]);
  const onMixedPlacedByPageRef = useRef(onMixedPlacedByPage);
  useEffect(() => {
    onMixedPlacedByPageRef.current = onMixedPlacedByPage;
  }, [onMixedPlacedByPage]);
  const onDiagnosticEventRef = useRef(onDiagnosticEvent);
  useEffect(() => {
    onDiagnosticEventRef.current = onDiagnosticEvent;
  }, [onDiagnosticEvent]);
  const diagnosticTraceIdRef = useRef(diagnosticTraceId);
  useEffect(() => {
    diagnosticTraceIdRef.current = diagnosticTraceId;
  }, [diagnosticTraceId]);

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

  const workingPdfError = (cause?: unknown): Error => {
    const error = new Error(t(
      'imposition.gridPreview:khong_tao_duoc_pdf_lam_viec',
      'Không thể tạo PDF làm việc từ thứ tự hoặc góc xoay trang hiện tại. Hãy thử lại hoặc hoàn tác thay đổi trang.',
    ));
    (error as Error & { cause?: unknown }).cause = cause;
    return error;
  };

  const resolvePreviewSource = async (): Promise<{ path?: string; file_id?: string }> => {
    const viewerStateKey = previewSourceKey ?? "default";
    const cacheKey = `${viewerStateKey}|working:${requiresWorkingSource ? 1 : 0}`;
    const viewerState = parsePreviewViewerState(viewerStateKey);
    // Đổi pageOrder (xóa/sắp trang) → bỏ cache path/fileId cũ.
    if (previewPathCacheRef.current && previewPathCacheRef.current.key !== cacheKey) {
      previewPathCacheRef.current = null;
    } else if (previewPathCacheRef.current?.key === cacheKey) {
      if (previewPathCacheRef.current.path) return { path: previewPathCacheRef.current.path };
      if (previewPathCacheRef.current.fileId) return { file_id: previewPathCacheRef.current.fileId };
    }

    // PREVIEW (audit 2026-08-04 §W2.PA2): mọi sửa trang phải có artifact riêng.
    // Nếu tạo artifact thất bại, dừng preview; dùng file gốc sẽ dựng sai trang/cut tree.
    const order = viewerState.order;
    if (order.length > 0) {
      if (order.length > maxOrderLenSeenRef.current) {
        maxOrderLenSeenRef.current = order.length;
      }
    }
    let mustBake = requiresWorkingSource || previewViewerStateRequiresMaterialization(
      viewerState,
      maxOrderLenSeenRef.current,
    );
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
        const nativePath = (wf as WorkspaceFileLike)?.path;

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
          if ((window as RuntimeWindow).__TAURI_INTERNALS__) {
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

        // Chỉ file identity mới được phép rơi về path gốc.
        if (nativePath) {
          if (mustBake) throw workingPdfError();
          previewPathCacheRef.current = { key: cacheKey, path: nativePath };
          return { path: nativePath };
        }
      } catch (e) {
        console.warn("[GridPreview] resolvePreviewSource getWorkingFile failed:", e);
        if (mustBake) throw workingPdfError(e);
      }
    }

    // Không được fallback sang prop gốc khi thứ tự/xoay/xóa trang chưa materialize.
    if (mustBake) throw workingPdfError();

    // Fallback cuối chỉ dành cho trạng thái trang identity.
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
    } catch {
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
  // PARITY (audit 2026-08-29 §NEST-PARITY-1): phải đúng hệt backend. Hằng rút gọn
  // 2.83465 làm 320 mm thành 320.000488889 mm sau vòng đổi đơn vị, đủ làm miss
  // session identity và buộc export solve lại.
  const MM_TO_PT = 72 / 25.4;
  const PT_TO_MM = 1 / MM_TO_PT;

  // Generation id — chặn response cũ (10 trang) ghi đè response mới (4 trang).
  const previewGenRef = useRef(0);
  // B10-6: generation chặn request cũ; rank chặn provisional về MUỘN trong cùng generation.
  const publicationRef = useRef<{ generation: number; rank: 0 | 1 | 2 }>({
    generation: 0,
    rank: 0,
  });
  const provisionalLayoutRef = useRef<{
    generation: number;
    requestId: string;
    traceId: string;
    perViewKey: string;
    result: BackendLayoutResult;
  } | null>(null);
  /** Cache layout theo khóa ổn định — cuộn trang view KHÔNG đụng cache/API. */
  const layoutKeyRef = useRef("");
  const layoutCacheRef = useRef<BackendLayoutResult | null>(null);
  // Decision là một phần của publication cache; thiếu nó thì A→B→A có thể preview lưới
  // nhưng export lại auto-route true-shape.
  const layoutCacheForceLegacyRef = useRef(false);
  // B10-6: publication true-shape all-page đã chứa mọi representative sheet. Ref này
  // giữ đúng object đã publish để map viewer page → sheet mà không đụng lifecycle fetch.
  const reusableStepRepeatLayoutRef = useRef<{
    identity: string;
    result: BackendLayoutResult;
  } | null>(null);
  const viewerSheetSelectionRef = useRef<{
    pageIdx: number;
    result: BackendLayoutResult | null;
  }>({ pageIdx, result: null });

  // ── Khi nào cuộn trang view KHÔNG được refetch layout ──
  // • 1 khuôn (mọi trang cùng type / master inherit) → 1 layout, cuộn chỉ xem.
  // • Multi-pack (ratio_stack / sequential / cluster / CNC) → 1 tờ xếp nhiều loại.
  // • MỖI TEM MỘT KHUÔN khác nhau + step_repeat/repeat → PHẢI tính theo trang view
  //   (die size/type khác → capacity khác). Không gộp với case 1 khuôn.
  const _isMixedGuillotine = layoutType === "mixed_guillotine";
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
    _isMixedGuillotine ||
    (_multiPage &&
      !isStepRepeatLayout &&
      (layoutType === "ratio_stack" ||
        layoutType === "sequential" ||
        layoutType === "cut_stacks")) ||
    // CNC Bình trang (step_repeat/repeat) phải giữ page_idx đang xem để
    // compute_sticker_layout_for_page dùng đúng khuôn của trang đó. Chỉ
    // Dàn nhiều mẫu mới gom vào nhánh multi-pack; nếu gom nhầm sẽ khóa trang 0.
    (_multiPage && imposerMode === "cnc" && !isStepRepeatLayout) ||
    // Die-cut multi nhưng không phải step_repeat “một loại/tờ”: pack chung
    (_multiPage &&
      !!isDieCut &&
      !isStepRepeatLayout);
  const _layoutIgnoresViewPage =
    _singleMoldFamily || _multiPackLayout;

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
      const preferred = pageValue(shapesByPage, _geometryPageIdx);
      if (preferred && preferred !== "CUSTOM") st = String(preferred);
      else {
        for (const k of Object.keys(shapesByPage)) {
          const v = shapesByPage[Number(k)];
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
  const _itemWDep = _layoutIgnoresViewPage && (isDieCut || _isMixedGuillotine) ? 0 : itemW;
  const _itemHDep = _layoutIgnoresViewPage && (isDieCut || _isMixedGuillotine) ? 0 : itemH;
  const _pageIdxForRequest = _singleMoldFamily
    ? _geometryPageIdx
    : (_layoutIgnoresViewPage ? 0 : pageIdx);

  /** Khóa per-view: hình học singular hiện hành vẫn phải đổi cho fallback lưới. */
  const perViewLayoutFetchKey = useMemo(() => {
    const quantityAffectsLayout = !isStepRepeatLayout;
    return JSON.stringify({
      uw: Math.round(usableW * 100) / 100,
      uh: Math.round(usableH * 100) / 100,
      iw: Math.round((_itemWDep || 0) * 100) / 100,
      ih: Math.round((_itemHDep || 0) * 100) / 100,
      gx: gapX,
      gy: gapY,
      sg: splitGap,
      gs: gridStrategy,
      ar: effectiveAlternateRotation,
      cols: columns,
      rows: rows,
      st: _shapeTypeDep,
      sp: _shapeParamsDep,
      pont: pontType,
      pontC: pontType && pontType !== "none" ? pontConfig : null,
      // §B10: routing đi qua usesTrueShape (auto-route theo hình), không còn theo option
      // gridStrategy thủ công. Bỏ vào key để đổi phân loại → gọi lại đúng nhánh preview.
      ts: usesTrueShape,
      tm: taskMode,
      lt: layoutType,
      df: duplexFlow,
      die: !!isDieCut,
      psm: pageSheetMode,
      dfe: duplexFlipEdge,
      // §MG-A2: PHẢI có trong cache key — đổi ngưỡng dư là đổi số bản kẽm, thiếu
      // key này thì preview trả kết quả cũ (bẫy cache đã ghi trong prynx-imposition).
      mxe: mixedExcessPercent,
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
      tq: quantityAffectsLayout ? targetQuantity : undefined,
      tqbp: quantityAffectsLayout ? (targetQuantitiesByPage || {}) : undefined,
      srqp: isStepRepeatLayout ? stepRepeatQuantityLayoutKey : undefined,
      im: imposerMode || "",
      c2: !!cncTwoSided,
      cfe: cncFlipEdge || "",
      // PARITY (audit 2026-09-05 §NEST26.1): dấu canh CNC hai mặt là vật cản
      // của solver; đổi cờ phải làm mất cache để preview không dùng bố trí simplex.
      cdm: !!cncDuplexMarks,
      ct: cutType || "",
      fbg: fillBlockGap,
      dsm: dieSizeMode,
      dom: dieOffsetMm,
      psk: previewSourceKey || "",
      rws: requiresWorkingSource,
      // Tab nền vẫn mounted trong App; đổi active phải chạy cleanup để hủy job cũ.
      active: isActive !== false,
      detecting: shouldDeferPreviewLayout(!!isDieCut, !!isDetectingShape),
    });
  }, [
    usableW,
    usableH,
    mixedExcessPercent,
    _itemWDep,
    _itemHDep,
    gapX,
    gapY,
    splitGap,
    gridStrategy,
    usesTrueShape,
    effectiveAlternateRotation,
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
    duplexFlipEdge,
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
    isStepRepeatLayout,
    stepRepeatQuantityLayoutKey,
    imposerMode,
    cncTwoSided,
    cncFlipEdge,
    cncDuplexMarks,
    cutType,
    fillBlockGap,
    dieSizeMode,
    dieOffsetMm,
    previewSourceKey,
    requiresWorkingSource,
    isActive,
    isDetectingShape,
  ]);

  // All-page effect không rerun khi cuộn; async callback phải đối chiếu key viewer mới
  // nhất trước khi publish capacity/layout page-local.
  const latestPerViewLayoutFetchKeyRef = useRef(perViewLayoutFetchKey);
  latestPerViewLayoutFetchKeyRef.current = perViewLayoutFetchKey;

  // B10-6: một job S&R true-shape luôn mang maps của toàn file. Loại singular geometry
  // của trang đang xem khỏi identity để cuộn không hủy/submit lại job 13 mẫu.
  const allPageStepRepeatFetchKey = useMemo(() => {
    if (!usesProgressiveStepRepeat) return "";
    try {
      const canonical = JSON.parse(perViewLayoutFetchKey) as Record<string, unknown>;
      canonical.iw = 0;
      canonical.ih = 0;
      canonical.st = _shapesByPageKey;
      canonical.sp = _shapeParamsByPageKey;
      canonical.detecting = false;
      canonical.srAll = true;
      return JSON.stringify(canonical);
    } catch {
      return `srAll:${_shapesByPageKey}:${_shapeParamsByPageKey}:${perViewLayoutFetchKey}`;
    }
  }, [
    usesProgressiveStepRepeat,
    perViewLayoutFetchKey,
    _shapesByPageKey,
    _shapeParamsByPageKey,
  ]);

  const usesAuthoritativeLegacyStepRepeat = usesProgressiveStepRepeat
    && legacyStepRepeatDecisionKey === allPageStepRepeatFetchKey;
  const effectiveLayoutFetchKey = usesProgressiveStepRepeat
    && !usesAuthoritativeLegacyStepRepeat
    ? allPageStepRepeatFetchKey
    : perViewLayoutFetchKey;

  const markAuthoritativeLegacyStepRepeat = (): void => {
    if (!usesProgressiveStepRepeat) return;
    if (reusableStepRepeatLayoutRef.current?.identity === allPageStepRepeatFetchKey) {
      reusableStepRepeatLayoutRef.current = null;
    }
    setLegacyStepRepeatDecisionKey(allPageStepRepeatFetchKey);
  };

  const terminalizePreviewDiagnostic = (
    generation: number,
    phase: GridPreviewDiagnosticEvent["phase"],
    capacity?: number,
    forceLegacyGrid = false,
  ): void => {
    const activeRequest = activePreviewRequestRef.current;
    if (
      !activeRequest
      || activeRequest.generation !== generation
      || activeRequest.terminal
    ) {
      return;
    }
    activeRequest.terminal = true;
    const effectiveForceLegacyGrid = forceLegacyGrid || activeRequest.forceLegacyGrid;
    onDiagnosticEventRef.current?.({
      traceId: activeRequest.traceId,
      requestId: activeRequest.requestId,
      generation,
      phase,
      ...(capacity != null ? { capacity } : {}),
      ...(effectiveForceLegacyGrid ? { forceLegacyGrid: true } : {}),
    });
    activePreviewRequestRef.current = null;
  };

  const cancelNestingJobWithRetry = (jobId: string): Promise<void> => {
    const inFlight = cancellingNestingJobsRef.current.get(jobId);
    if (inFlight) return inFlight;

    const operation = (async () => {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= NESTING_CANCEL_MAX_ATTEMPTS; attempt += 1) {
        const attemptController = new AbortController();
        let timeoutId: number | null = null;
        try {
          await Promise.race([
            cancelNestingPreviewJob(jobId, attemptController.signal),
            new Promise<never>((_resolve, reject) => {
              timeoutId = window.setTimeout(() => {
                attemptController.abort();
                reject(new DOMException(
                  "Quá thời gian chờ hủy preview nesting.",
                  "TimeoutError",
                ));
              }, NESTING_CANCEL_ATTEMPT_TIMEOUT_MS);
            }),
          ]);
          return;
        } catch (error) {
          lastError = error;
          if (attempt < NESTING_CANCEL_MAX_ATTEMPTS) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, NESTING_CANCEL_RETRY_MS);
            });
          }
        } finally {
          if (timeoutId != null) window.clearTimeout(timeoutId);
        }
      }
      console.warn("[GridPreview] Không hủy được job preview nesting sau khi thử lại:", lastError);
    })();
    const tracked = operation.finally(() => {
      cancellingNestingJobsRef.current.delete(jobId);
    });
    cancellingNestingJobsRef.current.set(jobId, tracked);
    return tracked;
  };

  const cancelActiveNestingJob = (expectedGeneration?: number): Promise<void> | null => {
    const active = activeNestingJobRef.current;
    if (!active || (expectedGeneration != null && active.generation !== expectedGeneration)) return null;
    // Xóa active ref để cleanup không dội lệnh; map retry vẫn giữ jobId tới khi ACK/đủ lượt.
    activeNestingJobRef.current = null;
    return cancelNestingJobWithRetry(active.jobId);
  };

  const handleCancelNestingPreview = (): void => {
    const active = activeNestingJobRef.current;
    const cancelledGeneration = previewGenRef.current;
    const pendingRequest = activePreviewRequestRef.current?.generation === cancelledGeneration
      ? activePreviewRequestRef.current
      : null;
    const provisional = usesProgressiveStepRepeat
      && provisionalLayoutRef.current?.generation === cancelledGeneration
      ? provisionalLayoutRef.current
      : null;
    // Fence trước, cancel sau: result vừa về cùng tick cũng không còn quyền ghi UI.
    previewGenRef.current += 1;
    publicationRef.current = { generation: previewGenRef.current, rank: 2 };
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    const cancellation = cancelActiveNestingJob();

    if (provisional) {
      // B10-6: Hủy chỉ dừng tối ưu nền; provisional vẫn thuộc per-view đã tạo nó.
      // Nếu viewer đã cuộn, cache theo origin để effect legacy buộc probe trang mới.
      markAuthoritativeLegacyStepRepeat();
      const matchesCurrentView = provisional.perViewKey === perViewLayoutFetchKey;
      layoutKeyRef.current = provisional.perViewKey;
      layoutCacheRef.current = provisional.result;
      layoutCacheForceLegacyRef.current = true;
      if (matchesCurrentView) {
        setLayoutResult(provisional.result);
        onCapacityChangeRef.current?.(provisional.result.totalItems);
      }
      setPreviewError(null);
      terminalizePreviewDiagnostic(
        cancelledGeneration,
        "applied",
        matchesCurrentView ? provisional.result.totalItems : undefined,
        true,
      );
    } else {
      // Không có provisional hiện hành: xóa preview stale để user không nhầm là kết quả mới.
      layoutKeyRef.current = "";
      layoutCacheRef.current = null;
      layoutCacheForceLegacyRef.current = false;
      setLayoutResult(null);
      setActiveSheet(0);
      setPreviewError(null);
      onCapacityChangeRef.current?.(0);
      onMixedPlacedByPageRef.current?.({});
      if (pendingRequest) {
        terminalizePreviewDiagnostic(cancelledGeneration, "aborted");
      }
    }
    provisionalLayoutRef.current = null;
    setIsCancellingNesting(!!active);
    setIsLoading(false);
    setNestingProgress({
      phase: "cancelled",
      progress: nestingProgress?.progress,
      elapsedMs: nestingProgress?.elapsedMs ?? 0,
      messageCode: "cancelled_by_user",
    });
    if (active) {
      // Registry cancel idempotent; trạng thái UI không cần chờ round-trip mới dừng spinner.
      void cancellation?.finally(() => setIsCancellingNesting(false));
    } else {
      setIsCancellingNesting(false);
    }
  };

  useEffect(() => {
    // Chụp route cho đúng generation. Sau quality gate legacy, viewer page chỉ được
    // gọi endpoint lưới đồng bộ; tuyệt đối không đi lại createNestingPreviewJob.
    const requestUsesLegacyStepRepeat = usesAuthoritativeLegacyStepRepeat;
    const requestUsesTrueShape = usesTrueShape && !requestUsesLegacyStepRepeat;
    const requestUsesProgressiveStepRepeat = usesProgressiveStepRepeat
      && requestUsesTrueShape;

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
    void cancelActiveNestingJob();

    // App giữ tab nền mounted. Không được cho tab nền chiếm CPU hoặc công bố capacity.
    if (!isActive) {
      setIsLoading(false);
      setIsCancellingNesting(false);
      return;
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

    const previousRequest = activePreviewRequestRef.current;
    if (previousRequest && !previousRequest.terminal) {
      terminalizePreviewDiagnostic(previousRequest.generation, "stale");
    }

    // ── CACHE HIT: khôi phục CẢ layout lẫn decision của publication ──
    if (
      layoutKeyRef.current === effectiveLayoutFetchKey &&
      layoutCacheRef.current
    ) {
      const cachedResult = layoutCacheRef.current;
      const gen = ++previewGenRef.current;
      const requestId = `${diagnosticTraceId || "preview"}-c${gen}`.slice(0, 96);
      publicationRef.current = { generation: gen, rank: 2 };
      provisionalLayoutRef.current = null;
      setIsLoading(false);
      if (cancellingNestingJobsRef.current.size === 0) {
        setIsCancellingNesting(false);
      }
      setPreviewError(null);
      setLayoutResult((prev) => (
        prev === cachedResult ? prev : cachedResult
      ));
      onCapacityChangeRef.current?.(cachedResult.totalItems);
      onDiagnosticEventRef.current?.({
        traceId: diagnosticTraceId,
        requestId,
        generation: gen,
        phase: "applied",
        capacity: cachedResult.totalItems,
        forceLegacyGrid: layoutCacheForceLegacyRef.current,
      });
      return;
    }

    // Stale-while-revalidate: GIỮ preview cũ trên màn hình, chỉ bật loading nhẹ.
    // KHÔNG setLayoutResult(null) → hết giật trắng khi detect/settings đổi.
    setIsLoading(true);
    setPreviewError(null);
    setIsCancellingNesting(false);
    setNestingProgress(null);
    const gen = ++previewGenRef.current;
    publicationRef.current = { generation: gen, rank: 0 };
    provisionalLayoutRef.current = null;
    const requestId = `${diagnosticTraceId || "preview"}-p${gen}`.slice(0, 96);
    // Đăng ký pending NGAY khi generation đổi (trước debounce/bake) để quyết định
    // legacy của publication cũ không thể rò sang lệnh Bình cho settings mới.
    activePreviewRequestRef.current = {
      traceId: diagnosticTraceId,
      requestId,
      generation: gen,
      terminal: false,
      forceLegacyGrid: requestUsesLegacyStepRepeat,
    };
    onDiagnosticEventRef.current?.({
      traceId: diagnosticTraceId,
      requestId,
      generation: gen,
      phase: "pending",
      ...(requestUsesLegacyStepRepeat ? { forceLegacyGrid: true } : {}),
    });

    // Số trang viewer (SSOT cho ratio_stack) — luôn gửi, không để backend đoán từ file gốc.
    const viewerPageCount = resolvePreviewPageCount(previewSourceKey, sourceTotalPages || 0);

    let effectActive = true;
    debounceRef.current = setTimeout(async () => {
      // Abort previous in-flight request
      if (abortRef.current) {
        abortRef.current.abort();
      }
      const controller = new AbortController();
      abortRef.current = controller;
      const isCurrentGeneration = () => (
        effectActive
        && isActive
        && !controller.signal.aborted
        && gen === previewGenRef.current
        && diagnosticTraceIdRef.current === diagnosticTraceId
      );
      // Progressive bắt đầu ở 250 ms; đồng hồ debounce nesting vẫn chạy đủ 750 ms tính từ đây.
      const nestingStartDelay: Promise<boolean> = requestUsesProgressiveStepRepeat
        ? waitForAbortableDelay(NESTING_DEBOUNCE_MS - DEBOUNCE_MS, controller.signal)
            .then(() => true, () => false)
        : Promise.resolve(true);
      let finalizeWithProvisional: (reason: string) => boolean = () => false;

      try {
        const _tPrev = performance.now();
        const previewSrc = await resolvePreviewSource();
        // Nguồn PDF có thể mất hàng giây để bake/upload. Trong lúc await, user có thể
        // đổi settings, chuyển tab hoặc đóng component; tuyệt đối không tạo job stale.
        if (!isCurrentGeneration()) {
          return;
        }
        void previewPerfLog("preview-layout START", {
          trace_id: diagnosticTraceId,
          request_id: requestId,
          generation: gen,
          taskMode: taskMode || "",
          isDieCut: !!isDieCut,
          grouping: groupingStrategy || "",
          imposerMode: imposerMode || "",
          pageIdx: _pageIdxForRequest,
          ignoreViewPage: _layoutIgnoresViewPage,
          hasPath: !!(previewSrc.path || filePath),
          sheet_w_mm: sheetWidth,
          sheet_h_mm: sheetHeight,
          usable_w_mm: usableW,
          usable_h_mm: usableH,
          item_w_pt: (typeof itemWPt === "number" && itemWPt > 0) ? itemWPt : itemW * MM_TO_PT,
          item_h_pt: (typeof itemHPt === "number" && itemHPt > 0) ? itemHPt : itemH * MM_TO_PT,
          gap_x_mm: gapX,
          gap_y_mm: gapY,
          bleed_mm: bleed,
          split_gap_mm: splitGap,
        });
        // Multi-sheet: shape/props theo master (trang 0 / fingerprint), không theo trang view.
        const _reqShapeType = (() => {
          if (!_layoutIgnoresViewPage) {
            return shapeType && shapeType !== "CUSTOM" ? shapeType : "CUSTOM";
          }
          if (shapesByPage && typeof shapesByPage === "object") {
            const preferred = pageValue(shapesByPage, _geometryPageIdx);
            if (preferred && preferred !== "CUSTOM") return String(preferred);
            for (const k of Object.keys(shapesByPage)) {
              const v = shapesByPage[Number(k)];
              if (v && v !== "CUSTOM") return String(v);
            }
          }
          return shapeType && shapeType !== "CUSTOM" ? shapeType : "CUSTOM";
        })();
        const _reqShapeProps = (() => {
          if (!_layoutIgnoresViewPage) return shapePropsParsed || {};
          if (shapeParamsByPage && typeof shapeParamsByPage === "object") {
            const preferred = pageValue(shapeParamsByPage, _geometryPageIdx);
            if (preferred && typeof preferred === "object") return preferred;
          }
          return shapePropsParsed || {};
        })();
        // Convert ALL dimensions from mm → points to match shapeParams units
        const body = {
          usable_w: usableW * MM_TO_PT,
          usable_h: usableH * MM_TO_PT,
          item_w: (typeof itemWPt === 'number' && itemWPt > 0) ? itemWPt : itemW * MM_TO_PT,
          item_h: (typeof itemHPt === 'number' && itemHPt > 0) ? itemHPt : itemH * MM_TO_PT,
          gap_x: gapX * MM_TO_PT,
          gap_y: gapY * MM_TO_PT,
          // §B10: `strategy` là TOKEN giao thức của endpoint preview nesting ("chạy true-shape"),
          // không phải "Cách xếp" người dùng. usesTrueShape đã định tuyến (bản sao route_true_shape),
          // nên gửi token true_shape_nesting để /preview-layout/jobs nhận đúng nhánh nesting; còn
          // gridStrategy thật (optimal_auto) vẫn giữ nguyên cho export dùng route_true_shape.
          strategy: requestUsesTrueShape ? "true_shape_nesting" : (gridStrategy || "optimal_auto"),
          // PARITY (audit 2026-08-31 §NEST-PREVIEW-INTENT): token engine giống nhau,
          // nhưng chỉ auto-route optimal_auto được quyền nhường layout lưới.
          allow_legacy_fallback: requestUsesTrueShape,
          alternate_rotation: effectiveAlternateRotation,
          cols: columns || 0,
          rows: rows || 0,
          shape_type: pageSheetMode ? "RECTANGLE" : _reqShapeType,
          shape_props: pageSheetMode ? {} : _reqShapeProps,
          pont_type: pontType || "none",
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
          separate_cut_page: pageSheetMode ? true : separateCutPage,
          ponts_on_cut_file: pontsOnCutFile,
          export_unique_sheets: exportUniqueSheets,
          report_display: reportDisplay,
          report_material: reportMaterial,
          report_lamination: reportLamination,
          report_lamination_sides: reportLaminationSides,
          report_order_code: reportOrderCode,
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
          duplex_flip_edge: duplexFlipEdge,
          // MIXED-GUILLOTINE (audit 2026-07-30 §MG-A2): % dư → tỉ lệ. Preview và export
          // PHẢI dùng cùng giá trị, nếu không số bản kẽm 2 bên lệch nhau.
          mixed_excess_tolerance: Math.max(0, Number(mixedExcessPercent ?? 0)) / 100,
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
          // UIUX (audit 2026-09-05 §NEST26.1): truyền đúng cờ dấu canh
          // để preview dựng cùng 4 vật cản với manifest xuất CNC; simplex luôn false.
          cnc_duplex_marks: pageSheetMode ? false : !!cncDuplexMarks,
          diagnostic_trace_id: diagnosticTraceId || undefined,
          diagnostic_request_id: requestId,
        };

        const conversionOptions: LayoutConversionOptions = {
          ptToMm: PT_TO_MM,
          layoutType,
          viewerPageCount,
          targetQuantitiesByPage,
          targetQuantity: Number(targetQuantity) || 0,
        };
        const publishPlacedByPage = (result: BackendLayoutResult): void => {
          onMixedPlacedByPageRef.current?.(placedByPageForLayout(result, {
            layoutType,
            viewerPageCount,
          }));
        };
        const publishProvisional = (data: BackendLayoutResult): BackendLayoutResult | null => {
          const publication = publicationRef.current;
          if (
            !data.success
            || !isCurrentGeneration()
            || publication.generation !== gen
            || publication.rank >= 2
          ) {
            return null;
          }
          const converted = convertLayoutResultToMm(data, conversionOptions);
          publicationRef.current = { generation: gen, rank: 1 };
          provisionalLayoutRef.current = {
            generation: gen,
            requestId,
            traceId: diagnosticTraceId,
            perViewKey: perViewLayoutFetchKey,
            result: converted,
          };
          if (perViewLayoutFetchKey === latestPerViewLayoutFetchKeyRef.current) {
            setActiveSheet(0);
            setLayoutResult(converted);
            setPreviewError(null);
            onCapacityChangeRef.current?.(converted.totalItems);
            publishPlacedByPage(converted);
          }
          void previewPerfLog("preview-layout PROVISIONAL", {
            trace_id: diagnosticTraceId,
            request_id: requestId,
            generation: gen,
            ms: Math.round(performance.now() - _tPrev),
            capacity: converted.totalItems,
            strategy: data.strategyUsed || "optimal_auto",
          });
          return converted;
        };
        finalizeWithProvisional = (reason: string): boolean => {
          const provisional = provisionalLayoutRef.current;
          if (!isCurrentGeneration() || provisional?.generation !== gen) return false;
          publicationRef.current = { generation: gen, rank: 2 };
          markAuthoritativeLegacyStepRepeat();
          const matchesCurrentView = provisional.perViewKey
            === latestPerViewLayoutFetchKeyRef.current;
          layoutKeyRef.current = provisional.perViewKey;
          layoutCacheRef.current = provisional.result;
          layoutCacheForceLegacyRef.current = true;
          if (matchesCurrentView) {
            setLayoutResult((previous) => (
              previous === provisional.result ? previous : provisional.result
            ));
            onCapacityChangeRef.current?.(provisional.result.totalItems);
            publishPlacedByPage(provisional.result);
          }
          setPreviewError(null);
          setIsLoading(false);
          terminalizePreviewDiagnostic(
            gen,
            "applied",
            matchesCurrentView ? provisional.result.totalItems : undefined,
            true,
          );
          void previewPerfLog("preview-layout PROVISIONAL_FINAL", {
            trace_id: diagnosticTraceId,
            request_id: requestId,
            generation: gen,
            ms: Math.round(performance.now() - _tPrev),
            capacity: provisional.result.totalItems,
            reason,
          });
          provisionalLayoutRef.current = null;
          return true;
        };

        if (requestUsesProgressiveStepRepeat) {
          const provisionalBody = { ...body, strategy: "optimal_auto" };
          // PERF (audit 2026-08-30 §B10-6): hiện tiler nhanh trước; lỗi kênh tạm không
          // được hủy job nesting. Kết quả cuối vẫn do quality gate backend quyết định.
          void authenticatedFetch(`${getApiUrl()}/imposition/preview-layout`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(provisionalBody),
            signal: controller.signal,
          })
            .then(async (response): Promise<BackendLayoutResult> => {
              if (!response.ok) {
                const detail = await response.text();
                throw new Error(detail.trim() || `Không thể tính preview tạm (${response.status}).`);
              }
              return response.json();
            })
            .then((data) => {
              publishProvisional(data);
              return data;
            })
            .catch((error: unknown) => {
              if (!isAbortError(error) && isCurrentGeneration()) {
                console.warn("[GridPreview] Không dựng được preview lưới tạm:", error);
                void previewPerfLog("preview-layout PROVISIONAL_FAIL", {
                  trace_id: diagnosticTraceId,
                  request_id: requestId,
                  generation: gen,
                  ms: Math.round(performance.now() - _tPrev),
                });
              }
              return null;
            });
        }

        let data: BackendLayoutResult;
        if (requestUsesTrueShape) {
          // PV-A2: POST tạo job không mang AbortSignal. Nếu request bị supersede trong
          // lúc chờ 202, ta vẫn nhận job_id rồi hủy được; abort POST sẽ tạo job mồ côi.
          // S&R đã gọi provisional ở mốc 250 ms nhưng vẫn giữ debounce nesting 750 ms để
          // người dùng gõ liên tục không tạo chuỗi cold solve.
          if (!(await nestingStartDelay) || !isCurrentGeneration()) return;
          const accepted = await createNestingPreviewJob(body);
          if (!accepted.job_id) {
            throw new Error(t(
              'imposition.gridPreview:khong_nhan_duoc_ma_job_preview_nesting',
              'Không nhận được mã theo dõi preview nesting. Hãy thử lại.',
            ));
          }
          if (!isCurrentGeneration()) {
            void cancelNestingJobWithRetry(accepted.job_id);
            terminalizePreviewDiagnostic(
              gen,
              controller.signal.aborted ? "aborted" : "stale",
            );
            return;
          }
          activeNestingJobRef.current = {
            jobId: accepted.job_id,
            generation: gen,
            requestId,
            traceId: diagnosticTraceId,
          };
          setNestingProgress({
            phase: accepted.status || "queued",
            elapsedMs: 0,
          });

          const finalStatus = await waitForNestingPreviewJob(accepted.job_id, {
            signal: controller.signal,
            onStatus: (status) => {
              if (!isCurrentGeneration()) return false;
              setNestingProgress(status.progress ?? {
                phase: status.status,
                elapsedMs: 0,
              });
              return true;
            },
          });
          if (!isCurrentGeneration()) {
            void cancelActiveNestingJob(gen);
            terminalizePreviewDiagnostic(
              gen,
              controller.signal.aborted ? "aborted" : "stale",
            );
            return;
          }
          if (finalStatus.status === "cancelled") {
            activeNestingJobRef.current = null;
            setNestingProgress(finalStatus.progress ?? {
              phase: "cancelled",
              elapsedMs: 0,
              messageCode: "cancelled_by_user",
            });
            if (requestUsesProgressiveStepRepeat && finalizeWithProvisional("nesting_cancelled")) {
              return;
            }
            publicationRef.current = { generation: gen, rank: 2 };
            setIsLoading(false);
            terminalizePreviewDiagnostic(gen, "aborted");
            return;
          }
          if (finalStatus.status !== "completed") {
            activeNestingJobRef.current = null;
            throw new Error(
              finalStatus.message || t(
                'imposition.gridPreview:preview_nesting_khong_co_ket_qua',
                'Preview nesting kết thúc nhưng chưa có kết quả. Hãy thử lại.',
              ),
            );
          }
          data = await getNestingPreviewJobResult<BackendLayoutResult>(
            accepted.job_id,
            controller.signal,
          );
          if (activeNestingJobRef.current?.jobId === accepted.job_id) {
            activeNestingJobRef.current = null;
          }
        } else {
          // Solver lưới nhẹ giữ endpoint đồng bộ. Không có nhánh nào hạ nesting về grid.
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
              else if (Array.isArray(parsed?.detail)) {
                // UIUX (audit 2026-09-13 §PREVIEW-422): FastAPI trả lỗi schema
                // dưới dạng mảng; giữ lại loc/msg để người dùng biết chính xác
                // field nào bị từ chối thay vì chỉ thấy mã 422 chung chung.
                const details = parsed.detail
                  .map((item: unknown) => {
                    if (!item || typeof item !== "object") return "";
                    const value = item as { loc?: unknown; msg?: unknown };
                    const loc = Array.isArray(value.loc)
                      ? value.loc.filter((part) => typeof part === "string" || typeof part === "number").join(".")
                      : "";
                    const msg = typeof value.msg === "string" ? value.msg : "Dữ liệu không hợp lệ";
                    return loc ? `${loc}: ${msg}` : msg;
                  })
                  .filter(Boolean)
                  .join("; ");
                if (details) message = details;
              }
              else if (typeof parsed?.error === "string") message = parsed.error;
            } catch {
              if (errText.trim()) message = errText.trim();
            }
            // UIUX (audit 2026-08-01 §MG-AUTO): backend đã đọc kích thước xén thật.
            // Nếu mode lưới đồng cỡ từ chối nhiều khổ, đổi đúng store của tab sang
            // mixed-guillotine rồi effect tự gọi lại preview; không nháy lỗi đỏ cho user.
            if (
              settingsStore &&
              shouldAutoSwitchToMixedGuillotine({
                status: res.status,
                message,
                taskMode,
                layoutType,
                isDieCut,
                pageSheetMode,
                imposerMode,
              })
            ) {
              void previewPerfLog("preview-layout AUTO_SWITCH_MIXED_SIZE", {
                trace_id: diagnosticTraceId,
                request_id: requestId,
                generation: gen,
                ms: Math.round(performance.now() - _tPrev),
                status: res.status,
              });
              if (gen === previewGenRef.current) {
                terminalizePreviewDiagnostic(gen, "aborted");
                settingsStore.getState().setLayoutType("mixed_guillotine");
              }
              return;
            }
            // SEC (audit 2026-09 §LOG.01): request chứa đường dẫn PDF và hình học;
            // response có thể chứa chi tiết engine. Dev chỉ cần mã HTTP để truy vết.
            if (import.meta.env.DEV) {
              console.error("[GridPreview] Preview layout API failed:", { status: res.status });
            }
            void previewPerfLog("preview-layout FAIL", {
              trace_id: diagnosticTraceId,
              request_id: requestId,
              generation: gen,
              ms: Math.round(performance.now() - _tPrev),
              status: res.status,
            });
            if (gen === previewGenRef.current) {
              terminalizePreviewDiagnostic(gen, "failed");
              setLayoutResult(null);
              setIsLoading(false);
              setPreviewError(message);
              if (onCapacityChangeRef.current) onCapacityChangeRef.current(0);
            }
            return;
          }

          data = await res.json();
        }

        if (!isCurrentGeneration()) {
          const phase = controller.signal.aborted ? "aborted" : "stale";
          terminalizePreviewDiagnostic(gen, phase);
          void previewPerfLog(`preview-layout ${phase.toUpperCase()}`, {
            trace_id: diagnosticTraceId,
            request_id: requestId,
            generation: gen,
            ms: Math.round(performance.now() - _tPrev),
            items: data.totalItems ?? (data.cells?.length ?? 0),
          });
          return;
        }

        // Chỉ terminal mới ghi cache/diagnostic applied. Backend đã so ở cấp toàn job;
        // frontend tuyệt đối không so `totalItems` của riêng tờ đầu.
        if (!controller.signal.aborted && gen === previewGenRef.current) {
          if (data.success) {
            const convertedFinal = convertLayoutResultToMm(data, conversionOptions);
            const provisional = provisionalLayoutRef.current?.generation === gen
              ? provisionalLayoutRef.current.result
              : null;
            const backendPublishedAllPage = [
              "true_shape_nesting",
              "per_design_best",
            ].includes(data.strategyUsed);
            const keepProvisional = requestUsesProgressiveStepRepeat
              && !backendPublishedAllPage
              && provisional !== null;
            const chosenResult = keepProvisional ? provisional : convertedFinal;
            const forceLegacyGrid = requestUsesLegacyStepRepeat
              || (requestUsesProgressiveStepRepeat && !backendPublishedAllPage);
            const resultMatchesCurrentView = !forceLegacyGrid
              || perViewLayoutFetchKey === latestPerViewLayoutFetchKeyRef.current;

            // Rank 2 được đặt TRƯỚC setState: provisional cùng generation về sau không có
            // quyền ghi đè kết quả terminal.
            publicationRef.current = { generation: gen, rank: 2 };
            if (forceLegacyGrid) {
              markAuthoritativeLegacyStepRepeat();
            } else if (requestUsesProgressiveStepRepeat && backendPublishedAllPage) {
              // Chỉ sheets có pageIdx đầy đủ mới được đồng bộ theo viewer. Kết quả thiếu
              // contract vẫn hiển thị tờ đầu nhưng không được đoán bằng ordinal nén.
              if (hasReusableStepRepeatSheets(convertedFinal)) {
                reusableStepRepeatLayoutRef.current = {
                  identity: allPageStepRepeatFetchKey,
                  result: convertedFinal,
                };
              } else if (
                reusableStepRepeatLayoutRef.current?.identity === allPageStepRepeatFetchKey
              ) {
                reusableStepRepeatLayoutRef.current = null;
              }
              setLegacyStepRepeatDecisionKey((current) => (
                current === allPageStepRepeatFetchKey ? null : current
              ));
            }
            layoutKeyRef.current = forceLegacyGrid
              ? perViewLayoutFetchKey
              : effectiveLayoutFetchKey;
            layoutCacheRef.current = chosenResult;
            layoutCacheForceLegacyRef.current = forceLegacyGrid;
            if (!keepProvisional && resultMatchesCurrentView) {
              setActiveSheet(0);
              setLayoutResult(chosenResult);
              onCapacityChangeRef.current?.(chosenResult.totalItems);
              publishPlacedByPage(chosenResult);
            }
            setPreviewError(null);
            provisionalLayoutRef.current = null;
            terminalizePreviewDiagnostic(
              gen,
              "applied",
              resultMatchesCurrentView ? chosenResult.totalItems : undefined,
              forceLegacyGrid,
            );
            void previewPerfLog("preview-layout APPLIED", {
              trace_id: diagnosticTraceId,
              request_id: requestId,
              generation: gen,
              ms: Math.round(performance.now() - _tPrev),
              capacity: chosenResult.totalItems,
              strategy: data.strategyUsed || "",
              mixed: !!chosenResult.isMixedPreview,
              progressive: requestUsesProgressiveStepRepeat,
              kept_provisional: keepProvisional,
              split_gap_mm: splitGap,
            });
          } else {
            if (requestUsesProgressiveStepRepeat && finalizeWithProvisional("terminal_unsuccessful")) {
              return;
            }
            publicationRef.current = { generation: gen, rank: 2 };
            terminalizePreviewDiagnostic(gen, "failed");
            setLayoutResult(null);
            onCapacityChangeRef.current?.(0);
            // UIUX (audit 2026-07-27 §B-05): giữ lỗi backend và nối gợi ý khắc phục.
            const backendMessage = data.error || t(
              'imposition.gridPreview:khong_the_tinh_bo_cuc_preview',
              'Không thể tính bố cục preview.',
            );
            const oversizeHint = /không vừa|quá khổ|exceed|too large/i.test(backendMessage)
              ? t('imposition.gridPreview:goi_y_qua_kho', ' — thử giảm số hàng/cột, tăng khổ giấy hoặc giảm lề.')
              : '';
            setPreviewError(backendMessage + oversizeHint);
          }
          setIsLoading(false);
        }
      } catch (err: unknown) {
        if (isAbortError(err)) {
          // Hủy bằng nút B10-6 đã tăng generation và có thể chốt provisional thành
          // `applied`; không được phát `aborted` muộn rồi ghi đè snapshot đó.
          if (gen === previewGenRef.current) {
            terminalizePreviewDiagnostic(gen, "aborted");
          }
          void previewPerfLog("preview-layout ABORTED", {
            trace_id: diagnosticTraceId,
            request_id: requestId,
            generation: gen,
          });
        } else if (isCurrentGeneration()) {
          void cancelActiveNestingJob(gen);
          if (requestUsesProgressiveStepRepeat && finalizeWithProvisional("nesting_failed")) {
            setNestingProgress((previous) => ({
              phase: "failed",
              progress: previous?.progress,
              elapsedMs: previous?.elapsedMs ?? 0,
            }));
            console.warn("[GridPreview] Nesting nền lỗi; giữ preview lưới hợp lệ:", err);
            return;
          }
          publicationRef.current = { generation: gen, rank: 2 };
          terminalizePreviewDiagnostic(gen, "failed");
          console.error("Preview layout fetch error:", err);
          setLayoutResult(null);
          setIsLoading(false);
          if (requestUsesTrueShape) {
            setNestingProgress((previous) => ({
              phase: "failed",
              progress: previous?.progress,
              elapsedMs: previous?.elapsedMs ?? 0,
            }));
          }
          // UIUX (audit 2026-07-27 §B-05): formatError thay vì err.message thô
          setPreviewError(formatError(err, t('imposition.gridPreview:khong_dung_duoc_preview_bo_cuc', 'Không dựng được preview bố cục')));
          onCapacityChangeRef.current?.(0);
        }
      }
    }, requestUsesProgressiveStepRepeat
      ? DEBOUNCE_MS
      : (requestUsesTrueShape ? NESTING_DEBOUNCE_MS : DEBOUNCE_MS));

    return () => {
      const activeRequest = activePreviewRequestRef.current;
      if (activeRequest?.generation === gen && !activeRequest.terminal) {
        terminalizePreviewDiagnostic(gen, "stale");
      }
      effectActive = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      void cancelActiveNestingJob(gen);
    };
    // effectiveLayoutFetchKey là all-page khi nesting còn authoritative, và chỉ đổi
    // sang per-view sau khi quality gate/cancel đã chốt legacy.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional single-key cache
  }, [effectiveLayoutFetchKey]);

  useEffect(() => {
    const publication = reusableStepRepeatLayoutRef.current;
    const reusableResult = publication?.identity === allPageStepRepeatFetchKey
      ? publication.result
      : null;
    const previousSelection = viewerSheetSelectionRef.current;
    const viewerPageChanged = previousSelection.pageIdx !== pageIdx;
    const publicationChanged = previousSelection.result !== reusableResult;
    viewerSheetSelectionRef.current = { pageIdx, result: reusableResult };

    if (
      !usesProgressiveStepRepeat
      || !reusableResult
      || layoutResult !== reusableResult
      || (!viewerPageChanged && !publicationChanged)
    ) {
      return;
    }

    // B10-6: pageIdx trong cells là danh tính trang thật. Trang SL=0 không có sheet,
    // vì vậy không đổi lựa chọn; tuyệt đối không dùng physicalSheetIndex/ordinal.
    const matchingSheet = reusableResult.sheets?.findIndex((sheet) => (
      sheet.cells.some((cell) => Number.isInteger(cell.pageIdx) && cell.pageIdx === pageIdx)
    )) ?? -1;
    if (matchingSheet >= 0) {
      setActiveSheet(matchingSheet);
    }
    // Không phụ thuộc activeSheet: pager tay phải giữ nguyên tới khi viewer đổi trang.
  }, [allPageStepRepeatFetchKey, layoutResult, pageIdx, usesProgressiveStepRepeat]);

  // LƯU Ý: kiểm tra sheetWidth/sheetHeight <= 0 được dời xuống SAU svgCells useMemo
  // (hook cuối) để không gọi hook có điều kiện → tránh React #300 crash.

  // ── N-Up "Dàn nhiều mẫu": tổng con cần = SL mỗi loại × số mẫu (SL trống → lấp đầy 1 tờ).
  //    "Cần in" theo tổng con; căn giữa CHỈ khi đúng 1 tờ (nhiều tờ giữ vị trí full layout).
  //    ratio_stack: backend trả sheetsNeeded (mọi mẫu chung 1 số tờ) — ưu tiên dùng.
  const _cap = layoutResult?.totalItems ?? 0;
  const _isRatioStack = layoutType === "ratio_stack";
  const _isCutStacks = layoutType === "cut_stacks";
  const _isNupFill = !isDieCut && taskMode === "nup" && _cap > 0 && !_isRatioStack && !_isCutStacks && !_isMixedGuillotine;
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
          const value = Number(hasOverride ? byPage[idx] : _qtyPerType);
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

  // UIUX/PERF (audit 2026-09-02 §PREVIEW-SEMANTIC-KEY): S&R chỉ cache
  // hình học một tờ đại diện. `sheetsNeeded` của response true-shape là số tờ
  // đại diện/số mẫu, KHÔNG phải số bản phải in của mẫu đang xem. Tính số tờ
  // ngay trên UI từ SL hiện tại để đổi SL không gọi lại preview.
  const stepRepeatQuantity = isStepRepeatLayout
    ? quantityForPage(pageIdx, targetQuantity, targetQuantitiesByPage)
    : 0;
  const stepRepeatCapacity = isStepRepeatLayout && layoutResult
    ? stepRepeatCapacityForPage(layoutResult, pageIdx, activeSheet)
    : 0;

  let totalSheets = 1;
  if (layoutResult && layoutResult.totalItems > 0) {
    if (isStepRepeatLayout) {
      if (stepRepeatQuantity > 0 && stepRepeatCapacity > 0) {
        totalSheets = Math.ceil(stepRepeatQuantity / stepRepeatCapacity);
      }
    } else if (layoutResult.sheetsNeeded != null && layoutResult.sheetsNeeded > 0) {
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
  const svgCells = useMemo<SvgPreviewCell[]>(() => {
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
          cell.pageIdx ?? cell.blockId,
          pageIdx,
          taskMode,
          !!isDieCut,
        ),
        // Đường bế THẬT → pixel (mm top-down * scale). Vẽ y nguyên, không xoay/lật.
        diePolylinesPx: cell.diePolylines
          ? cell.diePolylines.map((pl: number[][]) =>
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
  const _activeUsableRect = _isMixedGuillotine ? layoutResult?.sheets?.[activeSheet]?.usableRect : undefined;
  const uaX = pad + (_activeUsableRect?.x ?? marginLeft) * scale;
  const uaY = pad + (_activeUsableRect?.y ?? marginTop) * scale;
  const uaW = (_activeUsableRect?.width ?? usableW) * scale;
  const uaH = (_activeUsableRect?.height ?? usableH) * scale;

  // ── Đường xén cụm (chia cụm / zone) → pixel. cutLines (mm) gốc dưới-trái Y-up:
  //   v = hoành độ (x), h = tung độ (y). SVG: x = pad + v*scale ; y = pad + (H - y)*scale.
  const _sheetArrCuts = layoutResult?.sheets;
  const _activeSheetMeta = _sheetArrCuts?.[activeSheet];
  const _mixedBackFace = _isMixedGuillotine && _activeSheetMeta?.side === "back";
  const _cutSegments = (_activeSheetMeta?.cutSegments
    ? _activeSheetMeta.cutSegments
    : layoutResult?.cutSegments) || [];
  const cutSegmentsPx = _cutSegments.map((line) => {
    if (line.axis === "x") {
      return {
        x1: pad + line.coordinate * scale,
        y1: pad + line.start * scale,
        x2: pad + line.coordinate * scale,
        y2: pad + line.end * scale,
      };
    }
    return {
      x1: pad + line.start * scale,
      y1: pad + line.coordinate * scale,
      x2: pad + line.end * scale,
      y2: pad + line.coordinate * scale,
    };
  });
  const _cutLines = ((_activeSheetMeta?.cutLines)
    ? _activeSheetMeta.cutLines
    : layoutResult?.cutLines) as { v?: number[]; h?: number[] } | undefined;
  const cutVpx = cutSegmentsPx.length === 0 ? (_cutLines?.v || []).map((v) => pad + v * scale) : [];
  const cutHpx = cutSegmentsPx.length === 0 ? (_cutLines?.h || []).map((h) => pad + (sheetHeight - h) * scale) : [];

  // Lật gương Mặt sau theo cạnh lật (CNC). Mặc định long-edge = lật ngang.
  const _isCncPreview = !!layoutResult?.isCncPreview;
  const _cncShortFlip =
    _isCncPreview &&
    (layoutResult?.cncFlipEdge || cncFlipEdge) === "short";
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
  const _isPairDuplex = duplexFlow === "double" &&
    (_isRatioStack || layoutType === "sequential" || _isMixedGuillotine);
  const cellLabel = (blockId: number, isBack: boolean): string | number => {
    // MIXED-GUILLOTINE: blockId ở đây là pageIdx THÔ (mặt trước=trang chẵn,
    // mặt sau=trang lẻ) do resolvePreviewCellType ghi đè bằng pageIdx. Vì thế
    // loại = floor(blockId/2)+1 — DÙNG CHUNG công thức cặp duplex ở dưới, không
    // được +1 thẳng (từng làm mặt sau trang 1 hiện "2b" và sản phẩm 2 hiện "3a").
    if (_isPairDuplex)
      return `${Math.floor(blockId / 2) + 1}${isBack ? "b" : "a"}`;
    if (isBack && _isCncPreview && layoutResult?.cncTwoSided)
      return blockId + 2;
    return blockId + 1;
  };

  // MIXED-GUILLOTINE: màu ô phải theo LOẠI SẢN PHẨM, không theo pageIdx thô —
  // nếu không mặt trước (trang chẵn) và mặt sau (trang lẻ) của cùng sản phẩm sẽ
  // đổi màu khi lật. CHỈ áp cho mixed_guillotine để không đổi hành vi màu của
  // ratio_stack/sequential (giữ nguyên phân biệt mặt trước/sau như cũ).
  const colorIndexFor = (blockId: number): number =>
    _isMixedGuillotine && _isPairDuplex ? Math.floor(blockId / 2) : blockId;

  // Mặt sau dùng CHÍNH ô mặt trước — phản chiếu do backGroupTransform đảm nhiệm.
  const cncBackCells = svgCells;
  const activeSheetLabel = _isMixedGuillotine && _activeSheetMeta
    ? `${t('imposition.gridPreview:to')} ${(_activeSheetMeta.physicalSheetIndex ?? activeSheet) + 1} · ${t(_mixedBackFace ? 'imposition.gridPreview:mat_sau' : 'imposition.gridPreview:mat_truoc')}`
    : `${t('imposition.gridPreview:to')} ${activeSheet + 1} / ${layoutResult?.sheets?.length || 1}`;


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

  // CUT-BORDER (audit 2026-08-04 §CB.5): overlay dùng chính cell tuyệt đối mà
  // preview nhận từ backend. Bleed chỉ mở rộng rect, không gọi lại solver/layout.
  const renderCutBorderRects = (
    cells: typeof svgCells,
    side: "front" | "back",
  ) => {
    if (!cutBorder?.enabled || !canUseCutBorder({ activeTool, taskMode, pageSheetMode }) || isDieCut) return null;
    const borderBleed = cutBorder.position === "bleed" ? Math.max(0, bleed) * scale : 0;
    const thickness = Math.min(2, Math.max(0.1, Number(cutBorder.thickness) || 0.3));
    return (
      <g
        data-testid="cut-border-preview"
        data-side={side}
        data-position={cutBorder.position}
        fill="none"
        stroke={cutBorder.color || "#000000"}
        strokeWidth={Math.max(0.5, thickness * scale)}
        strokeLinejoin="miter"
      >
        {cells.map((cell) => (
          <rect
            key={`cut-border-${side}-${cell.idx}`}
            x={cell.sx - borderBleed}
            y={cell.sy - borderBleed}
            width={cell.sw + borderBleed * 2}
            height={cell.sh + borderBleed * 2}
          />
        ))}
      </g>
    );
  };

  // UIUX (audit 2026-09-05 §PV26.2): Tem/CNC dùng chung vùng trạng thái.
  // Nhánh lưới (kể cả sau quality gate) không có tiến trình từ server; không
  // gán % giả hoặc hiện nút hủy solver chỉ có ở job nesting.
  const usesNestingProgress = (usesTrueShape && !usesAuthoritativeLegacyStepRepeat)
    || isCancellingNesting;
  const showPreviewProgress = isActive && (isLoading || isCancellingNesting);
  const hasMeasuredProgress = usesNestingProgress
    && nestingProgress !== null
    && Number.isFinite(nestingProgress.progress);
  const nestingProgressPercent = Math.max(
    0,
    Math.min(100, Math.round((nestingProgress?.progress ?? 0) * 100)),
  );
  const nestingPhaseLabel = (() => {
    if (isCancellingNesting) {
      return t('imposition.gridPreview:dang_huy_preview_nesting', 'Đang hủy preview…');
    }
    if (!usesNestingProgress) {
      return t('imposition.gridPreview:dang_tinh_toan_bo_cuc');
    }
    switch (nestingProgress?.phase) {
      case "queued":
      case "waiting_resources":
        return t('imposition.gridPreview:nesting_dang_cho', 'Đang chờ tài nguyên để xếp tem…');
      case "normalizing":
        return t('imposition.gridPreview:nesting_dang_chuan_hoa', 'Đang chuẩn hóa đường bế…');
      case "baseline":
        return t('imposition.gridPreview:nesting_dang_xep_nen', 'Đang xếp phương án nền…');
      case "nesting":
      case "improving":
        return t('imposition.gridPreview:nesting_dang_toi_uu', 'Đang tối ưu vị trí và góc xoay…');
      case "validating":
        return t('imposition.gridPreview:nesting_dang_kiem_tra', 'Đang kiểm tra va chạm và khoảng hở…');
      case "cancelled":
        return t('imposition.gridPreview:nesting_da_huy', 'Đã hủy preview.');
      case "completed":
        return t('imposition.gridPreview:nesting_da_xong', 'Đã xếp xong.');
      case "failed":
        return t('imposition.gridPreview:nesting_that_bai', 'Không thể xếp preview.');
      default:
        return t('imposition.gridPreview:dang_tinh_toan_bo_cuc');
    }
  })();

  return (
    <div className="flex flex-col items-center bg-slate-50 dark:bg-zinc-900/50 rounded-lg p-3 border border-slate-200 dark:border-white/10 mt-2">
      {showPreviewProgress && (
        <div
          data-testid={usesNestingProgress ? "nesting-preview-progress" : "layout-preview-progress"}
          data-phase={usesNestingProgress ? (nestingProgress?.phase || "queued") : "computing"}
          className="mb-2 flex w-full max-w-md items-center gap-2 rounded border border-indigo-200 bg-indigo-50 px-2.5 py-2 text-[11px] text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className={usesNestingProgress ? "sr-only" : "truncate"}
              >
                {nestingPhaseLabel}
              </span>
              {hasMeasuredProgress && (
                <span className="tabular-nums">{nestingProgressPercent}%</span>
              )}
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded bg-indigo-100 dark:bg-indigo-900">
              <div
                data-testid={usesNestingProgress ? "nesting-preview-progress-bar" : "layout-preview-progress-bar"}
                role="progressbar"
                aria-label={nestingPhaseLabel}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={hasMeasuredProgress ? nestingProgressPercent : undefined}
                className={`h-full rounded bg-indigo-500 ${hasMeasuredProgress
                  ? "transition-[width] duration-300"
                  : "w-1/3 motion-safe:animate-pulse"}`}
                style={hasMeasuredProgress ? { width: `${nestingProgressPercent}%` } : undefined}
              />
            </div>
          </div>
          {usesNestingProgress && (
            <button
              type="button"
              onClick={handleCancelNestingPreview}
              disabled={isCancellingNesting}
              className="shrink-0 rounded border border-indigo-300 bg-white px-2 py-1 font-semibold text-indigo-700 hover:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-700 dark:bg-zinc-900 dark:text-indigo-200"
            >
              {t('imposition.gridPreview:huy_preview_nesting', 'Hủy preview')}
            </button>
          )}
        </div>
      )}
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
              (isStepRepeatLayout
                ? stepRepeatQuantity > 0 && stepRepeatCapacity > 0
                : Number(targetQuantity) > 0 ||
                  _isRatioStack ||
                  Object.values(targetQuantitiesByPage || {}).some((v) => Number(v) > 0)) && (
              <>
                <div className="w-px h-4 bg-slate-300 dark:bg-zinc-700"></div>
                <div
                  data-testid="needed-sheets-stat"
                  className="text-slate-600 dark:text-zinc-400"
                >
                  {t('imposition.gridPreview:can_in')}{" "}
                  <span
                    data-testid="needed-sheets-count"
                    className="font-bold text-indigo-600 dark:text-indigo-400"
                  >
                    {totalSheets}
                  </span>{" "}
                  {t('imposition.gridPreview:to')}
                  {_isRatioStack && (
                    (!layoutResult.sheets || layoutResult.sheets.length <= 1) && (
                      <span className="text-[11px] text-slate-400 ml-1">
                        {t('imposition.gridPreview:1_to_mau_x_ban', { n: totalSheets })}
                      </span>
                    )
                  )}
                </div>
              </>
            )}
            {/* Kích thước tem thành phẩm — CHỈ bình cắt xén (N-Up guillotine).
                Ẩn tem bế + CNC (isDieCut): kích thước ô SVG không phải “tem thành phẩm” xén. */}
            {!isDieCut && !_isMixedGuillotine && visibleCells.length > 0 && scale > 0 && (
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
          {effectiveAlternateRotation !== "none" && visibleCells.length > 0 && (
            <div
              data-testid="inking-direction-legend"
              className="flex items-center justify-center gap-1.5 text-[11px] text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 rounded px-2 py-1"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                aria-hidden="true"
                className="shrink-0"
              >
                <circle cx="7" cy="7" r="6" fill="white" stroke="currentColor" strokeWidth="0.8" />
                <line x1="7" y1="10" x2="7" y2="4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <path d="M 7 2.5 L 4.8 5.8 L 9.2 5.8 Z" fill="currentColor" />
              </svg>
              <span>
                {t(
                  'imposition.gridPreview:mui_ten_chi_huong_dau_noi_dung',
                  'Mũi tên chỉ hướng đầu nội dung sau khi xoay.',
                )}
              </span>
            </div>
          )}
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
                {activeSheetLabel}
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
                  ((layoutResult.sheets && layoutResult.sheets.length > 1)
                    ? layoutResult.sheets.flatMap((sheet) => sheet.cells || [])
                    : (layoutResult.cells || []))
                    .map((c) => c.pageIdx)
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

          {/* §MG-B2 (audit 2026-07-30): cảnh báo lề bất đối xứng khi bình 2 mặt.
              Backend đã soạn câu tiếng Việt kèm số đo nên hiển thị nguyên văn. */}
          {Array.isArray(layoutResult.warnings) &&
            layoutResult.warnings.map((warning, index) => (
              <div
                key={index}
                className="text-[12px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded px-2 py-1 w-full"
              >
                ⚠ {warning}
              </div>
            ))}

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
                    {t(_mixedBackFace ? 'imposition.gridPreview:mat_sau' : 'imposition.gridPreview:mat_truoc')}
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
                  {cutSegmentsPx.length > 0 && (
                    <g stroke="#0ea5e9" strokeWidth={0.7} strokeDasharray="5,3" opacity={0.85}>
                      {cutSegmentsPx.map((segment, index) => (
                        <line key={`cs${index}`} {...segment} />
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
                    const color = BLOCK_COLORS[colorIndexFor(c.blockId) % BLOCK_COLORS.length];
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
                      (isMixed && layoutResult?.diePolygonsByPage
                        ? layoutResult.diePolygonsByPage[String(c.blockId)]
                        : null) ?? layoutResult?.diePolygon;
                    return (
                      <g key={c.idx}>
                        {renderCellDiePolylines(
                          c.diePolylinesPx,
                          colorIndexFor(c.blockId),
                          "front",
                        ) ??
                          renderCellShape(
                            c.sx,
                            c.sy,
                            c.sw,
                            c.sh,
                            c.isRotated,
                            c.is180,
                            colorIndexFor(c.blockId),
                            itemShape,
                            parsedItemParams,
                            c.idx,
                            itemDiePoly,
                            effectiveAlternateRotation !== "none",
                          )}
                        {effectiveAlternateRotation !== "none" &&
                          renderCellDirectionIndicator(
                            c.sx,
                            c.sy,
                            c.sw,
                            c.sh,
                            c.isRotated,
                            c.is180,
                            "front",
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
                            {cellLabel(c.blockId, _mixedBackFace)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                  {renderCutBorderRects(visibleCells, "front")}
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
              {duplexFlow === "double" && !_isMixedGuillotine && (
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
                          BLOCK_COLORS[colorIndexFor(c.blockId) % BLOCK_COLORS.length];
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
                          (isMixed && layoutResult?.diePolygonsByPage
                            ? layoutResult.diePolygonsByPage[String(c.blockId)]
                            : null) ?? layoutResult?.diePolygon;

                        return (
                          <g key={c.idx}>
                            {renderCellDiePolylines(
                              c.diePolylinesPx,
                              colorIndexFor(c.blockId),
                              "back",
                            ) ??
                              renderCellShape(
                                c.sx,
                                c.sy,
                                c.sw,
                                c.sh,
                                c.isRotated,
                                c.is180,
                                colorIndexFor(c.blockId),
                                itemShape,
                                parsedItemParams,
                                c.idx,
                                itemDiePoly,
                                effectiveAlternateRotation !== "none",
                              )}
                            {effectiveAlternateRotation !== "none" &&
                              renderCellDirectionIndicator(
                                c.sx,
                                c.sy,
                                c.sw,
                                c.sh,
                                c.isRotated,
                                c.is180,
                                "back",
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
                      {renderCutBorderRects(cncBackCells, "back")}
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
      ) : showPreviewProgress && !previewError ? null : (
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
