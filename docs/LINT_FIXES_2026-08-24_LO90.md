# Lô LO90 — Helper thư viện giấy (2026-08-24)

## Phạm vi

- `desktop/src/components/paper-library/tables.tsx`
- `desktop/src/components/paper-library/tableUtils.ts`
- `desktop/src/components/paper-library/PaperLibraryTool.tsx`

## Thay đổi

Tách các export thuần (`fmt`, `fmtFull`, `FAMILY_ORDER`, `FAMILY_COUNTS`) khỏi
file JSX bảng giấy sang `tableUtils.ts`. `tables.tsx` chỉ còn export component,
giảm cảnh báo React Fast Refresh mà không đổi dữ liệu giấy, thứ tự họ, cách lọc,
cách định dạng hay giao diện bảng. `PaperLibraryTool` cập nhật import sang helper.

## Verify

- ESLint phạm vi 3 file: đạt.
- `npm run typecheck`: đạt.
- `npx vitest run src/components/paper-library/PaperLibraryTool.test.tsx`:
  36/36 passed.

Không thay đổi dữ liệu vật tư hoặc contract backend; chưa commit/push/build release.
