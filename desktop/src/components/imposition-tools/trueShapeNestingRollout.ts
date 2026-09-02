/**
 * Cờ rollout và quy tắc hiển thị của chiến lược "Nesting tối ưu theo đường bế".
 *
 * NEST (audit 2026-08-28 §A4a-3). Kế hoạch:
 * `docs/KE_HOACH_TICH_HOP_NESTING_TU_DO_TEM_CNC_CHINH_THUC_2026-08-27.md`,
 * cổng Chặng 0: `docs/BAO_CAO_CHANG_0_NESTING_TU_DO_TEM_CNC_2026-08-28.md`.
 *
 * Module **thuần**, không import React: quy tắc phải test được ở mọi tổ hợp mà
 * không cần render, và phải đọc được từ module không thuộc app shell.
 *
 * ## Vì sao cờ RIÊNG, không dùng chung `VITE_MIXED_NESTING_ENABLED`
 *
 * `MIXED_NESTING_ENABLED` gác công cụ **Bình lồng ghép tự do standalone**. Chiến
 * lược này là đường **khác**: nó nằm trong Bình tem bế/CNC hiện hữu. Hai đường
 * phải bật/tắt độc lập, nếu không thì khi cần kill switch cho một đường sẽ phải
 * tắt luôn đường kia.
 *
 * ## Vì sao mặc định HOLD ở bản phát hành
 *
 * Số đo Lô 0 cho thấy free-angle còn **kém** cardinal ở 8/9 ca, và Cổng Chặng B
 * chưa đóng. Chặng A chỉ là canary nội bộ: đường production chạy cardinal, và
 * option chưa được công bố cho thợ in.
 */

/** Tên cờ frontend. Phải trùng chính tả với `build_production.ps1` khi nung cờ. */
export const TRUE_SHAPE_NESTING_FLAG_NAME = 'VITE_TRUE_SHAPE_NESTING_ENABLED' as const;

/** Tên cờ backend, để test parity chốt được cặp cờ khi lô route mở. */
export const TRUE_SHAPE_NESTING_BACKEND_FLAG_NAME =
  'PRYNX_TRUE_SHAPE_NESTING_ENABLED' as const;

/** Giá trị strategy trên đường truyền — suy từ enum Rust, xem `GridStrategyKind`. */
export const TRUE_SHAPE_NESTING_STRATEGY = 'true_shape_nesting' as const;

/** Công cụ được phép thấy option. Bình sách/guillotine không thuộc phạm vi. */
const ALLOWED_TOOLS = new Set(['sticker_imposer', 'cnc_imposer']);

/**
 * Quy tắc thuần, tách khỏi `import.meta.env` để test đủ tổ hợp.
 *
 * Dev chạy Vite thông dịch luôn mở (giống mọi tính năng đang làm); bản phát hành
 * phải bật cờ tường minh.
 */
export function isTrueShapeNestingEnabled(
  isDevelopment: boolean,
  releaseEnabled = false,
): boolean {
  return isDevelopment || releaseEnabled;
}

/**
 * Option có được hiện trong dropdown "Cách xếp" hay không.
 *
 * Ba điều kiện phải đồng thời đúng, và đây là **điểm chặn duy nhất**:
 *
 * 1. cờ rollout bật;
 * 2. công cụ là Bình tem bế hoặc Bình CNC;
 * 3. `taskMode === 'nup'` — nhánh dàn nhiều mẫu/gang.
 *
 * Chưa mở cho `step_repeat` (Bình trang/S&R): số đo Lô 0 cho thấy kernel còn kém
 * baseline rất xa ở S&R hình tam giác (77–84 so với 152 con/tờ), nên hiện option
 * ở đó là mời người dùng chọn phương án tệ hơn.
 */
export function shouldShowTrueShapeNestingOption(params: {
  enabled: boolean;
  activeTool: string;
  taskMode: string;
}): boolean {
  const { enabled, activeTool, taskMode } = params;
  if (!enabled) return false;
  if (!ALLOWED_TOOLS.has(activeTool)) return false;
  return taskMode === 'nup';
}

/**
 * Giá trị "Cách xếp" mặc định hợp lệ khi phải chuẩn hoá. Trùng default của `nupSlice`.
 */
export const DEFAULT_GRID_STRATEGY = 'optimal_auto' as const;

/**
 * Chuẩn hoá `gridStrategy` trước khi HIỂN THỊ và trước khi GỬI backend.
 *
 * NEST (audit 2026-08-29 §GRIDSTRATEGY-LEAK): `gridStrategy` được persist theo profile
 * công cụ. Nếu người dùng từng chọn `true_shape_nesting` (canary die-cut/CNC) rồi giá trị
 * đó **rò** sang công cụ khác — nhất là Bình cắt xén — hoặc còn kẹt khi cờ tắt ở bản phát
 * hành, thì: dropdown "Cách xếp" nhận một giá trị không có `<option>`, và backend
 * fail-closed ("Nesting … chỉ dùng cho Bình tem bế/CNC") mà người dùng **không gỡ được**
 * từ UI (option không hiện lại). Đây là trạng thái tự khoá.
 *
 * Hàm này là **điểm chuẩn hoá dùng chung**: khi `gridStrategy` là `true_shape_nesting` mà
 * [`shouldShowTrueShapeNestingOption`] cho `false` (sai công cụ / taskMode / cờ tắt) thì
 * trả [`DEFAULT_GRID_STRATEGY`]; mọi giá trị khác giữ nguyên. Thuần, test được đủ tổ hợp.
 *
 * KHÔNG nới cổng backend: backend vẫn fail-closed đúng khi người dùng THẬT SỰ chọn nesting
 * trong công cụ được hỗ trợ mà không chạy được. Gốc bệnh là giá trị rò ở frontend.
 */
export function resolveGridStrategy(params: {
  enabled: boolean;
  activeTool: string;
  taskMode: string;
  gridStrategy: string;
}): string {
  const { gridStrategy, enabled, activeTool, taskMode } = params;
  if (
    gridStrategy === TRUE_SHAPE_NESTING_STRATEGY &&
    !shouldShowTrueShapeNestingOption({ enabled, activeTool, taskMode })
  ) {
    return DEFAULT_GRID_STRATEGY;
  }
  return gridStrategy;
}

/**
 * Tập hình CÓ TÊN — mỗi loại đã có tiler chuyên biệt nên KHÔNG đi true-shape.
 *
 * Trùng đúng 10 giá trị non-CUSTOM của enum `ShapeType` backend
 * (`backend/app/workers/shape_types.py`). Đồng bộ hai bên là bất biến: lệch một tên ⇒
 * preview (frontend) và export (backend) phân loại khác nhau ⇒ drift.
 */
const NAMED_SHAPE_TYPES: ReadonlySet<string> = new Set([
  'CIRCLE_ELLIPSE',
  'TRIANGLE',
  'RECTANGLE',
  'PENTAGON',
  'HEXAGON',
  'DUMBBELL',
  'HAMMER',
  'TRAPEZOID',
  'PARALLELOGRAM',
  'ARROW',
]);

/**
 * Hình "đặc biệt" (CUSTOM) hay không — bản sao thuần của `_shape_is_special` backend.
 *
 * Thiếu / rỗng / không khớp mẫu có tên ⇒ đặc biệt (die-cut không mẫu tên mặc định CUSTOM).
 * Chỉ hình đặc biệt mới đi true-shape; hình có tên giữ nguyên tiler cũ (ranh giới §B10).
 */
export function isSpecialShapeType(value: string | null | undefined): boolean {
  if (value == null) return true;
  const key = value.trim().toUpperCase();
  if (key === '') return true;
  return !NAMED_SHAPE_TYPES.has(key);
}

/**
 * Tập chỉ số trang tham gia lấp đầy tờ — bản sao của `_autofill_pages` backend.
 *
 * Hợp của mọi khoá trang UI gửi (SL / hình / tham số hình). Rỗng ⇒ `[0]` (một mẫu, trang đầu).
 */
function autofillPages(
  sources: ReadonlyArray<Record<number, unknown> | null | undefined>,
): number[] {
  const pages = new Set<number>();
  for (const source of sources) {
    if (!source) continue;
    for (const key of Object.keys(source)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0) pages.add(index);
    }
  }
  return pages.size > 0 ? [...pages].sort((a, b) => a - b) : [0];
}

/**
 * Tập trang thực sự vào job — bản sao của `_page_quantities`(SL>0) ELSE `_autofill_pages`.
 *
 * Trang SL 0 KHÔNG vào job, nên một mẫu CUSTOM bị đặt SL 0 không được kéo cả tờ sang
 * true-shape (nếu không sẽ lệch với backend đã lọc SL>0 rồi mới phân loại).
 */
export function trueShapeJobPages(params: {
  shapesByPage?: Record<number, string> | null;
  targetQuantity?: number | string | null;
  targetQuantitiesByPage?: Record<number, number> | null;
  shapeParamsByPage?: Record<number, unknown> | null;
}): number[] {
  const knownPages = autofillPages([
    params.targetQuantitiesByPage,
    params.shapesByPage,
    params.shapeParamsByPage,
  ]);
  const rawGlobal = Number(params.targetQuantity ?? 0);
  const globalQuantity = Number.isFinite(rawGlobal) && rawGlobal > 0
    ? Math.trunc(rawGlobal)
    : 0;
  const merged = new Map<number, number>();

  // PARITY (audit 2026-08-29 §MAP-NEST-01): giống `_page_quantities` backend —
  // global là mặc định cho mọi trang đã biết; override hiện diện luôn thắng, kể cả 0.
  if (globalQuantity > 0) {
    for (const page of knownPages) merged.set(page, globalQuantity);
  }
  for (const [key, rawValue] of Object.entries(params.targetQuantitiesByPage || {})) {
    const page = Number(key);
    const value = Number(rawValue);
    if (!Number.isInteger(page) || page < 0 || !Number.isFinite(value)) continue;
    merged.set(page, Math.max(0, Math.trunc(value)));
  }

  const positive = [...merged.entries()]
    .filter(([, quantity]) => quantity > 0)
    .map(([page]) => page)
    .sort((a, b) => a - b);
  return positive.length > 0 ? positive : knownPages;
}

/**
 * Khóa chuẩn của tập mẫu thực sự tham gia job.
 *
 * Giá trị SL tuyệt đối không nằm trong khóa: đổi 100 → 200 nhưng vẫn cùng tập trang
 * thì hình học Bình trang không đổi. Thứ tự trang đã được `trueShapeJobPages` chuẩn hóa.
 */
export function trueShapeJobMembershipKey(
  params: Parameters<typeof trueShapeJobPages>[0],
): string {
  return trueShapeJobPages(params).join(',');
}

/**
 * Job có ÍT NHẤT một mẫu đặc biệt không — bản sao của `_job_has_special_shape` backend.
 *
 * Đây là mệnh đề "quy về đặc biệt hết": gang lẫn hình có tên + CUSTOM ⇒ có CUSTOM ⇒ cả tờ
 * true-shape. `shapesByPage` thiếu ⇒ thận trọng coi là đặc biệt (die-cut chưa dò = CUSTOM).
 */
export function jobHasSpecialShape(params: {
  shapesByPage?: Record<number, string> | null;
  targetQuantity?: number | string | null;
  targetQuantitiesByPage?: Record<number, number> | null;
  shapeParamsByPage?: Record<number, unknown> | null;
}): boolean {
  const shapes = params.shapesByPage;
  if (!shapes) return true;
  return trueShapeJobPages(params).some((page) => isSpecialShapeType(shapes[page]));
}

export type UnsupportedTrueShapeReason =
  | 'stack-layout'
  | 'one-dao'
  | 'grouping'
  | 'cluster-mode'
  | 'alternate-rotation'
  | 'cut-border'
  | 'hidden-ocg'
  | 'save-by-report';

export interface TrueShapeCompatibilityIntent {
  taskMode?: string | null;
  layoutType?: string | null;
  cutType?: string | null;
  groupingStrategy?: string | null;
  clusterMode?: string | null;
  alternateRotation?: string | null;
  cutBorderEnabled?: boolean;
  hiddenOcgLayerIds?: readonly (string | number)[] | null;
  saveByReport?: boolean;
  imposerMode?: string | null;
  cncTwoSided?: boolean;
  cncDuplexMarks?: boolean;
}

/** Bản sao thuần của `_unsupported_true_shape_reason` backend. */
export function unsupportedTrueShapeReason(
  intent: TrueShapeCompatibilityIntent,
): UnsupportedTrueShapeReason | null {
  const layoutType = String(intent.layoutType || 'sequential').trim().toLowerCase();
  if (layoutType === 'ratio_stack' || layoutType === 'cut_stacks') return 'stack-layout';
  if (String(intent.cutType || 'default').trim().toLowerCase() === 'one_dao') {
    return 'one-dao';
  }

  const taskMode = String(intent.taskMode || '').trim().toLowerCase();
  const isStepRepeat = taskMode === 'step_repeat' || taskMode === 'sr' || layoutType === 'repeat';
  const grouping = String(
    intent.groupingStrategy || (isStepRepeat ? 'none' : 'maximize_area'),
  ).trim().toLowerCase();
  // PARITY (audit 2026-08-29 MAP-NEST-04): N-up có hai contract độc lập.
  // S&R một mẫu không chia dải và chỉ nhận none/free_gang.
  const groupingAllowed = isStepRepeat
    ? grouping === 'free_gang' || grouping === 'none'
    : grouping === 'free_gang' || grouping === 'maximize_area';
  if (!groupingAllowed) return 'grouping';
  if (String(intent.clusterMode || 'none').trim().toLowerCase() !== 'none') {
    return 'cluster-mode';
  }
  if (String(intent.alternateRotation || 'none').trim().toLowerCase() !== 'none') {
    return 'alternate-rotation';
  }
  if (intent.cutBorderEnabled === true) return 'cut-border';
  if ((intent.hiddenOcgLayerIds?.length || 0) > 0) return 'hidden-ocg';
  if (intent.saveByReport === true) return 'save-by-report';
  return null;
}

/**
 * Có TỰ ĐỘNG định tuyến job sang true-shape nesting không — bản sao FRONTEND của
 * `route_true_shape` backend (`backend/app/workers/nup_true_shape_nesting.py`).
 *
 * Preview và export phải dùng cùng compatibility matrix. Setting chưa có semantics
 * true-shape được giữ ở lane legacy trước khi tạo preview, không đợi export đổi engine.
 */
export function shouldUseTrueShapeNesting(params: TrueShapeCompatibilityIntent & {
  enabled: boolean;
  isDieCut?: boolean;
  pageSheetMode?: boolean;
  gridStrategy?: string | null;
  shapesByPage?: Record<number, string> | null;
  targetQuantity?: number | string | null;
  targetQuantitiesByPage?: Record<number, number> | null;
  shapeParamsByPage?: Record<number, unknown> | null;
}): boolean {
  const {
    enabled,
    imposerMode,
    isDieCut,
    pageSheetMode,
    layoutType,
    gridStrategy,
  } = params;
  if (!enabled) return false;
  const isCnc = String(imposerMode || '').trim().toLowerCase() === 'cnc';
  if (!isCnc && !isDieCut) return false;
  if (pageSheetMode === true) return false;
  if (String(layoutType || '').trim() === 'mixed_guillotine') return false;
  if (String(gridStrategy || '').trim() !== DEFAULT_GRID_STRATEGY) return false;
  // PARITY (audit 2026-08-29 §MAP-NEST-03): cùng thứ tự/default với backend guard.
  if (unsupportedTrueShapeReason(params) !== null) return false;
  return jobHasSpecialShape(params);
}

const RELEASE_ENABLED =
  import.meta.env.VITE_TRUE_SHAPE_NESTING_ENABLED === 'true';

/** Giá trị dùng thật trong UI. */
export const TRUE_SHAPE_NESTING_ENABLED = isTrueShapeNestingEnabled(
  import.meta.env.DEV,
  RELEASE_ENABLED,
);
