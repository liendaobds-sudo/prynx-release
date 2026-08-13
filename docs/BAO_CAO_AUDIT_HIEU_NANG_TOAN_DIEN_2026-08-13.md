# BÁO CÁO AUDIT HIỆU NĂNG TOÀN DIỆN — PrynX

**Ngày:** 2026-08-13
**Mốc code:** `5629eaf`, branch `codex/pre-release-audit-2026-08-04`, worktree có 3 nhóm thay đổi dở (Lô A Chữ & Font, lô sửa build/release, dò hình bình tem) — các vùng đó KHÔNG bị audit trùng trong báo cáo này.
**Máy đo:** Windows, 32 GB RAM, 16 logical CPU (cùng máy với các audit trước).
**Trạng thái:** Chốt 1 — khảo sát, chấm điểm, đề xuất. **CHƯA SỬA GÌ — chờ duyệt danh sách.**

> Yêu cầu của chủ dự án: "audit đánh giá, chấm điểm, đề xuất cải thiện hiệu năng — muốn PrynX mạnh mẽ hơn nữa". Báo cáo này KHÔNG lặp lại phát hiện đã đóng của các đợt trước (xem mục 2); nó xác minh cây mã hiện tại, đo mới ở những vùng chưa từng đo, và hợp nhất các mục còn mở thành một lộ trình duy nhất.

---

## 1. Kết luận điều hành

PrynX hiện **nhanh và kỷ luật hơn hẳn baseline 05/08** (6,5/10 lúc đó): 11 lô fix §PERF.1–9 đã vào cây mã và còn nguyên; hạ tầng RAM-gating (`plan_worker_count`, heavy scheduler, memory reservation, disk guard, tile cache theo byte) đúng chính sách "máy yếu mới giảm, máy mạnh lút cán"; các route nặng đã offload khỏi event loop; PPE có Rayon cho kernel stateless.

Tuy nhiên còn **4 vùng chưa dùng hết sức máy hoặc phí tài nguyên**, có bằng chứng đo mới trong đợt này:

1. **So sánh PDF — tính năng gốc của sản phẩm — chỉ dùng 1/16 lõi.** Đo tách giai đoạn: 66,1% thời gian là so ảnh OpenCV (không cần khóa PDFium) + 4,8% ghi kết quả, tất cả chạy tuần tự sau render. Máy mạnh bỏ phí ~70% headroom.
2. **Entry bundle chứa ~60% là dữ liệu ngôn ngữ**, trong đó locale EN (~310 KB min) tải cứng dù người dùng Việt không bao giờ dùng.
3. **Sidecar import toàn bộ engine nặng lúc boot** (~1,3 s import ở dev venv; cv2 + numpy + pdfplumber + pypdf + httpx đều nạp trước khi `/health` trả lời) — kéo dài đúng khoảng "chờ startup proof" đang chặn hiện cửa sổ chính.
4. **Trần 50 trang của so sánh là cap vô điều kiện** — chặn tài liệu dài trên cả máy 32–64 GB, trong khi guard pixel per-page mới là thứ thật sự bảo vệ RAM.

Ngoài ra: pipeline build/release chậm (71 phút) và Nuitka cap 4 job đã được audit riêng hôm nay (`BAO_CAO_AUDIT_BUILD_RELEASE_TOC_DO_ON_DINH_2026-08-13.md` §BR.01–12) và đang sửa — báo cáo này chỉ trỏ tới, không lặp.

### Bảng chấm điểm hiện tại

Thang 10. Cột "05/08" là baseline lịch sử để thấy tiến bộ; cột "Trần nếu sửa" là mức đạt được nếu hoàn tất lộ trình mục 7.

| Tiêu chí | 05/08 | **13/08** | Trần nếu sửa | Căn cứ chính |
|---|---:|---:|---:|---|
| Bình bản / tem bế trên máy mạnh | 8,0 | **8,5** | 9 | NFP Rust, 13 loại tem 17,4×–2,2×, PPE Rayon 8,6×/3,1×/2,2×; còn stage tuần tự trong engine |
| Độ phản hồi UI khi job nặng | 6,0 | **8,5** | 9 | Sticker/inspect/fix/Output Preview đã offload + worker; minimize pause; Lô A Chữ & Font vừa đóng nốt `/preflight/inspect` |
| RAM / thân thiện máy yếu | 5,0 | **7,5** | 8,5 | VDP + N-Up + Sticker + Preflight + heavy slot + tile cache + warmup đều gate RAM; **chưa có benchmark máy vật lý 8/16 GB** |
| Khởi động (warm/cold release) | 6,0 | **6,5** | 8 | Native splash + warmup theo tier đã có; median warm ~5,1–5,4 s, cold 7,4 s; import diet sidecar chưa khai thác (§P25.4) |
| Dung lượng cài / cache / disk | 4,0 | **6,5** | 7,5 | Prune sidecar giữ current+previous; tile disk quota + reserve; high-watermark uploads/results; installer vẫn ~461–486 MB |
| So sánh PDF (đo mới đợt này) | — | **5,5** | 8,5 | 1 lõi / 16; 71% thời gian ngoài khóa PDFium vẫn tuần tự; cap 50 trang vô điều kiện (§P25.1–2) |
| Tải lần đầu frontend / bundle | — | **6,5** | 8 | Entry 1.058 KB đạt budget nhưng ~60% là locale JSON; EN chết nằm trong entry (§P25.3) |
| Build / release pipeline | — | **4,0** | 7,5 | 71 phút full build, không resume; NuitkaJobs cap 4 — ĐÃ audit riêng, đang sửa theo §BR |
| Đo lường / P95 hiện hành | 5,0 | **6,0** | 8 | `PRYNX_PERF` opt-in + pixel gate viewer; chưa có P50/P95 định kỳ, chưa có stage telemetry build (§BR.12 đang xử lý) |
| **Tổng thể (desktop runtime)** | 6,5 | **7,5–8** | **8,5–9** | Kéo xuống chủ yếu bởi So sánh PDF, khởi động, và nợ nghiệm thu máy yếu vật lý |

---

## 2. Phạm vi, phương pháp và những gì KHÔNG audit lại

### Đã đọc trước khi phán (tránh phát hiện trùng / sửa thứ chủ đích)

- `BAO_CAO_AUDIT_HIEU_NANG_VA_THAN_THIEN_PHAN_CUNG_2026-08-05.md` + `PERF_FIXES_2026-08-05.md` (Lô 1–11, §PERF.1–9 — **xác minh còn nguyên trong cây mã**, xem mục 4).
- `PRYNX_MASTER_AUDIT_MATRIX.md` (trạng thái W1–W8, đặc biệt W7).
- `BAO_CAO_AUDIT_BUILD_RELEASE_TOC_DO_ON_DINH_2026-08-13.md` (§BR.01–12) và `BAO_CAO_AUDIT_CHU_FONT_HIEU_NANG_UIUX_2026-08-13.md` (§FONT.*) — hai audit cùng ngày, đang sửa; **không audit trùng**.
- `prynx-performance` skill: bảng RAM-gating chuẩn, danh sách false-positive (§3.14, §3.16), quy tắc Cargo LTO.

### Không đưa vào phạm vi

- Vùng đang sửa dở trong worktree: `FontToolsTool`, `preflight.py`/`preflight_engine.py` (Lô A đã verify), `quanly_phathanh.ps1`/`release_update.ps1`/`scripts/release_controller.ps1` (lô build), `ImposerDashboard`/`shapeDetectionPolicy`/`die_detection.py` (phiên dò hình đang chạy).
- Không chạy full build, không build installer, không đo máy vật lý 8/16 GB (chưa có máy).

### Bằng chứng mới tạo trong đợt này

| Phép đo | Công cụ | Kết quả thô |
|---|---|---|
| Tách giai đoạn 1 job so sánh (20 trang A4, 150 DPI, 16 CPU) | `tmp/bench_compare_stages.py` (dùng đúng `PDFProcessor`/`ImageComparator` production) | render 0,975 s (28,2%) · compare 2,284 s (66,1%) · save 0,167 s (4,8%) · tổng 3,454 s · 172,7 ms/trang |
| Thời gian import sidecar | `python -X importtime -c "from app.main import app"` trên `backend/venv` | tổng 1.295,6 ms; chi tiết mục 5 |
| Thành phần entry bundle | kiểm tra `dist/assets/index-*.js` chứa chuỗi cả VI lẫn EN; minify thử vi.json | entry 1.058 KB; vi.json min ≈ 334 KB; en.json ≈ 344 KB raw |

---

## 3. Ma trận cấu hình máy (cập nhật 13/08)

| Cấu hình | Trạng thái policy hiện tại | Đánh giá | Ghi chú |
|---|---|---:|---|
| **< 8 GB** | N-Up/Sticker/Preflight/VDP 1 worker; heavy slot 1; tile RAM 64 MiB; tile disk theo ổ; warmup chỉ PDFium; PPE budget 256–640 MiB | **5,5/10** | Policy đầy đủ ở mức code/test (`AUTO`); **chưa có runtime máy thật** |
| **8–15 GB** | worker ≤2; heavy slot 2; tile RAM 128 MiB; warmup PDFium + 1 chunk | **6,5/10** | Như trên — nợ nghiệm thu vật lý |
| **16 GB** | full worker (CPU-1); heavy slot 3; đọc `GetPhysicallyInstalledSystemMemory` nên không rớt nhầm tier | **7,5/10** | Perf cliff 2→CPU-1 đúng ngưỡng vẫn tồn tại (đã biết, chấp nhận) |
| **32 GB / 16 luồng** | full; không cap tile/preview | **8/10** | Máy audit. Bỏ phí lớn nhất còn lại: So sánh PDF 1 lõi, Nuitka 4 job khi build |
| **≥ 64 GB** | heavy slot 4; full toàn bộ | **8/10** | PPE stage tuần tự + compare 1 lõi vẫn không dùng hết máy |

---

## 4. Những gì đang tốt — xác minh trên cây mã hiện tại, KHÔNG được làm yếu đi

1. **[CONFIRMED] Hạ tầng admission 3 lớp đúng thiết kế** — `heavy_job_scheduler.py`: slot toàn cục theo RAM (1/2/3/4), kind-gate whole-machine (`nup|vdp|compare` chia 1 suất), serial `office`, memory reservation theo byte (`§US.04`), thứ tự khóa cố định chống deadlock, async admission không giữ token AnyIO.
2. **[CONFIRMED] `plan_worker_count` là một nguồn chân lý duy nhất** — `system_memory.py:53-130`: <8 GB→1, <16 GB→2, ≥16 GB→CPU-1 không hạ; trần RAM khả dụng chỉ áp máy yếu; env override thắng. VDP đã dùng đúng planner này (`vdp_engine.py:1070-1074` + `PRYNX_VDP_WORKERS`).
3. **[CONFIRMED] Không còn route nặng chặn event loop trong các đường đã sửa** — sticker (`run_scheduled_in_threadpool`), preflight inspect/inspect-upload (`run_in_threadpool`, Lô A 13/08), mọi action của `ActionEngine` đi `asyncio.to_thread` với cancel/staging/atomic publish.
4. **[CONFIRMED] Khóa PDFium theo từng lời gọi, không theo lượt** — `pdf_processor.py` giữ `pdfium_guard` quanh đúng render/open/close từng trang (audit 2026-07-29 §C.1), phần so ảnh nằm ngoài khóa.
5. **[CONFIRMED] QC route đã lazy-import cv2/OCR** (`qc.py:9-11,78-81`) — mẫu tốt cần nhân rộng (xem §P25.4).
6. **[CONFIRMED] Cargo sạch** — không có `[profile.release]` trong bất kỳ `Cargo.toml` nào; Rayon 1.12 có mặt ở `native` + `print_engine` cho kernel lớn (ngưỡng 512K pixel, không cap máy mạnh).
7. **[CONFIRMED] Frontend đã có kỷ luật**: bundle budget plugin fail build khi entry >1,5 MB; warmup theo tier RAM đọc `installedBytes`; tile URL cache theo byte; Output Preview chạy Web Worker + OffscreenCanvas; polling N-Up ngủ khi app nền.
8. **[EXPECTED — không đụng]** dieline executor `max_workers=1` (warm Boa context), ink bridge `max_workers=1` (bridge, không phải pool), trần compare đồng thời =1 (đã có lý do đo đạc), các bản copy overlay spotlight GIF (§3.16), WebView2 occlusion flags.

---

## 5. Phát hiện mới — có bằng chứng, chờ duyệt

### §P25.1 — [CONFIRMED] P1 / M — Job so sánh PDF chỉ dùng 1 lõi; 71% thời gian nằm NGOÀI khóa PDFium nhưng vẫn tuần tự

**Đường chạy live:** `POST /jobs/compare` → `run_comparison_sync` (`compare.py:72-100`, kind `compare`) → `run_comparison_pipeline` (`comparison_engine.py:306-510`) — một vòng `for` duy nhất: render A → render B → `comparator.compare` → encode/ghi PNG+GIF → `db.commit()` cho **từng trang một**.

**Bằng chứng đo (mới):** 20 trang A4 tổng hợp @150 DPI trên máy 16 luồng:

```text
render  : 0,975 s (28,2%)  <- giữ pdfium_guard, tuần tự trong 1 process
compare : 2,284 s (66,1%)  <- OpenCV/NumPy, KHÔNG cần khóa PDFium
save    : 0,167 s ( 4,8%)  <- encode PNG + ghi đĩa, KHÔNG cần khóa
tổng    : 3,454 s (172,7 ms/trang)
```

Comment trong chính engine xác nhận đặc tính: "đo thực tế trang ảnh 1500px @150dpi … ~0,5 s/trang" (`comparison_engine.py:224-228`) — file khách nặng hơn mẫu tổng hợp, tức phần compare còn chiếm tỷ trọng lớn hơn.

**Vi phạm:** máy mạnh không được chạy hết công suất trên chính tính năng đặt tên cho repo (pdfcompare). Trần 1 job đồng thời là ĐÚNG (giữ); nhưng **bên trong** một job, so ảnh từng trang là các tác vụ độc lập hoàn toàn.

**Đề xuất (giữ mọi bất biến hiện có):**
- Pipeline theo trang: render tuần tự như cũ (tôn trọng khóa), đẩy `(img_a, img_b)` vào pool so-ảnh+ghi-file gate bằng `plan_worker_count(kind="compare", ...)`; DB commit vẫn từ một thread duy nhất, tiến độ vẫn monotonic theo trang.
- Không đổi thuật toán so sánh, không đổi format kết quả, không nới trần job đồng thời.
- Kỳ vọng trên máy 16 luồng: thời gian job tiệm cận `max(render_tổng, compare_tổng/(CPU-1)) + save` ≈ **2,5–3× nhanh hơn** cho tài liệu compare-dominated; máy <8 GB giữ 1 worker (không đổi hành vi).
- Nhánh `document_imposition`/căn trang giữ nguyên tuần tự nếu cần con trỏ `current_b_idx` (chỉ song song nhánh đã có cặp trang xác định trước); đây là chi tiết thiết kế của lô sửa.

### §P25.2 — [CONFIRMED] P2 / S — Trần 50 trang của so sánh là cap vô điều kiện, không gate theo RAM

**Bằng chứng:** `compare.py:136-141` — `MAX_PAGES = 50` từ chối thẳng với thông báo "Vui lòng nâng cấp phần cứng và chia nhỏ file PDF", nhưng trần không hề đọc phần cứng. Trong khi đó chính engine ghi rõ RAM **không** tích lũy theo số trang (giải phóng mỗi vòng, `comparison_engine.py:224-228`) và guard thật sự cho RAM là `_MAX_COMPARE_PAGE_PIXELS` per-page (`compare.py:42-45`, đã có sẵn).

**Tác động:** người dùng máy 32–64 GB không thể so catalogue/sách 60–500 trang dù máy thừa sức (chỉ tốn thời gian, không tốn RAM tích lũy); thông báo lỗi đổ cho phần cứng gây hiểu sai.

**Đề xuất:** gate theo bảng RAM chuẩn (ví dụ <8 GB: 50; 8–<16 GB: 150; ≥16 GB: 1.000 hoặc bỏ trần, env `PRYNX_MAX_COMPARE_PAGES` override) — số cụ thể chốt sau khi đo §P25.1; giữ nguyên pixel guard per-page. Làm CÙNG lô hoặc SAU §P25.1 để trần mới đi kèm tốc độ mới.

### §P25.3 — [CONFIRMED] P1 / S — Entry bundle gánh ~60% locale JSON; bản EN nằm chết trong đường tải lần đầu

**Bằng chứng:** `i18n/index.ts:4-5` import tĩnh cả `vi.json` (373 KB, min ≈ 334 KB) lẫn `en.json` (344 KB); kiểm tra `dist/assets/index-XwT5Gz0K.js` (1.058 KB) chứa đồng thời chuỗi khóa VI và chuỗi dịch EN. Ứng dụng mặc định `lng: 'vi'`, người dùng chính là nhà in Việt Nam.

**Tác động:** mỗi lần cold load WebView phải parse thêm ~310 KB JS không bao giờ dùng (trên máy văn phòng, parse + evaluate cỡ này là hàng chục ms; còn chiếm RAM heap thường trú). Entry hiện sát 70% budget 1,5 MB — locale là khoản lớn nhất, không phải code.

**Đề xuất:** chuyển `en.json` sang `import()` động khi (a) người dùng đổi ngôn ngữ, hoặc (b) boot với preference EN đã lưu; nạp bằng `i18n.addResourceBundle`. Lưu ý ràng buộc: reverse-map `tv()` build từ `vi.json` (giữ nguyên); phần đối chiếu divergence chỉ chạy DEV — cho phép nạp EN lười trong DEV. Kỳ vọng: entry giảm ~300–330 KB raw (~30%), thời gian parse lần đầu giảm tương ứng; người dùng EN chịu một lần fetch chunk nhỏ khi đổi ngôn ngữ.

### §P25.4 — [CONFIRMED] P2 / M — Sidecar nạp toàn bộ engine nặng lúc boot; upload route kéo cv2/numpy/pdfplumber/pypdf, QC kéo httpx dù không dùng

**Bằng chứng đo (mới):** `python -X importtime` trên `from app.main import app` (dev venv): tổng **1.295,6 ms**, trong đó phần "của PrynX" (ngoài FastAPI/SQLAlchemy):

| Chuỗi import | cum_ms | Vì sao nạp lúc boot |
|---|---:|---|
| `app.api.routes.upload` → `app.core.pdf_processor` | 247,9 (riêng pdf_processor 181,8: cv2 56,1 + numpy 54,6 + pypdf 61,1 + pdfplumber 49,2) | `upload.py:19,28` import + khởi tạo `PDFProcessor()` ở module level |
| `app.api.routes.sticker_sheet` | 124,0 | schema + session import sớm |
| `app.api.routes.vdp` → `vdp_engine` | 99,2 (engine 67,2, reportlab.platypus 28,6) | engine import ở module level |
| `app.api.routes.qc` → `app.core.llm_checker` → `httpx` | 78,7 (httpx 75,0) | `qc.py:5` import cứng, dù LLM là tính năng cloud tùy chọn và cv2/OCR NGAY TRONG FILE ĐÓ đã lazy đúng mẫu |

**Vì sao quan trọng:** "chờ startup proof" (spawn sidecar → `/health` trả lời) là thành phần lớn nhất của khởi động release (5,543 s trong lần đo 05/08; median warm hiện 5,1–5,4 s) và **chặn hiện cửa sổ chính**. Mọi ms import module đều nằm trước `/health`. Trên bản Nuitka, import không nhanh hơn tự động: cv2/numpy là DLL thật phải load + qua antivirus scan.

**Đề xuất:** "import diet" cho các route: (1) `upload.py` chuyển `PDFProcessor` sang lazy (khởi tạo trong hàm, giống mẫu `qc.py` đã làm với cv2); (2) `qc.py` chuyển `LLMChecker` vào trong handler; (3) rà `sticker_sheet`/`vdp`/`edit` cho import engine trì hoãn được. Nghiệm thu: importtime trước/sau (mục tiêu −400–600 ms dev, đo lại startup proof thật trên release), py_compile + test hiện hữu, và grep bảo đảm không route nào mất tính năng.

### §P25.5 — Ghi nhận hợp nhất (không lặp — đã có chủ quản)

| Mục | Nơi quản | Trạng thái |
|---|---|---|
| Nuitka hard-cap 4 job trên máy 32 GB/16 CPU | `§BR.04` audit build 13/08 | Chờ duyệt Lô D của audit đó |
| QA nguyên khối, không resume, UI bắn-và-quên, venv mutable, exit-in-library | `§BR.01–03, 05, 07, 10` | Đang sửa (worktree có `release_controller.ps1`) |
| Chữ & Font Lô B–D: gộp unique font, handoff path (bỏ vòng backend→WebView→backend), API batch/session native | `§FONT.UI.1, §FONT.PERF.5–6` | Lô A xong; B–D chờ duyệt |
| Preflight `hard_ceiling=8` trên máy mạnh | Audit 05/08 mục 6 | Giữ `[SUSPECTED]` — chỉ đổi sau benchmark full 16-rule |
| Pixel gate lăn/zoom/pan/xoay + P50/P95 + installed smoke (`§RENDER.11`) | Master matrix W7-U04 | Nợ nghiệm thu sau native rebuild |
| Benchmark máy vật lý 8/16 GB cho mọi policy tier thấp | Audit 05/08 mục 8 | Nợ nghiệm thu — cần máy thật |
| `SPLASH_MIN_MS=3000` | Audit 05/08 §PERF.5 | P3 — đã xác minh chồng lấp thời gian chờ sidecar trong release, chỉ đáng chỉnh nếu warm start xuống <3 s sau §P25.4 |

---

## 6. Nghi vấn đã triage — KHÔNG phải bug, không được "tối ưu"

1. **[EXPECTED] Trần compare đồng thời = 1** (`compare.py:26-30`): so sánh render qua PDFium serialize bằng khóa; job thứ hai chỉ thêm tranh chấp. §P25.1 tăng tốc BÊN TRONG job, không nới trần này.
2. **[EXPECTED] `_poll_db_progress` 1,5 s/lần** (`ws.py:109`): một connection cho mỗi job đang chạy, tải không đáng kể; đổi sang push chỉ đáng làm nếu có bằng chứng nghẽn.
3. **[DISPROVED] Nesting engine TS chậm:** kiểm tra cấu trúc `nestingEngine.ts` — vòng lặp theo số khuôn trên tờ (hàng chục phần tử), có profile/collision đã test 30/30; không có bằng chứng chậm ở quy mô thật. Không đưa vào lộ trình.
4. **[EXPECTED] `fastapi.openapi.models` 86 ms lúc import:** nội bộ FastAPI, nạp cả khi docs tắt — không sửa được ở tầng PrynX, không tính vào §P25.4.
5. **[EXPECTED] ImageComparator dùng NumPy/OpenCV vector hóa** — không có vòng per-pixel Python; phần chậm là bản chất thuật toán, xử lý bằng song song hóa (§P25.1) chứ không phải viết lại.

---

## 7. Lộ trình sửa đề xuất — chờ duyệt, mỗi lô ≤5 file

Thứ tự xếp theo (tác động × độ an toàn). Mỗi lô verify xong mới sang lô kế, có benchmark trước/sau trên cả máy mạnh (không được chậm đi) lẫn giả lập máy yếu (env cap).

### Lô P-A — So sánh PDF đa lõi (§P25.1) — ưu tiên cao nhất
1. `backend/app/core/comparison_engine.py` — pipeline render tuần tự → pool compare+save gate bằng `plan_worker_count(kind="compare")`.
2. `backend/tests/` test mới: parity kết quả (bit-exact PageResult/summary trên corpus cố định), tiến độ monotonic, cancel giữa chừng, máy yếu 1 worker.

Gate: `tmp/bench_compare_stages.py` chạy lại đạt ≥2× trên máy 16 luồng; output DB/PNG/GIF parity; không đổi trần job = 1.

### Lô P-B — Trần trang so sánh theo RAM (§P25.2)
1. `backend/app/api/routes/compare.py` — bảng trần theo RAM + env override, thông báo tiếng Việt mới nêu đúng lý do.
2. Test policy 3 tier + override.

### Lô P-C — Locale EN lazy (§P25.3)
1. `desktop/src/i18n/index.ts` — dynamic import EN + `addResourceBundle`; DEV giữ divergence check bằng nạp lười.
2. Điểm đổi ngôn ngữ (Settings) chờ nạp xong mới `changeLanguage`.
3. Test: đổi VI↔EN vẫn đủ chuỗi; boot với preference EN nạp đúng; entry bundle giảm (kiểm bằng build + budget plugin).

### Lô P-D — Import diet sidecar (§P25.4)
1. `backend/app/api/routes/upload.py` — lazy `PDFProcessor`.
2. `backend/app/api/routes/qc.py` — lazy `LLMChecker`.
3. (đo lại rồi mới quyết) `sticker_sheet`/`vdp` nếu còn ngon ăn trong cùng giới hạn lô.
4. Test import-hygiene: assert các module cv2/httpx không nằm trong `sys.modules` sau `import app.main`.

Gate: importtime giảm ≥30% phần app-owned; toàn bộ test route liên quan xanh; startup proof đo lại trên bản release kế tiếp.

### Sau P-A→P-D (không thuộc đợt này, đã có chủ quản)
- Lô D audit build (§BR.04 Nuitka jobs theo RAM) + stage telemetry → đo lại full build.
- Chữ & Font Lô B–D theo báo cáo 13/08.
- Nghiệm thu nợ: pixel gate W7-U04 sau native rebuild, installed smoke, benchmark máy vật lý 8/16 GB.

---

## 8. Điều kiện nghiệm thu tổng cho đợt sửa

1. Máy 32 GB/16 luồng: so sánh 20 trang 150 DPI nhanh ≥2× so với số baseline mục 2; không job nào chậm đi ở bất kỳ tính năng nào khác.
2. Giả lập máy yếu (`PRYNX_MAX_COMPARE_JOBS`, env RAM test hooks): worker compare = 1, hành vi như trước lô.
3. Entry bundle giảm ≥250 KB raw; đổi ngôn ngữ VI↔EN không thiếu chuỗi (test catalog hiện hữu + test mới).
4. Import sidecar (dev venv) giảm ≥400 ms; sau bản release kế tiếp, đo lại `startup proof` trong `startup_debug.log` để xác nhận chuyển hóa thành thời gian thật.
5. Không golden/snapshot nào bị cập nhật; không đổi format output; không thêm cap vô điều kiện mới (soi bằng scanner `RESOURCE_CAP_WITHOUT_RAM_SIGNAL`).
6. Cập nhật `PRYNX_MASTER_AUDIT_MATRIX.md` (W7 + mục compare) và viết `docs/HIEU_NANG_TOAN_DIEN_FIXES_2026-08-13.md` theo từng lô.

---

**Chốt duyệt đề nghị:** duyệt **Lô P-A → P-B → P-C → P-D** theo thứ tự. P-A đem lại tăng tốc lớn nhất cho một tính năng lõi với blast radius nhỏ (một file engine + test); P-C/P-D là quick-win khởi động/tải lần đầu áp dụng cho MỌI người dùng mỗi lần mở app.
