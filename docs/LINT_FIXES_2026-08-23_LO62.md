# Lô lint P2.58 — 2026-08-23

## Phạm vi

Loại 40 lỗi `no-explicit-any` khỏi 5 file sạch:

- `__test_hex_parity.ts`: thêm contract nội bộ cho item/layout JSX và cell/block
  TypeScript; giữ nguyên toàn bộ công thức, đơn vị và thứ tự chọn chiến lược.
- `PageResizer.ts`: dùng API public có kiểu của `pdf-lib` cho MediaBox, CropBox,
  TrimBox, BleedBox và ArtBox.
- `pdfWarmup.ts`: dùng global type hiện có cho Tauri, đường dẫn file và idle
  callback của DOM.
- `HomeTab.tsx`: dùng `ToolCategoryId` và alias callback theo payload registry.
- `LayerPanel.tsx`: định kiểu object OCG theo response backend, guard đường dẫn
  native và phân loại AbortError từ `unknown`.

Không đổi backend, UI/UX, lifecycle, request payload, engine hình học, giới hạn
hiệu năng hay đơn vị nghiệp vụ.

## Verify

- ESLint hẹp 5 file: 0 lỗi.
- `npm run typecheck`: đạt.
- Script parity hex: 8/8 ca đạt; count các strategy khớp và sai lệch tọa độ đầu
  bằng `0.000000`.
- Vitest regression PDF/UI gộp: 7 file, 88/88 test đạt.
- Hai nhánh verify bổ sung: PDF 57/57 test; UI 57/57 test.
- `git diff --check`: đạt; chỉ có cảnh báo chuẩn hóa LF/CRLF ở file cũ.
- `npm run lint:budget`: 1.021 → 981 errors; warnings giữ 103; gate đạt.

## Kết luận

Lô type-only/guard-only hoàn tất ở mức kiểm thử tự động. Chưa chạy runtime GUI,
chưa commit, push hoặc build release.
