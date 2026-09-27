# Tái kiểm sau phản hồi “tệ hơn” — 27/09/2026

**Chưa nghiệm thu trải nghiệm thực tế.** Không dùng các test kernel/cache trước thay cho toàn vòng input → scene → surface. Chỉ đọc log và kiểm bằng code, không điều khiển máy.

## Baseline runtime mới

Host20492, EXE SHA256 `067158bbca0a876f424d68274d37a54fe107d06b061e7f84a6deb8901c06d520`; log `.tmp/render-diagnostics/PrynX_RenderPerf.log`, session bắt đầu L631417/epoch1790467234736. Phiên này có78 refinement, không còn vòng12×3 idle hàng phút. Điều đó chỉ xác nhận triệu chứng cache cũ không xuất hiện trong phiên này, không chứng minh viewer đã mượt.

### V27.R5 — CONFIRMED P1: IPC công cụ cắt ngang pan đang được capture

- L636035, epoch1790467340552: native down, tool Hand, space=true, pan=true, button1 tại(910,131).
- L636079, epoch1790467340567: IPC tool Pointer đến sau15ms.
- L636352, epoch1790467340896: up tại(809,575), nhưng dragging=false và last_pointer còn(909,149); camera chỉ đi(-1,+18) thay vì toàn delta(-101,+444).
- Ca khác L632509–632819 cũng bị cắt. Ca đối chứng L632923–634114 giữ dragging=true tới up và camera nhận pan.
- `useViewerHotkeys.ts` khôi phục tool khi WebView blur; `WM_LBUTTONDOWN` gọi SetFocus(HWND), có đường gây blur nội bộ. Nguồn blur là suy luận từ code và thứ tự log, không có event blur trực tiếp trong telemetry.
- Nguyên nhân đã xác nhận: `set_native_gpu_viewport_interaction` xóa `pan_button` và `controller.is_dragging` vô điều kiện khi nhận tool, kể cả pan đã bắt đầu và chưa mouse-up/capture-lost.

### V27.R6 — CONFIRMED P1: renderer cũ được gắn revision mới lúc load

- `load_native_gpu_scene` tăng `scene_revision` nhưng giữ `state.renderer` cũ; `render_viewport_frame` clone renderer đó và đóng dấu revision mới.
- L631772/epoch1790467317938: revision4 đã refine382draw (renderer trang1). Scene trang2/revision4 chỉ compile/ready tại L631776–631780/epoch1790467318626, sau **688ms**.
- Presenter reset theo revision, không identity renderer. Khi renderer trang2 được cài với cùng revision4, overview/detail trang1 có thể còn được dùng và nhận proof/cache-hit cho trang2.
- Không được chữa bằng tăng timeout hoặc nới content proof. Cần tách revision mong muốn khỏi revision renderer đã bind; không phát FrameRequest cho renderer chưa thuộc revision hiện hành.

## Phạm vi sửa hẹp

Đã sửa source trong một lô hẹp:

- `ViewportHostState::apply_interaction_tool` không xóa pan đang capture. Mouse-up/capture-lost/Escape/đổi scene vẫn kết thúc gesture; đổi tool ở trạng thái nghỉ không tự khởi động pan.
- Tách `renderer_revision` khỏi `scene_revision` mong muốn. `begin_scene_revision` hủy gesture/delta cũ; `install_renderer` chỉ commit đúng revision; `current_renderer` là gate dùng chung cho clamp/scroll/fit/metadata và tạo FrameRequest.
- FrameRequest mang revision **đã bind**, không lấy revision mong muốn để relabel renderer. Giữ tài nguyên cũ không đồng nghĩa được phát frame mới từ chúng.
- Command IPC và WM_PAINT gọi chính các method được test, không dùng model giả riêng. Thêm pan_button/dragging vào log tool để lần sau kiểm được thời điểm gesture bị mất quyền.
- Không sửa thuật toán mask/cache, ICC, DPI hoặc worker trong lượt này. Không rollback những sửa có bằng chứng đúng chỉ vì hiệu năng tổng thể vẫn chưa đạt.

## Verify vừa chạy

- Hai test R5/R6 **đỏ trước vá** trên logic production đã tách method, rồi xanh sau vá; ca thứ ba kiểm đổi scene xóa gesture/delta cũ và chặn stale commit.
- Ba test lifecycle headless đạt; toàn nhóm viewport có **57 pass /6 ignored**, bỏ rõ9 test HWND/visibility/input. `cargo check --offline --lib` đạt (cảnh báo dead-code, không compile error).
- Không mở cửa sổ test, không gửi input tới app đang dùng. Test tái hiện binding/capture state bằng method production và renderer GPU riêng; chưa replay trên native HWND sống.
- [Snapshot/hash/source và kết quả](audit/VIEWER_2026-09-27/input-scene-recheck.json), [log trích có số dòng](audit/VIEWER_2026-09-27/input-scene-recheck.evidence.log).
- PID20492 đã được Windows tái dùng sau một lần rebuild trong lúc làm. Công cụ lưu evidence đã khóa cả PID **và epoch1790467234736**, không gộp phiên cũ với binary mới. Lần xuất đầu bị assertion chặn do chọn nhầm phiên tái dùng; không xuất số đo sai.

## Khoảng trống còn lại

Trang3 trong cùng phiên có overview CPU encode **khoảng2,06 giây** và tuổi request đến submit xong **khoảng4,93 giây**, cùng UI long-task50–104ms ở một số thời điểm. Chưa phân bổ đầy đủ CPU/GPU batch/surface; hai sửa ownership không tự chứng minh các thời gian này đã giảm. Không tuyên bố “hết lag” từ input-to-present P95 nhỏ hoặc số test pass. R5/R6 đạt SOURCE+AUTO; nghiệm thu toàn trải nghiệm vẫn OPEN sau phản hồi người dùng.
