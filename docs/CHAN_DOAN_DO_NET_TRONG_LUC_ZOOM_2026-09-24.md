# Độ nét trong lúc zoom sau bản chống chớp — 2026-09-24

**Kết luận: bản R24.07 xử lý việc lớp PDFium phủ lại PPE, chưa làm PPE tạo ảnh nét nhanh hơn. Trải nghiệm giữ nét trong lúc wheel vẫn chưa đạt kỳ vọng của người dùng.** Lượt này chỉ chẩn đoán và bổ sung bằng chứng; không thay đổi production, không build hay restart ứng dụng.

## 1. Bằng chứng runtime mới

Trace `Vmufom5lz-p8s66f`, seq 1–19876, khoảng 22:23:44–22:27:40 ngày 24/09. SHA-256 `LivePageFrame.tsx` được Vite phục vụ khớp source trên đĩa: `30bcd2bdc9ff79e1f40bf9ced0fc99b24bb1eb53c5ee16c6e09e4bceb0d602d4`.

[Dữ liệu đã ẩn đường dẫn tài liệu](audit/RENDER_LOAD_2026-09-24/zoom_sharpness_runtime_post_flash_fix.json).

| Phép đo | Kết quả trong trace này |
|---|---|
| Request viewport chính của tài liệu PPE `6b7a9ffaa811` | 97: 88 cancelled (90,7%), 8 ready, 1 stale |
| Native của 8 request ready, ghép đúng `request_id` | 537–1551 ms; trung vị 689,5 ms |
| Native completion stale còn lại | 471 ms; tổng cộng 9 completion native quan sát được |
| Hàng đợi đã ghi trong 9 completion | `sem_wait_ms=0`, `worker_queue_ms=0` |
| FE viewport commit | 8; `native_to_decode_ms` trung vị 773 ms, tối đa 1598 ms |
| Phân bố trang | Trang 1: 53 request / 6 commit; trang 2: 44 request / 2 commit |

`native_to_decode_ms` là khoảng request đến decode/commit của FE, không phải thời gian riêng bộ giải mã và không phải input→compositor. Không trừ timestamp hai clock hay dùng thời điểm flush log làm thời gian ảnh lưu trên màn hình. Đây là một phiên thao tác với một tài liệu PPE, không phải phân vị hiệu năng sản phẩm hay A/B với Acrobat.

Trace không có request group `viewport-display`; đường hai lớp gây chớp R24.07 không xuất hiện lại trong mẫu này. Tài liệu compatibility khác vẫn có actual engine PDFium dưới tên group `viewport-accurate`; tên group không xác nhận engine.

## 2. Hai cơ chế còn cản ảnh nét khi wheel đang chạy

### R24.08 — target mới loại target đang render trước khi có ảnh

`LivePageFrame.tsx` cập nhật target khoảng mỗi 16 ms. Khi bucket DPI hoặc clip đổi, key viewport đổi. `reduceViewportTileBuffer()` trong `viewportTilePolicy.ts` giữ ảnh A đã hiện nhưng thay target B đang chạy bằng C. Fragment có key theo tile làm B unmount; cleanup hủy request/generation của B. `useTileRenderer.ts` và coordinator cũng hủy/vô hiệu hóa request viewport trước khi nhận target mới.

Vì vậy cơ chế giữ in-flight và coalesce target bên trong một `LiveTile` không bảo vệ được B khi cả instance bị tháo. Không phải mọi wheel tick đều tạo request: bucket DPI/clip giống nhau vẫn có thể tái dùng target.

Bằng chứng runtime phù hợp với luồng này:

- Trang 1: request→unmount tại seq 270→297 (scale 1,458), 328→379 (1,708), 425→476 (1,833); coordinator generation 5/6/7 đều cancelled. Sau đó mới có commit scale 3,583 tại seq 942, native PPE 679 ms.
- Trang 2: request→unmount tại seq 6169→6199 (scale 1,083), 6231→6258 (1,208), 6290→6317 (1,333); generation 1/2/3 đều cancelled. Commit scale 7,208 tại seq 7277 có native PPE 1196 ms.

Ảnh A phải tiếp tục được kéo giãn trong khoảng chờ. Chỉ đặt chu kỳ target thành 16 ms không tạo ra ảnh nét mỗi 16 ms.

**Hướng sửa:** tách target mong muốn, target đã nhận để render và ảnh đang hiển thị. Với cùng định danh nội dung, giữ B sống đến terminal, chỉ ghi đè target mong muốn bằng C mới nhất; B hợp lệ hoàn tất thì trình bày với đúng hình học của B rồi tiếp tục C. Đổi tài liệu/revision/trang/profile/rotation vẫn hủy ngay. Phải xử lý cả lỗi/hủy/decode thất bại để luôn tiếp tục target cuối.

Không chỉ bỏ cancel hoặc cố định React key: coordinator vẫn vô hiệu generation cũ; bitmap clip B không được vẽ bằng hình học C. Cần chính sách coverage khi pan/zoom-out và không cho response sai nội dung quay lại màn hình.

### R24.09 — nhánh nhận prime có thể tiếp tục chờ 96 ms ở các lần zoom sau

`shouldSettleAccurateTarget()` yêu cầu accurate-only, đã nhận prime, đã có ảnh và params thay đổi. `adoptedInitialFrameRef` được bật khi nhận prime nhưng không reset sau lần sharpen đầu. Full-page instance sống lâu vì vậy có thể khởi động lại timer 96 ms ở những lần zoom sau khi đi qua các guard cache/giữ ảnh nét hơn.

Đây **không phải debounce chung của mọi viewport**: viewport instance mới thường không nhận prime, nên không thuộc nhánh này. Kết luận này dựa trên source, chưa có phép đo riêng mức đóng góp 96 ms trong trace hiện tại.

**Hướng sửa:** giới hạn settle vào giai đoạn ổn định layout sau prime. Sau lần sharpen đầu, các target mới đi theo cơ chế in-flight/coalesce, không tiếp tục chịu cold-start delay.

## 3. Chi phí PPE vẫn cần giảm độc lập

PPE đã giữ Document/PageProgram, prepared snapshot và cache tài nguyên. Không có cơ sở đề xuất xây lại các thành phần đó từ đầu. Tuy vậy target mới vẫn chạy raster, chuyển mực sang sRGB và encode PNG trong đường worker PPE hiện tại (`print_engine/src/session.rs`, `desktop/src-tauri/src/pdf_engine/render_worker.rs`).

Hai trường queue bằng 0 chỉ loại trừ việc chờ tại **hai điểm đã đo**, không chứng minh không có contention hay chờ bên trong worker. Log `PPE_NATIVE_RESULT` chỉ có total/queue/bytes; chưa tách prepare/raster/color/encode. Worker response đã có `render_ms`, `encode_ms`, `cache_ms`, nhưng `render_ms` còn gộp open/parse/raster/color. Không quy toàn bộ 537–1551 ms thành raster hoặc PNG.

Ngay cả khi sửa R24.08, một ảnh mới mất khoảng nửa giây đến hơn một giây vẫn chưa đáp ứng kỳ vọng giữ nét khi zoom nhanh. Sửa lịch giúp công việc hữu ích được hoàn thành; giảm chi phí tạo pixel là bài toán tiếp theo.

## 4. Thứ tự nâng cấp và phép nghiệm thu

1. **Chống đói kết quả trong viewport.** Test render mất 80 ms, target khác nhau đến mỗi 20 ms suốt hơn 300 ms: phải trình bày ảnh PPE mới khi input còn chạy, rồi đạt target cuối. Kèm lỗi/decode lỗi, đổi document/profile, zoom đảo chiều và coverage pan/zoom-out. Không khôi phục đường PDFium phủ PPE.
2. **Bỏ settle lặp lại sau prime.** Test prime→ảnh sharpen đầu→zoom tiếp; chỉ giai đoạn layout ban đầu được settle.
3. **Đo từng pha và cạnh tranh CPU trên đúng binary hiện tại.** Ưu tiên viewport đang nhìn; xác minh caller `viewerPanGridRenderPolicy` đang bỏ tham số `targetRasterPending` trước khi kết luận atlas làm chậm. Không tăng worker hay đổi transport dựa trên phỏng đoán.
4. **Tối ưu pha chiếm thời gian và thử khả năng giữ sẵn pixel cho mức zoom kế tiếp.** Thử nghiệm cache nhiều mật độ/prefetch có đo chi phí pixel và RAM; không tăng DPI vô điều kiện. Giữ chất lượng và khả năng máy mạnh theo quy tắc dự án.

Đo trước/sau trên cùng tài liệu, clip, DPR, profile và chuỗi input: số lần ảnh nét cập nhật **trong lúc wheel còn chạy**, tuổi/mật độ bitmap đang hiện, thời gian từ input cuối đến ảnh cuối, tỷ lệ hủy, màu và coverage. Test lifecycle xanh chưa chứng minh trải nghiệm ngang Acrobat; cần quan sát compositor và đối chứng cùng điều kiện.

Chưa chạy benchmark binary cũ để suy hiệu năng hiện tại, chưa có GUI A/B Acrobat. Không tuyên bố mức tăng tốc trong lượt chẩn đoán này.
