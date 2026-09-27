# Sửa ảnh không nét, zoom nhảy và lệnh view native — 27/09/2026

Phản hồi người dùng: “vẫn … nét … zoom … giật vị trí … ko chuyển view”. Tiếp tục phạm vi sửa đã duyệt; không điều khiển ứng dụng hay gửi input toàn máy. Các test trước chưa đủ vì chỉ kiểm texture ROI và tiến triển scheduler, không kiểm pixel cuối cùng cùng quyền sở hữu camera.

## Nguyên nhân và bản sửa

| Mã | Bằng chứng trước sửa | Sửa theo hợp đồng |
|---|---|---|
| R8.1 — frame cũ che frame mới | GPU test thật: cấp cả frame cũ1,5× và frame mới đúng camera1×; RGBA lệch3.960byte, BGRA sRGB lệch3.911byte so với render mới, trong khi exact-only lệch0 | Raster đúng lưới camera được vẽ sau lớp đã resample. Full raster đúng lưới che toàn viewport thì bỏ draw các lớp thấp hơn, không xóa/cap cache |
| R8.2 — cache-hit không đồng nghĩa nét | Hai test cache đỏ: density0,952 của zoom1,05 vẫn được báo hoàn tất; pan0,25/0,5 được tái dùng như ảnh đã nét | Chỉ cùng hệ số tuyến tính và offset pixel nguyên mới chứng minh lưới đã nét. Lớp cũ vẫn dùng tạm để tương tác; thiếu lưới thì dựng lại. Không dùng epsilon để giấu khe |
| R8.3 — gom zoom làm mất neo/thứ tự |7test đỏ: neo di chuyển lệch43,125px; inverse zoom làm mất100px; pan-before-zoom bị đảo; chạm max rồi zoom lại cho60 thay vì32 | Giữ thứ tự gesture, chỉ gộp pan kề nhau; từng zoom vẫn qua controller và giới hạn zoom riêng. Không cap/bỏ input |
| R8.4 — clamp kéo mất điểm neo | Ca viewport1812×865, zoom1,887, pan29,146, cursor1438: điểm PDF746,61053 bị đổi thành670,0307 sau zoom+clamp (~166px màn hình) | Camera pan/zoom chỉ bị chặn khi sắp mất toàn bộ trang; giữ dải tối thiểu16DIP. Wheel cuộn/lật trang giữ biên riêng. Đây là thay đổi chủ đích về phạm vi pan, không xóa hết guard |
| R8.5 — Fit và ACK tranh quyền | Log host20552/epoch1790472032172: ACK fit1,427 tự làm smart→custom dù chưa wheel. Replay callback thực: ACKzoom2 tới sau eventzoom3 kéo state về2 | Camera có version riêng, độc lập scene revision; ACK cũ bị loại. Event có userInitiatedZoom; chỉ zoom tay đổi custom. Fit/scene/resize giữ mode; cùng version/f32 tương đương không gây churn hoặc mất ý định |
| R8.6 — Smart Fit sai hiệu chuẩn | UI Smart cap100%; native lại fit lênUI111,7% | Truyền maxZoom tương ứng100% đã hiệu chuẩn, chỉ cho Smart. Fit Page không bị cap này; refit khi extent/DPR/hiệu chuẩn đổi, không refit chỉ vì pan |
| R8.7 — native focus nuốt lệnh view | Click đưa focus vào HWND; Ctrl2/PageUp/PageDown/Home/End rơi xuống DefWindowProc. Ctrl1 tự gánnative1 khác100%UI | Map9lệnh xem/zoom/trang về shell hiện hữu qua event có lease/revision; allowlist bênTS, chuyển ngay từng event, chặn tabẩn/occluded/stale. Không đổi Copy/Space/Escape |

Điểm cần tách bạch: log mới chỉ chứng minh Ctrl-wheel và pan, không ghi người dùng bấm dropdown layout hay phím cụ thể. Không lấy “không có page transition” làm bằng chứng dropdown bị chặn. Bridge phím được xác minh bằng code; tác động lên giao diện đang mở chưa nghiệm thu.

## Pixel cuối, không chỉ texture trung gian

- Compositor đối chứng RGBA và **Bgra8UnormSrgb đúng loại surface native**: old+exact sau sửa đều0byte khác; crop mới không xóa vùng cũ ngoài crop.
- Ca pan poster lớn~−70.068px làm phép nghịch đảo f32 tự làm mờ frame trên chính nó:694byteRGBA/max2,461byteBGRA/max20. Khi đã chứng minh cùng lưới, dùng identity+offset nguyên trực tiếp:0byte khác, không đổi shader/ICC.
- Hai PDF thật, trang1: file outline user đưa và bản chưa outline trên Desktop. Mỗi file kiểm2format ×32camera/DPR: **128 camera,0byte ROI khác và0byte pixel sau compositor khác ảnh render mới**. Mỗi lượt32camera có20refinement,0recovery và3.840kiểm idle.
- Artifact: `audit/VIEWER_2026-09-27/r8-desktop-rgba.json`, `r8-desktop-bgra.json`, `r8-outline-rgba.json`, `r8-outline-bgra.json`.
- Probe Presenter thật trên surface riêng luônẩn, fixture outline: sau120camera liên tục, chờ đủ nét cuối47,192ms ở lượt này;150ms idle không tăng frame, lỗi GPU owned-context được báo không cần input. Đây là một mẫu, không phải scan-out/FPS hoặc cam kết mọi PDF. [Kết quả](audit/VIEWER_2026-09-27/r8-presenter-outline/result.json).

## Verify

- GPU:56pass/5ignored; test ảnh cuối đỏ→xanh. Một full-suite invocation thoát bất thường giữa output; isolated retry và full rerun đều đạt, không giấu sự cố.
- Native viewport:78pass/7ignored, không chạy9test UI/input trên HWND. Các test thuần camera/scheduler, provenance, Smart cap, cache và pixel cuối đạt.
- Frontend toàn bộ:341file,3.940pass/2skip; targeted camera/keyboard111pass; typecheck đạt. jsdom vẫn in cảnh báo canvas getContext của ca fallback cũ, assertion không fail.
- Cargo check lib/examples đạt. EXE thật đã build thành công2lượt, lượt sau0,54s; SHA256 `e5cbc444ca6f4a9040234712c36d15926d687c1aa2e73140a06eb112e12f854f`. Không chỉ dừng ở cargo check.
- [Manifest source/test/pixel/build](audit/VIEWER_2026-09-27/r8-fixes-results.json), [script xác minh](audit/VIEWER_2026-09-27/summarize_r8_fixes.py).
- Không đổi golden, ICC, shader, backend Python, worker cap hoặc Cargo profile. Giữ thay đổi không liên quan trong worktree.

## Giới hạn

Độ phủ SOURCE + AUTO + ARTIFACT/pixel và surface native ẩn; chưa replay click/keyboard trên cửa sổ người dùng, chưa đo scan-out hay khẳng định60fps/Acrobat. Handoff pan native→DOM khi đổi layout và repeated page commands trong cùng một React batch chưa được nghiệm thu trong lượt này. Không gộp các khoảng trống đó thành claim “mọi chế độ view đã hoàn hảo”.
