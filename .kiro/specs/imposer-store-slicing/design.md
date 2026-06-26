# Design Document

## Overview

Tách `useImposerSettingsStore.ts` (monolith ~650 dòng) thành **các slice theo domain
ở file riêng**, dùng **Zustand "slices pattern"**: mỗi slice là một `StateCreator`
trả về phần state+actions của domain đó; store cuối ghép tất cả slice lại rồi bọc
`persist` + Context/Provider như cũ.

Nguyên tắc bất biến: **state vẫn PHẲNG** (hợp của các slice), **API hook giữ nguyên**
(`useImposerSettingsStore(selector)` + Provider), **persist/migration/partialize/
tool-profiles giữ nguyên hành vi**. Consumer KHÔNG phải sửa (trừ khả năng đổi đường
import nếu di chuyển file — sẽ tránh bằng cách giữ `useImposerSettingsStore.ts` làm
điểm export công khai).

## Architecture

```
imposition-tools/
  useImposerSettingsStore.ts        ← GIỮ public API: Context, Provider, hook,
                                       createImposerSettingsStore() (ghép slice + persist)
  store/
    types.ts                        ← ImposerSettingsState = giao của tất cả *SliceShape
    persist.ts                      ← name, version, migrate (verbatim), partialize (compose)
    profiles.ts                     ← ALGO_PROFILE_KEYS (compose) + switchToolProfile
    slices/
      paperSlice.ts                 ← formsize, sheet, margins, gap, classification, gripper
      marksSlice.ts                 ← markType, bleed, marksConfig, pontConfig, cutType...
      bookletSlice.ts               ← signatureMode, foliosize, creep, gutter, blankPlacement, scaleMode, interleave
      nupSlice.ts                   ← layout, columns/rows, cluster*, align, duplex, targets, fold? (fold rieng)
      foldSlice.ts                  ← foldPattern
      catalogSlice.ts               ← autoCatalog, catalog*, sourcePageDim(s), optimalData
      reportSlice.ts                ← reportDisplay, materials, lamination, exportUniqueSheets, saveByReport
      cncSlice.ts                   ← cncFlipEdge, cncDuplexMarks, savePrint
      uiSlice.ts                    ← showSettings, modals, flipbook, sheetViewer
      preprocSlice.ts               ← shuffle/resize/split settings
      workspaceSlice.ts             ← activeDashboardTool, batchOutput, confirmBookletSettings, taskMode
```

`createImposerSettingsStore()`:
```ts
createStore<ImposerSettingsState>()(
  persist(
    (set, get, store) => ({
      ...createPaperSlice(set, get, store),
      ...createMarksSlice(set, get, store),
      ...createBookletSlice(set, get, store),
      ...createNupSlice(set, get, store),
      ...createFoldSlice(set, get, store),
      ...createCatalogSlice(set, get, store),
      ...createReportSlice(set, get, store),
      ...createCncSlice(set, get, store),
      ...createUiSlice(set, get, store),
      ...createPreprocSlice(set, get, store),
      ...createWorkspaceSlice(set, get, store),
    }),
    PERSIST_CONFIG, // từ store/persist.ts
  )
);
```

## Components and Interfaces

### Slice creator
Mỗi slice file export:
```ts
// bookletSlice.ts
export interface BookletSlice {
  signatureMode: 'continuous'|'saddle'|'thread'|'cut_stacks'|'flush_mount';
  setSignatureMode: (v: BookletSlice['signatureMode']) => void;
  foliosize: number; setFoliosize: (v: number) => void;
  // ... blankPlacement, gutterMargin, separateCover, coverPageCount, scaleMode, interleave, paperThickness
}
export const createBookletSlice: StateCreator<ImposerSettingsState, [], [], BookletSlice> =
  (set) => ({ signatureMode: 'saddle', setSignatureMode: (v) => set({ signatureMode: v }), /* ... */ });

// Khai báo phần persist + profile của slice (compose ở nơi khác)
export const BOOKLET_PERSIST_KEYS = ['signatureMode','foliosize','paperThickness','scaleMode','interleave'] as const;
export const BOOKLET_PROFILE_KEYS = ['scaleMode','signatureMode','foliosize','interleave'] as const;
```

### persist.ts (compose, giữ nguyên hành vi)
```ts
export const PARTIALIZE_KEYS = [
  ...PAPER_PERSIST_KEYS, ...MARKS_PERSIST_KEYS, ...BOOKLET_PERSIST_KEYS, ...NUP_PERSIST_KEYS,
  ...FOLD_PERSIST_KEYS, ...CATALOG_PERSIST_KEYS, ...REPORT_PERSIST_KEYS, ...CNC_PERSIST_KEYS,
  ...WORKSPACE_PERSIST_KEYS,
] as const;
export const PERSIST_CONFIG = {
  name: 'ps_imposer_settings',
  version: 7,
  migrate, // GIỮ NGUYÊN verbatim từ store hiện tại (v1→v7)
  partialize: (state) => Object.fromEntries(PARTIALIZE_KEYS.map(k => [k, (state as any)[k]])),
};
```
> `PARTIALIZE_KEYS` phải BẰNG ĐÚNG tập key `partialize` hiện tại (test khẳng định).

### profiles.ts
```ts
export const ALGO_PROFILE_KEYS = [
  ...NUP_PROFILE_KEYS, ...BOOKLET_PROFILE_KEYS, ...MARKS_PROFILE_KEYS, ...CNC_PROFILE_KEYS, ...
]; // BẰNG ĐÚNG danh sách hiện tại
export const createWorkspaceSlice = ... // chứa switchToolProfile dùng ALGO_PROFILE_KEYS + toolProfiles
```

### Public API (giữ nguyên)
`useImposerSettingsStore.ts` vẫn export: `ImposerSettingsContext`, `ImposerSettingsProvider`,
`useImposerSettingsStore(selector)`, `createImposerSettingsStore`, và **re-export type**
`ImposerSettingsState`. Mọi import hiện có không đổi.

## Data Models

- `ImposerSettingsState = PaperSlice & MarksSlice & BookletSlice & NupSlice & FoldSlice &
  CatalogSlice & ReportSlice & CncSlice & UiSlice & PreprocSlice & WorkspaceSlice`.
- Không thêm/bớt field so với hiện tại; chỉ phân bổ vào các slice. Các field "dùng chung
  vật lý" (khổ, lề, gap, classification, gripper) → `PaperSlice`; marks/bleed/pont → `MarksSlice`.

## Correctness Properties

### Property 1: API & state phẳng không đổi
Sau refactor, `useImposerSettingsStore(selector)` + Provider giữ nguyên chữ ký; mọi
field/action cùng tên & cùng vị trí phẳng như trước.

**Validates: Requirements 2.1, 2.2, 2.3**

### Property 2: Tập partialize bất biến
`PARTIALIZE_KEYS` (ghép từ slice) BẰNG ĐÚNG tập key `partialize` của store hiện tại
(không thừa/thiếu).

**Validates: Requirements 3.1, 3.2, 5.3**

### Property 3: Migration bảo toàn
Hàm `migrate` v1→v7 giữ nguyên; nạp một persistedState v6 cho ra kết quả y hệt trước
refactor (đặc biệt nhánh v6→v7 gangCount).

**Validates: Requirements 3.3**

### Property 4: Tool profiles bất biến
`ALGO_PROFILE_KEYS` (ghép từ slice) BẰNG ĐÚNG danh sách hiện tại; `switchToolProfile`
lưu/khôi phục đúng các field như trước.

**Validates: Requirements 4.1, 4.2**

### Property 5: Default state bất biến
State khởi tạo (mọi default value) sau refactor trùng khớp snapshot trước refactor.

**Validates: Requirements 5.1, 6.1**

### Property 6: Khu trú thay đổi theo domain
Thêm field cho một domain chỉ chạm file slice của domain đó + (tùy chọn) danh sách
persist/profile của chính slice đó.

**Validates: Requirements 1.1, 1.2, 3.4**

## Error Handling

- Nếu một field bị bỏ sót khi phân bổ slice → TypeScript báo thiếu key trong intersection
  (compile-time) → bắt được ngay.
- Test characterization so default state + partialize keys + ALGO_PROFILE_KEYS với
  snapshot "vàng" chụp TRƯỚC refactor → lệch là đỏ.
- `loadFromLocalStorage('ps_custom_marks_config', ...)` (side-effect khởi tạo marksConfig)
  giữ trong `marksSlice` để hành vi không đổi.

## Testing Strategy

1. **Trước refactor — chụp snapshot vàng** (characterization test):
   - default state đầy đủ (mọi field) của store mới tạo.
   - tập key `partialize` (sort).
   - `ALGO_PROFILE_KEYS` (sort).
   - `migrate` cho mẫu persistedState v6 → so kết quả.
   - `switchToolProfile('nup','booklet')` rồi quay lại → state đúng kỳ vọng.
2. **Sau refactor** — chạy lại đúng test đó, phải khớp 100%.
3. `npm run typecheck` sạch; toàn bộ vitest hiện có xanh.
4. Smoke: render một component dùng store (vd BookletSettingsSection) không lỗi.

## Migration / Rollout (thứ tự thực thi)
1. Thêm characterization test trên store hiện tại (xanh) — chốt "hành vi vàng".
2. Tạo `store/slices/*` + `store/types.ts` + `store/persist.ts` + `store/profiles.ts`
   bằng cách DI CHUYỂN nguyên văn từng cụm (không sửa logic).
3. Viết lại `useImposerSettingsStore.ts` thành bản ghép slice; giữ mọi export công khai.
4. Chạy characterization + typecheck + vitest → phải khớp/xanh.
5. Commit refactor riêng (không kèm tính năng). Nếu phát hiện dead code → commit dọn riêng.
