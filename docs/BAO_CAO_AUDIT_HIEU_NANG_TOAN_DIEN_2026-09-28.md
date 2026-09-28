# Audit hiệu năng toàn diện PrynX — 28/09/2026

> **CẬP NHẬT TRẠNG THÁI 28/09/2026:** Phần đầu tài liệu này là báo cáo khảo sát
> lịch sử. Sau khi user duyệt tiếp tục, các lô ngoài **AI QC** đã được xử lý và
> verify theo từng batch nhỏ: VDP parser/serialization, phân hạng RAM
> installed/usable/available và các consumer Sticker/PPE/N-up/Compare/CUT,
> xuất xám, locale EN lazy-load. AI QC vẫn **DEFERRED**; entry bị khóa tại
> `desktop/src/lib/toolRegistry.ts` và không được bật lại, benchmark lại hay
> dùng để nghiệm thu. D2 startup chỉ mới source-profile, chưa có patch ròng đã
> chứng minh. Các mục GUI/release/máy vật lý 8/16 GiB vẫn pending; xem nhật ký
> cập nhật tại `docs/HIEU_NANG_TOAN_DIEN_FIXES_2026-09-28.md` và matrix.
>
> Các tiêu đề “AUDIT ONLY · CHỜ DUYỆT SỬA” và số đo baseline bên dưới được giữ
> nguyên làm bằng chứng lịch sử, không phải trạng thái hiện hành.

**AUDIT ONLY · CHỜ DUYỆT SỬA.** Đợt này khảo sát xuyên tầng và đo các điểm rủi ro cao; không sửa mã sản phẩm, không build, commit, đổi snapshot hoặc can thiệp app đang chạy. Không khẳng định đã đạt “trần hiệu năng”, hết lag hay 60 FPS.

## 1. Kết luận điều hành

PrynX đã có nhiều nền tảng đúng: Compare chạy song song, admission theo working set, khóa PDFium, cache theo byte, tái sử dụng phiên nesting, gate tab/foreground và render 3D theo nhu cầu. Không nên thay bằng giới hạn tài nguyên đồng loạt hoặc tăng worker theo cảm tính.

**Ba ưu tiên cao nhất còn hiện hữu:**

1. Soát lỗi AI dùng HTTP đồng bộ ngay trong route `async`: thời gian chờ mạng cũng là thời gian event loop backend bị chặn.
2. Đọc dữ liệu VDP, đặc biệt Excel, chạy đồng bộ trong route `async`: fixture Excel chỉ 306.558 byte/10.000 dòng đã chặn heartbeat khoảng **498–551 ms** trên máy 32 GiB.
3. Python dùng RAM hệ điều hành có thể sử dụng để phân hạng phần cứng, trong khi Tauri đã dùng RAM lắp đặt: mô phỏng máy lắp 16 GiB nhưng dành 240 MiB cho phần cứng làm planner giảm **15 xuống 2 worker** dù còn đủ RAM. Đây là sai phân hạng, không phải kết quả benchmark tăng tốc 7,5 lần.

Có thêm hai cơ hội đã xác nhận: chuyển màu xám giữ khóa PDFium lâu hơn cần thiết; locale tiếng Anh vẫn nạp tĩnh khi khởi động tiếng Việt. Tổng cộng **5 finding CONFIRMED: 3 P1, 2 P2**. Startup dependency, fan-out React và khả năng tăng tốc sâu hơn được giữ riêng ở SUSPECTED, chưa tự xếp severity.

Baseline Compare hiện tại: 20 trang/150 DPI, N=3 mỗi cấu hình; 15 worker trung vị **1,656 s**, 1 worker **3,475 s**, parity metadata và hash artifact đạt. Tăng throughput có trade-off: peak working set khoảng **413,6 so với 268,5 MiB**, mốc progress trang đầu **477 so với 413 ms**. Đây là A/B cấu hình của code hiện có, **không phải cải thiện do audit này**.

## 2. Phạm vi, nguồn và phương pháp

- Source: worktree tại HEAD `bc3d6d5b1761e5c5309eb589ec6eb58ac31b3f58`; các file Viewer/PPE đang có thay đổi của công việc khác, được giữ nguyên. SHA-256 source quan trọng nằm trong `audit/PERF_2026-09-28/evidence.json`.
- Máy đo: Windows x64 build 26200, Python 3.11.9, 16 CPU logic; RAM lắp 32.768 MiB, OS dùng được 32.527,914 MiB, còn khả dụng khoảng 18.891 MiB lúc probe. Chưa đo trên máy vật lý 8/16 GiB.
- Đã đối chiếu báo cáo và log fixes 26/07, 05/08, 13/08, Compare 20/08, PPE 25/09, Viewer/PDFium 27/09 và master audit matrix. Không coi finding lịch sử còn đúng nếu source đã thay đổi.
- Probe route gọi trực tiếp handler và engine thật trong process riêng; dữ liệu tổng hợp, SQLite memory, thư mục tạm riêng. Chỉ transport HTTP AI được mô phỏng, không gửi mạng thật. Dependency license được cung cấp bằng fixture; không phải kiểm thử lớp HTTP/auth.
- Heartbeat dùng cùng event loop, sleep danh nghĩa 5 ms. Windows thực tế có gap idle tối đa 18,510 ms trong lượt cuối; con số đo là **gap event loop**, không phải network latency, thời gian paint hoặc FPS.
- N=3 chỉ là mẫu thăm dò. Không tính p95 có ý nghĩa thống kê từ ba lần; không flush filesystem cache, không gọi lần đầu trong process là cold-disk/release startup.
- Artifact PDF/PNG tổng hợp được tạo, mở lại và kiểm tra trong probe rồi dọn cùng thư mục tạm. Giữ script, hash PNG preview, số đo và log Compare để tái lập.
- Tuân theo `prynx-audit-workflow`, `prynx-deep-audit`, `prynx-performance` và các skill kiến trúc/testing/imposition/dieline/build/conventions: báo cáo trước, duyệt rồi mới sửa theo lô ≤5 file.

## 3. Bảng finding chính

| Mã | Finding CONFIRMED | Ưu tiên / effort | Bằng chứng và phạm vi |
|---|---|---|---|
| §PERF28.01 | AI QC chặn event loop khi chờ HTTP | P1 / S | UI→route→checker; mock transport 250 ms gây gap 250,477–250,680 ms; đối chứng offload 16,095 ms |
| §PERF28.02 | Đọc dữ liệu VDP đồng bộ trong async route | P1 / M | UI Excel/Sheets→datasource; Excel 10.000 dòng gap 497,767–551,141 ms; CSV 100.000 dòng cũng tái hiện |
| §PERF28.03 | Python phân hạng RAM theo usable thay vì installed | P1 / M | 16.384→16.144 MiB làm 15→2 worker; Tauri đã phân biệt hai loại RAM |
| §PERF28.04 | CMM ảnh xám chạy khi giữ khóa PDFium | P2 / S–M | Xuất A4/300 DPI thật; 3/3 `ImageCms.applyTransform` giữ khóa, mất 78,795–80,583 ms/lượt |
| §PERF28.05 | Locale EN vẫn nạp tĩnh ở startup VI | P2 / M | Import static và resources trực tiếp; EN 360.381 byte JSON compact. Tiếp nối §P25.3, không phải phát hiện mới hoàn toàn |

P1 ở đây là rủi ro lớn về khả năng phản hồi/chính sách tài nguyên, không đồng nghĩa mất dữ liệu. Chưa thấy cơ sở đưa finding hiệu năng mới lên P0.

### §PERF28.01 — Soát lỗi AI chặn event loop backend

**Trace:** `desktop/src/components/AiQcTab.tsx:28,47` → POST `/api/qc/check-text` → registration `backend/app/main.py:378` → `backend/app/api/routes/qc.py:28,44` → `backend/app/core/llm_checker.py:28,35,38` → JSON errors → `AiQcTab.tsx:60` cập nhật kết quả.

Đường gọi có `async def check_text(...)` nhưng bên trong gọi trực tiếp `LLMChecker.check_text_cloud(...)`, dùng `with httpx.Client(timeout=60.0)` và `client.post(...)`. Không có điểm nhường event loop trong thời gian chờ HTTP đồng bộ. Request khác/cancel/progress trên cùng loop có thể phải chờ; không suy rằng mọi process/native UI đều đứng.

Probe N=3, transport giả ngủ 250 ms: route 250,394–250,600 ms, heartbeat 250,477–250,680 ms. Đối chứng cùng checker bằng `asyncio.to_thread`, chưa đưa vào production: route 251,190 ms nhưng gap chỉ 16,095 ms. Tách được nguyên nhân chặn loop khỏi thời gian dịch vụ AI. Không đo latency thật của nhà cung cấp hoặc phát sinh chi phí API.

**Đề xuất:** HTTP async, hoặc offload I/O qua cơ chế thread sẵn có phù hợp; không tạo process pool cho chờ mạng. Giữ provider/key/error/auth, tránh thay đổi nghiệp vụ trong lô perf. Kiểm thành công, timeout, lỗi provider, request đồng thời và heartbeat. Phép offload không làm dịch vụ AI trả lời nhanh hơn; nó giữ backend phục vụ được các việc khác.

### §PERF28.02 — Đọc Excel/Sheets VDP chặn vòng xử lý

**Trace:** `desktop/src/components/preprocess-tools/DataMergeTool.tsx:767,791,824` → `desktop/src/lib/api.ts:1513,1770` → registration `backend/app/main.py:385` → `backend/app/api/routes/vdp.py:999,1016` → `_read_table_from_source:886,931` → `backend/app/workers/vdp_datasource.py:357,590` → `RecordTable` → JSON preview/record_count → bảng dữ liệu UI. Google Sheets cùng dispatcher gọi HTTP đồng bộ tại `vdp_datasource.py:508`.

`await file.read()` không làm phần parse tiếp theo bất đồng bộ: `return read_source(...)` vẫn chạy inline. API chỉ trả 20 dòng preview nhưng đọc toàn bộ để có số record. Không được “tối ưu” bằng cắt nguồn còn 20 dòng vì bước generate cần toàn bộ dữ liệu.

| Fixture tổng hợp | Kích thước | Route trung vị | Gap heartbeat trung vị / lớn nhất |
|---|---:|---:|---:|
| Excel 10.000 dòng ×6 cột | 306.558 byte | 551,363 ms | 542,113 / 551,141 ms |
| CSV 100.000 dòng ×6 cột | 3.866.810 byte UTF-8 | 176,637 ms | 176,828 / 215,363 ms |

Excel đi đúng đường UI đã truy vết; CSV chứng minh thêm cùng helper, không khẳng định UI luôn gửi CSV lên backend. Thời gian tạo workbook không nằm trong số đo. Probe kiểm `record_count` đầy đủ và đúng 20 preview rows.

**Pattern liên quan đã trace, chưa định lượng riêng:** `/datasource/sheets` gọi `list_xlsx_sheets` inline (`vdp.py:1030,1037`); `/validate` gọi resolve và `validate_batch` (`1044,1069`); `_table_from_rows:936` parse/copy JSON đồng bộ. UI lấy lại full rows ở `DataMergeTool.tsx:1229,1237`, rồi validation `1258`. Không quy toàn bộ chi phí validate/generate cho một lần parse được đo.

**Đề xuất:** tách parse/network khỏi event loop; đo thread offload trước cho nguồn vừa, giữ đường tác vụ nặng/admission khi dữ liệu lớn và CPU-bound. Thread không tự tăng throughput CPU Python. Nếu cache/reuse bảng đọc, phải có identity nguồn/sheet/header/revision, invalidation và ownership theo tab; không thêm cache vô hạn hay hard-cap cho tất cả máy. Verify đủ dòng, Unicode, cột rỗng, lỗi file, header, đổi sheet, retry/cancel, nguồn Sheets thay đổi và heartbeat đồng thời.

**Giới hạn quan trọng về preview:** `/vdp/preview` cũng có parse/render inline (`vdp.py:1087,1154`, `vdp_preview.py:184,230,243`). Đã tạo PNG 1190×1684 thật, 3 hash trùng nhau; gap lượt cuối 103–258 ms. Probe trước đó có lượt đầu khoảng 2,134 s, cho thấy nhiễu khởi tạo/cache lớn. Tuy nhiên tìm `previewVdpRecord` trong `desktop/src` chỉ thấy định nghĩa API, **chưa thấy caller UI hiện tại**. Không dùng số này để kết luận live overlay/Next của VDP đang lag vì endpoint này. Cần xác nhận consumer trước khi ưu tiên sửa. Nếu offload, phải kiểm khóa/lifetime PDFium trong engine, không chỉ bọc route bằng thread; không quay lại renderer cũ làm mất parity với PDF writer.

### §PERF28.03 — Sai ranh giới RAM 8/16 GiB

**Trace:** `backend/app/core/system_memory.py:60` trả `ullTotalPhys`; planner `:125–147` so trực tiếp với 8×1024 và 16×1024 MiB → `backend/app/workers/nup_engine.py:4039`, `vdp_engine.py:1939` → kế hoạch worker sinh PDF → kết quả job/UI. Nhánh phân hạng riêng ở sticker/PPE/preflight/scheduler cũng đọc helper này và cần đối chiếu từng consumer.

Tauri `desktop/src-tauri/src/lib.rs:2795,2807–2818` đã gọi `GetPhysicallyInstalledSystemMemory`, phân biệt RAM lắp đặt và RAM OS dùng được. Python chưa làm điều tương tự. `ullTotalPhys` không phải RAM còn trống; không được nhầm với `ullAvailPhys`.

Probe planner thật, CPU16/per-worker256 MiB, mock cặp usable/available hợp lệ:

| RAM OS dùng được | RAM đang khả dụng trong fixture | Worker |
|---:|---:|---:|
| 8.192 MiB | 6.144 MiB | 2 |
| 7.952 MiB | 5.964 MiB | 1 |
| 16.384 MiB | 12.000 MiB | 15 |
| 16.144 MiB | 12.000 MiB | 2 |
| 32.768 hoặc 32.528 MiB | 12.000 MiB | 15 |

Vi phạm chính sách máy lắp ≥16 GiB không bị hạ tier chỉ vì vùng RAM dành cho phần cứng. Máy đo 32 GiB **không** bị giảm tier trong ca này. Đây là mô phỏng boundary và xác minh API OS/source, chưa phải chạy job trên máy vật lý16 GiB.

**Đề xuất:** phân biệt `installed`, `usable`, `available`; dùng installed cho tier phần cứng, usable/available cho admission/reservation và áp lực bộ nhớ thực tế. Không thay mọi số total thành installed, không làm tròn tăng RAM một cách mù quáng, không bỏ `process_pool_budget_mb`/memory admission ngày25/09. Ca OS đọc lỗi, giới hạn VM/job, RAM đang cạn phải có policy/test rõ ràng. Các consumer sticker/PPE có budget riêng nên cần lô tiếp theo, không sửa hàng loạt chỉ bằng regex.

### §PERF28.04 — Chuyển màu xám giữ khóa PDFium thừa

**Trace UI hiện tại:** `desktop/src/components/workspace/ExportImageModal.tsx:265,286` → `exportImagesBatch`, `desktop/src/lib/api.ts:736,746` → `/api/export/images/batch`, `backend/app/api/routes/export.py:922,944` → `_render_image_batch:879,894` → `render_pdf_to_images:570` → PDFium raster → RGB độc lập → ICC gray → PNG/TIFF → response files/count → thông báo/mở thư mục từ UI. Registration `backend/app/main.py:390`, router prefix `export.py:38`. API đơn `/images:802` cũng gọi cùng renderer, nhưng không phải đường gọi modal hiện tại. Probe đo renderer chung, không mô phỏng batch HTTP đầy đủ.

`with pdfium_guard("export_images_page")` tại `export.py:684` bao cả `ImageCms.applyTransform(rgb_source, _get_srgb_to_gray_transform())` tại `:714`. RGB đã được chuyển ra khỏi bitmap trước CMM, nhưng phép CMM độc lập vẫn giữ khóa toàn process. Probe quan sát ownership ngay trong transform: **3/3 true**, 78,795–80,583 ms với A4/300 DPI; ảnh mở lại đúng mode `L`. Lượt đo trước 139–165 ms: không lấy mức chậm hơn làm lợi ích chắc chắn.

Chi phí này làm các thao tác PDFium **cùng backend process** chờ thêm. Không ảnh hưởng qua cùng khóa tới process PDFium Tauri độc lập. Encode/ghi ảnh hiện đã nằm ngoài khóa, không phải toàn bộ pipeline đều bị khóa.

**Đề xuất:** giữ detach/copy bitmap, phục hồi CropBox và close trong khóa; chuyển CMM ra ngoài sau khi ownership bộ nhớ đã chắc chắn độc lập. Kiểm cả lazy transform initialization và dùng transform đồng thời. Phải giữ ICC Gray Gamma2.2 và pixel/profile parity của fix22/09; không thay bằng `.convert('L')` để lấy tốc độ. Thêm test lock ownership, alpha/page-box/profile, hủy/lỗi và artifact parity.

### §PERF28.05 — Locale EN nạp sớm dù dùng VI

**Trace:** `desktop/src/main.tsx:4` → `desktop/src/i18n/index.ts:4–5` static import vi/en → resources `:19–23`, mặc định `lng: 'vi'` → i18next/tv → text UI. Reverse-map VI còn tạo lúc import, `enDict` tại `:58` phục vụ kiểm collision DEV.

Đây là phần còn mở của §P25.3 trong audit13/08. Source hiện tại xác nhận EN vẫn được tham chiếu/nạp, không phải chỉ import type:

| Locale | File raw | JSON compact | gzip compact | Số key |
|---|---:|---:|---:|---:|
| VI | 440.700 B | 396.402 B | 132.785 B | 6.084 |
| EN | 404.680 B | 360.381 B | 126.763 B | 6.084 |

Đây là kích thước dữ liệu source, **không phải kích thước chunk production, RAM object, download thực hoặc số ms có thể tiết kiệm**. Chưa build trong audit.

**Đề xuất:** lazy-load EN và đồng bộ lúc khôi phục lựa chọn EN đã lưu; giữ fallback VI, namespace, `tv()` reverse-map, collision checks DEV, trạng thái load/error và tránh render key thô. Ưu tiên sau các điểm chặn backend. Đo startup/bundle khi được phép build, không cam kết giảm360 KB chính xác ở installer.

## 4. Nghi vấn và việc KHÔNG được kết luận quá mức

| Đối tượng | Trạng thái | Bằng chứng / bước kế tiếp |
|---|---|---|
| Eager dependency sidecar (§P25.4 tồn dư) | SUSPECTED về phần có thể tiết kiệm | Ba process mới import `app.main`: 1.151,222 / 1.392,074 / 1.213,179 ms; vẫn nạp cv2/numpy/pikepdf/httpx/reportlab/PDFium. Chưa có import graph attribution và A/B lazy; không quy1,213s là toàn bộ “lãng phí” |
| ImposerDashboard subscribe toàn store | SUSPECTED, đã biết | `desktop/src/components/imposition-tools/ImposerDashboard.tsx:231,240` gọi `useImposerSettingsStore()` không selector; chưa có React commit-duration/fan-out profile. Không refactor god file chỉ vì dài |
| Preflight ceiling tối đa8 | SUSPECTED, đã biết | `backend/app/core/preflight_engine.py:226,228`, `hard_ceiling=min(len(chunks), 8)`; cần benchmark saturation/working set/cancel trên nhiều CPU trước khi đổi; không mặc định tăng là nhanh |
| VDP preview API/sibling PDF helpers | SUSPECTED về tác động UI hiện tại | Cơ chế block đã tái hiện trên preview API nhưng thiếu caller UI; auto-detect/pick-text còn cần trace và repro riêng. Object-picker đã có offload, không áp cùng kết luận cho mọi route |
| “3D tab ẩn vẫn chạy mọi frame” | DISPROVED trong đường đã đọc | `DielineTool.tsx:566,583` không mount 3D khi inactive; `MockupCanvas.tsx:117` là `frameloop="demand"`. Chưa đo GPU idle toàn app |
| “Startup hiện import sớm mọi PDF/workspace chunk” | STALE/không đúng tổng quát | `desktop/src/lib/pdfWarmup.ts:20–21` đã trì hoãn 8s/10s và có gate phần cứng từ23/09; cần kiểm startup thực tế thay vì dùng code cũ |
| “Compare còn hoàn toàn tuần tự/commit từng trang” | DISPROVED | Pipeline và benchmark hiện tại xác nhận parallel; encode/batch commit đã có. Process path trang lớn tồn tại, corpus này chưa đo path đó |
| “Nesting giải lại mọi preview/execute” | Không đúng tổng quát | `backend/app/core/nesting_production_pipeline.py:820,863` có singleflight và render_session; những nhánh/revision khác cần ca riêng |
| “Bật LTO Cargo.toml để tối ưu” | EXPECTED: không làm | Release LTO ở `build_production.ps1:1348–1350,2445–2447`; không thêm `[profile.release]`, không làm chậm maturin dev |
| Viewer hiện đã đạt60FPS sau các fix27/09 | UNKNOWN về nghiệm thu tổng thể | Matrix V27 vẫn còn RUNTIME/scan-out pending; có dirty Viewer/PPE mới28/09. Không dùng EXE cũ làm bằng chứng source mới, không đụng việc sửa correctness đang diễn ra |

## 5. Baseline Compare và cách đọc số đo

Chạy adapter `docs/audit/PERF_2026-09-28/compare_probe.py`, giữ nguyên thuật toán/corpus/kiểm parity của `scripts/benchmark_compare_pipeline.py`. Adapter chỉ khởi tạo fixture token trong child tách biệt vì harness cũ còn dựa env token không hợp guard hiện tại; không đổi guard/auth sản phẩm, không chạy server.

| Worker | Elapsed trung vị | Mốc progress trang đầu | Peak working set tối đa | Artifact bytes | Parity |
|---:|---:|---:|---:|---:|---|
| 1 | 3,475 s | 0,413 s | 268,504 MiB | 9.498.432 | Đạt |
| 15 | 1,656 s | 0,477 s | 413,609 MiB | 9.498.432 | Đạt |

Parity so `page_snapshot`, `summary`, SHA-256 artifact; không chỉ so thời gian. RAM đo cả cây process của benchmark, không phải RAM toàn app hoặc peak hệ điều hành. Mốc trang đầu do callback progress báo, **không phải ảnh đã paint trên màn hình**.

Tỷ lệ elapsed 2,099× chỉ áp dụng bộ mẫu này. Với15 worker, render tổng khoảng0,94–0,97s, phần tuần tự đo được khoảng1,03–1,07s; tăng worker thêm không tự xử lý phần tuần tự này. Tổng compare của các worker là thời gian cộng dồn, không được cộng thẳng vào wall time hay gọi “unaccounted” là pure overhead. Muốn tăng tiếp phải profile từng stage, giữ PDFium lock và pixel parity; process parallel render cần đánh đổi RAM/copy/startup, không phê duyệt từ N=3 này.

## 6. Ma trận độ phủ của đợt audit

Tất cả hàng dưới gắn ngày28/09/2026 và HEAD/working-tree đã ghi ở mục2. `ARTIFACT` không đồng nghĩa `RUNTIME`; phần chưa đo được giữ rõ.

| Audit unit / hành động | Entry → handler/engine → output → consumer; hợp đồng | Ca/test và mức hiện tại | Khoảng trống / bước tiếp |
|---|---|---|---|
| W7-P28-QC — chạy soát lỗi AI | AiQcTab→qc→LLMChecker→errors JSON→AI output; provider/error, loop không bị chờ mạng | AUTO: transport250ms×3, control offload, output empty-errors | Chưa real HTTP/server/UI; lô A1 + heartbeat/concurrency |
| W4-P28-DATA — nạp Excel/Sheets | DataMergeTool→api→vdp→read_source→RecordTable/JSON→bảng UI; đầy đủ record, preview20 | AUTO: Excel10k và CSV100k×3, kiểm count; trace validation/list sheets | Chưa runtime Excel nhiều sheet/Sheets mạng/soak, parse+serialization cần tách timer |
| W4-P28-PREVIEW-API — API preview1record | API đã đăng ký→vdp_preview→VDP writer→PDF raster→PNG; field/mm/scale/parity | ARTIFACT cho API: PNG1190×1684 mở lại,3 hash trùng; không có UI caller được chứng minh | Xác nhận consumer; không nâng live-preview UI từ kết quả này |
| W7-P28-RAM — lập kế hoạch worker | N-up/VDP→plan_worker_count→engine workers→PDF job; tier≥16GiB, admission RAM thật | AUTO cho helper/gate; consumer TRACED, boundary8/16/32 và test RAM/scheduler | Chưa physical16GiB hoặc throughput từng engine; lô B1/B2 |
| W3-P28-GRAY — xuất ảnh xám | ExportImageModal→/export/images/batch→_render_image_batch→render_pdf_to_images→PDFium→ICC→PNG→Image.open; mode/profile/CropBox | ARTIFACT: A4/300DPI×3, modeL, CMM lock-owned; export tests | Chưa concurrent lock contention/ICC A/B sau vá; lô C |
| W7-P28-COMPARE — so sánh20trang | /api/jobs/compare (`compare.py:332`)→comparison_engine→page DB+ảnh→result consumer; snapshot/score/hash | ARTIFACT: benchmark20trang150DPI N3×2, parity tests | Chưa GUI, tài liệu nặng/trang lớn/cancel dưới tải; không coi CPU16 là optimum mọi file |
| W7-P28-BOOT — mở shell/sidecar | main.tsx→i18n→UI; app.main→route imports→app; ngôn ngữ/fallback/lifecycle | TRACED + đo import process mới và source locale bytes | Chưa sidecar lifespan, startup cài đặt, click-to-first-paint; D1/D2 |
| W5-P28-3D — tab khuôn bế | DielineTool→3D subtree→MockupCanvas→frame; inactive phải ngừng | AUTO hẹp: sidebar suite, source inactive/demand | Chưa đo FPS/model phức tạp, GPU idle toàn app; profile nếu user gặp lag |
| W2-P28-NEST — xem trước/bình khuôn | layout request→singleflight/session→writer/preview→consumer; reuse phải đúng revision | AUTO hẹp singleflight + TRACED production pipeline | Chưa benchmark lại toàn nesting corpus, hình học/export không tái-audit mọi biến thể |
| W6-P28-VISIBILITY — chuyển tab/app nền | appVisibility→warmup/viewer schedulers/cache→consumer; active/ownership | AUTO hẹp48test frontend gồm visibility/warmup/cache/loader; không nâng toànViewer | Cần lifecycle đa tab, memory plateau và cancel app thật |
| W7-P28-PPE — mở/render PDF nặng | Tauri/viewer→PPE worker/scene→frame/surface→viewer; color/geometry/proof trước speed | TRACED delta + matrix lịch sử; không chạy kernel benchmark source dirty | Correctness đang sửa riêng; sau đó profile fresh đúng source/binary, scan-out |
| W8-P28-RELEASE — chạy bản đóng gói | build_production→Nuitka/maturin/Tauri→manifest→installer/app | TRACED cấu hình LTO; không build/test release đợt này | Startup clean-user/dev-release, executable hash, WebView/GPU/installer còn UNKNOWN |

Wave1 đơn vị/page-box không được tái-audit toàn bộ; chỉ kiểm fixture preview/export nêu trên. Không audit lại license/security, color science hay nesting optimality để làm số lượng finding. Chúng vẫn là bất biến phải giữ khi sửa performance.

## 7. Kiểm thử đã chạy và baseline còn đỏ

### Backend

Tại `backend/`, Python venv Windows, `-B -m pytest -q -p no:cacheprovider` cho:

```text
tests/test_worker_ram_gating.py
tests/test_heavy_scheduler_kind_gate.py
tests/test_pdfium_lock.py
tests/test_preview_layout_singleflight.py
tests/test_compare_pipeline.py
tests/test_compare_parallel_parity.py
tests/test_qc_extract.py
tests/test_export_images.py
```

Lượt sandbox: **143 pass,4 fail**,45,25s. Bốn ca fail tại Windows named-pipe ProcessPoolExecutor `PermissionError/WinError5`. Đã xin quyền và chạy lại **toàn file** `test_compare_parallel_parity.py`: **27/27 pass**,26,55s, gồm cả bốn ca bị chặn. Kết quả hiệu dụng là **147 ca duy nhất đạt**, không cộng143+27 thành170. Có warning Pydantic config deprecation. Không gọi toàn bộ backend suite xanh.

### Frontend

- `npm run typecheck`: **PASS**.
- `npx vitest run` các file `appVisibility.test.ts`, `pdfWarmup.test.ts`, `tileUrlCache.test.ts`, `usePdfLoader.test.tsx`, `i18nCatalog.test.ts`, `DielineTool.sidebar.test.tsx`: **48 pass,1 fail**,6file,7,69s.
- Ca đỏ: `i18nCatalog.test.ts:102` phát hiện thiếu `misc.acrobatViewer:compatibility_preview_warning` trong VI. `git diff` xác nhận lời gọi key nằm trong `AcrobatViewer.tsx` đã dirty từ công việc Viewer/PPE trước audit. **Không sửa thay**, không gọi đây là regression của tối ưu hay che bằng update snapshot.
- Không chạy full Vitest/Cargo/build app/installer; không đo GUI hoặc máy vật lý8/16GiB.
- Cuối lượt: hai script probe qua kiểm cú pháp AST, JSON evidence hợp lệ, đủ6mẫu Compare/parity và3quan sát ownership khóa; diff tài liệu không lỗi whitespace. Source Rust mesh có thay đổi thêm từ công việc song song, không thuộc audit này và không được đưa vào kết luận performance.

### Tái lập probe

Từ root Windows:

```powershell
.\backend\venv\Scripts\python.exe -B docs/audit/PERF_2026-09-28/probe.py
.\backend\venv\Scripts\python.exe -B docs/audit/PERF_2026-09-28/probe.py --mode import
.\backend\venv\Scripts\python.exe -B docs/audit/PERF_2026-09-28/compare_probe.py --workers 1,cpu-1 --runs 3 --pages 20 --dpi 150 --stages
```

Không cần build. Probe dùng fixture tổng hợp; timing dao động theo cache, CPU và tác vụ nền. Harness token cũ lỗi là drift của công cụ đo, không phải finding throughput của app.

## 8. Lộ trình đề xuất để tiến tới hiệu năng tối đa

### Thứ tự sửa sau khi được duyệt

Mỗi lô **≤5 file, tính cả test/log**, verify xong và xác nhận thao tác thật trước lô tiếp theo; không gộp tất cả backend/frontend/native thành một patch.

| Lô | Nội dung | Lợi ích kỳ vọng / gate nghiệm thu |
|---|---|---|
| A1 | §PERF28.01: async/offload cloud QC, regression heartbeat/provider;2–4file | Backend tiếp tục phục vụ khi chờ AI; không hứa AI trả lời nhanh hơn |
| A2 | §PERF28.02: datasource/list sheets/validation entry, test dữ liệu đầy đủ;3–5file | Giảm block event loop Excel/Sheets; đo thêm GIL/serialization trước khi chọn thread/process |
| B1 | §PERF28.03: helper phân biệt installed/usable/available và test boundary;≤4file |16GiB không bị hạ tier nhầm; admission/cancel/oom guards vẫn nguyên |
| B2… | Từng nhóm consumer RAM riêng sticker/PPE/preflight/scheduler; mỗi lô≤5file | Đồng bộ tier nhưng giữ budget theo working set; không sửa theo regex toàn repo |
| C | §PERF28.04: rút ngắn lock span gray export và test artifact/ownership;≤4file | Giảm thời gian chờ PDFium cùng process; ảnh/ICC/pagebox không đổi |
| D1 | §PERF28.05: lazy EN và language boot/fallback tests;≤5file | Nhẹ startup VI; đo byte/time bản build sau khi được phép, EN không nháy key |
| D2 | Profile sidecar imports rồi chọn đúng dependency đáng hoãn | Đây là bước đo bổ sung, chưa có danh sách production fix được xác nhận |
| E | Profile UI/PPE theo file khách và binary đúng source sau khi công việc correctness hiện tại ổn định | input-to-paint/settle/idle, React commits, raster/ICC/encode/upload/scan-out; chỉ sửa bottleneck đã đo |

Quick win ít rủi ro nhất là A1; ảnh hưởng rộng tới throughput đúng chính sách là B1; C có phạm vi hẹp nhưng cần pixel/ICC parity nghiêm ngặt. Không tăng tất cả worker, giảm DPI, bớt chất lượng màu, bỏ lock hoặc đặt cache/resource cap chung để đạt con số đẹp.

### Chuẩn đo/so sánh trước khi gọi “nhanh, nhẹ, mượt”

Các ngưỡng sau là **đề xuất nghiệm thu**, chưa đạt hoặc được user chốt:

- Cùng source/binary hash, corpus và quality; tách CPU8/16/32+, RAM<8/8–<16/≥16GiB, SSD, DPI màn hình và driver. Dùng8/16/32GiB máy thật khi có; mock boundary không thay được máy thật.
- Sau warm-up, lấy tối thiểu30mẫu cho p50/p95 ở tương tác/route ngắn; job dài ghi N thực tế và phân tán, không bịa p95 từN3. Tách cold-process/warm-cache/cold-disk; không flush cache hoặc tác động app user nếu chưa được phép.
- Backend: QC transport250ms và nạp Excel phải cho heartbeat/request khác tiến triển; mục tiêu gap p95<50ms trên máy đo là gate đề xuất, cần thêm harness HTTP/concurrent chứ không chỉ direct-route. Theo dõi cancellation, queue wait và memory pressure.
- UI: đo input-to-visible-frame, thời gian đạt ảnh nét đúng màu, long task>50ms, p95 frame time khi pan/zoom. Màn60Hz có16,7ms/frame làm mốc; chỉ timer/rAF hay frame submitted không chứng minh scan-out60FPS.
- RAM/CPU: peak cây process của job, RSS/working set idle, cache bytes, GPU memory và memory plateau sau20vòng mở/đóng tài liệu. “Nhẹ” nghĩa là ít công việc/copy/cache tồn dư không cần thiết, không hy sinh throughput/chất lượng máy mạnh.
- Throughput: Compare/VDP/N-up/nesting/export dùng cùng input/output, đánh giá thời gian trang đầu và toàn job riêng. Một tối ưu throughput không tự được duyệt nếu làm tương tác/cancel chậm rõ rệt.
- Artifact: hash khi phù hợp, page count/boxes/order, barcode/text/font, ảnh/ICC/proof và nesting placements. Nhanh hơn nhưng sai file/màu không được nghiệm thu.
- Startup: app ready, sidecar ready, mở file đầu, lần gọi tính năng lazy đầu tiên; dev và release đo riêng, không chuyển chi phí sang lần bấm đầu rồi chỉ báo startup đẹp.

## 9. Bàn giao và chốt duyệt

> **Trạng thái sau khi user duyệt tiếp tục (28/09/2026):** các lô ngoài AI QC
> đã được triển khai và verify theo nhật ký `HIEU_NANG_TOAN_DIEN_FIXES_2026-09-28.md`:
> B2a–B2k, A3, C và D1. D2 giữ `SOURCE-PROFILE/SUSPECTED` vì chưa có lợi ích ròng
> được chứng minh. AI QC vẫn `DEFERRED`, không được bật hoặc dùng để nghiệm thu.
> Verify cuối lượt: backend liên quan 1.139 pass trong sandbox + 4/4 ca
> multiprocessing pass ngoài sandbox; frontend typecheck pass và i18n 49/49 pass.
> GUI, release/installer, máy vật lý 8/16 GiB và scan-out GPU vẫn là pending
> runtime.

Bằng chứng: `docs/audit/PERF_2026-09-28/evidence.json`, `compare-output.txt`, hai script probe. Master matrix đã thêm các unit W7/W4/W3-P28 theo đúng mức chứng minh.

Phần đề nghị duyệt A1→A2, B1/B2, C và D/E bên dưới là **baseline lịch sử** của báo cáo khảo sát. Sau các lô đã triển khai, vẫn không thể tuyên bố toàn dự án đạt “trần hiệu năng” cho đến khi có runtime/release/máy vật lý tương ứng; các khoảng trống này được giữ công khai để nghiệm thu tiếp.
