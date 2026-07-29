# NHẬT KÝ SỬA LỖI I18N, FILE CỤC BỘ VÀ 403

**Ngày:** 2026-07-28  
**Báo cáo gốc:** `docs/BAO_CAO_AUDIT_LOI_TUONG_TU_I18N_ASSET_LOCAL_2026-07-28.md`

## Kết quả

Đã đóng toàn bộ 7 phát hiện trong báo cáo audit: 4 P1 và 3 P2.

### Lô A — file cục bộ và upload an toàn

- Thêm `desktop/src/lib/localFileTransport.ts` làm một nguồn chân lý cho URL và đọc byte/range file cục bộ.
- `prepareFileForUpload` không còn trả lại fake `File` rỗng khi đọc thất bại; tác vụ dừng trước request với lỗi tiếng Việt rõ ràng.
- `getFileArrayBuffer` không còn thử `asset.localhost` để nhận 403 rồi mới fallback.
- `detectColorSpace` chỉ phân tích response thành công; body của 403/404 không thể bị coi là byte PDF.
- Tauri đăng ký protocol `localfile` có allowlist phần mở rộng, chặn đường dẫn nhạy cảm, hỗ trợ GET/HEAD/OPTIONS, CORS và byte Range.

### Lô B — preview ảnh/PDF/font

- Chuyển các điểm dùng `convertFileSrc` trực tiếp trong Combine, Imposition, Recent Files, Font Selector và Live Page Frame sang protocol chung.
- Preview không còn phụ thuộc asset scope cố định của Tauri và không cần tải toàn bộ PDF lớn qua IPC chỉ để lấy Range.

### Lô C — i18n và hàng rào hồi quy

- Bổ sung 93 khóa tĩnh còn thiếu cho cả `vi.json` và `en.json`.
- Đổi `&#10;` trong tooltip thành newline JSON thật.
- Thêm `desktop/src/i18n/i18nCatalog.test.ts`: quét AST toàn bộ TypeScript/TSX, buộc mọi khóa `t(...)` tĩnh tồn tại ở cả hai locale và cấm HTML entity trong locale.
- Thêm `desktop/src/lib/localFileTransport.test.ts`: che byte Range, 403, fake file rỗng, upload fail-safe và dò hệ màu.

## Xác minh

- TypeScript typecheck: **PASS**.
- Vitest toàn frontend: **142 test files PASS; 1.210 tests PASS; 2 skipped có chủ đích**.
- ESLint cho các file mới: **PASS**.
- Rust `cargo check`: **PASS**.
- Rust `cargo test --lib`: **40/40 PASS**.
- Static i18n coverage: **0 khóa thiếu** ở VI và EN.
- Quét locale: **0 HTML entity** thuộc nhóm cấm.
- Quét source runtime: **0 lời gọi `convertFileSrc` trực tiếp** còn lại.
- `git diff --check`: **PASS**.

## Lưu ý vận hành

Protocol `localfile` được đăng ký ở tiến trình Tauri/Rust. Sau khi nhận thay đổi này phải đóng hẳn phiên PrynX dev cũ và chạy lại `run_dev.bat`; hot reload frontend không thể nạp protocol mới.
