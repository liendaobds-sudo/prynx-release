# Nhật ký sửa hiệu năng PrynX — 05/08/2026

**Nguồn:** `BAO_CAO_AUDIT_HIEU_NANG_VA_THAN_THIEN_PHAN_CUNG_2026-08-05.md`
**Phạm vi đã duyệt:** §PERF.1–§PERF.4, §PERF.6, §PERF.7 (phần 1–3)
**Trạng thái:** Đã sửa và kiểm thử tự động; còn kiểm tra runtime trên ứng dụng thật.

## Lô 1 — Độ phản hồi Sticker Dieline và RAM-gating VDP

### §PERF.1 — Không khóa event loop khi tạo đường cắt Sticker

- `backend/app/api/routes/pdf_tools.py`: đưa khởi tạo engine, chờ semaphore, `process_pdf()` và khôi phục canvas sang worker của scheduler. Phần đọc/kiểm tra form vẫn ở async route.
- `backend/app/workers/sticker_engine.py`: vì engine nay chạy trong thread, bọc các lời gọi PDFium bằng `pdfium_guard()`; nhả khóa trước xử lý NumPy/OpenCV, chia process và thao tác file độc lập.
- Bảo toàn hợp đồng output, header, cleanup, watermark và semaphore một job Sticker tại một thời điểm.
- Test mới chứng minh heartbeat vẫn chạy khi engine giả lập đang chờ, engine/restore cùng chạy ngoài event-loop thread và exception luôn nhả slot.

### §PERF.2 — VDP chọn worker theo RAM

- `backend/app/workers/vdp_engine.py`: dùng `plan_worker_count(kind="vdp", per_worker_mb=1024, env_override="PRYNX_VDP_WORKERS")`.
- `<8 GB` giảm còn 1 worker; `8–<16 GB` tối đa 2; `>=16 GB` giữ `CPU-1`; không đọc được RAM thì giữ hành vi CPU cũ.
- Kích thước chunk được tính lại theo ngân sách worker thật, tránh máy yếu tạo nhiều chunk nhỏ rồi xử lý tuần tự không cần thiết.
- Ghi log lý do chọn worker; `PRYNX_VDP_WORKERS` vẫn thắng auto-detect theo escape hatch của dự án.
- Phần ghép chunk bằng PDFium được bọc khóa theo từng lời gọi; xóa chunk và tối ưu pikepdf nằm ngoài khóa.

## Bằng chứng kiểm thử

Baseline trước sửa:

- Bộ test mới: `5 failed, 8 passed` — heartbeat bị treo; VDP chưa có planner trên đường engine.

Sau sửa:

- `py_compile` ba tệp backend: đạt.
- Test hồi quy mới + policy worker chung: `13 passed`.
- Sticker route/canvas chọn lọc: `18 passed`.
- VDP engine + lifecycle + CSV transport: `27 passed`.
- Toàn bộ Sticker engine E2E + page canvas: `103 passed`.
- Scheduler/resource gate cuối: `21 passed`.
- Khóa PDFium + heavy scheduler: `6 passed`.
- `git diff --check` trên toàn bộ tệp của lô: đạt.
- Không cập nhật golden/snapshot; không thay đổi hình học hoặc định dạng file output có chủ đích.

## Kiểm tra runtime còn lại

1. Chạy `run_dev.bat`, tạo đường cắt trên PDF nhiều trang trong khi mở/chuyển tab hoặc gọi health/status; UI và tiến độ phải tiếp tục phản hồi.
2. Chạy một VDP đủ lớn trên máy audit 32 GB/16 luồng; log phải báo `workers=15` nếu không đặt env override.
3. Giả lập máy yếu bằng môi trường kiểm thử hoặc máy 8–12 GB; xác nhận worker 1/2 và theo dõi peak RSS, thời gian hoàn tất, hủy job và file tạm.

## Lô 2 — Telemetry opt-in và dọn cache sidecar cũ

### §PERF.3 — Preview telemetry mặc định tắt

- `backend/app/utils/preview_perf_log.py`: chỉ `PRYNX_PERF=1/true/yes/on` mới bật; cờ cũ `PRYNX_PREVIEW_PERF_LOG` không tự bật lại release.
- Mỗi sự kiện chỉ ghi một file `%APPDATA%/PrynX/logs/preview_perf.log`; bỏ bản sao workspace.
- `desktop/src/lib/previewPerfLog.ts`: cache kết quả cờ qua một IPC đầu tiên; khi tắt không dựng payload, không ghi Desktop và không gửi HTTP beacon.
- `desktop/src-tauri/src/lib.rs`: thay command ghi `Desktop/PrynX_Performance.log` bằng command chỉ đọc cờ; truyền cùng giá trị `PRYNX_PERF` sang sidecar.

### §PERF.4 — Prune cache Nuitka an toàn

- Sau khi sidecar hiện tại đã qua startup proof, Rust chạy prune trong thread nền để không kéo dài cold start.
- Chỉ nhận thư mục con trực tiếp có tên version hợp lệ trong `%LOCALAPPDATA%/PrynX`; bỏ qua file, tên lạ, symlink/junction hoặc đường dẫn ra ngoài.
- Giữ cache hiện tại và một cache trước. Nếu không khớp được current, giữ hai cache mới nhất để fail-safe.
- Xóa retry ba lần khi antivirus/file lock giữ cache; lỗi chỉ ghi cảnh báo, không chặn khởi động.
- Đã đối chiếu mã Nuitka cài trong venv: khi truyền cả product/file version, `{VERSION}` có dạng `1.0.0.3-1.0.0.3`; parser và test dùng đúng định dạng thực này.

### Bằng chứng kiểm thử lô 2

- Baseline telemetry: `3 failed, 1 passed` — mặc định đang bật và có hai đích ghi.
- Sau sửa, backend telemetry: `4 passed`.
- Rust test riêng flag/version/prune/path containment: `4 passed`.
- Toàn bộ Rust library: `67 passed, 1 ignored` (smoke test máy in thật bỏ qua có chủ ý).
- `cargo check --release`: đạt, bao gồm đường code chỉ biên dịch ở release.
- Frontend `npm run typecheck` và production build: đạt.
- `rustfmt --check` riêng `lib.rs`: đạt; formatter toàn crate vẫn báo ba chỗ có sẵn trong `security.rs`, không thuộc lô này.
- Không chạy prune trên cache thật trong lúc test; test chỉ dùng thư mục tạm riêng rồi tự dọn.

## Lô 3 — Output Preview/TAC không chặn luồng giao diện

### §PERF.6 — Dời xử lý toàn ảnh sang Web Worker

- `desktop/src/components/OutputPreviewTab.tsx`: bỏ `pako`, Canvas và các vòng lặp full-image khỏi luồng giao diện; gửi yêu cầu dựng kẽm/TAC sang worker, nhận PNG `Blob` và chỉ giữ mảng alpha trên UI cho phép lấy mẫu khi rê chuột.
- `desktop/src/workers/outputPreview.worker.ts`: giải mã base64, inflate alpha, dựng RGBA, cộng TAC và encode PNG bằng `OffscreenCanvas`; chỉ giữ `Uint16Array` tổng TAC giữa các lần đổi ngưỡng.
- `desktop/src/lib/outputPreviewPixels.ts`: tách công thức màu kẽm và TAC thành hàm thuần để kiểm thử parity; giữ nguyên phép làm tròn phần trăm, điều kiện cảnh báo `total > threshold` và gradient vàng → đỏ/alpha 120 → 220.
- Khi đổi trang hoặc đóng tab, worker cũ bị terminate, mọi promise đang chờ bị từ chối, URL kẽm/TAC được revoke. `OffscreenCanvas` luôn nhả backing store kể cả khi encode lỗi.
- Không thêm hard-cap worker, giảm chất lượng hay giới hạn theo CPU/RAM; máy mạnh và máy yếu đều hưởng lợi từ việc main thread không còn gánh vòng pixel.

### Bằng chứng kiểm thử lô 3

- Lint riêng ba file mới (`outputPreviewPixels.ts`, test và worker): đạt.
- Lint toàn `OutputPreviewTab.tsx` vẫn báo 6 lỗi/3 cảnh báo có sẵn ở các đoạn ngoài diff (kiểu `any`, catch rỗng và dependency `t`); lô này không mở rộng sang dọn nợ lint ngoài phạm vi.
- Unit test pixel parity + overlay/layout hiện hữu: `10 passed` trên 3 test file.
- `npm run typecheck`: đạt.
- `npm run build`: đạt; Vite phát hành worker riêng `dist/assets/outputPreview.worker-*.js` (48,78 kB ở lần build xác minh cuối).
- `git diff --check` cho file tracked và quét whitespace trực tiếp bốn file mới: đạt.
- Không cập nhật golden/snapshot; không thay đổi dữ liệu separations, công thức TAC hoặc định dạng PDF output.

### Kiểm tra runtime còn lại cho lô 3

1. Trong app thật, mở Output Preview cho trang A3 150 DPI có CMYK + ít nhất 2 màu pha; UI vẫn kéo panel, chuyển tab và rê chuột mượt trong lúc các kẽm đang dựng.
2. Bật TAC, kéo ngưỡng qua nhiều mức và so với bản cũ: vùng cảnh báo, màu gradient và giá trị phần trăm tại con trỏ phải trùng.
3. Đổi trang nhanh rồi đóng tab khi worker còn chạy; không được hiện ảnh trang cũ, báo lỗi giả hoặc tăng RAM kéo dài sau khi đóng tab.

## Lô 4 — Cache tile RAM theo dung lượng thật

### §PERF.7 phần 1 — Thay giới hạn 500 ảnh bằng LRU theo byte

- `desktop/src-tauri/src/lib.rs`: `TileCache` theo dõi tổng byte JPEG đang giữ thay vì coi mọi tile có cùng kích thước; khi thêm tile mới, LRU đẩy đủ số entry cũ cho tới khi nằm trong ngân sách.
- Tile đơn lẻ lớn hơn toàn bộ ngân sách vẫn được trả cho viewer nhưng không giữ trong RAM cache. Khi ghi đè cùng key, byte của entry cũ được trừ trước khi tính entry mới.
- Policy theo RAM tổng: `<8 GB → 64 MiB`, `8–<16 GB → 128 MiB`, `>=16 GB` hoặc không đọc được RAM → không cap, đúng bất biến máy mạnh chạy full.
- Escape hatch `PRYNX_TILE_CACHE_MB=<MiB>` thắng auto-detect; `0` nghĩa là không giới hạn. Giá trị sai hoặc overflow được bỏ qua và quay về policy phần cứng.
- Ba điểm đọc/ghi cache RAM dùng chung một initializer nên không thể lệch policy giữa cache hit từ RAM, cache hit từ đĩa và tile vừa render.
- Khi QA bật `PRYNX_PERF=1`, kênh perf ghi `TILE_CACHE_POLICY`; release mặc định vẫn không thêm I/O.
- Lô này chưa đổi cache Blob URL frontend, quota cache đĩa hoặc free-disk guard; các phần đó được tách sang lô sau để giữ phạm vi nhỏ.

### Bằng chứng kiểm thử lô 4

- Baseline cache/hồ sơ RAM hiện hữu trước sửa: `6 passed`.
- Test mới trước triển khai: compile fail đúng lý do (`TileCache` chỉ nhận số entry, không có `current_bytes`/policy byte).
- Test mới sau sửa: `4 passed` — LRU đẩy nhiều entry, thay thế key, bỏ cache tile quá lớn, policy ba tier RAM và env override.
- Toàn bộ Rust library: `71 passed, 1 ignored`; smoke test Microsoft Print to PDF thật tiếp tục bỏ qua có chủ đích.
- `cargo check --release`: đạt.
- `rustfmt --check` riêng `lib.rs` với `skip_children=true`: đạt. Format toàn crate vẫn còn ba diff có sẵn trong `security.rs`, ngoài lô này.
- Không thay đổi byte ảnh JPEG trả về, chất lượng render, file PDF hoặc golden/snapshot.

### Kiểm tra runtime còn lại cho lô 4

1. Bật `PRYNX_PERF=1`; trên máy `<8 GB`, mở/cuộn/zoom PDF ảnh nhiều trang và xác nhận `TILE_CACHE_POLICY budget=64 MiB`; peak RAM cache không tăng theo số lượng 500 tile như trước.
2. Trên máy `8–<16 GB`, xác nhận policy `128 MiB`; cuộn ngược vẫn cache-hit trong vùng làm việc gần nhất và không có preview trắng.
3. Trên máy `>=16 GB`, xác nhận policy `unbounded` và tốc độ cuộn/zoom không giảm. QA có thể đặt `PRYNX_TILE_CACHE_MB=64` để ép eviction và kiểm tra đường fallback.

## Lô 5 — Cache Blob URL frontend theo dung lượng thật

### §PERF.7 phần 2 — Thay giới hạn 200 URL bằng LRU theo byte

- `desktop/src/lib/tileUrlCache.ts`: cache dùng tổng `Blob.size`, LRU và callback revoke tập trung; thay key, clear toàn bộ và clear theo file đều cập nhật byte chính xác.
- Policy frontend theo RAM tổng: `<8 GB → 32 MiB`, `8–<16 GB → 64 MiB`, `>=16 GB` hoặc không đọc được RAM → không cap. Policy được áp ngay cả khi IPC phát hiện RAM hoàn tất sau các tile đầu tiên.
- `desktop/src/hooks/viewer/useTileRenderer.ts`: cả đường IPC native và PDF.js trả `{ url, byteLength }`; ảnh thường dùng URL `#keep` có `byteLength=0` và vẫn không bị cache chiếm quyền revoke.
- `desktop/src/components/workspace/LivePageFrame.tsx`: giữ nguyên export cleanup cho AcrobatViewer/ImpositionTab/usePdfLoader; cache hit vẫn touch LRU để cuộn ngược không nháy trắng.
- Tile coarse hoặc tile lớn hơn budget không nằm trong cache được component theo dõi riêng và revoke khi lỗi, bị thay thế hoặc unmount. Tile đã chuyển quyền vào cache vẫn sống qua vòng mount/unmount của Virtuoso như trước.
- Khi `PRYNX_PERF=1`, telemetry ghi `tile-url-cache-policy`; release mặc định không tạo log/beacon.
- Lô này không thay đổi scheduler, độ phân giải, JPEG quality, cache Rust hoặc cache đĩa.

### Bằng chứng kiểm thử lô 5

- Test mới trước triển khai: fail đúng lý do module cache theo byte chưa tồn tại.
- Unit test cache mới: `5 passed` — ba tier RAM, LRU theo byte, tile quá lớn, thay key/clear theo file và áp budget phát hiện muộn.
- Cache + scheduler + lifecycle loader: `25 passed` trên 3 test file.
- `npm run typecheck`: đạt.
- `npm run build`: đạt; chunk `LivePageFrame` tăng khoảng 1,96 kB chưa gzip và vẫn qua budget.
- `npm run lint:budget`: đạt. Lint riêng hai file mới: đạt.
- Lint toàn `LivePageFrame.tsx`/`useTileRenderer.ts` vẫn báo nợ cũ (`any`, hook dependency, unused…); không có finding mới thuộc diff của lô.
- Không cập nhật golden/snapshot và không thay đổi byte ảnh/PDF đầu ra.

### Kiểm tra runtime còn lại cho lô 5

1. Bật `PRYNX_PERF=1`, mở PDF ảnh nhiều trang và xác nhận sự kiện `tile-url-cache-policy` khớp tier RAM máy.
2. Cuộn nhanh xuôi/ngược và zoom liên tục; trang gần vẫn cache-hit, không nháy trắng hoặc xuất hiện ảnh tile đã bị revoke sớm.
3. Đóng tab khi tile coarse/sharp còn tải; RAM Blob phải hạ, không còn URL mồ côi hoặc lỗi decode ảnh.
4. Trên máy `>=16 GB`, xác nhận tốc độ cuộn không giảm so với trước; trên máy `<16 GB`, theo dõi peak RAM WebView khi đi qua hơn 200 tile.

## Lô 6 — Cache tile đĩa theo byte và dung lượng trống

### §PERF.7 phần 3 — Bỏ prune cố định 3.000 file

- Baseline trên máy audit trước sửa vẫn đúng số báo cáo: `%TEMP%/prynx_tile_cache` có `3.265` file, `622.076.396` byte (`593,26 MiB`). Không xóa cache thật trong lúc test.
- `desktop/src-tauri/src/tile_disk_cache.rs`: policy dựa trên dung lượng trống của volume đọc bằng Win32 `GetDiskFreeSpaceExW`; cache được tính theo tổng byte và xóa file cũ nhất cho tới khi đồng thời đạt quota và reserve.
- Tier dung lượng trống: `<5 GiB → 128 MiB`, `5–<20 GiB → 512 MiB`, `>=20 GiB → 2 GiB`; không đọc được trạng thái đĩa thì dùng quota 512 MiB. Đây là quota cache đĩa, không giảm worker/chất lượng render.
- Reserve mặc định là 2% tổng dung lượng volume, tối thiểu 2 GiB và tối đa 20 GiB. Nếu một lần ghi mới làm dung lượng trống xuống dưới reserve, PrynX chỉ bỏ ghi cache đĩa; ảnh vẫn trả về UI và cache RAM vẫn hoạt động.
- Escape hatch: `PRYNX_TILE_DISK_CACHE_MB=0` bỏ quota (`>0` đặt MiB); `PRYNX_MIN_FREE_DISK_MB=0` tắt reserve (`>0` đặt MiB). Override được đọc một lần; giá trị sai/overflow chỉ cảnh báo một lần rồi dùng auto-detect.
- Prune chạy thread nền, có `AtomicBool` chống chạy trùng. Tier thấp kiểm mỗi 16 lần ghi, tier giữa 32, tier rộng 64; lần ghi đầu của phiên luôn lên lịch prune.
- Chỉ file trực tiếp có tên đúng 16 ký tự hex + `.jpg` mới được xét; file lạ, thư mục, symlink/junction đều bị bỏ qua.
- `desktop/src-tauri/src/lib.rs`: ghi cache đĩa và đọc trạng thái volume được đưa ra ngoài mutex cache RAM, nên cache hit ở thread khác không phải chờ I/O đĩa.
- `desktop/src-tauri/Cargo.toml`: chỉ bật thêm feature Win32 `Win32_Storage_FileSystem`; không thêm crate, không đổi release profile/LTO.
- Telemetry `PRYNX_PERF=1` ghi `TILE_DISK_PRUNE` gồm byte quét/xóa, số file, quota và reserve.
- Free-disk guard tổng quát trước các job tạo PDF/output lớn của backend vẫn là phần riêng, chưa được coi là hoàn tất trong lô cache tile này.

### Bằng chứng kiểm thử lô 6

- Baseline cache Rust hiện hữu: `4 passed`.
- Test mới trước triển khai: compile fail đúng lý do chưa có `TileDiskPolicy`, kế hoạch xóa theo byte và write guard.
- Test module mới: `9 passed` — quota byte/LRU, reserve, ba tier đĩa, nhịp prune, override, bộ lọc/collector file và API Win32 trên volume temp thật.
- Toàn bộ Rust library: `80 passed, 1 ignored`; smoke test Microsoft Print to PDF thật tiếp tục bỏ qua có chủ đích.
- `cargo check --release`: đạt sau khi bật feature Win32 mới.
- `rustfmt --check` riêng `lib.rs` + module mới với `skip_children=true`: đạt.
- Không cập nhật golden/snapshot; không thay đổi JPEG, bitmap hiển thị hoặc PDF output.

### Kiểm tra runtime còn lại cho lô 6

1. Bật `PRYNX_PERF=1`, mở/cuộn PDF đủ tạo tile rồi xác nhận `TILE_DISK_PRUNE` ghi đúng quota/reserve và chạy ngoài đường trả ảnh.
2. Với cache thật 593,26 MiB: trên ổ còn `5–<20 GiB`, lần prune đầu phải hạ cache về tối đa khoảng 512 MiB; trên ổ `<5 GiB`, hạ về khoảng 128 MiB hoặc xóa thêm để cố phục hồi reserve.
3. Dùng `PRYNX_MIN_FREE_DISK_MB` trong môi trường QA để giả lập ổ gần đầy; tile vẫn hiển thị, chỉ không xuất hiện file cache mới và không có lỗi viewer.
4. Đặt `PRYNX_TILE_DISK_CACHE_MB=0` trên máy ổ rộng để xác nhận escape hatch giữ full cache và nhịp prune 64 không làm chậm cuộn/zoom.

## Lô 7 — Chốt dung lượng trước job PDF lớn

### §PERF.7 phần 4 — N-Up/VDP từ chối sớm khi chắc chắn không đủ đĩa

- `backend/app/core/disk_space_guard.py`: thêm chốt dùng chung, kiểm volume chứa thư mục tạm và volume chứa output. Nếu cùng volume, dùng đỉnh lớn nhất giữa các giai đoạn tuần tự thay vì cộng tất cả rồi chặn nhầm; nếu khác volume, kiểm riêng từng ổ.
- Reserve mặc định là 2% tổng dung lượng volume, tối thiểu 2 GiB và tối đa 20 GiB, cùng policy với cache tile đĩa. `PRYNX_MIN_FREE_DISK_MB=<MiB>` ghi đè; `0` tắt reserve cho QA. Giá trị sai quay về tự động và có cảnh báo.
- Chỉ fail khi đọc được trạng thái đĩa và chắc chắn thiếu. Nếu Windows/filesystem không trả được dung lượng, job vẫn chạy và ghi cảnh báo; helper không tự xóa file, không hạ chất lượng và không giảm worker máy mạnh.
- Ước lượng N-Up dành hai lần byte file nguồn và 256 KiB metadata/tờ; không nhân mù toàn bộ nguồn với mọi chunk vì sẽ chặn nhầm PDF nhiều trang tuần tự. Giai đoạn hậu xử lý tính cả output và bản ghi atomic có thể cùng tồn tại.
- `backend/app/workers/nup_engine.py`: kiểm sau khi chốt đúng `total_sheets`, trước khi fan-out process và tạo `prynx_nup_*`.
- Ước lượng VDP tính template theo số chunk, 128 KiB overlay/record và tổng byte ảnh biến đổi theo từng lần nhúng; cùng một ảnh dùng cho 1.000 record được tính 1.000 lần, tránh đánh giá thấp job ảnh cá nhân hóa.
- `backend/app/workers/vdp_engine.py`: quét ảnh có cache đường dẫn/kích thước, quan sát hủy mỗi 256 record, rồi kiểm đĩa trước canonicalize và `ProcessPoolExecutor`.
- Lỗi trả về bằng tiếng Việt, nêu dung lượng cần, dung lượng đang trống và cách chia job; route hiện hữu tiếp tục chuyển ngoại lệ thành trạng thái job thất bại bình thường.
- Cleanup high-watermark của `uploads/results` là phần riêng; lô này không tự xóa dữ liệu người dùng hoặc file còn đang được job khác dùng.

### Bằng chứng kiểm thử lô 7

- Baseline vòng đời trước sửa: `13 passed` — canonical cleanup N-Up, hủy VDP và toàn bộ characterization VDP hiện hữu.
- Test mới trước triển khai: collection fail đúng lý do chưa có `app.core.disk_space_guard`.
- Unit test chốt đĩa: `8 passed` — công thức N-Up/VDP, ảnh lặp theo từng record, cùng volume lấy peak, khác volume kiểm riêng, reserve override, thông báo tiếng Việt và fail-open khi không đọc được đĩa.
- Kiểm tra gộp chốt đĩa + N-Up canonical/output finalize + VDP engine/lifecycle/CSV transport: `42 passed`.
- `py_compile` ba file Python triển khai: đạt.
- Không cập nhật golden/snapshot; không thay đổi byte PDF đầu ra, hình học, layer, tên ốc hoặc policy worker.

### Kiểm tra runtime còn lại cho lô 7

1. Trong app thật, đặt `PRYNX_MIN_FREE_DISK_MB` cao hơn dung lượng trống rồi chạy N-Up và VDP; job phải dừng sớm với thông báo tiếng Việt, không còn chunk/canonical mới.
2. Đặt `PRYNX_MIN_FREE_DISK_MB=0`, chạy lại job nhỏ; output phải hoàn tất và giống bản trước lô này.
3. Chạy VDP ảnh biến đổi đủ lớn trên ổ tạm và ổ output khác nhau; ổ nào thiếu phải được báo đúng trước khi mở process worker.
4. Trên ổ rộng/máy mạnh, so thời gian chuẩn bị N-Up và VDP text-only; không được giảm worker hoặc phát sinh chậm đáng kể ngoài một lần đọc dung lượng ổ.

## Lô 8 — Cleanup high-watermark có danh sách an toàn

### §PERF.7 phần 5 — Thu hồi artifact managed khi ổ xuống dưới reserve

- Baseline trước sửa trên workspace hiện tại: `backend/results` có 356 file / 53,15 MiB; `results` gốc có 96 file / 21,74 MiB; uploads hiện trống. Chỉ đo, không xóa dữ liệu thật.
- `backend/app/core/disk_space_guard.py`: công khai `minimum_free_disk_bytes()` để admission guard và cleanup dùng đúng một policy reserve, tránh hai nơi tự diễn giải `PRYNX_MIN_FREE_DISK_MB` khác nhau.
- `backend/app/core/cleanup.py`: sau sweep TTL/OS-temp hiện hữu, đọc dung lượng từng volume. Chỉ khi free disk thấp hơn reserve mới xóa ứng viên cũ nhất tới reserve + khoảng hồi phục 0,5% volume, tối thiểu 512 MiB và tối đa 2 GiB; mục tiêu là tránh vòng 30 phút sau lại xóa lắt nhắt.
- Hai thư mục `uploads/results` trên cùng volume được gộp một lần kiểm. Nếu nằm ở hai ổ khác nhau, mỗi ổ có reserve và danh sách ứng viên riêng.
- Kết quả được phép xóa sớm chỉ gồm `nup_<8-hex>.pdf` và `vdp_<32-hex>.pdf` tầng gốc, tuổi ít nhất 2 giờ. Hai route đã quy định TTL job/file là 1 giờ; thêm 1 giờ biên để tránh race.
- Input bị sót sau crash chỉ gồm `vdp_data_<32-hex>.dat`, `vdp_template_<32-hex>.pdf` và `<UUID>_plan_input.pdf` tầng gốc, tuổi ít nhất 12 giờ — cùng ngưỡng dài hơn job tối đa của cleanup OS temp. Ngoài tuổi, mtime phải cũ hơn lúc sidecar hiện tại khởi động; input tạo trong process hiện tại luôn được giữ dù đã xếp hàng lâu.
- Giữ nguyên `sticker_*`, file khách hàng/tên lạ, Working_File edit, compare/preflight, mọi thư mục con, symlink và file mới. `sticker_*` cố ý không nhận dù có trùng prefix output bình tem, vì endpoint tạo đường cắt cũng dùng tên này và frontend còn tái sử dụng path sau response.
- Trước khi unlink, cleanup stat lại mtime + size; file vừa bị job khác sửa sẽ bị bỏ qua. Lỗi khóa/quyền chỉ ghi debug và tiếp tục, không làm chết vòng cleanup.
- `PRYNX_MIN_FREE_DISK_MB=0` tắt cả reserve admission lẫn high-watermark. Cleanup không giảm worker/chất lượng và không áp quota khi ổ còn đủ rộng.

### Bằng chứng kiểm thử lô 8

- Baseline OS-temp + disk guard hiện hữu: `15 passed`.
- Test mới trước triển khai: `5 failed` đúng lý do chưa có high-watermark/public reserve helper.
- Sau sửa, disk guard + OS-temp + high-watermark: `22 passed` — không áp lực giữ nguyên file; pattern/tuổi/tầng thư mục; bảo vệ input của sidecar hiện tại; xóa cũ nhất và dừng đúng target; override 0; lỗi unlink; vòng cleanup nền gọi chốt mới.
- Mở rộng cùng lifecycle N-Up/VDP để xác nhận TTL mà high-watermark dựa vào: `37 passed`.
- `py_compile` cho `cleanup.py` và `disk_space_guard.py`: đạt.
- Không chạy cleanup high-watermark trên thư mục thật; không cập nhật golden/snapshot và không thay đổi PDF output.

### Kiểm tra runtime còn lại cho lô 8

1. Dùng thư mục QA riêng, đặt `PRYNX_MIN_FREE_DISK_MB` cao hơn dung lượng trống rồi khởi động sidecar; log phải có `STORAGE-PRESSURE`, xóa N-Up/VDP đủ tuổi theo thứ tự cũ nhất.
2. Trong cùng thư mục, tạo `sticker_*`, file tên khách hàng, thư mục compare/preflight và file N-Up mới dưới 2 giờ; tất cả phải còn nguyên.
3. Đặt `PRYNX_MIN_FREE_DISK_MB=0`; vòng cleanup 30 phút vẫn dọn TTL/OS-temp cũ nhưng không chạy nhánh high-watermark.
4. Trên máy ổ rộng, xác nhận mỗi vòng chỉ đọc trạng thái volume và không có log/xóa `STORAGE-PRESSURE`.

## Lô 9 — Hiện trạng thái khởi động ngay lập tức

### §PERF.5 phần 1 — Native startup splash và chuỗi mốc đo xuyên tầng

- Baseline release gần nhất trong `%APPDATA%/PrynX/logs/startup_debug.log`: `release setup: begin` lúc `14:19:28.584`, `sidecar startup proof: waiting` lúc `14:19:29.666`, sidecar sẵn sàng lúc `14:19:35.209`, `app ready` lúc `14:19:35.256`. Tổng setup là **6,672 giây**, riêng chờ startup proof **5,543 giây**; trong toàn khoảng này main window cấu hình `visible:false` nên người dùng không thấy phản hồi.
- `desktop/src-tauri/tauri.conf.json`: giữ main window ẩn như trước nhưng thêm cửa sổ `startup` 520×300, không decoration/resize/taskbar, luôn nổi và hiện ngay từ lúc Tauri tạo window.
- `desktop/public/startup.html`: splash tự chứa, không JavaScript/network, dùng asset logo đã có; có tiếng Việt, progress CSS, dark mode và reduced-motion. Vite copy nguyên asset vào release bundle.
- `desktop/src-tauri/src/lib.rs`: ghi thêm các mốc `process entry`, `native splash: created`, `sidecar: ready (startup proof OK)`, `setup complete — app ready`, `frontend: Home interactive`. Hash sidecar 413 MB, spawn và startup proof chạy trong worker riêng để event loop vẫn paint/phản hồi; cửa sổ chính chỉ được show/focus sau proof, rồi mới đóng startup splash.
- Bản debug đóng startup splash ngay trong `setup` vì không chờ Nuitka sidecar; vòng dev không bị thêm màn chờ. Bản release vẫn giữ toàn bộ integrity/proof fail-closed và timeout 60 giây, chỉ thay đổi phản hồi nhìn thấy.
- `desktop/src/App.tsx`: sau khi `AppInner`/Home mount, gửi đúng một IPC `mark_frontend_interactive` qua API Tauri chính thức; không phụ thuộc global bridge, không chặn render, không gọi network và không tạo telemetry khi app đang chạy.
- Lô này chưa thay đổi `SPLASH_MIN_MS=3000` hoặc warm ba chunk workspace. React splash tiếp tục chạy phía sau native splash; policy warm theo RAM được tách sang phần 2 để đo riêng và không vượt giới hạn 5 file.

### Bằng chứng kiểm thử lô 9

- Baseline: Rust startup `2 passed`; frontend `npm run typecheck` đạt.
- Test mới trước triển khai: compile fail đúng lý do thiếu `desktop/public/startup.html`.
- Sau sửa, Rust startup `3 passed` — config có window startup visible, asset đủ status/ARIA và không script; proof/timeout cũ tiếp tục xanh.
- `cargo check --release`: đạt, bao gồm nhánh chỉ có ở bản đóng gói.
- `npm run typecheck` và `npm run build`: đạt. `dist/startup.html` 3.321 byte và `dist/logo.svg` 8.939 byte tồn tại sau build.
- Visual QA asset `dist/startup.html` ở đúng viewport 520×300: logo/text/progress nằm trọn khung, dark mode đọc rõ, accessibility tree có `role=status`/nhãn tiếng Việt và console không có warn/error.
- Toàn bộ Rust library: `81 passed, 1 ignored`; smoke test máy in thật tiếp tục bỏ qua có chủ ý. `rustfmt --check` riêng `lib.rs` và `npm run lint:budget` đều đạt.
- Build chỉ còn các cảnh báo chunk lớn/dynamic-import đã có; không có lỗi mới. Không đổi Cargo profile/LTO, sidecar, PDF output hoặc hình học.

### Bằng chứng runtime Release lô 9

- Lần đóng gói đầu phát hiện đúng lỗi runtime mà test tĩnh không bắt được: gọi `is_visible()` ngay trong `setup` trả `failed to receive message from webview`; UI thread bị chặn đến khi sidecar cold-start xong, cửa sổ có lúc `Responding=False`. Cold-start này kéo dài **26,504 giây** (`22:23:12.102 → 22:23:38.606`).
- Sau bản sửa worker, bản `--no-bundle` mới có SHA-256 `8F0D2DE9E61FACA69D8773E9BFC82AFE58C3A1A879BAB2D39DA35DEC7CEDD8A7`, kích thước 31.559.168 byte. Trong 20 mẫu lấy mỗi 250 ms ở 5 giây đầu, tiến trình luôn `Responding=True`; window handle xuất hiện khoảng 1,1 giây sau lệnh mở và không còn log `visibility check failed`.
- Warm-start thứ nhất: `process entry 22:34:14.410 → native splash 22:34:14.804 → Home preload 22:34:21.047 → sidecar ready 22:34:21.251 → main visible/app ready 22:34:21.252`, tổng **6,842 giây**. Home mount sớm hơn sidecar 204 ms nhưng vẫn nằm sau native splash; main chỉ hiện khi backend đã xác thực.
- Warm-start thứ hai: `22:35:46.263 → 22:35:51.119`, tổng **4,856 giây**. Mở `.exe` lần hai sau 1,5 giây tạo PID tạm rồi thoát; chỉ còn một main process, splash của instance đầu vẫn phản hồi và main chỉ hiện sau sidecar ready.
- Đóng main bằng luồng thoát bình thường đã dừng cả bootstrap Nuitka và tiến trình Python con; kiểm cuối không còn PID test nào chạy ngầm.
- Chưa phá sidecar có chủ ý để thử dialog timeout trên runtime. Nhánh fail-closed không đổi; ba test startup/proof/timeout vẫn đạt và toàn Rust library đạt `81 passed, 1 ignored`.

### Chốt runtime Release lô 9 — 2026-08-06

- Năm warm run trước Lô 10: **21,407 / 5,633 / 5,408 / 5,372 / 5,132 giây**; median **5,408 giây**, min 5,132 giây, max 21,407 giây. Cả 5 lần đều `Responding=True`; lần đầu sau khoảng nghỉ là outlier nhưng được giữ nguyên trong số liệu.
- Cold-start thật được tạo bằng cách đổi tên tạm đúng cache `sidecar-1.0.0.3`, chạy một lần rồi xóa cache test mới và khôi phục cache gốc trong `finally`. Cache mới giải nén 923,8 MiB; splash có window handle sau 190 ms, main sẵn sàng sau **7,415 giây**, luôn phản hồi. Sau phép đo: cache gốc tồn tại, backup không còn và không có PID PrynX/sidecar.
- Bản sao QA thiếu `pdf-inspector-backend.exe` và bản đặt sai binary dưới tên sidecar đều ghi `sidecar integrity: FAIL`, không hiện main, tạo dialog bảo mật và thoát sạch.
- Khi listener QA giữ `127.0.0.1:8321`, integrity sidecar vẫn đạt nhưng app không spawn backend, không hiện main, mở dialog bảo mật rồi thoát. Listener được dừng và cổng được nhả sau test.
- Như vậy nhánh fail-closed đã đạt runtime cho thiếu file, sai hash và cổng bị chiếm. Timeout đủ 60 giây không bị kích hoạt chủ ý vì ba lỗi trên đã phủ các đường dừng thực tế mà không kéo dài test.

## Lô 10 — Warm-up frontend theo tier RAM

### §PERF.5 phần 2 — Máy yếu mới giảm preload, máy mạnh giữ full

- Baseline: `scheduleWarmupPdfjs()` luôn tải đồng thời `ImpositionTab` (1.111,76 kB), `AcrobatViewer` (174,57 kB), `LivePageFrame` (1.117,45 kB), warm PDFium và sau 3 giây warm thêm PDF.js/worker; không đọc cấu hình máy.
- `desktop/src/lib/pdfWarmup.ts`: đọc `get_system_memory_status` qua IPC Tauri rồi chọn policy theo RAM lắp đặt:
  - `<8 GB`: chỉ warm native PDFium; không preload workspace/PDF.js.
  - `8–<16 GB`: warm PDFium + chunk `ImpositionTab`; không preload riêng hai chunk còn lại/PDF.js.
  - `≥16 GB`: giữ nguyên toàn bộ ba chunk + PDFium + PDF.js như trước.
  - Không đọc được RAM hoặc payload sai: giữ full; không hạ máy mạnh theo phỏng đoán.
- Follow-up 2026-08-06: `GlobalMemoryStatusEx.ullTotalPhys` có thể thấp hơn RAM lắp đặt do hardware-reserved, khiến máy 16 GB bị xếp nhầm xuống tier trung bình. Tauri nay gọi thêm `GetPhysicallyInstalledSystemMemory`; payload có `installedBytes`, `usableBytes`, `availableBytes`, còn `totalBytes` giữ tương thích nhưng mang giá trị RAM lắp đặt. Mọi consumer cũ dùng `totalBytes` vì vậy cũng không hard-cap nhầm máy 16 GB.
- Frontend ưu tiên `installedBytes`; payload app cũ chưa có trường này fallback về `totalBytes`. Giá trị installed nhỏ hơn total hoặc không hợp lệ bị bỏ qua, không dùng dữ liệu lỗi để nâng tier.
- Workspace warm-up dùng level `primary/full` thay boolean, nên một lần primary không chặn lần full về sau. Timer PDF.js được hủy khi App unmount; import đã bắt đầu vẫn để module loader hoàn tất an toàn.
- Không đổi `SPLASH_MIN_MS=3000`, worker backend, chất lượng preview, PDF output hoặc hình học. Sau follow-up, lô chạm đúng 4 file gồm Rust contract, frontend implementation, test và báo cáo.

### Bằng chứng kiểm thử và runtime lô 10

- Test mới trước implementation: `8 failed` đúng lý do chưa có `warmupPlanForTotalRam`.
- Sau sửa ban đầu: test biên 4/8/15/16/64 GB và `null/NaN/-1` đạt `8 passed`; các ca không xác định đều xác nhận full policy. Follow-up RAM lắp đặt có `3 failed` trước implementation, sau sửa toàn module đạt `11 passed`, gồm máy 16 GB→15,25 GB usable và 8 GB→7,5 GB usable.
- Hai test Rust xác nhận schema camelCase và bất biến `installed = total ≥ usable ≥ available`; toàn Rust library đạt `81 passed, 1 ignored`.
- `npm run typecheck`, `npm run lint:budget`, production `npm run build` và `check:dieline-webview` đều đạt. Toàn frontend: `199 passed`, `1919 passed | 2 skipped`.
- Build Release `--no-bundle` đạt với frontend hash `8aa2933b0dae08cdabbcd79846a5706f705cebc8187b5848417669e9a7d0b7a3`. Artifact `pdf-inspector.exe` có SHA-256 `BE91B1DE93D4FD75A648F4292CE98C9AB07A713746CCA0DC990D202334564FCD`, 31.559.168 byte.
- Năm warm run sau sửa trên máy mạnh: **8,988 / 5,240 / 5,065 / 5,076 / 5,142 giây**; median **5,142 giây**, min 5,065 giây, max 8,988 giây, 5/5 lần luôn phản hồi. So median baseline 5,408 giây, nhánh full không bị chậm đi.
- Runtime Release sau follow-up: splash có handle sau 907 ms, main sẵn sàng sau 6,255 giây, luôn `Responding=True`; đóng main đã dừng sạch cả app và sidecar.
- Chưa có máy vật lý 8 GB/16 GB trong phiên này; policy hai tier thấp đã được xác nhận ở mức unit. Nghiệm thu vật lý còn cần đo first-file latency và peak WebView RSS trên đúng hai tier để lượng hóa phần RAM tiết kiệm.

## Lô 11 — Giảm tải khi app nền và tăng tốc hậu xử lý PPE

### §PERF.9 — Pause polling/render mới khi minimize hoặc mất focus

- `desktop/src/lib/appVisibility.ts`: thêm nguồn trạng thái foreground dùng chung,
  kết hợp `document.visibilityState` với `getCurrentWindow().onFocusChanged`.
  Không đọc được focus native thì fail-open theo document; không tự đoán máy/app
  đang nền.
- Delay polling giữ nhịp 500 ms khi app hiển thị. Nếu app chuyển nền giữa nhịp,
  timer bị hủy; polling đứng yên và tiếp tục ngay khi foreground để lấy trạng thái
  backend mới nhất.
- `processHandlers.ts`: thay sleep cố định của vòng N-Up bằng delay nhận biết
  foreground. Job backend không bị pause/hủy; chỉ UI không hỏi lặp khi người dùng
  không nhìn ứng dụng.
- `tileRenderScheduler.ts`: tile đang chạy vẫn hoàn tất và giữ slot PDFium đến
  `finally`; queue không bắt đầu tile mới khi app nền. Khi foreground, queue được
  bơm ngay và vẫn sắp theo priority/sequence cũ.
- Giữ nguyên toàn bộ WebView2 flags chống occlusion/background throttling; đây là
  workaround cho lỗi render, không phải cơ chế tiết kiệm tài nguyên.

### Bằng chứng kiểm thử §PERF.9

- Baseline test mới fail đúng lý do chưa có `appVisibility`.
- 4 test trạng thái/delay: foreground giữ 500 ms; background không tự resolve;
  chuyển nền hủy timer; foreground resume ngay; document/focus phối hợp đúng.
- 3 test scheduler: tile nền không chạy; tile đang chạy hoàn tất nhưng task kế
  đứng yên; foreground giữ đúng priority.
- Test hẹp gồm process handler: `40 passed`.
- `npm run typecheck` và `npm run lint:budget`: đạt.
- Toàn frontend: `200 passed` file, `1.926 passed | 2 skipped` test.
- Runtime Tauri Release `--no-bundle`, mở fixture PDF 15 trang: visible 4 giây dùng
  250 ms CPU (0,390% toàn máy); minimize 5 giây dùng 0 ms CPU, working set giữ
  46,5 MiB và `Responding=true`; restore tiếp tục `Responding=true`, sau đó app và
  sidecar đóng sạch. §PERF.9 được nâng lên bằng chứng `RUNTIME`.

### §PERF.8 — Song song có chọn lọc các kernel PPE stateless

- Corpus profile chính: `17_tac_heavy_cmyk.pdf`, 300 DPI, 2.550×3.300 =
  8,415 triệu pixel, 4 kênh. Corpus phụ: `image_stems_p4_dct.pdf`, 833×833.
- `print_engine/examples/perf_profile.rs` đo tách riêng render, max TAC, dựng
  plate/coverage và export CMYK; checksum được giữ qua mọi lượt trước/sau.
- `max_tac_percent()` fold trực tiếp theo pixel thay vì dựng `Vec<f32>` full-page,
  tránh khoảng 32,1 MiB buffer tạm ở corpus chính.
- Thêm Rayon 1.12 nhưng chỉ dùng pool global chung; không tạo pool theo request.
  Ảnh dưới 512K pixel giữ đường tuần tự để tránh overhead; ảnh lớn dùng toàn bộ
  pool có sẵn, không hard-cap máy mạnh.
- Chỉ song song kernel thuần dữ liệu: `tac_percent`, `max_tac_percent`, `plate_u8`,
  `plate_coverage_pct`, bước đầu/cuối của `to_process_cmyk`. Merge transparency
  tiếp tục tuần tự; `ColorManager`/LittleCMS không bị chia sẻ giữa thread vì cache
  nội bộ không `Sync`.

### Benchmark trước/sau §PERF.8

Median 5 lượt, mỗi lượt hậu xử lý lặp 5 lần trên máy 32 GB / 16 logical CPU:

| Kernel, corpus 8,415M px | Trước | Sau | Tăng tốc |
|---|---:|---:|---:|
| `max_tac_percent` ×5 | 208,639 ms | 24,174 ms | **8,63×** |
| 4 plate + coverage ×5 | 230,897 ms | 73,553 ms | **3,14×** |
| process CMYK ×5 | 335,917 ms | 154,876 ms | **2,17×** |

- Live binding `pdfcompare_native.ppe_separations` sau rebuild: median 167,401 ms
  cho 5 lượt 300 DPI; max TAC 400,0%; plate đúng thứ tự C/M/Y/K; SHA-256 gộp byte
  kẽm `835583df69f0da4af6fc0b1e08acd74110e21a13eea3b237712142564305fe5f`.
- Test mới ép local Rayon pool 2 thread trên đúng ngưỡng 512K pixel và so toàn bộ
  TAC vector, max TAC, byte plate, coverage, byte CMYK với công thức tuần tự.
- Toàn `print_engine`: `348` unit + `218` integration/golden, tất cả đạt; không
  cập nhật snapshot/golden.
- Native `cargo check --release` đạt; `maturin develop --release` đạt; 117 test
  `test_ppe_native`, facade, memory budget, export image và preflight golden đạt.
- Tauri QA `--no-bundle` dùng sidecar đã xác thực sẵn để test §PERF.9; pipeline
  rebuild production sidecar PPE mới chưa chạy được trong sandbox vì kho khóa DPAPI
  nằm ngoài workspace. Không tạo installer và không gọi artifact QA này là bản
  phát hành chứa §PERF.8.
- Không đổi PDF output, hình học, spot/overprint, layer/tên ốc, Cargo release
  profile hoặc policy RAM/worker hiện hữu.
