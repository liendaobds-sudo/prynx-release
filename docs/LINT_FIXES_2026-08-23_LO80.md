# Lint fixes 2026-08-23 — Lô 80

## Phạm vi

- `desktop/src/components/CombineTab.tsx`
- Mục tiêu: loại `@typescript-eslint/no-explicit-any` trong UI ghép PDF, không đổi transport, delegate, interleave, grouping hoặc hook lifecycle.

## Thay đổi

- Dùng `PDFPage[][]` chính thức của `pdf-lib` cho cache trang đã copy khi dán xen.
- Dùng ambient `window.__TAURI_INTERNALS__` và `File.path` cho thumbnail file native.
- Thu hẹp payload mở tab thành `Record<string, unknown>`; payload `{ initialFeature: 'view' }` giữ nguyên.
- Khai báo detail của sự kiện in bằng `CustomEvent<TriggerPrintDetail>`.
- Đặt tên union `CombineScaleMode` cho ba chế độ khổ giấy.
- Đổi hai nhánh `catch` sang `unknown` và chuẩn hóa message chuỗi mà không đổi luồng toast.
- Không sửa bốn dependency array đang có cảnh báo hook.

## Kết quả

- Giảm 9 lỗi lint: `689 -> 680`.
- Cảnh báo toàn kho giữ nguyên: `103`.

## Xác nhận

- `npx eslint src/components/CombineTab.tsx`: 0 lỗi, còn 4 cảnh báo hook có sẵn.
- `npm run typecheck`: đạt.
- Bốn suite `combineTransport`, `combineGroupBySize`, `combineDelegation`, `combineAssembly`: 62/62 test đạt.
- `git diff --check -- desktop/src/components/CombineTab.tsx`: đạt.
- `npm run lint:budget`: đạt (`680 errors`, `103 warnings`).

## Rủi ro còn lại

- `CombineTab` chưa có test component riêng cho sự kiện `app-trigger-print` và select `scaleMode`; contract transport/assembly liên quan đã được phủ bởi bốn suite hiện có.
- Bốn cảnh báo dependency hook là nợ cũ nhạy với vòng ghép và đo kích thước; cần lô hành vi riêng, không gộp vào lô type-only này.
