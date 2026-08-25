# Lô lint P2.7 — 2026-08-23

## Phạm vi

Dọn symbol dead code đã xác minh trong 5 file dieline:

- `desktop/src/lib/dieline/exportGate.test.ts` — bỏ tham số parser stub không dùng
- `desktop/src/lib/dieline/signature.smoke.test.ts` — bỏ tham số parser stub không dùng
- `desktop/src/lib/dieline/validateParams.test.ts` — bỏ trường `wasClamped` không đọc
- `desktop/src/lib/dieline/GableBox.ts` — bỏ import `arc` và destructure `HH` không dùng
- `desktop/src/lib/dieline/Envelope.ts` — bỏ helper `buildSealFlapH` không có consumer

Không thay đổi generator geometry; không cập nhật golden master.

## Verify

- ESLint hẹp: các finding `no-unused-vars` của lô đã hết; còn 6 `no-explicit-any`
  baseline.
- Dieline: 29 file, 582 test đạt, 2 skip.
- `npm run build:dieline-sidecar`: đạt.
- `npm run check:dieline-webview`: đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: errors `1.406 → 1.398`, warnings `108 → 108`;
  budget gate đạt.

## Kết luận

Chỉ loại symbol không có consumer live; chưa build release, commit hoặc push.
