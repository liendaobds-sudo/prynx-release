# Lô lint P2.31 — 2026-08-23

## Phạm vi

Thu hẹp 7 `no-explicit-any` tại các boundary đã có test trong 5 file:

- `desktop/src/lib/createBlankPdf.ts`
- `desktop/src/hooks/useWorkingPdf.ts`
- `desktop/src/lib/savePrintFiles.ts`
- `desktop/src/lib/recipe/recipeOps.ts`
- `desktop/src/lib/recipe/PlaybackRunner.ts`

Giữ nguyên public contract: byte PDF dùng bản sao `Uint8Array` hợp lệ `BlobPart`,
rotation dùng type store hiện có, filesystem dùng interface tối thiểu, recipe có
shape nội bộ và lỗi `unknown` vẫn nhận đúng `ABORT_BY_USER`/`AbortError`.

## Verify

- ESLint hẹp: 7 → 0 lỗi `no-explicit-any`.
- Vitest tập trung: 5 file, 36/36 đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt; chỉ có cảnh báo autocrlf.
- `npm run lint:budget`: số tổng sau LO35–36 là 1.273 errors / 103 warnings; riêng LO35 giảm 7 lỗi.

## Kết luận

Type được thu hẹp tại boundary, không đổi payload, PDF output hoặc semantics hủy recipe.
