# BÁO CÁO AUDIT HIỆU NĂNG VÀ MỨC ĐỘ THÂN THIỆN PHẦN CỨNG — PrynX

**Ngày:** 05/08/2026
**Trạng thái:** ĐÃ DUYỆT VÀ SỬA THEO LÔ — xem `PERF_FIXES_2026-08-05.md`
**Mốc code:** `51c2397`, branch `codex/pre-release-audit-2026-08-04`, worktree đang có thay đổi chưa commit của người dùng
**Máy đo hiện tại:** Windows, 32 GB RAM, 16 logical CPU
**Phạm vi:** cold/warm launch; sidecar; bundle frontend; UI/multi-tab; viewer/cache; bình bản, tem bế, VDP, Preflight, PPE; worker/process; RAM/disk; hành vi khi chạy nền; bản release hiện có.

> Báo cáo này đánh giá độ nhanh, nhẹ và ổn định theo bằng chứng hiện có. Không dùng build/test xanh để thay cho benchmark sản phẩm. Mọi con số runtime đều ghi rõ máy và phạm vi; chưa có máy vật lý 4/8/16 GB nên các tier đó chỉ được nâng tới mức `TRACED/AUTO`, không gọi là runtime.

> **Cập nhật 06/08/2026:** 9/9 finding §PERF.1–§PERF.9 đã được xử lý trong
> worktree và verify theo từng lô. Các bảng điểm 6,5/10 bên dưới là baseline lịch
> sử tại thời điểm audit; mức re-audit sau sửa là khoảng **8,5/10**. Chưa nâng cao
> hơn vì còn thiếu benchmark vật lý đủ ba tier 8/16/32 GB và artifact phát hành đã
> đóng gói lại sidecar PPE mới.

---

## 1. Kết luận điều hành

PrynX có nền hiệu năng tốt hơn nhiều so với các audit tháng 7: đường file local tránh copy qua WebView; N-Up/Sticker đã có RAM-gating; job nặng có scheduler; viewer có cache và chủ động đóng document; Combine chuyển backend theo RAM; Rust release có LTO/x86-64-v2; bình 13 loại tem đã được tăng tốc 17,44×–2,21× mà giữ parity.

Tuy nhiên, kết luận hiện tại là:

> **Khá nhanh trên máy mạnh, dùng được trên máy 8–16 GB với tác vụ vừa; chưa “nhẹ” và chưa thân thiện đồng đều với mọi cấu hình.**

Không có finding P0 mới trong phạm vi hiệu năng. Có **6 finding P1** ảnh hưởng trực tiếp tới cảm giác nhanh/nhẹ và **3 finding P2** cần xử lý sau:

1. `/pdf-tools/sticker-dieline` vẫn chạy engine đồng bộ ngay trong `async def`, chặn event loop backend.
2. VDP vẫn lấy `cpu_count - 1` process mà không RAM-gate; máy 4–8 GB/16 luồng vẫn có thể mở 15 process.
3. Log preview đang bật mặc định; một mốc frontend ghi ra Desktop rồi gửi thêm HTTP beacon, backend lại append hai file.
4. Nuitka cache theo từng version nhưng không prune: máy đo đang giữ ba cache sidecar, tổng thư mục `%LOCALAPPDATA%\PrynX` là 3.292,99 MB.
5. Cold launch release hiện mất median khoảng 4,4 giây từ `release setup begin` tới `app ready` trên máy 32 GB; lượt gần nhất 6,672 giây.
6. Output Preview/TAC giải nén, chạy vòng per-pixel và encode PNG trên main thread.

Điểm đánh giá kỹ thuật hiện tại:

| Tiêu chí | Điểm | Kết luận ngắn |
|---|---:|---|
| Bình bản/tem bế trên máy mạnh | **8/10** | Tận dụng CPU tốt, nhiều fast-path và parity test; vẫn còn stage tuần tự. |
| Độ phản hồi UI khi job nặng | **6/10** | Scheduler/offload khá tốt, nhưng Sticker Dieline vẫn khóa event loop và Output Preview còn chạy main thread. |
| RAM trên máy yếu | **5/10** | N-Up/Sticker/Combine có gate; VDP, tile cache và một số buffer chưa theo RAM. |
| Khởi động | **6/10** | An toàn và có cache, nhưng release hiện vẫn khoảng 4–7 giây trên máy mạnh. |
| Dung lượng cài/cache | **4/10** | Installer 461 MB, footprint cài khoảng 613 MB; cache sidecar nhiều version làm máy đo lên 3,29 GB. |
| Đo lường/P95 hiện hành | **5/10** | Có instrumentation, nhưng frontend release tắt mark còn preview audit log lại bật mặc định. |
| **Tổng thể** | **6,5/10** | **Khá nhanh, chưa nhẹ và chưa đều giữa các cấu hình.** |

---

## 2. Ma trận cấu hình máy

Các mức dưới đây là đánh giá sản phẩm theo code, test RAM-gating và số đo máy 32 GB. Điểm cho máy chưa có runtime vật lý được ghi bảo thủ.

| Cấu hình | Worker mặc định chính | Đánh giá | Khuyến nghị sử dụng |
|---|---|---:|---|
| **<8 GB RAM** | N-Up 1; Sticker 1; Preflight 1; heavy slot 1; **VDP có thể vẫn 15** | **3,5/10** | Không khuyến nghị cho VDP lớn, TAC/tách kẽm hoặc nhiều tab. PDF nhỏ/tác vụ nhẹ có thể dùng. |
| **8–15 GB RAM** | N-Up/Sticker tối đa 2; Preflight 2; heavy slot 2 | **5,5/10** | Khá an toàn cho file vừa. Job nặng chậm có chủ đích để tránh swap; VDP vẫn là lỗ hổng. |
| **16 GB RAM** | N-Up/Sticker nhảy lên `CPU-1`; heavy slot 3 | **6,5/10** | Dùng tốt phần lớn nghiệp vụ, nhưng đúng ngưỡng 16 GB có “performance cliff” 2 → CPU-1 worker và không nhìn RAM khả dụng. |
| **32 GB / 16 luồng / SSD** | N-Up/Sticker 15; heavy slot 3 | **7,5/10** | Cấu hình phù hợp nhất hiện tại. Máy audit thuộc tier này. |
| **≥64 GB / nhiều nhân** | CPU-1; heavy slot 4 | **8/10** | Bình bản tốt; PPE đơn luồng và main-thread Output Preview vẫn không dùng hết máy. |

### 2.1 Kết quả giả lập policy trên CPU 16 luồng

| RAM | N-Up | Sticker | Preflight | Ghi chú |
|---:|---:|---:|---:|---|
| 4 GB | 1 | 1 | 1 | Có bảo vệ máy yếu. |
| 8 GB | 2 | 2 | 2 | Ranh `<8 GB`; đúng 8 GB vào tier giữa. |
| 12 GB | 2 | 2 | 2 | Có bảo vệ. |
| 16/32/64 GB | 15 | 15 | 8 | Preflight còn hard ceiling 8; cần benchmark trước khi gọi là lỗi. |

`backend/tests/test_worker_ram_gating.py` và `test_heavy_scheduler_kind_gate.py` chặn hồi quy N-Up/Sticker/scheduler, nhưng chưa kiểm đường VDP thật.

---

## 3. Bằng chứng runtime/build hiện tại

### 3.1 Khởi động release trên máy 32 GB

Nguồn: `%APPDATA%\PrynX\logs\startup_debug.log`.

- 16 lượt release hoàn tất có đủ cặp `release setup: begin → setup complete`.
- Toàn bộ lịch sử có số: min 0,351 s, median 1,632 s, max 6,672 s; các build trước dùng payload/cache khác nên không đại diện bản hiện tại.
- Riêng các lượt thành công ngày 04–05/08: **min 3,935 s, median 4,415 s, max 6,672 s**.
- Lượt gần nhất: 14:19:28.584 → 14:19:35.256 = **6,672 s**.

Đây mới là Rust setup tới `app ready`, chưa phải click-to-Home-interactive. `App.tsx:222` còn giữ splash tối thiểu 3.000 ms từ lúc React mount; nó có thể chồng thời gian sidecar vì WebView đang ẩn, nên **không cộng cơ học 4,4 + 3 giây** khi chưa có trace frontend release.

### 3.2 Bundle frontend

`npm run build` hiện tại: PASS, 3.535 module, Vite build 44,61 s.

| Chunk | Raw | Gzip |
|---|---:|---:|
| Entry `index` | 1.058,05 kB | 349,13 kB |
| `ImpositionTab` | 1.110,51 kB | 261,45 kB |
| `LivePageFrame` | 1.115,39 kB | 309,53 kB |
| `DielineTool` | 736,08 kB | 218,86 kB |
| `vendor-pdf` | 927,22 kB | 328,78 kB |
| `vendor-three` | 1.020,18 kB | 277,73 kB |

Entry đạt budget 1,5 MB. Tuy nhiên `scheduleWarmupPdfjs()` import song song `ImpositionTab + AcrobatViewer + LivePageFrame` gần đầu phiên (`pdfWarmup.ts:25-33, 87-108`), không điều chỉnh theo RAM/CPU. Đây là đánh đổi mở file đầu nhanh hơn bằng cách làm cold launch nặng hơn.

### 3.3 Dung lượng thật

- Installer `PrynX_1.0.0-rc.3_x64-setup.exe`: **461,09 MB**.
- Registry `EstimatedSize`: khoảng **613 MB** cho payload cài.
- Sidecar onefile: **393,95 MB**; khi bung cache mỗi version khoảng **923 MB**.
- `%LOCALAPPDATA%\PrynX`: **3.292,99 MB** trên máy đo.
  - `sidecar-1.0.0.1`: 923,02 MB
  - `sidecar-1.0.0.2`: 923,17 MB
  - `sidecar-1.0.0.3`: 923,81 MB
  - `binaries`: 308,72 MB
- Tile cache hiện tại: **3.265 file / 593,26 MB**.
- `PrynX-dev/uploads + results`: **4.279,81 MB** trong khoảng 24 giờ test; đây là môi trường dev/test, không dùng làm footprint khách hàng, nhưng chứng minh cleanup theo tuổi không phải quota theo byte.

### 3.4 Gates đã chạy trong đợt audit

| Gate | Kết quả |
|---|---|
| Contract scanner self-test | PASS — 17 ca |
| Contract scanner current tree | 1.188 file, 0 lỗi đọc, 877 ứng viên; đây là `[SUSPECTED]`, không phải 877 bug |
| Backend RAM/scheduler/perf/temp tests | **37 passed** |
| Frontend Combine RAM-gate + viewer lifecycle | **40 passed** |
| Frontend production build + typecheck | **PASS** |

---

## 4. Những gì đang làm tốt

### 4.1 [CONFIRMED] N-Up/Sticker chỉ giảm máy yếu, máy mạnh dùng CPU-1

- `backend/app/core/system_memory.py:53-130`: `<8 GB → 1`, `<16 GB → 2`, `≥16 GB → CPU-1`, env override thắng.
- `backend/app/workers/nup_engine.py:3470-3488`: N-Up dùng planner chung.
- `backend/app/workers/sticker_engine.py:3411-3467`: Sticker cùng policy; máy 32 GB/16 luồng hiện log `tier=full workers=15`.
- Job nhỏ N-Up chạy nội tuyến thay vì spawn từng tờ (`nup_engine.py:70-79`).

### 4.2 [CONFIRMED] Scheduler ngăn oversubscription giữa các họ job nặng

- Heavy slot theo RAM: 1 / 2 / 3 / 4 (`heavy_job_scheduler.py:17-55`).
- `nup`, `vdp`, `compare` chia đúng một whole-machine slot (`:68-83`).
- Office serial riêng vì COM/LibreOffice có lịch sử treo (`:71-74`).
- Test concurrency/deadlock/exception release đạt.

### 4.3 [CONFIRMED] Combine và viewer có bảo vệ RAM hữu ích

- Combine đọc RAM thật và chuyển native/backend khi buffer ước tính vượt 25% RAM khả dụng; máy yếu có threshold thấp hơn (`combineDelegation.ts:220-239`).
- File PDF local đi bằng path, không bắt WebView giữ bản copy nguồn lớn.
- Viewer native: doc cache 2 entry `<8 GB`, 4 entry `<16 GB`, không hard-cap `≥16 GB`; đóng tab gọi `close_pdf_document`.
- Viewer tab nền hơn 20 giây bỏ cây bitmap `LivePageFrame`, vẫn giữ state làm việc (`AcrobatViewer.tsx:586-602`).

### 4.4 [CONFIRMED] Build Rust production đúng chính sách

- Không có `[profile.release]` trong Cargo.toml.
- `build_production.ps1` bật `thin LTO`, `codegen-units=1`, strip và `x86-64-v2` đối xứng cho maturin + Tauri.

---

## 5. Phát hiện chính

### §PERF.1 — [CONFIRMED] P1 / S — Tạo đường cắt Sticker chặn event loop backend

**Đường chạy live:**

`StickerTool.tsx:433` → `POST /pdf-tools/sticker-dieline` → `pdf_tools.py:1258-1259` → `StickerEngine.process_pdf()` tại `:1455-1482` → PDF kết quả.

Route là `async def`, nhưng cả `_sticker_job_slot` và `engine.process_pdf()` chạy đồng bộ ngay trên event-loop thread. Chỉ bước watermark sau đó mới dùng `run_in_threadpool` (`:1529`). Khi engine chạy vài giây/phút, health, status, preview và request khác cùng sidecar có thể đứng theo.

**Consumer live:** công cụ Bù xén/Đường cắt và recipe gọi endpoint này.
**Test gap:** test hiện gọi coroutine trực tiếp với FakeRequest; chưa có test heartbeat/health concurrent.
**Đề xuất:** đưa toàn bộ semaphore + engine + restore canvas vào worker của scheduler; giữ parsing request nhẹ ở event loop. Thêm test một engine giả ngủ trong lúc `/health`/một coroutine heartbeat vẫn chạy.

### §PERF.2 — [CONFIRMED] P1 / S–M — VDP không RAM-gate worker nội bộ

**Đường chạy live:**

`POST /vdp/generate` → `_VDP_EXECUTOR.submit` (`vdp.py:497`) → `@scheduled_job("vdp")` (`:346`) → `vdp_background_task()` → `run_vdp_engine()` (`:304`) → `vdp_engine.py:1101-1124`.

`run_vdp_engine` dùng:

```text
available_cores = os.cpu_count() - 1
num_workers = min(num_chunks, available_cores)
ProcessPoolExecutor(max_workers=num_workers)
```

Không có `plan_worker_count`, RAM total hoặc RAM available. Với CPU 16 luồng và dataset đủ lớn, cả máy 4 GB lẫn 32 GB đều có thể mở 15 process. `_VDP_MAX_CONCURRENT_JOBS=1` chỉ chặn hai job VDP cùng lúc, không giới hạn process của một job.

**Bất biến vi phạm:** `<8 GB` phải giảm mạnh; `<16 GB` giảm nhẹ; `≥16 GB` mới full.
**Đề xuất:** dùng `plan_worker_count(kind="vdp", per_worker_mb=...)`, env `PRYNX_VDP_WORKERS`; thêm test gọi đúng planner trên đường engine, không chỉ test helper chung.

### §PERF.3 — [CONFIRMED] P1 / S — Telemetry preview bật mặc định và tự tạo tải I/O/network

Backend `preview_perf_log.py:25-30` mặc định `PRYNX_PREVIEW_PERF_LOG=1`. Mỗi dòng:

- mở/append log workspace;
- mở/append log `%APPDATA%` (`:33-57, 87-93`).

Frontend `previewPerfLog.ts:15-41` với mỗi mốc:

- invoke Rust để append `Desktop/PrynX_Performance.log` (`lib.rs:940-952`);
- gửi thêm authenticated POST `/imposition/perf-beacon`.

Call-site nằm ở tile load, detect shape, batch capacity và preview layout. Số thật trên máy audit:

- `logs/preview_perf.log`: **26.118 dòng / 3,52 MB**;
- `%APPDATA%` bản sao: **2,50 MB**;
- Desktop `PrynX_Performance.log`: **2.924 dòng / 315 kB**.

Đây là self-observation overhead: audit hiệu năng đang làm đường cần đo chậm hơn, đặc biệt trên HDD/antivirus và máy yếu.

**Đề xuất:** mặc định OFF ở release; bật bằng một cờ thống nhất `PRYNX_PERF=1`; buffer/flush batch nếu bật; không ghi cả Desktop + backend + AppData cho cùng sự kiện.

### §PERF.4 — [CONFIRMED] P1 / S–M — Cache sidecar theo version không được prune

`build_production.ps1:917-918` dùng Nuitka onefile và:

`{CACHE_DIR}\PrynX\sidecar-{VERSION}`

Không tìm thấy code runtime/build dọn `sidecar-*` cũ. Artifact thật đang giữ ba version, mỗi version khoảng 923 MB. Sau ba RC, riêng cache sidecar đã gần 2,77 GB; tổng `%LOCALAPPDATA%\PrynX` là 3,29 GB.

**Ảnh hưởng:** cập nhật đều làm ổ C tăng gần 1 GB/version; máy SSD nhỏ nhanh hết dung lượng.
**Đề xuất:** sau khi sidecar hiện tại xác thực và sẵn sàng, prune cache version cũ; giữ current + tối đa một previous để rollback. Không xóa thư mục đang chạy; test path containment và file-lock.

### §PERF.5 — [CONFIRMED] P1 / M — Cold launch chưa thân thiện máy yếu

Chuỗi release hiện tại:

`verify pdfium/integrity → hash sidecar → kill zombie → spawn Nuitka onefile → đợi startup proof → show window` (`desktop/src-tauri/src/lib.rs:2865-3189`). Window cấu hình `visible:false` nên trước `app ready` người dùng không có tiến trình trực quan.

Trên máy 32 GB/16 luồng, build 04–05/08 đạt median 4,415 s và max 6,672 s. Máy HDD/antivirus/CPU yếu có nguy cơ lâu hơn; code cho phép chờ tới 60 s (`lib.rs:97`). Frontend còn warm đồng thời ba chunk workspace lớn và giữ brand splash 3 giây.

**Đề xuất:** trước tiên thêm mốc release `process start → native splash visible → sidecar ready → Home interactive`; hiện native splash/progress phải xuất hiện sớm, không để cửa sổ hoàn toàn ẩn. Sau đó benchmark phương án standalone/cached payload, hoặc giữ onefile nhưng prune + chỉ warm chunk theo tier máy.

### §PERF.6 — [CONFIRMED] P1 / M — Output Preview/TAC chạy vòng per-pixel trên main thread

`OutputPreviewTab.tsx:54-73` làm `atob → pako.inflate → createImageData → vòng từng pixel → putImageData → toDataURL` cho từng kẽm. TAC heatmap lặp lại toàn bộ pixel × số kênh tại `:164-198` mỗi khi threshold/plate đổi.

Không có Web Worker/OffscreenCanvas/ImageBitmap ở đường này. Với A3 150 DPI khoảng 4,35 triệu pixel, 6 kẽm tạo hàng chục triệu phép tính JS + encode PNG trên main thread, đủ gây giật rõ trên máy văn phòng.

**Đề xuất:** worker transfer `ArrayBuffer`, tính plate/TAC ngoài main thread; trả `ImageBitmap` hoặc Blob URL; giữ debounce nhưng không coi debounce là thay thế worker.

### §PERF.7 — [CONFIRMED] P2 / M — Cache được cap theo số/tuổi, chưa theo byte và free disk

- Page LRU cố định 24 page/document (`src-tauri/src/lib.rs:376`), không theo tier RAM.
- Rust tile cache cố định 500 JPEG (`:1167`), frontend tile URL 200 (`LivePageFrame.tsx:129`), disk prune theo 3.000 file (`lib.rs:1376`).
- Cleanup backend chỉ dùng tuổi 26 giờ (`cleanup.py:16-22, 122-198`), không có byte quota hoặc free-disk watermark.

Artifact hiện tại: tile cache 593 MB; dev uploads/results 4,28 GB trong 24 giờ test. Không kết luận khách hàng luôn chiếm 4,28 GB, nhưng policy hiện tại cho phép spike theo workload cho tới khi đủ tuổi.

**Đề xuất:** byte-budget theo RAM/disk tier; LRU theo tổng byte; kiểm free disk trước job tạo output lớn; cleanup high-watermark trước khi chờ TTL.

### §PERF.8 — [FIXED LÔ 11 — VERIFIED AUTO] P2 / L — PPE/tách kẽm còn nhiều kernel đơn luồng

`print_engine/Cargo.toml` không phụ thuộc Rayon; các kernel full-frame vẫn dùng vòng tuần tự, ví dụ `ink.rs:1429`, `:1498`. `max_tac_percent()` dựng cả `Vec<f32>` TAC rồi mới fold (`:1582-1594`), gây thêm một buffer full-page. Consumer live là `pdfcompare_native.ppe_separations` (`native/src/print_engine_py.rs:166`) qua Separations/Preflight/Export CMYK.

Máy mạnh vì vậy không dùng hết CPU ở một số stage PPE. Chưa có benchmark mới trên corpus khách hàng trong đợt này nên không gán hệ số tăng tốc.

**Đề xuất:** profile trước; song song theo hàng/kênh nơi state cho phép; `max_tac` fold trực tiếp; giữ ColorManager/thread-safety và golden render làm gate.

**Đã sửa 06/08:** profile fixture `17_tac_heavy_cmyk.pdf` ở 300 DPI
(2.550×3.300 px) chứng minh hậu xử lý kẽm/TAC chiếm phần đáng kể của luồng live.
`max_tac_percent()` nay fold trực tiếp, bỏ buffer tạm khoảng 32,1 MiB; các kernel
stateless `tac_percent`, `plate_u8`, `plate_coverage_pct` và xuất CMYK dùng pool
Rayon chung khi ảnh từ 512K pixel. Không chia sẻ `ColorManager` và không song song
merge transparency. Median 5 lượt: max TAC nhanh 8,63×; bốn kẽm + coverage 3,14×;
CMYK export 2,17×. Toàn `print_engine` đạt 348 unit test cùng 218 integration/golden;
native build/check đạt và 117 test PPE/facade/export/preflight qua extension mới đạt.

### §PERF.9 — [FIXED LÔ 11 — VERIFIED RUNTIME] P2 / M — Minimize/background vẫn chạy gần full-speed

WebView2 bị tắt occlusion và toàn bộ background/timer throttling ở cả `tauri.conf.json:27` và `src-tauri/src/lib.rs:2758-2768`. Đây là workaround có căn cứ cho lỗi “chỉ nhanh khi mở DevTools”, nên **không được gỡ mù**.

Hệ quả là tab active vẫn active khi cửa sổ minimize; polling 500 ms của N-Up (`processHandlers.ts:316`), timer và một số render scheduler không được WebView tự bóp ga. Viewer tab nền có suspend sau 20 giây, nhưng trạng thái minimize không đồng nghĩa đổi tab.

**Đề xuất:** giữ flags chống occlusion, nhưng pause polling/render ở tầng ứng dụng theo `document.visibilityState`/window focus; backend job vẫn chạy, UI resync ngay khi hiện lại.

**Đã sửa 06/08:** thêm nguồn trạng thái foreground chung kết hợp
`document.visibilityState` và focus cửa sổ Tauri. Poll N-Up không còn thức mỗi
500 ms khi app nền; tile đang chạy được hoàn tất nhưng scheduler không lấy tile
mới. Foreground đánh thức cả polling và queue ngay, giữ nguyên priority. Không hủy
backend job và không gỡ WebView2 workaround. Bảy test hành vi mới đạt; toàn frontend
đạt 200 file / 1.926 test, 2 skipped; typecheck và lint budget đạt. Runtime Tauri
Release `--no-bundle` với PDF 15 trang: 4 giây visible dùng 250 ms CPU; 5 giây
minimize dùng 0 ms CPU, `Responding=true`; restore tiếp tục phản hồi và đóng sạch
app/sidecar.

---

## 6. Nghi vấn/false-positive đã triage

### [EXPECTED] Dieline executor `max_workers=1`

`dieline.py:18-44` giữ đúng một native thread để tái sử dụng Boa thread-local JS context. Đây không phải cap máy mạnh bị bỏ sót; tăng thread sẽ mất warm context và có rủi ro sai thread affinity.

### [EXPECTED] Preflight Ink `_run_coro_sync(... max_workers=1)`

`preflight_rules/ink.py:146-155` chỉ tạo một bridge thread khi caller đang đứng trong event loop; nó không phải pool quét trang. Scanner `RESOURCE_CAP_WITHOUT_RAM_SIGNAL` báo đúng pattern nhưng sai ngữ nghĩa runtime.

### [SUSPECTED] Preflight hard ceiling 8 trên máy mạnh

Preflight đã RAM-gate máy yếu nhưng truyền `hard_ceiling=min(chunks, 8)` (`preflight_engine.py:215-224`). Nó trái policy “máy mạnh full” ở hình thức, nhưng audit chưa có benchmark chứng minh >8 process nhanh hơn hoặc an toàn hơn. Giữ ở `[SUSPECTED]`, không tự đổi 8 → CPU-1.

### [EXPECTED] Không gỡ các bản copy overlay đã đánh dấu false-positive

Giữ kết luận cũ §3.16: các bản overlay riêng phục vụ spotlight GIF; không tối ưu bằng cách xóa.

---

## 7. Lộ trình sửa đề xuất

Mỗi lô tối đa 5 file, verify xong mới sang lô tiếp theo.

### Lô 1 — Trả lại độ phản hồi backend (ưu tiên cao nhất)

1. `backend/app/api/routes/pdf_tools.py`
2. Test concurrency/event-loop mới trong `backend/tests/`

Đưa toàn bộ StickerEngine vào scheduled worker. Gate: engine giả ngủ nhưng heartbeat/status vẫn phản hồi; exception luôn nhả slot; file output/cleanup không đổi.

### Lô 2 — RAM-gate VDP

1. `backend/app/workers/vdp_engine.py`
2. `backend/tests/test_worker_ram_gating.py` hoặc test VDP riêng

Gate: `<8 GB → 1`, `<16 GB → 2`, `≥16 GB → CPU-1`; env override; output parity và cancel/cleanup.

### Lô 3 — Tắt telemetry release mặc định

1. `backend/app/utils/preview_perf_log.py`
2. `desktop/src/lib/previewPerfLog.ts`
3. `desktop/src-tauri/src/lib.rs`
4. Test cờ perf

Gate: release mặc định tạo 0 log/beacon; `PRYNX_PERF=1` vẫn đủ correlation; không ghi ba bản sao.

### Lô 4 — Prune cache sidecar an toàn

1. `desktop/src-tauri/src/lib.rs`
2. Test path/lifecycle Rust

Gate: giữ current + previous; không đụng thư mục ngoài `%LOCALAPPDATA%\PrynX`; không xóa cache đang dùng; retry file lock.

### Lô 5 — Output Preview worker

1. `desktop/src/components/OutputPreviewTab.tsx`
2. Worker mới trong `desktop/src/workers/`
3. Test pixel parity/TAC

Gate: byte/pixel parity; main-thread không chạy vòng full image; revoke blob đúng.

### Lô 6 — Cache/disk/background policy

Tách tiếp thành lô nhỏ: tile cache byte-budget; free-disk guard; app-level pause khi minimize; warmup theo tier. Không gỡ WebView occlusion workaround.

### Lô 7 — PPE/Rust

Chỉ làm sau profile corpus thật. Mỗi kernel phải có benchmark trước/sau + golden render, không đưa Rayon vào toàn engine bằng một patch lớn.

---

## 8. Benchmark nghiệm thu bắt buộc

Chạy tối thiểu 5 warm run + 1 cold run trên mỗi tier vật lý/VM:

| Audit unit | Corpus tối thiểu | Chỉ số |
|---|---|---|
| Startup | clean cache / warm cache / sau update | process start → native UI → sidecar ready → Home interactive; P50/P95 |
| Viewer | PDF ảnh 500 trang; 1/5/10 tab | first page, scroll FPS/long task, peak RSS, RAM sau đóng tab |
| N-Up | 100/1.000 trang; vector/raster | total, peak process-tree RSS, worker/chunk, temp, cancel |
| Sticker | corpus 13 loại + Alpha 72 trang | detect/batch/plan/render/merge/first paint, parity |
| VDP | 1k/10k/100k record | peak RSS/process, queue, cancel, output parity |
| Output Preview | A3 150 DPI, CMYK+2 spot | long task, time-to-plate, TAC parity |
| PPE | vector/ảnh/transparency/ICC | page time, CPU utilization, peak RSS, golden |
| Disk | update 3 version + job lớn | installed/cache/temp peak, cleanup high-watermark |

Tier đề xuất: 8 GB/4 CPU, 16 GB/8 CPU, 32 GB/16 CPU; ít nhất một máy SATA SSD hoặc HDD để bắt I/O/antivirus.

---

## 9. Chốt duyệt (mốc lịch sử 05/08)

Tại mốc 05/08, audit đã đủ bằng chứng để bắt đầu **Lô 1–4**. Sau khi người dùng
duyệt, việc sửa đã tiếp tục đến Lô 11; trạng thái hiện hành nằm trong
`PERF_FIXES_2026-08-05.md`.

Thứ tự khuyến nghị: **§PERF.1 → §PERFvậy  → §PERF.3 → §PERF.4**. Bốn mục này có impact rõ, blast radius nhỏ hơn các thay đổi cache/Rust và trực tiếp cải thiện cả máy yếu lẫn máy mạnh.
