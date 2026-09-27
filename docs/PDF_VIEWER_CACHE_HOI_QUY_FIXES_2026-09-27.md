# Sửa hồi quy cache/làm nét Viewer — 27/09/2026

> **Phản hồi tiếp theo “tệ hơn”: nghiệm thu trải nghiệm vẫn OPEN.** Log mới xác nhận hai lỗi chưa nằm trong test cache: tool IPC cắt pan và renderer cũ mang revision mới lúc chuyển trang. Đã vá hẹp R5/R6, 2 test đỏ→xanh,57 viewport tests đạt; chưa xác nhận hết độ trễ overview/phản hồi trên cửa sổ thực. [Tái kiểm input/scene](VIEWER_INPUT_SCENE_RECHECK_2026-09-27.md). Không dùng số liệu ROI phía dưới làm bảo đảm tốc độ thao tác tổng thể.

**R1–R4 đã vá và verify SOURCE + AUTO + ARTIFACT headless. Không nâng toàn Viewer lên 60fps/RUNTIME.** [Số đo, hash source/input/test binary](audit/VIEWER_2026-09-27/cache-regression-fixes-results.json).

Người dùng duyệt “sửa” sau báo cáo `BAO_CAO_AUDIT_VIEWER_CACHE_HOI_QUY_2026-09-27.md`. Chỉ kiểm bằng code, không điều khiển hay ra lệnh restart ứng dụng; giữ mọi thay đổi khác trong worktree. Không commit/push/phát hành và không sửa PDF khách.

## Lô R1/R2 — coverage và giữ frame nét

- Hai test hồi quy đỏ trước patch: frame fractional tự thiếu coverage; crop nhỏ cùng matrix làm mất frame lớn.
- `RasterCoverage` giữ matrix raster gốc + ROI nguyên từ chính Refiner. Cùng camera dùng trực tiếp tọa độ nguyên, camera khác biến đổi bằng f64; không dùng epsilon để lấp khe thật.
- Cache chỉ loại entry bị vùng mới bao phủ đủ kích thước và mật độ; không dedup theo matrix đơn thuần.
- Verify: **10 cache tests đạt**, gồm 48 tổ hợp DPR 1/1,25/1,5/2 × 4 rotation × zoom 1/1,15/0,8; kiểm khe thật nhỏ vẫn không bị che. `cargo check --offline --lib` đạt, target riêng `.tmp/viewer-v27-target`.
- Mức bằng chứng: source + test headless; chưa nghiệm thu app đang chạy.

## Lô R4 — tiến triển và idle

Đã gắn policy dùng chung với Presenter: chỉ dựng ROI khi diện tích thiếu giảm; nếu không giảm thì full-detail PPE, giữ frame tốt. Test kiểm chính policy + cache + Refiner, không dùng vòng `completed` riêng như probe trước.

- 53 native viewport tests đạt (5 ignored có điều kiện; bỏ riêng 9 test liên quan HWND/input để không điều khiển UI), thêm test tích hợp fractional Refiner đạt.
- Hai ca PDF thật riêng biệt (outline trong `test/`, bản chưa outline trên Desktop), mỗi ca **32 camera/DPR + 3.840 kiểm idle**, ROI so byte với full frame, **0 byte khác / 0 lần recovery**. Artifact `cache-fix-outline-before-mask.json` và `cache-fix-desktop-before-mask.json`.
- Test cố tình không thêm coverage đã đi đúng nhánh full PPE recovery mà không xóa frame tốt; sau full, 120 kiểm policy trả Idle.
- Chưa gọi đây là scan-out/FPS hoặc kiểm toàn vòng surface/batch GPU của Presenter; bộ test dùng cùng policy thật, Refiner, cache và GPU fence headless.

## Lô R3 — mask/ROI và compositor

Đã giới hạn union mask theo nhu cầu ROI gốc cho mọi invocation, kể cả nested/shared mask. Không đổi FOGRA39, backdrop/transfer, knockout hoặc AA toàn cục.

- Test đỏ trước/sau: ROI 15 pixel từ **29.552 → 128 byte coverage**, 96 đối chiếu pixel (2 luminosity ×2 isolated ×2 knockout ×3 scale ×4 ROI) đều khớp full-frame.
- 7 test GPU scene/ROI đạt, 2 probe ignored được chạy riêng. Exact fixture outline: 18 ROI/3 camera không khác byte, trước và sau đều có CSV. Tại camera 1, ROI3×5: **7.067.200 → 256 byte coverage**, CPU encode **4,997 → 1,700 ms**, hoàn tất fence **14,612 → 6,396 ms**. Đây là một cặp mẫu kernel headless, không phải FPS GUI hay mức cải thiện bảo đảm trên mọi trang.
- Chuỗi convergence/PDF thật sau mask đã chạy lại trên binary test cuối, không ảnh hưởng lô trước: `cache-fix-outline-final.json`, `cache-fix-desktop-final.json`. Mỗi file 62 refinement trong 32 camera, tối đa 9 lượt/camera; sau đó 3.840 kiểm idle, 0 recovery và 0 byte ROI khác full-frame.

## Compositor — giảm fragment cho mảnh nhỏ

- Scissor lấy từ đúng map f32 gửi shader, nghịch đảo f64 và mở biên bảo thủ. Không đổi UV, bilinear filter, thứ tự layer, ICC hay pixel ngoài detail.
- Mảnh 3×5 ở viewport1292×733 chỉ cần scissor dưới150 pixel thay vì chạy fragment trên947.036 pixel. Đây là cận vùng shader trong test, không phải số đo tốc độ tổng thể.
- Test **123 lớp detail** với identity, fractional pan/zoom, rotation90° và shear: output bằng byte với đối chứng cùng compositor không scissor ở cả4 camera. Không cắt số entry/worker hoặc giảm DPI.

## Verify cuối và giới hạn

| Kiểm tra | Kết quả |
|---|---|
| Native `viewport::`, bỏ rõ các test HWND/visibility/input UI | **54 pass, 6 ignored**, 9 test UI không chạy |
| Toàn bộ `viewer_gpu` | **49 pass, 5 ignored** |
| `pdf_engine::render_worker::tests` | **53 pass, 9 ignored** |
| Probe ignored chạy riêng | Hai PDF liveness trang1; 18 ROI exact-fixture; PPE RGB và late-material-fallback qua worker, crop/rotation/scale |
| `cargo check --offline --lib --examples` | Đạt; cảnh báo dead-code, không có compile error |
| TS/Python backend/UI | Không sửa nên không chạy lại full frontend/backend suite |
| Golden snapshots, release, cài đặt, GUI/scan-out | Không cập nhật/chạy |

Hai test cache đỏ trước patch và test mask workload đỏ trước patch đều đã xanh. Test scissor mới ban đầu có lỗi ép kiểu dấu âm trên u32 trong fixture, đã sửa và chạy toàn GPU suite đạt. Probe fallback lần đầu chưa có thư mục output nên lỗi OS3 trước khi render; tạo đúng thư mục artifact rồi chạy lại đạt. Không che các lần fail này.

Log app tự có session/binary mới trong thời gian làm việc (host16652, SHA `66a029cf78c10564c3dec9c52b559f4fe1e8678b21bc6d0d74d5a5d5aaa85f86` lúc kiểm). Không ra lệnh khởi động/đóng/restart app. Các session mới chỉ có startup trong phần log được đọc, không dùng chúng làm bằng chứng zoom/pan đã nghiệm thu. Timestamp/hash EXE cũng không đủ chứng minh mọi source mới đã được nạp trong cửa sổ.

Kiểm headless dùng cùng policy/cache/Refiner với production; native surface, batch-credit scheduler và scan-out vẫn chưa đo end-to-end. Số14,612→6,396ms là một cặp ROI/kernel có fence, không phải lời cam kết60fps. Giữ pipeline PPE/FOGRA39 và byte parity ở những ca đã kiểm; không tuyên bố khớp Acrobat100% trên mọi PDF.
