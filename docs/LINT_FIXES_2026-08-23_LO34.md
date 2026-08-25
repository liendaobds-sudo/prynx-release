# Lô lint P2.30 — 2026-08-23

## Phạm vi

Dọn 10 binding `no-unused-vars` trong 3 file UI bình bản/viewer:

- `desktop/src/components/imposition-tools/sections/PreprocessingRouter.tsx` — bỏ 2 import không dùng và binding callback merge không được đọc; public prop vẫn giữ nguyên.
- `desktop/src/hooks/viewer/useViewerHotkeys.ts` — bỏ 6 prop khỏi destructuring nội bộ; interface/call sites vẫn giữ nguyên.
- `desktop/src/components/imposition-tools/sections/GridPreview.tsx` — bỏ binding lỗi JSON không được đọc.

Không đổi tuyến merge đang do `ImposerDashboard` sở hữu, hotkey hoặc cache/layout preview.

## Verify

- ESLint rule mục tiêu: giảm đúng 10 lỗi; chỉ còn `_pageIdxDep` lịch sử trong `GridPreview`.
- Test hotkey + trapezoid/mixed-duplex preview: 3 file, 29/29 đạt.
- `npm run typecheck`: đạt.
- `npm run lint:budget`: 1.294 → 1.284 errors; warnings giữ 103.

## Kết luận

Chỉ bỏ import/binding không được đọc; public contract và hành vi runtime được giữ nguyên.
