# Điều tra mở PDF nặng và chất lượng Viewer PrynX - 2026-09-20

**Trạng thái: AUDIT / CHƯA SỬA SOURCE.** Đã đo worker của cả binary dev và release hiện có, kiểm bitmap, đọc log thật và truy vết source. Chưa có phép đo GUI Acrobat–PrynX cùng điều kiện trên file khách; chưa build/cài/phát hành.

## 1. Kết luận điều hành

Phản ánh có cơ sở, nhưng cần tách ba vấn đề:

1. **Bản release có thể chậm ngay ở khâu mở tài liệu, trước raster.** PDF 302,16 MB / 72 trang trên máy32GB: bootstrap release2.0.3 trung vị **5669 ms**, RSS sau bootstrap **2773 MiB**, đỉnh worker **4573 MiB**. Dev hiện có cùng máy: **222 ms**, **598 MiB**, đỉnh **1285 MiB**. Đây là số đo worker, không phải click-to-paint.
2. **Có lỗi hiển thị nội dung thật, không chỉ “chưa đủ DPI”.** PPE có thể thay cả Helvetica, Times-Roman và Courier không nhúng bằng cùng DejaVu Sans. Trên fixture có CMYK/transparency và viewer tự chọn PPE, cả ba dòng có cùng mask glyph, cùng rộng441px; PDFium ở cùng96DPI cho392/368/445px và giữ khác biệt sans/serif/mono. Release cũng tái hiện.
3. **Source/dev còn một hồi quy chưa thấy trong release đang kiểm:** full-page nhân96/72 hai lần, trong khi tile chỉ nhân một lần. Trang612x792pt/scale1 đáng ra816x1056px lại thành1088x1408px: thừa77,8% pixel. Không gán lỗi này cho mọi khách đang dùng release2.0.3.

Vì vậy hướng hiệu quả nhất là chốt correctness + loại tiền xử lý nặng khỏi đường mở trang đầu + đưa đúng bản đã kiểm vào release. Sau đó mới tối ưu sâu CPU/GPU. Không có căn cứ để hứa “chỉ bật GPU/tăng worker là đạt Acrobat”.

## 2. Môi trường và phạm vi bằng chứng

- Windows, Intel Core i5-13400,10core/16logical, RAM vật lý báo34.107.990.016 byte, RTX3060, driver32.0.15.9186.
- Acrobat cài tại máy: **24.2.20857.0**. Chỉ xác nhận version, chưa điều khiển GUI hoặc lấy timing/pixel Acrobat mới.
- PrynX source: working tree tại HEAD `0c8a347`, có nhiều WIP đã tồn tại trước audit.
- Dev EXE: target/debug/pdf-inspector.exe, mtime19/09/2026 21:43:59; SHA256 `F2E703EA08AE862A8F3A6FB6CBE9586FF15B41C76B4D9676156CB61972B36D15`.
- Release EXE: target/release/pdf-inspector.exe, mtime15/09/2026 09:53:40; SHA256 `AE3E99FA7D46A65F927F2A35058C77972F7817557B7254BAC965918E71CF09C4`.
- Có installer local PrynX_2.0.3_x64-setup.exe cùng ngày15/09. **Không suy ra tất cả khách đang chạy đúng hash này**; chưa đối chiếu manifest/file của từng máy khách.
- Hai worker handshake cùng app version2.0.3, protocol4, cache v7, PDFium SHA `01be7a757183793f15eb35de9d9da424fc07d24b5560e8c3822f52812b2ad89a`.
- Dev Cargo opt-level1, image/pdfium-render opt-level3; release khác profile và code. So sánh hai binary không phải A/B cô lập một dòng sửa.
- Worker được chạy đúng cờ --prynx-render-worker, CREATE_NO_WINDOW, TEMP/TMP riêng, chỉ shutdown/kill process do probe tạo. Không đóng app, đổi setting, purge cache người dùng hoặc gửi dữ liệu PDF ra internet.
- “Cold” dưới đây là process mới/cache tile riêng; **OS file cache không được flush**. Máy đang dùng chung. N=5 là thăm dò có lặp, không phải P95 của khách hàng.
- Nguồn source chính giữ nguyên hash trong lượt audit; chỉ thêm script/fixture/evidence/report chẩn đoán.

## 3. Đường chạy đã xác minh

### Mở và hiển thị

File/native path → usePdfLoader.ts:558 → get_pdf_viewer_bootstrap (:642) → Tauri lib.rs:3727 → render_worker.bootstrap_with_policy → viewer_bootstrap_in_process (:3778) → build_cached_document (:2908) → đọc/parse/PageBox/risk + load PDFium → metadata → markReady (:783) → LivePageFrame/LiveTile → useTileRenderer.getTileUrl (:440) → renderCoordinator → IPC render_pdf_page / render_ppe_page → worker → PNG → decode/compositor.

Viewport và first frame là consumer khác nhau. Metadata “ready” không đồng nghĩa pixel đã hiện.

### Hai đường render

- Display: PDFium → render_tile_png_with_options, lib.rs:3950 → bitmap PNG lossless.
- Accurate: PPE RenderSession → render_page_srgb_region_timed, render_worker.rs:1485-1552 → PNG. View/annotations bật, overprint simulation tắt trong viewer thường; Output Preview là hợp đồng khác.
- Risk detector: pdf_color_risk.rs → riskyPages → useTileRenderer.shouldUseAccurateViewerRender (:193).
- Full-page CSS: LivePageFrame.applyExactFit (:444) chỉ snap1:1 khi lệch≤2devicepx; bitmap lệch33% vẫn được co theo khung.
- Hủy: PPE có cooperative cancel; PDFium request đang chạy dùng kill worker khi hủy (render_worker.rs:2554). Không tăng thread PDFium cùng process bừa.

## 4. Các phát hiện

| Mã | Mức | Trạng thái/phạm vi | Nội dung |
|---|---|---|---|
| V20.1 | P1 | CONFIRMED, release artifact + log; nguồn từng bước còn cần A/B build | Mở PDF lớn bị tiền xử lý/phình dữ liệu, chi phí RAM rất cao |
| V20.2 | P1 | CONFIRMED, dev hiện tại; release đang đo không tái hiện | Full-page đổi72→96 hai lần, phá hợp đồng pixel và tạo việc dư |
| V20.3 | P1 | CONFIRMED, dev + release | PPE thay font không nhúng không giữ family/metrics; mất thông tin cảnh báo hình học ở biên worker |
| V20.4 | P1 | CONFIRMED, dev + release | Hai cách khai cùng màu CMYK chọn hai engine khác nhau, dẫn tới hình khác nhau |
| V20.5 | P2 | CONFIRMED bottleneck, không gọi là lỗi cache | PPE vẫn tốn raster/replay và chuyển màu sau khi Form/image cache đã hit |
| V20.6 | P2 | CONFIRMED gap, cần acceptance GUI | Test policy đang xanh nhưng chưa khóa được pixel/native/cache/build và so Acrobat cùng điều kiện |

### V20.1 - bootstrap lớn là vấn đề thực của release

Case302,16MB/72trang, N=5:

| Chỉ số | Release2.0.3 local | Dev hiện tại |
|---|---:|---:|
| Bootstrap trung vị | 5669,2ms | 222,1ms |
| Khoảng bootstrap | 5635,3–5720,5ms | xem JSON |
| RSS sau bootstrap, trung vị | 2772,6MiB | 597,6MiB |
| Đỉnh worker của probe | 4573,3MiB | 1285,2MiB |
| PPE render đầu sau bootstrap, trung vị | 355,3ms | 369,4ms |

Thời gian chậm của case này chủ yếu đã xảy ra **trước khi yêu cầu render**. Trên máy ít RAM, nguy cơ paging là suy luận có cơ sở từ working set, chưa phải benchmark máy8GB.

Log runtime hiện có ghi ví dụ `PDF_STREAM_OPTIMIZE`: 53 ảnh, file301.916.518byte được nở thành1.446.479.475byte, mất5,5–11,7giây ở những lượt đã ghi. Đây là case log khác với file302.157.051byte đang benchmark, không gộp thành một mẫu.

Source HEAD và diff working tree cho thấy đường cũ:
- đếm≥2 Form XObject (không chứng minh chúng thật sự được reuse);
- decompress ảnh Flate trên cả tài liệu;
- save_to buffer tối ưu mới trước bootstrap;
- từng có generate_proxy_pdf clone tài liệu, giảm ảnh RGB lớn4x/8x.
Working tree hiện tại đã bỏ đoạn tiền xử lý này và thêm singleflight theo path. Không gọi đây là bản sửa do audit này làm.

Kết hợp code/log/phép đo xác định được vùng tiền xử lý tài liệu cần ưu tiên. **Chưa có build A/B chỉ bật/tắt từng phần**, nên không quy toàn bộ25,5x chênh bootstrap cho riêng một thay đổi. Cũng chưa xác nhận proxy hoạt động ở từng binary; không đưa “proxy làm mờ bản release” thành finding đã chứng minh.

Riêng đường PPE-only sau bootstrap trên dev: RSS hiện hữu khoảng955MiB, đỉnh1244MiB. Do đó vẫn còn dư địa giảm bản sao/parsed representation dù bỏ đường nở dữ liệu đã có tác dụng lớn.

### V20.2 - hồi quy full-page DPI trong dev

Consumer sống:
- lib.rs:2170 viewer_render_scale = (96/72)*zoom*UserUnit.
- lib.rs:4138 nhánh full-page lại screen_scale = render_scale*(96/72).
- Nhánh clip dùng render_scale một lần.
- LivePageFrame.tsx:444-468 không snap bitmap lệch hàng trăm pixel, dùng100%/100%.

Probe cùng trang612x792pt, UserUnit1, zoom1:
- Dev full-page:1088x1408.
- Dev clip đủ trang:816x1056.
- PPE96DPI:816x1056.
- Release full-page:816x1056.

Dư77,78% pixel so với hợp đồng96DPI; bỏ hệ số lặp tương ứng giảm43,75% pixel của nhánh này, **không hứa giảm43,75% toàn bộ thời gian mở file**. Resampling LCD/text không còn1:1 có thể đổi cảm giác nét; chưa định lượng mọi font trên màn hình thật.

Cả hai binary dùng cùng cache version v7 dù full-page tạo kích thước khác nhau. Khi sửa phải khóa lại render/cache identity và kiểm cache cũ; chưa thực hiện cross-build cache replay trong audit này.

### V20.3 - font bị thay, không thể chữa bằng tăng DPI

Fixture chuẩn có Helvetica/Times-Roman/Courier không nhúng, text ASCII để loại lỗi encoding, kèm CMYK/transparency khiến riskyPages=[1].

Trên cả release và dev, PPE thay cả ba font bằng DejaVu Sans:
- Cùng câu ở96DPI: PDFium có bề rộng392/368/445px.
- PPE:441/441/441px; ba mask glyph có SHA256 giống hệt.
- Đã xem hai PNG ở cùng816x1056px; Times mất serif, Courier mất monospace.

Source: interp.rs:4906-4914 substitute_program lấy một fallback_font chung; font.rs:938-967 không có program nhúng thì Missing. Không có resolver theo family/style/Standard14 tại nhánh này.

Native PPE core trả `degraded=true, ink_unsound=false`. Nhưng render_worker.rs:1365-1372 cố ý không từ chối geometry-only và response bitmap không chuyển tiếp danh sách substituted font/geometry warning; test :4967 còn khóa Ready + unsupported_reason=None. **Color-verified không có nghĩa geometry-verified**.

Giải pháp phải vừa hỗ trợ font phù hợp, vừa giữ metadata cảnh báo hình học. Không tự chuyển toàn bộ trang CMYK về PDFium khi chỉ lỗi font vì có thể đổi màu.

### V20.4 - classifier chọn renderer theo cách viết PDF

Tạo hai PDF tương đương:
- A: màu CMYK bằng toán tử `k`.
- B: cùng giá trị qua ColorSpace tài nguyên DeviceCMYK và `cs/scn`.
- Cùng alpha, text, vị trí; bitmap A và B có **cùng hash trong từng renderer**, gồm display, display-clip, PPE.
- Detector A: accurateColorRecommended=false.
- Detector B: true, riskyPages=[1].
- Kết quả cuối mặc định vì thế khác font/màu tùy cú pháp xuất PDF.

Source: pdf_color_risk.rs:198 bỏ Contents khi quét; :149 nhận tên DeviceCMYK trong resource graph; :259 dựng risk, :333 bootstrap. Đây là lỗ hổng ở biên phân loại→chọn engine, không phải nội dung hai PDF khác nhau.

Cần phát hiện ngữ nghĩa màu được sử dụng và capability; không chỉ sự có mặt của tên resource. Đồng thời không được eager-scan cả tài liệu nặng để sửa classifier: ưu tiên đúng trang/viewport, cache theo revision, kiểm state kế thừa/Form/OCG.

### V20.5 - cache resource không xóa được chi phí vẽ

PPE core hiện cài trong venv, cùng View/annotations/FOGRA39/Relative/overprint off,96DPI; đo riêng, **không ghép thời gian này với worker dev/release**:

- File37MB đã bình, warm: khoảng447ms gồm raster368ms + chuyển màu76ms.
- Cache đã hit20 ảnh và73 Form, không eviction; parse=0.
- File18MB outlined, warm: khoảng259ms, raster223ms + màu34ms.
- Fixture chữ nhỏ: khoảng40ms, màu33ms; không được kết luận raster là nút thắt của mọi loại trang.

print_engine/session.rs:1014 vẫn gọi render_page_descriptor mỗi lượt; FormProgram cache có ích nhưng chưa phải retained display-list/tile bitmap cache cho mọi phép tương tác. Frontend đã có blob/tile cache; **không khẳng định mọi warm-open GUI phải render lại**. Những con số warm ở đây là khi một request thật đi tới worker/core.

### V20.6 - đo đúng artifact, không chỉ unit

162 test Viewer liên quan đều đạt. Tuy vậy test đó không bắt được full-page PNG1088 thay vì816. Cần thêm gate PNG/native dimensions, glyph identity, engine routing invariance và metadata quality trước khi đánh giá đạt chất lượng.

Log đang có:
- 534 IPC_RENDER, median94,5ms, quan sát lớn nhất14855ms; sem_wait và worker_queue ở nhóm này bằng0.
- pdf-load-ready có70record, median242ms, quan sát lớn nhất11978ms.
- Đây là log hỗn hợp trang/zoom/phiên, **không phải phân bố thời gian khách hàng**, không lấy P95 của nó làm SLA.
- core_ms bao gồm công việc trong worker, không đồng nhất với “raster”. Case release302MB đã chứng minh bootstrap có thể là thành phần lớn nhất. Tránh lặp kết luận “tất cả9–15giây đều do raster”.

## 5. Benchmark worker dev, N=5 mỗi case

| Case | MB / trang | Bootstrap median | PPE lần đầu96DPI | PPE render lặp96DPI |
|---|---:|---:|---:|---:|
| Chữ live nhỏ | 0,0016 /1 | 1ms | 53ms | 47ms |
| CMYK outlined | 18,06 /4 | 51ms | 660ms | 324ms |
| File72mẫu đã bình | 37,16 /6 | 39ms | 860ms | 619ms |
| PDF lớn nhiều ảnh | 302,16 /72 | 222ms | 369ms | 29ms |

Nên tối ưu theo cấu trúc trang/số Form/ảnh/mask, không chỉ MB. File302MB không nhất thiết raster trang đầu chậm hơn file37MB.

Đã đo cả display, clip96DPI và accurate. Không đưa chúng thành “engine X nhanh hơn Y bao nhiêu lần” vì khác pipeline màu, cache, thứ tự làm nóng và dev full-page còn lỗi DPI. JSON giữ đủ dữ liệu để tái phân tích.

## 6. Những giả thuyết đã loại trừ / chưa đủ bằng chứng

- Không còn JPEG q90 ở đường chính vừa kiểm: payload là PNG; JPEG trong audit tháng7 là lịch sử.
- PrynX đã có viewport tile, DPR, giữ bitmap cũ, ưu tiên active, worker tách process, cancel và cache. Không đề xuất xây lại những thứ đó từ đầu.
- Ngưỡng12MP full-page và8000px không mặc nhiên là hạ chất lượng cuối: viewport có đường dựng riêng đúng mật độ. Không bỏ guard để “lút cán”.
- Font fixture live-text cũ có ký tự Việt không được Helvetica encode: không dùng dòng lỗi đó để buộc tội PPE. Fixture mới ASCII/3font loại được nhiễu này.
- Chưa đo trực tiếp Acrobat GUI, bản cài PrynX của khách, mở qua UNC/NAS/USB, máy8/16GB, nhiều màn/DPR.
- Chưa có hotspot profile đủ sâu cho từng request9–15s lịch sử. Không hứa GPU xử lý hết.
- Proxy trong source lịch sử là nghi vấn chất lượng, chưa có artifact A/B chứng minh trên release đang đo; current code đã tắt/bỏ, giữ ngoài bảng finding chính.

## 7. Lộ trình lên hiệu năng/chất lượng cao

### A. Chốt tính đúng và bản được giao khách - ưu tiên trước

A1. Sửa hệ số DPI lặp ở dev; thống nhất pt→CSS→device pixel/clip/rotation/UserUnit; cập nhật cache identity; test100/125/150/200% Windows scaling, zoom100/200/400%.
A2. Font: embedded trước; hỗ trợ Standard14 và resolver family/style/metrics; font hệ thống chỉ theo chính sách rõ, fingerprint được. Glyph hinting/AA cho chữ nhỏ kiểm riêng, không sửa màu hay PDF nguồn. Giữ cảnh báo substituted font/geometry tới UI.
A3. Classifier invariant trước hai PDF tương đương về ngữ nghĩa; kiểm màu trực tiếp k/K, named spaces, Forms, OCG, transparency và OutputIntent.
A4. Chốt loại eager inflate/proxy/re-save toàn tài liệu khỏi critical path trước trang đầu; tận dụng thay đổi đã có trong working tree, không làm lại mù. So chính xác release candidate với release đang có trên cùng corpus.
A5. Chỉ sau nghiệm thu mới đóng gói/phát hành; ghi hash/build/profile/engine/cache trong diagnostics. Version2.0.3 một mình không đủ nhận diện code.

Mỗi lô con≤5file, có test tái hiện và pixel gate; không build/release khi chưa được duyệt riêng.

### B. Mở file theo nhu cầu, giảm nhân bản bộ nhớ

- Ưu tiên page tree/metadata tối thiểu/trang nhìn thấy; metadata các trang khác chạy nền.
- Byte source bất biến dùng chung/reader hoặc mmap an toàn, giảm Vec clone. **Không xóa clone trực tiếp khi chưa sửa ownership/lifetime của PDFium.**
- Parsed resource/session theo document revision; ưu tiên chạy gần cache của tài liệu, không để mỗi worker tự chuẩn bị lại mọi ảnh.
- Worker/admission dựa cả CPU và RAM khả dụng/working set; máy mạnh giữ khả năng tối đa, không hard-cap DPI/worker vô điều kiện.
- Không giảm chất lượng file nguồn để làm viewer nhẹ.

### C. Tối ưu phần vẽ đã đo, giữ đúng màu

- Retained page/display-list + spatial index và vùng phụ thuộc: không replay/raster toàn nội dung cho mọi tile.
- BBox phải bảo thủ; giữ graphics state, clip, transparency-group, SMask, OCG và nguồn lực kế thừa. Không bỏ đối tượng dựa trên bbox sai.
- Mipmap/LOD ảnh theo pixel màn hình, giữ ảnh gốc cho zoom sâu/in/xuất.
- Cache glyph/path/Form/image có version; tránh lặp giải mã/layout và giữ warmth khi hủy.
- SIMD/Rayon/ROI cho scan conversion, blend/SMask và ICC; ưu tiên nơi profiler cho thấy tốn thời gian.
- PDFium progressive render có API pause/continue/close để nghiên cứu hủy mà không mất cả worker/cache. Đây là lựa chọn kỹ thuật cần PoC và kiểm vòng đời, không phải đổi một flag là xong. [PDFium API](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_progressive.h).

### D. GPU - giai đoạn đo được, không khẩu hiệu

GPU hữu ích cho compositor, zoom/pan, texture/mipmap, color transform và một số kernel raster; không tự giải quyết parse PDF, font bị thay, byte clone hoặc classifier sai. Đường PPE hiện dùng tiny-skia/Rayon; có RTX3060 không đồng nghĩa core tự chạy GPU.

Chọn kernel theo profiler; prototype GPU phải vượt CPU ở cùng DPI/pixel/ICC/alpha và có fallback cho thiết bị cũ. Không viết lại toàn bộ PDF renderer trước khi hoàn tất A–C.

## 8. Chỉ tiêu nghiệm thu đề xuất, không phải cam kết đã đạt

Trên corpus chốt và máy32GB/NVMe đại diện:
- Page/scroll interaction giữ phản hồi UI, không mất frame đã có; hướng tới60fps ở thao tác compositor.
- Nét cuối vùng nhìn sau dừng zoom: mục tiêu warm P95≤250ms cho nhóm trang thông thường.
- First readable/sharp frame: tách riêng. Mục tiêu cold-open≤1,5s cho nhóm thường/50MB và≤3s cho nhóm100–300MB sau khi phân loại; PDF cực phức tạp cần progressive/cancel, không hứa theo MB đơn thuần.
- Ít nhất30lượt/case/tier cho P50/P95; N=5 audit chưa phải nghiệm thu percentile.
- Chất lượng: không thiếu glyph/đối tượng; không đổi family/metrics khi font chuẩn có thể giải; full-page và tile khớp; không upscale ảnh cuối dưới mật độ đích; glyph/edge ROI + màu ΔE + blend/OCG/annotation kiểm riêng.
- Máy yếu vật lý phải đo riêng peak toàn cây, paging và timeouts; không giả RAM bằng env rồi gọi là máy8GB thật.

## 9. So Acrobat công bằng

Cùng PDF/hash/page, cùng kích thước vật lý và viewport, cùng DPR/monitor ICC; so cold và warm riêng. Ghi các tùy chọn làm mịn chữ/ảnh, tăng nét đường mảnh, local fonts, page cache và acceleration. Adobe công bố các tùy chọn này, nên chỉ nhìn cùng “100%” chưa đủ. [Adobe Page Display](https://helpx.adobe.com/acrobat/using/viewing-pdfs-viewing-preferences.html).

So Page Display với Page Display; so proof với proof có cùng simulation profile/overprint/paper/black. Adobe lưu ý Output Preview và ICC làm thay đổi cách tài liệu xuất hiện. [Adobe Output Preview](https://helpx.adobe.com/acrobat/using/previewing-output-acrobat-pro.html).

Không lấy MAE cả trang trắng làm oracle duy nhất: dùng ROI chữ nhỏ, đường mảnh, logo, ảnh và gradient. So pixel không đồng nghĩa đo cảm giác; cần input-to-paint/settle capture trên đúng app đã cài.

## 10. Bằng chứng và ma trận phủ

Evidence máy đọc: [VIEWER_OPEN_QUALITY_2026-09-20.json](audit/VIEWER_OPEN_QUALITY_2026-09-20.json).
Raw/probe tại workspace tmp/viewer-audit-20260920/ và các script audit_viewer_worker.py, audit_viewer_fonts.py, audit_viewer_log.py, audit_viewer_ppe_profile.py. Không chứa PDF khách trong repo. Fixture mới là tài liệu chẩn đoán, không dùng sản xuất.

| Unit | Entry→engine→artifact/consumer | Hợp đồng/case | Mức |
|---|---|---|---|
| W7-V20-OPEN | loader→bootstrap→worker→PageBox/risk→mount | 302MB, process cold, release/dev, RSS | RUNTIME-WORKER + TRACED UI, chưa GUI |
| W7-V20-PIXEL | LiveTile→scale/clip→PDFium→PNG→CSS | Letter612x792, scale1, full vs clip/PPE | ARTIFACT + source + telemetry |
| W2-V20-FONT | high-risk→PPE→FontProgram→PNG | 3Standard14 không nhúng, mask/width/degraded | ARTIFACT release/dev |
| W2-V20-ROUTE | syntax→risk detector→pipeline→PNG | k so cs/scn, cùng hash theo engine | ARTIFACT release/dev |
| W7-V20-CORE | render request→session/cache→raster/ICC | warm Form73/image20,96DPI | PROFILE core; không GUI |
| W7-V20-ACROBAT | app installed→viewer→screenshot | cùng settings/file/DPR | UNKNOWN, cần ca khách và click-smoke |

162 test Viewer đạt. Không sửa source, không đổi test oracle sản phẩm, không build/install/commit hoặc thay setting app. Các worker do audit tạo đã được đóng. Theo prynx-audit-workflow, dừng ở báo cáo chờ duyệt lô sửa.
