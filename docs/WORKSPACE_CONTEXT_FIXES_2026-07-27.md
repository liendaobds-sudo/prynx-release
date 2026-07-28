# Nhật ký sửa Workspace Context — 2026-07-27

## Lô 1 — Khôi phục workspace Preflight

### §WC.1 + §WC.2 — Bổ sung đủ Provider

- `desktop/src/components/PreflightTab.tsx`
  - Tách root `PreflightTab` và phần nội dung `PreflightTabInner`.
  - Mỗi tab Preflight sở hữu một `WorkspaceStore` và một `ImposerSettingsStore` riêng.
  - Bọc nội dung bằng `WorkspaceContext.Provider` và `ImposerSettingsContext.Provider`, đúng hợp đồng của `AcrobatViewer`.

### §WC.3 — Đồng bộ lại hợp đồng dữ liệu viewer

- Chuyển `file`, `pdfUrl` và trạng thái sidebar sang workspace store mà `AcrobatViewer` thực sự đọc.
- Bỏ hai prop cũ `pdfUrl` và `onToggleSidebar` khỏi lời gọi viewer.
- Truyền `isActive` và `tabId` để lệnh viewer chỉ tác động đúng tab Preflight đang hoạt động.

### §WC.4 — Test chống tái phát

- `desktop/src/components/__tests__/PreflightTab.provider.test.tsx`
  - Mô phỏng chọn PDF và chuyển từ màn hình tải file sang workspace.
  - Xác nhận viewer render được trong cả hai Provider.
  - Xác nhận viewer nhận đúng tên file, blob URL, trạng thái tab và store thiết lập mặc định.

## Verify

- `npm.cmd run typecheck`: đạt.
- `PreflightTab.provider.test.tsx`: 1/1 đạt.
- Lint file test mới: đạt.
- `git diff --check` phạm vi Lô 1: đạt.

Chưa thay đổi backend hoặc nghiệp vụ kiểm tra/sửa lỗi PDF.

## Lô 2 — Hợp nhất đường mở Preflight

### §WC.5 — Xóa chênh lệch menu theo thứ tự mở file

- toolRegistry.ts: shortcut Preflight dùng ImpositionTab và tự chọn focusFeature: preflight; bỏ lazy route tới component Preflight độc lập.
- App.tsx: nhận diện Preflight là thành viên workspace chung để truyền đủ file, report, feature và trạng thái tab.
- toolRegistry.routing.test.ts: khóa ba bất biến:
  - Preflight dùng đúng component và menu tích hợp.
  - Mọi shortcut tới PreprocessingRouter dùng workspace chung.
  - Không thành viên nào của họ Imposition bị tách sang component riêng.

### Kết quả rà các tool khác

Không phát hiện tool nào khác bị cùng lỗi hai component/hai menu. Các shortcut tiền xử lý hiện đều hội tụ vào ImpositionTab; các app độc lập không có route tích hợp trùng.

## Verify Lô 2

- npm.cmd run typecheck: đạt.
- Ba file test routing/provider/panel: 16/16 đạt.
- ESLint file test mới: đạt.
- git diff --check phạm vi Lô 2: đạt.
