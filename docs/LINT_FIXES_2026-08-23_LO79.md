# Lint fixes 2026-08-23 — Lô 79

## Phạm vi

- `desktop/src/components/preprocess-tools/OfficeConvertTool.tsx`
- Mục tiêu: loại `@typescript-eslint/no-explicit-any` trong các luồng Office/Google/batch, không đổi endpoint, payload, request lifecycle hoặc quyền tính năng.

## Thay đổi

- Dùng ambient contract `window.__TAURI_INTERNALS__` và `File.path` đã khai báo toàn dự án thay cho cast `any`.
- Giữ fallback materialize file qua `prepareFileForUpload`; chỉ narrow phần tử tạo `Blob` thành `BlobPart`.
- Thêm formatter hẹp cho phần tử `detail` của lỗi validation FastAPI.
- Đổi năm nhánh `catch` sang `unknown`; helper `getErrorMessage` chỉ lấy message chuỗi hợp lệ và dùng thông báo dự phòng cũ cho dữ liệu bất thường.
- Giữ nguyên thứ tự kiểm `AbortError`, request-generation guard, job ID, `AbortSignal`, native result path, entitlement và callback `onFileFixed`.
- Không sửa hai dependency array đang có cảnh báo hook.

## Kết quả

- Giảm 16 lỗi lint: `705 -> 689`.
- Cảnh báo toàn kho giữ nguyên: `103`.

## Xác nhận

- `npx eslint src/components/preprocess-tools/OfficeConvertTool.tsx`: 0 lỗi, còn 2 cảnh báo hook có sẵn.
- `npm run typecheck`: đạt.
- `npx vitest run src/components/preprocess-tools/OfficeConvertTool.test.tsx`: 12/12 test đạt.
- `git diff --check -- desktop/src/components/preprocess-tools/OfficeConvertTool.tsx`: đạt.
- `npm run lint:budget`: đạt (`689 errors`, `103 warnings`).

## Rủi ro còn lại

- Component có nhiều tuyến vận chuyển file; suite hiện đã phủ native path, browser/Google, resize, batch, cancel/unmount và thay đổi entitlement nhưng chưa kiểm trực tiếp mọi biến thể payload lỗi validation.
- Hai cảnh báo dependency hook là nợ cũ nhạy với lifecycle chọn file; cần lô hành vi riêng, không gộp vào lô type-only này.
