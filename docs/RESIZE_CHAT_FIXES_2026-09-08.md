# NHẬT KÝ SỬA RESIZE ẢNH THU NHỎ BỊ MỜ

**Ngày:** 2026-09-08  
**Báo cáo gốc:** `docs/BAO_CAO_AUDIT_RESIZE_CHAT_2026-09-08.md`

## Lô 1 — Auto ưu tiên chất lượng (§RZ.2)

- `backend/app/workers/pdf_tools_engine.py`: `mode=auto` không còn tự gọi
  `_raster_resize` cho PDF ảnh-only. Raster chỉ chạy khi người dùng chọn
  tường minh; đường mặc định giữ Form/XObject và downsample object-level.
- `backend/tests/test_resize_smart.py`: cập nhật policy test và thêm regression
  chặn auto raster hóa ảnh RGB.

**Verify:** `tests/test_resize_smart.py` — 38 passed.

## Lô 2 — DPI nguồn JPEG EXIF (§RZ.4)

- `backend/app/workers/pdf_manifest_engine.py`: thêm parser TIFF/EXIF trong APP1,
  fallback sau JFIF; giữ JFIF làm nguồn ưu tiên khi cả hai cùng tồn tại.
- `desktop/src/lib/imageNormalizer.ts`: đọc EXIF DPI khi JPEG Photoshop không
  có APP0/JFIF; JPEG không có metadata vẫn fallback 72 DPI.
- `backend/tests/test_pdf_manifest_engine.py`: regression JPEG EXIF-only không
  có JFIF.
- `desktop/src/lib/imageNormalizer.test.ts`: regression trên đúng fixture
  `Tem thuc pham sach Duc An.jpg`.

**Verify:** backend manifest 40 passed; frontend image normalizer 30 passed.
Fixture hiện được dựng thành trang khoảng `460 × 460 mm` (288 DPI), không còn
`1840 × 1840 mm` do fallback 72 DPI.

## Lô 3 — Minh bạch pixel và cảnh báo chất lượng (§RZ.5)

- `desktop/src/components/preprocess-tools/PageResizerTool.tsx`: hiển thị số
  pixel dự kiến theo khổ + DPI; “Giữ nguyên” nói rõ giữ toàn bộ pixel; cảnh báo
  riêng cho downsample và raster.
- `desktop/src/i18n/locales/vi.json`, `en.json`: bổ sung chuỗi Việt/Anh và sửa
  mô tả Auto cho khớp policy mới.
- `desktop/src/components/preprocess-tools/PageResizerTool.test.ts`: regression
  khổ 50 mm ở 600 DPI hiển thị khoảng 1181 px và cảnh báo giảm mẫu.

**Verify:** PageResizerTool 22 passed; processHandlers + imageNormalizer + UI
Resize 110 passed; TypeScript typecheck đạt; JSON locale hợp lệ. UI hiển thị
`50 mm @ 600 DPI ≈ 1181 px` theo cùng công thức với backend.

## Ma trận verify tổng hợp

- Backend Resize + nền + manifest: **128 passed**, 1 warning deprecation của
  Pydantic.
- Frontend Resize/ImageNormalizer/ProcessHandlers: **110 passed**.
- `git diff --check` các file thuộc lô: sạch (chỉ cảnh báo LF/CRLF của Windows).

## Lô 4 — Hiển thị DPI gốc cho input ảnh

- `PreprocessingRouter.tsx` truyền `sourceImageFile` còn khớp revision vào
  `PageResizerTool`; không dùng ảnh tham chiếu cũ sau khi PDF đã chỉnh sửa.
- `PageResizerTool.tsx` đọc metadata ảnh qua `getFileArrayBuffer` và dùng chung
  parser `readImageDpi`: dòng thông tin hiển thị DPI hiện tại của ảnh, không bị
  thay bằng DPI đích 300/600. PDF vẫn giữ dòng pixel dự kiến như trước.
- Khi ảnh thiếu metadata hoặc đọc thất bại, UI báo rõ “không xác định/không đọc
  được”, không giả định 72 DPI.
- Bổ sung regression cho EXIF 288 DPI của fixture, DPI X/Y khác nhau, ảnh thiếu
  metadata, lỗi đọc và chống rò kết quả khi đổi file.

**Verify bổ sung:** PageResizerTool + imageNormalizer + sourceImageRevision
**60 passed**; full frontend **3460 passed, 2 skipped**; typecheck và Vite build
đạt.

## Còn lại / cần kiểm tay

- Chưa chạy thao tác đầy đủ trên Tauri desktop với file thật sau khi build app.
- `target_dpi=300/600` vẫn là downsample có chủ đích; muốn giữ 5216 px phải
  chọn “Giữ nguyên”.
- Route Resize đã trả telemetry `quality` trong `X-PrynX-Resize-Timing`/JSON:
  `requested_dpi`, `requested_mode`, `applied_mode`, `applied_dpi`,
  `downsample_applied` và `fallback_reason`. UI hiện vẫn hiển thị pixel dự kiến;
  chưa có toast riêng cho fallback này.
- Smoke route trên fixture ở `50 mm @ 600 DPI` trả
  `applied_mode=vector`, `applied_dpi=600`, `downsample_applied=true`.
