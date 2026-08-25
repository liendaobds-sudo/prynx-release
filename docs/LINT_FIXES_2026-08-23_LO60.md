# Lô lint P2.56 — 2026-08-23

## Phạm vi

Loại 25 `any` khỏi 3 test file:

- `stripBytesIfOnDisk.test.ts`: dùng `RuntimeMetadataFile` cho metadata runtime,
  global Tauri/File path đã khai báo và `ArrayBuffer` cho fixture bytes.
- `OfficeConvertTool.test.tsx`: dùng `Window.__TAURI_INTERNALS__` đã có thay các
  cast global trong lifecycle Tauri.
- `useImposerSettingsStore.characterization.test.ts`: snapshot state bằng
  `Object.entries` + `Record<string, unknown>`, dùng type store thực cho report/
  resize và bỏ cast ở các partial state hợp lệ.

Không đổi production code, snapshot vàng hay semantics test.

## Verify

- ESLint hẹp 3 file: 0 lỗi.
- `npm run typecheck`: đạt.
- Vitest đúng 3 file: 39/39 đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: 1.123 → 1.098 errors; warnings giữ 103; gate đạt.

## Kết luận

Lô test-only hoàn tất. Chưa commit, push hoặc build release.
