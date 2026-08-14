# PPE NATIVE VIEWER — NHẬT KÝ TRIỂN KHAI 2026-08-13

Tài liệu này theo dõi các lô đã được duyệt từ
`BAO_CAO_AUDIT_PPE_NATIVE_VIEWER_2026-08-13.md`. Mỗi lô tối đa 5 file và phải verify
hẹp trước khi chuyển lô. Không build production/installer nếu chưa có chỉ đạo riêng.

## Lô 0A — Baseline trước khi thay engine

**Trạng thái:** baseline core 30/30 và WebView2 30 cặp cold-open/warm-zoom đã hoàn tất trên
Standee thật; pixel gate và PPE-only gate đạt. Bản sửa runtime chống phát lại cùng request đang bay
đã qua test/typecheck và chính ca WebView thật. Baseline Viewer chính đủ để người dùng test và làm
mốc tối ưu Lô 1A; phép đo cold-app sạch chưa chạy vì phiên này không được phép restart PrynX.
Baseline thumbnail hiện tại mới có smoke riêng và xác nhận vẫn còn đi PDFium, nên cutover thumbnail
ở Phase 7 chưa đóng.

**File mã đo thay đổi trong lô:** 4

1. `print_engine/examples/perf_profile.rs`
2. `scripts/ppe_viewer_baseline.py`
3. `scripts/ppe_viewer_webview_baseline.mjs`
4. `scripts/measure_process_tree_memory.ps1`

Tài liệu nhật ký này không tính là code runtime. `print_engine/Cargo.toml` và `Cargo.lock` giữ
nguyên; probe dùng dependency `flate2` sẵn có.
Hồ sơ audit/kế hoạch/ma trận cũng được cập nhật để phản ánh đúng mức bằng chứng nhưng không mở rộng
blast radius runtime của lô.

### Hợp đồng đo

- `perf_profile` mở một `RenderSession`, tách pha mở (`file/parse/resource/color`) khỏi pha
  render (`open/parse/resource/raster/color`) và PNG encode, rồi lặp warm trong cùng session.
  Probe dùng `FOGRA39 + Relative + View OCG + annotation + DejaVuSans fallback` giống đường
  PPE Viewer runtime. Render/cache budget là tham số
  tường minh (mặc định probe 1536/512 MiB) và được ghi vào report; đây không phải policy runtime
  và không hard-cap ứng dụng trên máy mạnh.
- `total_wall_ms` đo trực tiếp toàn khoảng render + checksum + PNG encode + lấy cache stats;
  không còn suy ra bằng phép cộng hai timer con.
- `encode_ms` chỉ là PNG proxy RGB/filter-None qua `flate2` đã có sẵn; report gắn
  `runtime_equivalent=false` vì worker thật dùng `image::PngEncoder`. Không thêm dependency
  và không làm lệch `Cargo.lock` chỉ để phục vụ probe.
- `ppe_viewer_baseline.py` khởi động process probe độc lập cho mỗi cold run, kiểm SHA-256
  Standee khi được yêu cầu, kiểm binary mới hơn toàn bộ core/asset liên quan, lấy P50/P95 và peak
  working set của process probe từ bộ đếm peak do Windows duy trì (kèm sampled max 10 ms để đối
  chiếu). FFI khai báo HANDLE/pointer tường minh cho Windows 64-bit và giữ một handle đo cho suốt
  vòng đời process thay vì mở/đóng handle mỗi 10 ms. Thiếu peak counter làm baseline fail; binary
  được khóa size/mtime/ctime/SHA-256 và render signature gồm kích thước/byte/checksum phải ổn định
  giữa mọi process cold. Report không lưu đường dẫn file khách.
- Nếu người dùng ngắt core harness, nó chỉ terminate/kill đúng process probe do chính nó tạo rồi ghi
  checkpoint partial; không tìm/kill PrynX, Node, Python hay process dev khác.
- `ppe_viewer_webview_baseline.mjs` nối WebView đang chạy qua CDP và đo theo từng cặp
  `cold-open → warm-zoom` trên cùng tab/document session:
  - Page Shell: khung trang đã có hình học;
  - FSP: viewport Viewer thực (giao của trang với `.acro-scroll`) được phủ và compositor thật có pixel nội dung;
  - FCVF: frame nét, phủ viewport, có pixel nội dung và ổn định hai lần chụp liên tiếp;
  - blank-gap: thời gian khung đã tồn tại nhưng compositor không còn surface pixel nhìn thấy; chờ
    PPE mới trong khi surface cũ vẫn hiện không bị tính là blank.
- Baseline WebView Lô 0A đo **trang chính với panel thumbnail đóng có kiểm soát**. Harness đóng tab
  đo cũ, mở một Viewer mới (store mặc định `viewerThumbMenuOpen=false`), xác nhận lại đúng store của
  file ở từng lượt và ghi evidence vào report. Harness không đổi trạng thái thumbnail của tab khác.
  Lý do: thumbnail hiện còn gọi `render_pdf_page` (PDFium), nên để panel mở sẽ trộn chi phí/lane của
  thumbnail vào FSP/FCVF trang chính. Đây không phải bỏ qua thumbnail: baseline runtime thumbnail
  là gate tách riêng và vẫn còn mở trước cutover Phase 7.
- WebView gate quan sát request/response IPC custom protocol của đúng target WebView qua CDP
  (không monkey-patch `window.__TAURI_INTERNALS__.invoke`, vì Tauri 2.11 khai báo thuộc tính này
  không writable/configurable). Nó ghi từng `render_ppe_page`, `render_pdf_page`,
  `shadow_render_ppe_page`, request ID, pipeline identity cùng trạng thái
  fulfilled/rejected/pending. Run chỉ hợp lệ khi cấu hình runtime từ bootstrap/metadata xác nhận
  là `ppe-only`, shadow tắt, mọi PPE call đều fulfilled với request ID duy nhất + đúng pipeline,
  đúng trace sequence hiện hành và tuyệt đối không có display/shadow call. Vì vậy response muộn của
  transition trước, process PrynX khác và log file chung không thể
  làm nhiễu gate.
  `PrynX_RenderPerf.log` (nếu debug build hoặc `PRYNX_PERF=1`) chỉ là timing bổ sung, không phải
  nguồn chứng minh PPE-only.
- Response bootstrap/metadata chỉ được dùng làm gate cấu hình khi payload request mang đúng
  `filePath` của Standee. Metadata của tab nền vẫn được ghi đếm riêng nhưng không thể ghi đè
  `viewerConfig` của lượt đo; cold run thiếu response đúng path vẫn fail. Mọi response cấu hình
  đúng path trong cùng trace đều phải báo `ppe-only` và shadow tắt; một response mâu thuẫn làm
  fail cả lượt dù response hợp lệ đến sau có ghi đè trạng thái cuối.
- Candidate PPE có clip không còn được nhận chỉ vì “có clip”. Harness đối chiếu request với
  `LiveTile` đang hiển thị theo path, trang, DPI/zoom, rotation, clip và kích thước bitmap, rồi tính
  hợp các tile đó có phủ ít nhất 98% viewport thật hay không. Nguồn ảnh DOM còn phải đổi so với
  snapshot trước trigger, nên props/request mới không thể làm bitmap cũ được tính là frame mới.
  Request còn phải bắt đầu sau trigger; request nền đã khởi phát trong khoảng chuẩn bị nhưng hoàn
  tất muộn không được tính là frame mới. Self-test có clip đúng, clip nằm sai viewport, surface cũ,
  request bắt đầu trước trigger và viewport ghép bởi hai tile.
- FCVF tính độ nét theo `naturalWidth/Height ÷ (CSS rect × devicePixelRatio)`, không lấy CSS pixel
  làm chuẩn; cho sai số làm tròn tối đa 2% rồi vẫn bắt buộc phủ ít nhất 98% viewport.
- Run thiếu source identity hoặc thiếu bằng chứng PPE-only được ghi vào report rồi fail ngay;
  timeout/thiếu pixel gate cũng fail ngay thay vì ghi nhầm lượt là hợp lệ rồi chạy tiếp. Report chỉ
  có `complete=true` khi đủ mẫu và toàn bộ pixel gate đạt.
- Cả hai report không lưu path; WebView còn không lưu `sourceKey` hay request ID thô: identity DOM
  chỉ giữ tên/phase/số trang, request ID được băm ngắn và mọi chuỗi report được che `<PDF_PATH>`.
  Self-test khóa cả path thô lẫn path URL-encoded để report partial/HTTP error không làm lộ đường
  dẫn file khách.
- Cả hai harness từ chối nếu output trùng với PDF đầu vào và ghi report bằng thay thế atomic. Core
  checkpoint lại report `complete=false` sau từng cold run; nếu probe hỏng giữa 30 lượt, các sample
  đã hoàn tất cùng `failedRun/completedRuns` vẫn còn để chẩn đoán thay vì mất toàn bộ phép đo.
- Mặc định WebView harness từ chối PDF không khớp SHA-256 Standee đã audit (chỉ bỏ gate khi đặt rõ
  `PRYNX_VIEWER_BASELINE_REQUIRE_STANDEE_HASH=0` cho corpus khác). Hai harness khóa size/mtime trong
  từng run và băm lại trước khi chốt để không trộn hai revision của file save-over.
- Hai stable frame chỉ được tính từ hai screenshot mới khác lượt chụp. FSP/blank-gap lấy mốc
  sau khi screenshot + pixel probe hoàn tất nên có tính cả overhead compositor quan sát được.
  Report lưu thêm `contentBounds` chuẩn hóa trong surface để baseline bắt được hiện tượng Standee
  bị lệch/crop khi so trước–sau; đây là số đo theo bounding box pixel, chưa thay kiểm chứng ảnh Acrobat.
- Trước mỗi transition, harness chờ mọi IPC trace cũ về terminal rồi mới reset; request cũ còn
  pending quá 5 giây làm lượt đo fail thay vì bị xóa khỏi trace và hoàn tất lẫn vào cửa sổ mới.
- Khi kết thúc, harness chỉ ngắt transport CDP phía Playwright; không gọi `Browser.close`, không
  tắt WebView/PrynX của người dùng. Lỗi cleanup CDP/listener vẫn được ghi vào report, hạ
  `complete=false`, làm lệnh đo thoát lỗi và không làm mất report cuối.
- Playwright trên session CDP thật vẫn có thể giữ handle nội bộ sau khi transport đã ngắt. Sau khi
  đã await cleanup và ghi report atomic, harness thoát rõ ràng bằng mã 0/1 của **chính process Node**;
  smoke xác nhận không còn Node treo và PrynX giữ nguyên PID/thời điểm khởi chạy/CDP target.
- Harness không ghi đè auth/license hoặc bật `DEV_MODE`; app phải ở trạng thái người dùng hợp lệ
  trước khi đo. Nếu WebView/Tauri chưa sẵn sàng, harness fail thay vì giả mạo phiên.
- Cold run xóa tile theo namespace `pdfUrl` thật đã chụp trước khi đóng tab (path chỉ fallback),
  đồng thời bắt buộc lệnh đóng document cache **thực thi thành công** trước khi đo. Kết quả
  `documentClosed=true` nghĩa là đã xóa entry; `false` nghĩa là cache vốn đã rỗng. Cả hai đều là
  cold state hợp lệ; chỉ command reject/error mới fail run. Harness còn dò các `LiveTile` còn
  mounted theo namespace để xác nhận không lấy lại được entry sau clear; nếu vẫn còn cache thì fail.
- Tab đo cũ được định danh bằng path trong đúng Workspace store rồi mới đóng; không dùng tên tab
  nên không đụng nhầm file khác trùng tên. Nếu Standee đã mở trước khi chạy, harness fail và yêu
  cầu người dùng tự đóng — không tự đóng tài liệu có sẵn. Sau warm, harness chỉ đóng đúng tab do
  chính lượt đo vừa tạo (đối chiếu cả `tabId` lẫn path) và chờ store của path đó biến mất trước
  cold run kế tiếp.
- Tab active và Viewer active được nối từ Workspace store theo path/tabId tới đúng container
  `data-prynx-tab-active=true`; harness không còn dựa vào class trình bày `font-semibold`.
  Dispatcher của PrynX vẫn tự kích hoạt tab vừa mở như đường người dùng thật; harness không click
  thay ứng dụng trong cửa sổ timing. Nếu tab không trở thành active đúng path, lượt đo fail thay vì đo nhầm.
- Warm zoom giữ nguyên tab/PPE session và surface cũ, rồi đổi zoom 1,5× (hoặc 0,67× khi đã
  quá 200%); với file cực lớn đang fit, đích tối thiểu là 200% để chắc chắn thoát sàn 24 DPI trên
  toàn miền raw-DPI hợp lệ và tạo một request raster mới. FSP chỉ được công nhận sau khi hình học
  trang đã đổi. Đóng tab sau warm để cặp
  cold tiếp theo không kế thừa session. Harness không xóa Blob đang hiển thị nên blank-gap
  phản ánh ứng dụng thật, không phải nhiễu do công cụ đo.
- Blank-gap chỉ tính khi surface compositor đang nhìn thấy thật sự biến mất; thời gian chờ frame PPE
  đích trong lúc surface cũ vẫn còn hiện không bị ghi oan thành khung trắng/trong suốt.
- Hai report tách rõ phạm vi. Số core không được dùng thay FSP/FCVF; peak working set probe
  không được gọi là RSS toàn cây ứng dụng. Scope WebView là
  `end-to-end-webview-main-page-thumbnail-closed`, không được gọi tắt thành baseline toàn Viewer.

### Kết quả runtime ngày 2026-08-14

Artifact khóa đúng Standee SHA-256
`D3AFDAA6C3940F0431FE26EA3CBEEDB8E59FE85C2A802DB49A95BE856868F61C`.
Không build production/installer, không chạy `run_dev.bat`, không restart/tắt PrynX.

| Phép đo | P50 | P95 | Ghi chú |
|---|---:|---:|---|
| Core open | 12,851 ms | 16,780 ms | 30 process cold |
| Core first render | 3.814,435 ms | 4.364,219 ms | full-page 96 DPI, có PNG proxy |
| Core warm render | 3.507,069 ms | 7.585,140 ms | cùng RenderSession |
| Core peak working set | 1.207,902 MiB | 1.209,605 MiB | process probe, không phải toàn app |
| WebView Page Shell cold | 294 ms | 329 ms | 30 cold-open |
| WebView FSP cold | 1.511 ms | 1.798 ms | viewport + compositor pixel |
| WebView FCVF cold | 1.801 ms | 2.092 ms | nét + hai screenshot ổn định |
| WebView blank-gap cold | 847 ms | 1.133 ms | max gap trong từng lượt |
| WebView FSP warm zoom | 803 ms | 844 ms | 30 warm-zoom |
| WebView FCVF warm zoom | 1.171 ms | 1.204 ms | max 1.506 ms |
| WebView blank-gap warm | 0 ms | 0 ms | giữ surface cũ trong lúc đổi zoom |

- Report chính thức:
  `.tmp/ppe_viewer_baseline/webview-baseline-after-live-tile-fix.json`; đủ 60/60 lượt hợp lệ,
  `complete=true`, pixel gate đạt.
- Trace toàn phiên: `900/900` PPE fulfilled, `0` rejected, `0` pending, `0` stale,
  `0` display, `0` shadow; mọi source/path/payload/request identity gate đạt. 257 console entry
  chỉ là cùng một lỗi dev-resource `ERR_CONNECTION_REFUSED`; `badHttp=0`, không có lỗi render.
- Bộ đo RAM riêng lấy mẫu **tổng cùng thời điểm** toàn process tree mỗi 25 ms, không cộng các peak
  lịch sử rời nhau: peak working set `2.889,555 MiB`, peak private `2.241,938 MiB`, tối đa 26
  process, 23 mẫu/3.571 ms và `0` process-read failure. Report:
  `.tmp/ppe_viewer_baseline/process-tree-memory-after-live-tile-fix.json`. Đây là session app
  hiện hữu sau baseline, không phải cold-process mới; dùng làm peak toàn cây runtime của một cặp
  Standee, không dùng làm số startup/cold-app.
- Smoke thumbnail tách biệt trên chính tab Standee: 1 thumbnail `302×661`, đúng một
  `render_pdf_page` hoàn tất HTTP 200 trong `587 ms`, `0` PPE call và không có console error.
  Đây là bằng chứng đường hiện tại hoạt động, đồng thời xác nhận thumbnail **vẫn phụ thuộc PDFium**;
  không được dùng để nâng trạng thái cutover PPE thumbnail.
- Mở lại Standee sau phép đo đạt: 1 trang, `800 × 1750 mm`, không có load error, các surface PPE
  hoàn tất; ảnh runtime lưu ở `.tmp/ppe_viewer_baseline/standee-open-after-fix.png`.

### Cách chạy sau khi app dev đã sẵn sàng

```powershell
backend\venv\Scripts\python scripts\ppe_viewer_baseline.py `
  "C:\Users\Khanh Pham\Desktop\Standee_800x1600mm-1.pdf" `
  --cold-runs 30 --warm-repeats 2 --dpi 96 `
  --render-budget-mib 1536 --resource-cache-budget-mib 512 `
  --require-standee-hash

$env:PRYNX_VIEWER_BASELINE_PDF = "C:\Users\Khanh Pham\Desktop\Standee_800x1600mm-1.pdf"
$env:PRYNX_VIEWER_BASELINE_RUNS = "60"
node scripts\ppe_viewer_webview_baseline.mjs
```

WebView harness mặc định khóa đúng fingerprint Standee. Khi chủ đích đo một file corpus khác, đặt
`PRYNX_VIEWER_BASELINE_REQUIRE_STANDEE_HASH=0`; report vẫn ghi tên, size và SHA-256 của artifact.

WebView phải được khởi động sẵn với `PRYNX_VIEWER_ENGINE_MODE=ppe-only` và shadow tắt; harness
không tự ghi hai biến runtime này vì đổi env sau khi process đã chạy không có tác dụng và việc tự
khởi động lại PrynX nằm ngoài quyền của Lô 0A. Response bootstrap/metadata của chính run là gate cuối.
CDP `127.0.0.1:9223` cũng phải do chủ dự án bật tạm trên phiên dev đo riêng; `lib.rs` cố ý không mở
remote debugging và release còn dọn biến WebView2 debug. Harness không hạ hardening để tự nối vào app.

`60` lượt WebView tạo 30 cặp cold-open (đóng cache/document do PrynX sở hữu, không xóa
cache hệ điều hành) và warm-zoom trên cùng session. Cold app/process thật vẫn cần session app độc lập nếu
muốn đo startup; harness cố ý không tự khởi động/tắt app để không can thiệp phiên người dùng.

Harness core chỉ chạy `print_engine/target/release/examples/perf_profile.exe` đã tồn tại; nó
không gọi Cargo và không tự build. Sau khi source probe thay đổi, cần được chủ dự án cho phép
compile lại binary này trước khi lấy số chính thức. Harness từ chối binary cũ hơn bất kỳ source
Rust nào trong `print_engine/src`, chính probe, manifest/lockfile hoặc asset FOGRA39/font dự phòng; report
cũng kiểm fingerprint hai asset và toàn bộ hợp đồng schema/options/budget/sample. Smoke binary cũ
ngày 2026-08-13 đã dừng ở trần 512 MiB trên Standee; không có số hiệu năng nào từ lượt đó được
công nhận.

### Gate trước Lô 1A

- `[ĐẠT]` Standee đúng SHA-256
  `D3AFDAA6C3940F0431FE26EA3CBEEDB8E59FE85C2A802DB49A95BE856868F61C`.
- `[ĐẠT]` Tối thiểu 30 mẫu cold-open và 30 mẫu warm-zoom hợp lệ; report ghi P50/P95.
- `[ĐẠT]` Mọi mẫu FCVF vượt pixel gate compositor, không chỉ `img.complete`.
- `[ĐẠT]` Mọi mẫu xác nhận runtime đúng `ppe-only`, shadow tắt và IPC trace đúng WebView; thiếu/trùng
  request identity, sai pipeline, PPE rejected/pending hoặc lọt display/shadow lane là fail.
- `[ĐẠT]` Mỗi cold-open bắt được response bootstrap/metadata cấu hình engine trong chính lượt đó;
  không được kế thừa bằng chứng của lượt trước. Warm-zoom được kế thừa cấu hình vì nằm trong cùng
  tab/document session với cold-open ngay trước nó.
- `[ĐẠT cho baseline trang chính]` Mọi mẫu xác nhận thumbnail đóng trong đúng Workspace store; report này không được dùng làm số
  baseline thumbnail. Trước Phase 7 phải có baseline thumbnail riêng và sau cutover phải chứng minh
  không còn `render_pdf_page` trong cả Viewer chính lẫn thumbnail.
- `[ĐẠT core + phiên app hiện hữu; CÒN MỞ cold-app sạch]` Có peak working set core và một phép đo
  RSS toàn cây ứng dụng tách riêng; chưa restart app chỉ để lấy số cold-process.
- `[ĐẠT]` Chưa đổi engine kiến trúc, chưa stage/commit, chưa build production trong lô này.

### Verify đã chạy

- `node --check scripts/ppe_viewer_webview_baseline.mjs`: đạt.
- WebView harness self-test schema 2 (coverage, sharp coverage, parser URL IPC, lifecycle
  pending→fulfilled + pending quá hạn, mode/shadow/pipeline/request/path gate, config đúng/sai path
  + stale sequence + response cấu hình mâu thuẫn, request bắt đầu trước/sau trigger, clip đúng/sai
  viewport + union nhiều tile, mật độ device-pixel, pixel gate fail-closed, warm target thoát sàn
  24 DPI, mixed PPE rejected/pending, semantics cache removed/already-empty, định danh tab theo path,
  same-file guard, redaction path thô/URL-encoded, atomic report và ngắt CDP không gọi
  `Browser.close`): đạt.
- `python -m py_compile scripts/ppe_viewer_baseline.py`: đạt.
- Core harness self-test schema 2 (percentile, open/render stage, first/warm stage, Windows
  process-memory counter bắt buộc, render signature cross-run, cleanup terminate→kill đúng child
  probe, same-file guard, atomic report): đạt.
- `rustfmt --edition 2021 --check print_engine/examples/perf_profile.rs`: đạt.
- `cargo metadata --manifest-path print_engine/Cargo.toml --locked --offline --no-deps`: đạt.
- `git diff --check`: đạt.
- Git blob `print_engine/Cargo.toml` và `Cargo.lock` trùng HEAD; Lô 0A không đổi manifest/lockfile
  dù `git status` trên máy vẫn hiển thị `Cargo.toml` do trạng thái working-tree/line ending có sẵn.
- Fingerprint runtime đã đối chiếu lại: Standee, FOGRA39 và DejaVuSans đều khớp SHA-256 đã khóa.
- Probe được compile riêng theo đúng quyền đã cho, không build PrynX/installer; core baseline 30/30 đạt.
- WebView2 thật: cleanup smoke 2/2, baseline chính thức 60/60, pixel/PPE-only gate đạt; PrynX sống
  nguyên phiên và Standee được mở lại thành công.
- Frontend liên quan: 73/73 test, typecheck và `git diff --check` đạt.
- Chưa build production/installer, chưa stage/commit/push.

### Khoảng trống còn mở

- `scene_ms` chưa tồn tại vì PPE hiện chưa có SceneCompiler; phải ghi `not-applicable`, không
  gộp giả vào `resource_ms`.
- WebView harness đo `decode + swap + compositor` theo ranh quan sát được; muốn tách chính xác
  decode và swap cần thêm event identity trong compositor ở lô sau.
- PPE fulfilled và pixel hiện chỉ được tương quan trong cùng transition: request phải hoàn tất trước
  screenshot, đối chiếu đúng `LiveTile` theo trang/DPI/xoay/clip và hợp các tile phải phủ viewport;
  tuy nhiên compositor chưa công khai request ID gắn trực tiếp với surface đang hiển thị.
  Harness lọc candidate phát sinh sau trigger theo transition + path + trang + ưu tiên interactive +
  hình học request/DOM và ghi
  `post-trigger-path-page-interactive-geometry-candidate-no-compositor-request-id`; không được diễn giải thành parity
  request → pixel tuyệt đối cho tới khi có event/surface identity ở lô sau.
- Log native chưa có request ID trong các dòng `PPE_NATIVE_RESULT/IPC_PPE`; timing native từ log
  vì vậy vẫn chỉ là bằng chứng bổ sung. Gate pipeline đã tương quan request ID ở biên IPC WebView;
  muốn nối request ID sâu đến worker/native timing cần instrument Tauri ở lô riêng.
- Cấu hình `ppe-only` và trace custom-protocol đã được gate trên WebView2 thật qua 60 lượt; khoảng
  trống còn lại là request ID trực tiếp trên compositor surface, không phải khả năng quan sát CDP.
- CDP là công cụ dev tạm thời và không được bật trong release; smoke cần một session dev đo riêng,
  không sửa hardening/installer chỉ để phục vụ baseline.
- Thumbnail vẫn dùng PDFium tại `desktop/src/components/acrobat/ThumbSidebar.tsx`; Lô 0A chỉ cô lập
  nó khỏi phép đo trang chính. Baseline/correctness thumbnail và gate loại PDFium toàn Viewer vẫn
  là khoảng trống runtime, không được suy ra từ report trang chính.
