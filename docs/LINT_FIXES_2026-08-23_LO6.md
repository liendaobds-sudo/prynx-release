# Lô lint P2.2 — 2026-08-23

## Phạm vi

Vệ sinh một finding `prefer-const` và một biến dead code đã được ESLint xác
nhận trong helper khuôn bế:

- `desktop/src/lib/dieline/autoBottomHelpers.ts`

Thay `xEarR` thành `const` (không bị gán lại) và loại bỏ phép tính `sorted` không
có consumer. Không thay đổi hình học hay dữ liệu đầu ra.

## Verify

- ESLint file: đạt, không còn finding.
- Khuôn bế: `npx vitest run src/lib/dieline` — 29 file, 582 test đạt, 2 skip.
- `npm run build:dieline-sidecar`: đạt.
- `npm run check:dieline-webview`: đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: errors `1.430 → 1.428`, warnings `108 → 108`;
  budget gate đạt.

## Kết luận

Đây là thay đổi cơ học trong helper, không cập nhật golden master vì không đổi
hình học. Chưa build release, commit hoặc push.
