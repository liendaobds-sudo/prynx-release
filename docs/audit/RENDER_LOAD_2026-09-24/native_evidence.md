# Bằng chứng tầng native — 2026-09-24

Phạm vi: `render_pdf_page` → `render_worker` → `render_tile_with_options` → PDFium → PXRG/PNG. Không sửa production, không build, không mở/đóng hoặc điều khiển phiên UI của người dùng.

## Tái hiện

Chạy từ gốc repo trên Windows:

```powershell
backend/venv/Scripts/python.exe docs/audit/RENDER_LOAD_2026-09-24/native_render_audit_probe.py
backend/venv/Scripts/python.exe docs/audit/RENDER_LOAD_2026-09-24/native_worker_artifact_probe.py
```

Probe thứ nhất dựng hai fixture PDF độc lập, gọi trực tiếp DLL qua ctypes trong process Python riêng. Probe thứ hai dùng đúng EXE app đang có với `--prynx-render-worker`: `main.rs:7-9` rẽ nhánh trước Tauri, không tạo cửa sổ. Child được tạo với `CREATE_NO_WINDOW`; cleanup chỉ đóng child do probe tạo. Không dùng PDF của khách.

Kết quả tổng quát là **ARTIFACT**, chưa phải thao tác UI Windows/Acrobat parity. Script ghi file chứng cứ cùng thư mục này. Cần rerun khi DLL/EXE/source đổi; không suy provenance binary từ commit HEAD.

## Provenance đã đo

| Artifact | SHA-256 |
|---|---|
| `desktop/src-tauri/target/debug/pdf-inspector.exe` | `ff8a97bcb773dfbc8e94bdf371f1cd087d16812491f25989bf2f5ca22f5a822d` |
| `desktop/src-tauri/bin/pdfium.dll` và `target/debug/bin/pdfium.dll` | `01be7a757183793f15eb35de9d9da424fc07d24b5560e8c3822f52812b2ad89a` |
| `native_render_flags_fixture.pdf` | `0cc8d2b1e8675ba4c675b65cd02f1000a205571a9d932ad7c65e906e08af7f2d` |

EXE: 29.158.400 bytes; LastWriteTime cục bộ `2026-09-24 20:40:57`. Worker handshake xác nhận app `2.0.4`, protocol `4`, cache `v9_opaque_white_lcd_sharp_png`, pipeline `pdfium-display-png-v1` và đúng SHA-256 DLL ở trên. Header cùng payload đầy đủ nằm trong `native_worker_artifact_probe.json`.

## N1 — [CONFIRMED] FPDF_PRINTING đổi nội dung màn hình sang nội dung in

Đề xuất P1, effort S. `desktop/src-tauri/src/lib.rs:4160,4193` thêm `.use_print_quality(true)` cho cả clip và full-page, trong khi consumer vẫn là Viewer display. Đây không phải cờ nâng độ chính xác chung của vector.

Fixture 400×200 chứa:

- Đỏ: OCG `/ViewState /ON`, `/PrintState /OFF`.
- Xanh lá: OCG `/ViewState /OFF`, `/PrintState /ON`.
- Xanh dương: annotation có appearance, `/F 0`, nhìn được trên màn hình nhưng không có Print flag.

Cùng DLL và chỉ thêm `FPDF_PRINTING` làm đổi 30.000 pixel: đỏ và annotation xanh dương biến mất; xanh lá xuất hiện. `native_render_flags_probe.png` ghép kết quả view phía trên, print phía dưới. Worker EXE hiện có trả đúng hành vi print cho **cả page và clip**, xem `native_worker_page.png`, `native_worker_clip.png` và JSON. Probe text/vector thuần không OCG/annotation cho **0 pixel khác** khi chỉ bật thêm cờ in; không có bằng chứng cờ này nâng độ nét ở ca đó.

Nguồn chính thức: [PDFium `cpdfsdk_renderpage.cpp`](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/fpdfsdk/cpdfsdk_renderpage.cpp), hàm `RenderPageImpl` chọn OCContext `kPrint` khi có `FPDF_PRINTING`, và truyền trạng thái in cho annotation list.

Ngoài ra token PNG cache vẫn là v9 (`lib.rs:1828`) từ commit trước khi thêm print flag, nên PNG cache cũ có thể giữ nội dung View trong khi PXRG mới dựng nội dung Print. Nên reset đúng version khi sửa semantic render; không xóa cache người dùng trong audit.

## N2 — [CONFIRMED] Nền trắng đục chưa kích hoạt LCD subpixel

Đề xuất P2, effort S/M. `lib.rs:4147,4156,4188,4191` đặt clear alpha 255 và bật LCD, nhưng không thay bitmap format. Dependency đang dùng `pdfium-render 0.8.37`:

- `src/pdf/document/page/render_config.rs:109-124`: constructor lấy `PdfBitmapFormat::default()`.
- `src/pdf/bitmap.rs:101-105`: mặc định là `BGRA`.
- `src/pdf/document/page/render_config.rs:414-415`: setter format tồn tại nhưng caller hiện tại không dùng.

Probe chữ Helvetica 11 pt + nét/vector, cùng DLL, cùng kích thước:

| Cấu hình | Pixel có R/G/B khác nhau |
|---|---:|
| BGRA trắng đục, LCD bật | 0 |
| BGRA trắng đục, LCD tắt | 0 |
| BGRA trong suốt, LCD bật | 0 |
| BGRx trắng đục, LCD bật | 898 |

BGRA opaque LCD bật/tắt giống nhau **từng pixel**. Đây là phủ định trực tiếp claim hiện tại rằng clear white alpha 255 đã kích subpixel. Không khẳng định BGRx mặc định sẽ tốt trên mọi màn hình, DPR, nền trong suốt hoặc transform CSS: cần khóa đúng device-pixel mapping và kiểm riêng font/zoom/độ tương phản.

Nguồn chính thức: [PDFium `cfx_renderdevice.cpp`](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/core/fxge/cfx_renderdevice.cpp), `DrawNormalText`: nhánh thiết bị có `render_cap_alpha_output_` đặt `normalize=true`; helper đưa RGB coverage về trung bình. Quyết định dựa vào khả năng alpha của surface, không chỉ alpha màu clear.

## Các nghi vấn đã trace, chưa nâng thành finding artifact

1. **Cancel giữ độc quyền lane đến hết render**: `render_worker.rs:3098-3139` bỏ kill ở request display và chỉ loại active lease; `PendingClientResponse::wait` tại `2347-2352` vẫn `recv()` không có cancel/deadline. `dispatch_worker_request:3424,3463` giữ `WorkerLaneLease` trong suốt `dispatch_locked_worker`, rồi `render_display_with_policy_inner:3928` mới kiểm pending cancel sau khi nhận frame. Vì thế claim “drop in-flight ngay” trong comment không đúng ở parent wait; stale display vẫn giữ lane trên trang nặng. Chưa đo thời gian cancel của binary hiện tại, không lấy số 1–3 ms trong comment làm baseline.

2. **PXRG là đường raw có copy và mất disk reuse, chưa là shared surface**: `lib.rs:3961` copy toàn pixel vào Vec; `4239` clone thêm vào RAM cache; `TileCache::get:2613` clone khi hit; `render_worker::read_frame` cấp phát payload parent. Raw dùng key `_pxrg` riêng (`4004`), không đọc/ghi PNG disk cache (`4033,4224`), cache >=16 GiB không có byte ceiling (`2657-2663`, đây là policy có từ trước). Không gọi đây là lỗi chỉ vì raw lớn: cần so thời gian end-to-end, RSS và churn trên corpus khách; PNG/PXRG là encoding lossless cùng pixel nên không tự nâng độ nét.

3. **Rotation parameter trong native**: native display cache mang rotation nhưng render config không rotate. Chưa kết luận bug vì frontend có thể chủ động CSS-rotate và truyền clip trong tọa độ gốc. Cần đọc consumer trước khi báo finding; không tính chỉ từ biến chưa sử dụng.

## Giới hạn và phản chứng

- PNG→PXRG không phải nén mất dữ liệu; không có cơ sở nói bản thân transport làm mờ chữ.
- Parent/worker format PXRG có suffix cache riêng; không có PNG/raw collision trong key hiện tại.
- ResponseRouter chủ động tiêu thụ frame của receiver đã bỏ; không coi mọi cancel là protocol mismatch.
- Code giữ generation và kiểm cancel sau response, nên nghi vấn cancel ở trên là responsiveness/tài nguyên, không có bằng chứng stale frame được commit.
- Chưa chạy cargo build/test, chưa benchmark P50/P95, chưa đo Acrobat trên cùng màn hình và settings. Không tuyên bố nguyên engine kém hơn Acrobat từ hai fixture này.
