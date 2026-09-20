# Audit tải và chất lượng hiển thị PDF sau bình - 2026-09-20

> **Cập nhật sau bản sửa của người dùng:** xem [re-audit](RE_AUDIT_VIEWER_SAU_BINH_2026-09-20.md). Output mới đã dedup còn28,74MB và cacheICC có hit thật. PPE vẫn khoảng6,07s/trang; bộ lọc mới chỉ averagealpha, còn màu vẫn lấy một texel nên POSTVIEW20.03 chưa đạt. Nội dung bên dưới là baseline trước sửa, không phải trạng thái hiện tại. Zoom nằm ngoài phạm vi re-audit theo yêu cầu người dùng.

Trạng thái: **chỉ audit, chưa sửa production**. Giữ nguyên phần sửa scale tem của người dùng. Dùng prynx-performance, prynx-deep-audit, prynx-testing và PDF skill; dừng ở chốt duyệt theo prynx-audit-workflow.

## 1. Trả lời trực tiếp

**Có yếu tố file nặng, nhưng điểm nghẽn chính không phải đọc file từ ổ đĩa.** Trên ca oval còn lưu trong kết quả:

1. File bị phình do lặp tài nguyên ảnh khi ghép chunk: 28,43 MB nguồn thành 165,96 MB sau bình; khoảng 136,94 MB là payload ảnh/mask lặp.
2. Bộ PPE mà viewer chọn cho tài liệu màu/transparency cần 12-15 giây để dựng trang đầu ở 96 DPI. Mở cấu trúc file chỉ khoảng 0,18 giây.
3. Ảnh ICC kèm alpha không được hưởng cache ảnh và bộ lọc thu nhỏ chất lượng của nhánh CMYK đục. PPE lấy texel ở tâm nên bản fit/zoom thấp có chi tiết răng cưa, mất nét nhỏ; zoom lên thêm pixel nên rõ hơn.
4. Viewer giữ bitmap cũ khi zoom và chờ render mới. Cơ chế này tránh màn trắng, nhưng khi render kéo dài nhiều giây nó biểu hiện thành “mờ, phải chờ rồi mới nét”.

**Không thấy exporter giảm độ phân giải hoặc nén mất dữ liệu ảnh trong ca đo:** ảnh nền vẫn 5000x3125 px, bytes ảnh và mask có SHA256 giống nguồn. Tám artwork tờ đầu đều scale 1,0; không dùng lại lỗi phóng 2,136893 lần làm lời giải thích cho hiện tượng mới.

## 2. Phạm vi và provenance

- Nguồn: C:/Users/Khanh Pham/AppData/Local/Temp/PrynX-dev/results/sticker_a78eff38.pdf, 123 trang, 28.426.520 byte.
- Sau bình: C:/Users/Khanh Pham/AppData/Local/Temp/PrynX-dev/results/nup_6cd97ef2.pdf, 17 trang, 165.956.101 byte; job log lúc 18:16.
- Đây là cặp nguồn/kết quả gần nhất xác định được từ log; không khẳng định mọi PDF người dùng đang mở có cùng tính chất.
- Process PrynX đang chạy dùng D:/pdfcompare/desktop/src-tauri/target/debug/pdf-inspector.exe. File binary mtime 2026-09-20 17:05:19; SHA256 D5C7C0948DDE6AD2EE8B124AF7D21D829CAF64DD7870CEA8A2E9E4B0610A11EE.
- Worker handshake: app2.0.3, protocol4, cache v8_transparent_bg_lossless_png. Probe cũ gửi v7 bị từ chối; đã sửa **harness**, không coi lỗi handshake đó là bug ứng dụng.
- N=3 cho mỗi PDF, mỗi run có process/TEMP/TMP cache riêng, xen kẽ thứ tự display/accurate. Không flush OS cache, máy vẫn đang được sử dụng.
- Chỉ spawn worker ẩn thuộc audit; shutdown đúng worker audit. Không kill/restart app hoặc thay setting/cache đang dùng.
- Timing dưới đây là **worker và binding native**, không phải đồng hồ từ click đến paint trên cửa sổ app.
- Profile pha chi tiết dùng pdfcompare_native.cp311-win_amd64.pyd, mtime13:36:55. Đây là binary riêng; không cộng timing core vào timing worker, không coi là A/B cô lập build profile.
- Không dựng lại hoặc tối ưu PDF nguồn/kết quả. Chỉ đọc cấu trúc, render PNG và lưu evidence.

## 3. Số đo

### Worker đúng binary hiện có

Trung vị ba run. “Lần đầu” là lần render đầu của pipeline đó trong worker mới; thứ tự pipeline xen kẽ, không phải cold OS disk.

| Đại lượng | Nguồn 123 trang | Sau bình 17 trang |
|---|---:|---:|
| Dung lượng | 28,43 MB | 165,96 MB |
| Bootstrap | 75,53 ms | 183,25 ms |
| PDFium display trang1, scale1 | 208,65 ms | 701,57 ms |
| PPE trang1, 96 DPI lần đầu | 991,41 ms | 13.018,19 ms |
| PPE cùng trang/DPI lần2, giữ session | 978,60 ms | 14.375,20 ms |
| Bitmap PPE 96 DPI | 605x378 | 1247x1814 |

- PPE output 96 DPI: lần đầu 12.371-13.235 ms, lần2 14.071-14.609 ms. Không có gain rõ từ warm resource cache cho ảnh này.
- PDFium cùng output: 601-801 ms ở full-page; request lặp exact đi disk tile cache khoảng 2,5-3,2 ms.
- PPE worker báo render khoảng 12,8-14,2 giây, encode PNG khoảng 0,10-0,12 giây. Không thể giải thích 13 giây bằng encode hoặc truyền PNG.
- Peak RSS worker trong probe output khoảng 781-839 MiB; đây không phải tổng RAM của app/WebView.

### Đo DPI/viewport riêng, N=1

| Request PPE | Bitmap | Thời gian |
|---|---:|---:|
| Nguồn, 192 DPI toàn trang | 1209x756 | 2.837 ms |
| Output, 48 DPI toàn trang | 624x907 | 4.420 ms |
| Output, 192 DPI viewport 800x900 | 800x900 | 4.071 ms |
| Cùng viewport lần2 trong session | 800x900 | 2.596 ms |

Không đề xuất hạ DPI: 48 DPI vẫn mất hơn 4 giây và sẽ giảm chi tiết. Cần sửa chi phí render và cách lấy mẫu, không đánh đổi chất lượng để che bottleneck.

### Profile binding core, hai lượt

- Lượt1: raster 10.810,75 ms; color 378,12 ms; parse/open trong lượt render=0.
- Lượt2: raster 12.675,82 ms; color 295,65 ms; parse/open=0.
- Form cache hoạt động: form_hits tăng 26 -> 67, form_misses giữ15.
- Image cache: image_hits=0, image_misses=0, bytes cache chỉ448.606 trên budget536.870.912.
- Với guard image_cache_key hiện tại, hai số0 là **bỏ qua lookup cache**, không phải tất cả image-cache hit.

## 4. Finding có bằng chứng

### POSTVIEW20.01 - P2 / effort M - Lặp ảnh nền theo chunk

[CONFIRMED] AUTO + ARTIFACT.

Nguồn chứa 2 image objects: bitmap 5000x3125, FlateDecode 19.521.432 byte và alpha mask 41.120 byte. PDF sau bình có **8 bản mỗi object**, cùng hash payload. Tổng bytes ảnh tăng 19.562.552 -> 156.500.416.

Payload lặp dư: (8-1) x (19.521.432 + 41.120) = **136.937.864 byte**, khoảng82,5% dung lượng file xuất.

Đường live: nup_engine -> process_chunk riêng theo chunk -> nup_output_finalize.py:119 _merge_layered_chunks -> :160 final_doc.pages.extend(src_pdf.pages) -> :184 save. Import các tài liệu chunk độc lập bảo toàn resource identity của từng chunk nhưng không hợp nhất ảnh có nội dung giống nhau giữa chunk.

Trong tờ1 có8 lệnh gọi cùng image object357. Khác biệt cần phân biệt:

- Lặp object **giữa chunk** làm file lớn, tăng I/O và RAM.
- Gọi cùng image **8 lần trên một tờ** là bình bản hợp lệ; renderer cần tái dùng decode, không xóa những placement này.

Hướng sửa: shared resource import/dedup giữa chunk theo đầy đủ dữ liệu image + ColorSpace/ICC + Decode + mask/SMask + metadata ảnh. Không chỉ hash pixel payload rồi gộp bừa, không flatten/downsample/nén JPEG để giảm size. Có tiềm năng về khoảng29 MB trước overhead thay đổi; chưa tạo file tối ưu nên đây là ước tính, không phải kết quả sau sửa.

### POSTVIEW20.02 - P2 / effort M-L - PPE bỏ cache ảnh ICC, raster chậm

[CONFIRMED] TRACED + AUTO + ARTIFACT.

File này dùng **ICCBased + SMask**. print_engine/src/content/interp.rs:3192 image_cache_key chỉ nhận ImageMask hoặc ColorSpace tên trực tiếp DeviceGray/DeviceRGB/DeviceCMYK. ICCBased rơi vào None.

Consumer: decode_image_cached :3222-3262; key None bỏ cả cache theo request lẫn shared session cache và gọi decode_image_with_cancel. draw_image :3347 gọi nó cho từng placement. Cùng ảnh được gọi8 lần trên trang đầu; warm session vẫn phải thực hiện đường decode không cache. Counter core phù hợp: cache ảnh không có hit/miss, trong khi cache Form có hit.

Đường hiển thị: usePdfLoader.ts bootstrap/risk -> useTileRenderer.ts:462 chọn accurate -> render coordinator -> render_worker.rs:1416 render_accurate_png -> RenderSession -> draw_image -> PNG. Bitmap thực đã được kiểm, không chỉ mô phỏng hàm.

Core profile xác nhận phần lớn thời gian nằm ở raster, không phải mở/parse/color cuối. Chưa đo tách riêng số mili giây codec/ICC từng placement/composite trong raster, vì vậy không khẳng định cache ảnh một mình sẽ xóa hết13 giây.

Hướng sửa:
- Mở cache cho ảnh ICC tự chứa khi identity/resource scope/profile/mask được chốt an toàn.
- Tái sử dụng decoded image + mask qua nhiều placement/tile/DPI khi semantics không đổi.
- Profile và tối ưu sampling/composite/clip theo vùng đang nhìn; giữ cache Form đã có.
- Đo lại first-frame, warm zoom và correctness sau mỗi lô. Không tăng worker bừa: nhiều worker có thể lại decode cùng ảnh nhiều lần.

### POSTVIEW20.03 - P2 / effort M - Lấy mẫu ảnh alpha/ICC quá thô khi thu nhỏ

[CONFIRMED] TRACED + ARTIFACT.

print_engine/src/content/interp.rs:3594-3604 chỉ mở preview_cmyk_grid cho ảnh CMYK trực tiếp, không alpha, không overprint, blend Normal. Ảnh ICCBased có SMask của ca này không đủ điều kiện -> grid(1,1).

Nhánh :3740 lấy sampler.ink_into(sx,sy) ở tâm texel; :3756 đi composite trực tiếp cho viewer. Bộ lọc footprint tốt hơn ở nhánh CMYK đục không áp dụng cho ảnh này.

Đã mở PNG thật:

- Nguồn PDFium khoảng605x378: chữ/đường cong được lọc mượt.
- PPE96DPI 605x378: viền logo, chữ nhỏ, chi tiết ảnh rõ răng cưa/đứt hoặc lấp nét.
- PPE192DPI 1209x756: thêm chi tiết, phù hợp hiện tượng zoom xong mới thấy rõ.

Không dùng chênh lệch màu sRGB/Fogra39 để đánh giá độ nét bằng một chỉ số SSIM chung; hai pipeline có mục tiêu màu khác nhau. Kết luận ở đây là chất lượng sampling và hình ảnh quan sát được, chưa phải phép so GUI Acrobat.

Hướng sửa: lọc thu nhỏ chất lượng cao cho ảnh ICC/RGB + alpha, xử lý alpha/premultiplication đúng để tránh viền sáng/tối. Tách chất lượng viewer khỏi sampling bảo thủ của TAC/separation; không thay chuẩn đo mực chỉ để hình nhìn “mịn hơn”.

## 5. Vì sao phải zoom và chờ

LivePageFrame.tsx:3071+ cập nhật renderZoom sau250ms. Viewport dùng VIEWPORT_TILE_SETTLE_MS=48 ở renderZoomPolicy.ts. Khi bitmap mới chưa xong, layer cũ được giữ rồi scale theo zoom để tránh trắng/nhấp nháy.

Đây là hành vi progressive/underlay có chủ đích, không tự nó là lỗi. Nhưng:
- bitmap cũ bị phóng tạm -> nhìn mềm/mờ;
- PPE của ca này có thể mất vài giây đến hơn13 giây -> pha chờ kéo dài;
- target DPI cao hơn có thêm pixel -> sau đó hình rõ hơn.

250/48ms không giải thích được13 giây. Vì vậy ưu tiên xử lý raster/cache/sampling. Có thể tinh chỉnh debounce sau khi có click-to-paint trace, không sửa “mù” chỉ các timer.

Current source không gửi coarseZoom cho full-display trong ca này, và nhánh accurateOnly xin thẳng target. Không tái kết luận rằng mọi cold-open đều cố tình render24DPI trước. Cổng12MP surface không bị chạm bởi trang96DPI 2,26MP này.

## 6. Những giả thuyết đã loại trừ hoặc chưa đủ chứng cứ

- Scale oval: tờ đầu output kiểm đủ8 placement đều scale1; không phải lỗi214% trước đó.
- Ảnh nguồn bị downsample sau bình: kích thước và SHA payload ảnh/mask giữ nguyên; loại trừ cho cặp file này.
- Lỗi96/72 nhân hai lần của binary dev cũ: current worker trả bitmap đúng1247x1814 ở96DPI, không tái hiện lỗi đó.
- Font fallback: worker của ca này báo substituted_fonts=[] và geometry_approximated=false. Không dùng bug font ở audit trước để giải thích ca hiện tại.
- Hỏng GPU/thiếu RAM: chưa có bằng chứng. Lượt native có parse0 nhưng raster10-12 giây, image cache không nhận ICC.
- “Mở file” = bootstrap: không đúng toàn luồng. Còn render, queue, PNG transfer, decode và compositor; chưa có trace click-to-paint của GUI hiện tại.
- PDFium nhanh hơn ở phép đo này không có nghĩa được phép thay toàn bộ PPE bằng PDFium bất chấp màu/overprint/DeviceN. Chỉ đổi route khi có policy và kiểm chứng màu.
- Thông số cache/DPI của máy khách/release có thể khác. Audit này đo binary debug đang hiện diện trên máy, không đại diện mọi bản cài.
- Code về co/phóng tem người dùng tự sửa được giữ nguyên; không triển khai việc sửa đã bị hủy.

## 7. Test, đề xuất lô và nghiệm thu

Test hiện hữu: 73/73 frontend ở usePdfLoader, useTileRenderer, LivePageFrame.renderPolicy, renderZoomPolicy; 10/10 backend finalizer/page cache. Một warning Pydantic có sẵn. Các test này chưa khóa ảnh ICC+SMask15,6MP đặt8 lần hoặc resource duplication sau merge.

Lô đề xuất, mỗi lô con tối đa5 file:
1. **Giảm file dư, giữ nguyên PDF:** dedup/shared import ảnh giữa chunk, kiểm OCG/ICC/SMask/CUT và pixel trước/sau. Không hạ resolution.
2. **PPE cache đúng tài nguyên:** ICC image cache có fingerprint đầy đủ; test lạnh/ấm/đổi profile/save-over/nhiều tile và budget RAM.
3. **Sampling viewer:** ảnh ICC+alpha thu nhỏ, kiểm text trong ảnh, đường cong và halo; tách khỏi engine đo mực.
4. **Chốt trải nghiệm:** timing từ thực thi xong -> tab kết quả -> first readable frame -> zoom target ready; active viewport ưu tiên, background không tranh lane; desktop/bản cài thực.

KPI phải đo lại trên đúng source/artifact và binary sau sửa. Chưa hứa phần trăm tăng tốc; ba thay đổi có tác động khác nhau. Không hạ DPI toàn cục, không áp cap mới vô điều kiện trên máy mạnh.

## 8. Evidence và giới hạn

- docs/audit/POST_IMPOSITION_VIEWER_2026-09-20.json: cấu trúc PDF, số đo6 worker run, DPI probes, core profile, binary SHA và tóm tắt.
- Workspace/tmp/post-impose-viewer-20260920/: raw JSON/PNG/stderr từng worker.
- Harness: audit_post_impose_worker.py (dùng audit_viewer_worker.py), audit_post_impose_structure.py, audit_post_impose_zoom.py, audit_post_impose_core.py.
- Đã xem PNG display/PPE96/PPE192 của nguồn và PPE output; không chỉnh/re-export PDF.
- Chưa làm tương tác native Tauri/Acrobat A/B GUI; không đo mouse-to-paint, không thay cấu hình app, không build/install/commit.
- Kết luận có hiệu lực với cặp PDF và binary đã nêu. Nếu phản hồi thuộc file mới khác, phải đo lại trên đúng artifact đó.
