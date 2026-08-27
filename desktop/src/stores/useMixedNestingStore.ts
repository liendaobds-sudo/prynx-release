/**
 * Store "Bình lồng ghép tự do" — phase P10.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §6.4, §12, §16.4.
 *
 * Năm ràng buộc, mỗi cái có test trong `useMixedNestingStore.test.ts`:
 *
 * 1. **Phân vùng theo `tabId`.** Hai tab không dùng chung chi tiết, job, tiến độ hay kết
 *    quả. `destroyTab` xoá sạch key để đóng tab không rò RAM.
 * 2. **Mặc định là free-angle.** Cấp job mặc định `{ mode: 'free' }`, cấp chi tiết mặc
 *    định `{ mode: 'inherit' }`. Không có state nào tên `angleStep`, `snapMm`, `mirror`.
 * 3. **Job cũ không ghi đè tab.** Mỗi lần chạy tăng `runToken`; snapshot/manifest mang
 *    `jobId` không khớp job hiện tại thì bị **bỏ qua**, không phải "cập nhật nhẹ".
 * 4. **Sửa đầu vào thì kết quả cũ mất hiệu lực.** `revision` tăng theo mọi thay đổi hình
 *    học/tham số; manifest thuộc revision cũ không được preview hay xuất.
 * 5. **`dirty` phản ánh dữ liệu người dùng**, không phản ánh việc job đang chạy.
 */

import { create } from 'zustand';

import { buildCreateJobRequest } from '../lib/mixed-nesting/api';
import { validateManifest, type ValidationIssue } from '../lib/mixed-nesting/resultValidator';
import type {
  CreateJobRequest,
  JobProgress,
  JobRotationConstraint,
  JobStatus,
  MixedNestingProfile,
  PartRotationConstraint,
  PlacementManifest,
  RingMm,
  SheetSpec,
} from '../lib/mixed-nesting/types';

/** Chi tiết trong bảng UI. `uiId` chỉ để React key; `partId` là thứ gửi lên server. */
export interface MixedNestingPart {
  uiId: string;
  partId: string;
  quantity: number;
  outer: RingMm;
  holes: RingMm[];
  rotationConstraint: PartRotationConstraint;
  /** Tên nguồn để hiển thị. Không gửi lên server. */
  sourceLabel?: string;
}

export interface MixedNestingJobState {
  jobId: string;
  status: string;
  terminal: boolean;
  cancelRequested: boolean;
  progress: JobProgress | null;
  errorCode: string | null;
  message: string | null;
  /** `revision` của đầu vào tại lúc gửi job. Dùng để phát hiện kết quả lỗi thời. */
  revision: number;
  /** Token tăng dần mỗi lần chạy; chặn snapshot của lượt chạy trước. */
  runToken: number;
}

export interface MixedNestingTabState {
  sheet: SheetSpec;
  gapMm: number;
  profile: MixedNestingProfile;
  seed: number;
  /** `null` ⇒ work-plan cố định (deterministic). Số ⇒ thêm deadline. */
  timeBudgetMs: number | null;
  /** Ràng buộc xoay cấp job. Mặc định free — đây là mặc định của sản phẩm. */
  defaultRotation: JobRotationConstraint;
  parts: MixedNestingPart[];
  /** Tăng theo mọi thay đổi đầu vào. Kết quả gắn revision cũ là lỗi thời. */
  revision: number;
  job: MixedNestingJobState | null;
  manifest: PlacementManifest | null;
  /** Revision của đầu vào mà `manifest` thuộc về. */
  manifestRevision: number | null;
  issues: ValidationIssue[];
  error: string;
  activeSheetIndex: number;
  runToken: number;
}

export const DEFAULT_SHEET: SheetSpec = {
  widthMm: 700,
  heightMm: 1000,
  marginMm: { left: 10, right: 10, top: 10, bottom: 10 },
  maxSheets: 20,
};

export const DEFAULT_GAP_MM = 3;
export const DEFAULT_PROFILE: MixedNestingProfile = 'balanced';
export const DEFAULT_SEED = 20260826;

/** Mặc định của engine và của sản phẩm: **tự do, liên tục**. */
export const DEFAULT_JOB_ROTATION: JobRotationConstraint = { mode: 'free' };
/** Chi tiết mới kế thừa policy cấp job. */
export const DEFAULT_PART_ROTATION: PartRotationConstraint = { mode: 'inherit' };

function makeDefaultTab(): MixedNestingTabState {
  return {
    sheet: {
      widthMm: DEFAULT_SHEET.widthMm,
      heightMm: DEFAULT_SHEET.heightMm,
      marginMm: { ...DEFAULT_SHEET.marginMm },
      maxSheets: DEFAULT_SHEET.maxSheets,
    },
    gapMm: DEFAULT_GAP_MM,
    profile: DEFAULT_PROFILE,
    seed: DEFAULT_SEED,
    timeBudgetMs: null,
    defaultRotation: { ...DEFAULT_JOB_ROTATION },
    parts: [],
    revision: 1,
    job: null,
    manifest: null,
    manifestRevision: null,
    issues: [],
    error: '',
    activeSheetIndex: 0,
    runToken: 0,
  };
}

let uiIdCounter = 0;
function nextUiId(): string {
  uiIdCounter += 1;
  return `mnp-${uiIdCounter}`;
}

export interface MixedNestingStore {
  tabs: Record<string, MixedNestingTabState>;

  initTab: (tabId: string) => void;
  getTab: (tabId: string) => MixedNestingTabState;
  destroyTab: (tabId: string) => void;
  reset: (tabId: string) => void;

  // ── Đầu vào ──
  setSheet: (tabId: string, patch: Partial<SheetSpec>) => void;
  setMargin: (tabId: string, patch: Partial<SheetSpec['marginMm']>) => void;
  setGapMm: (tabId: string, value: number) => void;
  setProfile: (tabId: string, value: MixedNestingProfile) => void;
  setSeed: (tabId: string, value: number) => void;
  setTimeBudgetMs: (tabId: string, value: number | null) => void;
  setDefaultRotation: (tabId: string, value: JobRotationConstraint) => void;

  addPart: (tabId: string, part: Omit<MixedNestingPart, 'uiId'>) => string;
  updatePart: (tabId: string, uiId: string, patch: Partial<Omit<MixedNestingPart, 'uiId'>>) => void;
  setPartRotation: (tabId: string, uiId: string, value: PartRotationConstraint) => void;
  removePart: (tabId: string, uiId: string) => void;

  // ── Job ──
  beginRun: (tabId: string, jobId: string) => void;
  applyJobStatus: (tabId: string, status: JobStatus) => boolean;
  applyManifest: (tabId: string, manifest: unknown) => boolean;
  markCancelRequested: (tabId: string) => void;
  clearJob: (tabId: string) => void;
  setError: (tabId: string, message: string) => void;
  setActiveSheetIndex: (tabId: string, index: number) => void;
}

function patchTab(
  tabs: Record<string, MixedNestingTabState>,
  tabId: string,
  update: (tab: MixedNestingTabState) => MixedNestingTabState,
): Record<string, MixedNestingTabState> {
  const current = tabs[tabId] ?? makeDefaultTab();
  return { ...tabs, [tabId]: update(current) };
}

/**
 * Đánh dấu đầu vào đã đổi: tăng `revision` và **bỏ** kết quả cũ khỏi vùng dùng được.
 *
 * Cố ý xoá `manifest` thay vì chỉ đánh dấu: giữ manifest lỗi thời trong state là mời gọi
 * một component nào đó đọc nó ra để vẽ hoặc xuất.
 */
function touchInput(tab: MixedNestingTabState): MixedNestingTabState {
  return {
    ...tab,
    revision: tab.revision + 1,
    manifest: null,
    manifestRevision: null,
    issues: [],
  };
}

export const useMixedNestingStore = create<MixedNestingStore>((set, get) => ({
  tabs: {},

  initTab: (tabId) => {
    if (get().tabs[tabId]) return;
    set((state) => ({ tabs: { ...state.tabs, [tabId]: makeDefaultTab() } }));
  },

  getTab: (tabId) => get().tabs[tabId] ?? makeDefaultTab(),

  destroyTab: (tabId) =>
    set((state) => {
      const rest = { ...state.tabs };
      delete rest[tabId];
      return { tabs: rest };
    }),

  reset: (tabId) => set((state) => ({ tabs: { ...state.tabs, [tabId]: makeDefaultTab() } })),

  // ── Đầu vào ──

  setSheet: (tabId, patch) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) =>
        touchInput({ ...tab, sheet: { ...tab.sheet, ...patch } }),
      ),
    })),

  setMargin: (tabId, patch) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) =>
        touchInput({ ...tab, sheet: { ...tab.sheet, marginMm: { ...tab.sheet.marginMm, ...patch } } }),
      ),
    })),

  setGapMm: (tabId, value) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) => touchInput({ ...tab, gapMm: value })),
    })),

  setProfile: (tabId, value) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) => touchInput({ ...tab, profile: value })),
    })),

  setSeed: (tabId, value) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) => touchInput({ ...tab, seed: value })),
    })),

  setTimeBudgetMs: (tabId, value) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) => touchInput({ ...tab, timeBudgetMs: value })),
    })),

  setDefaultRotation: (tabId, value) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) => touchInput({ ...tab, defaultRotation: value })),
    })),

  addPart: (tabId, part) => {
    const uiId = nextUiId();
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) =>
        touchInput({ ...tab, parts: [...tab.parts, { ...part, uiId }] }),
      ),
    }));
    return uiId;
  },

  updatePart: (tabId, uiId, patch) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) =>
        touchInput({
          ...tab,
          parts: tab.parts.map((part) => (part.uiId === uiId ? { ...part, ...patch } : part)),
        }),
      ),
    })),

  setPartRotation: (tabId, uiId, value) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) =>
        touchInput({
          ...tab,
          parts: tab.parts.map((part) =>
            part.uiId === uiId ? { ...part, rotationConstraint: value } : part,
          ),
        }),
      ),
    })),

  removePart: (tabId, uiId) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) =>
        touchInput({ ...tab, parts: tab.parts.filter((part) => part.uiId !== uiId) }),
      ),
    })),

  // ── Job ──

  beginRun: (tabId, jobId) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) => {
        const runToken = tab.runToken + 1;
        return {
          ...tab,
          runToken,
          error: '',
          issues: [],
          manifest: null,
          manifestRevision: null,
          activeSheetIndex: 0,
          job: {
            jobId,
            status: 'queued',
            terminal: false,
            cancelRequested: false,
            progress: null,
            errorCode: null,
            message: null,
            revision: tab.revision,
            runToken,
          },
        };
      }),
    })),

  applyJobStatus: (tabId, status) => {
    const tab = get().tabs[tabId];
    // Không có job, hoặc snapshot thuộc job khác ⇒ BỎ QUA. Đây là chốt chống "job cũ ghi
    // đè tab": người dùng bấm Chạy lần hai thì lượt polling của lần một vẫn còn bay.
    if (!tab?.job || tab.job.jobId !== status.jobId) return false;
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (current) => {
        if (!current.job || current.job.jobId !== status.jobId) return current;
        return {
          ...current,
          job: {
            ...current.job,
            status: status.status,
            terminal: status.terminal,
            cancelRequested: status.cancelRequested,
            progress: status.progress ?? current.job.progress,
            errorCode: status.errorCode ?? null,
            message: status.message ?? null,
          },
        };
      }),
    }));
    return true;
  },

  applyManifest: (tabId, raw) => {
    const tab = get().tabs[tabId];
    if (!tab?.job) return false;

    const result = validateManifest(raw, {
      expectedQuantities: Object.fromEntries(
        tab.parts.map((part) => [part.partId, part.quantity]),
      ),
    });
    if (!result.ok) {
      set((state) => ({
        tabs: patchTab(state.tabs, tabId, (current) => ({
          ...current,
          manifest: null,
          manifestRevision: null,
          issues: result.issues,
          error: 'Kết quả lồng ghép không đúng hợp đồng nên đã bị từ chối.',
        })),
      }));
      return false;
    }

    // Manifest của job khác, hoặc của một revision đầu vào đã cũ ⇒ bỏ qua.
    if (result.manifest.jobId !== tab.job.jobId) return false;
    if (tab.job.revision !== tab.revision) return false;

    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (current) => ({
        ...current,
        manifest: result.manifest,
        manifestRevision: current.revision,
        issues: [],
        error: '',
        activeSheetIndex: 0,
      })),
    }));
    return true;
  },

  markCancelRequested: (tabId) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) =>
        tab.job ? { ...tab, job: { ...tab.job, cancelRequested: true } } : tab,
      ),
    })),

  clearJob: (tabId) =>
    // Bỏ CẢ kết quả của lượt chạy, không chỉ bản ghi job. Nút "Bỏ kết quả" ở vỏ tool gọi
    // hàm này; nếu chỉ đặt `job: null` thì `hasUsableResult` vẫn đúng (nó chỉ soi
    // `manifest` + `manifestRevision`) nên preview, bảng tóm tắt và nút Xuất PDF vẫn nằm
    // đó sau khi người dùng đã bấm bỏ — và job thì đã bị xoá trên sidecar, tức màn hình
    // hiện một kết quả không còn xuất được nữa.
    //
    // Dữ liệu ĐẦU VÀO (khuôn, khổ tờ, tham số) vẫn giữ nguyên: bỏ kết quả để xếp lại là
    // việc thường ngày, bắt nhập lại khuôn thì vô lý.
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) => ({
        ...tab,
        job: null,
        manifest: null,
        manifestRevision: null,
        issues: [],
        error: '',
        activeSheetIndex: 0,
      })),
    })),

  setError: (tabId, message) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) => ({ ...tab, error: message })),
    })),

  setActiveSheetIndex: (tabId, index) =>
    set((state) => ({
      tabs: patchTab(state.tabs, tabId, (tab) => ({
        ...tab,
        activeSheetIndex: Math.max(0, Math.trunc(index)),
      })),
    })),
}));

// ─────────────────────────────────────────────────────────────────────────────
//  Bộ chọn thuần — dùng được trong test mà không cần React
// ─────────────────────────────────────────────────────────────────────────────

/** Tab có dữ liệu người dùng chưa lưu? Job đang chạy KHÔNG làm tab dirty. */
export function isTabDirty(tab: MixedNestingTabState): boolean {
  return tab.parts.length > 0;
}

/** Manifest còn dùng được cho preview/export? Sai revision là không. */
export function hasUsableResult(tab: MixedNestingTabState): boolean {
  return tab.manifest !== null && tab.manifestRevision === tab.revision;
}

export function isRunning(tab: MixedNestingTabState): boolean {
  return tab.job !== null && !tab.job.terminal;
}

/** Chạy được chưa: có chi tiết, tổng số con > 0, và không có job đang chạy. */
export function canRun(tab: MixedNestingTabState): boolean {
  if (isRunning(tab)) return false;
  if (tab.parts.length === 0) return false;
  return tab.parts.every((part) => part.quantity >= 1 && part.outer.length >= 3);
}

export function totalInstances(tab: MixedNestingTabState): number {
  return tab.parts.reduce((sum, part) => sum + part.quantity, 0);
}

/** Số tờ trong kết quả đang dùng được. `0` khi chưa có kết quả. */
export function sheetCount(tab: MixedNestingTabState): number {
  return hasUsableResult(tab) ? (tab.manifest as PlacementManifest).stats.sheetCount : 0;
}

/**
 * Dựng body `POST /jobs` từ state tab.
 *
 * Đi qua `buildCreateJobRequest` để dùng cùng một lớp lọc trường với mọi nơi khác —
 * `uiId` và `sourceLabel` không bao giờ lọt lên server.
 */
export function buildRequestFromTab(tab: MixedNestingTabState): CreateJobRequest {
  return buildCreateJobRequest({
    seed: tab.seed,
    profile: tab.profile,
    sheet: tab.sheet,
    gapMm: tab.gapMm,
    orientationPolicy: { defaultRotation: tab.defaultRotation, reflection: 'forbidden' },
    parts: tab.parts.map((part) => ({
      partId: part.partId,
      quantity: part.quantity,
      outer: part.outer,
      holes: part.holes,
      rotationConstraint: part.rotationConstraint,
    })),
    ...(tab.timeBudgetMs === null ? {} : { timeBudgetMs: tab.timeBudgetMs }),
  });
}
