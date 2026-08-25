# Lô lint P2.47 — 2026-08-23

## Phạm vi

Thu hẹp năm `no-explicit-any` ở các hợp đồng UI/runtime đã có kiểu rõ:

- Dùng `ViewerContextMenuState` xuyên `ViewerContextMenu`, `ThumbSidebar` và
  `useViewerHotkeys`.
- Dùng khai báo global `window.__TAURI_INTERNALS__` đã có trong `tauri-globals.d.ts`
  tại danh sách file gần đây.
- Định kiểu metadata `__editCommit` cục bộ cho `File` trong history chỉnh sửa đối tượng.

Không đổi giá trị state, điều kiện Tauri hoặc cách gắn metadata runtime.

## Verify

- ESLint hẹp: 5 finding mục tiêu còn 0.
- Hotkey + context menu + thumbnail + recent files: 4 file test, 24/24 đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt; chỉ có cảnh báo autocrlf.
- `npm run lint:budget`: 1.191 → 1.186 errors; warnings giữ 103.

## Kết luận

Lô chỉ thay `any` bằng hợp đồng tĩnh tương ứng; hành vi runtime giữ nguyên.
