# Lô lint P2.35 — 2026-08-23

## Phạm vi

Thu hẹp 16 `no-explicit-any` trong 3 file có test trực tiếp:

- `desktop/src/lib/utils.ts` — type cục bộ cho Blob có native path và metadata File runtime.
- `desktop/src/hooks/viewer/usePhysicalDisplayScale.ts` — dùng global Tauri declaration hiện có.
- `desktop/src/lib/preprocessEngine/PdfMerger.ts` — dùng `PDFPage[]` cho trang đã copy.

Không đổi global declaration, feature detection, byte-range hoặc thuật toán merge.

## Verify

- ESLint hẹp: 16 → 0 lỗi `no-explicit-any`.
- Vitest trực tiếp: 4 file, 44/44 đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: số tổng sau LO39–41 là 1.234 errors / 103 warnings; riêng LO39 giảm 16 lỗi.

## Kết luận

Type được thu hẹp tại runtime boundary; dữ liệu PDF và hành vi filesystem không đổi.
