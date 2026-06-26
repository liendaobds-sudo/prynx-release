# Implementation Plan

## Overview

Refactor thuần: tách store monolith thành slice theo domain, KHÔNG đổi hành vi.
Thực hiện test-first — chốt "snapshot vàng" trước, di chuyển nguyên văn, rồi verify khớp 100%.

## Task Dependency Graph

```
1 → 3.* → 2.* → 4 → 5 → 6
```

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"], "parallel": false },
    { "wave": 2, "tasks": ["3.1","3.2","3.3","3.4","3.5","3.6","3.7","3.8","3.9","3.10","3.11"], "parallel": true },
    { "wave": 3, "tasks": ["2.1","2.2","2.3"], "parallel": false },
    { "wave": 4, "tasks": ["4"], "parallel": false },
    { "wave": 5, "tasks": ["5"], "parallel": false },
    { "wave": 6, "tasks": ["6"], "parallel": false }
  ]
}
```

## Tasks

- [x] 1. Chụp "snapshot vàng" hành vi store hiện tại (test-first, trước khi refactor)
  - Viết `useImposerSettingsStore.characterization.test.ts`: tạo store mới và khẳng định
    (a) toàn bộ default state (mọi field + giá trị), (b) tập key `partialize` (đã sort),
    (c) `ALGO_PROFILE_KEYS` (đã sort), (d) `switchToolProfile('nup','booklet')` rồi quay lại
    cho state đúng kỳ vọng.
  - Thêm test migration: nạp mẫu `persistedState` version 6 (có/không `reportDisplay`) →
    khẳng định nhánh v6→v7 thêm `gangCount`/`showGangCount` đúng.
  - Chạy test → phải XANH (chốt hành vi tham chiếu trước refactor).
  - _Requirements: 5.1, 5.3, 3.3, 4.1_

- [x] 2. Dựng khung thư mục `store/` (chưa đổi store chính)
  - [x] 2.1 Tạo `store/types.ts`: khai báo `ImposerSettingsState` = giao của các `*Slice` shape
    (import shape từ các slice ở task 3). Tạm export type tổng để các slice tham chiếu.
    - _Requirements: 2.2, 1.3_
  - [x] 2.2 Tạo `store/persist.ts`: `PARTIALIZE_KEYS` (ghép từ `*_PERSIST_KEYS` của slice),
    `PERSIST_CONFIG` (name `ps_imposer_settings`, version 7, `migrate` COPY verbatim từ store
    hiện tại, `partialize` từ `PARTIALIZE_KEYS`).
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [x] 2.3 Tạo `store/profiles.ts`: `ALGO_PROFILE_KEYS` (ghép từ `*_PROFILE_KEYS`) + hằng
    `PROFILED_TOOLS`.
    - _Requirements: 4.1, 4.2_

- [x] 3. Tạo các slice (DI CHUYỂN nguyên văn từ store, không sửa logic/default)
  - [x] 3.1 `slices/paperSlice.ts` (formsize, customSheet W/H, gapX/Y, spreadDistribution,
    marginMode, margin T/B/L/R, paperClassification, gripperMargin) + `PAPER_PERSIST_KEYS`.
    - _Requirements: 1.1, 1.3, 6.1_
  - [x] 3.2 `slices/marksSlice.ts` (markType, cutType, fillBlockGap, pontType, bleed,
    showBleedView, spawnNewTab, marksConfig + `loadFromLocalStorage`, pontConfig,
    separateCutPage, pontsOnCutFile) + persist/profile keys.
    - _Requirements: 1.1, 6.1_
  - [x] 3.3 `slices/bookletSlice.ts` (signatureMode, foliosize, paperThickness, gutterMargin,
    separateCover, coverPageCount, blankPlacement, scaleMode, interleave) + persist/profile keys.
    - _Requirements: 1.1, 1.2, 6.1_
  - [x] 3.4 `slices/nupSlice.ts` (layoutType, columns, rows, gridStrategy, groupingStrategy,
    cluster*, tileGap*, clusterNesting, showGapSettings, duplexFlow, align, targetQuantity(ies),
    previewCapacity(ies), mixedPlacedByPage, fetchEpoch) + persist/profile keys.
    - _Requirements: 1.1, 6.1_
  - [x] 3.5 `slices/foldSlice.ts` (foldPattern) + persist keys.
    - _Requirements: 1.1, 6.1_
  - [x] 3.6 `slices/catalogSlice.ts` (autoCatalog, catalogHasCover, catalogMasterSigOverride,
    catalogRemainderPlacement, sourcePageDim(s), optimalData, catalogPreview, catalogJobsState)
    + persist keys.
    - _Requirements: 1.1, 6.1_
  - [x] 3.7 `slices/reportSlice.ts` (exportUniqueSheets, reportDisplay, customMaterials,
    reportMaterial, reportLamination(Sides), reportOrderCode, saveByReport) + persist keys.
    - _Requirements: 1.1, 1.2, 6.1_
  - [x] 3.8 `slices/cncSlice.ts` (cncFlipEdge, cncDuplexMarks, savePrint) + persist/profile keys.
    - _Requirements: 1.1, 6.1_
  - [x] 3.9 `slices/uiSlice.ts` (showSettings, showMarksModal, showPontModal, isPresetOpen,
    showFlipbook, showSheetViewer).
    - _Requirements: 1.1, 6.1_
  - [x] 3.10 `slices/preprocSlice.ts` (shuffleSettings, resizeSettings, splitSettings).
    - _Requirements: 1.1, 6.1_
  - [x] 3.11 `slices/workspaceSlice.ts` (taskMode, activeDashboardTool, batchOutput,
    confirmBookletSettings, toolProfiles, switchToolProfile) — dùng `ALGO_PROFILE_KEYS` từ profiles.ts.
    - _Requirements: 1.1, 4.1, 4.2_

- [x] 4. Ghép lại `useImposerSettingsStore.ts` (giữ nguyên public API)
  - Viết lại `createImposerSettingsStore()` thành bản spread tất cả `create*Slice` + bọc
    `persist(..., PERSIST_CONFIG)`.
  - GIỮ NGUYÊN export: `ImposerSettingsContext`, `ImposerSettingsProvider`,
    `useImposerSettingsStore(selector)`, `createImposerSettingsStore`, và re-export type
    `ImposerSettingsState`.
  - _Requirements: 2.1, 2.2, 2.4_

- [x] 5. Xác minh không hồi quy
  - Chạy lại characterization test (task 1) → khớp 100%.
  - `npm run typecheck` sạch (bắt sót field qua intersection type).
  - Chạy vitest imposerEngine + store → xanh.
  - Smoke: import store ở 1 component (BookletSettingsSection) không lỗi runtime/typecheck.
  - _Requirements: 2.3, 5.2, 5.3_

- [x] 6. Commit refactor riêng + ghi nhận dead code (nếu có)
  - Commit chỉ các file store slicing (không kèm tính năng khác).
  - Nếu phát hiện code chết trong store khi di chuyển → ghi chú, commit dọn RIÊNG (không lẫn).
  - _Requirements: 6.1, 6.2, 6.3_

## Notes

- **Bất biến số 1:** state phẳng + API hook + persist key + migrate + ALGO_PROFILE_KEYS
  KHÔNG đổi. Mọi sai khác phải do lỗi di chuyển, bị golden test bắt.
- Di chuyển "nguyên văn" — copy đúng default values, không tranh thủ sửa/đổi tên.
- `marksConfig` có side-effect `loadFromLocalStorage` lúc khởi tạo → giữ trong `marksSlice`.
- Nền đã sạch (report-tem đã commit `04b968e`), nên diff refactor sẽ không lẫn tính năng.
- Typing: dùng `StateCreator<ImposerSettingsState, [], [], XSlice>` cho mỗi slice để
  intersection bắt sót field lúc compile.

