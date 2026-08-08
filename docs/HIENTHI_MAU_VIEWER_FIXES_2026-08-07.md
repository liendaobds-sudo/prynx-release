# NHẬT KÝ SỬA HIỂN THỊ MÀU PDF VIEWER

**Ngày:** 2026-08-07  
**Audit gốc:** `BAO_CAO_AUDIT_HIEN_THI_GRADIENT_VA_MAU_VIEWER_2026-08-07.md`  
**Audit unit:** `W7-U03`

## Lô 1 — Detector cấu trúc màu và runtime identity

### Thay đổi

- `desktop/src-tauri/src/pdf_color_risk.rs`
  - Thêm detector chỉ đọc dictionary PDF, không giải mã bitmap/stream content.
  - Ghi nhận theo từng trang: `DeviceCMYK`, `DeviceN`, `Separation`, transparency group, soft mask, blend mode và alpha.
  - Ghi nhận `/OutputIntents`, `riskyPages` và lý do có mã ổn định.
  - Có fixture Rust tối thiểu cho RGB thường, CMYK/DeviceN + transparency không OutputIntent và spot có OutputIntent.
- `desktop/src-tauri/src/lib.rs`
  - Dùng chung lần parse `lopdf` hiện có cho `/UserUnit` và detector màu, không đọc file lần hai.
  - Lưu kết quả trong document cache và trả qua `get_pdf_metadata`.
  - Ghi chính xác đường dẫn, kích thước, mốc sửa của `pdfium.dll`, phiên bản app và phiên bản tile cache thực sự đang chạy.
- `desktop/src/hooks/viewer/usePdfLoader.ts`
  - Giữ `colorRisk` và `renderEngine` theo đúng lượt tải; reset khi đổi file và không mượn metadata cũ khi fallback.
- `desktop/src/hooks/viewer/usePdfLoader.test.tsx`
  - Bảo vệ hợp đồng metadata Rust → React.

### Bất biến

- Không bật engine render phụ trong Lô 1.
- Không thêm cap/worker/cache mới.
- Máy mạnh không bị giảm công suất; detector dùng cùng lần parse cấu trúc PDF đã bắt buộc cho `/UserUnit`.

### Verify

- `cargo test pdf_color_risk --locked`: **3 pass**.
- `npm.cmd run test -- src/hooks/viewer/usePdfLoader.test.tsx`: **9 pass**.
- `npm.cmd run typecheck`: **pass**.
- `cargo fmt -- --check`: phần file mới đã được `rustfmt`; lệnh toàn crate còn báo format cũ trong `security.rs`, ngoài phạm vi đợt này.

## Lô 2 — Transport PNG lossless

### Thay đổi

- `desktop/src-tauri/src/lib.rs`
  - Thay encoder JPEG q90 bằng PNG RGBA lossless cho full-page và tile.
  - Đổi cache thành `v7_userunit_lossless_png` và đuôi `.png`, nên JPEG cache cũ không thể được đọc lại.
  - Protocol dự phòng trả đúng `Content-Type: image/png`.
  - Thêm test giải mã PNG và so pixel-equal với bitmap đầu vào.
- `desktop/src-tauri/src/tile_disk_cache.rs` (Lô 2b sau verify)
  - Bộ dọn cache nhận cả PNG hiện tại và JPEG legacy; vẫn chỉ xóa file có tên hash 16 ký tự trực tiếp.
  - Ngăn cache PNG mới bị bỏ ngoài quota và phình không giới hạn.
- `desktop/src/hooks/viewer/useTileRenderer.ts`
  - Native IPC tạo Blob PNG; fallback PDF.js cũng xuất PNG lossless.
- `desktop/src/components/acrobat/ThumbSidebar.tsx`
  - Thumbnail native khai báo đúng MIME PNG.

### Căn cứ hiệu năng

Trên artifact audit, PNG encode mất `4–10 ms`, JPEG q90 mất `133–334 ms`; PNG lớn hơn khoảng 4 lần nhưng cache RAM/đĩa hiện đã có budget theo phần cứng. Không thêm hard-cap mới và không hạ chất lượng máy `≥16 GB`.

### Verify

- `cargo test transport_png_giu_nguyen_tung_pixel_va_cache_dung_duoi_moi --locked`: **1 pass**, pixel-equal.
- `npm.cmd run test -- usePdfLoader + tileRenderScheduler + tileUrlCache`: **28 pass**.
- `npm.cmd run typecheck`: **pass**.

## Lô 3a — Backend render màu chính xác

### Thay đổi

- Thêm `/api/preflight/viewer-accurate`: nhận path PDF local đã được chuẩn hóa/kiểm đuôi/tồn tại, trang, DPI và profile.
- Dùng PPE/FOGRA39 qua `SoftProofEngine`; giữ các fallback hiện có khi PPE không khả dụng.
- Trả `image/png` lossless, không nén JPEG sau bước ICC.
- Route Viewer không bị khóa nhầm sau capability chuyển màu vì nó chỉ hiển thị, không sửa file.
- Giới hạn DPI `24–9600` chỉ là validation chống payload bất thường; ngân sách bitmap/zoom thật vẫn do Viewer quyết định.

### Verify

- `py_compile` cho schema/core/route/test: **pass**.
- `pytest -q backend/tests/test_icc_and_color_preview.py`: **9 pass, 1 skip** (Ghostscript tùy máy).

## Lô 3b — Nối accurate path vào Viewer

### Thay đổi

- Viewer tự bật chế độ CMYK chính xác khi detector đánh dấu file/trang rủi ro cao.
- Nút `CMYK✓` trên toolbar cho phép tắt/bật theo từng file; `CMYK!` báo accurate path lỗi và Viewer đã lùi về PDFium.
- Chỉ full-page dùng PPE; lớp tile PDFium bị tắt trong accurate mode để không đổi hue theo từng mảng khi zoom.
- Không prefetch PPE cho trang kề; chỉ trang active dùng đường chậm.
- Cache key tách `display` và `accurate`, tránh lấy nhầm bitmap PDFium cũ khi bật chế độ màu.
- Nếu PPE lỗi, ảnh PDFium fallback vẫn hiển thị nhưng không được cache dưới key accurate; tắt/bật CMYK sẽ thử lại được.
- DPI PPE được ánh xạ `96 × renderZoom`, cùng kích thước pixel với đường native.

### Verify

- `npm.cmd run test -- useTileRenderer + usePdfLoader + tileRenderScheduler + tileUrlCache`: **30 pass**.
- `npm.cmd run typecheck`: **pass**.
- Full frontend: **1.942 pass, 2 skip, 3 fail do timeout/mock ở hai file API ngoài phạm vi**; chạy riêng hai file đỏ ngay sau đó: **4/4 pass**.

## Lô 4 — Cách ly profile sRGB bị gắn nhãn sai

### Thay đổi

- Mọi ứng viên `srgb` được LittleCMS đọc tên/mô tả trước khi resolver trả cho consumer.
- `backend/app/assets/icc/sRGB.icc` hiện là Adobe RGB (1998), nên bị bỏ qua thay vì tiếp tục đầu độc Soft-Proof/Ghostscript.
- Resolver tìm profile sRGB chuẩn của hệ điều hành; nếu không có, tự materialize profile `sRGB built-in` chuẩn từ LittleCMS vào thư mục tạm nội bộ PrynX.
- Test khóa hai bất biến: kết quả không chứa `Adobe RGB`, và bundle gắn nhãn sai phải bị cách ly ngay cả khi là ứng viên duy nhất.

### Verify

- Backend màu/API/PPE: **121 pass, 1 skip**.
- Rust/Tauri full: **86 pass, 1 ignored**.
- Đúng PDF khách qua endpoint mới: `ppe+lcms`, `rip_softproof`, PNG `1210 × 907`; MAE với ảnh Acrobat **4,6632**, dịch RGB `(+1,022; -2,727; -1,896)`.
- `git diff --check`: **pass**.
- Lint file Viewer vẫn đỏ bởi baseline cũ của các file lớn (`any`, unused, hook deps); không có lỗi typecheck và test phạm vi mới đều xanh.

## Trạng thái bàn giao

- Mức bằng chứng: `ARTIFACT` — đã đo đúng PDF khách và có regression tự động xuyên detector/transport/endpoint.
- Chưa tuyên bố `RUNTIME`: cần mở lại app Tauri, chọn đúng PDF, xác nhận nút `CMYK✓` tự bật và quan sát màu trang trên chính màn hình người dùng.

## Lô phản hồi runtime — Progressive color render

**Phản hồi:** màu/gradient đã mượt nhưng ảnh đầu tiên xuất hiện chậm vì Viewer đợi toàn bộ PPE (`~2,5 giây/trang`).

**Sửa `§GV.P1`:** full-page chính xác màu chạy hai pha bắt buộc:

1. `display`: PDFium → PNG lossless hiện ngay, không ghi vào cache accurate.
2. `accurate`: PPE + FOGRA39 → sRGB chạy nền, thay ảnh đúng cùng kích thước và là kết quả duy nhất được cache.

Không giảm DPI, không hạ chất lượng máy mạnh, không bật lại tile PDFium trên lớp màu chính xác. Nếu PPE lỗi, ảnh display đang thấy vẫn được giữ và toolbar báo `CMYK!`.

PPE được tách khỏi `nativeTileRenderScheduler`: hàng đợi này chỉ dành cho PDFium có khóa tuần tự. Đổi trang hủy request accurate frontend cũ, còn PDFium trang mới được chạy ngay thay vì chờ PPE trang trước.

### Verify

- `npm.cmd run typecheck`: **pass**.
- Viewer target (`useTileRenderer`, scheduler, tile cache, loader): **32 pass**.
- Regression mới xác nhận khi PPE promise còn pending, PDFium trang kế vẫn trả ảnh ngay; thứ tự màu là `display → accurate`.
- Runtime màu/gradient đã được người dùng xác nhận mượt trước lô này; tốc độ progressive chờ người dùng chuyển trang kiểm lại trên app dev đang chạy.

## Lô phản hồi runtime — Cache chuẩn màu và dựng trước trang liền kề

**Phản hồi:** ảnh display xuất hiện sớm nhưng lớp PPE chuẩn màu vẫn mất khoảng vài giây ở
mỗi trang chưa từng dựng.

### Đo nút thắt trước khi sửa

Công cụ `print_engine/examples/softproof_bench.rs` tách bốn công đoạn trên đúng file
`CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1/2 ở 36 DPI:

| Công đoạn | Trang 1 | Trang 2 |
|---|---:|---:|
| Nạp ICC | `0,560 ms` | `0,555 ms` |
| Mở/parse PDF | `31,440 ms` | `31,423 ms` |
| Render PPE | `1.215,875 ms` | `3.080,584 ms` |
| CMYK → sRGB | `27,897 ms` | `39,304 ms` |

Kết luận đo được: cache `lopdf::Document`/`ColorManager` chỉ tránh khoảng 32 ms và không
thể giải quyết cảm giác chậm; phần render nội dung chiếm gần toàn bộ thời gian. Thử giới
hạn vùng quét gradient giữ pixel đúng nhưng không tạo mức tăng ổn định trên artifact nên
không được giữ trong bản sửa.

### Sửa `§GV.P3`

- Thêm cache PNG chuẩn màu trong `RESULTS_DIR/viewer_accurate_cache`; cleanup hiện hành
  tự dọn file cũ sau 26 giờ không sử dụng.
- Khoá cache gồm path chuẩn hoá + size + mtime/ctime của PDF, trang, DPI, profile CMYK,
  profile sRGB, intent và phiên bản pipeline. File/profile thay đổi không thể lấy ảnh cũ.
- Chỉ ảnh `rip_softproof` và PNG lossless hợp lệ mới được ghi; fallback xấp xỉ tuyệt đối
  không đi vào cache.
- Single-flight dùng chung một task cho request trùng khoá, tránh prefetch và thao tác
  người dùng render cùng một trang hai lần.
- Sau khi trang active hoàn tất PPE, Viewer dựng nền đúng hai trang liền kề thuộc danh
  sách rủi ro màu. Không hạ DPI, không thay profile, không bật lại tile PDFium.
- Gate đồng thời theo RAM: `<8 GB → 1`, `8–15 GB → 2`, `≥16 GB → không cap`.

### Kết quả đo và verify

- Gọi hàm endpoint trong cùng tiến trình: `1,2644 s` (miss) → `0,0012 s` (disk-hit),
  PNG cùng SHA-256 `8405F91AF7EE0C02008C0CCE840E0CBC58C0ADA23A7A9D0D5EA290F8D20289C6`.
- Gọi qua đúng HTTP Viewer sau khi restart backend dev: `2,8786 s` → `0,1296 s`, nhanh
  hơn khoảng **22×** ở lần xem lại.
- Backend cache + màu: **17 pass, 1 skip**.
- Viewer target: **34 pass**; `npm.cmd run typecheck`: **pass**.
- `cargo test --locked` trong `print_engine`: **pass** toàn bộ 348 unit test và các bộ
  integration; native `maturin develop --release`: **pass**.
- App dev/backend đã khởi động lại; `/health`: **OK**.

**Giới hạn trung thực:** trang đầu tiên chưa từng dựng ở DPI đó vẫn phải chạy PPE thật.
Tốc độ chuyển trang được cải thiện nhờ dựng trước, còn quay lại trang/mở lại file trong
vòng đời cache lấy PNG chuẩn màu trực tiếp từ đĩa.
