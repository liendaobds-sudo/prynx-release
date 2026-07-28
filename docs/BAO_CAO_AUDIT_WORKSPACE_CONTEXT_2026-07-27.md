# Báo cáo audit Workspace Context — 2026-07-27

## Phạm vi

Rà toàn bộ điểm gọi `useWorkspaceStore`, các nơi dựng `AcrobatViewer`, registry công cụ và cây Provider. Audit đọc-only, chưa sửa code.

## Tóm tắt

- Có 22 file runtime gọi trực tiếp `useWorkspaceStore`.
- `AcrobatViewer` chỉ được dựng ở hai luồng runtime: `ImpositionTab` và `PreflightTab`.
- `ImpositionTab` đã bọc đủ hai Provider theo từng tab.
- Chỉ `PreflightTab` chắc chắn thiếu Provider và gây crash sau khi chọn PDF.
- Không có bằng chứng các công cụ khuôn bế, so sánh PDF, ghép PDF hoặc các công cụ chạy qua `ImpositionTab` bị cùng lỗi.

## Phát hiện

### §WC.1 — P0/S: Preflight thiếu WorkspaceContext.Provider

**Bằng chứng**

- `desktop/src/components/PreflightTab.tsx:283` dựng `AcrobatViewer` trực tiếp.
- `desktop/src/components/AcrobatViewer.tsx:113` gọi `useWorkspaceStore`.
- `desktop/src/stores/useWorkspaceStore.ts:608` ném lỗi nếu không có Provider.
- `desktop/src/components/ImpositionTab.tsx:101` là nơi runtime duy nhất hiện bọc `WorkspaceContext.Provider`.

**Ảnh hưởng**

Chọn PDF trong công cụ Preflight chuyển sang workspace và làm sập cây React với mã lỗi người dùng đã cung cấp.

### §WC.2 — P0/S: Preflight còn thiếu ImposerSettingsContext.Provider

**Bằng chứng**

- `desktop/src/components/AcrobatViewer.tsx:141` gọi `useImposerSettingsStore`.
- `desktop/src/components/imposition-tools/useImposerSettingsStore.ts:87` cũng ném lỗi nếu thiếu Provider.
- `desktop/src/components/ImpositionTab.tsx:100` bọc Provider này; `PreflightTab` không bọc.

**Ảnh hưởng**

Nếu chỉ sửa §WC.1, Preflight sẽ văng lỗi Provider thứ hai ngay sau đó.

### §WC.3 — P1/M: Hợp đồng dữ liệu Preflight → AcrobatViewer đã lỗi thời

**Bằng chứng**

- `desktop/src/components/PreflightTab.tsx:284-285` truyền `pdfUrl` và `onToggleSidebar`.
- `desktop/src/components/AcrobatViewer.tsx:64-86` không khai báo hai prop này.
- `desktop/src/components/AcrobatViewer.tsx:92-114` đọc `file` và `pdfUrl` từ workspace store, không đọc từ prop.
- `PreflightTab.tsx` có `// @ts-nocheck`, nên TypeScript không chặn hợp đồng prop sai.

**Ảnh hưởng**

Sau khi thêm đủ Provider, nếu không đồng bộ `file/pdfUrl` vào store thì viewer vẫn không có tài liệu đúng để hiển thị và các thao tác crop/chỉnh sửa không có file nguồn.

### §WC.4 — P1/S: Không có test hồi quy cho chuyển pha Preflight upload → workspace

**Bằng chứng**

Không tìm thấy test nào mount `PreflightTab`, chọn file rồi xác nhận `AcrobatViewer` render trong đủ Provider. Các test hook viewer hiện có đều tự bọc Provider đúng nên không bắt được luồng standalone này.

## Những luồng đã loại trừ

- Tất cả công cụ `ImpositionTab`: bình bài, N-up, tem bế, CNC, VDP, Watermark, Optimize, PDF/X, mã hóa, metadata, Output Preview và các panel Acrobat đều nằm dưới cả hai Provider tại `ImpositionTab.tsx:99-105`.
- Khuôn bế bao bì dùng `DielineTool`, không gọi workspace store.
- Ghép PDF, so sánh PDF và so sánh văn bản dùng component độc lập, không gọi workspace store.
- `pdfWarmup` chỉ import trước module, không render component nên không kích hoạt hook.

## Đề xuất sửa theo lô

### Lô 1 — Khôi phục Preflight (ưu tiên)

1. Tạo workspace store và imposer settings store riêng cho mỗi tab Preflight.
2. Bọc `PreflightTabInner` bằng cả hai Provider, giống hợp đồng của `ImpositionTab`.
3. Đồng bộ `file`, `pdfUrl`, trạng thái sidebar và reset vào workspace store; bỏ hai prop viewer đã lỗi thời.
4. Thêm integration test: upload → workspace không crash và viewer nhận đúng file/URL.

Phạm vi dự kiến 2–3 file, chưa cần thay đổi backend.

### Lô 2 — Siết hợp đồng (sau khi Lô 1 chạy thật đạt)

Giảm dần phạm vi `@ts-nocheck` của `PreflightTab` để TypeScript chặn prop drift trong tương lai; xử lý riêng nếu bật typecheck làm lộ thêm nợ kiểu cũ.

## Trạng thái

Đã được người dùng duyệt và đã sửa theo các lô nhỏ có kiểm thử.

## Bổ sung §WC.5 — P1/M: Preflight có hai đường mở tạo hai menu khác nhau

**Bằng chứng**

- Shortcut Preflight trong toolRegistry.ts từng dựng PreflightTab độc lập.
- Sau khi mở PDF, menu Preflight lại chạy qua ImpositionTab → PreprocessingRouter → PreflightTool.
- Vì vậy thứ tự thao tác quyết định component và menu người dùng nhận được.

**Rà soát công cụ tương tự**

Đã đối chiếu toàn bộ shortcut có focusFeature với PREPROCESS_ROUTER_TOOLS. Chỉ Preflight dùng component riêng trong khi đã có route tích hợp. Các shortcut tiền xử lý còn lại đều dùng ImpositionTab; các ứng dụng độc lập như So sánh PDF, Ghép PDF và Khuôn hộp không đồng thời có route thứ hai trong workspace nên không cùng lỗi.

**Kết luận**

Hợp nhất Preflight vào ImpositionTab, truyền focusFeature: preflight, và dùng một hàm nhận diện họ workspace chung tại cả registry lẫn App.
