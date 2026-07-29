# Nhật ký sửa lỗi điều hướng tab công cụ — 2026-07-28

Đối chiếu báo cáo: `BAO_CAO_AUDIT_DIEU_HUONG_TAB_CONG_CU_2026-07-28.md`.

## Lô 1 — PageTools (NAV.1)

- Mọi lệnh quản lý trang mang theo `tabId` của tab phát lệnh.
- `AcrobatViewer` chỉ nhận lệnh khi vừa đúng `tabId`, vừa là tab đang hiển thị.
- Bổ sung test khóa hợp đồng sự kiện theo tab.

Trạng thái kiểm thử: `typecheck` đạt; test PageTools `1/1` đạt.
## Lô 2 — Crop (NAV.2)

- Các sự kiện mở hộp thoại, chọn vùng và xem trước đều mang `tabId`.
- Canvas/hộp thoại chỉ nhận sự kiện của tab sở hữu; phím tắt canvas bị vô hiệu ở viewer nền.
- Enter/Escape của hộp thoại đang mở cũng bị bỏ qua khi tổ tiên tab mang trạng thái ẩn.

Trạng thái kiểm thử: `typecheck` đạt; test Crop + PageTools `14/14` đạt.
## Lô 3 — Sự kiện/cờ toàn cục (NAV.3, NAV.4, NAV.8, NAV.11)

- Xóa `window.__isBgRemoverActive`; file hệ thống chỉ chuyển vào Tách nền khi chính tab active được mở với intent Tách nền, event mang đúng `tabId`.
- Preview Tách nền/Upscale chỉ giữ phím Space khi tab active và con trỏ không nằm trong ô nhập liệu.
- Nút preset gọi thẳng store riêng của tab; xóa broadcast làm mọi tab mở modal.
- Refresh OCG, đổi visibility và refresh object mang scope tab; xóa singleton kết quả Preflight.

Trạng thái kiểm thử: `typecheck` đạt; các nhóm test liên quan đạt `54/54` (31 + 9 + 14 ở các lượt hẹp).
## Lô 4 — Hoàn tất VDP và tab kết quả (NAV.5, NAV.6)

- Data Merge, Nhảy số và Méc bìa chờ commit file thật sự xong rồi mới báo hoàn tất.
- Giữ nguyên panel VDP sau khi chạy để người dùng nhìn thấy trạng thái thành công; không tự rơi về menu công cụ.
- Tab kết quả không còn tự kế thừa `lockedMode` của tab cha; chỉ payload được caller gửi tường minh mới quyết định chế độ.

Trạng thái kiểm thử: `typecheck` đạt; test routing hiện có `13/13` đạt.
## Lô 5 — Recovery, capability và kiểm thử đa tab (NAV.7, NAV.9, NAV.10, NAV.12)

- Snapshot lưu `activeDashboardTool` hiện tại, không còn luôn lưu công cụ lúc tab mới mở.
- Store theo tab là nguồn trạng thái tool duy nhất; xóa state local song song trong dashboard.
- Capability không-PDF được khai báo chung cho đúng ba tool: Tách nền, Upscale, Office Convert. Encrypt/Metadata không còn vào workspace trắng.
- Thêm helper/test shell: tab chuyên dụng nền không nhận file, tab active đúng intent mới nhận, tab kết quả không kế thừa khóa ngầm.
- Kết quả sửa từ Output Preview gọi thẳng commit của tab; xóa event `preflight-fixed` không có consumer.

Trạng thái kiểm thử hẹp: `typecheck` đạt; routing/capability `15/15` và ma trận listener liên quan `47/47` đạt trước lượt tổng.
## Xác minh cuối

- `npm run typecheck`: đạt.
- Toàn bộ Vitest: `138/138` file test đạt; `1.196` test đạt, `2` test được skip theo cấu hình.
- `git diff --check` trên toàn bộ file của đợt sửa: đạt.
- Tìm lại các cơ chế cũ `__isBgRemoverActive`, `open-preset-modal`, `__preflightFixed*`, `preflight-fixed` và `prynx-office-source-file`: không còn trong mã desktop.

Kết luận: đã xử lý đủ NAV.1–NAV.12 trong phạm vi báo cáo audit; không còn blocker phát hành đã biết từ nhóm điều hướng tab/công cụ này.