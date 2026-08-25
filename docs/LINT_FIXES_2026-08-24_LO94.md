# Lô LO94 — Type hóa barcode engine (2026-08-24)

## Phạm vi

`desktop/src/engine/barcode/barcodeEngine.ts`.

## Thay đổi

- Bỏ `@ts-nocheck`.
- Dùng `RenderOptions` suy ra trực tiếp từ API browser của `bwip-js`, thay cho
  `Record<string, any>` và các cast `as any`.
- Dùng `unknown` trong catch và chuyển lỗi thành message an toàn trước khi đưa
  vào i18n.
- Đổi import sang `bwip-js/browser`, subpath có declaration/export browser chính
  thức; không thêm dependency và không đổi encoder, options, dữ liệu mã vạch hay
  kết quả SVG/canvas.

## Verify

- ESLint file: đạt, 0 finding.
- `npm run typecheck`: đạt.
- Không có test barcode chuyên biệt trong repo; chưa chạy runtime UI barcode.

Không commit/push/build release.
