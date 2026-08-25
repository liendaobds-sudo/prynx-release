# Lô lint P2.50 — 2026-08-23

## Phạm vi

Thu hẹp hai `no-explicit-any` tại imposition UI và viewer VDP:

- `NupSettingsSection`: dùng `NupSettings['layoutType']` cho RichSelect.
- `ViewerHelpers`: định nghĩa `VdpPreviewField` cho QR/barcode và dùng type engine
  `QRStyleOptions`/`BarcodeType`.

QR preview merge style theo thứ tự default → style người dùng → override preview,
đảm bảo object gửi engine luôn đủ thuộc tính bắt buộc.

Không đổi lựa chọn layout, nội dung QR/barcode hoặc hình học overlay.

## Verify

- ESLint hẹp: 2 file còn 0 `no-explicit-any`.
- Workspace/viewer + imposition sections: 17 file test, 229/229 đạt.
- `npm run typecheck`: đạt sau khi siết merge QR style đầy đủ.
- `git diff --check`: đạt; chỉ có cảnh báo autocrlf.
- `npm run lint:budget`: 1.177 → 1.175 errors; warnings giữ 103.

## Kết luận

Lô chỉ bổ sung hợp đồng tĩnh; preview QR/barcode và layout runtime giữ nguyên.
