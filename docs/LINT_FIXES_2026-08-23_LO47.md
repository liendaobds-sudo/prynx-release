# Lô lint P2.43 — 2026-08-23

## Phạm vi

Xử lý 3 finding trong vùng nesting/export dieline:

- `desktop/src/components/dieline-tool/NestingCanvas.tsx`: fit toàn bộ cụm hai tờ khi `trayNestingMode=split`, dùng tổng chiều rộng + khe 30mm và chiều cao lớn nhất.
- `desktop/src/components/dieline-tool/__tests__/NestingCanvas.interaction.test.tsx`: regression khóa hai mép cụm nằm trong vùng padding.
- `desktop/src/lib/dieline/exportPDF.ts`: xóa hằng `clearance` không có consumer.

`exportGate.test.ts` chỉ có thay đổi `parseFromString()` từ trạng thái dirty có trước,
không thuộc logic lô này.

## Verify

- Test focused nesting/export: 15/15 đạt.
- Toàn bộ `src/lib/dieline`: 29 file, 582 đạt, 2 skipped.
- `npm run typecheck`: đạt.
- `npm run build:dieline-sidecar`: đạt.
- `npm run check:dieline-webview`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: 1.200 → 1.197 errors; warnings giữ 103.
- ESLint file `NestingCanvas`: chỉ còn 1 lỗi `react-hooks/set-state-in-effect` lịch sử ở effect auto-fit; `no-unused-vars` sạch.

## Kết luận

Fit split đã được kiểm bằng số đo hai mép; không mở rộng annotation PDF chưa có contract.
