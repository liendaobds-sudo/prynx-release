# Biến môi trường của PrynX (backend sidecar)

KIENTRUC (audit 2026-07-29 §D.2). Trước file này, các núm điều chỉnh nằm rải rác: đọc `os.environ`
ở ~65 chỗ trong `backend/app`, `config.py` chỉ khai 16 field, `.env.example` chỉ nhắc 4 biến — người
vận hành không có cách nào biết có những núm nào.

Quy ước đọc bảng:

- **Mặc định** là giá trị khi biến KHÔNG được đặt. "auto" = tự chọn theo phần cứng.
- **Đụng tới khi nào** viết cho người vận hành/hỗ trợ khách, không phải cho dev.
- Biến không có trong bảng này thì coi như **không được hỗ trợ** — thêm biến mới thì thêm dòng ở đây
  trong cùng PR (đây là chốt để bảng không lạc hậu).

Ràng buộc chung: sidecar chạy `127.0.0.1:8321`, một tiến trình. Mọi trần dưới đây là **trần của một
tiến trình**; việc nặng chạy process con riêng nên trần job không phải trần CPU của máy.

---

## 1. Giấy phép & bảo mật

| Biến | Mặc định | Đụng tới khi nào |
|---|---|---|
| `DEV_MODE` | `false` | Chỉ khi phát triển cục bộ. Trên **binary compiled** biến này bị BỎ QUA (fail-closed): guard vẫn cưỡng chế token/chữ ký. Nguồn chân lý là `license_guard._is_dev_mode()`, không phải `settings.DEV_MODE` |
| `PRYNX_SIDECAR_TOKEN` | *(không)* | Token định danh sidecar do host Tauri truyền. Thiếu token khi `DEV_MODE=off` → mọi request bị 403 |
| `PRYNX_TOKEN_FILE` | *(không)* | Đường dẫn file chứa token (thay cho truyền qua stdin) |
| `PRYNX_TOKEN_SOURCE` | *(không)* | Nguồn token, dùng để chẩn đoán khi 403 |
| `PRYNX_ENFORCE_LICENSE_TOKEN` | bật | Chỉ tắt khi debug guard; **không** ship |
| `PRYNX_LICENSE_PUBLIC_KEY` | khoá nhúng | Ghi đè khoá công khai verify license (test/staging) |
| `PRYNX_MAX_TOKEN_LIFETIME_SECONDS` | theo `license_guard` | Siết tuổi token khi điều tra sự cố phát hành |
| `PRYNX_CLOCK_GUARD_FILE` | theo APPDATA | Đổi chỗ lưu mốc chống lùi đồng hồ |
| `PRYNX_SECURITY_DIAG` | tắt | Bật log chẩn đoán posture bảo mật. Log có thể lộ thông tin môi trường → không bật lâu trên máy khách |
| `PRYNX_FEATURE_GATING_ENABLED` | bật | Tắt cổng tính năng theo gói (Free/Pro) khi test |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | *(không)* | Chỉ dùng cho đường kích hoạt/kiểm tra license phía server |
| `PRYNX_SUPABASE_URL`, `PRYNX_SUPABASE_SECRET_KEY` | *(không)* | Tương thích CI/CLI để lấy khóa resource khuôn bế; build lấy và xóa hai biến ngay đầu process, trước mọi tool con. Launcher chuẩn không dùng env: `build_production.ps1` tự giải mã kho DPAPI `%LOCALAPPDATA%\PrynX\ReleaseSecrets\secrets.clixml` đúng tại bước REST. Public release chỉ nhận khóa mới `sb_secret_` |

## 2. Trần đồng thời (concurrency)

Nguyên tắc rule #1: **máy yếu mới điều chỉnh, máy ≥16 GB chạy hết công suất.** Muốn máy mạnh nhanh
hơn thì tăng **worker trong job**, không tăng **số job** — mỗi job nặng đã tự trải hết lõi.

| Biến | Mặc định | Đụng tới khi nào |
|---|---|---|
| `PRYNX_MAX_HEAVY_JOBS` | auto theo RAM: `<8GB`→1, `<16GB`→2, `≥16GB`→3, `≥64GB`→4 | Trần việc nặng **dùng chung**. Cũng là số chia **ngân sách RAM** mỗi slot — tăng thì mỗi slot được ít RAM hơn. Đặt `2` để quay về hành vi trước 2026-07-29 nếu máy khách có biểu hiện lạ. **Không** phải trần của bình bản/VDP/tem: ba loại đó có trần phụ riêng (xem dưới) |
| *(trần phụ, không có env)* | `nup`+`vdp`+`compare` = **1 suất chung**; `office` = **1 suất** | Ba loại đầu mỗi job đã tự mở tới `cpu-1` process nên chỉ một job chạy tại một thời điểm. `office` (COM/LibreOffice) cách ly vì nhiều instance là nguồn treo đã có lịch sử. Định nghĩa ở `core/heavy_job_scheduler.py` (`_WHOLE_MACHINE_KINDS`, `_SERIAL_KINDS`) |
| `PRYNX_MAX_NUP_JOBS` | `1` | **Đừng tăng** trừ khi đã đo. Một job bình bản đã mở tới `cpu−1` process |
| `PRYNX_MAX_NUP_QUEUE` | `8` | Số job bình bản được xếp chờ; vượt → từ chối sớm thay vì phình RAM |
| `PRYNX_NUP_WORKERS` | auto theo RAM+CPU | **Đây** là núm cho máy mạnh/máy yếu của bình bản. Ép số process trong MỘT job (cả chiều tăng và giảm) |
| `PRYNX_MAX_VDP_JOBS` / `PRYNX_MAX_VDP_QUEUE` | `1` / `8` | Như nup: job VDP đã tự chia chunk theo lõi |
| `PRYNX_MAX_STICKER_JOBS` | `1` | Bình tem bế; worker trong job do `_auto_sticker_hw_profile` chọn theo RAM+CPU |
| `PRYNX_MAX_COMPARE_JOBS` / `PRYNX_MAX_COMPARE_QUEUE` | `1` / `8` | So sánh PDF (render + so ảnh, tốn RAM theo khổ trang) |
| `PRYNX_MAX_COMPARE_PAGE_PIXELS` | theo `compare.py` | Trần số pixel một trang được render khi so sánh. Hạ khi khách mở file A0/A1 trên máy yếu |
| `STICKER_MAX_WORKERS` | auto theo RAM+CPU | Ép số worker bình tem trong một job |
| `STICKER_STICKY_SEQ_SEC` | auto theo tier | Thời gian "dính" chế độ tuần tự sau khi gặp job nặng |
| `STICKER_PARALLEL_MIN_PAGES` | theo `sticker_engine` | Dưới ngưỡng trang này thì chạy tuần tự (song song không đáng) |
| `STICKER_FORCE_SEQUENTIAL` | tắt | Ép tuần tự khi nghi lỗi do song song |

## 3. Bộ nhớ & chất lượng render

| Biến | Mặc định | Đụng tới khi nào |
|---|---|---|
| `PRYNX_PPE_MEMORY_BUDGET_MB` | auto theo RAM (`<8GB`/`<16GB`/`≥16GB`, chia theo số slot việc nặng) | Ép ngân sách RAM mỗi lần render của print engine. Đặt sai (`≤0`) sẽ raise ngay khi khởi tạo — cố tình fail sớm |
| `PRYNX_DETECT_RASTER_MAX` | theo `imposition.py` | Trần kích thước raster khi dò đường bế/khuôn |
| `PRYNX_UPSCALE_TILE` | auto (hạ khi RAM `<8 GB`) | Kích thước tile upscale; hạ khi máy yếu OOM |
| `PRYNX_UPSCALE_MAX_SECONDS` | theo `realesrgan_engine` | Trần thời gian một job upscale trước khi bỏ cuộc |
| `PRYNX_UPSCALE_GPU_TILE_BUDGET_S` | theo `realesrgan_engine` | Ngân sách thời gian mỗi tile trên GPU; vượt → tự hạ về CPU |
| `PRYNX_UPSCALE_FORCE_CPU` | tắt | Ép upscale chạy CPU khi GPU/DirectML treo |
| `PRYNX_BG_FORCE_CPU` | tắt | Ép tách nền (BiRefNet/ISNet) chạy CPU |

## 4. Ghostscript, PDFium, đường dẫn

| Biến | Mặc định | Đụng tới khi nào |
|---|---|---|
| `GHOSTSCRIPT_PATH` | tự dò | Trỏ tới `gswin64c.exe` khi bản cài đặt ở chỗ lạ |
| `PRYNX_NO_GS_BUILD` | tắt | Đánh dấu bản build **không kèm** Ghostscript → engine tự chọn đường thay thế |
| `PDFIUM_DLL_PATH` | tự dò `native/pdfium_lib/bin` | Trỏ thư mục chứa `pdfium.dll` cho module Rust |
| `VIRTUAL_ENV` | theo venv | `rust_bridge` dùng để dò `pypdfium2_raw/pdfium.dll` khi không có `PDFIUM_DLL_PATH` |
| `IMPOSITION_RESTRICT_PATHS` | bật | Giới hạn đường dẫn file mà endpoint `*-by-path` được đọc |
| `IMPOSITION_ALLOWED_DIRS` | *(không)* | Danh sách thư mục được phép, đi cùng biến trên |
| `DATABASE_URL` | SQLite cục bộ | Chỉ đổi cho deployment web/docker cũ |

## 5. Parity & fallback engine

| Biến | Mặc định | Đụng tới khi nào |
|---|---|---|
| `IMPOSITION_ALLOW_PY_FALLBACK` | `0` (Rust **bắt buộc**) | Đặt `1` để chạy solver Python khi thiếu module Rust. **KHÔNG đảm bảo parity** — xem `backend/tests/parity/KNOWN_DIVERGENCES.md`. Không dùng cho production |
| `PRYNX_OUTLINE_TRUST_PPE` | theo `outline_text.py` | Tin kết quả outline của print engine thay vì hậu kiểm lại |
| `PRYNX_SHAPE_CLIP` | theo `nup_clip_shape.py` | Bật/tắt clip theo hình khi bình tem |

## 6. Log & chẩn đoán (mặc định TẮT — chỉ bật khi đang điều tra)

| Biến | Mặc định | Ghi ra |
|---|---|---|
| `PRYNX_PERF` | tắt | Bật lấy mẫu hiệu năng. Khi tắt, code lấy mẫu **không chạy** dòng nào |
| `PRYNX_PERF_DIR` | `tmp/` | Thư mục chứa file mẫu hiệu năng |
| `PRYNX_PREVIEW_PERF_LOG` | tắt | Log thời gian dựng preview |
| `PRYNX_EDIT_BUG_LOG` / `PRYNX_EDIT_BUG_LOG_PATH` | tắt / `tmp/logs/edit_pdf_bug.jsonl` | Log chẩn đoán sửa PDF |
| `PRYNX_EDIT_TEXT_MOVE_LOG` / `PRYNX_EDIT_TEXT_MOVE_LOG_PATH` | tắt | Log riêng cho thao tác di chuyển text |
| `PRYNX_ROT_AUDIT` | tắt | Log audit góc quay (mỗi process worker tự gắn handler) |
| `STICKER_DEBUG`, `STICKER_TIMING` | tắt | Log chi tiết/bấm giờ bình tem |

---

## Ghi chú vận hành

- Cấu hình khóa máy build một lần bằng `scripts\setup_release_secrets.ps1`. Không dán key vào file
  `.ps1`, `.bat`, `.env`, lịch sử lệnh hoặc chat. Kho DPAPI gắn với đúng tài khoản Windows đã lưu.
- Log ứng dụng: `%APPDATA%\PrynX\logs\app.log` (xoay vòng 5 MB × 5) — cùng thư mục với `security.log`.
- Biến hệ thống mà backend chỉ **đọc** (không phải cấu hình của PrynX): `APPDATA`, `HOME`, `WINDIR`.
- Trên bản đóng gói, `/docs`, `/redoc`, `/openapi.json` bị tắt và **không** bật lại được bằng env —
  cố ý, vì đó là bản đồ API cho kẻ trinh sát.
