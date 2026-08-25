# Lô lint P2.68 — 2026-08-23

## Phạm vi

Loại 4 lỗi `no-explicit-any` trong đúng 2 UI output:

- `SoftProofPanel.tsx`: catch dùng `unknown`, giữ message của Error/object và
  fallback i18n; không đổi latest-generation/AbortController guard.
- `ExportImageModal.tsx`: đọc message/name từ lỗi `unknown`, giữ phân biệt
  `AbortError` và lỗi xuất thật.

Không đổi request soft-proof, profile/intent, payload export, dải trang, job
batch, đường dẫn output, hành vi hủy hoặc thông báo thành công. Diff tách
`exportImagePlan` có sẵn từ lô trước được giữ nguyên.

Hai modal Save có `ts-nocheck` đã được loại khỏi lô vì cần một lô contract/test
riêng; không gỡ suppression khi chưa chứng minh được toàn bộ type lỗi ẩn.

## Verify

- ESLint hẹp 2 file: đạt, 0 lỗi / 0 cảnh báo.
- `npm run typecheck`: đạt.
- Regression Output Preview + Export Image: 2 file, 10/10 test đạt.
- `git diff --check`: đạt; chỉ có cảnh báo line-ending cũ.
- `npm run lint:budget`: **768 → 764 errors**, warnings giữ ở **103**; budget
  gate đạt.

## Rủi ro còn lại

- Test Export Image hiện phủ planner/tab, chưa mô phỏng trực tiếp dialog lỗi và
  `AbortError`; logic phân nhánh runtime được giữ nguyên.
- Chưa chạy Soft-Proof và xuất ảnh bằng sidecar/Tauri thật.

## Kết luận

Lô type-safety output UI hoàn tất ở mức kiểm thử tự động, chưa commit, push hoặc
build release.
