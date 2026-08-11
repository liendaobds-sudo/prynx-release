# Sửa luồng In theo phạm vi trang — 2026-08-11

Tài liệu này chốt các lô sửa sau `BAO_CAO_AUDIT_IN_THEO_PHAM_VI_TRANG_2026-08-11.md`.

Phạm vi: trang đang xem/thumbnail đang chọn trong workspace → hộp **In** → preview → TypeScript IPC → worker cách ly → Rust/PDFium/GDI.

## Kết quả nghiệp vụ

- Ô **Trang cụ thể** nhận cú pháp `27-28,30-33` và tạo đúng danh sách `27, 28, 30, 31, 32, 33`.
- Có thể xóa sạch ô rồi gõ lại; state rỗng không còn bị ép tức thì về `1`.
- Token sai hoặc trang ngoài biên được báo lỗi và khóa nút In trước khi tạo job.
- **Trang hiện tại** nhận đúng trang workspace đang xem, kể cả sau khi PDF.js load preview xong.
- Hộp In có lựa chọn **Các trang đang chọn** khi Viewer cung cấp snapshot thumbnail.
- Preview, direct-print và Windows fallback cùng nhận một danh sách canonical; không hạ về min/max làm lọt trang 29.
- Danh sách explicit đi nguyên qua Tauri command, worker JSON và Rust. Rust validate fail-closed trước `StartDocW`, sau đó mới áp lẻ/chẵn và đảo thứ tự.

## Lô 1 — Hợp đồng native `pages`

Các file chính:

- `desktop/src/lib/nativePrint.ts`
- `desktop/src-tauri/src/pdf_engine/print_worker.rs`
- `desktop/src-tauri/src/pdf_engine/print.rs`
- `desktop/src-tauri/src/pdf_engine/print_layout.rs`

Thay đổi:

- Thêm `pages?: number[] | null` ở TypeScript và `Option<Vec<i32>>` ở Tauri/worker.
- Cả direct-print và `PrintDlgW` fallback đều bảo toàn danh sách rời rạc.
- `resolve_page_numbers()` giữ đúng gap/thứ tự, validate toàn bộ trang trước khi gửi job, rồi áp subset/reverse.
- Đường cũ chỉ có `from/to` vẫn giữ nguyên hành vi.

Verify:

- `rustfmt --check`: đạt.
- `rustc --test print_layout.rs`: **7/7 đạt**, gồm explicit list, even+reverse, danh sách rỗng và trang ngoài biên.
- `cargo check --lib` bằng target tạm độc lập: đạt; 7 warning dead-code có sẵn ở module khác. Target tạm đã được xác minh nằm trong `%TEMP%` và dọn sau kiểm tra.
- `cargo check` trên target dev mặc định vẫn bị `bin/pdfium.dll` do app/dev process giữ (`os error 32`); không dừng tiến trình của người dùng.

## Lô 2 — Parser và i18n

Các file:

- `desktop/src/lib/printPageSelection.ts`
- `desktop/src/lib/printPageSelection.test.ts`
- `desktop/src/i18n/locales/vi.json`
- `desktop/src/i18n/locales/en.json`

Quy ước đã khóa:

- Nhận dấu `-`, `–`, `—` và khoảng trắng.
- Range đảo chiều được chuẩn hóa tăng dần; checkbox **Đảo thứ tự** là nguồn điều khiển thứ tự đảo toàn job.
- Trang trùng chỉ giữ lần đầu để tránh in lặp ngoài ý muốn; số bản dùng trường **Số bản**.
- Trang ngoài `1..numPages` không bị tự kẹp.
- Snapshot thumbnail 0-based được sort theo vị trí đang hiển thị rồi đổi sang trang 1-based.

Verify: parser/formatter/mapping/subset **6/6 đạt**; JSON Việt/Anh parse hợp lệ.

## Lô 3 — Hộp In và hook

Các file:

- `desktop/src/components/shared/PrintDialog.tsx`
- `desktop/src/components/shared/usePrintDialog.tsx`
- `desktop/src/components/shared/usePrintDialog.test.tsx`

Thay đổi:

- Thay hai ô number Từ–Đến bằng một ô text **Trang cụ thể**.
- Giữ `rangeText` dạng chuỗi để người dùng có thể để rỗng tạm thời trong lúc sửa.
- `basePageList` là nguồn duy nhất; preview áp subset/reverse từ đó, payload native gửi danh sách gốc cùng cùng tùy chọn subset/reverse.
- `initialPage` và `selectedPages` đi qua `PrintRequest` tới dialog.
- PDF.js load thành công không còn reset `previewPage` về 1.
- Nút In và fallback bị khóa nếu danh sách lỗi/rỗng hoặc subset loại hết mọi trang.

Regression khóa trực tiếp:

- xóa ô rồi nhập `27-28,30-33`;
- payload direct đúng sáu trang;
- current page = 27 kể cả sau PDF.js load;
- selected thumbnail đúng sáu trang;
- Windows fallback vẫn giữ explicit list.

## Lô 4 — Snapshot theo tab và biên invoke

Các file:

- `desktop/src/stores/useWorkspaceStore.ts`
- `desktop/src/components/AcrobatViewer.tsx`
- `desktop/src/components/ImpositionTab.tsx`
- `desktop/src/stores/printSelectionSnapshot.test.ts`
- `desktop/src/lib/nativePrint.test.ts`

Thay đổi:

- Selection được lưu trong Workspace store riêng của mỗi tab, không đưa vào shell global.
- Viewer chỉ subscribe setter ổn định; cập nhật snapshot không làm component cha `ImpositionTab` subscribe/re-render theo mỗi lần cuộn.
- Handler In đọc snapshot mới nhất bằng `store.getState()` ngay trước khi mở dialog.
- `viewerActivePage` và index selection đều được chuẩn hóa theo vị trí của PDF sau bake.
- Test invoke khóa trường `pages` ở cả `print_pdf_direct` và `print_pdf`.

## Verify cuối

- Frontend targeted: **5 file / 23 test đạt**.
- TypeScript `npm run typecheck`: đạt.
- ESLint cho helper/nativePrint/dialog/hook và test mới: đạt, 0 lỗi.
- ESLint trực tiếp ba file legacy lớn (`AcrobatViewer`, `ImpositionTab`, `useWorkspaceStore`) vẫn báo backlog có sẵn; không mở rộng phạm vi để sửa 221 lỗi/warning lịch sử.
- Frontend toàn bộ: **232/233 file đạt; 2.266 test đạt, 2 skip; 1 test OutputPreviewLayout timeout ở 5 giây** khi chạy song song. Chạy lại riêng đúng test timeout: **1/1 đạt** trong 0,581 giây, nên được phân loại là contention của full run, không phải hồi quy luồng In.
- Không cập nhật snapshot/golden.

## Bằng chứng còn mở

- Chưa chạy lại thao tác trên Tauri UI sau native rebuild/restart.
- Chưa tạo artifact Microsoft Print to PDF ≥40 trang để fingerprint đúng sáu trang và chứng minh trang 29 không xuất hiện.
- Chưa smoke máy in vật lý.

Trạng thái hiện tại: **`AUTO`** cho contract/parser/UI/IPC/Rust helper; runtime/app/artifact còn mở.
