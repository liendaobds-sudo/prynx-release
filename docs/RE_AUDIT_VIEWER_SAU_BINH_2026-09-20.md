# Re-audit viewer sau bình sau bản sửa của người dùng - 2026-09-20

**Phạm vi đã chốt lại:** chỉ dung lượng PDF sau bình, tốc độ mở/dựng trang và chất lượng ảnh hiển thị. **Không audit, sửa hay chạy lại probe zoom.** Không thay production source trong lượt này.

## 1. Kết luận

Bản sửa có hiệu quả thật, không phải chưa nạp đúng binary:

- **POSTVIEW20.01 đã đạt trên artifact mới:** PDF giảm từ165,96MB xuống28,74MB; còn một bitmap nền và một SMask, giữ nguyên5000x3125px và hash payload.
- **POSTVIEW20.02 cache ICC đã chạy:** profile mới có image miss lần đầu và image hit lượt sau. Cùng file cũ trên engine mới giảm thời gian PPE khoảng13,02s ->6,25s.
- **Trải nghiệm tải vẫn chưa đạt:** file mới chỉ mất66,7ms để bootstrap nhưng PPE vẫn cần6,07s trang đầu, warm5,74s. Điểm nghẽn còn lại là raster, không phải file chưa dedup hoặc cache chưa được bật.
- **POSTVIEW20.03 chưa được sửa đầy đủ:** code mới lấy trung bình alpha, nhưng màu ảnh vẫn lấy từ một texel. Viền trong suốt có thể khác, còn chữ/chi tiết màu trong ảnh vẫn alias. PNG hiện tại xác nhận vẫn răng cưa rõ so với PDFium cùng mật độ.

Không kết luận mọi thay đổi của người dùng đều sai. Cần giữ phần dedup/cache đã đúng và xử lý tiếp sampling màu + chi phí raster.

## 2. Binary và file đã đo

- Worker đang chạy từ desktop/src-tauri/target/debug/pdf-inspector.exe, mtime21:58:18, SHA25675993ECBCC4A8EC6401225037D5307153764B1DC1B188F65E009735B4DCC847E.
- Các process app/worker bắt đầu sau21:58:18. Probe mới cũng dùng chính executable này.
- Binding native trong backend/venv được build21:56:21. Profile core ghi riêng với worker, không cộng thời gian hai binary.
- Nguồn mới: sticker_60ba731b.pdf,47.702.769byte,123trang.
- Output mới: nup_4f866c3a.pdf,28.741.104byte,17trang,21:58:48.
- Output cũ đối chứng: nup_6cd97ef2.pdf,165.956.101byte,17trang.
- Cả ba dưới C:/Users/Khanh Pham/AppData/Local/Temp/PrynX-dev/results.
- N=3 cho output cũ và mới trên engine mới; mỗi lượt process/cache TEMP riêng. Không flush OS file cache, máy đang dùng chung.
- Chỉ đo worker và core, **chưa đo click-to-paint trên GUI**. Không restart/kill app người dùng, không đổi setting.

## 3. Kết quả đo

Trung vị3lượt,96DPI, trang1, bitmap1247x1814:

| Ca | Bootstrap | PDFium full-page | PPE lần đầu | PPE lần2 giữ session |
|---|---:|---:|---:|---:|
| Engine trước + output cũ (baseline audit trước) |183,25ms|701,57ms|13.018,19ms|14.375,20ms|
| Engine mới + cùng output cũ |167,81ms|581,62ms|6.252,38ms|5.739,40ms|
| Engine mới + output mới đã dedup |66,68ms|610,07ms|6.074,97ms|5.742,74ms|

Diễn giải:
- So cùng output cũ giúp tách tác động engine khỏi việc giảm size: bản engine mới đã nhanh hơn rõ.
- Giảm size tiếp tục cải thiện bootstrap/RAM; không xóa chi phí vẽ cùng8ảnh trên trang.
- PPE file mới vẫn chậm xấp xỉ10lần PDFium ở phép đo này. Đây không phải lý do đổi renderer màu bất chấp tính đúng.
- Không gọi3lượt là P95 hoặc benchmark đại diện mọi tài liệu.

Profile core mới, cùng output mới:
- Lượt1: tổng5791,91ms; raster5702,50ms; color84,75ms; parse/open trong render=0.
- Lượt2: tổng5650,25ms; raster5561,07ms; color84,28ms; parse/open=0.
- Image cache: lượt1 hits0/misses1 -> lượt2 hits1/misses1; không eviction.
- Form cache: hits23 ->58, misses giữ12.
- Cache giữ109.813.556byte trên budget536.870.912byte của probe.

Do đó không còn căn cứ nói cache ICC vẫn bị bỏ qua như báo cáo baseline. Nhưng dù cache đã hit, raster vẫn mất5,56s: phải profile/tối ưu phần còn lại, không tiếp tục coi giải mã ảnh là toàn bộ thời gian.

## 4. Phần đã đạt

### Khử trùng ảnh - artifact xác nhận

Output mới có2 Image XObjects:
- Ảnh ICCBased + SMask:5000x3125,19.521.432byte nén.
- SMask DeviceGray:5000x3125,41.120byte nén.

Hash giống ảnh/mask nguồn và baseline:
- Ảnh:941d1f1ebb23d2e65a3181a55d4dffe221a7a0cdc6d4aa4de240ffd702d7a475.
- Mask:ee7faf54b7115574c51be9186a1240e0b0e7f9cab2274614ccf7df4b107df030.

Không mất resolution hay đổi sang JPEG. Nguồn mới tự chứa hai bản ảnh/mask, nhưng output đã gộp về một bộ; output nhỏ hơn nguồn trong trường hợp này là hợp lý.

Code live:
- backend/app/workers/nup_output_finalize.py:184-205 gọi deduplicate_image_xobjects sau merge.
- backend/app/core/pdf_resource_dedup.py băm cả dictionary/ICC/SMask/payload, đi dây lại tham chiếu.
- Test dedup + finalizer: **9/9pass**; chưa coi đây là chứng nhận mọi PDF phức tạp.

### Cache ICC - số đo xác nhận

print_engine/src/content/interp.rs:3217+ chấp nhận ColorSpace Array ICCBased; đường decode_image_cached lấy shared cache thật. Counter core đã thay đổi từ không lookup sang miss/hit như kỳ vọng. Không đề nghị gỡ bản sửa này.

## 5. Phần chưa ổn - POSTVIEW20.03 vẫn OPEN

[CONFIRMED] P2, effort M. Bản sửa lọc alpha không tương đương lọc màu ảnh.

Đường thực thi trong print_engine/src/content/interp.rs:
1. :3603 mở preview_sample_grid cho ảnh viewer.
2. :3686-3729, với ảnh alpha khi thu nhỏ, vòng lặp cộng alpha_sum và đếm valid_samples.
3. Nó đồng thời chọn best_sx/best_sy là điểm có alpha cao nhất.
4. :3724 tính avg_alpha, nhưng chỉ trả (best_sx,best_sy,coverage).
5. :3800 gọi sampler.ink_into(sx,sy) **một lần tại điểm được chọn**. Không lấy trung bình RGB/màu của footprint ICC.
6. Trường hợp các mẫu đều alpha1, best_alpha chỉ được cập nhật ở mẫu đầu vì so sánh >. Màu trở thành màu của mẫu đầu trong lưới, không phải trung bình vùng ảnh.

Kết quả: có thêm nhiều lần đọc alpha nhưng chưa có anti-alias đúng cho chữ/hoa văn/màu trong phần đục của ảnh. So với trước, còn thay đổi pha chọn texel từ tâm sang một vị trí khác, nên chi tiết có thể trông khác nhưng không có nghĩa đã lọc tốt hơn.

Mask thật đo được:
- 78,536% pixel alpha255.
- 21,387% alpha0.
- Chỉ0,077% là alpha trung gian.
Các tỷ lệ tính trên toàn bitmap, không phải chỉ vùng đã qua clip oval.

Ở mức96DPI, grid có thể tới8x8=64mẫu mỗi pixel thiết bị. Vòng này tốn công ngay cả nhiều vùng hoàn toàn đục. Chưa có timer riêng quanh vòngalpha, vì vậy **chưa quy toàn bộ5,56s cho64mẫu alpha**; đây là đường nóng cần tách số đo tiếp theo.

Đã xem PNG thực:
- new-source-display.png và new-source-accurate.png ở mật độ tương đương: PPE vẫn răng cưa ở logo, chữ headline và chi tiết ảnh; PDFium mượt hơn.
- Image pixels gốc không đổi; vấn đề hiện tại nằm ở cách lấy mẫu/render, không phải exporter hạ độ phân giải.
- Không dùng khác biệt màu Fogra39/sRGB để thay cho đánh giá sampling; chưa so GUI Acrobat.

## 6. Hướng sửa tiếp phù hợp

1. **Lọc màu và alpha cùng nhau**, có trọng số/premultiplied alpha đúng, thay vì chọn best-alpha texel làm màu đại diện. Giữ đúng ICC và tránh halo.
2. Làm hiệu quả bằng ảnh/level đã lọc sẵn hoặc cache theo mức cần hiển thị, cùng profile/revision/transform thích hợp; không chạy ICC hàng chục lần cho từng pixel chỉ để mở rộng vòng hiện tại.
3. Có fast path được chứng minh cho vùng mask hoàn toàn đục/trong suốt; phần biên xử lý đầy đủ. Không giả định cả ảnh đục chỉ vì phần lớn pixel đục.
4. Cache nền ảnh chung, **không cache nguyên tem rồi làm mất chữ VDP riêng từng loại**.
5. Đo riêng decode, samplingalpha, samplingmàu, ICC, composite và clip. Warm cache đã hit nhưng5,56s raster cho thấy vẫn còn chi phí đáng kể.
6. Nghiệm thu bằng cùng PDF sau bình ở đúng mật độ màn hình, kiểm chữ nhỏ, đường cong, halo, màu, thời gian first readable frame. Không giảm DPI để làm đẹp số tốc độ.

Đây là đề xuất, **chưa triển khai**. Không cần mở lại công việc sửa zoom.

## 7. Kiểm thử và giới hạn

-9backend tests đạt: test_pdf_resource_dedup.py + test_nup_output_finalize.py.
-Worker N3 mỗi output; nguồn mới N1 để lấy ảnh đối chiếu.
-Core N2 có cache/timing phases.
-Không build binary mới trong audit; đã kiểm đúng mtime/hash binary người dùng vừa build.
-Không chạy probe zoom, không sửa source, không re-export/ghi đè PDF khách, không commit.
-Chưa có phép đo cô lập chứng minh bao nhiêu ms thuộc riêng alpha loop; chưa benchmark các file/bảncài khác.
-Báo cáo gốc giữ làm baseline; trạng thái mới chỉ thay cho các kết luận đã kiểm ở đây.

## 8. Evidence

- docs/audit/POST_IMPOSITION_VIEWER_RECHECK_2026-09-20.json.
- Workspace/tmp/post-impose-recheck-20260920/: raw worker JSON, PNG và core-profile.json.
- Harness: recheck_post_impose_worker.py, recheck_post_impose_repeat.py, recheck_post_impose_core.py.
- Field source_snapshot trong JSON ghim các file liên quan. Bản sửa của người dùng được giữ nguyên.
