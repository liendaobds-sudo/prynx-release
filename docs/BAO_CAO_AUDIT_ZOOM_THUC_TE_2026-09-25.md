# Chẩn đoán zoom từ thao tác thật — 2026-09-25

## Kết luận

Lượt thao tác xác nhận phản ánh “mờ lâu, chủ yếu nét sau khi dừng”. Có một lỗi điều phối atlas xác định được bằng cả code lẫn log; một chính sách giữ request cũ gây chậm target cuối; và chi phí worker còn quá lớn để đuổi kịp chuỗi wheel này. Chưa có căn cứ nói kiến trúc đã đạt trần công nghệ.

**Ưu tiên sửa: chặn phát lại atlas thuộc zoom cũ → xử lý độ trễ target cuối có kiểm soát → profile và giảm chi phí PPE.** Tăng DPI, tăng worker hoặc chỉnh timer đơn lẻ không giải quyết đủ ba vấn đề.

Lượt này phân tích và lưu bằng chứng; chưa thay đổi pipeline render. Log chưa chứng minh parity thị giác với Acrobat, cũng chưa tách hết chi phí nội bộ PPE/IPC. Không dùng kết quả test mock trước đây làm bằng chứng trải nghiệm đã đạt.

## Nguồn và độ tin cậy

- Log gốc: `D:\pdfcompare\.tmp\render-diagnostics\PrynX_RenderPerf.log`.
- Bản chụp cố định: [PrynX_RenderPerf.snapshot.log](D:/pdfcompare/.tmp/render-r25-04/PrynX_RenderPerf.snapshot.log), 8.329.167 byte, 18.424 dòng; SHA-256 `9c5165651dbb44b7e8c83f9a5f57e7ebf88c4360fa263cee0515b17e37722d8f`.
- Host SHA-256 trong log: `628356274829327a4e417ba1ac58918107324d13e13fa13add14b4f060560d6c`; 16 logical CPU, RAM cài đặt 32 GiB, DPR 1.
- Trang 1, pipeline `ppe-fogra39-relative-view-knockout-png-v5-native-worker`; token tài liệu `17869243:1786097761398351100:1786097761204255100`. Đây là working copy 17.869.243 byte đang mở, không đồng nhất byte với PDF gốc 18.059.736 byte của benchmark trước.
- Hai trace ID, số thứ tự 1–6342 và 1–9126 liên tục, không trùng seq, không JSON lỗi, không có `TRACE_TRANSPORT` báo mất sự kiện. Đây là kiểm tra phần đã ghi, không chứng minh app crash sẽ không mất batch cuối.
- Có tái khởi tạo module/viewer trong lượt ghi. Hai observer ghi trùng một số long task; đã deduplicate bằng `(start_epoch_ms, duration_ms)`: 94 bản ghi tương ứng **61 long task khác nhau**.
- Kết luận chính dùng đoạn cuối **01:09:35.918–01:09:48.634 (UTC+7)**, owner kết thúc bằng `d68a3bd7-7f6d-4281-8efa-0a54896bd34b:document-2`, instance `p5`, sau lần tái khởi tạo cuối hơn một phút. 44 wheel input, 6 đợt zoom, 17 request viewport hoàn tất.
- Thời điểm frontend lấy từ `event_epoch_ms`, không lấy prefix lúc flush. Timestamp native dùng cho đối chiếu có sai số do ghi log/lập lịch; các khoảng suy ngược từ `command_ms` ghi rõ là ước tính.
- `tile-frame-opportunity` là DOM/rAF: có bitmap, kích thước CSS, opacity/clip và mật độ pixel. Không phải xác nhận pixel đã scan-out; `css_visible` cũng không đo bị layer khác che. Không dùng log này để tuyên bố đã hết khung trắng.

## Số đo chính của đoạn cuối

| Phép đo | Trung vị | Khoảng / ghi chú |
|---|---:|---|
| Worker total của viewport | 335 ms | 301–432 ms; gồm các bước trong worker, không riêng raster |
| Coordinator đến source/decode ready | 396 ms | 310–974 ms; 17 request |
| Source PNG → Blob/ImageBitmap | 5 ms | 4–8 ms |
| Commit → cơ hội frame đo được | 22,3 ms | 18,1–31,6 ms |
| Wheel event → handler | 41,1 ms | tối đa 118,5 ms |
| Long task UI khác nhau | 19 lần | 53–97 ms, tổng thời lượng 1.289 ms |
| Atlas ready / cancelled / stale | 79 / 433 / 28 | 540 request kết thúc; 85,4% bị hủy/lỗi thời |

`decode_ms=0` không có nghĩa PNG không tốn decode: `createTileSourceFromBytes()` gọi `createImageBitmap(blob)` trong stage `source_ms`, trước callback decode của component. Không chọn thay PNG bằng raw buffer làm ưu tiên chính từ số đo này; encode native chưa được tách trong file log.

Đo từ **handler wheel cuối** đến frame viewport đầu tiên sau đó có `css_visible=true`, mật độ tối thiểu 0,98 và trước đợt wheel kế tiếp:

| Đợt | Zoom đầu → cuối theo input | Đợi sau wheel cuối | Dòng frame |
|---|---|---:|---:|
| 13 | 0,916 → 10,098 | 555 ms | 11523 |
| 14 | 10,098 → 30,337 | 734 ms | 12466 |
| 15 | 30,337 → 15,065 | 811 ms | 13473 |
| 16 | 15,065 → 7,481 | 835 ms | 14647 |
| 17 | 7,481 → 4,538 | 889 ms | 16403 |
| 18 | 4,538 → 13,631 | 490 ms | 17433 |

Sáu frame trên đo vùng thấy 1292 × 733 CSS pixel. Đây là mốc đủ mật độ/coverage DOM, không phải đo độ nét font bằng ảnh màn hình. Trong khoảng từ wheel đầu đến wheel cuối của sáu đợt, chỉ một frame viewport mới được probe: mật độ **0,185**, tức bitmap bị phóng khoảng **5,4 lần** mỗi chiều. Không có frame mới đủ mật độ được probe trong các khoảng này; ảnh có sẵn vẫn có thể tiếp tục hiện.

## Phát hiện

### R25.04.1 — P1 / M: atlas zoom cũ được bật lại rồi hủy ngay

**Bằng chứng runtime:**

| Thời điểm | Sự kiện |
|---|---|
| 01:09:37.709 | `viewport-layer-state` dòng 11671: 48 cell trong plan, 0 active, viewport cũ vẫn là visible/target |
| 01:09:37.718 | dòng 11867: bật lại **48 cell**, `outer_enabled=true`; visible/target vẫn thuộc zoom cũ |
| 01:09:37.718 | `viewport-plan` dòng 11866 đã tính render scale mới **10,708** |
| Khoảng 01:09:37.718 | 48 `tile-request-start` và 48 `tile-url-request` của cell còn dùng scale **9,708** |
| 01:09:37.724 | dòng 12017: target mới được nhận, active cell về **0**, các instance vừa tạo bị cleanup |

**Bằng chứng code:** [LivePageFrame.tsx](D:/pdfcompare/desktop/src/components/workspace/LivePageFrame.tsx:1928) có `panGridPlanIsCurrent` nhưng chỉ dùng để quyết định trình bày. `activePanGridTiles` chỉ xét `renderEnabled`, plan và `panGridPolicy.near`. Trong một lần React render khi `settled` vừa đổi nhưng reducer target chưa cập nhật, `zoomSettling=false`, target cũ vẫn bằng visible cũ; policy tưởng không có việc mới và mở lại atlas cũ. Effect `compute()`/dispatch sau đó mới đóng nó.

**Hệ quả xác định:** phát và hủy lại công việc thuộc kế hoạch không còn hiện hành, tăng mount/effect/IPC/cancel. Không quy toàn bộ 461 request hủy/lỗi thời thành lỗi này: một phần hủy là hợp lệ khi người dùng đổi vùng/zoom.

**Sửa đề xuất:** điều kiện được phép *phát* atlas phải kiểm tra plan/raster bucket hiện hành và viewport đã sẵn sàng cho chính bucket đó, ngay trong render. Không đợi effect cập nhật target mới đóng cổng. Giữ cache cell đã decode hợp lệ để dùng lại khi pan. Không giảm DPI hay cap worker trên máy mạnh.

### R25.04.2 — P1 / M: target mới chờ request cũ dù ảnh cũ không còn đủ mật độ

[reduceViewportTileBuffer()](D:/pdfcompare/desktop/src/components/workspace/viewportTilePolicy.ts:652) cố ý giữ `target` đang chạy, chỉ cập nhật `queued`; `ready` mới đưa queued thành target. Cách này đã giảm starvation do hủy liên tục, nhưng không có tiêu chí đánh giá lợi ích của ảnh cũ so với zoom sống.

**Timeline đợt 14:**

| Thời điểm | Bằng chứng |
|---|---|
| 01:09:37.724 | Bắt đầu request `1932757f…` tại 1028 DPI, scale 10,708 (dòng 12015) |
| 01:09:37.984 | Wheel cuối, zoom input 30,337 (dòng 12061) |
| 01:09:37.992–.995 | Plan yêu cầu scale 29,083 / 2792 DPI; vẫn ở `queued` (dòng 12066–12067) |
| 01:09:38.386 | 1028 DPI cũ hoàn tất (dòng 12273) |
| 01:09:38.388 | Mới bắt đầu request `5fb99468…` cho 2792 DPI (dòng 12282) |
| 01:09:38.418 | Probe ảnh cũ: bitmap rộng 1344, CSS rộng 3648,969; tỷ lệ **0,368** (dòng 12285) |
| 01:09:38.698 | Request mới hoàn tất (dòng 12298) |
| 01:09:38.718 | Frame đủ mật độ 1,0, phủ DOM viewport (dòng 12466) |

Target cuối đã biết nhưng còn chờ khoảng **393 ms** trước khi được phát, sau đó thêm khoảng **330 ms** tới frame opportunity. Đây là cơ chế cụ thể tạo cảm giác “dừng rồi mới nét”, không phải chỉ chờ timer idle 200 ms.

**Sửa đề xuất:** giữ độc lập bitmap đang hiện, job đang chạy và target mong muốn; bổ sung quyết định tiếp tục/hủy job dựa trên mật độ/coverage dự kiến, thời gian đã chạy và tiến độ/checkpoint. Ảnh cũ còn ích lợi được giữ; target đã quá xa phải được thay ở checkpoint. Không quay lại hủy mọi wheel — phiên trước đã chứng minh cách đó làm starvation. Cần replay đúng latency 300–430 ms và tốc độ wheel vừa ghi trước khi chọn ngưỡng.

### R25.04.3 — P1 / M: có khoảng chờ lớn trước khi lệnh render native bắt đầu

Ví dụ request `4aaffde6-20ee-4e6c-ae0a-1356ae6281e2`:

- Coordinator bắt đầu xấp xỉ **01:09:42.207**, ready **01:09:43.181**, tổng **974 ms** (dòng 14967).
- `IPC_PPE` dòng 14964 kết thúc **01:09:43.173**, `command_ms=356`; suy ra native command bắt đầu xấp xỉ **01:09:42.817**.
- Worker total **355 ms**, semaphore và spawn queue bằng 0 (dòng 14963).
- Chênh trước native entry xấp xỉ **610 ms**. 17 request cuối có chênh FE total − native command từ 8 đến 618 ms, trung vị 15 ms: phần đuôi mới là vấn đề.

**Không được kết luận “không có queue” từ `queue_ms=0`:** nhánh PPE dùng `bypassScheduler: true` ở [useTileRenderer.ts](D:/pdfcompare/desktop/src/hooks/viewer/useTileRenderer.ts:743). Queue FE đo ở coordinator không bao gồm chờ transport/dispatch trước Rust entry. `worker_queue_ms` chỉ đo chờ `spawn_blocking`, cũng không bao phủ đoạn đó.

Tauri 2.11.2 trong dependency local gửi invoke qua `fetch(...ipc...)` nếu custom protocol hoạt động. Atlas render, cancel và logging đều dùng invoke. Đây là hướng cần kiểm chứng về nghẽn transport; **chưa có trace fetch/dispatch hoặc A/B để khẳng định cơ chế cụ thể hay số slot bị nghẽn**. Không mặc định quy 610 ms cho CPU raster, network, ghi log hoặc một giới hạn kết nối nào.

**Bước kế tiếp:** đo `invoke-submit → Rust command-entry → worker dispatch → native result → FE receive` theo request ID; giữ công việc chưa cần phát ở scheduler có ưu tiên thay vì đẩy tất cả xuống transport. Scheduler phải dựa trên capacity thực của worker/phần cứng; không bật lại singleton scheduler cũ chỉ có hai slot để gọi đó là tối ưu máy 32 GiB.

### R25.04.4 — P1 / L: mỗi viewport vẫn mất hơn 300 ms trong worker

17 request đoạn cuối: **301–432 ms**, trung vị **335 ms**. Dù bỏ toàn bộ chờ frontend, một ảnh raster mới chỉ có thể hoàn tất theo nhịp cỡ ba lượt/giây trên đường tuần tự này. Wheel trong mỗi đợt thay target nhanh hơn nhiều.

Resource cache có hit: ví dụ hai request đợt 14 tăng image hit 14→16, form hit 88→96, page hit 9→10; số miss giữ nguyên (dòng 12268 và 12286). Không có căn cứ cho kết luận “mỗi zoom đọc/parse lại toàn bộ PDF”. Có cache không đồng nghĩa raster phần thay đổi đã rẻ.

**Thiếu phép đo:** worker đã có `render_ms`, `encode_ms`, `cache_ms` trong response, nhưng `PPE_NATIVE_RESULT` hiện chỉ xuất total. Log này chưa tách prepare/parse/raster/shading/transparency/ICC/PNG. Cần xuất các số thực có và profile warm viewport trước khi chọn tối ưu nội bộ.

**Hướng giải quyết:** giảm công việc lặp trong phần stage đo là đắt; khai thác scene/resource cache hiện có, chỉ vẽ vùng cần, tái dùng kết quả trung gian khi semantics/màu cho phép. Nếu vẫn không đạt latency mục tiêu, mới làm spike renderer tương tác từ scene giữ lại/đường tăng tốc GPU, với oracle parity màu và geometry. Không cam kết đổi sang GPU hay tăng cache tự động sẽ giải quyết PDF này.

### R25.04.5 — P2 / M: zoom-out có frame đủ pixel nhưng bị ẩn do thiếu coverage

Ba frame viewport đoạn cuối bị `css_visible=false`: dòng 13260 (ratio 1,824), 14410 (1,825), 16242 (1,514). [viewportTilePresentationItems()](D:/pdfcompare/desktop/src/components/workspace/viewportTilePolicy.ts:709) chủ ý ẩn tile thiếu coverage khi có underlay để tránh “đảo nét”/khung lỗi.

Đây là tradeoff hiện tại, không phải bằng chứng PNG hỏng. Underlay toàn trang có thể rất thiếu mật độ: dòng 12266 ghi ratio **0,054**. Vì vậy lúc zoom-out, người dùng có thể rơi xuống nền mờ dù đã có một phần pixel tốt.

**Sửa sau khi khóa tính đúng:** tái dùng phần giao của surface đủ mật độ ở tọa độ trang ổn định, chỉ bổ sung phần thiếu. Không lặp lại ngay bản retained-canvas/predictive R24.11 đã hồi quy. Cần test ảnh thật ở zoom phân số, pan, đảo chiều, clip/rotation/identity trước khi đưa vào viewer.

## Mở file và chi phí của phép đo

- Lần prime đầu: start → ready **3.714 ms**, trong đó chặng đến bootstrap-ready **2.983 ms**, worker 80 DPI **711 ms**. Các mốc dòng 172, 176, 192, 197. Chưa có breakdown bootstrap để quy trách nhiệm cho đọc file, metadata hay phân tích màu.
- Hai lần prime sau 1.255 và 1.306 ms đi cùng tái khởi tạo viewer; không gọi là ba lần cold-open độc lập.
- Probe DOM cả log: trung vị khoảng 0,1–0,2 ms theo trace, tối đa 1,8 ms. Con số này chỉ đo probe, không đo hết stringify, transport, ghi đĩa và ảnh hưởng của logging.
- Prefix ghi log có thể trễ hàng trăm ms, đầu lượt tối đa 2.983 ms; phân tích đã dùng timestamp capture. Cần A/B logging on/off với script thao tác cố định khi đánh giá hiệu quả cuối. Hai observer trùng sau HMR cũng cần dọn; không cộng hai lần thời lượng long task.

## Kế hoạch sửa và nghiệm thu

Mỗi lô ≤5 file nguồn/test/tài liệu. Không đổi chất lượng màu, hard-cap tài nguyên máy mạnh hoặc thay engine hiển thị để lấy số đo đẹp.

| Lô | Thay đổi cụ thể | Bằng chứng phải đạt |
|---|---|---|
| A — atlas cũ | Khóa điều kiện phát atlas theo current plan/bucket và target readiness; giữ cache đã decode | Test tái hiện chuyển `settled` trước effect phải đỏ trước sửa; không còn 48 request old-scale phát lại; vẫn prefetch/pan đầy đủ khi viewport hiện hành ready |
| B — transport | Bổ sung submit/entry/dispatch/receive + timing worker đang có; kiểm scheduling/cancel không chặn đường tương tác | Phân rã được request 974 ms tương đương; A/B chứng minh giảm tail. Không suy nguyên nhân từ queue=0 |
| C — target mới | Replay trace 44 input với latency thật; quyết định nhận target mới theo lợi ích và checkpoint, bảo toàn surface đang hiện | Target cuối không chờ vô ích ảnh đã quá thiếu pixel; vẫn có tiến triển khi wheel kéo dài, không starvation, không chớp trắng/đổi màu |
| D — PPE | Profile prepare/raster/color/encode đúng working copy; tối ưu stage đứng đầu | Cùng file/page/clip/profile/DPR; A/B đảo thứ tự, warm/cold tách riêng; ảnh/parity không giảm, máy mạnh không chậm hơn |
| E — reuse và chuẩn Acrobat | Coverage vùng giao + cache nhiều mức có kiểm chứng; chỉ spike GPU khi số đo đòi hỏi | Quay/chụp cùng thao tác PrynX/Acrobat, ROI chữ/gradient/seam; đo độ mờ trong khi zoom và sau dừng, không chỉ test mock |

Mục tiêu nghiệm thu đề xuất cho các lô tương tác: giảm rõ mốc sau wheel cuối **490–889 ms** trên cùng trace; không phát atlas stale; không bỏ target cuối; phản hồi input không có chuỗi long task; mọi bản pixel/clip giữ đúng. Mốc tham vọng như frame tương tác <100 ms là mục tiêu để benchmark quyết định, chưa phải cam kết đã đạt. Đạt mật độ 1:1 là điều kiện cần, không đủ kết luận ngang Acrobat.

## Artifact có thể kiểm lại

- [Inventory và tính toàn vẹn](D:/pdfcompare/.tmp/render-r25-04/inventory.json).
- [Bảng request và 18 đợt wheel](D:/pdfcompare/.tmp/render-r25-04/timeline.md).
- [Thống kê riêng owner/lượt cuối](D:/pdfcompare/.tmp/render-r25-04/final-session.json).
- Script phân tích: `analyze_trace.py`, `summarize_trace.py`, `final_session.py` trong cùng thư mục `.tmp/render-r25-04`.
- Dòng log trong báo cáo tham chiếu bản snapshot bất biến. Không chạy lại bộ test ứng dụng trong lượt chỉ phân tích này; không tuyên bố sửa lỗi runtime đã hoàn tất.
