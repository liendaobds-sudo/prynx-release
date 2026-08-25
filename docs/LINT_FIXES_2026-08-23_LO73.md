# Lô lint P2.69 — 2026-08-23

## Phạm vi

Loại 5 lỗi `no-explicit-any` còn lại trong `useViewerHotkeys.ts`:

- Guide/history dùng contract `Guide` của `GuideLayer`.
- Ref danh sách dùng `VirtuosoHandle` chính thức của `react-virtuoso`.
- Giữ type `ViewerContextMenuState` đã được bổ sung từ diff trước.

Không đổi listener, shortcut, thứ tự ưu tiên undo/redo, guard tab active/dialog,
logic bộ gõ tiếng Việt, crop, dimension hoặc điều hướng trang. Các phần dọn biến
destructure/`prefer-const` có sẵn từ lô trước được giữ nguyên.

## Verify

- ESLint hẹp 1 file: đạt, 0 lỗi / 0 cảnh báo.
- `npm run typecheck`: đạt.
- Regression hotkey Viewer + modal contract: 2 file, 17/17 test đạt.
- `git diff --check`: đạt; chỉ có cảnh báo line-ending cũ.
- `npm run lint:budget`: **764 → 759 errors**, warnings giữ ở **103**; budget
  gate đạt.

## Rủi ro còn lại

- Caller `AcrobatViewer` vẫn có một số ref `any` riêng; lô này chỉ siết contract
  đầu vào của hook, chưa refactor Viewer lớn.
- Chưa kiểm phím tắt bằng bộ gõ UniKey/VietKey trên GUI thật trong lô type-only.

## Kết luận

Lô type-safety Viewer hook hoàn tất ở mức kiểm thử tự động, chưa commit, push
hoặc build release.
