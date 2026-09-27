# Audit PDF Viewer: độ trễ, độ nét và tính nhất quán PPE — 27/09/2026

> Cập nhật sau duyệt: các lô sửa A–F đã triển khai và kiểm bằng code/headless. Xem [nhật ký và kết quả sau sửa](PDF_VIEWER_60FPS_FIXES_2026-09-27.md). Phần bên dưới giữ nguyên bằng chứng **trước sửa**; không dùng số liệu cũ làm trạng thái của mã hiện tại. Chưa nghiệm thu FPS màn hình/Acrobat.

## 1. Kết luận điều hành

**Chưa đạt chốt 60fps/zero-jank hoặc bảo đảm mọi pixel hiển thị là PPE soft-proof.** Có bằng chứng về chi phí dựng nét cao, một lỗi nối frame mồi và một khe hở provenance màu. Không có đủ phép đo để quy mọi spike cho GPU, IPC hoặc React; không tuyên bố ngang Acrobat.

1. **Frame PPE mồi bị đứt tại caller:** `AcrobatViewer` không truyền `nativeFilePath` cho `LivePageFrame`. Frame đã chuẩn bị không được đọc lại. Probe dùng AST và chính policy/store từ source tái hiện lỗi; đối chứng có path đọc được frame.
2. **Nút thắt warm-detail còn nằm trên CPU:** path/clip được raster lại theo camera. Trong probe GUI mới, encode detail **107,708–139,543 ms**, riêng clip **39,802–46,006 ms**, trong khi vật liệu đã cache chỉ **0,002–0,004 ms**. Đây là độ trễ lên nét, không phải bằng chứng UI thread bị khóa cùng thời lượng.
3. **Worker PPE thực vẫn mất hàng trăm ms:** đúng PDF outline trang 1, 96 DPI, process/session mới **698,646–732,074 ms**; cùng session **390,555–422,038 ms**. PNG encode chỉ **19–24 ms**: bỏ PNG đơn thuần không giải quyết phần lớn raster.
4. **Native camera nhanh ở nhiều mẫu nhưng không đều:** baseline revision 14 có 19 mẫu input→`present()`, P50 **2,230 ms**, P95/max **72,227 ms**. 4 mẫu GUI mới đạt **1,525–12,692 ms**, quá ít để chốt 60fps. Không phép đo nào trong số này đo scan-out.
5. **Yêu cầu “100% PPE” chưa được khóa xuyên pipeline:** compatibility lane `current/hybrid` có thể trả PDFium cho yêu cầu accurate, không báo lỗi; cache/compositor thiếu metadata về engine thực tạo bytes. Đây là hành vi được test bảo vệ theo chính sách cũ, nhưng không đáp ứng yêu cầu mới.

**Phạm vi thay đổi của lượt audit:** chỉ thêm báo cáo, công cụ chẩn đoán và artifact audit; cập nhật ma trận. Không vá production, không build/restart/kill app, không sửa PDF gốc, không cập nhật golden, không commit/push. Dừng tại chốt duyệt theo `prynx-audit-workflow`.

## 2. Nguồn dữ liệu và giới hạn

### 2.1. Máy và phiên chạy

- Windows thật; Intel i5-13400, 10 core/16 logical processors; RAM lắp 32 GiB, usable 34.107.990.016 byte; RTX 3060; driver Windows `32.0.15.9186`, Vulkan diagnostic `591.86`.
- HEAD khi audit: `bb139dde242804fb44d0514f2c6688bbd686e13a`. Worktree đã có nhiều sửa/untracked của người dùng, bao gồm renderer/viewport. Không dùng HEAD làm fingerprint duy nhất.
- App dev đang chạy PID **11016**, `desktop/src-tauri/target/debug/pdf-inspector.exe`, SHA256 **`4c7a8b752494925df574e2e34ac68fde99fde6e23d6206fb2d5f3308d67f8dc4`**. Hash khớp `PERF_SESSION` đầu phiên và binary dùng cho worker probe.
- Đây không phải installer/release acceptance. Manifest hash source chỉ là snapshot source đọc khi audit, **không chứng minh binary được build từ toàn bộ source đó**.

### 2.2. Không gộp hai PDF khác nhau

| Ca | Input và bằng chứng | Được phép kết luận |
|---|---|---|
| A — file người dùng chỉ định | `test/CMNM2026 - Giay moi_BLUE - in_OUTLINE_FONTS_5e2846.pdf`, trang 1, 18.059.736 byte; SHA256 `e657eab1a222ca11ccbe01554f663405251bfb0952fb79eee5083f9c0ce06dd1` | Worker thật, scene wire, ảnh PPE và GPU headless của đúng file |
| B — cửa sổ đã mở sẵn | UI/log ghi `CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1; `viewer-render-source` ghi đường Desktop/PDF, 17.869.243 byte | Quan sát native pan/zoom và log phiên app; **không đổi tên thành ca A** |
| Phiên host tổng hợp | Có mở thêm VDP 123 trang trong cùng trace FE | Không lấy thống kê toàn phiên làm số đo riêng BLUE |

Hộp chọn file đã được gọi thừa một lần rồi không dùng; không mở thêm tab/PDF. Sau phản hồi của người dùng, thử trực tiếp cửa sổ có sẵn: hai pan ngược chiều, một bước zoom bằng nút và một wheel-scroll. Đã trả zoom về 121% và công cụ chọn; giữ nguyên các tab. Các ảnh chụp UI là điểm quan sát, không phải video 60fps; không suy không-chớp từ vài screenshot.

### 2.3. Artifact tái kiểm

Thư mục [audit/VIEWER_2026-09-27](audit/VIEWER_2026-09-27/):

- `worker-probe/worker-probe.json`: 3 process mới × 3 request cho từng mode scene/PPE; request, response, input/exe/ICC/source hash, timeout và exit code.
- `worker-probe/ppe-run-*-sample-*.png`: 9 PNG PPE thật; không ảnh giả/mock.
- `host11016-baseline.json` + `.evidence.log`: cắt phiên cũ ở epoch `1790445470000`; giữ số dòng gốc.
- `host11016-gui-probe.json` + `.evidence.log`: epoch `1790446040053..1790446235000`, không trộn thời gian benchmark headless sau đó.
- `verify_first_frame_wiring.mjs`: probe hợp đồng caller→policy→store; exit 1 là lỗi đã tái hiện, không phải tool hỏng.
- `pixel-comparison.json`, `gpu-headless/`: ảnh raw/PNG và thời gian của **binary test riêng**, không phải thời gian UI đang chạy.
- `analyze_log.py`, `probe_workers.py`, `verify_pixels.py`: tái tính được; không sửa source sản phẩm.
- `audit-manifest.json`: hash cuối lượt của 24 source/binary/input/profile và kết quả verify; không thay cho build provenance.

FOGRA39 dùng file `backend/app/assets/icc/FOGRA39.icc`, SHA256 `da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77`.

## 3. Trace xuyên tầng đã xác minh

| Hành động | Entry → engine → artifact/consumer thật |
|---|---|
| Mở file/ảnh mồi | `useIncomingFileDispatcher.ts:51–57` → `viewerFirstFrame.ts:254,304–325,377–393` → bootstrap/PPE worker → frame store theo path/token → `LivePageFrame.tsx:3278–3289` → `LiveTile` |
| Native scene | `AcrobatViewer.tsx:3075`/`useNativeGpuViewport.ts:265` → đăng ký IPC `src-tauri/src/lib.rs:8389` → `viewport/commands.rs:116–150` → `scene_cache.rs:59–100` → `scene_worker.rs:34–41,80–99` → `print_engine/src/scene/wire.rs:117–154` → `PreparedScene`/`DocumentRenderer` |
| Native wheel/pan | `win32_host.rs:388–437,580–602` → scheduler/controller → `WM_PAINT:779–850` → latest FrameRequest → `presenter.rs:95–192` → resident compositor → acquire/submit/`present():204–249` |
| Dựng nét | `presenter.rs:176–190` → `refinement.rs:64–132` → `retained_renderer.rs:172–190,219–230,288–353` → CPU path/clip + GPU ink/mask/group/ICC → resident texture/detail cache → present |
| PPE compatibility native | `document_renderer.rs:105–118,165–254` → **Rust executable render worker** → PPE PNG → host decode/row copy/padded upload → cùng native compositor |
| React tile/fallback | `LivePageFrame.tsx` → `useTileRenderer.ts:781–887` → Rust PPE/PDFium worker hoặc HTTP `/preflight/viewer-accurate` → `tileUrlCache` → canvas/DOM layer |

**Không phải một chuỗi nối tiếp Native GPU → FastAPI → React cho mọi frame.** Native GPU đang dùng scene worker Rust; Python/FastAPI là nhánh HTTP fallback của tile viewer. Không quy PDFium Python lock hoặc `heavy_job_scheduler` thành nguyên nhân native wheel khi request không đi qua đó.

## 4. Số đo thực và ý nghĩa đúng

### 4.1. Ca A: process/session mới và dùng lại phiên

Đo tuần tự, bằng EXE đang chạy, không build. “Cold” nghĩa là process/session mới; **không xóa cache filesystem Windows**. N=3 cold, N=6 warm mỗi mode; báo min–max, không dùng N nhỏ để suy P99.

| Mắt xích | Cold (ms) | Warm (ms) | Ghi chú |
|---|---:|---:|---|
| Scene parse | 43,589–55,790 | 0 ở độ phân giải µs | Worker giữ lopdf document |
| Retained scene compile | 271,694–278,503 | 265,828–284,474 | Probe cố ý gửi lại compile; **host scene-cache hit không chạy lại bước này mỗi zoom** |
| Scene request→nhận/consume wire ở probe | 509,679–533,303 | 430,253–470,102 | Gồm startup màu, serialize/pipe và consumer Python |
| Residual ngoài parse/compile | 193,811–203,710 | 159,828–185,628 | **Không phải IPC thuần**; riêng probe SHA tốn 49,926–51,398 ms, JSON decode 5,685–8,817 ms |
| PPE Hello | 30,880–42,501 | Không lặp | Bao initialize/hash PDFium; riêng với request render |
| PPE request→PNG | 698,646–732,074 | 390,555–422,038 | Không gồm GUI/upload GPU/scan-out |
| PPE internal render | 625–652 | 368–399 | Chuẩn bị/raster theo timer worker, chưa phân tách tất cả phase |
| PNG encode | 19–20 | 19–24 | Không phải bottleneck lớn nhất |
| PPE queue/wait fields | 0/0 | 0/0 | Probe tuần tự, **không chứng minh không contention dưới tải** |

Scene wire mỗi request **98.550.669 byte (~93,99 MiB)**, gồm metadata 475.517 byte và hai ảnh 4042×2696: plane Gray 10.897.232 byte; CMYK 43.588.928 byte; alpha f32 43.588.928 byte. Đây là lượng truyền/cấp phát thực, khoảng 5,46 lần kích thước PDF. Wire đã tách ảnh nhị phân, không phải 98 MB JSON.

9 ảnh PPE đều **998×748**, **480.826 byte**, cùng SHA256 `1ab7fe755cb5ebef7d15c5674ad2a0b8c358989d403c0b5258d3fda0c4fffe9b`; response `color-verified`, không font thay thế, `geometry_approximated=false`. Scene không báo dropped object/unsupported transparency/color approximation. Đã xem ảnh thực. Điều này xác nhận artifact của ca A, không chứng nhận tất cả pixel ở mọi zoom/handoff.

### 4.2. Ca B: native camera và thời gian lên nét

Percentile nearest-rank. Revision là khóa nhóm log, chưa phải document identity toàn cục; kết hợp UI/trace để diễn giải. Không trộn page 2/VDP vào hai revision dưới.

| Phạm vi/mắt xích | N | P50 ms | P95 ms | Max ms |
|---|---:|---:|---:|---:|
| Baseline rev 6 — input nhận tại WndProc→`present()` | 35 | 1,587 | 11,921 | 23,700 |
| Baseline rev 6 — encode detail CPU | 13 | 168,061 | 189,183 | 189,183 |
| Baseline rev 6 — clip CPU | 13 | 71,646 | 83,273 | 83,273 |
| Baseline rev 14 — input→`present()` | 19 | 2,230 | 72,227 | 72,227 |
| Baseline rev 14 — encode detail CPU | 10 | 160,911 | 169,002 | 169,002 |
| Baseline rev 14 — request age đến submit xong detail | 10 | 170,436 | 332,237 | 332,237 |
| GUI mới rev 14 — input→`present()` | 4 | 8,910 | 12,692 | 12,692 |
| GUI mới rev 14 — encode detail CPU | 4 | 116,711 | 139,543 | 139,543 |
| GUI mới rev 14 — clip CPU | 4 | 43,372 | 46,006 | 46,006 |

- Baseline rev14 có **2/19 input >16,667 ms**, 1/19 >50 ms. Đây không phải tỷ lệ dropped frame; nhiều input có thể bị coalesce trước khi được đo.
- GUI mới: warm material chỉ **0,002–0,004 ms**, acquire ở 4 input-present samples **0,037–0,064 ms**, resident CPU P50 **1,020 ms**. Không có căn cứ quy toàn bộ chậm của ca này cho GPU upload hoặc chờ swapchain.
- Một **WebView long task 58 ms** xảy ra quanh bước zoom nút trong probe mới (raw dòng 211446). Baseline toàn phiên có 19 long task 52–106 ms, nhưng có nhiều tài liệu/chế độ; chưa có call stack để gán hết cho React.
- Các drag do helper gửi chỉ tạo 4 input samples đã present trong cửa sổ đo. Chưa phải replay wheel/pan liên tục đủ mẫu để nghiệm thu.
- Không dùng `request_to_present_us` của các frame refine sau input cuối làm input latency; cũng không lấy khoảng cách hai present qua lúc idle làm FPS.

### 4.3. Startup app: chậm có thật nhưng telemetry còn thiếu phase

Ở baseline ca B, dòng gốc 205743–205746:

- parse **45,434 ms**, compile **262,944 ms**, transport residual **89,149 ms**;
- shared LUT **65,918 ms**, pipelines **12,714 ms**;
- scene-cache preparation tổng **3.190,769 ms**;
- còn khoảng **2.714,610 ms** chưa được phân bổ cho các span trên.

Phần chưa phân bổ có thể chứa DXGI probe, wait các mutex/resource slots, khởi tạo process/màu hoặc prepare/bind; **chưa được phép gọi 2,7 giây này là parse, IPC hay GPU upload**. UI đổi trang/revision giữa startup và present; không cộng tùy tiện thành một FSP mở trang 1.

Frame mồi của trace này sẵn sàng sau **960 ms** (80 DPI, 831×624; dòng 205681), nhưng không có `tile-first-frame-adopted` trong cửa sổ baseline. Đây phù hợp với probe lỗi nối path, song không cho phép lấy 960 ms làm “thời gian tiết kiệm chắc chắn sau vá”.

### 4.4. Pixel PPE ↔ GPU headless: chưa thể nói đồng nhất 100%

Chạy binary test sẵn có `scene_startup-c77044890b812f5b.exe`, SHA256 `a71351df601df019b37064f89c156ee952f855ae4671637202f267eeb275082a`, trang 1 ca A, scale 96/72, pan 0, 998×748. 3 ảnh GPU cold/warm byte-identical với nhau.

So với PPE PNG: RGB MAE **1,03467/255**; **7,314% pixel** có ít nhất một kênh lệch >2; **2,554%** lệch >10; max channel **141**; exact RGB **43,245%**. Alpha tất cả 255; không có pixel nền native 82/86/89. Đây có thể gồm khác biệt AA/sampling/độ làm tròn/raster, không phải phép đo DeltaE hoặc chứng minh cả trang sai ICC. Chưa có ROI/heatmap phân loại biên và vùng màu phẳng, chưa có golden Acrobat cùng monitor/profile.

“Mọi pixel đi qua đúng hợp đồng proof” khác “hai rasterizer trùng từng byte”: điều đầu đòi provenance/engine/fallback đúng; điều sau còn phụ thuộc AA/sampling. Không dùng tỷ lệ byte khác nhau để tự kết luận FOGRA39 sai, và cũng không dùng cùng tên profile để bỏ qua khác biệt pixel.

**Không lấy timing binary test này so với app:** test riêng có parse 336,750 ms, compile 1.695,803 ms, first-frame 6.898,715 ms; warm 1.429,738–1.565,226 ms. Chưa chứng minh profile/toolchain của test tương đương host đang chạy. Nó được dùng để kiểm artifact/pixel, không báo “PrynX mất 6,9 giây” trên cơ sở test này. Không build binary benchmark mới trong lượt audit.

## 5. Finding xác nhận

Chỉ những dòng dưới có bằng chứng source + probe/test/log mới xếp ưu tiên. Không mặc định tất cả đều là nguyên nhân trực tiếp của cùng một cú khựng.

### §V27.01 — P1 / S — [CONFIRMED] Frame PPE mồi không tới consumer chính

- Caller duy nhất `desktop/src/components/AcrobatViewer.tsx:2682–2727` không có prop `nativeFilePath`, không có spread.
- `LivePageFrame.tsx:3157,3278–3289` dùng prop để subscribe/peek; `desktop/src/lib/viewerFirstFrame.ts:442–448` trả null khi không có path.
- `LivePageFrame(props:any)` ở dòng 3143 khiến typecheck không bảo vệ hợp đồng này.
- Probe đã chạy lại bởi main agent: đối chứng frame/path/token khớp thành công, caller thực không đọc được; exit 1 đúng ca lỗi.
- Hậu quả xác nhận: công việc prime không được tái dùng qua consumer này. Phần latency/RAM/CPU tiết kiệm sau vá cần A/B; không tự lượng hóa từ timer prime.

Vá: truyền native path canonical của **đúng nguồn đang render**, không path cũ khi working PDF thay đổi; thêm integration caller→store→adoption và typing prop hẹp. Kiểm token/profile/rotation, Blob ownership, frame về muộn, metadata hydration sau native success.

### §V27.02 — P1 / L — [CONFIRMED] CPU coverage/clip và detail toàn viewport chi phối lên nét

- `viewer_gpu/src/retained_renderer.rs:182` tạo cache clip/mask/buffer theo frame; `219–230` CPU `Mask::fill_path`, đóng gói coverage.
- `:334–336` còn cấp mask kích thước toàn viewport cho từng clip path; cache hình học trong một frame không tái sử dụng raster giữa camera.
- `viewport/refinement.rs:97–107` dựng detail theo cả viewport, không chỉ vùng mới lộ.
- Log mới dòng 211407/211427/211450/211460 chứng minh encode 108–140 ms, clip 40–46 ms, warm materials gần 0. Baseline có encode 147–189 ms khi pan chỉ vài pixel/giữ zoom.

Vá ưu tiên: cache coverage theo scene/scale/region, tận dụng hợp vùng đã phủ; thiết kế tile neo theo tọa độ trang và raster phần thiếu. Sau đó cân nhắc GPU coverage thật. Không dịch clip sang ô tùy tiện: audit R33 đã từng bác tối ưu làm đổi AA. Phải giữ tọa độ, alpha, mask, overprint và kiểm pixel trước/sau.

### §V27.03 — P2 / M — [CONFIRMED] Trần cache 12 frame và điều kiện hit không xét hợp vùng

- `viewport/presenter.rs:45–51`: máy ≥16 GiB, không memory pressure vẫn trần **12**; chưa tính byte/VRAM thật của từng frame.
- `detail_cache.rs:37–57`: chỉ một frame đủ bốn góc mới là hit; không xét union. Những frame chỉ giao vùng đều nhận cùng timestamp LRU.
- `:70–81` thực thi eviction; probe GUI mới có hai eviction ở dòng 211451/211461 trên máy 32 GiB.

Đây là giới hạn máy mạnh chưa dựa trên ngân sách thực, cần sửa theo quy tắc dự án. **Chưa chứng minh frame A cụ thể bị evict gây hồi quy A→B→A**; nhiều miss xảy ra trước cache đầy. Không giải quyết bằng tăng 12 lên con số khác hoặc xóa hết giới hạn an toàn driver.

### §V27.04 — P1 / M — [CONFIRMED CONTRACT GAP; legacy EXPECTED] Raw PDFium có thể mang nhãn accurate

- `useTileRenderer.ts:608–611,812–824,879–887`: unsupported trong current/hybrid → nhớ trang compatibility → `invokeDisplayPng`, xóa accurate error.
- Test `useTileRenderer.test.ts:695–743` tái hiện chính fallback này và kỳ vọng lỗi UI null; bộ test đã chạy đạt.
- `desktop/src/lib/tileUrlCache.ts:6–14` thiếu actual-engine/profile/proof metadata; `LivePageFrame.tsx:1001,1071–1075,1148–1155` xếp hạng/cache theo colorStage được yêu cầu.
- `useTileRenderer.ts:650–653` current accurate request gắn color-verified trước khi biết bytes thực đến từ đâu; hybrid bảo thủ hơn nhưng vẫn thiếu provenance xuyên cache.

**Không chứng minh ca A rơi nhánh này**: 9 response ca A đều PPE color-verified. Finding là khe hở đường live có test, không phải kết luận PDF đang mở lóe màu.

Vá: typed result mang engine/profile hash/intent/soundness/revision tới cache và compositor. Chế độ proof không được lấp bằng raw PDFium rồi gọi accurate; fallback tương thích phải là trạng thái tường minh, không biến thành ảnh proof hợp lệ. Đổi policy này cần test riêng với trang unsupported và file trắng hợp lệ.

### §V27.05 — P2 / M — [CONFIRMED] Telemetry hiện tại không đo đủ điều cần nghiệm thu

- `scene_worker.rs:93`: transport là elapsed trừ parse/compile, bao cả startup/serialize/decode; không đo IPC độc lập.
- `render_worker.rs:1598–1602,1710`: cold-open session không được tách khỏi total; pool lock/profile/raster còn lẫn.
- `presenter.rs:143–173`: ready nghĩa là submit hết commands, không GPU fence; `resident_us:220–284` bỏ acquire và chứa một phần logging.
- `win32_host.rs:373–379`: timestamp sau khi lấy state lock; thiếu middle-button pan; input chưa present/coalesced không có mẫu riêng.
- Native log `lib.rs:3371–3380` mở/append file đồng bộ; wheel format/log trong UI lock tại `win32_host.rs:407–423`. Chưa có A/B overhead.
- Không GPU timestamp query/completion stage hay present-to-display trace. `surface acquire` riêng chỉ log mẫu ≥8 ms, không dùng làm phân bố tất cả frame.

Vá telemetry trước khi tuyên bố tối ưu: monotonic spans, lock wait/hold, queue age/depth/drop, engine/proof/source hash, input/frame IDs; tách CPU-submit/GPU-complete/displayed. Logging buffer ngoài hot path, lấy mẫu và đo overhead. Không coi snapshot `css_visible=true` là pixel nhìn được khi HWND đè lên DOM.

## 6. Nghi vấn còn mở — chưa xếp P0/P1

| Mã | Chuỗi đã trace | Cần chứng minh tiếp |
|---|---|---|
| S27.01 — producer bên dưới HWND | `AcrobatViewer.tsx:2720` luôn renderEnabled; `LivePageFrame.tsx:6500–6544` vẫn cho accurate base; chỉ viewport TileLayer bị nativePending chặn ở 6689 | Correlate request owner/page với khoảng native visible và A/B freeze producer. Không dùng toàn bộ request cùng trace vì có VDP/tab khác |
| S27.02 — fallback PPE detail bị loại | `document_renderer.rs:249–254` trả FrameStats chỉ encode_us; `presenter.rs:151–164` loại detail draws=coverage=0 và đánh dấu completed | Test qua presenter thật cho trang GPU-unsupported/PPE-supported; hiện test chỉ renderer không đủ. Không thấy cặp engine=ppe-worker + REFINE_EMPTY trên ca đo |
| S27.03 — khóa↔ACK khi lỗi GPU | renderer giữ surfaces lock qua callback, `refinement.rs:118–139` chờ ACK; `presenter.rs:197–202` clear resources lại cần lock | Fault injection error đúng thời điểm, watchdog/stack; chưa tái hiện deadlock, không bỏ lock an toàn theo phỏng đoán |
| S27.04 — React/layout fan-out | mỗi WM_PAINT emit camera (`win32_host.rs:837–839`); hook setCamera vô điều kiện `:93–96`; zoom cập nhật AcrobatViewer và LivePageFrame không memo; rAF measure quét geometry/popup `:159–258` | React Profiler + layout/long-task stacks. Long task 58 ms là thật nhưng chưa chứng minh tất cả do reconciliation |
| S27.05 — handoff/surface proof | hook `contentReady !== false` chấp nhận thiếu field; false sau true không thu quyền; không surface generation | Native producer hiện có field; cần test missing/false-after-true/resize/stale surface, gray/white capture; không dùng tỷ lệ pixel khác trắng làm proof vì PDF trắng hợp lệ |
| S27.06 — minification | current `retained_material.rs:97–99` bỏ mip, shader vẫn tính LOD | Fine lines/checkerboard/ảnh tần số cao, zoom nhỏ và pixel oracle. Không suy bỏ CPU downsample là luôn đúng chất lượng |
| S27.07 — UI create/close surface | `commands.rs:206–240` create/configure trên UI; close/drop/join có thể đợi refiner; material conversion không cancel giữa block | Span UI/thread + close-during-render; khoảng 1.052 ms giữa hai log startup không tự chứng minh CPU block cùng độ dài |
| S27.08 — accurate bypass scheduler FE | `useTileRenderer.ts:735–751` hủy nhóm cũ rồi bypass; `renderCoordinator.ts:333–344` chạy trực tiếp; native vẫn có cancellation lease/admission/worker lanes | Bypass là chủ đích tránh PPE chờ display/yield UI. Chỉ nghi duplicate work khi contention; cần request/coalesce/cancel ACK và queue trace. Không bật lại chung scheduler hoặc ép single-thread vô điều kiện |

## 7. Những kết luận cũ không được lặp lại

- One-notch zoom không còn bị exact-camera cancel ngay: hiện ngưỡng log-scale 0,45/pan 75% viewport.
- Ngưỡng hiển thị detail cũ đã là 0,55; không còn finding “1,15× làm detail bị loại ngay vì 0,9”.
- Mailbox đã chọn khi surface hỗ trợ; presenter đã bỏ `Maintain::Wait` ở mỗi batch.
- CPU mip loop còn trong source nhưng image/shading hiện gọi upload không tạo mip. Không báo lại “CPU mip 9 giây” là bottleneck source hiện tại; kiểm lại trade-off chất lượng.
- Nhận camera React không tự gửi lại tool Hand: effect interaction diff theo field; giả thuyết đó đã bác.
- Native mode chỉ active FOGRA39/relative theo gate; không báo thiếu check custom intent nếu upstream đã ép relative và loại Output Preview.
- Giữ overview→detail là chủ đích hiện tại về độ nét. Không bỏ detail chỉ vì overview đủ density nếu chưa có oracle nét/minification.

## 8. Kế hoạch vá cụ thể sau duyệt

Mỗi lô tối đa 5 file tính cả test; verify xong mới qua lô kế. Không đặt cap chất lượng/worker cho máy ≥16 GiB, không sửa Cargo release profile, không nới golden để lấy tốc độ.

| Lô | File/phạm vi dự kiến | Điều kiện qua lô |
|---|---|---|
| A — nối ảnh mồi (S) | `AcrobatViewer.tsx`, `LivePageFrame.tsx`, một test caller integration, một test first-frame | Probe hiện đỏ→xanh; đúng token/profile/working PDF; adopt đúng một lần; không render base trùng chỉ vì thiếu path; không revoke Blob sớm |
| B1 — phase/lock telemetry (M) | `scene_cache.rs`, `scene_worker.rs`, `render_worker.rs`, một test protocol, audit parser | Phân bổ gap 2,7s; tách process/parse/compile/serialize/pipe/decode/pool-lock; không đặt tên residual thành IPC |
| B2 — frame/input và log overhead (M) | `presenter.rs`, `win32_host.rs`, `lib.rs`, một test, collector | Stamp đủ pan; input→submit và drop/coalesce đúng; log không I/O đồng bộ trong UI lock; A/B overhead |
| B3 — GPU/display collector (M) | `device.rs`, renderer timestamp helper, presenter, collector, một test | Upload/compute/complete riêng; phân biệt call-present với displayed; thiết bị thiếu query báo unavailable, không giả zero |
| C1 — proof provenance (M) | `useTileRenderer.ts`, `tileUrlCache.ts`, coordinator contract, hai test | Raw PDFium không mang accurate key/rank; profile/intent/revision thật theo bytes; unsupported tường minh |
| C2 — handoff và sở hữu producer (M) | `LivePageFrame.tsx`, `useNativeGpuViewport.ts`, `NativeGpuViewportContainer.tsx`, hai test | Giữ bitmap proof cuối nhưng ngừng render mới khi native hợp lệ; native invalid khôi phục producer; metadata/prefetch lifecycle không bị treo |
| C3 — native PPE detail/proof (M) | `document_renderer.rs`, `refinement.rs`, `presenter.rs`, test presenter, fixture | FrameProof không dựa draws; PPE fallback vẫn lên nét; white page đúng; stale scene/surface không giành quyền |
| D1 — cache theo byte/vùng (M–L) | `detail_cache.rs`, `resident_present.rs`, `presenter.rs`, `refinement.rs`, test | Hợp vùng phủ; A→B→A tái dùng thực; không trần 12 trên máy mạnh vô căn cứ; áp lực RAM/VRAM vẫn an toàn |
| D2 — coverage/clip (L) | `retained_renderer.rs`, helper raster/cache, test parity, harness, fixture | Warm clip giảm rõ; tọa độ/AA/mask/overprint giữ nguyên; không chia ô làm đổi biên âm thầm |
| E — React camera/layout (M) | hook native, container, AcrobatViewer, hai test | Dedup snapshot; geometry dirty-driven; native input không chờ shell; profiler chứng minh giảm commit/layout, không chỉ giảm timer |
| F — recovery/teardown (M) | presenter, refiner, document renderer, commands, fault-injection test | Không lock↔ACK/join dài trên UI; device lost/resize/tab-close không treo; fallback đúng proof |

Lô C1/C2/C3 phải kiểm hợp đồng đầu-cuối với nhau; không ship trạng thái nửa chuyển schema. Lô D2 có rủi ro hình học/pixel cao nhất, cần A/B artifact trước khi thay renderer chính. Không đề xuất tăng thread bừa để che chi phí raster.

### KPI nghiệm thu đề xuất, chưa phải cam kết kết quả

- Camera interaction: frame budget 16,667 ms trên màn 60 Hz; báo P50/P95/P99 và tỷ lệ miss theo frame **trong đoạn đang tương tác**, không gộp idle; đo displayed nếu công cụ hỗ trợ.
- Fresh opening: FSP phải là frame PPE đúng revision/profile có pixel thật, không chỉ scene-ready; cold/warm đo riêng, ≥30 lượt sau khi pipeline/collector ổn.
- Time-to-sharp: đo cả lúc đang pan/wheel và sau nhả; mục tiêu giai đoạn đầu P95 ≤100 ms, mục tiêu tiếp theo ≤50 ms trên ca chuẩn, phải giữ chất lượng. Không coi kéo ảnh cũ 60fps là trang đã lên nét 60 lần/giây.
- Không raw-PDFium takeover trong proof mode; mỗi frame có engine/profile/intent/proof ID. Video/capture quanh mở/zoom đảo chiều/page switch/resize; blank PDF không bị coi là lỗi.
- Chất lượng: ROI vùng màu phẳng + biên chữ/vector + gradient/alpha/spot/overprint; cùng page box/DPR/zoom/profile và golden PPE/Acrobat. Không dùng MAE toàn trang một mình để duyệt.
- Không hồi quy máy mạnh; ca áp lực RAM thấp/VRAM, tab nền, nhiều tab, cancel/retry, device lost, monitor DPI và bản đóng gói cần wave verify riêng.

## 9. Kiểm thử đã chạy và phần chưa chạy

- Worker protocol self-test đạt; **18 request thật** (9 scene + 9 PPE) hoàn tất, child chỉ do harness sở hữu được dọn; PDF/exe hash trước/sau khớp.
- Main chạy lại 4 file Vitest: **83/83 đạt**. Có diagnostic jsdom `HTMLCanvasElement.getContext` ở test fallback nhưng không assertion fail; không che log này.
- Probe missing-nativeFilePath: **FAIL dự kiến**, đối chứng dương đạt; xác nhận finding §V27.01.
- GPU headless test sẵn có: **1/1 đạt**, 3 cold/warm camera-0 artifacts cùng hash; không dùng timing nó làm SLA app.
- Pixel comparator đã chạy, xem cả PNG PPE/GPU; độ lệch ghi trung thực, không thay snapshot/golden.
- `npm run typecheck`: **đạt, exit 0**; không coi typecheck là bảo vệ prop `any`.
- Chưa full Vitest/pytest, chưa build Rust/release, chưa A/B Acrobat, chưa GPU execution timestamps/OS display trace, chưa đo lock contention/fault injection và chưa continuous wheel replay đủ mẫu. Không yêu cầu dừng môi trường dev để ép chạy test/build.

## 10. Chốt audit

Độ phủ đạt: trace cả ba nhánh, source/contract probes, worker artifact của đúng file A, telemetry phiên app và probe GUI hẹp của file B. Không nâng toàn bộ Viewer lên `RUNTIME` nghiệm thu vì thiếu đồng nhất input/build/collector/pixel oracle ở các ca UI.

**Đề nghị duyệt A → B1/B2 → C1/C2/C3 → D1/D2 → E/F**, B3 song song khi không cạnh tranh tài nguyên benchmark. A là quick-win có lỗi cụ thể; B định vị gap startup; C giữ đúng màu và quyền hiển thị; D mới đánh vào chi phí lên nét chính. Chưa có bản vá production trong lượt này.
