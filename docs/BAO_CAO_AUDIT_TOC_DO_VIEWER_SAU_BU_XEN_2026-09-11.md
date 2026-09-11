# Audit tốc độ Viewer sau bù xén vuông góc - 2026-09-11

**AUDIT-ONLY - CHỜ DUYỆT.** Không tích hợp tối ưu vào mã sản phẩm trong lượt này.

## 1. Kết luận điều hành

Với ca CMNM2026 được người dùng cung cấp, chậm chính là **dựng lại PDF kết quả
bằng PPE**, không phải thời gian sinh PDF bù xén hay mở/đọc file.

- Engine bù xén trực tiếp 4 trang: 673,2 / 675,9 / 772,0 ms, trung vị **675,9 ms**.
  Không gồm HTTP admission, chuẩn bị Working PDF, watermark hay handoff vào Viewer.
- Session PPE mở tài liệu chỉ khoảng **32 ms**.
- PDF kết quả, trang 2: lượt đầu **5,34 s**, trung vị 3 lượt raster nóng **4,81 s**.
- PDF kết quả, trang 3: lượt đầu **9,78 s**, trung vị 3 lượt raster nóng **7,90 s**.
  Khoảng **99,3%** của lượt trung vị là pha raster, không phải chuyển màu cuối.
- Artifact bù xén gọi cùng Form artwork **9 lần/trang**: một lần cho nội dung
  chính, bốn cạnh và bốn góc. Việc giữ màu bằng vector có chủ đích, nhưng PPE
  vẫn giải mã/biên dịch và xử lý lại nội dung lồng nhau qua các lần gọi này.
- Cache session đang hoạt động; không có eviction trong bộ đo. Cache ảnh/chương
  trình trang không tương đương cache chương trình Form hoặc bitmap cuối.

Đề nghị ưu tiên **tái dùng chương trình Form đã giải mã trong PPE**, rồi đo tiếp
SMask/clip và hàng đợi Viewer. Không bỏ 8 dải bù xén, bỏ transparency group,
chuyển PDFium, raster hóa cả artwork hoặc giảm DPI để tạo số nhanh.

Độ phủ: **TRACED + PROBE trên artifact thật**, chưa click-to-paint Tauri/installer.
Các con số nhỏ mẫu không phải P95/SLO; chưa có bản tối ưu nên không hứa phần trăm tăng tốc.

## 2. Audit unit, baseline và môi trường

Audit unit: `W2-U03-PPE-PERF / W7-U04-CMNM`.

- Hành động: PDF đang xem được → Bù xén/Tạo đường cắt → Xén vuông góc → Thực thi
  → tải/xem trang 2–3 của PDF kết quả.
- Cấu hình ảnh người dùng: bleed **2 mm**, edge bite **0,5 mm**, cả bốn cạnh,
  màu nền **Làm mượt vùng ảnh** (`inpaint`). Rectangle gửi `cut_mode=none`,
  `draw_cut_contour=false`; không chạy fitter/Simplify contour của Bế tem nhãn.
- Ngoài phạm vi: audit toàn bộ Bình tem/CNC/nesting/AI, thay chính sách màu,
  chạy bộ cài hoặc thay đổi phiên ứng dụng người dùng.

### Dữ liệu

| Nguồn | SHA-256 |
|---|---|
| `test/CMNM2026 - Giay moi_BLUE - in_OUTLINE_FONTS_5e2846.pdf` | `e657eab1a222ca11ccbe01554f663405251bfb0952fb79eee5083f9c0ce06dd1` |
| `$TEMP/PrynX-dev/results/sticker_c2f67b48.pdf` | `d68eddc487aa394b3556a2b0c72bce89ddc4d55fc938d90e02b3ebe0a230985a` |

File kết quả thứ hai, tạo sau khi sửa Flate (`sticker_12817713.pdf`, 16:48 ngày
11-09), có cùng 9 `Do`/trang và cùng hash decoded stream của cả bốn Form với
`sticker_c2f67b48.pdf`. Không dùng sự trùng này để kết luận toàn PDF byte-identical;
metadata/watermark/resource identity có thể khác. Bộ benchmark chọn cố định
`sticker_c2f67b48.pdf` để mọi lượt so sánh đọc cùng một artifact.

### Môi trường đo chốt

- Windows thật, Python venv dự án **3.11.9**, **16 CPU logic**, RAM **32.527,9 MiB**.
- RAM khả dụng đầu/cuối bộ baseline: **15.769,1 / 16.370,9 MiB**.
- HEAD: `5d4e7feca5aefbacbc621aba0857f996512c9eb3`; working tree có thay đổi đã có
  của người dùng/phiên khác, bao gồm bản sửa Flate lượt trước. Không reset/commit.
- Native **đang cài trong backend/venv**, release:
  - SHA-256 `.pyd`: `7747dd5a15e05995f8951591131e71631ae99365707c759124954d50d8a36677`.
  - Build identity: `3c4741173d730385e553958d35f749c47b65d4cb853359d78ab991cc4deffbfb`.
  - Source revision bằng HEAD, `source_dirty=true`. Đây là provenance binary thực
    đo, không khẳng định tương ứng mọi file dirty của toàn repository.
- EXE Tauri trên đĩa có thời điểm build 16:47 ngày 11-09; lượt audit **không build
  lại, không restart/kill app**, không suy đoán phiên UI từ timestamp này.
- Khảo sát ban đầu dùng wheel riêng của lượt Flate trước. Bảng baseline chính
  bên dưới đã đo lại bằng native đang cài, không trộn hai binary.

Máy được dùng chung, không cô lập CPU/frequency. Harness chạy serial để không tự
đo các nhánh song song tranh nhau, nhưng không dừng công việc khác của người dùng.

## 3. Đường chạy đã trace

| Mắt xích | Bằng chứng source hiện hành |
|---|---|
| UI và tham số | `StickerTool.tsx:79` ánh xạ Làm mượt vùng ảnh → `inpaint`; `stickerToolPolicy.ts:208–257` dựng payload rectangle. |
| Route reachable | `backend/app/api/routes/pdf_tools.py:1449` POST `/sticker-dieline`, router pdf_tools được đăng ký ở `backend/app/main.py`. |
| Thực thi | `pdf_tools.py:1820,1882` tạo/gọi StickerEngine; `:1968` canonicalize; `:1980` offload vào `run_scheduled_in_threadpool("sticker", ...)`. |
| Quyết định màu thật | `sticker_engine.py:9169–9187`: nguồn thiếu ICC, có DeviceN và DeviceCMYK đi fallback vector bảo toàn màu. Đây là nhánh thật của mẫu này dù input là `inpaint`. |
| Writer | `sticker_engine.py:11053` chuyển trang nguồn thành Form; `:11076` gọi helper; `:8344–8357,8370–8388` ghi tám dải/góc; `:11247` vẽ artwork chính. |
| Trả kết quả | `pdf_tools.py:2022` log output-ready rồi FileResponse/path; rectangle không đi bước restore canvas của Bế tem nhãn. |
| Viewer | `AcrobatViewer.tsx:543–549,2336` chọn PPE theo color risk; `LivePageFrame.tsx:730,907–911` xin bitmap accurate. |
| IPC | `useTileRenderer.ts:564–581` → `render_ppe_page`; profile mặc định FOGRA39/Relative đi native, không vòng HTTP/Python. |
| PPE | `render_worker.rs:1400,1542` → `RenderSession::render_page_srgb_region_timed`; `page.rs:342` chạy PageProgram; `interp.rs:2596,2655,982` xử lý Form và compile. |
| Bitmap cuối | `render_worker.rs:1592` encode PNG → IPC bytes → Blob → `LivePageFrame.tsx:768–841` decode/swap. |

`timings_ms.raster` của session **bao gồm cả parse/replay Form lồng nhau**, dựng
mask và composite; trường `parse=0` sau open không có nghĩa mọi lần parse Form
đã được cache. Các phép đo session không bao gồm Rust PNG/IPC/WebView decode.

## 4. Kết quả đo chốt

### 4.1. Raster 96 DPI, cùng cấu hình Viewer

FOGRA39/Relative, optional content View, annotation bật, overprint tắt; cache và
render budget dùng **mặc định hardware của facade**, không ép 512 MiB trong bộ
chốt. Hai session source/output mở một lần; từng trang có một lượt đầu + ba lượt
ấm, thứ tự source/output đảo xen kẽ. Tổng **32 render**, mọi lượt `ink_unsound=false`
và hash RGB ổn định trong mỗi trang/tài liệu.

| Trang | Nguồn: lượt đầu | Nguồn: trung vị nóng N=3 | Kết quả: lượt đầu | Kết quả: trung vị nóng N=3 | Khoảng nóng của kết quả |
|---|---:|---:|---:|---:|---:|
| 1 | 0,582 s | 0,276 s | 1,175 s | 0,924 s | 0,921–0,978 s |
| 2 | 0,760 s | 0,710 s | 5,344 s | 4,813 s | 4,288–6,519 s |
| 3 | 1,160 s | 1,261 s | 9,780 s | 7,905 s | 7,771–8,124 s |
| 4 | 0,292 s | 0,290 s | 1,038 s | 1,045 s | 1,045–1,097 s |

"Lượt đầu" không phải cold OS/process: thư viện và OS cache đã dùng; session
cùng tài liệu cũng có thể đã nhận resource từ trang trước. "Nóng" là **reraster
với resource cache**, không phải Blob/bitmap cache hit trên UI.

Mở source/output: **32,00 / 31,67 ms**. Cuối bộ đo cache mỗi session giữ
**98.075.424 byte**, budget khoảng **2,06 GB**, **0 eviction**, image hits/misses
**14/2**. Vì vậy chưa có cơ sở tăng RAM/worker hay đổ lỗi thiếu cache ảnh.

Trang 3 output nóng: median raster **7.851,5 ms** trên median wall **7.904,9 ms**.
Các phase color cuối khoảng **45–58 ms**. CPU time một số lượt gần wall, nhưng
không suy rằng mọi kernel đơn luồng hoặc máy rảnh; Rayon và tác vụ ngoài vẫn tồn tại.

### 4.2. Đối chứng nhân quả: giữ Form, chỉ vẽ artwork một lần

Bản sao chẩn đoán giữ nguyên tài nguyên/Form/Group của kết quả, giữ khối artwork
đầu tiên và watermark, bỏ **tám khối dải/góc**. Đã parse xác nhận một `Do`/trang,
q/Q cân và soi raster có artwork. **Bản này thiếu bù xén, không giao in và không
phải tối ưu giữ chất lượng.**

Bộ đo riêng 3 cặp xen kẽ/trang:

| Trang | Artifact đủ 9 Do, median N=3 | Artwork-only, median N=3 |
|---|---:|---:|
| 2 | 6,485 s | 1,342 s |
| 3 | 8,356 s | 1,986 s |

Giữ toàn bộ mẫu: lượt đầu trang 3 artifact đủ mất **32,514 s**, CPU **15,563 s**;
hai lượt sau **8,356 / 7,476 s**. Nguồn/production hash không đổi, số Do không
đổi. Có biến thiên ngoài khối lượng lệnh cố định; chưa đủ telemetry hệ thống
để quy cho tiến trình nào, IO/page fault hay frequency. Không loại outlier,
không trộn bảng này với §4.1 để tính speedup sản phẩm và không dùng N=3 làm P95.

Đối chứng bác bỏ cách quy toàn bộ chậm cho **chỉ một Group bọc trang**. Phần đắt
liên quan việc thực thi nội dung phức tạp cho nhiều dải/góc có CTM lớn. Nó chưa
chia được chính xác phần tiết kiệm nếu chỉ cache parser so với tối ưu mask/raster.

### 4.3. Sinh PDF khác với tải PDF

`StickerEngine.process_pdf` với source và thông số ảnh người dùng chạy 3 lượt:
**772,0 / 673,2 / 675,9 ms**, output khoảng 18 MB; cả bốn trang báo
`raster_seconds=find_contours_seconds=0`. Source thiếu ICC đi vector fallback,
không gọi inpaint/AI nặng trong phép thử này. Không dùng số đó đại diện HTTP
hay toàn đường Working PDF của phiên UI. Byte PDF giữa lượt khác do resource ID,
không gọi là byte-parity; artifact thật từ app đã được kiểm riêng trong §4.1.

## 5. Findings CONFIRMED

### §PPEBX.1 - P1 / M-L: chi phí đọc lại artwork bị khuếch đại bởi bù xén vector

Sink: helper writer tám dải/góc + artwork → chín `Do` cùng Form → PPE renderer.
Trên output, Form decoded page 1/2/3/4 lần lượt **16.145 / 354.115 / 356.135 /
16.105 byte**. Trang 2/3 có nhiều tài nguyên/transparency lồng nhau nên chậm hơn
rõ rệt; §4.1 và đối chứng §4.2 đã xác nhận tác động vài giây mỗi raster mới.

Tám dải là dữ liệu bù xén có chủ đích, **không phải tám request UI trùng** và
cũng không đồng nghĩa PPE cấp chín bitmap full-page độc lập. Mỗi lần có clip/CTM
riêng; điểm cần tối ưu là lượng xử lý bên trong để dựng vùng thực sự cần.

Ưu tiên xử lý phía PPE để giữ artifact/màu trước khi cân nhắc đổi writer.
Không đơn giản bỏ Do, flatten RGB, bỏ Group hoặc dùng lại bitmap bất chấp CTM.

### §PPEBX.2 - P2 / M: Form lồng nhau chưa có cache chương trình giải mã

`interp.rs:2655` gọi `decode_stream` mỗi Form invocation; đường execute tại
`:982` gọi `PageProgram::compile(data)` lại. `PageDescriptor` chỉ cache chương
trình **trang chính** (`page.rs:100–109`), `ResourceCache` chỉ chứa ảnh
(`session.rs:274–282`). Sau bù xén, page chính chỉ còn lệnh đặt Form; nội dung
nặng đã nằm ngoài cache PageProgram đó.

Confirmed là thiếu tái dùng công việc bất biến trên đúng đường live; mức latency
có thể giảm nhờ cache **chưa đo tách riêng**, không gán toàn bộ 7–10 giây cho parse.
Frame/RGB không được cache như Form program vì phụ thuộc CTM, clip, backdrop,
overprint, OCG, Show filter và profile. Cache phải giữ decode provenance,
exception/cancel và invalidate theo revision; dùng ngân sách tài nguyên hiện có.

## 6. Các hướng chưa đủ bằng chứng để xếp severity

- **Prefetch đi chung lane tương tác:** `livePageFramePolicy.ts:29–37` cho active
  priority 10, prefetch 20; `render_worker.rs:2752` ánh xạ cả hai thành Interactive.
  `useTileRenderer.ts:566` bypass JS scheduler; manager dùng một interactive mutex
  tại `render_worker.rs:2882`, không sort 10 trước 20. Có nguy cơ trang đang cần
  chờ prefetch đã khởi động, nhưng chưa có timeline GUI chứng minh đó là phần
  chậm của thao tác người dùng lần này. Không tự đổi ưu tiên trước khi đo.
- **Bỏ công việc ngoài clip:** Form giải nén trước khi thiết lập clip; group_region
  rỗng chưa thoát sớm; SMask `/G` decode tại `interp.rs:2383` trước empty-window
  return `:2516`. Có dư địa dời việc xuống sau cổng hiện hữu, nhưng cần counter/
  timing. Không cull toàn interpreter: `Q` có thể phục hồi clip, OUTLINE cần mã/
  path vô hình; spot inventory và `/All` có thể phụ thuộc object ngoài clip.
- **Cache bitmap PPE native:** worker accurate luôn render+PNG ở `:1542,1592`;
  Blob cache frontend đã tồn tại (`LivePageFrame.tsx:641,803`). Display có RAM/disk
  bitmap cache riêng, không được nói toàn Viewer "không có cache". Lợi ích thêm
  tầng bitmap cần đo hit/miss theo zoom/clip/reopen, không chữa cold raster đầu.
- **PNG/IPC/DOM, queue và cancel:** probe session chưa đo được. Đã có trace opt-in
  nhưng không tìm được log mới ở các đường log chuẩn đã kiểm. Không gọi log tắt
  mặc định là bug; cần đúng request ID và click-to-paint khi nghiệm thu UI.

## 7. Những kết luận bị loại hoặc giới hạn

- Không quy chậm cho bản sửa `Finish → None`: bản sửa Flate khắc phục từ chối
  nhầm dữ liệu, không tối ưu render. Benchmark cũ chỉ N=1 dưới tải không đủ chứng
  minh speed regression trước/sau; lượt này không có A/B binary kiểm soát.
- Không coi đơn giản xóa `/Group` là giải pháp; phép thử thăm dò không cho kết
  quả tốc độ ổn định và chưa đạt color parity.
- Một harness artwork-only ban đầu nối literal `\\n` sai, cho thời gian 115–180 ms
  vì thiếu nội dung render; **đã loại khỏi evidence**. Bảng §4.2 chỉ dùng PDF q/Q
  hợp lệ, parse đúng và đã soi PNG. Không dùng số sai để hứa tăng tốc.
- Các findings cũ về AI/Simplify, route chặn event loop, chunk spill và ba lần
  restore canvas không đại diện nhánh rectangle vector này. Route đã offload;
  không có lý do tăng pool cho job sinh PDF dưới một giây.
- Bản audit màu ngày 19-08 và master matrix giữ lời văn lịch sử về
  `trajectory/inpaint`; nguồn hiện có fallback DeviceN+CMYK thiếu ICC. Báo cáo
  này dựa vào code + artifact hiện hành, không tự thay chính sách để khớp tài liệu.

## 8. Lô sửa đề xuất - cần duyệt

### Lô A: tái dùng Form program, giữ nguyên artifact (ưu tiên)

Dự kiến ≤5 file: `print_engine/src/session.rs`, `content/interp.rs`, một helper
nếu cần và 1–2 test. Cache decoded/compiled Form bất biến theo document revision/
object identity; resolve state/resources theo đúng invocation. Giữ mọi warning,
inline image, cancel và fail-closed; RAM theo ngân sách sẵn có, không cap máy mạnh.

Tiêu chí: đếm compile một lần mỗi Form/revision khi đủ budget; raster/plate/hash
khớp baseline ở mọi clip/CTM, không lỗi Flate quay lại; đo lại §4.1. Nếu hiệu quả
nhỏ, ghi số thật và chuyển Lô B, không hứa "cache là tức thì".

### Lô B: giảm công việc SMask/clip sau khi có profile chi tiết

Đầu tiên dời decode SMask ra sau nhánh empty-window **đã có**, giữ `/BC`, `/TR`,
guard-band. Sau đó mới nghiên cứu cull nested Form với hợp đồng riêng cho View
và đo kẽm/Outline; không làm mất spot/hidden metadata. Mỗi nhóm ≤5 file, verify
trước/sau độc lập. Không gộp thay writer trong lô này.

### Lô C: click-to-paint và ưu tiên active/prefetch

Đo ở app thật trước: bootstrap → enqueue → bắt đầu worker → raster/encode →
decode → ảnh hiện. Sau đó mới chọn cache bitmap/singleflight hoặc thay lane của
prefetch để không giữ interactive. Giữ độ nét, mapping tab/revision, lease và
hủy đúng request; không tăng worker mù hoặc giảm DPI để che độ trễ.

Nếu PPE đã tối ưu nhưng vẫn không đạt nhu cầu, writer edge-only là nghiên cứu
riêng cần duyệt màu/plate/đơn vị. Không dùng bản artwork-only của audit làm patch.

### Ma trận nghiệm thu chung

CMNM 4 trang; source/output; 1/4 cạnh; bite 0/0,5; 96/144 DPI và viewport;
View/Print/OCG/annotation; spot/DeviceN/CMYK/ICC; alpha/group/blend; checksum hỏng;
warm/cold/revision đổi; cancel/đóng tab; một và nhiều tab; tier <8, 8–16, ≥16 GB.
Máy mạnh giữ đầy đủ công suất, không giảm chất lượng. Timing cuối cần ≥20 mẫu,
source/binary/settings khóa, telemetry tải và pixel gate, không dùng riêng test xanh.

## 9. Evidence và việc đã/chưa làm

- [Harness session](audit/VIEWER_BU_XEN_PERF_2026-09-11/measure_session.py).
- [Baseline chốt 32 render](audit/VIEWER_BU_XEN_PERF_2026-09-11/session_baseline.json).
- [Đối chứng 12 render](audit/VIEWER_BU_XEN_PERF_2026-09-11/ablation.json).
- [Cách tạo đối chứng hợp lệ](audit/VIEWER_BU_XEN_PERF_2026-09-11/build_ablation.py).
- Hash 7 file production trọng tâm và PDF đầu/cuối hai bộ đo giữ nguyên.
- Windows Vitest 5 suite Viewer/coordinator/policy/LiveTile/tile-cache:
  **94 passed**. Các test này không chứng minh tốc độ hay GUI runtime.
- Không chạy full suite/typecheck/build trong audit; 720/78/31 test ở báo cáo
  Flate là kết quả lượt sửa trước, không tính lại vào đợt này.
- Không đóng app, không reset cache của app, không chỉnh worker/RAM/quality,
  không commit/push. Chỉ thêm báo cáo/harness/evidence và cập nhật master matrix.

Theo `prynx-audit-workflow`, dừng tại đây chờ duyệt **Lô A**.
