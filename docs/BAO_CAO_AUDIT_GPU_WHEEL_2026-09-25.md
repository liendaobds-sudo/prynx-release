# R25.GPU.32 — Cuộn trang trên viewport GPU

User báo: “cuộn trang giật giật, không cuộn được sang trang tiếp theo” sau R31.
Phạm vi: sửa hồi quy UX của nhánh native trong công việc nâng cấp đã được yêu cầu.

## Bằng chứng trước sửa

- P1: `desktop/src-tauri/src/viewport/win32_host.rs`, WM_MOUSEWHEEL chỉ gọi accumulate_pan; không có sự kiện chuyển trang. Native HWND không đi qua DOM wheel của Viewer.
- P1: cùng handler đổi mọi delta thành ±50 DIP, kể cả delta = 1; Ctrl/Space wheel luôn đổi zoom 15% bất kể độ lớn delta.
- P1: `controller.rs::pan` không có biên trang. Ở single_fit, trang nhỏ hơn viewport vẫn bị đẩy vào nền xám.
- `useViewerZoom.ts` đã có điều hướng tại biên bằng `wheelPageNav.ts`, chống quán tính 250 ms và tích lũy delta nhỏ. Cần dùng chung logic này và giữ state trên Viewer khi container native đổi key theo trang.

## Bản vá và tiêu chí

Lô native (3 file): giữ delta lẻ, dùng thiết lập cuộn Windows, giới hạn wheel theo kích thước trang thực (Rotate/UserUnit/DPR), phát sự kiện biên trang có revision qua callback hiện có. Không thay đổi kéo bằng bàn tay.

Lô frontend (5 file): nối sự kiện trực tiếp vào reducer điều hướng hiện hữu; không qua React setState làm mất delta; giữ chặn tab ẩn, lease/revision cũ. Kiểm cả đường DOM cũ.

Kiểm chứng: baseline test lỗi trước sửa; SendMessageW vào HWND thật cho delta nhỏ/Ctrl/cuộn thường; biên trang lớn và trang vừa khung; tích lũy wheel, chuyển trang, quán tính sau remount, sự kiện cũ/ẩn; typecheck và test liên quan. Soạn/test ở staging khi app còn mở, áp dụng và build native sau khi user lưu và dừng dev.

## Kết quả R32

- Baseline đỏ qua `SendMessageW` vào HWND thật: `delta=1 gave zoom=1.15`; một delta 1/120 nấc bị coi là cả nấc.
- Đã giữ delta lẻ cho zoom/cuộn; cuộn theo thiết lập Windows; chiều ngang phần cứng theo chiều phải. Wheel giới hạn theo trang, giữ kéo bàn tay hiện hành. Không yêu cầu frame nếu camera không thay đổi.
- Native báo biên trước khi áp dụng delta để không lật ngay trong lần vừa chạm đáy. Biên dùng kích thước sau Rotate/UserUnit, viewport đổi physical pixel về DIP.
- Nối sự kiện qua lease/revision hiện hữu tới callback trực tiếp; `useViewerZoom` giữ reducer/cooldown chung cho DOM và native, tồn tại qua đổi key trang. Tab ẩn/đóng, revision cũ và popup không nhận chuyển trang.
- Thêm `wheel-page-navigation` vào log Viewer hiện hữu để đối chiếu trang trước/trang đích và biên trong lượt thử tiếp theo.
- 37 test native đạt, 4 test worker/benchmark chuyên biệt vẫn ignored theo mặc định; 48 test frontend/4 file đạt trên source thật đã áp dụng. Lint 4 file frontend sửa đạt; không tuyên bố toàn Viewer sạch lint. Build và typecheck cuối được lưu riêng trong bộ bằng chứng.

Source đã áp dụng sau khi kiểm tra không còn PrynX/cargo/Vite chạy. Sao lưu, patch, hash trước/sau và log: `.tmp/gpu-wheel-navigation-2026-09-25/`. Kết quả cuối: `verification.json` (chỉ được tạo khi build/typecheck/test và hash đều đạt).

Chưa xác minh thao tác thực tế của user. Ca kiểm tay: chạy `run_dev.bat`, mở PDF đang thử ở single_fit, cuộn xuống từ trang 1 sang 2 rồi lên lại; zoom lớn, cuộn trong trang và vượt biên; vuốt nhẹ/đảo chiều; Ctrl+wheel; so lại khi tắt GPU. Độ trễ chuẩn bị scene trang nặng vẫn là giới hạn đã ghi ở R31, không coi R32 đã giải quyết.
