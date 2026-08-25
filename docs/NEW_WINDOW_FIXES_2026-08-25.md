# NEW WINDOW — NHẬT KÝ TRIỂN KHAI 2026-08-25

## 1. Phạm vi đã duyệt

Triển khai V1 an toàn theo `BAO_CAO_AUDIT_NEW_WINDOW_2026-08-25.md`:

- `Cửa sổ mới` tạo một cửa sổ native độc lập từ PDF đang hoạt động.
- Cửa sổ mới nhận đúng working revision hiện tại, gồm sửa đối tượng đã commit và thay đổi thứ tự/xóa/nhân bản/xoay trang.
- Khởi tạo cùng trang, zoom, fit mode và layout; sau đó mỗi cửa sổ cuộn/zoom độc lập.
- Child chỉ Save As, không ghi đè file khách hoặc snapshot do PrynX sở hữu.
- Child không sở hữu Open With/startup queue, updater hoặc recovery toàn cục.
- Chưa đồng bộ edit/undo hai chiều giữa các cửa sổ; đây là giai đoạn coordinator riêng.

## 2. Lô A — Registry native và capability

### File

- `desktop/src-tauri/src/document_window_registry.rs`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/capabilities/default.json`
- `desktop/src-tauri/capabilities/document-window.json`

### Thay đổi

- Thêm registry trong RAM cho `document-*`, label/nonce ngẫu nhiên CSPRNG và bootstrap one-shot ràng buộc đúng caller label.
- Validate session/title/view state; canonicalize nguồn, chặn symlink, UNC/device path, đường dẫn nhạy cảm và file không có PDF header.
- Copy snapshot trong `spawn_blocking` vào app cache; tạo cửa sổ ở trạng thái ẩn và chỉ hiện sau bootstrap hợp lệ.
- Allowlist navigation về origin PrynX, chặn popup, tắt browser accelerator/context menu/devtools theo build mode.
- Dọn snapshot khi tạo cửa sổ lỗi, child bị destroy, pending hết hạn hoặc app khởi động lại sau crash.
- Tách capability `document-*` tối thiểu: window controls và Save dialog; capability mặc định chỉ còn áp cho `main`.

## 3. Lô B — Working revision, viewport và Save As

### File

- `desktop/src/lib/documentWindow.ts`
- `desktop/src/main.tsx`
- `desktop/src/App.tsx`
- `desktop/src/components/ImpositionTab.tsx`
- `desktop/src/components/AcrobatViewer.tsx`
- `desktop/src/lib/toolRegistry.ts`
- `desktop/src/i18n/locales/vi.json`
- `desktop/src/i18n/locales/en.json`

### Thay đổi

- Lấy bootstrap trước khi mount React; bootstrap child lỗi thì destroy cửa sổ ẩn để native dọn snapshot.
- Active tab đăng ký facade `prepareNewWindow`; facade chụp viewport trước mọi `await`, commit edit-session nếu dirty, xác minh working path đã publish rồi đọc lại file từ store của đúng tab.
- Dùng `useWorkingPdf(freshFile)` để bake thứ tự/xóa/nhân bản/xoay; lỗi bake fail-closed, không rơi về file gốc.
- Materialize file qua path staging trong TEMP, không đưa byte PDF lớn vào JSON IPC.
- Child bỏ splash/login/updater/startup integration/recovery scan; mở trực tiếp snapshot path-backed và không thêm Recent.
- Child ép mọi đường Save thành Save As và không xóa recovery toàn cục.
- View seed chỉ chạy sau loader `ready`; callback hoàn tất được schedule bằng rAF và timer song song để cửa sổ Tauri ẩn không deadlock. Scroll pending được retry bằng layout effect sau khi Virtuoso dựng row.
- Menu child fail-closed: không New/Open/Recent/Tools/Print/external Help/Settings; callback tạo tab bị bỏ, hotkey bị chặn; `Ctrl+W` đóng đúng cửa sổ. `Cửa sổ mới` vẫn được giữ để tạo cửa sổ thứ ba từ revision của child.
- Thêm i18n Việt/Anh cho nhãn và lỗi `Cửa sổ mới`.

## 4. Lô C — Cô lập nhiều WebView

### File

- `desktop/src/hooks/viewer/usePdfLoader.ts`
- `desktop/src/components/imposition-tools/store/persist.ts`

### Thay đổi

- Owner native PDF/tile cache đổi thành `pdf-loader:<WebView UUID>:<counter>`; module counter không còn va chạm khi mỗi WebView đều bắt đầu từ 1.
- Cờ GC scoped persist chuyển từ `sessionStorage` sang `localStorage`, cùng miền với dữ liệu bị quét; cờ được đặt trước khi xóa stale keys để child không chạy GC lại và xóa state main.

## 5. Verify tự động

- `npm run typecheck`: đạt.
- ESLint hẹp trên các file frontend New Window: đạt, 0 lỗi/0 warning.
- Vitest hẹp (`App.windowRestore`, `App.recoveryEntitlement`, `MenuBar`, `i18nCatalog`, `usePdfLoader`): **5 file / 33 test đạt**.
- `cargo test document_window_registry`: **5/5 test đạt**.
- `cargo check`: đạt; còn 8 warning `dead_code` có sẵn, ngoài phạm vi New Window.
- `rustfmt --edition 2021 --check src/document_window_registry.rs`: đạt.
- `git diff --check` trên các file New Window: đạt; chỉ có cảnh báo line-ending LF/CRLF của working tree.

## 6. Kiểm tay Windows còn bắt buộc

Chưa tuyên bố đạt runtime cho đến khi chạy app thật và kiểm:

1. Trim & Shift/sửa đối tượng/xóa/xoay/sắp trang chưa lưu → `Cửa sổ > Cửa sổ mới` mở đúng revision.
2. Child hiện đúng trang/zoom/layout ban đầu; hai viewport sau đó độc lập.
3. Tạo cửa sổ thứ ba; taskbar/minimize/maximize/close hoạt động độc lập.
4. `Ctrl+S`, File > Lưu và Save modal của child đều mở Save As.
5. Open With khi main + child cùng sống chỉ đến main; đóng child không xóa recovery/persist của main.
6. Thử PDF nhỏ, PDF lớn, file ở ổ D và file từ backend/in-memory.

## 7. Giới hạn và residual risk của V1

- Đây là snapshot độc lập, không phải hai view dùng chung document authority. Edit/undo/dirty state không đồng bộ tức thì giữa các cửa sổ.
- Chưa renumber hậu tố `:1…:N` khi đóng cửa sổ; số mới luôn duy nhất trong document session.
- Đường staging hiện copy disk → TEMP → app-cache để bảo đảm mọi nguồn hợp lệ đi qua cùng biên `fs_scope`. PDF lớn chịu thêm một lượt I/O; chỉ tối ưu fast-path sau khi có test retry cho file ngoài Documents/Downloads/Desktop và không làm yếu path capability.
- Review bảo mật mới đạt mức tĩnh + unit test cục bộ. Proof gap còn lại là WebView2/runtime Windows, file trên nhiều volume/NAS và hành vi release artifact thật.
