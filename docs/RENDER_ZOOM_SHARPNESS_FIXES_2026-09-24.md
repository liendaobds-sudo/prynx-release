# Sửa cập nhật độ nét trong lúc zoom — 2026-09-24

**Trạng thái 2026-09-25: R24.11 đã bị gỡ sau hai hồi quy runtime.** Người dùng báo “quá tệ, vừa chậm vừa xuất hiện thêm các khung trắng”, kèm ảnh. Mục tiêu tốc độ/độ nét CHƯA ĐẠT. Giữ các sửa R24.07–R24.10; bản R25.01 bên dưới chỉ khôi phục lớp trình bày và sửa nền trắng của ảnh cắt. Người dùng đã duyệt công việc bằng “tiến hành đi” / “làm đi”; các kết quả test trước không thay thế phản hồi runtime.

## R25.01 — gỡ giữ chồng ảnh và sửa mép viewport

### Thay đổi

- Khôi phục chính xác phần R24.11 về bản trước đã lưu, giữ nguyên các thay đổi ngoài phạm vi. Xóa module/test riêng `viewportTilePresentation`; bỏ giữ nhiều khung viewport, xếp lớp theo DPI và dự đoán 1,25×. Không quay lại R24.11 sau khi chỉ sửa một triệu chứng.
- Giữ bộ đệm viewport trước/mới hiện hữu và policy atlas cũ. Thêm test qua nhiều lượt zoom/đảo chiều: không tích lũy canvas viewport đã nghỉ, không tự xin DPI dự đoán khi idle.
- Bỏ nền trắng/đen riêng của khung, canvas và ảnh dự phòng khi tile có clip. Giữ nguyên `applyExactFit` và kích thước pixel 1:1 của viewport, cho phần dư do làm tròn lộ ảnh trang bên dưới. Không giảm DPI hoặc sửa raster/ICC/màu. Phương án kéo canvas phủ 100% khung đã bị loại sau khi screenshot browser thật cho thấy chữ mềm đi do nội suy toàn bitmap.

### Bằng chứng pixel và runtime

- Screenshot người dùng có đường một pixel bị pha trắng. Ví dụ `(140,160)` RGB `(200,229,247)` trong khi hai phía khoảng `(161,211,241)`.
- Đối chứng **hai PNG từ worker thật**, cùng trang 1/632 DPI: tile `3520,2432,1344,832` và vùng rộng thêm 32 pixel mỗi phía. Các dải mép trái/phải/dưới 4 pixel khớp tuyệt đối; mép trên chỉ khác một pixel chữ, tối đa 5/255. Không có đường trắng trong PNG. Đây là loại trừ viền native có hệ thống **tại vùng đã kiểm**, không phải kiểm tất cả DPI/clip.
- Artifact local: `.tmp/render-r25-01/edge-native/{report.json,tile.png,surrounding.png,check_edges.py}`. Binary trong phép đo là `99732680dd5682d94d392680a226705c9192d3b430a3190fd5d12df0786cfee7`, timestamp 00:05:12 ngày 25/09; khác binary R24.10. Phiên này không build native. PDF và executable giữ nguyên trong hai request đối chứng, không suy rằng executable không đổi giữa hai lượt làm việc.
- Edge headless 153.0.4234.48, canvas màu đồng nhất ở tọa độ phân số: nền trắng + bitmap hụt 0,8 CSS pixel tạo **525 pixel sáng**, nền trong suốt không tạo pixel khác ở scale 1. Ca scale 0,93 và 1,237 cũng giảm đường sáng mạnh. Fixture/report `.tmp/render-r25-01/compositor-edges.cjs` và `compositor-cases.json`. Đây là thử nghiệm compositor riêng; nó chứng minh một nguồn mép trắng, chưa chứng minh toàn bộ các mép trên/trái trong screenshot hoặc thay cho WebView PrynX.
- Đối chứng **component LiveTile thật + PNG native của PDF người dùng** trong Edge headless: khung 1344,8×832,8 CSS pixel, bitmap/CSS canvas cùng 1344×832, `seamless=false`. Trước sửa nền: mép phải 810/810 pixel trắng và mép dưới 1320/1320 trắng; sau sửa nền: cả hai về 0. **1.100.864 pixel nội dung khớp tuyệt đối** trước/sau (max channel delta 0), giữ nguyên cả chữ. Ảnh dưới dùng `surrounding.png` căn đúng offset 32 pixel; canvas nội dung opaque nên thay ảnh dưới không ảnh hưởng đối chứng nội dung. Không có lỗi JS. Artifacts `.tmp/render-r25-01/live-tile-component{,-transparent}/{report.json,pixels.json,seamless-false.png}`, harness `.tmp/render-r25-01/live-tile-component.cjs --transparent`. Source đã kiểm có SHA-256 `d93dc6ccae2844550897140bdf6b82b4a4bf02e80137616c3f5958d9fcb9ea60`. Browser/server riêng đã đóng.
- Trace `Vmufs96gc-b2mtfh`, 00:05:35–00:06:08 ngày 25/09: 746 request accurate trên 316 vùng raster khác nhau; 430 lần thử lại. Atlas 104 ready/55 stale/477 cancelled. Dự đoán 1 ready/12 cancelled, lượt ready mất 1.523 ms (772 ms chờ semaphore). Peak dựng lại từ mount/commit/unmount: 82 canvas committed còn mounted, gồm **22 viewport**, 59 nền, 1 base; dung lượng RGBA tối thiểu 155,58 MiB. Không gọi đây là số canvas đồng thời nhìn thấy sau occlusion.
- Main viewport trong trace trên: 34 ready, trung vị 471 ms, tối đa 867 ms. Chuỗi thao tác khác baseline nên không suy tỷ lệ nhanh/chậm; không có bằng chứng vòng lặp idle vô hạn. Số liệu đủ để bác bỏ lợi ích của lô giữ nhiều ảnh/dự đoán trên phiên này.

### Kiểm chứng và giới hạn

Typecheck exit 0; **211 test/8 file đạt** sau bản sửa nền trong suốt giữ pixel 1:1. Hai ca viewport display/PPE kiểm bitmap 640×512 vẫn dùng CSS 640×512 khi khung có kích thước phân số và không có nền trắng riêng; ca không tích lũy và không dựng DPI lạ qua. Các test mock cũ vẫn có cảnh báo jsdom canvas ở decoder fallback. Không cập nhật golden.

Công cụ điều khiển cửa sổ trả `Computer Use was not approved to use PrynX`; không dùng đường khác để điều khiển PrynX. Các PID dev cũ đã được thay; Vite phục vụ qua `localhost:5173`, trả HTTP 200 và sourcemap khớp source trên đĩa; xem `.tmp/render-r25-01/served-source.json`. Không suy trạng thái server từ một kết nối IPv4/IPv6 bị từ chối. Chưa xác minh chuỗi wheel/pan trong cửa sổ PrynX. Không tuyên bố tương đương Acrobat hoặc đã giải quyết độ trễ PPE CPU.

## R25.02 — giảm chi phí native sau phản hồi “chậm”

### Bằng chứng mới

Trace `Vmuft223k-jtw3n9`, owner tạo lúc 00:34:43 ngày 25/09, đã dùng lại group viewport cũ sau rollback. 17 viewport ready, không cancel/stale: FE trung vị 519 ms; 15 request ghép worker trung vị 441 ms, không chờ semaphore/hàng đợi. Atlas 99 ready/48 stale/424 cancelled; đây là tải nền đáng kể nhưng không có bằng chứng main bị chặn permit. Không dùng hiệu số timestamp VIEWER_TRACE để tính độ trễ vì `viewerTraceLog` đóng dấu thời gian lúc ghi trong hàng đợi; khoảng 5.000 IPC trace có lúc chậm gần 3 giây so với sự kiện. Các duration đã capture trong request/native vẫn dùng được.

Đọc cấu trúc PDF gốc bằng pikepdf: tám SMask `/Luminosity` có tám `/G` khác nhau. Năm mask khai wrapper Gray nhưng lồng Form CMYK và radial DeviceN Black, nên không tự thay bằng renderer xám hoặc thêm cache theo G. Chúng đi vào shading process song song, nơi mọi pixel đều ghi cùng cờ atomic và có thể cập nhật bốn biên atomic.

### Thay đổi giới hạn

- `print_engine/src/content/interp.rs`: chỉ ghi cờ `painted` khi còn false; chỉ gọi `fetch_min/max` khi pixel có thể mở rộng biên. Giữ phép cập nhật nguyên tử và thứ tự float/composite; trạng thái được đọc sau Rayon join. Giá trị cũ do đọc Relaxed chỉ có thể gây cập nhật thừa, không bỏ cực trị. Không thêm worker/cache/cap hoặc thay hình ảnh.
- `desktop/src-tauri/Cargo.toml`: tối ưu riêng package PPE ở mức 3 trong profile dev, tương tự image/PDFium; shell vẫn mức 1. Không thêm profile release hoặc LTO. Trước sửa PPE cũng chạy mức 1 trong worker dev.

### Đo và verify lõi

Profiler độc lập release, A/B/B/A, mỗi process bỏ mẫu đầu rồi lấy ba mẫu warm, cùng PDF/trang/clip. Đây chưa phải worker/WebView. Artifact `.tmp/render-r25-02/core-optimization-ab.json`: chỉ đổi tối ưu package PPE mức 1→3, render trung vị lần lượt 382,16→337,89 ms (104 DPI), 351,22→305,21 ms (632 DPI), 291,91→254,99 ms (2072 DPI); checksum RGB khớp.

Artifact `.tmp/render-r25-02/core-atomic-ab.json`: cùng tối ưu mức 3, riêng sửa atomic giảm render 355,20→332,14 ms (104), 314,89→293,75 ms (632), 258,93→239,42 ms (2072). Ca một thread, ngân sách render/cache 256/128 MiB: 620,15→631,32 ms, không cho thấy lợi ích; đường shading song song không chạy trong ca này. Không cộng hai tỷ lệ của hai phép đo khác nhau để dự đoán tốc độ app. Tất cả checksum khớp.

`cargo test --offline --release --features perf-probe --quiet`: **750 test đạt, 7 ignored**, gồm footprint chính xác scalar/parallel và shading không tô không được phát diagnostic. Không cập nhật golden. Binary cũ `99732680dd5682d94d392680a226705c9192d3b430a3190fd5d12df0786cfee7` được giữ ở `.tmp/render-r25-02/worker-before.exe` để đối chứng protocol thật. Tiến trình `cargo run` của dev tự biên dịch lại; không đóng app bằng lệnh của agent. Probe Cargo trùng đã dừng đúng hai PID do agent tạo, không dừng dev watcher.

### Kết quả worker thật

Dev watcher mở lại app lúc 00:46:17, binary SHA-256 `65b26af372f6dc56a6a839eb5a3c109ee236be6fb328bd82aede9a950c45c68d`. Gọi protocol thật bằng hai binary đã lưu, thứ tự A/B/B/A; mỗi process bốn vòng, bỏ vòng đầu khi tính warm. `PRYNX_PERF=0` để phép đo không mang chi phí trace; không điều khiển WebView. Tất cả 80 request trả `rendered`, không chờ queue/semaphore, mọi PNG và metadata chất lượng khớp trước/sau, kể cả cold và ca một thread. Artifacts `.tmp/render-r25-02/{benchmark_worker.py,worker-ab.json,worker-verification.json,source-manifest.json}`.

| DPI | Tổng worker trước, trung vị ms | Sau, ms | Giảm |
|---|---:|---:|---:|
| 104 | 420 | 361 | 14,0% |
| 692 | 375,5 | 308,5 | 17,8% |
| 632 | 392 | 316,5 | 19,3% |
| 2072 | 385 | 307,5 | 20,1% |
| 632, một thread | 676 | 668,5 | 1,1% |

Ca một thread dao động lớn giữa các block (before 641/713, after 633/681 ms), không gọi 1,1% là cải thiện có ý nghĩa. Lần đọc lại hash binary app khớp chính binary AFTER đã đo. Không đổi frontend trong lô R25.02; sửa viền R25.01 vẫn giữ nguyên. Khoảng 300 ms/request vẫn chưa đạt mục tiêu nét tức thời khi zoom. Các số trên là worker độc lập, không phải độ trễ người dùng nhìn thấy trong cửa sổ PrynX.

## Tái kiểm sau phản hồi vẫn mờ

[Trace mới và phép đo kernel](audit/RENDER_LOAD_2026-09-24/zoom_sharpness_runtime_after_coalescing.json): `Vmufpi59w-lnsjf5`, seq 1–4506. Runtime có `queued_key`, xác nhận đường coalesce mới đã chạy.

- Cùng document identity hash `6b7a9ffaa811`: 13 request viewport chính, cả 13 ready, 13 FE commit, không có cancelled ở nhóm này. Việc giữ công việc đã có tác dụng trong phiên thử này.
- 13 native completion ghép chính xác request ID: **416–657 ms**, trung vị **475 ms**. Request→decode FE trung vị **550 ms**. Hai điểm queue được ghi vẫn bằng 0; chưa tách toàn bộ chờ/contend trong worker.
- Chuỗi wheel khác lần trước nên không gọi 689,5→475 ms là mức tăng tốc của bản vá. FE commit cũng không chứng minh compositor đã trình bày hay pixel đủ nét cho mức zoom đang sống.
- Có lượt ảnh scale 1,083 hoàn tất khi khung đã lên khoảng 7,169: giữ được ảnh trung gian nhưng nó vẫn phải phóng lớn nhiều lần. Có lượt zoom-out co bitmap xuống còn khoảng 888×507 CSS px giữa viewport 1292×733; policy coverage có thể dùng underlay. Không bỏ guard coverage chỉ để tăng số lần commit.

Kiểm giả thuyết chi phí dựng transform ICC bằng test thủ công mới `color::icc::tests::profile_softproof_setup_and_viewport` trong `print_engine/src/color/icc.rs`: chạy `cargo test --offline --release profile_softproof_setup_and_viewport -- --ignored --nocapture`, exit 0, 1 test đạt. Với 1.118.208 pixel, 4 mẫu setup là 0,820 / 0,823 / 0,932 / 0,771 ms; batch chuyển màu là 42,419 / 47,858 / 50,959 / 36,118 ms; đối chiếu byte với transform tham chiếu đạt. Không có căn cứ thêm cache transform để xử lý độ trễ hàng trăm ms. Đây là **kernel release**, không phải worker dev đang chạy hay phép đo trên PDF người dùng; chưa quy được phần còn lại thành raster/PNG.

Lượt tái kiểm trước khi nhận file chỉ thêm phép đo. Người dùng sau đó cung cấp PDF và trang 1; kết quả đo trên file và bản sửa native nằm ở R24.10 dưới đây.

## R24.10 — đo trang 1 và bỏ Form ngoài viewport

File được người dùng chỉ định: `test/CMNM2026 - Giay moi_BLUE - in_OUTLINE_FONTS_5e2846.pdf`, 18.059.736 byte, SHA-256 `e657eab1a222ca11ccbe01554f663405251bfb0952fb79eee5083f9c0ce06dd1`. Các dấu `\_` trong tin nhắn là escape của dấu gạch dưới, không phải thư mục con. File gốc này có kích thước khác tài liệu 17.869.243 byte trong trace trước: phép đo dưới đây dùng **file người dùng cung cấp**, không tuyên bố đã xác minh đó là cùng byte với bản làm việc trong tab cũ.

[Worker baseline](audit/RENDER_LOAD_2026-09-24/page1_worker_baseline.json) gọi trực tiếp binary dev đang được dùng, protocol PXRW v4, page 1, FOGRA39 relative, pipeline PPE. Bốn mức 104/692/632/2072 DPI dùng clip từ trace; mỗi mức lặp bốn lần và đảo thứ tự. Sau lượt cold đầu, 15 kết quả: render 360–489 ms (trung vị 406), encode 17–22 ms (trung vị 19), total 382–512 ms (trung vị 428). PNG lặp cùng case có SHA-256 giống nhau. Queue/wait bằng 0. Vì vậy giảm encode hoặc debounce không xử lý phần lớn độ trễ của ca này.

[Profiler theo pha và đối chứng A/B](audit/RENDER_LOAD_2026-09-24/page1_raster_profile.json) dùng cùng trang/clip/profile, build release của lõi PPE. Đây không phải timing WebView hoặc timing của worker dev. Ở clip 632 DPI, raster warm trước sửa khoảng 267–307 ms, màu khoảng 44–48 ms. Trong raster, soft-mask chiếm khoảng 134–139 ms inclusive; không cộng các span có lồng nhau. Quan sát thêm cho thấy 5/10 transparency group có giao BBox/clip rỗng nhưng vẫn cấp surface toàn viewport.

Thay đổi sản xuất giới hạn trong `print_engine/src/content/interp.rs`:

- Viewer bỏ Form có giao BBox/clip rỗng trước khi giải nén nguồn hoặc tạo surface. Giới hạn BBox vẫn dùng lề khử răng cưa hiện hữu, giữ xử lý bảo thủ khi tọa độ không hữu hạn.
- Giữ đường thu outline chữ và đường đo mực. Form tự chứa nên bỏ Form vô hình không làm rò hoặc mất state của caller; vẫn kiểm cancellation.
- Test mới dùng ngân sách đủ cho trang nhưng không đủ cấp thêm group: trước sửa ca group ngoài viewport thất bại vì hết RAM; sau sửa đạt. Group nhìn thấy, chạm biên và chế độ outline vẫn đi vào đường dựng thật.

`print_engine/src/lib.rs` và các span trong interpreter bổ sung đo image/soft-mask/clip/BBox. Chỉ feature `perf-probe` có đối chứng `PRYNX_PROBE_DISABLE_FORM_CULLING=1`; worker mặc định không đọc biến này và không trả chi phí đo. Không thêm cap worker, RAM, độ phân giải hoặc giảm chất lượng.

Verify cuối: `cargo test --offline --release --features perf-probe --quiet` đạt **750 test, 7 ignored**, không cập nhật golden; `cargo build --offline --bin pdf-inspector` trong `desktop/src-tauri` đạt. Các cảnh báo dead-code của bản dev không chặn build. Người dùng xác nhận đã tắt app trước khi cập nhật binary. Kết quả benchmark và tình trạng mở lại được chốt ở phần tiếp theo.

### Kết quả chốt

Đối chứng chạy trong **cùng executable profiler**, tắt/bật culling bằng cờ chỉ có trong `perf-probe`, đảo thứ tự A/B rồi B/A, mỗi lần bỏ mẫu cold và lấy ba mẫu warm (sáu mẫu/mode/case):

| DPI / cấu hình | Raster trước, trung vị ms | Raster sau, trung vị ms | Giảm |
|---|---:|---:|---:|
| 104 / mặc định | 319,02 | 300,19 | 5,9% |
| 692 / mặc định | 272,43 | 239,58 | 12,1% |
| 632 / mặc định | 273,98 | 255,09 | 6,9% |
| 2072 / mặc định | 289,57 | 247,19 | 14,6% |
| 632 / `RAYON_NUM_THREADS=1`, render 256 MiB, resource 128 MiB | 361,39 | 319,58 | 11,6% |

Checksum RGB và kích thước PNG proxy khớp trước/sau cho mọi mẫu. Cấu hình thấp chỉ dùng để đo, không thay policy tài nguyên trong ứng dụng. Số đo so hai executable theo thứ tự trước/sau ban đầu được giữ trong artifact nhưng dùng bảng A/B này làm kết luận vì giảm ảnh hưởng dao động tải máy.

Worker dev mới: SHA-256 `bce5bbcd5cd634ec8d03ed595e9da996990f0c9f1f47af5656678abab696a693`. Gọi protocol thật lại cùng 16 request: **cả 16 SHA-256 PNG khớp baseline**. Sau cold đầu, render trung vị 381 ms, encode 18 ms, total 402 ms (372–416 ms). Baseline total trung vị 428 ms; mức chênh quan sát khoảng 26 ms, không phải bước nhảy đủ làm zoom nét liên tục. Phép đo worker trước/sau không interleave, không thay cho A/B lõi hay cảm nhận WebView.

Backend và Vite được khởi động lại trong cùng môi trường dev với token phiên mới; cả `/health` và Vite trả HTTP 200. Bản app mở lại dùng binary trên. Cần người dùng thử wheel trang 1 để xác minh compositor; chưa đánh dấu mục tiêu trải nghiệm đạt.

### Giới hạn và bước còn lại

R24.10 chỉ loại phần việc chắc chắn không tạo pixel. Nó không biến đường PPE CPU thành renderer tương tác theo từng frame. Các mặt nạ còn nhìn thấy, lấy mẫu ảnh, blend và chuyển màu vẫn phải tính lại theo DPI/clip. Chưa có căn cứ gọi đây là hết mờ hay ngang Acrobat.

Mốc tiếp theo phải đo **độ trễ và độ nét của ảnh thực sự hiện trong lúc wheel**, cùng thời gian nét cuối, trên trang này. Nếu vẫn ở hàng trăm ms, hướng nâng cấp chính là đường trình bày giữ lại nhiều mức ảnh/vùng đã dựng và tối ưu mặt nạ/blend đang nhìn thấy; cần đối chứng pixel, profile và invalidation trước khi đưa vào viewer. Chuyển sang GPU/scene giữ lại là thay đổi kiến trúc cần một lô triển khai riêng; không thể chứng minh bằng giảm timer hoặc tăng số request.

## R24.11 — giữ canvas nhiều mức DPI và trình bày từng vùng (đã gỡ)

Người dùng duyệt bước nâng cấp trình bày và thử nghiệm native bằng “làm đi”, sau đề xuất giữ nhiều mức ảnh, cập nhật từng tile và đo blend/mặt nạ. Lô frontend gồm 5 file: `viewportTilePresentation.ts`, test policy tương ứng, `LivePageFrame.tsx`, test LiveTile, tài liệu này. Thử nghiệm native được làm có đối chứng riêng; chưa dùng test component để kết luận ca runtime đã đạt.

- Giữ nguyên React instance/canvas PPE đã decode qua zoom và pan; xếp lớp theo DPI tăng dần. Ảnh thấp DPI về muộn lấp vùng thiếu nhưng không phủ ảnh DPI cao. Loại ảnh chỉ khi có ảnh ít nhất cùng mật độ phủ kín vùng trang; máy <8/<16 GiB giới hạn canvas phụ 32/64 MiB, máy full không cap. Tắt render hoặc đổi file/revision/profile/trang/góc xoay giải phóng ảnh giữ.
- Mỗi cell atlas hiện ngay sau decode. Kiểm coverage toàn atlas vẫn quyết định bỏ request viewport trùng lặp, không còn chặn trình bày từng vùng đã có pixel. Giữ phép snap mép theo device pixel hiện hữu.
- Tách nhóm render/hủy theo slot số tăng dần của mỗi instance; dọn canvas cũ hoặc hủy dự đoán không hủy viewport mới. Khóa tài liệu/DPI/clip dài chỉ dùng nội bộ để tra slot, không đưa vào identifier IPC.
- Khi viewport hoàn tất và input yên 160 ms, chuẩn bị một mức DPI 1,25× trên lane background. Input mới hủy phần dự đoán chưa decode; ảnh đã decode vẫn dùng ngay. Giữ nguyên chất lượng/pipeline PPE, không đưa PDFium trở lại trên ảnh PPE.

Baseline: hai test tích hợp mới đỏ trên code cũ — cell atlas đã vẽ vẫn bị ẩn, và ảnh zoom-out thấp DPI thay mất canvas DPI cao. Sau sửa: `npm run typecheck` exit 0; 9 file test render đạt **224 test**. Bao gồm ảnh dự đoán trước khi wheel tiếp, hủy dự đoán độc lập, callback muộn, identity mới không nhận ảnh cũ, zoom liên tục, đổi hướng, pan, seam và terminal lỗi. Một assertion cũ yêu cầu bỏ ảnh rộng A khi B chỉ phủ một phần đã đổi theo hợp đồng giữ A ở phần còn thiếu. Không đổi golden. Cảnh báo jsdom canvas của test fallback decoder cũ vẫn có, test đạt.

### Hồi quy runtime và sửa hợp đồng IPC

Người dùng trả lời **“tệ hơn, ko nét nữa”**. Kết luận lô đã ổn bị thu hồi. Đã rollback riêng R24.11, verify lại 208 test và dừng thử nghiệm native R24.12; `ink.rs` được đối chiếu khớp HEAD, không build hoặc đưa thử nghiệm vào binary.

Log Vite lúc 23:49:33–34 ghi 10 lần `Accurate render failed; refusing display fallback: group_key vượt giới hạn độ dài render worker.` Nguyên nhân: bản đầu nối toàn bộ key chứa path/revision/profile vào `pageInstanceId`, rồi `viewerRenderGroupKey` bọc thêm prefix/suffix. `valid_identifier` ở Rust giới hạn **256 byte UTF-8**. Test đầu dùng tên file ngắn và mock không kiểm hợp đồng, vì vậy bỏ sót lỗi. Đây là lỗi của lô R24.11, không phải PPE raster chậm hơn.

Sửa lại bằng `useId` cho instance + số slot tăng dần, không cắt chuỗi hoặc dùng hash dễ va chạm. Hồi phục lô trình bày với mã ngắn. Test harness giờ mô phỏng đúng giới hạn UTF-8 của worker; thêm ca đường dẫn PDF người dùng, token/proof đầy đủ và đường dẫn Unicode rất dài. Kiểm có main, atlas, dự đoán và target zoom cuối, các nhóm độc lập.

Đối chứng qua **protocol worker thật** trên PDF/trang 1, 632 DPI, clip `3520,2432,1344,832`:

| Mã nhóm | Byte UTF-8 | Kết quả |
|---|---:|---|
| Nối path/revision/profile như bản lỗi | 318 | `error`, đúng thông báo `group_key` quá dài |
| Instance + slot mới | 35 | `ready`, PNG có SHA-256 khớp baseline R24.10 |

Artifact chẩn đoán local: `.tmp/render-r24-11/worker-contract.json`. Script đã ghi đầy đủ và đối chiếu thành công; thao tác in cuối gặp lỗi encoding cp1252, lần đọc JSON sau xác nhận kết quả bằng output ASCII exit 0. Không báo đây là benchmark tốc độ hoặc kiểm WebView.

Chốt lại: typecheck exit 0; **226 test/9 file đạt**; diff check đạt. Vite HTTP 200 và sourcemap khớp bản mã nhóm ngắn, SHA-256 nội dung LF `11e19033c9aec108d47a6f216525ae666372c33c0778e7c6e08a1a95a44f7843`. Đã gửi người dùng thử lại độ nét cuối. **Chưa xác nhận trải nghiệm runtime hoặc ngang Acrobat; native đang tạm dừng để kiểm hết hồi quy này.** Dự đoán chỉ giúp khi có thời gian rảnh; lần đầu zoom nhanh tới vùng/DPI chưa dựng vẫn phụ thuộc PPE CPU.

### Baseline lô R24.08

Ca gốc: người dùng wheel zoom PDF trong viewer PrynX; ảnh chỉ nét rõ khi chậm hoặc dừng zoom. Bản R24.07 trước đó đã xử lý lớp PDFium phủ lại PPE, chưa giảm thời gian tạo pixel.

Baseline runtime đã lưu: [trace sau bản chống chớp](audit/RENDER_LOAD_2026-09-24/zoom_sharpness_runtime_post_flash_fix.json). Tài liệu PPE có 97 request viewport chính, 88 cancelled, 8 ready, 1 stale; 8 native ready mất 537–1551 ms, trung vị 689,5 ms. Đây là dữ liệu trước lô này.

Trước khi sửa, 6 ca mới R24.08/R24.09 đều đỏ:

- Render giả lập 80 ms, zoom đổi mỗi 20 ms trong 320 ms: **0** bitmap mới hiện trong lúc input chạy, ở cả hai trường hợp có/không underlay.
- Sau prime và lần sharpen đầu, zoom tiếp vẫn chưa phát request vì lặp timer 96 ms.
- Target kế tiếp được phát trước khi request đang chạy tới terminal, thể hiện việc thay/hủy target cũ.

## Lô 1 — frontend, 5 file

| File | Thay đổi |
|---|---|
| `desktop/src/components/workspace/viewportTilePolicy.ts` | Tách ảnh đang hiện (`visible`), target đã nhận (`target`), mong muốn mới nhất (`queued`). PPE cùng nội dung giữ request đang chạy, coalesce target mong muốn; hoàn tất thì trình bày ảnh và chuyển tiếp. Đổi identity hủy ngay. Terminal lỗi giải phóng hàng đợi; đảo chiều về ảnh đang hiện có thể tái dùng ngay. Đường display-only giữ chế độ thay target hiện hữu. |
| `desktop/src/components/workspace/LivePageFrame.tsx` | Bật coalesce cho viewport PPE; tách mount khỏi presentation để ẩn tile thiếu coverage không hủy raster. Bitmap luôn đi cùng clip và hình học của chính nó. Terminal lỗi render/decode/canvas báo về reducer. Tắt render vẫn hủy công việc. Trace bổ sung `queued_key`. |
| Cùng file trên — R24.09 | Settle 96 ms chỉ dùng trước khi bắt đầu sharpen sau prime. Những lần zoom tiếp dùng in-flight/coalesce; cache hit mới cũng kết thúc trạng thái prime. |
| Cùng file trên — ưu tiên viewport | Truyền `targetRasterPending` vào policy atlas đã có: chỉ mở công việc atlas sau target viewport hiện tại, không dùng ready của B để mở atlas thuộc C. Giữ nguyên độ phân giải, worker và ngân sách tài nguyên. |
| `desktop/src/components/workspace/LivePageFrame.liveTile.test.tsx` | Ca input liên tục, prime, terminal lỗi, đổi file/revision/profile/trang/xoay, coverage zoom-out, tắt/bật render. Hai ca R24.07 cập nhật thứ tự B→C theo hợp đồng mới; vẫn kiểm PPE-only, hình học clip đúng và target cuối. |
| `desktop/src/components/workspace/viewportTilePolicy.test.ts` | Coalesce B/C/D, callback trễ, identity khác, lỗi trước/sau queued, đảo chiều và bỏ target. |
| Tài liệu này | Nhật ký thay đổi, baseline, verify và phần còn chờ. |

Không bỏ guard generation trong coordinator. Chỉ target được nhận mới gọi xuống hook/coordinator; response sai nội dung vẫn bị loại. Không dùng DPI thấp hơn để đổi lấy số đo tốc độ.

## Verify

Chạy trên Windows thật:

```text
npm run typecheck
node node_modules/vitest/vitest.mjs run 
  src/components/workspace/LivePageFrame.liveTile.test.tsx
  src/components/workspace/LivePageFrame.renderPolicy.test.ts
  src/components/workspace/viewportTilePolicy.test.ts
  src/components/workspace/renderZoomPolicy.test.ts
  src/hooks/viewer/useTileRenderer.test.ts
  src/hooks/viewer/renderCoordinator.test.ts
  src/hooks/viewer/tileRenderScheduler.test.ts
  src/lib/viewerFirstFrame.test.ts
```

- Typecheck: exit 0.
- Vitest: **8 file / 208 test đạt**, exit 0.
- Ca input liên tục: từ 0 thành **ít nhất 3 mức bitmap được trình bày trong 320 ms**, sau đó tới đúng target cuối trong 200 ms kiểm tra tiếp. Đây là phép đo component với latency giả lập cố định, **không phải mức tăng tốc của native**.
- Test fallback decoder hiện hữu in cảnh báo jsdom chưa triển khai canvas; test vẫn đạt. Ca canvas thất bại mới dùng mock riêng để kiểm chuyển tiếp target.
- `git diff --check`: đạt, chỉ cảnh báo chuẩn hóa LF/CRLF của Git.
- HTTP Vite trả 200; source trong sourcemap khớp nội dung file trên đĩa. Điều này xác nhận source đang được phục vụ, không thay thế kiểm tra compositor Tauri.

Chưa có A/B runtime sau bản sửa, chưa có đối chứng Acrobat. Không build/restart Tauri, không sửa native trong lô này. Chưa có bằng chứng giảm trung vị native 689,5 ms.

## Chốt runtime và lô tiếp theo

Theo `.agents/skills/prynx-audit-workflow/SKILL.md`: “User xác nhận chạy thật OK rồi mới sang lô kế.” Đã gửi câu hỏi kiểm tra wheel liên tục, đảo chiều, pan và target cuối trên chính PDF người dùng vừa thử.

Giữ B sống có thể khiến target cuối chờ phần thời gian còn lại của B rồi mới chạy lượt cuối. Đổi lại, các ảnh trung gian hợp lệ không còn bị hủy liên tục. Cần đo đồng thời cập nhật nét trong lúc zoom và thời gian nét cuối; không chỉ đếm ít request hơn để tuyên bố nhanh hơn.

Sau khi runtime xác nhận, lô native sẽ nối timing thực có của worker vào trace và tách prepare/open, raster, chuyển màu, encode trước khi chọn tối ưu. Giữ baseline cold/warm, cùng PDF/page/clip/DPR/profile và actual engine. Không suy hai trường queue bằng 0 thành không có contention bên trong worker; không dùng binary/harness cũ để báo tốc độ hiện tại.
