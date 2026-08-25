# Lint fixes 2026-08-24 — Lô 88

## Phạm vi

- `desktop/src/engine/barcode/qrLogos.ts`
- `desktop/src/engine/barcode/qrEngine.ts`
- Mục tiêu: loại bỏ suppression/type `any` trong engine QR, giữ nguyên payload và kết quả tạo mã.

## Thay đổi

- Bỏ `@ts-nocheck` khỏi thư viện logo QR và khai báo `QRLogoDefinition` riêng cho dữ liệu nguồn có `svgContent`; mảng logo xuất ra vẫn giữ kiểu `QRLogo[]`.
- Đổi tham số dữ liệu của `buildQRString` từ `any` sang `unknown`; các nhánh hiện có vẫn dùng cùng các cast/format runtime.
- Đổi fallback `getQRBlob` sang truyền trực tiếp `Buffer` vào `Uint8Array`, không dùng cast `any`.

## Kết quả

- ESLint hẹp cho hai file: đạt.
- `npm run typecheck`: đạt.
- `npm run lint:budget` tại thời điểm verify: `657 errors`, `103 warnings`, gate đạt. Số liệu toàn kho có thể thay đổi do các lô song song trong working tree; không dùng để quy toàn bộ mức giảm cho LO88.

## Bất biến và rủi ro

- Không đổi danh sách logo, URI SVG, chuỗi QR, format blob, caller hoặc API runtime.
- Không có test riêng cho barcode/QR trong `src`; chưa chạy kiểm tay tạo/tải QR trên WebView.
- Không chạm backend/PDFium, không commit, push hoặc build release.
