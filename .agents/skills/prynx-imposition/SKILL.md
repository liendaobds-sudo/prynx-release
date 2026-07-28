---
name: prynx-imposition
description: "Quy tắc backend cho bình tem bế, nup, VDP và mọi tác vụ PDF nặng của PrynX: heavy_job_scheduler, hồ sơ phần cứng, khóa PDFium, worker pool. Đọc trước khi sửa backend/app/core hoặc routes imposition/vdp/pdf_tools/compare. Use when working on imposition, sticker die-cut nesting, n-up, VDP, PDF rendering backend, threadpool, worker pools, bình tem bế, bình bản."
---

# Backend bình bản / tác vụ nặng

## Ba tầng điều phối — đừng nhầm tầng

1. **Event loop uvicorn**: route handler phải mỏng. Việc chặn CPU/IO nặng KHÔNG chạy trực tiếp trong `async def` — đẩy xuống threadpool, nếu không toàn bộ API (kể cả progress WS) đứng hình.
2. **`heavy_job_scheduler.py`** (`backend/app/core/`): hàng đợi cho việc RẤT nặng (bình bản, export lớn) — số slot đồng thời giới hạn (mặc định 2, override env `PRYNX_MAX_HEAVY_JOBS`). Chỉ đưa vào đây việc thật sự nặng; việc trung bình (preview khuôn bế…) dùng `starlette run_in_threadpool` thường — chiếm heavy slot sẽ làm job nặng của user xếp hàng oan (đã từng gây chậm preview).
3. **Worker pool trong engine** (per-job): số worker theo hồ sơ phần cứng — env override `STICKER_MAX_WORKERS`, `PRYNX_NUP_WORKERS`.

## Hồ sơ phần cứng — nguyên tắc vàng

`StickerEngine.get_sticker_hw_profile()` / `_total_ram_mb()` đo RAM + CPU. **Chỉ giảm trên máy yếu; máy mạnh chạy full** (nguyên tắc của chủ dự án):

```python
if 0 < ram_mb < 8*1024:   workers = min(cores, 2)
elif ram_mb < 16*1024:    workers = min(cores, 4)
else:                     # ≥16GB: giữ nguyên (cores-1/full) — KHÔNG cap
```

Đừng áp hồ sơ của StickerEngine lên pool KHÁC một cách máy móc — từng gây bình tem chậm 2× trên máy mạnh vì cap nhầm nup/vdp. Mỗi pool tự quyết theo bảng RAM trên.

## PDFium — không thread-safe

- Mọi lời gọi chạm PDFium (native qua PyO3 lẫn pypdfium2) phải giữ **`PDFIUM_PY_LOCK`** trong `backend/app/core/rust_bridge.py`. Quên khóa = crash ngẫu nhiên khó tái hiện dưới tải.
- `pdf_processor` và `rust_bridge` là CẶP: đổi chữ ký/hành vi bên này phải sửa bên kia cùng commit.
- Cần song song thật sự cho render PDF → song song ở tầng job/tài liệu, không phải tầng trang trong cùng một document handle.

## Khi thêm endpoint nặng mới

1. Route mỏng trong `api/routes/` → validate bằng `schemas/` → gọi engine trong `core/`.
2. Chọn tầng điều phối theo mục trên; báo tiến độ qua WS (`ws.py`) nếu chạy >1–2s.
3. Kết quả file ghi vào khu results/uploads hiện có (xem `results.py`, `upload.py`), dọn dẹp qua `cleanup.py` — đừng phát minh chỗ lưu mới.
4. Cache: các engine có cache tài liệu/kết quả (DOC_CACHE phía native, cache backend) — key phải gồm mọi tham số ảnh hưởng kết quả, nếu không sẽ trả kết quả cũ sai âm thầm.
5. Test: pytest `backend/tests/` (có `conftest.py` + bộ `golden/`); thêm case golden khi đổi kết quả render là chủ đích.
