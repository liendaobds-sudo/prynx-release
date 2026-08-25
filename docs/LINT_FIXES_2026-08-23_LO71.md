# Lô lint P2.67 — 2026-08-23

## Phạm vi

Loại 4 lỗi `no-explicit-any` trong đúng 2 UI shell/Home:

- `SettingsModal.tsx`: bỏ cast thừa của `ToolCategoryId`; khai báo danh sách đơn
  vị bằng tuple `as const` để setter nhận đúng union `mm | cm | inch`.
- `RecentFiles/ThumbnailView.tsx`: định kiểu cờ runtime Tauri và props constructor
  của error boundary.

Không đổi registry công cụ, giá trị đơn vị, luồng tải thumbnail, URL tile, cache,
điều kiện active hoặc fallback khi file/ảnh lỗi. Diff bỏ import `relaunch` có sẵn
từ lô trước trong `SettingsModal` được giữ nguyên.

## Verify

- ESLint hẹp 2 file: đạt, 0 lỗi / 0 cảnh báo.
- `npm run typecheck`: đạt.
- Regression Settings + Recent Files: 2 file, 3/3 test đạt.
- Verify tổng hợp LO70–LO71: 3 file, 4/4 test đạt.
- `git diff --check`: đạt; chỉ có cảnh báo line-ending cũ.
- `npm run lint:budget`: **772 → 768 errors**, warnings giữ ở **103**; budget
  gate đạt.

## Rủi ro còn lại

- `ThumbnailView` chưa có component test trực tiếp cho protocol tile; lô này chỉ
  thay kiểu, không đổi biểu thức truthiness hoặc effect.
- Chưa chạy GUI Tauri để kiểm thumbnail file gần đây bằng file thật.

## Kết luận

Lô type-safety UI hoàn tất ở mức kiểm thử tự động, chưa commit, push hoặc build
release.
