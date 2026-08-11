# UPSCALE / SIDECAR STABILITY — NHẬT KÝ SỬA

**Ngày:** 2026-08-11  
**Nguồn finding:** `docs/BAO_CAO_AUDIT_UPSCALE_ON_DINH_SIDECAR_2026-08-11.md`  
**Quy trình:** lô tối đa 5 file, test đỏ trước bản vá, verify hẹp sau bản vá

## Lô A — Lifecycle DirectML và reservation RAM

**Finding:** `§US.03`, `§US.04`  
**Trạng thái:** `AUTO + RUNTIME-HẸP`; chưa nghiệm thu trên máy khách lỗi

### Thay đổi

1. `backend/app/workers/realesrgan_engine.py`
   - Probe và job thật dùng chung đường chạy fallback/teardown.
   - Session DirectML lỗi được lấy khỏi cache, đóng, tháo native `_sess` và GC trước
     khi tạo session CPU.
   - Quality cũng teardown xác định trước khi trả lỗi; xóa probe timing stale.
   - Khóa tường minh `ORT_SEQUENTIAL` và `enable_mem_pattern=False` cho DirectML.
2. `backend/app/core/heavy_job_scheduler.py`
   - Thêm memory reservation theo số MB, chờ async không chiếm token threadpool.
   - Một job lớn được dùng toàn ngân sách khi chạy một mình; job đồng thời chỉ được
     admit khi tổng reservation còn vừa RAM.
   - Waiter hỗ trợ cancel và luôn release reservation/slot trên mọi nhánh.
3. `backend/app/api/routes/pdf_tools.py`
   - Đọc header ảnh trước worker, lấy estimated peak rồi truyền vào scheduler.
   - Recheck kích thước sau lúc chờ để chặn TOCTOU vượt reservation.
   - Nếu RAM giảm trước admission, trả 422 có hướng xử lý thay vì OOM/crash.
4. `backend/tests/test_upscale.py`
   - Khóa thứ tự `GPU run -> close -> native clear -> GC -> CPU create -> CPU run`.
   - Khóa peak memory và wiring route -> scheduler.
5. `backend/tests/test_heavy_job_scheduler.py`
   - Khóa queue/release, single-job full budget, oversized reject và cancel waiter.

### Baseline đỏ

Năm regression mới ban đầu cho `4 failed, 1 passed` đúng các khoảng trống:

- job thứ hai chạy chồng thay vì chờ;
- chưa có `HeavyJobMemoryUnavailable`;
- guard không trả peak;
- Real-ESRGAN chưa có session factory/lifecycle teardown.

### Verify sau sửa

| Kiểm tra | Kết quả |
|---|---|
| Regression mới | `5 passed` ở vòng đầu; bổ sung cancel/wiring tiếp tục đạt |
| Upscale + concurrency + scheduler + artifact self-test + consumer scheduler | `78 passed` |
| `py_compile` ba file production | Đạt |
| DirectML General, tiến trình sạch | 3/3 đạt; cold `0,661 s`, warm `0,002 s` |
| DirectML Quality, tiến trình sạch | 3/3 đạt; cold `1,101 s`, warm `0,018–0,020 s` |
| `git diff --check` phạm vi lô | Đạt; chỉ cảnh báo line-ending Windows |

### Bất biến giữ nguyên

- Không hard-cap worker, kích thước hoặc chất lượng trên máy mạnh.
- Không đổi pixel, ICC, DPI, alpha hoặc companion PDF.
- Không đổi Cargo profile/LTO, PDFium locking hoặc hình học khuôn bế.
- Không sửa file/thay đổi song song ngoài phạm vi.

### Runtime còn cần chốt trước Lô B

1. Khởi động lại `run_dev.bat` để backend nạp code mới.
2. Chạy General/Balanced liên tiếp tối thiểu 5–10 lần trên một ảnh thực tế.
3. Chạy hai tab đồng thời với ảnh đủ lớn; job sau phải chờ thay vì làm backend chết.
4. Hủy tab đang chờ RAM; tab phải trở về pending và job trước vẫn hoàn tất.
5. Gửi hai log nếu còn mất cổng 8321:
   `%APPDATA%\PrynX\logs\app.log` và
   `%LOCALAPPDATA%\com.prynx.app\logs\PrynX.log`.

Lô A giảm mạnh hai tác nhân OOM/fallback nhưng chưa đóng `§US.01–02`: DirectML vẫn
nằm trong sidecar và Tauri chưa có supervisor. Hai finding đó thuộc Lô B–C.
