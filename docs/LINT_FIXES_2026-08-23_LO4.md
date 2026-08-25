# Lô lint P1.4 — 2026-08-23

## Phạm vi

Tách policy render thuần khỏi `LivePageFrame` để React Refresh không coi file
viewer là module export hỗn hợp:

- `desktop/src/components/workspace/LivePageFrame.tsx`
- `desktop/src/components/workspace/livePageFramePolicy.ts`
- `desktop/src/components/workspace/LivePageFrame.renderPolicy.test.ts`
- `desktop/src/components/workspace/LivePageFrame.liveTile.test.tsx`

Đã chuyển 24 export policy (hàm quyết định pipeline tile/PPE và hai hằng số
render) sang module riêng. Hai export cache vẫn giữ tại `LivePageFrame` để bảo
toàn API đang dùng bởi `AcrobatViewer` và `ImpositionTab`.

## Verify

- Regression viewer: 2 file, 45/45 test đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- Số đo lint: errors `1.462 → 1.438`, warnings `108 → 108`.
- `react-refresh/only-export-components`: `54 → 30` (dưới budget 32).
- `eslint/unused-disable`: `9` (không tăng).
- `npm run lint:budget`: đạt.

## Kết luận

Thay đổi chỉ chuyển module và cập nhật import test; không đổi logic render,
cache hay API của các tab hiện tại. Chưa build release, commit hoặc push.
