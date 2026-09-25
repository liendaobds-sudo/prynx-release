# Sửa zoom theo log thao tác thực tế — 25/09/2026

Theo báo cáo `BAO_CAO_AUDIT_ZOOM_THUC_TE_2026-09-25.md`, người dùng đã yêu cầu “sửa đi”. Mục tiêu còn mở: giảm thời gian chờ nét trong và sau zoom, giữ màu/geometry và không xuất hiện khung trắng.

## Lô A — R25.04.1: chặn phát lại atlas của zoom cũ

`LivePageFrame.tsx`: điều kiện phát cell nền phải đồng thời có plan đúng raster hiện hành và viewport đã sẵn sàng cho raster đó. Trước đây `settled` đổi trước effect cập nhật target khiến atlas cũ bật lại trong một render rồi bị hủy. Không thay DPI, worker, màu hoặc cách đặt bitmap.

Bằng chứng:

- Test hồi quy đỏ trước sửa ở cả full/mid/low: phát thừa 6/2/2 request nền trước viewport mới ready; sau sửa cả ba đạt. Test còn kiểm atlas mới được phát đầy đủ sau viewport ready.
- 219 test trong 9 file đạt; TypeScript đạt. Log tại `.tmp/render-r25-05/{test-red,test-green,regression,typecheck}.log`.
- Fixture Edge dùng TileLayer thật, replay hình học/DPR/DPI anchor của log: trước sửa phát lại 48 request atlas cũ, sau sửa 0; cả hai vẫn phát 54 cell atlas mới sau viewport ready. `.tmp/render-r25-05/browser-atlas/report.json`. Transport/ảnh fixture là mô phỏng; không dùng thời gian fixture để suy tốc độ PPE/WebView thực.
- Snapshot runtime sau sửa: `.tmp/render-r25-05/post-atlas.snapshot.log`, SHA-256 `ef54eebc87bf99612bd8c856256db2d825a0caad586de30e3bd914f67f9ce6ff`. 307 state có marker bản sửa, không state nào phát atlas khi plan/viewport chưa hiện hành.
- Người dùng xác nhận: “không có khung trắng nữa nhưng tốc độ thì khó đánh giá, tôi chưa hài lòng lắm”. Khung trắng cũng đã có bản sửa riêng R25.01; không quy toàn bộ kết quả này cho gate atlas.

Tốc độ **chưa nghiệm thu**: 30 viewport ready trong snapshot, worker trung vị 347 ms, frontend trung vị 411,5 ms; khoảng ngoài native command lớn nhất 862 ms. Chuỗi thao tác khác lượt trước nên không suy phần trăm cải thiện.

## Lô B — R25.04.3: bỏ dynamic import khỏi đường gửi PPE

`useTileRenderer.ts`: thêm `ppe-ipc-submit`, `ppe-ipc-receive`, `ppe-ipc-reject`, request ID và thời gian round-trip ngay quanh invoke PPE, chỉ khi người dùng bật log. Coordinator wait trước đây gộp cả dynamic import và invoke nên chưa xác định đoạn chậm.

Lượt người dùng mở/zoom trang 1 tiếp theo cho 33 viewport có đủ mốc. Request `f7a029cf…` mất tổng 747 ms: **415 ms trước invoke**, 15 ms đến native entry suy từ `IPC_PPE`, 308 ms native, 3 ms trả về FE và 6 ms tạo source. Trong khoảng trước invoke có các long task 108/111/88 ms. Code trước điểm đo chỉ có các kiểm tra đồng bộ và `await import('@tauri-apps/api/core')`. Không phải bằng chứng nghẽn HTTP slot: 33 request có submit → native entry trung vị 2 ms, tối đa 17 ms.

Bản sửa dùng import tĩnh `invokeNativePpe` ở module hook, gọi ngay trong stack nhận viewport. Không thay quy tắc lane, DPI, payload hoặc fallback. Import SDK tự nó không gọi native nên các nhánh browser/HTTP vẫn dùng được.

Bằng chứng trước/sau:

- Test `R25.04.3` kiểm native đã nhận yêu cầu trước khi caller nhường lượt UI: đỏ trước sửa (0 invoke), xanh sau sửa (1 invoke đúng clip/priority/purpose). 50 test trong 3 file và TypeScript đạt. Log `.tmp/render-r25-06/{red,green,typecheck-fix}.log`.
- Verify cuối: 196 test/8 file trong `regression.log` và 24 test chính sách hiển thị trong `render-policy.log`, tổng **220 test/9 file đạt**. Cảnh báo jsdom thiếu canvas xuất hiện ở test fallback có sẵn; không có test thất bại.
- Fixture Edge dùng hook thật và module đã làm ấm, đặt tải UI giả lập 150 ms ngay sau `getTileUrl()`: ABBA trước sửa submit sau 150,4/150,3 ms; sau sửa 0/0,2 ms và trước tải UI. Đây chỉ là oracle thứ tự admission, không phải tốc độ PPE. `.tmp/render-r25-06/browser-ipc/report.json`.
- Vite source-map khớp file nguồn, SHA-256 `c9299407dc18814c76a8aea628ee251890200d967c6a59a4ffe3376447ee2ef5`.
- Người dùng chạy lại thao tác. 34 viewport của trace `Vmug4hsx9-5zcala`: trước invoke trung vị **0 ms**, tối đa **1 ms** (có -1 ms do làm tròn log). Submit → native entry trung vị 2 ms, tối đa 4 ms. Khoảng chờ đã đo ở trên không còn trong lượt này.
- Snapshot trước: `.tmp/render-r25-06/ipc-zoom.snapshot.log`, SHA-256 `a57d2e89f29225bf1cdbdef9fbe1b9972cc62147e1b7b76f7fc9e95d5923c61f`.
- Snapshot sau: `.tmp/render-r25-06/ipc-after.snapshot.log`, SHA-256 `7e39606ac3515a0fd30f5de104c9979bb47775185e7a10b9851b3588d05fca86`. Script `analyze_ipc.py`, bảng request và summary lưu cùng thư mục; cutoff bản sửa là `1790290008491` epoch ms.

Giới hạn: thao tác trước/sau do người dùng làm tay, không lấy 422 → 360,5 ms trung vị FE làm phần trăm tăng tốc kiểm soát. Worker sau sửa vẫn trung vị **350 ms**, tối đa 618 ms; native trả xong → FE nhận tối đa **176 ms**. Tổng request lớn nhất vẫn 864 ms. Chưa đạt mục tiêu nét trong khi zoom hoặc ngang Acrobat.

Chưa thay hàng đợi hoặc hủy target theo ngưỡng chưa đo. Không dùng `queue_ms=0` để kết luận không có tắc nghẽn. Các mốc DOM/rAF chỉ là cơ hội hiển thị, không xác nhận pixel đã lên màn hình. Bước còn lại: profile PPE trên đúng working copy và chi phí UI/nhận target mới, với kiểm chứng ảnh trước khi thay kernel hoặc trình bày.

## Dữ liệu đầu vào còn cần cho profile PPE

Frontend ghi identity `17869243:1786097761398351100:1786097761204255100`, prime path hash `6e398af4`. Bản có sẵn `test/CMNM2026 - Giay moi_BLUE - in_OUTLINE_FONTS_5e2846.pdf` là 18.059.736 byte; đường dẫn nhiều thư mục từ tin nhắn ban đầu không tồn tại tại lúc kiểm tra. Đã hỏi đường dẫn chính xác để không dùng số đo bản khác làm bằng chứng cho lỗi hiện tại. Native tự đọc identity tại đường dẫn truyền vào, nên metadata FE chưa thay thế việc đối chiếu file native thật.

Tìm được một bản 17.869.243 byte trong `_quarantine/runs/20260825T222216+0700_ec94298_3c6ff7fc/payload/.tmp/runtime-smoke/CMNM2026-cold-render-20260810-1455.pdf`, cùng modified-nanos nhưng khác created-nanos và path hash. Chưa xác nhận bản này trùng byte với file đang mở; không dùng nó làm oracle runtime. Chưa thay kernel native ở lô này.

### Đã giải quyết chênh lệch đường dẫn

Thêm sự kiện `viewer-render-source` tại effect đổi tài liệu của `useTileRenderer` (logger vẫn opt-in). Runtime ghi trực tiếp đường worker nhận: `C:\Users\Khanh Pham\Desktop\PDF\CMNM2026 - Giay moi_BLUE - in.pdf`. Đọc stat tại đường này khớp cả size/modified/created với identity FE; SHA-256 **`95f38cf429fe7dd7c6500043ce308fd2e87e80a2290217d428fe0c68c6098184`**. Đây là tài liệu dùng cho phép đo dưới, trang 1. Bản trong `test/` là đối chứng khác, không dùng thay thế âm thầm.

## Lô C — profile PPE và gửi hủy ngay

### Profile trên đúng file runtime

Script `.tmp/render-r25-07/profile_current.py`, số liệu và PNG `.tmp/render-r25-07/page1-profile.json`. Worker riêng được tạo bằng chính EXE ứng dụng, `PRYNX_PERF=0`, không điều khiển/đóng app. Mỗi vùng lấy từ log thực, 4 chu kỳ; bảng là trung vị 3 chu kỳ warm.

| DPI | Worker tổng | Render | Encode | Core raster | Core màu |
|---|---:|---:|---:|---:|---:|
| 104 | 370 ms | 347 ms | 20 ms | 292,98 ms | 36,82 ms |
| 848 | 313 ms | 292 ms | 18 ms | 220,62 ms | 43,54 ms |
| 2072 | 318 ms | 297 ms | 18 ms | 221,49 ms | 43,47 ms |

Core là profiler release riêng, không cộng thời gian core vào worker. Các span raster là **inclusive**, không cộng mask/image/composite để suy tổng. Chi phí open/parse warm gần 0, resource dưới 1 ms. Tách soft mask bằng bản sao nguồn trong `.tmp/` cho thấy phần vẽ nội dung mask khoảng 84–100 ms ở hai clip zoom, setup khoảng 24–28 ms, extract khoảng 13–15 ms. Các mask có ObjectId khác nhau; chưa có bằng chứng để thêm cache mask lặp trong cùng request.

Thử fast path composite Normal/CMYK trong bản sao riêng: ABBA giữ checksum RGB nhưng tốc độ không ổn định, chậm hơn ở DPI 2072 và cấu hình một thread. **Loại ứng viên, không đưa vào nguồn/native đang chạy.** Artifact `candidate-ab.json` ghi kết quả âm; bản source clone đã bỏ ứng viên. Mọi sửa profiler chi tiết nằm trong `.tmp/`, không thay kernel production. Artifact profiler tại target chung được build lại từ nguồn dự án sau đo.

### R25.04.3 bổ sung — đường hủy cũng nhường lượt ở dynamic import

Từ snapshot sau bản sửa gửi render: nối 203 `render-coordinator-stale-work` với `RENDER_WORKER_CANCEL`, tính thời điểm yêu cầu hủy bằng `event_epoch_ms - stale_ms`. Đến mốc native ghi đã gửi hủy: trung vị **146 ms**, tối đa **423 ms**. Đây là khoảng tổng frontend → native cancel, chưa tách mọi stage. Bảng `.tmp/render-r25-07/cancel-delay.json`.

`renderCoordinator.ts`: dùng import tĩnh cho lệnh hủy, gửi ngay trước khi nhường lượt UI. Giữ nguyên retry 16/50 ms khi native chưa nhận ra request; giữ owner/group/generation, slot vật lý và chống hủy lặp. Bổ sung marker opt-in `render-cancel-submit` / `render-cancel-ack` để kiểm chứng runtime, không suy giảm tail từ test đồng bộ.

Hai test hồi quy group/owner đỏ trước sửa vì IPC chưa được gửi, xanh sau sửa; kiểm cả cleanup lặp và tab khác vẫn hoàn tất. 69 test/4 file đạt; TypeScript đạt; Vite source-map khớp file đang sửa. Log `cancel-red.log`, `cancel-green.log`, `cancel-typecheck.log` trong `.tmp/render-r25-07/`. Oracle lần đầu viết thiếu tham số options tùy chọn mà SDK chuyển vào spy; đã chuẩn hóa hai đối số cần kiểm, không thay tiêu chí gửi trước yield.

Verify cuối lô: **222 test/9 file đạt** (`.tmp/render-r25-07/regression.log`). Worker benchmark SHA-256 `65951795fa9ee0439d2d58edf9fb97b036487aa1923b3890f338013f2750415e` khớp `PERF_SESSION` role `host` trong log ứng dụng. Việc dùng target chung cho hai manifest giữ lại EXE probe tạm dù Cargo báo fresh; đã dọn riêng package `print_engine` của target profiler và rebuild nguồn gốc (không đụng target Tauri). Không lấy dòng “Finished” làm bằng chứng provenance.

Đã kiểm probe phục hồi có đúng 14 stage gốc, không in `SM_DETAIL`, cùng checksum RGB ở chính clip baseline 848 DPI `(5504,2240,1344,832)` và `ink.rs` nguồn không đổi; `restored-probe.json` lưu hash EXE mới. Hash binary rebuild không được giả định trùng binary cũ. Lần đối chiếu đầu nhầm clip khác `(5120,3392,1344,768)` nên checksum khác; đã kiểm lại đúng hợp đồng clip, không nới oracle.

Đã đề nghị người dùng zoom/đảo chiều lại để đo tail hủy. **Chưa tuyên bố cải thiện runtime của lệnh hủy hoặc tốc độ toàn bộ zoom** khi chưa có lượt đó. Kernel PPE vẫn cần tối ưu sâu hơn; không đổi màu/DPI để che độ trễ.

### Kết quả lượt người dùng xác nhận “xong” sau lô C

Snapshot `.tmp/render-r25-08/cancel-after.snapshot.log`, 37.572.066 byte, SHA-256 `8af5b08b3016e428c7c7bd9c3de2ea199a0a80ce104098c5fd5a4fdd73ac969c`, trace `Vmug5wffc-nqszpb`, đúng identity tài liệu trên, trang 1. Script `summarize_runtime.py` và `analyze_ipc.py` lưu bảng nối request cùng thư mục.

- 261 yêu cầu hủy, 315 lần invoke gồm retry. Cả 261 có thời gian từ đánh dấu stale đến submit trung vị 0 ms, tối đa 1 ms. 176 request nối được tới marker native hủy active worker: trung vị **3 ms**, p95 **66 ms**, tối đa **395 ms**. So với 146/423 ms của 203 request ở lượt trước, đường gửi hủy đã cải thiện, nhưng hai lượt không phải thao tác A/B có kiểm soát. Những yêu cầu chỉ bị hủy khi đang pending không có marker active-worker; không coi thiếu marker là thất bại.
- 234/261 request được ack true. Thời gian FE nhận ack trung vị 98 ms, tối đa 403,6 ms; ack trễ không đồng nghĩa worker vẫn chạy đến lúc FE nhận. Đoạn đuôi 395 ms xuất hiện **sau submit**, không còn nằm trước dynamic import. Chưa đủ mốc để phân biệt chờ dispatch, khóa/pipe và I/O logging trong đoạn này.
- 36 viewport ready: worker trung vị **345,5 ms**, tối đa **1.412 ms**; tổng FE trung vị **367,5 ms**, tối đa **1.425 ms**. Submit render vẫn 0–1 ms; submit → native entry có một đuôi 380 ms. Semaphore/spawn queue bằng 0 không phủ hết các đoạn này.
- 122 wheel, 17 đợt nếu tách ở khoảng nghỉ >250 ms. Có 12 đợt ghi được frame priority 0, CSS visible, mật độ ≥0,98 sau input cuối và trước đợt kế: **418–1.102 ms**, trung vị **634 ms**. Năm đợt còn lại không có mẫu thỏa điều kiện trong cửa sổ đó; không gán giá trị 0. Đây là mốc DOM/rAF được lấy mẫu, không đo scan-out/occlusion và không thay nghiệm thu cảm nhận của người dùng.

Timeline R25.04.2 vẫn tái hiện: đợt 1 biết queued cuối khoảng +78 ms nhưng tới **+764 ms** sau wheel cuối mới gửi target mới. Ảnh cũ xuất hiện +779 ms chỉ có ratio **0,277**; target đúng tỷ lệ tới +1.102 ms. Đợt 3: target cuối được biết khoảng +41 ms nhưng gửi +289 ms; frame cũ có ratio 1,37 nhưng bị ẩn vì thiếu coverage. Đây là chờ trong buffer trước khi gọi render, không nằm trong `queue_ms` coordinator.

## Lô D — R25.04.2: kết thúc gom target khi viewport đã ổn định

`TileLayer` vẫn cho target B chạy trong lúc zoom/pan thay đổi. Nếu queued C và hình học sống ổn định **200 ms** (cùng khoảng idle hiện có của wheel), chuyển C thành target và hủy B qua cleanup/group hiện có. Giữ bitmap visible, màu, clip và DPI theo hợp đồng cũ. Không thêm worker/cache/cap, không dự đoán zoom.

Reducer kiểm key queued để timer cũ không phục hồi target sai. Target vừa được ưu tiên phải hoàn tất trước một lần ưu tiên idle nữa (`finishBeforeIdle`); tránh vòng hủy không có ảnh mới khi render chậm 1 giây và wheel cách nhau 500 ms. Callback ready/failed của B muộn bị bỏ; đổi file/page/profile/rotation vẫn bỏ state cũ như trước.

Bằng chứng:

- Test target cuối đỏ trước sửa: chỉ phát zoom `[3,4]`, target cuối 5 vẫn chờ B. Sau sửa phát `[3,4,5]`, giữ ảnh A đến C, kết quả B trả muộn không ghi đè C. `queue-red.log`, `queue-green.log`.
- Kiểm tiến triển có mô phỏng hủy vật lý: latency 300/430 ms, wheel mỗi 20 ms; latency 1.000 ms, wheel mỗi 500 ms. Mỗi ca đều có ít nhất ba ảnh cập nhật trong 6 giây và tới target cuối. Reducer kiểm timer lỗi thời, callback muộn, identity đổi và bảo vệ target vừa ưu tiên. `queue-progress.log`.
- Fixture Edge với TileLayer thật, ảnh/latency tổng hợp: ở latency 430 ms, đuôi cuối 778,5 → 661,7 ms; ở 1.000 ms, 1.900,3 → 1.233,3 ms. Ảnh cuối trước/sau cùng SHA-256, không có lỗi trang. Đây là kiểm lifecycle/compositor **không phải benchmark PrynX/PPE**. `.tmp/render-r25-08/browser-queue/report.json` và PNG cùng thư mục.
- `bench_queue.py` gọi chính EXE worker hiện hành, đúng PDF/clip, logging tắt; ABBA cho ba cặp target của đợt 1/3/14. Đợt 3 kích hoạt hủy cả hai lần, B trả cancelled, ảnh C vẫn cùng SHA-256; trung vị từ lúc C được biết tới PNG C **546,4 → 522,1 ms**. Lợi ích nhỏ trên worker riêng. Hai ca còn lại B xong trước deadline nên không hủy; kết quả dao động, không coi là tăng tốc. Worker riêng không tái hiện đuôi 1,4 giây của ứng dụng, không có Tauri manager/IPC/UI và tải atlas. `worker-queue-ab.json` giữ toàn bộ số liệu, kể cả kết quả không cải thiện.
- TypeScript đạt; **227 test/9 file đạt**, không cập nhật snapshot. `regression.log` (203 test/8 file) và `render-policy.log` (24 test). Cảnh báo jsdom canvas của test fallback có sẵn vẫn xuất hiện. Vite source-map hai file triển khai khớp nguồn (`vite-source.json`). Không thay Rust/EXE hoặc khởi động lại app.
- Lint phạm vi bốn file chưa xanh: `LivePageFrame.tsx` có 25 lỗi/6 cảnh báo từ baseline, ba file còn lại sạch. Đã lint nội dung snapshot trước sửa bằng `--stdin-filename` cùng cấu hình rồi đối chiếu rule/message sau chuẩn hóa số dòng: không thêm/bớt finding. `lint-before.json`, `lint-after.json`; không sửa các lỗi ngoài lô này.

**Chưa nghiệm thu lô D trên thao tác người dùng.** Bản sửa nhắm phần chờ giữa hai target; raster PPE vẫn khoảng 300–400 ms khi warm và chưa đạt độ nét liên tục ngang Acrobat. Cần đo marker `viewport-queued-promote`, thời gian đến frame target cuối, tiến triển trong zoom và kiểm hình ảnh ở lượt tiếp. Đuôi native/IPC dưới tải cùng chi phí soft-mask/image còn là vấn đề mở; không gộp thành kết luận “đã sửa nhanh”.

### Kết quả runtime sau lô D — lượt “xong” lúc 06:50

Snapshot `.tmp/render-r25-09/queue-after.snapshot.log`, 42.116.480 byte, SHA-256 `876d1642cd4992a71541adbd8f5fb125df65cea9f20a4ec806e577b791724c28`, trace `Vmug6o0ka-ohmckk`. Runtime vẫn mở đúng file Desktop, trang 1, identity đã xác nhận ở trên. Marker source đầu dùng identity tạm; marker thứ hai và các viewport đã dùng identity đầy đủ, không coi identity tạm là file PDF khác.

- 11 lần `viewport-queued-promote`; target mới được gửi sau **1–4 ms**, cả 11 có kết quả ready. Việc chuyển queued đã chạy thực. Không suy rằng cả 11 đem lại ảnh nét đúng lúc: một số đã bị người dùng zoom tiếp trước khi ready.
- 23 viewport ready, 11 bị hủy. Worker trung vị **350 ms**, tối đa **777 ms**; tổng FE trung vị **364 ms**, tối đa **962 ms**. Thời gian trước invoke vẫn 0–1 ms.
- 17 đợt wheel; 15 đợt có frame được lấy mẫu thỏa visible/ratio ≥0,98 sau input cuối: **386–1.238 ms**, trung vị **615 ms**. Lượt trước 634 ms nhưng thao tác khác (lượt này zoom tới khoảng 61×); **không có cơ sở kết luận tăng tốc tổng thể rõ rệt**. Chỉ hai đợt có mẫu frame priority 0 trong khi wheel còn chạy: một ảnh visible ratio 0,372 và một ảnh bị ẩn. Chưa đạt mục tiêu nét liên tục.
- 446 request hủy, 451 invoke kể cả retry; 444 được ack true. 332 request nối được marker hủy active worker: trung vị **5 ms**, p95 **456 ms**, tối đa **794 ms**. Bản sửa import vẫn gửi ngay, nhưng đuôi sau submit chưa hết.
- Request `20b6b8c8…`: submit `1790293807951`; entry suy từ `IPC_PPE` khoảng `1790293808461` (**510 ms** sau submit); command 440 ms, worker 439 ms; FE tổng 962 ms. `PPE_NATIVE_RESULT` và `IPC_PPE` cùng timestamp cuối `1790293808901`, nên đoạn giữa hai marker cuối không giải thích được khoảng 510 ms đó. Hai request khác có khoảng tương tự **365/336 ms**. Vẫn cần timestamp capture entry trực tiếp để không lệ thuộc prefix ghi file.

Artifact phân tích: `runtime-summary.json`, `queue-after-summary.json`, `promotion-rows.json`, `promotions.log`. Cơ chế lô D hoạt động nhưng **chưa nghiệm thu hiệu quả người dùng**; không chỉnh tiếp ngưỡng 200 ms để che nút thắt native.

## Lô E — tách I/O hủy khỏi callback IPC

Nguồn thực `cancel_pdf_render` là command đồng bộ, gọi thẳng `cancel_render_request`: lấy khóa registry, ghi pipe control và ghi perf log. Dependency đang cài xác nhận chuỗi gọi: Wry 0.55.1 `WebResourceRequested` → Tauri 2.11.2 `webview.on_message` → macro 2.6.2 `body_blocking`, thực thi handler ngay trong callback. Đây là đường có thể giữ luồng nhận IPC khi khóa/I/O chậm. Log hiện tại chưa đo riêng thời gian chờ từng khóa, pipe và ghi log; **không quy toàn bộ 510 ms cho một khóa cụ thể**.

Bản vá cụ thể tại `.tmp/render-r25-09/native-cancel.patch`, hai file nguồn/test, chuẩn bị trong `.tmp/render-r25-09/native-stage/desktop/src-tauri/`:

1. `cancel_pdf_render` thành async, chuyển toàn bộ phần hủy sang `spawn_blocking`; giữ request ID, registry và chính sách hủy cũ. Không tăng/cap worker hoặc thay pipeline màu.
2. Marker opt-in `IPC_CANCEL` ghi epoch lúc vào command, thời gian chờ luồng nền và thời gian thực hiện hủy. `IPC_PPE` có epoch capture entry trực tiếp. `PPE_NATIVE_RESULT` bổ sung render/encode/cache từ timing có sẵn; giá trị thiếu ghi `unknown`, không biến thành 0.
3. Test giữ khóa active registry bằng thread có barrier: phiên chỉ bọc async nhưng vẫn gọi hủy đồng bộ bên trong poll bị đỏ; phiên `spawn_blocking` trả `Pending` cho caller ngay, caller nhả khóa và request đích được hủy, request khác còn nguyên. Test không lấy timeout làm tiêu chuẩn tốc độ; timeout chỉ cứu phiên đỏ khỏi deadlock.

Verify bản staging: test hồi quy đỏ rồi xanh (`native-red.log`, `native-green.log`); **63 test render-worker đạt, 9 probe runtime có sẵn bị ignored** (`native-worker-regression.log`). Nhóm cancel đạt 6, ignored 1; có giao nhau với 63 nên không cộng thành 69. Hai cảnh báo dead-code có sẵn. Khi bổ sung log đã gặp lỗi kiểu timing `Option<u64>` và sửa thành chuỗi `unknown` khi thiếu trước lần test xanh; không thay giá trị đo để lấp thiếu dữ liệu.

Lần compile đầu dùng target của app bị file PDFium đang mở chặn sao chép resource. Đã chuyển sang `target-agent` riêng cho test, không dừng app và không thay EXE đang chạy. Hash EXE vẫn `65951795fa9ee0439d2d58edf9fb97b036487aa1923b3890f338013f2750415e`. Hai source production được đối chiếu byte còn nguyên so với snapshot trước staging; `native-patch-provenance.json` lưu hash.

### Áp dụng và mở lại sau xác nhận người dùng, 07:10 ngày 25/09

Người dùng xác nhận “Tôi đã lưu và đóng PrynX”. `git apply --check` không nhận hunk trong file worker; chưa áp dụng phần nào. Đối chiếu SHA-256 xác nhận cả hai file nguồn vẫn giống từng byte với snapshot trước staging. Sau đó chép đúng hai file staging với kiểm tra hash trước và sau ghi; không chép Cargo/config staging. `applied-source-provenance.json` xác nhận nguồn thật trùng bản đã kiểm thử, giữ các thay đổi khác có sẵn.

- Test lại từ crate gốc: `cargo test --offline --lib pdf_engine::render_worker::tests -- --test-threads=1` đạt **53 test, 9 ignored**, hai cảnh báo dead-code có sẵn. Bộ lọc này hẹp hơn nhóm staging 63 test vì không gồm work-queue/response-router. Test giữ khóa registry và kiểm hủy đúng request đạt. Log `native-root-regression.log`.
- `cargo build --offline` từ `desktop/src-tauri` sau khi áp dụng đạt, 17 cảnh báo có sẵn, 1 phút 06 giây. Log `native-root-build.log`. Lượt build trước khi áp dụng không dùng để triển khai bản sửa.
- EXE mới SHA-256 **`4e7aa5e34ca221064df4b6b2291b370cf8e3df877b559168d4bf9e05aa5c1fcc`**. PrynX PID 4616, `PERF_SESSION role=host` epoch `1790295035189` ghi đúng hash này. `native-runtime-provenance.json` nối hash file với phiên runtime, không dựa riêng vào dòng build thành công.
- Vite/backend trước đó đã tắt. Lần khởi động trong sandbox gặp Vite `spawn EPERM`; đã dừng đúng hai PID backend do lần thử tạo sau khi kiểm path/thời điểm khởi động. Chạy lại launcher với quyền được chấp thuận, hai dịch vụ trả HTTP 200 rồi mở PrynX với file PDF runtime đã xác nhận. Token dev mới chỉ nằm trong môi trường, không lưu vào artifact.
- Trace mới **`Vmug7fvg7-vcd6cy`** ghi đúng file Desktop và identity đầy đủ. Render trang 1 đã trả PNG và ghi marker mới: `IPC_PPE entry_epoch_ms`, `PPE_NATIVE_RESULT render_ms/encode_ms/cache_ms`. Ví dụ request `3ae00287…`: command 397 ms, worker 395 ms, render 374 ms, encode 18 ms. Đây là lúc mở trang, **không dùng làm phép đo cải thiện zoom**. Chưa có `IPC_CANCEL` ở thời điểm kiểm tra đầu vì người dùng chưa thực hiện lượt zoom mới.

**Đã triển khai bản dev; chưa nghiệm thu hiệu quả runtime lô E.** Đã yêu cầu zoom/đảo chiều/pan trang 1 khoảng 10–15 giây. Log vẫn ở `.tmp/render-diagnostics/PrynX_RenderPerf.log`; lượt tiếp sẽ tách submit → entry capture, queue/cancel và render/encode. Chưa có bằng chứng đạt tốc độ hay độ nét liên tục ngang Acrobat.

### Kết quả sau người dùng chạy lại run_dev — log đến 07:47:44

Snapshot `.tmp/render-r25-09/native-after.snapshot.log`, 45.809.749 byte, SHA-256 `f0563577890b9dd0d5f2c850b07c84910bcc7a4daef25ab9be6f54a45ccc4817`. Trace **`Vmug8p305-zncw82`**, 88 input wheel/10 đợt, đúng file Desktop, identity đầy đủ và trang 1. Host PID 36416 khởi động epoch `1790297142851`; hash EXE runtime **`469a2725ee299477cb165b513f35c8aa4332277c5e8300a16d8a4c8113f26fe0`** khớp EXE trên đĩa sau run_dev. Cả hai file Rust vẫn trùng SHA bản staging đã triển khai; binary rebuild khác hash không có nghĩa mất patch. Marker entry và cancel mới xuất hiện thực tế.

| Đại lượng | Lượt trước lô E | Lượt sau lô E |
|---|---:|---:|
| Viewport ready được nối đủ mốc | 23 | 20 |
| Gửi render → vào native, trung vị / lớn nhất | 2 / 510 ms (entry suy từ log) | **1 / 2 ms (entry capture)** |
| Worker tổng, trung vị / lớn nhất | 350 / 777 ms | **351,5 / 511 ms** |
| Tổng request ở FE, trung vị / lớn nhất | 364 / 962 ms | 395,5 / 684 ms |
| Wheel cuối → frame đủ mật độ được lấy mẫu, trung vị / lớn nhất | 615 / 1.238 ms (15 đợt có mẫu) | **574 / 911 ms (10 đợt có mẫu)** |

Hai lượt thao tác khác nhau; bảng không phải A/B kiểm soát và không chứng minh tỷ lệ tăng tốc toàn bộ. Tuy vậy, 20 request sau sửa đều vào native trong 0–2 ms, không thấy đuôi dispatch hàng trăm ms ở mẫu mới. **Bản sửa có bằng chứng cải thiện đường dispatch; lõi render chưa nhanh hơn về trung vị.**

- 20 viewport ready: render trong worker **269–478 ms, trung vị 330 ms**; encode **16–28 ms, trung vị 20 ms**; cache 0–2 ms. Semaphore và spawn queue ghi 0 ms ở cả 20. Không lấy queue 0 làm bằng chứng toàn bộ native hết chờ: request `d45bb459…` command 613 ms nhưng worker 328 ms, còn khoảng 285 ms ngoài timing worker. Nó trùng cửa sổ hủy `ff868bca…` mất 283 ms; chưa có mốc đủ nhỏ để quy chắc cho một khóa/pipe cụ thể.
- 179 request hủy, 199 invoke gồm retry, đủ 199 marker `IPC_CANCEL`. 169 ID không retry ghép chính xác submit → entry: **trung vị 1 ms, p95 4 ms, tối đa 9 ms**. 10 ID có retry không có attempt ID xuyên tầng nên không đoán thứ tự ghép. Blocking queue 0 ms; thân hủy trung vị 0 ms, p95 24 ms, tối đa 283 ms. 169 request có ack true; false còn lại không tự coi là thất bại vì có thể request đã hoàn tất/rời registry.
- 31 long task UI trong cửa sổ từ wheel đầu đến frame cuối, khoảng **51–107 ms** (thêm một long task 98 ms lúc mở file). Request `c7ddd147…` nhận byte lúc `1790297263627`, ready lúc `1790297263821`: **194 ms** sau nhận. Ba long task 52/69/61 ms nằm trong cửa sổ đó. `source_ms` bao cả việc chờ Promise tạo bitmap tiếp tục trên UI; không kết luận 194 ms là thời gian CPU giải mã PNG thuần.
- Chỉ đợt 1 và 4 có mẫu viewport frame trong khi wheel còn chạy; mẫu visible ở đợt 1 ratio 0,411, các mẫu còn lại bị ẩn. Không có mẫu vừa visible vừa ratio ≥0,98 trong lúc wheel ở lượt này. Sau dừng, 10 đợt có mẫu đạt điều kiện sau **393–911 ms**. DOM/rAF chỉ là cơ hội hiển thị, không phải phép đo scan-out; **chưa đạt nét liên tục**.
- Phát hiện cần giữ lại khi đánh giá telemetry: retry hủy `edd50fd7…` capture entry `1790297246870`, queue/cancel đều 0 ms nhưng prefix log tận `1790297247842` (**972 ms sau**). Code capture `cancel_ms` trước `perf_log` rồi mở/ghi file đồng bộ. Đây là khoảng ngoài thân hủy tại đường format/log/lập lịch luồng, chưa đủ để chỉ đích danh ổ đĩa/antivirus. Một ack khác cũng trễ gần 984 ms dù native đã ghi sớm; vì vậy không quy mọi ack trễ cho worker hoặc UI riêng lẻ. Chưa được coi hệ thống đo là không có ảnh hưởng.

Artifact: `native-after-summary.json`, `native-after-runtime-summary.json`, `native-after-native-cancel-summary.json`, các bảng `*-rows.json`, `native-after-outlier.log`. Parser dùng entry capture khi có và giữ nhãn `inferred` cho log cũ.

**Hướng xử lý tiếp theo theo bằng chứng:** giữ bản tách hủy đã có tác dụng ở dispatch; xử lý thời gian raster PPE khoảng 330 ms cùng công việc UI cản nhận/đưa bitmap lên frame. Trước khi diễn giải đuôi bất thường, kiểm đường ghi log đồng bộ bằng phép đo riêng và đối chứng bật/tắt log trong worker riêng; không đổi ngưỡng debounce, giảm DPI hay chuyển qua lại PDFium để che lỗi. Tối ưu raster phải có đối chứng PNG/màu trên đúng file và clip đã đo; dữ liệu profiler lô C là đầu vào, chưa phải bản sửa đạt yêu cầu.

## Giải pháp tiếp theo: giảm raster và giữ pixel hữu ích trong khi zoom

**Cập nhật theo yêu cầu giải pháp dài hạn:** định hướng kiến trúc và trình tự milestone mới nằm trong [Quyết định kiến trúc PPE Viewer dài hạn](QUYET_DINH_KIEN_TRUC_PPE_VIEWER_DAI_HAN_2026-09-25.md). Phần F–H dưới đây giữ lại làm phân tích kỹ thuật; không dùng làm chuỗi vá thử trên Viewer của người dùng.

Đây là kế hoạch triển khai, chưa phải kết quả tăng tốc. Các bản sửa A–E chưa đạt mục tiêu trải nghiệm. Cần xử lý cả chi phí tạo ảnh và cách trình bày ảnh; chỉ giảm IPC hoặc encode không giải quyết 330 ms dựng ảnh PPE.

### Lô F — phép đo ít cản trở và tối ưu kernel PPE đã xác định

Trước hết đưa ghi log đĩa khỏi đường trả kết quả: capture timestamp tại sự kiện, xếp bản ghi vào writer riêng theo process, gom ghi theo lô; có đếm mất bản ghi và flush khi đóng bình thường. Thiết kế hàng đợi phải xét RAM/áp lực bộ nhớ, tránh cả chặn render lẫn tăng bộ nhớ vô hạn. Benchmark với logger tắt/bật, sink bị chậm có chủ đích, không dùng mất log làm cách tăng tốc.

Ưu tiên tối ưu `content/interp.rs::build_soft_mask`, `draw_image` và các vòng raster được profiler chỉ ra. PPE **đã có** clip cục bộ/BBox và cache ảnh, FormProgram, PageProgram; không triển khai lại chúng để gọi là tối ưu mới. `PageProgram` giữ operator đã tokenize, không phải ảnh raster đã dựng. Profile warm đã cho thấy chi phí mặt nạ/ảnh lớn; các span inclusive không được cộng chồng.

Thử từng ứng viên độc lập trên clip 104/848/2072 DPI: giảm quét lại coverage, phép biến đổi tọa độ lặp trong vòng pixel, và buffer trung gian nếu cùng semantics. Chỉ thêm reuse mask khi chứng minh có lặp với đầy đủ identity, CTM, clip, trạng thái màu/alpha; không cache chỉ theo ObjectId hoặc phóng mask độ phân giải thấp qua các mức zoom. Ứng viên composite Normal/CMYK trước đó không đạt và đã loại, không phát lại nguyên xi.

Chốt mỗi ứng viên: ABBA trên đúng PDF/clip/profile, warm và cold tách riêng, kiểm pixel/màu/alpha/geometry; kiểm đường transparency lồng và hủy. Nếu tối ưu CPU không giảm đủ raster, kết luận mức đạt thực và chuyển sang prototype lớn hơn; không hứa trước số ms.

### Lô G — compositor giữ phần ảnh nét và cache tile nhiều mức

Mở rộng cơ chế tile hiện có thành tập surface theo tọa độ trang, có vùng phủ và mức mật độ rõ ràng. `viewportTilePresentationItems` hiện có nhánh trả `[]` khi ảnh cũ không phủ kín viewport; đây là vị trí cần thay bằng trình bày phần giao hữu ích và lấp phần thiếu bằng underlay cùng pipeline. Không chỉ xóa nhánh ẩn: nếu không quản lý clip/biên/alpha, sẽ lặp lỗi khung trắng và đảo nét.

- Zoom/pan dùng transform để trình bày ngay những pixel đã có; chọn tile phù hợp từ các mức đã cache. Zoom-in vượt mức pixel có sẵn vẫn có thể mờ cho tới ảnh mới, nên reuse không thay thế tối ưu raster.
- Tile mới của đúng vùng nhìn được đưa lên khi sẵn sàng trong lúc wheel, không buộc đợi đủ một ảnh viewport mới hoặc đợi wheel dừng. Giữ tiến triển, không hủy rồi tạo lại toàn bộ mỗi wheel.
- Ưu tiên vùng đang nhìn/tâm zoom, render phần thiếu; ảnh cũ và mới đều dùng cùng hợp đồng PPE/ICC. Prefetch mức kế cận chỉ khi có khả năng tái dùng và không cản công việc vùng nhìn; kiểm chi phí thực trên máy mạnh, không đặt cap chất lượng vô điều kiện.
- Clip/gutter và ánh xạ pixel phải thống nhất ở zoom phân số/DPR; chuyển tile không để hở nền và không thay pipeline màu. Không chuyển PDFium ↔ PPE theo động tác zoom.

Đầu tiên dựng prototype ngoài viewer đang dùng, tái hiện bằng bitmap PPE thật và trace thực; so ảnh ở zoom-in/out, pan, đảo chiều, rotation, đổi file/profile. Chỉ tích hợp sau khi loại được đường viền trắng, sai vùng và ảnh generation cũ. Đây là thay đổi kiến trúc trình bày, không được gọi một patch timer khác là hoàn thành lô này.

### Lô H — giữ đường input và commit ảnh ngắn

Long task 51–107 ms chưa có call-stack nên không quy hết cho React. Dùng replay/profiler để xác định phần reconciliation, layout, atlas và telemetry. Giữ cập nhật transform theo frame ngắn; tách tính plan/mount atlas khỏi công việc bắt buộc của từng wheel; commit ảnh sẵn sàng không phải chờ công việc nền. Chỉ chuyển decode/chuẩn bị bitmap sang worker nếu phép đo cho thấy giảm thời gian tới frame; `createImageBitmap` đã async, nên đổi sang worker không tự giải quyết mọi long task. PNG encode trung vị 20 ms là ưu tiên sau raster, không phải lời giải cho 330 ms PPE.

### Chốt nghiệm thu và hướng dài hạn

Mục tiêu ban đầu để kiểm chứng trên PDF này: render viewport warm tiến tới ≤100–150 ms; nhận bitmap → commit không có đuôi chờ hàng trăm ms; có ảnh đủ mật độ cập nhật trong chuỗi zoom; sau dừng tiến tới ≤200 ms. Đây là **mục tiêu thiết kế**, chưa phải dự báo hay cam kết. Báo cả trung vị/p95, vùng còn mờ và frame bị bỏ, không chỉ thời gian render một request.

Đo bằng thao tác cố định, tách logger on/off, so ảnh ROI chữ/gradient/biên tile trên đúng trang và profile. Log DOM/rAF phải đi cùng kiểm hình ảnh thực; chỉ khi có đối chứng cùng thao tác mới kết luận mức tương đương Acrobat.

Nếu CPU PPE vẫn không đạt sau ứng viên có chứng cứ, bước dài hạn là prototype scene đã phân giải trạng thái + raster/composite tăng tốc (có thể GPU), giữ đường chuẩn PPE để so kết quả. Scene cache đơn thuần không loại chi phí raster mask/ảnh; GPU cũng cần kiểm đúng blend, clip, font, CMYK/spot và quản lý bộ nhớ. Chỉ chọn thay kiến trúc khi prototype chứng minh cả tốc độ lẫn ảnh, không hứa đổi GPU là đủ.
