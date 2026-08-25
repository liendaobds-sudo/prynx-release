# Lô LO93 — Dọn QR worker legacy mồ côi (2026-08-24)

## Bằng chứng

`desktop/src/engine/barcode/qrWorker.ts` có 3 finding (`@ts-nocheck`, hai
`any`) nhưng không có import/caller trong toàn repo. File không được export qua
`engine/barcode/index.ts`, không có test, và dùng `qrcode`/`jszip` không tồn tại
trong `desktop/package.json`, lockfile hoặc `node_modules`. Luồng QR đang chạy
thực tế dùng `qrEngine.ts` (`qr-code-styling`) và `ViewerHelpers`.

## Thay đổi

Xóa duy nhất file worker legacy không nằm trong import graph. Giữ nguyên các key
i18n cũ để tránh thay đổi ngoài phạm vi. Không thêm dependency hoặc thay đổi
worker đang được dùng bởi tính năng khác.

## Verify

- `rg` xác nhận không còn import/runtime reference; chỉ còn key i18n legacy.
- `npx eslint src/engine/barcode src/components/workspace/ViewerHelpers.tsx`:
  không còn finding ở QR engine/worker; còn 6 finding có sẵn trong `barcodeEngine.ts`,
  không thuộc lô này.
- `npm run typecheck`: đạt.

Việc xóa là có chủ đích dựa trên import graph; chưa commit/push/build release.
