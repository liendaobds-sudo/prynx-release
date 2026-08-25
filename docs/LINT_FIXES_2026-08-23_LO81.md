# Lint fixes 2026-08-23 — Lô 81

## Phạm vi

- `desktop/src/components/imposition-tools/shapeDetectionPolicy.ts`
- Mục tiêu: loại `@typescript-eslint/no-explicit-any` trong contract tham số khuôn theo trang, không đổi hình học hoặc chính sách bình tem.

## Thay đổi

- Thêm `ShapeParamsByPage = Record<number, Record<string, unknown>>`, khớp contract `detectedShapeParamsByPage` của imposition settings.
- Dùng contract này cho nhận diện một khuôn kế thừa và phép chiếu tham số từ trang nguồn sang thứ tự viewer.
- Narrow `inheritedFromPage` thành số nguyên trước khi thu master hoặc ánh xạ master sau reorder/duplicate.
- Giữ nguyên quy tắc: chỉ inheritance tường minh từ đúng một master mới được coi là một khuôn.

## Kết quả

- Giảm 3 lỗi lint: `680 -> 677`.
- Cảnh báo toàn kho giữ nguyên: `103`.

## Xác nhận

- `npx eslint src/components/imposition-tools/shapeDetectionPolicy.ts`: đạt.
- `npm run typecheck`: đạt.
- `npx vitest run src/components/imposition-tools/shapeDetectionPolicy.test.ts`: 20/20 test đạt.
- `git diff --check -- desktop/src/components/imposition-tools/shapeDetectionPolicy.ts`: đạt; chỉ có cảnh báo chuyển LF/CRLF của Git.
- `npm run lint:budget`: đạt (`677 errors`, `103 warnings`).

## Bất biến đã giữ

- Không thay đổi backend, PDFium, worker pool, cache hoặc scheduler.
- Không thay đổi lựa chọn một/nhiều khuôn, `one_dao`, khoảng cách cụm phụ, kích thước trang live, reorder hoặc duplicate.
- Giá trị `inheritedFromPage` dạng chuỗi vẫn không hợp lệ như trước vì `Number.isInteger('0')` vốn trả `false`.
