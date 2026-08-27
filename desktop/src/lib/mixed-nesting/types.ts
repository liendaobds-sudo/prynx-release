/**
 * Hợp đồng dữ liệu "Bình lồng ghép tự do" — phase P8.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §9, §13.
 *
 * File này là bản **song ánh** của hai nguồn chân lý phía server:
 *
 * - `backend/app/schemas/mixed_nesting.py` (biên giới công khai)
 * - `imposition_core/src/mixed_nesting/model.rs` (hợp đồng engine)
 *
 * Bốn bất biến được mã hoá vào KIỂU, không chỉ nằm trong comment:
 *
 * 1. **Không có `translationStepMm`, không có matrix.** `Pose` chỉ có ba số thực. Không
 *    có kiểu nào trong file này nhận `a,b,c,d,e,f` hay `matrix`, nên một component muốn
 *    dựng transform tuỳ ý sẽ không compile.
 * 2. **`rotationDeg` là `number` liên tục**, không phải union `0 | 90 | 180 | 270`. Ràng
 *    buộc thu hẹp là `RotationConstraint`, và nó là **lựa chọn của người dùng**.
 * 3. **`reflection` là literal `'forbidden'`.** Không có kiểu nào cho phép giá trị khác.
 * 4. **Trường server-owned không có mặt trong `CreateJobRequest`.** `jobId`,
 *    `geometryHash`, `sourceRevision`, `referencePointMm` chỉ xuất hiện ở kiểu **kết
 *    quả**. Gửi kèm sẽ bị backend trả 422 (`extra="forbid"`), và ở đây thì không gõ được.
 */

/** Phiên bản protocol JSON. Lệch là từ chối, không có nhánh đoán ý. */
export const MIXED_NESTING_PROTOCOL_VERSION = 1;

/** Capability Free/Pro RIÊNG của tool. Không dùng `impo.diecut`/`packaging.dieline`. */
export const MIXED_NESTING_FEATURE_ID = 'impo.mixed_nesting' as const;

/** Trần byte của body `POST /jobs`, khớp `schemas/mixed_nesting.py::MAX_REQUEST_BYTES`. */
export const MAX_REQUEST_BYTES = 24 * 1024 * 1024;

// ─── Giới hạn, khớp `model.rs` ───────────────────────────────────────────────
export const MAX_PARTS = 2_000;
export const MAX_QUANTITY_PER_PART = 100_000;
export const MAX_INSTANCES_TOTAL = 100_000;
export const MAX_RING_VERTICES = 20_000;
export const MAX_TOTAL_VERTICES = 2_000_000;
export const MAX_HOLES_PER_PART = 1_000;
export const MAX_SHEETS_LIMIT = 10_000;
export const MAX_PART_ID_LEN = 128;
export const MAX_ROTATION_ANGLES = 4_096;
export const MAX_ROTATION_ARCS = 1_024;
export const MAX_TIME_BUDGET_MS = 24 * 60 * 60 * 1_000;

// ─────────────────────────────────────────────────────────────────────────────
//  Hình học
// ─────────────────────────────────────────────────────────────────────────────

/** Một điểm mm dạng `[x, y]` — đúng dạng mảng của `PointMm` phía Rust. */
export type PointMm = [number, number];

/** Một vòng kín. Đỉnh đầu KHÔNG lặp lại ở cuối. */
export type RingMm = PointMm[];

export interface SheetMarginMm {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface SheetSpec {
  widthMm: number;
  heightMm: number;
  marginMm: SheetMarginMm;
  maxSheets: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Rotation constraint — discriminated union theo `mode`
// ─────────────────────────────────────────────────────────────────────────────

/** Kế thừa policy cấp job. Chỉ hợp lệ ở cấp chi tiết. */
export interface RotationInherit {
  mode: 'inherit';
}

/**
 * Mọi góc trong miền **liên tục** `[0°, 360°)`. Đây là **mặc định của engine**.
 *
 * Không có trường nào để khai bước góc: `free` không phải "360 góc để thử".
 */
export interface RotationFree {
  mode: 'free';
}

/** Khóa đúng một góc — có thể không-cardinal, ví dụ `13.372849`. */
export interface RotationFixed {
  mode: 'fixed';
  angleDeg: number;
}

/** Tập góc hữu hạn. Preset 0/180 và 0/90/180/270 compile về mode này. */
export interface RotationDiscrete {
  mode: 'discrete';
  anglesDeg: number[];
}

/** Một cung góc liên tục. `sweepDeg` trong `(0, 360]` nên cung qua 0° rõ nghĩa. */
export interface AngleArcDeg {
  startDeg: number;
  sweepDeg: number;
}

/** Hợp của các cung liên tục — vẫn là miền **vô hạn góc**, không phải angle grid. */
export interface RotationRanges {
  mode: 'ranges';
  arcs: AngleArcDeg[];
}

/** Ràng buộc xoay ở **cấp chi tiết** — cho phép `inherit`. */
export type PartRotationConstraint =
  | RotationInherit
  | RotationFree
  | RotationFixed
  | RotationDiscrete
  | RotationRanges;

/** Ràng buộc xoay ở **cấp job** — KHÔNG cho `inherit` (không có gì để kế thừa). */
export type JobRotationConstraint =
  | RotationFree
  | RotationFixed
  | RotationDiscrete
  | RotationRanges;

export type RotationMode = PartRotationConstraint['mode'];

export const ROTATION_MODES: readonly RotationMode[] = [
  'inherit',
  'free',
  'fixed',
  'discrete',
  'ranges',
] as const;

/** Preset tiện dụng cho UI. Cả hai compile về `discrete` — KHÔNG tạo bước góc ẩn. */
export const ROTATION_PRESET_0_180: RotationDiscrete = {
  mode: 'discrete',
  anglesDeg: [0, 180],
};
export const ROTATION_PRESET_CARDINAL: RotationDiscrete = {
  mode: 'discrete',
  anglesDeg: [0, 90, 180, 270],
};

export interface OrientationPolicy {
  defaultRotation: JobRotationConstraint;
  /** Literal duy nhất. Protocol v1 không có đường bật phản chiếu. */
  reflection: 'forbidden';
}

export type MixedNestingProfile = 'fast' | 'balanced' | 'tight';

export const MIXED_NESTING_PROFILES: readonly MixedNestingProfile[] = [
  'fast',
  'balanced',
  'tight',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
//  Request
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Một loại chi tiết.
 *
 * Cố ý **không có** `referencePointMm`/`geometryHash`/`sourceRevision` — ba trường đó
 * do backend canonicalize và ký (§9.2).
 */
export interface PartSpec {
  partId: string;
  quantity: number;
  outer: RingMm;
  holes: RingMm[];
  rotationConstraint: PartRotationConstraint;
}

/** Body của `POST /api/mixed-nesting/jobs`. Không có `jobId`: server sinh bằng CSPRNG. */
export interface CreateJobRequest {
  protocolVersion: typeof MIXED_NESTING_PROTOCOL_VERSION;
  seed: number;
  profile: MixedNestingProfile;
  /** Vắng mặt ⇒ work-plan cố định (deterministic). Có ⇒ thêm deadline wall-clock. */
  timeBudgetMs?: number;
  sheet: SheetSpec;
  gapMm: number;
  orientationPolicy: OrientationPolicy;
  parts: PartSpec[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Kết quả
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pose SE(2) — **nguồn chân lý duy nhất** cho preview và export.
 *
 * `p_sheet = R(rotationDeg) × (p_source_local − referencePoint) + (translateXmm, translateYmm)`
 *
 * Ba số này được đọc **nguyên giá trị**. Không làm tròn, không snap pixel/lưới, không
 * đổi pivot theo bounding box sau xoay.
 */
export interface Pose {
  /** Degree, canonical trong `[0, 360)`. Số thực liên tục. */
  rotationDeg: number;
  /** mm, số thực liên tục. */
  translateXmm: number;
  /** mm, số thực liên tục. */
  translateYmm: number;
}

export interface PlacementRecord {
  /** Dạng `"<partId>#<ordinal 4 chữ số>"`. */
  instanceId: string;
  partId: string;
  sheetIndex: number;
  pose: Pose;
  sourceRevision?: string;
}

export type UnplacedReason =
  | 'NO_FEASIBLE_POSE'
  | 'SEARCH_BUDGET_EXHAUSTED'
  | 'MAX_SHEETS_REACHED'
  | 'CANCELLED';

export const UNPLACED_REASONS: readonly UnplacedReason[] = [
  'NO_FEASIBLE_POSE',
  'SEARCH_BUDGET_EXHAUSTED',
  'MAX_SHEETS_REACHED',
  'CANCELLED',
] as const;

export interface UnplacedRecord {
  instanceId: string;
  partId: string;
  reason: UnplacedReason;
}

export type TerminationReason =
  | 'all_placed'
  | 'work_budget_exhausted'
  | 'deadline'
  | 'max_sheets_reached'
  | 'cancelled';

export const TERMINATION_REASONS: readonly TerminationReason[] = [
  'all_placed',
  'work_budget_exhausted',
  'deadline',
  'max_sheets_reached',
  'cancelled',
] as const;

export interface RunStats {
  sheetCount: number;
  placedCount: number;
  unplacedCount: number;
  /** Thống kê. KHÔNG dùng làm tie-break giữa hai layout cùng số tờ. */
  materialUtilization: number;
  elapsedMs: number;
  attempts: number;
  orientationEvaluations: number;
  poseRefinements: number;
  terminationReason: TerminationReason;
}

export interface ValidationSummary {
  valid: boolean;
  validatorVersion: number;
}

export type ManifestStatus = 'completed' | 'failed' | 'cancelled';

/** Placement manifest. Preview và export dùng CHUNG object này, không dựng lại. */
export interface PlacementManifest {
  protocolVersion: number;
  engineVersion: string;
  jobId: string;
  seed: number;
  status: ManifestStatus;
  placements: PlacementRecord[];
  unplaced: UnplacedRecord[];
  stats: RunStats;
  validation: ValidationSummary;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Job
// ─────────────────────────────────────────────────────────────────────────────

/** Các pha của job (§12.2). `status` có thể là một pha hoặc một trạng thái terminal. */
export type JobPhase =
  | 'queued'
  | 'waiting_resources'
  | 'normalizing'
  | 'baseline'
  | 'nesting'
  | 'improving'
  | 'validating'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TERMINAL_JOB_STATUSES: readonly JobPhase[] = [
  'completed',
  'failed',
  'cancelled',
] as const;

export interface JobProgress {
  phase: string;
  /** 0..1. */
  progress: number;
  attempt: number;
  elapsedMs: number;
  bestSheetCount?: number | null;
  bestUtilization?: number | null;
  messageCode?: string | null;
}

export interface JobAccepted {
  jobId: string;
  status: string;
}

export interface JobStatus {
  jobId: string;
  status: string;
  terminal: boolean;
  cancelRequested: boolean;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  progress?: JobProgress | null;
  /** Mã lỗi ổn định khi `status === 'failed'`. */
  errorCode?: string | null;
  message?: string | null;
}

export interface JobCancelResult {
  jobId: string;
  status: string;
  cancelled: boolean;
  alreadyCancelled: boolean;
  terminal: boolean;
}

export interface JobDeleteResult {
  jobId: string;
  deleted: boolean;
}

/**
 * Kết quả `POST /jobs/{id}/export`. Khớp `schemas/mixed_nesting.py::ExportResponse`.
 *
 * Không có trường nào để chọn khổ tờ hay tỉ lệ: khổ đã nằm trong request đã validate của
 * job, và §13 cấm "xuất khác preview".
 */
export interface ExportResult {
  artifactId: string;
  jobId: string;
  sheetCount: number;
  sizeBytes: number;
  /** Băm hình học của mọi khuôn nguồn đã dùng. Đổi khuôn thì băm khác. */
  sourceRevision: string;
  exportRuleVersion: number;
  fileName: string;
}

export interface EngineCapabilities {
  protocolVersion: number;
  engineVersion: string;
  reflection: 'forbidden';
  defaultRotation: 'free';
  continuousTranslation: boolean;
  profiles: string[];
  maxRequestBytes: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Nguồn PDF khuôn bế
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trạng thái một nguồn đã nhập.
 *
 * `ambiguous` là **trạng thái thật**, không phải lỗi: file có nhiều vòng kín và server
 * KHÔNG đoán hộ (§10.5). `no_contour` nghĩa là không tìm được đường bế nào, người dùng có
 * thể xác nhận dùng khổ trang (§10.6).
 */
export type SourceStatus = 'ready' | 'ambiguous' | 'no_contour';

/** Lý do một vòng bị loại. Hiện cho người dùng biết file sai ở đâu, không im lặng bỏ. */
export type CandidateRejectedReason =
  | 'RING_NOT_CLOSED'
  | 'RING_SELF_INTERSECTING'
  | 'RING_TOO_MANY_VERTICES';

export interface ContourCandidate {
  candidateId: string;
  pageNumber: number;
  /** Contour ngoài, mm, đã dịch về gốc `(0,0)`. Vẽ được trực tiếp, không cần ảnh raster. */
  outer: RingMm;
  holes: RingMm[];
  areaMm2: number;
  widthMm: number;
  heightMm: number;
  vertexCount: number;
  rejectedReason?: CandidateRejectedReason | null;
}

export interface SourcePage {
  pageNumber: number;
  widthMm: number;
  heightMm: number;
}

export interface SourceRecord {
  sourceId: string;
  status: SourceStatus;
  fileName: string;
  candidates: ContourCandidate[];
  pages: SourcePage[];
  selectedCandidateId?: string | null;
  /** Băm hình học của ứng viên đang chọn. `null` khi chưa chọn. */
  sourceRevision?: string | null;
  flattenRuleVersion: number;
  createdAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trường legacy bị cấm
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tên trường của các protocol cũ/nháp mà payload **không được** mang.
 *
 * Vì sao cần danh sách này thay vì chỉ dựa vào `extra="forbid"` của backend: một payload
 * mang `allowedRotationsDeg` sẽ bị backend từ chối bằng 422 chung, còn frontend thì nên
 * nói rõ *trường nào* sai. Quan trọng hơn, `resultValidator` dùng danh sách này để chặn
 * manifest lạ **trước khi** preview/export đọc pose — nếu một trường như
 * `translationStepMm` hay `matrix` xuất hiện trong result thì có nghĩa nguồn chân lý đã
 * bị thay, và im lặng bỏ qua nó là cách sinh ra layout khác với bản đã validate.
 */
export const FORBIDDEN_LEGACY_FIELDS: readonly string[] = [
  'translationStepMm',
  'translationStep',
  'angleStepDeg',
  'angleStep',
  'rotationStepDeg',
  'allowedRotationsDeg',
  'allowedRotations',
  'rotationsDeg',
  'snapToGridMm',
  'gridMm',
  'matrix',
  'transform',
  'transformMatrix',
  'affine',
  'mirror',
  'mirrorX',
  'mirrorY',
  'flipX',
  'flipY',
  'scale',
  'scaleX',
  'scaleY',
  'shear',
  'skewX',
  'skewY',
  'reflect',
  'reflection',
] as const;

/** Trường do server sở hữu; client gửi kèm là lỗi hợp đồng, không phải "gợi ý". */
export const SERVER_OWNED_FIELDS: readonly string[] = [
  'jobId',
  'geometryHash',
  'sourceRevision',
  'referencePointMm',
] as const;
