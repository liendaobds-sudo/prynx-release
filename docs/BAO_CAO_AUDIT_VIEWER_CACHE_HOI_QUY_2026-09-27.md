# Chẩn đoán hồi quy zoom/pan và làm nét — 27/09/2026

> **Sau người dùng duyệt “sửa”: R1–R4 đã vá, verify SOURCE + AUTO + ARTIFACT headless.** [Nhật ký sửa và giới hạn nghiệm thu](PDF_VIEWER_CACHE_HOI_QUY_FIXES_2026-09-27.md). Nội dung dưới đây giữ nguyên bằng chứng **trước vá**, không dùng làm mô tả trạng thái source hiện tại.

## Kết luận

**Chưa đạt nghiệm thu độ mượt. Đã xác nhận hồi quy ở cache/ROI của lô V27.D1/D2.** Trang phức tạp làm chi phí lộ rõ hơn, nhưng nguyên nhân không chỉ là dung lượng PDF hoặc phần cứng yếu. Không được dùng các test pixel/benchmark kernel trước đó để kết luận quá trình làm nét thực tế hoàn tất.

Lượt này chỉ đọc log, chạy probe headless và cập nhật tài liệu; không sửa production, không điều khiển máy, không restart/kill app, không đổi PDF hay ICC. Quy trình audit yêu cầu dừng mở rộng tối ưu khi người dùng báo hồi quy; ưu tiên khoanh lô gây lỗi.

## Phạm vi và provenance

- Host đang chạy: PID **17540**, khởi động 06:12 ngày 27/09, EXE SHA256 `6e298bafb4b6b25649b918ab3c6b9bbaa76e281d011fb9d6712bab98db30ab59`; hash file EXE khớp session log. Không quy lỗi cho việc chạy binary cũ.
- Hash source `detail_cache.rs`, `presenter.rs`, `refinement.rs`, `retained_renderer.rs` khớp snapshot trong `fixes-results.json` của lượt sửa trước. Source không bị sửa trong lượt chẩn đoán này. Hash source không thay thế provenance build đầy đủ.
- Log thao tác Giấy mời là **bản chưa outline trên Desktop**, `CMNM2026 - Giay moi_BLUE - in.pdf`, 17.869.243 byte. Không đánh tráo với fixture outline 18.059.736 byte trong `D:/pdfcompare/test/`.
- Vòng idle dài ở **tài liệu khác, trang 2/revision 12**. Nó chứng minh lỗi cache không chỉ xảy ra trên Giấy mời; không dùng số đo này làm số đo riêng của fixture outline.
- [Kết quả máy đọc và hash snapshot](audit/VIEWER_2026-09-27/cache-regression-diagnosis.json), [log trích có số dòng gốc](audit/VIEWER_2026-09-27/cache-regression-evidence.log), [probe gọi trực tiếp source cache](audit/VIEWER_2026-09-27/repro_detail_cache_convergence.rs), [script kiểm bằng chứng](audit/VIEWER_2026-09-27/diagnose_cache_regression.py).

## Số đo thực tế

| Phạm vi | Số đo | Ý nghĩa |
|---|---|---|
| Giấy mời mở trang 1, log L213438–213443 | Parse **50,936 ms**, compile **241,317 ms**, transport residual **91,249 ms**, chuẩn bị scene tổng **468 ms**; 487 scene commands, wire 98.564.179 byte | PDF khoảng 18 MB giải nén thành scene khoảng 94 MiB; dung lượng file không phản ánh công việc mỗi trang. Phase con có chồng lấp, không cộng tùy tiện |
| Giấy mời, full detail N=6, cửa sổ epoch 1790464438005–1790464443575 | CPU encode **26,726–89,693 ms**, P50 **30,218 ms** | Có chi phí dựng nét thật vượt 16,667 ms; chạy ở refiner, không đồng nghĩa UI bị khóa đúng từng khoảng này |
| Giấy mời, cùng mảnh 3×5, N=31 trong cửa sổ trên | CPU encode **8,618–12,291 ms**, P50 **9,722 ms**; mỗi lượt **9.470.456 byte coverage** | Chỉ 15 pixel output nhưng mask/coverage vẫn làm nhiều việc, và bị lặp không tiến triển |
| Tài liệu khác, epoch 1790464610300–1790464854349, khoảng **244,049 s** | **11.556** refinement, tất cả 12×3; **11.556 insert + 11.556 miss**, không có input native; cache luôn **123 entries** | Đã đứng yên nhưng bộ lập lịch không bao giờ công nhận đủ vùng nét |
| Cùng cửa sổ idle | **34.668** lần gọi present; CPU acquire+encode_submit+present P50 **5,965 ms**, P95 **9,204 ms**, max **32,637 ms**, 121 mẫu >16,667 ms | Công việc thừa có thể tự tạo tải; không phải 34.668 khung thực được màn hình hiển thị |

`ready_us`/`request_age_us` lấy tuổi của **FrameRequest** cuối cùng. Con số 244 triệu µs không có nghĩa một lần raster mất 244 giây. Chứng cứ vòng lặp là các event lặp, camera/input đứng yên và cache miss liên tiếp.

## Finding và nguyên nhân gốc

### V27.R1 — CONFIRMED P1: vùng thiếu không hội tụ do sai số tọa độ

Trace: native camera → `presenter.rs:199` kiểm `details.touch()` → `missing_region()` → Refiner crop → `insert()` → partial đặt `completed=None` → kiểm lại.

`detail_cache.rs:11–26` biến đổi vùng bằng `source.invert().then(target)` với `f32`; `Region::valid()` coi mọi khoảng dương, dù rất nhỏ, là khe thật. `missing_region()` dòng 113 mở khe bằng floor/ceil cộng gutter 2 px. Không có chứng minh tiến triển giữa hai lượt.

Probe gọi **nguyên source cache**, texture headless thật, không chép thuật toán sang ngôn ngữ khác:

- Đối chứng ma trận nguyên: pan (-5,+3), hoàn tất sau **2 ROI**.
- Ma trận tổng hợp gần zoom 6,3773 của log: phép nghịch đảo/nhân lại trả `a=d=1.0000001`, `e=0.00024414063`, `f=-0.00012207031`, không phải identity chính xác.
- Sau 8 lượt đã quay lại đúng `[0,0,3,5]`; chèn kết quả cùng vùng vẫn `touch=false`. Probe phát hiện vòng lặp và dừng; 32 chỉ là giới hạn an toàn của probe, không phải cap đề xuất cho ứng dụng.

Ma trận probe là ca tổng hợp vì telemetry hiện làm tròn pan và thiếu ROI origin; không gọi nó là replay chính xác mọi trạng thái live. Tuy vậy, lỗi trên source được tái hiện độc lập và cùng dạng 3×5 xuất hiện trong log Giấy mời.

### V27.R2 — CONFIRMED P1: crop nhỏ xóa vùng nét lớn

`detail_cache.rs:84–88` loại entry chỉ vì **matrix bằng nhau**, không kiểm kích thước texture trước. Crop bắt đầu tại (0,0) giữ nguyên matrix, dù chỉ 3×5.

Probe: chèn frame 100×100 identity, coverage đúng; chèn 3×5 cùng identity → chỉ còn **1 entry / 60 byte**, mất coverage 100×100. Trong probe fractional, bước `[0,0,3,5]` cũng thay mảnh cùng gốc lớn hơn và buộc dựng lại dải `[1,0,1286,5]`.

Đây là lỗi mất tiến triển, không phải thiếu RAM. Nó có thể làm mất vùng detail đang dùng; tuy nhiên chưa có ảnh scan-out để quy mọi vùng mờ người dùng thấy cho riêng finding này.

### V27.R3 — CONFIRMED P2: ROI nhỏ vẫn gánh công việc mask lớn

`retained_renderer.rs:247` xây `mask_regions()` trên viewport; `mask()` dòng 444–448 thay `active_region` bằng vùng mask hợp của các invocation. Vì vậy ROI nhỏ không giới hạn được toàn bộ công việc mask. Log Giấy mời 3×5 vẫn có 13 draw và 9.470.456 byte coverage, 31 lượt lặp.

Không được cắt mask theo invocation đầu hay bỏ BC/TR/knockout để làm nhanh: mask dùng lại cần union đúng mọi vùng tiêu thụ trong công việc hiện tại. Cần kiểm riêng dependency/AA và pixel parity trước khi thu vùng này.

### V27.R4 — CONFIRMED P1: test nghiệm thu thiếu bất biến hoàn tất và idle

Test `refinement.rs:281` có 120 camera dùng một detail, vòng submit riêng và `completed=Some(work.camera)`; **không chạy DetailCache::missing_region/touch hoặc scheduler thật của Presenter**. Test union hiện hữu chủ yếu dùng identity/toạ độ nguyên. Test ROI pixel parity kiểm các crop riêng, không kiểm hợp coverage sau nhiều crop.

Do đó hàng nghìn test pass và ROI byte-identical vẫn không bắt R1/R2. Mức tin cậy “lô D đã đạt” phải được hạ xuống **OPEN/STALE cho convergence và smoothness**, giữ nguyên giá trị hẹp của test pixel đã chạy.

### Nghi vấn chưa được nâng thành nguyên nhân gốc

- Cache 123 entry đi vào compositor; `resident_present.rs:83–100` tạo pass/fullscreen triangle, uniform và bind group cho từng lớp giao viewport, chưa chọn riêng vùng đóng góp. Có nguy cơ overdraw lớn, nhưng log chưa có GPU timestamp live nên chưa định lượng phần GPU.
- Batch credit mới có thể làm refinement kéo dài trên scene nhiều command. Log này **không chứng minh deadlock GPU credit**; các command/refinement vẫn hoàn tất liên tục. Không ưu tiên vá scheduler theo phỏng đoán trước R1/R2.
- Chưa chứng minh PPE sidecar/IPC, PDFium lock hay thiếu RAM là thủ phạm vòng lặp hiện tại.

## Kế hoạch sửa đúng trọng tâm

1. **Lô cache/convergence, ưu tiên cao nhất:** giữ vùng phủ theo lưới raster/ROI nguyên với provenance camera; không tái tạo “khe thiếu” từ nhiễu `f32`. Cùng matrix chỉ thay thế khi extent và mật độ mới thật sự bao phủ phần cũ. Không tăng epsilon tùy tiện để giả chứng minh pixel.
2. **Lô scheduler/test:** thêm kiểm tiến triển cùng camera/ROI; khi không tiến triển, chuyển sang full-detail PPE của camera hiện hành mà vẫn giữ frame tốt, không quay sang PDFium hoặc nền trống. Test headless phải đi qua cùng logic Presenter + cache, fractional pan/zoom, DPR 1/1,25/1,5/2, pan↔zoom đảo chiều. Điều kiện đạt: vùng nét hoàn tất và không tự submit/present tiếp khi camera đứng yên.
3. **Lô ROI/mask/compositor:** union đúng nhu cầu mask của toàn bộ ROI hiện tại; kiểm nested/reused SMask, BC/TR/knockout, AA và FOGRA39 parity. Chỉ vẽ vùng detail thực sự đóng góp, cắt scissor phù hợp; không giải quyết bằng hard-cap cache hoặc giảm chất lượng trên máy 32 GiB.
4. Đo riêng CPU encode, chờ submit/GPU completion, time-to-sharp và idle work bằng harness logic chung. Chạy lại fixture outline trang 1 và bản Giấy mời chưa outline như hai ca riêng. Không suy tốc độ kernel thành 60 fps hoặc tuyên bố tương đương Acrobat khi chưa có bằng chứng hiển thị.

Mỗi lô sửa tối đa 5 source/test file, verify trước khi chuyển lô. Lượt chẩn đoán này không triển khai các thay đổi trên.

## Verify của lượt chẩn đoán

- Compile probe độc lập bằng `rustc --edition=2021`, liên kết rlib đã có ở `.tmp/viewer-v27-target/debug/deps`; không build/thay binary ứng dụng. Link lần đầu thiếu đường dẫn native `windows.0.52.0.lib`; thêm đúng thư mục dependency đã cài, không tải/cài gì.
- Probe chạy headless thành công, tái hiện R1/R2 với đối chứng nguyên. Script bằng chứng xác nhận các count và output trên, lưu SHA256 snapshot prefix/log + source.
- Không chạy lại full suite vì không sửa production. Không nâng kết quả thành nghiệm thu GUI.
