# Lint fixes 2026-08-23 — Lô 78

## Phạm vi

- `desktop/src/components/flipbook/FlipbookDialog.tsx`
- Mục tiêu: loại `@typescript-eslint/no-explicit-any` trong luồng xem trước lật trang, không đổi nhánh native/web, thuật toán preload hoặc dependency của hook.

## Thay đổi

- Dùng `PDFDocumentProxy` chính thức của `pdfjs-dist` cho document và ref PDF.js.
- Khai báo contract hẹp cho file nguồn có `path` và metadata `widthPt`/`heightPt`/`allDims` đúng schema command Rust `get_pdf_metadata`.
- Dùng generic `invoke<PdfMetadata>` thay cho response `any`.
- Dùng `FlipbookPage`/`FlipbookBookData` cục bộ để giữ `_originalIndex` và `_userRotation` trong toàn bộ vòng đời lazy-load.
- Narrow `nativePath` theo runtime Tauri; giữ nguyên điều kiện truthy cũ và payload `buildTileUrl`.
- Không sửa hai cảnh báo `react-hooks/exhaustive-deps`, thứ tự tải trang tương tác/nền hoặc timeout 750 ms.

## Kết quả

- Giảm 19 lỗi lint: `724 -> 705`.
- Cảnh báo toàn kho giữ nguyên: `103`.

## Xác nhận

- `npx eslint src/components/flipbook/FlipbookDialog.tsx`: 0 lỗi, còn 2 cảnh báo hook có sẵn.
- `npm run typecheck`: đạt.
- `npx vitest run src/components/flipbook/FlipbookDialog.test.tsx`: 1/1 test đạt.
- `git diff --check -- desktop/src/components/flipbook/FlipbookDialog.tsx`: đạt; chỉ có cảnh báo chuyển LF/CRLF của Git.
- `npm run lint:budget`: đạt (`705 errors`, `103 warnings`).

## Rủi ro còn lại

- Test component hiện phủ nhánh native, metadata, tile URL và đóng–mở lại cùng PDF; nhánh render canvas bằng PDF.js chưa có test component trực tiếp.
- Hai cảnh báo dependency hook là nợ cũ nhạy với vòng tải lại; cần lô hành vi riêng nếu xử lý, không gộp vào lô type-only này.
