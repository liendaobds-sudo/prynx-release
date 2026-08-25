# Lô lint P2.26 — 2026-08-23

## Phạm vi

Dọn import và biến chết trong 5 generator khuôn bế:

- `desktop/src/lib/dieline/MatchboxTray.ts`
- `desktop/src/lib/dieline/PizzaBox.ts`
- `desktop/src/lib/dieline/ReverseTuckEnd.ts`
- `desktop/src/lib/dieline/SnapLockBottom.ts`
- `desktop/src/lib/dieline/MatchboxSleeve.ts`

Chỉ xóa symbol không có consumer. Không đổi `allPaths`, `panels`, bounding box,
tọa độ, công thức hoặc snapshot hình học.

## Verify

- ESLint hẹp: 12 lỗi `no-unused-vars` → 0.
- Toàn bộ test dieline: 29 file đạt, 582 test đạt, 2 skipped.
- `npm run typecheck`: đạt.
- `npm run build:dieline-sidecar`: đạt.
- `npm run check:dieline-webview`: đạt.
- `git diff --check`: đạt.
- Không cập nhật golden master.

## Kết luận

Lô không thay đổi kết quả khuôn bế; sidecar đã được bundle và kiểm hợp đồng
WebView trên trạng thái working tree hiện tại.
