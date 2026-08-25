# Lô lint P2.55 — 2026-08-23

## Phạm vi

Loại 16 `any` khỏi 5 test boundary mà không đổi code runtime:

- `UnrecordedCommitBlock.integration.test.tsx`: suy ra callback commit từ props
  production của `EncryptTool`.
- `recipeTypes.test.ts`: guard tham số recipe `unknown` thành `string[]`; dữ liệu
  schema sai được truyền thẳng vào type guard nhận `unknown`.
- `api.upload.test.ts`: dùng khai báo global Tauri đã có trong
  `types/tauri-globals.d.ts`.
- `preprocessEngine.test.ts`: đọc TrimBox/BleedBox qua API công khai của pdf-lib và
  tạo fixture `MergeSettings` đầy đủ từ chữ ký `mergePdf`.
- `processHandlers.test.ts`: fixture page-sheet/CNC/die-cut dùng
  `GuillotineSettings`, `DieCutSettings`, `PontConfig`; metadata native path dùng
  `PdfPathMetadata`. Các field runtime ngoài schema được khai bằng intersection hẹp,
  không dùng cast kép `unknown as`.

Các assertion và nhánh nghiệp vụ của test được giữ nguyên.

## Verify

- ESLint hẹp trên 5 file: 0 lỗi.
- `npm run typecheck`: đạt.
- Vitest đúng 5 file: 87/87 đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: 1.139 → 1.123 errors; warnings giữ 103; gate đạt.

## Kết luận

Lô test-only hoàn tất. Việc định kiểu fixture `processHandlers` cũng làm lộ contract
runtime còn rộng hơn `SettingsTypes`; chưa sửa production trong lô này. Chưa commit,
push hoặc build.
