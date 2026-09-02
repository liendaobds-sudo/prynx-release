/**
 * Client API "Bình lồng ghép tự do" — phase P8.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §12.1, §16.4.
 *
 * Ba nguyên tắc:
 *
 * 1. **Đi qua `authenticatedFetch`.** Header license và chữ ký do Rust ký; module này
 *    không tự đặt header `X-License-*`/`X-PrynX-*` (interceptor sẽ xoá và ký lại).
 * 2. **Không gửi trường server-owned.** `buildCreateJobRequest` dựng payload từ đúng các
 *    trường hợp lệ; `assertNoForbiddenFields` chặn trước khi gửi để lỗi hiện ở nơi gây ra
 *    thay vì thành một 422 chung từ backend.
 * 3. **Giữ nguyên precision.** Không `toFixed`, không `Math.round`, không parse lại số qua
 *    chuỗi hiển thị. `JSON.stringify`/`JSON.parse` của JS round-trip `double` chính xác,
 *    nên góc `13.372849` và X/Y phần lẻ đi qua nguyên vẹn.
 */

import { authenticatedFetch, formatApiErrorDetail, getApiUrl, prepareFileForUpload } from '../api';
import {
  FORBIDDEN_LEGACY_FIELDS,
  MAX_REQUEST_BYTES,
  MIXED_NESTING_PROTOCOL_VERSION,
  SERVER_OWNED_FIELDS,
  type ContourCandidate,
  type AutofillPartSpec,
  type AutofillSingleSheetCreateJobRequest,
  type CreateJobRequest,
  type EngineCapabilities,
  type ExportResult,
  type JobAccepted,
  type JobCancelResult,
  type JobDeleteResult,
  type JobStatus,
  type MixedNestingProfile,
  type OrientationPolicy,
  type PartSpec,
  type QuantityFulfillmentCreateJobRequest,
  type SingleSheetSpec,
  type PlacementManifest,
  type SheetSpec,
  type SourceRecord,
} from './types';

const BASE = () => `${getApiUrl()}/mixed-nesting`;

/** Lỗi API có mã ổn định, đủ để UI phân biệt 403/404/409/413/429/503. */
export class MixedNestingApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'MixedNestingApiError';
    this.status = status;
    this.code = code;
  }

  /** Tính năng chưa mở trong bản phát hành, hoặc job không tồn tại/không phải của mình. */
  get isUnavailable(): boolean {
    return this.status === 404;
  }

  /** Thiếu quyền: gói Free hoặc license không có capability. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** Phần lõi tính toán thiếu hoặc lệch phiên bản. KHÔNG có đường fallback. */
  get isEngineUnavailable(): boolean {
    return this.status === 503 || this.code === 'ENGINE_UNAVAILABLE';
  }
}

async function toApiError(response: Response, fallback: string): Promise<MixedNestingApiError> {
  let detail: unknown;
  try {
    detail = (await response.json())?.detail;
  } catch {
    detail = undefined;
  }
  let code: string | undefined;
  if (detail && typeof detail === 'object' && 'code' in detail) {
    const raw = (detail as { code?: unknown }).code;
    if (typeof raw === 'string') code = raw;
  }
  return new MixedNestingApiError(formatApiErrorDetail(detail, fallback), response.status, code);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Dựng request
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tìm trường bị cấm ở MỌI độ sâu của payload.
 *
 * Đi đệ quy thay vì chỉ soi tầng một: `parts[i].referencePointMm` hay
 * `orientationPolicy.angleStepDeg` cũng phải bị chặn, và đó đúng là chỗ dễ lọt nhất khi
 * ai đó spread một object state của UI vào payload.
 */
export function findForbiddenFields(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenFields(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];

  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    // `reflection: 'forbidden'` là trường HỢP LỆ duy nhất mang tên nằm trong danh sách
    // cấm; nó chỉ bị cấm khi mang giá trị khác literal đó.
    if (key === 'reflection') {
      if (child !== 'forbidden') found.push(here);
      continue;
    }
    if (FORBIDDEN_LEGACY_FIELDS.includes(key) || SERVER_OWNED_FIELDS.includes(key)) {
      found.push(here);
      continue;
    }
    found.push(...findForbiddenFields(child, here));
  }
  return found;
}

export function assertNoForbiddenFields(payload: unknown): void {
  const found = findForbiddenFields(payload);
  if (found.length > 0) {
    throw new MixedNestingApiError(
      `Dữ liệu lệnh chứa trường không được phép: ${found.join(', ')}.`,
      422,
      'MIXED_NESTING_INVALID_REQUEST',
    );
  }
}

interface BuildJobOptionsBase {
  seed: number;
  profile: MixedNestingProfile;
  gapMm: number;
  orientationPolicy: OrientationPolicy;
  timeBudgetMs?: number;
}

export type QuantityBuildJobOptions = BuildJobOptionsBase & {
  layoutIntent: 'quantity_fulfillment';
  sheet: SheetSpec;
  parts: PartSpec[];
};

export type AutofillBuildJobOptions = BuildJobOptionsBase & {
  layoutIntent: 'autofill_single_sheet';
  sheet: SingleSheetSpec;
  parts: AutofillPartSpec[];
};

export type BuildJobOptions = QuantityBuildJobOptions | AutofillBuildJobOptions;

/**
 * Dựng body `POST /jobs` từ state UI.
 *
 * Chỉ copy đúng các trường của hợp đồng: nếu state UI mang thêm gì thì nó **không** đi
 * vào payload. Đây là lớp phòng thứ nhất; `assertNoForbiddenFields` là lớp thứ hai cho
 * trường hợp chính các trường hợp đồng bị nhồi dữ liệu lạ ở tầng sâu hơn.
 */
export function buildCreateJobRequest(
  options: QuantityBuildJobOptions,
): QuantityFulfillmentCreateJobRequest;
export function buildCreateJobRequest(
  options: AutofillBuildJobOptions,
): AutofillSingleSheetCreateJobRequest;
export function buildCreateJobRequest(options: BuildJobOptions): CreateJobRequest {
  const common = {
    protocolVersion: MIXED_NESTING_PROTOCOL_VERSION as typeof MIXED_NESTING_PROTOCOL_VERSION,
    seed: options.seed,
    profile: options.profile,
    sheet: {
      widthMm: options.sheet.widthMm,
      heightMm: options.sheet.heightMm,
      marginMm: {
        left: options.sheet.marginMm.left,
        right: options.sheet.marginMm.right,
        top: options.sheet.marginMm.top,
        bottom: options.sheet.marginMm.bottom,
      },
      maxSheets: options.sheet.maxSheets,
    },
    gapMm: options.gapMm,
    orientationPolicy: {
      defaultRotation: options.orientationPolicy.defaultRotation,
      reflection: 'forbidden' as const,
    },
  };
  const copyGeometry = (part: PartSpec | AutofillPartSpec) => ({
    partId: part.partId,
    outer: part.outer.map((point) => [point[0], point[1]] as [number, number]),
    holes: part.holes.map((ring) =>
      ring.map((point) => [point[0], point[1]] as [number, number]),
    ),
    rotationConstraint: part.rotationConstraint,
  });

  let request: CreateJobRequest;
  if (options.layoutIntent === 'autofill_single_sheet') {
    if (options.sheet.maxSheets !== 1) {
      throw new MixedNestingApiError(
        'Tự lấp đầy chỉ được chạy trên đúng một tờ.',
        422,
        'MIXED_NESTING_INVALID_REQUEST',
      );
    }
    request = {
      ...common,
      layoutIntent: 'autofill_single_sheet',
      sheet: { ...common.sheet, maxSheets: 1 },
      parts: options.parts.map(copyGeometry),
    };
  } else {
    const quantityRequest: QuantityFulfillmentCreateJobRequest = {
      ...common,
      layoutIntent: 'quantity_fulfillment',
      parts: options.parts.map((part) => ({
        ...copyGeometry(part),
        quantity: part.quantity,
      })),
    };
    request = quantityRequest;
  }
  if (options.timeBudgetMs !== undefined) request.timeBudgetMs = options.timeBudgetMs;
  assertNoForbiddenFields(request);
  return request;
}

/** Serialize + kiểm trần byte TRƯỚC khi gửi, để lỗi 413 không phải là bất ngờ ở server. */
export function serializeCreateJobRequest(request: CreateJobRequest): string {
  assertNoForbiddenFields(request);
  const body = JSON.stringify(request);
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_REQUEST_BYTES) {
    throw new MixedNestingApiError(
      `Dữ liệu lồng ghép quá lớn (${bytes} byte, trần ${MAX_REQUEST_BYTES} byte). `
        + 'Hãy giảm số chi tiết hoặc đơn giản hoá contour.',
      413,
      'MIXED_NESTING_REQUEST_TOO_LARGE',
    );
  }
  return body;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Endpoint
// ─────────────────────────────────────────────────────────────────────────────

export async function getCapabilities(signal?: AbortSignal): Promise<EngineCapabilities> {
  const response = await authenticatedFetch(`${BASE()}/capabilities`, { signal });
  if (!response.ok) {
    throw await toApiError(response, 'Không đọc được năng lực engine lồng ghép.');
  }
  const raw: unknown = await response.json();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MixedNestingApiError(
      'Năng lực engine lồng ghép không đúng hợp đồng.',
      503,
      'ENGINE_UNAVAILABLE',
    );
  }
  const caps = raw as Record<string, unknown>;
  const profiles = caps.profiles;
  const layoutIntents = caps.layoutIntents;
  const valid = caps.protocolVersion === MIXED_NESTING_PROTOCOL_VERSION
    && typeof caps.engineVersion === 'string'
    && caps.engineVersion.length > 0
    && caps.reflection === 'forbidden'
    && caps.defaultRotation === 'free'
    && caps.continuousTranslation === true
    && Array.isArray(profiles)
    && ['fast', 'balanced', 'tight'].every((item) => profiles.includes(item))
    && Array.isArray(layoutIntents)
    && ['quantity_fulfillment', 'autofill_single_sheet'].every(
      (item) => layoutIntents.includes(item),
    )
    && typeof caps.maxRequestBytes === 'number'
    && Number.isFinite(caps.maxRequestBytes)
    && caps.maxRequestBytes > 0;
  if (!valid) {
    throw new MixedNestingApiError(
      `Engine lồng ghép không tương thích protocol ${MIXED_NESTING_PROTOCOL_VERSION}.`,
      503,
      'ENGINE_UNAVAILABLE',
    );
  }
  return raw as EngineCapabilities;
}

export async function createJob(
  request: CreateJobRequest,
  signal?: AbortSignal,
): Promise<JobAccepted> {
  const body = serializeCreateJobRequest(request);
  const response = await authenticatedFetch(`${BASE()}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
  });
  if (!response.ok) {
    throw await toApiError(response, 'Không tạo được job lồng ghép.');
  }
  return response.json();
}

export async function getJobStatus(jobId: string, signal?: AbortSignal): Promise<JobStatus> {
  const response = await authenticatedFetch(
    `${BASE()}/jobs/${encodeURIComponent(jobId)}`,
    { signal },
  );
  if (!response.ok) {
    throw await toApiError(response, 'Không đọc được trạng thái job lồng ghép.');
  }
  return response.json();
}

/**
 * Manifest đã validate. `409` khi job chưa terminal hoặc không có kết quả — đó là hợp
 * đồng, không phải lỗi mạng: gọi khi `terminal === false` là dùng sai.
 */
export async function getJobResult(
  jobId: string,
  signal?: AbortSignal,
): Promise<PlacementManifest> {
  const response = await authenticatedFetch(
    `${BASE()}/jobs/${encodeURIComponent(jobId)}/result`,
    { signal },
  );
  if (!response.ok) {
    throw await toApiError(response, 'Không đọc được kết quả lồng ghép.');
  }
  return response.json();
}

export async function cancelJob(jobId: string): Promise<JobCancelResult> {
  const response = await authenticatedFetch(
    `${BASE()}/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw await toApiError(response, 'Không hủy được job lồng ghép.');
  }
  return response.json();
}

export async function deleteJob(jobId: string): Promise<JobDeleteResult> {
  const response = await authenticatedFetch(
    `${BASE()}/jobs/${encodeURIComponent(jobId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    throw await toApiError(response, 'Không xóa được job lồng ghép.');
  }
  return response.json();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Preview nesting của Bình tem/CNC — PV-A2
// ─────────────────────────────────────────────────────────────────────────────

const NESTING_PREVIEW_BASE = () => `${getApiUrl()}/imposition/preview-layout/jobs`;

/** Body giữ nguyên hợp đồng snake_case của ``PreviewLayoutRequest`` phía sidecar. */
export type NestingPreviewJobRequest = Readonly<Record<string, unknown>>;

export interface NestingPreviewJobAccepted {
  job_id: string;
  status: string;
}

export interface NestingPreviewJobProgress {
  phase: string;
  progress: number;
  attempt?: number;
  attempts?: number;
  elapsedMs: number;
  bestSheetCount?: number;
  bestUtilization?: number;
  messageCode?: string;
}

export interface NestingPreviewJobStatus {
  job_id: string;
  status: string;
  terminal: boolean;
  cancel_requested: boolean;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  progress: NestingPreviewJobProgress | null;
  error_code: string | null;
  message: string | null;
  has_result: boolean;
}

export interface NestingPreviewJobCancelResult {
  job_id: string;
  status: string;
  cancelled: boolean;
  already_cancelled: boolean;
  terminal: boolean;
}

export async function createNestingPreviewJob(
  request: NestingPreviewJobRequest,
): Promise<NestingPreviewJobAccepted> {
  // Không nhận AbortSignal: nếu browser ngắt POST sau khi sidecar đã nhận, client sẽ
  // mất job_id và không thể hủy solve. Caller dùng generation guard, rồi hủy job ngay
  // khi 202 tới nếu request đã bị supersede.
  const response = await authenticatedFetch(NESTING_PREVIEW_BASE(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await toApiError(response, 'Không tạo được job preview nesting.');
  }
  return response.json();
}

export async function getNestingPreviewJobStatus(
  jobId: string,
  signal?: AbortSignal,
): Promise<NestingPreviewJobStatus> {
  const response = await authenticatedFetch(
    `${NESTING_PREVIEW_BASE()}/${encodeURIComponent(jobId)}`,
    { signal },
  );
  if (!response.ok) {
    throw await toApiError(response, 'Không đọc được tiến độ preview nesting.');
  }
  return response.json();
}

export async function getNestingPreviewJobResult<Result>(
  jobId: string,
  signal?: AbortSignal,
): Promise<Result> {
  const response = await authenticatedFetch(
    `${NESTING_PREVIEW_BASE()}/${encodeURIComponent(jobId)}/result`,
    { signal },
  );
  if (!response.ok) {
    throw await toApiError(response, 'Không đọc được kết quả preview nesting.');
  }
  return response.json();
}

export async function cancelNestingPreviewJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<NestingPreviewJobCancelResult> {
  const response = await authenticatedFetch(
    `${NESTING_PREVIEW_BASE()}/${encodeURIComponent(jobId)}/cancel`,
    { method: 'POST', signal },
  );
  if (!response.ok) {
    throw await toApiError(response, 'Không hủy được preview nesting.');
  }
  return response.json();
}

/** Polling 300–500 ms: đủ mượt cho phase/progress nhưng không dội request vào sidecar. */
export const NESTING_PREVIEW_POLL_INTERVAL_MS = 400;

export interface NestingPreviewPollOptions {
  onStatus?: (status: NestingPreviewJobStatus) => void | boolean;
  intervalMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const sleepNestingPreviewPoll = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Đã dừng theo dõi preview nesting.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Đã dừng theo dõi preview nesting.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export async function waitForNestingPreviewJob(
  jobId: string,
  options: NestingPreviewPollOptions = {},
): Promise<NestingPreviewJobStatus> {
  const intervalMs = options.intervalMs ?? NESTING_PREVIEW_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? sleepNestingPreviewPoll;
  for (;;) {
    options.signal?.throwIfAborted();
    const status = await getNestingPreviewJobStatus(jobId, options.signal);
    const keepPolling = options.onStatus?.(status);
    if (status.terminal || keepPolling === false) return status;
    await sleep(intervalMs, options.signal);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Xuất PDF — phase P14a
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sinh PDF tờ đã lồng ghép từ phương án **đã validate** của job.
 *
 * Cố ý **không có tham số nào ngoài `jobId`**. Khổ tờ, lề, khoảng hở đều lấy từ request đã
 * validate lúc chạy solve (`mixed_nesting_jobs.request_of`). Cho client gửi lại khổ ở lần
 * xuất là mở đường xuất trên khổ khác khổ đã kiểm — đúng thứ §13 cấm.
 *
 * `409` khi job chưa có phương án; `410`/`409` khi khuôn nguồn đã hết hạn TTL nên không dựng
 * lại được hình. Cả hai là hợp đồng, không phải lỗi mạng.
 */
export async function exportJob(jobId: string): Promise<ExportResult> {
  const response = await authenticatedFetch(
    `${BASE()}/jobs/${encodeURIComponent(jobId)}/export`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw await toApiError(response, 'Không xuất được PDF tờ đã lồng ghép.');
  }
  return response.json();
}

/**
 * Tải bytes PDF đã xuất. Trả `Blob` để người gọi tự quyết định lưu ở đâu.
 *
 * Đi qua `authenticatedFetch` chứ **không** dựng URL cho `<a href>`: endpoint đòi header
 * license đã ký, và file này cố ý không công khai qua `/results`.
 */
export async function fetchJobArtifact(jobId: string): Promise<Blob> {
  const response = await authenticatedFetch(
    `${BASE()}/jobs/${encodeURIComponent(jobId)}/artifact`,
  );
  if (!response.ok) {
    throw await toApiError(response, 'Không tải được PDF đã xuất.');
  }
  return response.blob();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Polling
// ─────────────────────────────────────────────────────────────────────────────

/** Khoảng polling theo §12.1: 300–500 ms. Không dùng WebSocket của Compare. */
export const POLL_INTERVAL_MS = 400;

export interface PollOptions {
  /** Gọi mỗi lần có snapshot mới. Trả `false` để dừng polling (ví dụ tab đã đóng). */
  onStatus?: (status: JobStatus) => void | boolean;
  intervalMs?: number;
  signal?: AbortSignal;
  /** Trần tổng thời gian chờ. Hết hạn thì **không** hủy job, chỉ thôi theo dõi. */
  timeoutMs?: number;
  /** Cho test thay `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Chờ job về terminal.
 *
 * Cố ý **không** tự hủy job khi hết `timeoutMs` hay khi `signal` abort: hủy là quyết định
 * của người dùng. Người gọi muốn hủy thì gọi `cancelJob` tường minh — nếu hàm này tự hủy
 * thì việc đóng tab hoặc mất mạng tạm sẽ giết job đang chạy tốt.
 */
export async function waitForJob(jobId: string, options: PollOptions = {}): Promise<JobStatus> {
  const interval = options.intervalMs ?? POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs;

  for (;;) {
    if (options.signal?.aborted) {
      throw new MixedNestingApiError('Đã dừng theo dõi job lồng ghép.', 499);
    }
    const status = await getJobStatus(jobId, options.signal);
    const keepGoing = options.onStatus?.(status);
    if (status.terminal) return status;
    if (keepGoing === false) return status;
    if (deadline !== null && Date.now() >= deadline) {
      throw new MixedNestingApiError(
        'Hết thời gian theo dõi job lồng ghép. Job vẫn đang chạy trên máy.',
        504,
      );
    }
    await sleep(interval);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
//  Nguồn PDF khuôn bế — phase P13
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trần byte của file PDF nhận vào, khớp
 * ``backend/app/workers/mixed_nesting_pdf_source.py::MAX_SOURCE_BYTES``.
 *
 * Kiểm ở đây để người dùng biết ngay tại chỗ chọn file, thay vì chờ 413 từ server sau khi
 * đã tải xong 60 MB qua IPC.
 */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/**
 * Gửi **bytes** PDF lên server và nhận danh sách đường bế ứng viên.
 *
 * Không gửi đường dẫn cục bộ (§10.1). Với "fake File" của Tauri (blob rỗng nhưng có
 * `.path`), `prepareFileForUpload` đọc lại bytes thật từ đĩa **trong Rust** rồi mới gửi —
 * đó là lý do phải đi qua helper đó thay vì `FormData.append(file)` trực tiếp.
 */
export async function createSource(file: File, signal?: AbortSignal): Promise<SourceRecord> {
  if (file.size > MAX_SOURCE_BYTES) {
    throw new MixedNestingApiError(
      `File PDF vượt trần ${Math.round(MAX_SOURCE_BYTES / (1024 * 1024))} MB.`,
      413,
      'MIXED_NESTING_SOURCE_TOO_LARGE',
    );
  }
  const upload = await prepareFileForUpload(file);
  const body = new FormData();
  body.append('file', upload, file.name);
  const response = await authenticatedFetch(`${BASE()}/sources`, {
    method: 'POST',
    body,
    signal,
  });
  if (!response.ok) {
    throw await toApiError(response, 'Không đọc được khuôn bế từ file PDF.');
  }
  return response.json();
}

export async function getSource(sourceId: string, signal?: AbortSignal): Promise<SourceRecord> {
  const response = await authenticatedFetch(
    `${BASE()}/sources/${encodeURIComponent(sourceId)}`,
    { signal },
  );
  if (!response.ok) throw await toApiError(response, 'Không đọc được khuôn đã nhập.');
  return response.json();
}

/** Chọn đường bế khi file có nhiều vòng kín. Server không tự đoán (§10.5). */
export async function selectSourceCandidate(
  sourceId: string,
  candidateId: string,
): Promise<SourceRecord> {
  const response = await authenticatedFetch(
    `${BASE()}/sources/${encodeURIComponent(sourceId)}/select`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId }),
    },
  );
  if (!response.ok) throw await toApiError(response, 'Không chọn được đường bế.');
  return response.json();
}

/** Xác nhận dùng khổ trang làm hình chữ nhật (§10.6). Endpoint riêng, không phải một cờ. */
export async function acceptSourcePageBox(
  sourceId: string,
  pageNumber: number,
): Promise<SourceRecord> {
  const response = await authenticatedFetch(
    `${BASE()}/sources/${encodeURIComponent(sourceId)}/page-box`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageNumber }),
    },
  );
  if (!response.ok) throw await toApiError(response, 'Không dùng được khổ trang.');
  return response.json();
}

export async function deleteSource(sourceId: string): Promise<void> {
  const response = await authenticatedFetch(
    `${BASE()}/sources/${encodeURIComponent(sourceId)}`,
    { method: 'DELETE' },
  );
  // 404 nghĩa là đã không còn — coi như xóa xong, không làm người dùng thấy lỗi.
  if (!response.ok && response.status !== 404) {
    throw await toApiError(response, 'Không xóa được khuôn đã nhập.');
  }
}

/** Ứng viên đang được chọn của một nguồn. `null` khi còn `ambiguous`. */
export function selectedCandidateOf(source: SourceRecord): ContourCandidate | null {
  if (!source.selectedCandidateId) return null;
  return (
    source.candidates.find((item) => item.candidateId === source.selectedCandidateId) ?? null
  );
}

/** Chỉ những ứng viên dùng được. Ứng viên bị loại vẫn hiện để người dùng biết vì sao. */
export function usableCandidatesOf(source: SourceRecord): ContourCandidate[] {
  return source.candidates.filter((item) => !item.rejectedReason);
}
