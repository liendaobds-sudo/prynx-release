# Chẩn đoán mở file và zoom — 2026-09-25

Người dùng yêu cầu thêm log đầy đủ để tự thao tác mở file/zoom, agent đọc log tìm nguyên nhân. Phạm vi được duyệt: bổ sung phép đo, không đổi chính sách render trong lô này.

## Bằng chứng và phần còn thiếu

- Worker PPE hiện khoảng 300–400 ms/vùng; số đo độc lập chưa là input-to-visible của WebView.
- `viewerTraceLog` trước đây đóng timestamp lúc ghi sau chuỗi Promise, có thể lệch vài giây; mỗi dòng một IPC. `compactTracePayload` bỏ object `clip`, mất hình học request.
- `tile-commit` là vẽ canvas/đổi state, không chứng minh màn hình đã trình bày. Cần request ID tại surface và phép đo ở cơ hội vẽ frame sau commit, kèm tỷ lệ pixel bitmap/CSS/DPR và visibility.

## Lô thực hiện

1. Sửa thời điểm capture; batch log giữ từng event; giữ clip và báo lỗi vận chuyển; file chung FE/host/worker trong `.tmp/render-diagnostics/PrynX_RenderPerf.log`; session metadata và long task. Verify test logger/typecheck và test writer native.
2. Nối request ID với canvas; ghi wheel/zoom đích/layout và frame opportunity. Verify test coordinator/zoom/tile và kiểm log thật sau build.

Mỗi lô tối đa năm file nguồn/test/tài liệu. Không thêm cap chất lượng/tài nguyên render. Dữ liệu chỉ ghi cục bộ; không ghi token xác thực hoặc nội dung chữ PDF. Không gọi rAF hay DOM visibility là bằng chứng pixel đã lên màn hình; log ghi rõ mức đo này.

## Cách đọc kết quả

Theo request ID: input/zoom target → enqueue → native queue/wait/render/encode → source/decode → commit → frame opportunity. Tách cold/warm, viewport/atlas, ready/cancelled/stale và DPI đích/DPI hiện tại. Số đo thiếu stage phải đánh dấu thiếu, không tự điền 0. Log là bằng chứng thời gian/hình học, không tự chứng minh chất lượng thị giác hoặc tương đương Acrobat.

## Đã triển khai và kiểm chứng

- File chung: `D:\pdfcompare\.tmp\render-diagnostics\PrynX_RenderPerf.log`. Host/worker có `PERF_SESSION` chứa PID, version, CPU, RAM; host ghi SHA-256 executable. Native giữ timing render/encode/cache/queue của từng request như trước.
- FE ghi `event_epoch_ms`/`elapsed_ms` tại lời gọi, cùng `trace_id`/`seq`; thời gian prefix bên ngoài là lúc ghi. Packet IPC gom 25 ms/tối đa khoảng 64 KiB, không sampling sự kiện; lỗi ghi được đếm và báo `TRACE_TRANSPORT` ở gói ghi thành công kế tiếp. Đóng app đột ngột vẫn có thể mất gói cuối. Trường `clip` object được giữ lại.
- `zoom-input`/`zoom-dispatch`/`zoom-layout`/`zoom-idle`/`viewport-pan` và `ui-long-task` xác định đầu vào, React/layout và UI bị chặn. `latest_zoom_input_seq` là bối cảnh đầu vào gần nhất, không tự chứng minh quan hệ nhân quả của job nền.
- `tile-url-resolved`, `tile-dom-canvas-ready`, `tile-commit`, `tile-frame-opportunity` có cùng request ID khi source còn metadata coordinator. Cache source thiếu metadata vẫn có hash `source_id` để đối chiếu lần dùng trước, không bịa ID mới. Frame opportunity đo bitmap/CSS/DPR, opacity/clip tổ tiên và độ trễ sau commit; không xác nhận occlusion hay scan-out. Probe đo chính chi phí của nó qua `probe_ms`.
- Typecheck đạt; 157 test/6 file frontend đạt; test formatter native đạt. Không đổi golden hoặc chính sách render. Cảnh báo jsdom canvas hiện hữu ở decoder fallback không làm test thất bại.
- Edge headless riêng dùng component LiveTile thật và PNG native của PDF: request ID đi xuyên source → commit → frame opportunity, bitmap/CSS ratio 1, CSS visible=true, probe đo khoảng 0,1 ms trong fixture. Artifact `.tmp/render-r25-03/browser-log/report.json`; không gọi đây là kiểm chứng WebView PrynX.
- Bản native mới tự mở lại lúc 01:02:31, SHA `628356274829327a4e417ba1ac58918107324d13e13fa13add14b4f060560d6c`; đã đọc được session host/worker trong file đích. Vite phục vụ source logger/zoom/LiveTile khớp trên đĩa. Chờ thao tác mở file/zoom của người dùng để phân tích trải nghiệm thật.
- Đọc log thực tế lúc 01:08: đã có 94 `zoom-input`, 91 `zoom-dispatch`, 96 `zoom-layout`, 177 commit và 187 frame opportunity; 175 frame có request ID trực tiếp, phần còn lại cần nối cache qua source ID. Không có JSON lỗi. Probe DOM trung vị 0,2 ms, tối đa 1,8 ms trong lượt này. Có 56 long task để điều tra; chưa kết luận nguyên nhân/hiệu quả từ số lượng đơn thuần. Người dùng đang thực hiện thao tác, chờ kết thúc để phân tích cùng timeline.

## Đã phân tích sau khi người dùng báo “xong”

Bản chụp cuối có 18.424 dòng / 8.329.167 byte, không JSON lỗi hoặc seq bị thiếu. Kết quả và kế hoạch sửa nằm trong [báo cáo thao tác thật](BAO_CAO_AUDIT_ZOOM_THUC_TE_2026-09-25.md). Đã xác định atlas zoom cũ được phát lại rồi hủy sau khoảng 6 ms; target cuối chờ job cũ; worker viewport đoạn cuối trung vị 335 ms. Sáu đợt zoom cuối cần 490–889 ms sau wheel cuối để có frame đủ mật độ theo phép đo DOM/rAF.

Số long task sơ bộ bên trên là số bản ghi, không phải số tác vụ khác nhau: toàn log có 94 bản ghi / 61 tác vụ sau loại trùng do hai observer; riêng đoạn cuối có 38 bản ghi / 19 tác vụ. Timing worker nội bộ và transport vẫn còn khoảng trống, được ghi rõ trong báo cáo. Lượt phân tích không thay đổi rendering hoặc tuyên bố đã đạt trải nghiệm mong muốn.
