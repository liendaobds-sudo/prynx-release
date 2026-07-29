# Báo cáo audit — Upscale: chế độ Chất lượng treo, chế độ Nhanh bệt

Ngày: 2026-07-28
Phạm vi: `realesrgan_engine.py`, route `/pdf-tools/upscale`, `UpscaleTool.tsx`, `heavy_job_scheduler.py`.
Trạng thái: **chờ duyệt**. Chưa sửa gì.
Tiền đề: đợt audit trước (`BAO_CAO_AUDIT_UPSCALE_2026-07-28.md` + `UPSCALE_FIXES_2026-07-28.md`) đã sửa hard-cap 2.000px, ICC/DPI, checksum model, tile/padding. Hai triệu chứng dưới đây phát sinh **sau** các fix đó.

## Tóm tắt điều hành

Nguyên nhân "xoay cả ngày" **không phải** treo hay deadlock. Đó là chạy thật, nhưng bằng CPU với model nặng gấp 16 lần, không có tiến độ và không có giới hạn thời gian.

Đo trên máy này, một ô 592×592 (tile 512 + pad 40):

| | model Nhanh | model Chất lượng | tỉ lệ |
|---|---:|---:|---:|
| DirectML | 0,19 s | 4,03 s | 21× |
| CPU | 2,48 s | **39,75 s** | 16× |

Suy ra cho chế độ Chất lượng chạy CPU:

| Ảnh | Số ô | Thời gian |
|---|---:|---:|
| ~3 Mpx (2000×1500) | 16 | ~10,6 phút |
| ~12 Mpx (4000×3000) | 64 | **~42,4 phút** |

Chưa tính swap. Ảnh lớn hơn hoặc RAM chật thì lên hàng giờ — khớp mô tả "cả ngày".

Còn "chế độ Nhanh bệt": đo ra thì **ba chế độ UI không cho ba mức chất lượng thật**. Nhanh và Cân bằng dùng **cùng một model**; Chất lượng thì kém nét hơn cả Nhanh trong phép đo của tôi.

## §1 — Chế độ Chất lượng không ra output

### §1.1 [P0] Guard chống chạy RRDBNet trên CPU không hoạt động

`realesrgan_engine.py:_run_session`:

```python
if (variant == "quality" and not _force_cpu_by_env
        and session.get_providers() == ["CPUExecutionProvider"]):
    raise RuntimeError("Chế độ Chất lượng cần GPU DirectML/CUDA tương thích. ...")
```

Ý định đúng, phép kiểm sai. `get_providers()` trả về danh sách provider **đã đăng ký** với session, không phải provider thực thi từng node. Đo được trên máy này:

```
[quality] providers thuc te = ['DmlExecutionProvider', 'CPUExecutionProvider']
```

Danh sách này khác `["CPUExecutionProvider"]` nên guard **không bao giờ bắn**, kể cả khi ONNX Runtime rơi từng node về CPU. Guard chỉ bắt được ca đã đi qua `_switch_to_cpu()` (lúc đó `_cpu_only_variants` mới làm providers thành CPU-only).

Hệ quả: máy không có GPU DX12 dùng được vẫn nhận job Chất lượng, chạy 39,75 s/ô, và người dùng không nhận được thông báo nào.

**Khuyến nghị:** quyết định bằng **đo**, không bằng tên provider — chạy một ô nhỏ lúc warmup, nếu vượt ngưỡng (ví dụ >3 s cho ô 256) thì coi là không có tăng tốc GPU và từ chối chế độ Chất lượng kèm lý do rõ. Effort: S.

### §1.2 [P0] Không có giới hạn thời gian và không có tiến độ

- Route là một POST đồng bộ: `await run_in_threadpool(_process_upscale)` (`pdf_tools.py:1778`), không WS, không job id, không mốc tiến độ.
- `authenticatedFetch` phía desktop không đặt timeout.
- UI chỉ có chuỗi `Đang phóng to i / n`, không có phần trăm theo ô.

Nên một job 42 phút biểu hiện y hệt một job treo. Người dùng không có cách nào phân biệt, và không có gì cho biết còn bao lâu.

**Khuyến nghị:** ước lượng thời gian TRƯỚC khi chạy (số ô × thời gian/ô đã đo lúc warmup) rồi hiện cho người dùng xác nhận; báo tiến độ theo ô; đặt trần thời gian có thể huỷ. Effort: M.

### §1.3 [P1] Một job Chất lượng chiếm slot heavy 42 phút, chặn cả bình bản

`heavy_job_scheduler.py`:

```python
_MAX_ACTIVE_HEAVY_JOBS = max(1, int(os.environ.get("PRYNX_MAX_HEAVY_JOBS", "2") or "2"))
_HEAVY_JOB_SLOTS = threading.BoundedSemaphore(_MAX_ACTIVE_HEAVY_JOBS)
...
_HEAVY_JOB_SLOTS.acquire()      # KHÔNG timeout
```

Route upscale dùng `run_heavy_in_threadpool` → `kind="pdf-tools"`, chung 2 slot với **mọi** tác vụ pdf-tools và cùng semaphore với bình bản. `acquire()` chặn vô hạn.

Hai hệ quả: job upscale dài giữ slot rất lâu làm việc khác xếp hàng; và nếu slot đang bị chiếm, chính request upscale chờ vô hạn — lại ra spinner vô định, lần này đúng nghĩa "không chạy gì cả".

**Khuyến nghị:** cho `heavy_job_slot` một timeout có thông báo rõ khi hết hạn; xem lại việc upscale có nên dùng slot chung với bình bản hay có hàng đợi riêng. Effort: M.

## §2 — Chế độ Nhanh bệt, và ba chế độ không phân biệt được

### §2.1 [P1] Nhanh và Cân bằng dùng CÙNG một model

`realesrgan_engine.upscale`:

```python
preserve_texture = variant == "balanced"
if preserve_texture:
    variant = "general"          # ← Cân bằng = Nhanh + một bước làm nét
```

Khác biệt duy nhất là `_restore_source_texture`: cộng 35% thành phần tần số cao của ảnh nguồn đã LANCZOS lên, lấy bằng hiệu với bản blur bán kính 1,2 px **ở độ phân giải đầu ra**. Ở mức ×4, bán kính 1,2 px chỉ chạm nhiễu resample, không phải chi tiết thật.

Đo trên `desktop/public/images/dieline/auto_bottom.png` (thu 4× rồi phục hồi, ảnh gốc làm chuẩn):

| chế độ | độ nét (var. Laplacian) | PSNR | giây |
|---|---:|---:|---:|
| Lanczos (không AI) | 19,8 | 24,91 | 0,00 |
| **general** (Nhanh) | **285,7** | 26,45 | 0,54 |
| **balanced** (Cân bằng) | 292,5 | 26,34 | 0,17 |
| **quality** (Chất lượng) | 231,3 | 26,83 | 1,89 |
| ảnh gốc (chuẩn) | 738,8 | — | — |

Cân bằng chỉ hơn Nhanh **2%** độ nét. Nói cách khác, chế độ mặc định hiện tại (`useUpscaleStore.ts`: `model: 'balanced'`) gần như trùng chế độ Nhanh — người dùng đổi qua lại mà kết quả không khác biệt đáng kể.

### §2.2 [P1] Chế độ Chất lượng kém nét hơn chế độ Nhanh

Cùng bảng trên: 231,3 so với 285,7. Chất lượng chỉ nhích hơn 0,4 dB PSNR nhưng tốn **16×** thời gian CPU. Với người dùng, "chất lượng cao" cho ảnh mềm hơn là phản trực giác — và đây là lý do đáng cân nhắc việc có nên giữ RRDBNet làm chế độ cao cấp hay không.

### §2.3 [P2] Thiếu điều khiển cường độ khử nhiễu — gốc của cảm giác "bệt"

`realesr-general-x4v3` của upstream được thiết kế đi kèm biến thể `realesr-general-wdn-x4v3`, hai bản trộn theo tham số `dni` để điều chỉnh mức khử nhiễu. PrynX chỉ đóng gói bản khử nhiễu mạnh và không có tham số nào, nên texture/hạt bị làm phẳng mà người dùng không có cách tiết chế.

**Khuyến nghị:** bổ sung bản `wdn` và một thanh trượt khử nhiễu; đây là đường ngắn nhất để chữa đúng cái người dùng gọi là "bệt". Effort: M.

## §3 — Giới hạn kiểm chứng

Phép đo độ nét chạy trên **ảnh line-art khuôn bế**, không đại diện cho ảnh chụp/bao bì mà khách gửi. Kết luận vững chắc từ nó chỉ gồm: ba chế độ không tách biệt, và Chất lượng không nét hơn Nhanh. Nhận định về "bệt" trên ảnh chụp vẫn cần corpus thật.

Tôi cũng **chưa** kiểm được máy của bạn có GPU DirectML hoạt động hay không. Máy tôi đo có. Nếu máy bạn không có, §1.1 chính là nguyên nhân trực tiếp của "cả ngày".

Cần bạn cung cấp để chốt: một ảnh khách mà chế độ Nhanh cho kết quả bệt, và cho biết chế độ Chất lượng trên máy bạn có báo lỗi gì hay chỉ quay mãi.

## Lộ trình đề xuất

### Lô A — Hết treo, có thông tin (P0, khuyến nghị làm ngay)

1. §1.1 — đo tốc độ một ô lúc warmup, từ chối chế độ Chất lượng kèm lý do khi không có tăng tốc GPU thật.
2. §1.2 — ước lượng và hiện thời gian dự kiến trước khi chạy; báo tiến độ theo ô; cho huỷ.
3. §1.3 — `heavy_job_slot` có timeout và thông báo rõ khi hết hạn.

Phạm vi: `realesrgan_engine.py`, `pdf_tools.py`, `heavy_job_scheduler.py`, `UpscaleTool.tsx` — 4 file.

### Lô B — Ba chế độ có nghĩa thật

1. §2.3 — thêm model `wdn` + thanh trượt khử nhiễu.
2. §2.1/§2.2 — dựa trên benchmark, quyết định lại: hoặc bỏ chế độ Cân bằng (vì trùng Nhanh), hoặc đổi Cân bằng thành mức denoise trung gian; xem lại vai trò của RRDBNet.

Cần corpus ảnh thật trước khi làm, nên phụ thuộc §3.

### Lô C — Cổng kiểm thử chất lượng

Corpus có giấy phép rõ (chữ Việt nhỏ, logo, bao bì, tram, JPEG khách gửi, chân dung), baseline PSNR/SSIM và ngưỡng hồi quy cho từng model. Đây là mục UP-05 của báo cáo trước, vẫn chưa có.

## Chốt duyệt

Đề xuất: làm **lô A** ngay. Lô B chờ bạn gửi ảnh mẫu. Lô C là việc dài, nên tách riêng.
