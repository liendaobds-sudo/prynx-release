# Lô lint P2.71 — 2026-08-23

## Phạm vi

Loại 8 lỗi `no-explicit-any` trong 2 màn QC/so sánh:

- `DualPDFViewerInner.tsx`: dùng `VirtuosoHandle`, timer type chuẩn, props error
  boundary cụ thể và native `Event` cho listener cuộn.
- Target/currentTarget chỉ được đọc scroll metrics sau khi xác nhận là
  `HTMLElement`; listener thực tế vẫn gắn đúng lên scroller HTMLElement.
- `AiQcTab.tsx`: hai catch API/OCR dùng `unknown`, giữ message của Error/object.

Không đổi tỷ lệ đồng bộ scroll, thời gian khóa 800 ms, page index, spotlight
overlay, request QC/OCR hoặc payload API.

## Verify

- ESLint hẹp 2 file: đạt, 0 lỗi / 0 cảnh báo.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: **755 → 747 errors**, warnings giữ ở **103**; budget
  gate đạt.

## Rủi ro còn lại

- Chưa có component regression trực tiếp cho Dual PDF Viewer hoặc AI QC; lô này
  đạt bằng static/type evidence, chưa xác minh runtime mức 3.
- Chưa thao tác cuộn đồng bộ hai PDF và gọi AI/OCR trên GUI thật.

## Kết luận

Lô type-safety QC/compare hoàn tất ở mức kiểm tra tĩnh, chưa commit, push hoặc
build release.
