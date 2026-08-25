# Lô LO87 — Pont settings dialog (2026-08-24)

## Phạm vi

Xử lý ba finding ESLint trong dialog cấu hình ốc định vị, không thay đổi payload
hay logic dựng dấu:

- `desktop/src/components/imposition-tools/PontSettingsDialog.tsx`
- `desktop/src/components/imposition-tools/pontConfigDefaults.ts`
- `desktop/src/components/imposition-tools/PontSettingsDialog.validation.test.ts`
- `desktop/src/components/imposition-tools/store/persist.ts`
- `desktop/src/components/imposition-tools/store/slices/marksSlice.ts`

## Thay đổi

- Tách `DEFAULT_PONT_CONFIG` khỏi file component để Fast Refresh không coi hằng số
  dùng chung là export của component.
- Bỏ `@ts-nocheck`, thu hẹp kiểu `updateLocal` và kiểm tra giá trị `shape` từ
  select.
- Đổi nội dung dialog thành component con được mount theo phiên mở. State cấu hình
  và preset khởi tạo bằng lazy initializer; việc đóng/mở vẫn reset về `config` mới
  mà không gọi `setState` đồng bộ trong effect.
- Đọc preset localStorage theo `unknown`, bỏ qua bản ghi hỏng thay vì làm dialog
  crash; hành vi lưu/nạp preset hợp lệ giữ nguyên.
- Cập nhật các consumer (`persist`, `marksSlice`, test validation) sang module
  defaults thuần.

## Verify

- ESLint phạm vi 5 file: đạt, không còn finding.
- `npm run typecheck`: đạt.
- `npx vitest run src/components/imposition-tools/PontSettingsDialog.validation.test.ts`:
  1 file, 12 test passed.

## Rủi ro còn lại

Chưa chạy full vitest và thao tác dialog trên app desktop trong lô này. Không commit,
push hoặc build release.
