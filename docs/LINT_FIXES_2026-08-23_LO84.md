# Lint fixes 2026-08-23 — Lô 84

## Phạm vi

- `desktop/src/lib/dieline/exportPDF.ts`
- Mục tiêu: loại hai lỗi `@typescript-eslint/no-explicit-any` ở điểm gọi svg2pdf, không đổi hình học khuôn, cổng contour hoặc chữ ký API xuất.

## Thay đổi

- Dùng module augmentation chính thức của `svg2pdf.js` để gọi `doc.svg(...)` trực tiếp thay cho hai ép kiểu `doc as any`.
- Giữ nguyên tham số SVG, kích thước trang, thứ tự validate/confirm contour và cả hai đường xuất (`downloadPDF`, `buildDielinePdfBlob`).
- Một thay đổi xóa biến `clearance` trong cùng file đã có sẵn trong working tree trước lô này; lô LO84 không tạo hoặc hoàn tác thay đổi đó.

## Kết quả

- Giảm 2 lỗi lint: `673 -> 671`.
- Cảnh báo toàn kho giữ nguyên: `103`.

## Xác nhận

- `npx eslint src/lib/dieline/exportPDF.ts`: đạt.
- `npm run typecheck`: đạt.
- `npx vitest run src/lib/dieline/exportGate.test.ts src/lib/dieline/signature.smoke.test.ts`: 23/23 test đạt.
- `npx vitest run src/lib/dieline`: 582 test đạt, 2 skip.
- `npm run build:dieline-sidecar`: đạt.
- `npm run check:dieline-webview`: đạt.
- `git diff --check -- desktop/src/lib/dieline/exportPDF.ts`: đạt.
- `npm run lint:budget`: đạt (`671 errors`, `103 warnings`).

## Bất biến đã giữ

- Không sửa generator, CUT/CREASE/BLEED, nesting, tọa độ hoặc snapshot golden master.
- Không đổi backend/native/PDFium; sidecar chỉ được rebuild/kiểm tra theo quy trình, không có thay đổi hình học chủ đích.
- Không build release, commit hoặc push trong lô này.
