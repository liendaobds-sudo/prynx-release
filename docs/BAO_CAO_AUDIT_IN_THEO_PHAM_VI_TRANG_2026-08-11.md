# Báo cáo audit In theo phạm vi trang — 2026-08-11

## 1. Phạm vi và kết luận điều hành

Audit unit: `W7-U07` — người dùng đang xem/chọn trang trong workspace → mở hộp thoại **In** → chọn tất cả, trang hiện tại hoặc danh sách trang → xem trước → TypeScript IPC → worker cách ly → PDFium/GDI in đúng các trang đã chọn.

Ví dụ nghiệp vụ bắt buộc: tài liệu có ít nhất 40 trang, người dùng nhập `27-28,30-33`; kết quả phải chỉ gồm các trang `27, 28, 30, 31, 32, 33`, tuyệt đối không có trang 29.

Không thuộc phạm vi đợt này: vòng đời spooler/driver, output path của máy in PDF, progress/cancel và mixed-size preview đã được audit/sửa trong `BAO_CAO_AUDIT_IN_NATIVE_2026-08-05.md` và `IN_NATIVE_FIXES_2026-08-05.md`.

Kết luận:

- Luồng đạt mức **`TRACED + REPRODUCED`**, chưa đạt `AUTO` theo bất biến người dùng mong muốn và chưa có artifact in thật.
- Xác nhận **2 finding P1** và **2 finding P2**. Đây là lỗi hợp đồng xuyên tầng, không phải chỉ lỗi một ô nhập.
- Cú pháp `27-28,30-33` hiện không thể biểu diễn. Hợp đồng từ React tới Rust chỉ có `fromPage/toPage`, nên nếu dùng `27–33` thì trang 29 sẽ bị in sai.
- “Trang hiện tại” trong hộp In đang lấy trang preview nội bộ khởi tạo bằng 1, không lấy `viewerActivePage` của workspace.
- Danh sách thumbnail đang chọn nằm cục bộ trong Viewer và không được truyền cho handler In.
- Chưa sửa source trong đợt audit này; dừng ở chốt duyệt theo quy trình audit hai chốt của dự án.

## 2. Tái hiện và baseline

### 2.1 Harness tái hiện tạm thời

Đã dùng harness Vitest tạm với tài liệu 40 trang, chạy xong rồi gỡ sạch khỏi worktree:

1. Chọn **Khoảng trang**, gõ `27`, sau đó xóa ô **Từ**: giá trị lập tức bật về `1`.
2. Đưa chuỗi `27-28,30-33` vào ô số: browser trả chuỗi rỗng và handler ép state về `1`.
3. Chọn **Trang hiện tại** rồi In: payload native là `{ fromPage: 1, toPage: 1 }`.
4. Chọn `27` đến `33`: payload chỉ có `{ fromPage: 27, toPage: 33 }`, không có trường `pages`; vì vậy không có cách loại trang 29.

Kết quả harness: **3/3 ca tái hiện đạt theo hành vi lỗi hiện tại**. Harness chỉ dùng làm bằng chứng audit, không được giữ lại như regression vì nó khóa hành vi sai.

### 2.2 Test hiện hành

Lệnh:

```powershell
cd desktop
npx.cmd vitest run src/components/shared/usePrintDialog.test.tsx src/lib/printPreviewLayout.test.ts
```

Kết quả sau khi gỡ harness: **2 file / 10 test đạt**.

Ý nghĩa: baseline hiện tại xanh nhưng chưa kiểm cú pháp danh sách trang, trang hiện tại của workspace, thumbnail đang chọn hoặc khả năng để ô nhập rỗng trong lúc sửa.

Đã thử chạy Rust helper bằng:

```powershell
cd desktop/src-tauri
cargo test pdf_engine::print_layout --lib
```

Build bị chặn bởi tiến trình dev đang giữ tài nguyên Tauri/PDFium (`os error 32`). Không dừng hoặc kill tiến trình của người dùng. Đây là khoảng trống bằng chứng của đợt audit, không phải test nghiệp vụ đỏ.

## 3. Trace dọc hợp đồng hiện tại

| Mắt xích | Bằng chứng | Hợp đồng thực tế |
|---|---|---|
| Trang workspace đang xem | `desktop/src/components/ImpositionTab.tsx:165-166`, `:190-191` | Có `viewerActivePage`, 1-based. |
| Thumbnail đang chọn | `desktop/src/hooks/viewer/usePdfLoader.ts:141-146`; `desktop/src/components/AcrobatViewer.tsx:341-350` | `selectedIndices` là state cục bộ, 0-based theo vị trí đang hiển thị. |
| Handler In màn hình chính | `desktop/src/components/ImpositionTab.tsx:2488-2499` | Chỉ gọi `openPrintDialog({ source, numPages })`; bỏ `viewerActivePage` và selection. |
| Các caller khác | `CompareTab.tsx:117-136`; `CombineTab.tsx:874-893`; `DielineTool.tsx:105-130` | Cả bốn caller đều chỉ có source/tổng trang; không caller nào truyền trang khởi tạo hoặc danh sách trang. |
| Contract mở dialog | `desktop/src/components/shared/usePrintDialog.tsx:20-25` | `PrintRequest` chỉ có `source`, `numPages`, `autoRotateDefault`. |
| State hộp In | `desktop/src/components/shared/PrintDialog.tsx:111-122` | `previewPage` luôn khởi tạo bằng 1; range chỉ có `rangeFrom/rangeTo`. |
| UI chọn trang | `PrintDialog.tsx:67`, `:694-715` | Chỉ có `all/current/range`; range là hai `<input type="number">`, không có ô nhận danh sách. |
| Danh sách preview | `PrintDialog.tsx:187-211` | Luôn dựng một khoảng liên tục rồi mới áp lẻ/chẵn và đảo thứ tự. |
| Payload khi bấm In | `PrintDialog.tsx:559-582` | Chỉ trả `fromPage/toPage`; “current” dùng `previewPage`. |
| Hook gọi native | `usePrintDialog.tsx:116-152`, `:165-176` | Cả direct-print và Windows fallback chỉ chuyển hai biên. |
| TypeScript IPC | `desktop/src/lib/nativePrint.ts:53-85`, `:160-185` | `PrintDirectParams` và `PrintPathParams` không có danh sách trang. |
| Worker protocol | `desktop/src-tauri/src/pdf_engine/print_worker.rs:48-80` | JSON chỉ có `from_page/to_page`. |
| Tauri command | `desktop/src-tauri/src/pdf_engine/print.rs:1153-1216` | `print_pdf_direct` chỉ nhận và chuyển hai biên. |
| GDI sink | `print.rs:1297-1305`, `:784-790`; `print_layout.rs:41-65` | Rust chuẩn hóa thành `start_pg/end_pg`, sau đó sinh toàn bộ `(lo..=hi)`. |
| Windows fallback | `print.rs:477-525`, `:620-659` | `PrintDlgW` và fallback cũng chỉ bảo toàn một khoảng liên tục. |

Luồng dữ liệu hiện tại:

```text
workspace current/selection ──X──> PrintRequest
                                  │
PrintDialog all/current/range ──> fromPage + toPage
                                  │
nativePrint ──> Tauri ──> worker ──> start_pg..=end_pg ──> GDI
```

## 4. Finding đã xác nhận

### §PRINTRANGE.1 — P1, effort L — Không hỗ trợ danh sách trang rời rạc xuyên UI → native

**Trạng thái:** `[CONFIRMED]`.

**Bằng chứng:**

- `PrintSettings`, `PrintRequest`, `PrintDirectParams`, worker JSON và Tauri command đều không có trường danh sách trang.
- UI chỉ có hai ô số **Từ/Đến**.
- Preview JavaScript và sink Rust cùng sinh toàn bộ khoảng liên tục.
- Harness chứng minh `27–33` chỉ tạo payload hai biên và không có cách loại trang 29.

**Tác động:** người dùng không thể thực hiện một job như `27-28,30-33`. Nếu nới hai biên thành 27–33 thì output sai nội dung; nếu tách thành nhiều job thì số bản, collate, thứ tự, Multiple/Booklet/Poster và thao tác vận hành không còn là một job thống nhất.

**Hướng sửa:** thêm một danh sách trang canonical 1-based xuyên `PrintSettings → nativePrint → Tauri → worker → Rust`; preview và GDI phải dùng đúng cùng danh sách. Parser cần có test cho dấu phẩy, range, khoảng trắng, trùng lặp, đảo range, trang ngoài biên và token lỗi.

### §PRINTRANGE.2 — P1, effort M — “Trang hiện tại” và thumbnail đang chọn không đi vào hộp In

**Trạng thái:** `[CONFIRMED]`.

**Bằng chứng:**

- `ImpositionTab` đã có `viewerActivePage` nhưng không truyền khi gọi `openPrintDialog`.
- `PrintDialog` khởi tạo `previewPage = 1` và dùng chính state này cho mode `current`.
- `selectedIndices` tồn tại trong `usePdfLoader/AcrobatViewer` nhưng không có trong workspace print contract.
- Harness chứng minh bấm **Trang hiện tại** ngay sau khi mở dialog gửi trang 1.

**Tác động:** đang xem trang 27 nhưng chọn **Trang hiện tại** vẫn có thể in trang 1. Khi chọn nhiều thumbnail trên màn hình, lệnh In không biết selection đó và mặc định vẫn mở ở **Tất cả**.

**Hướng sửa:** truyền `initialPage` 1-based và selection snapshot vào yêu cầu In. Với PDF đã bake thứ tự/xoay, selection phải được chuẩn hóa theo vị trí trang của blob sau bake; không dùng lại số trang gốc. Không đưa state cuộn nóng vào store global làm shell render lại liên tục—chỉ chụp snapshot tại thời điểm mở In hoặc dùng bridge theo tab.

### §PRINTRANGE.3 — P2, effort S — Ô số không cho trạng thái rỗng trong lúc người dùng sửa

**Trạng thái:** `[CONFIRMED]`.

**Bằng chứng:** `PrintDialog.tsx:708-713` gọi `parseInt(value) || 1` rồi clamp ngay trong mỗi `onChange`. Khi xóa nội dung, controlled input lập tức render lại thành `1`; harness tái hiện đúng hành vi này.

**Tác động:** thao tác xóa rồi gõ số mới bị giật về 1, tạo cảm giác “không cho điền số trang”. `<input type="number">` cũng không thể nhận cú pháp `27-28,30-33`.

**Hướng sửa:** dùng state chuỗi cho lúc đang nhập, cho phép rỗng tạm thời; chỉ parse/validate khi blur hoặc submit. Danh sách trang dùng ô text chuyên biệt kèm ví dụ và thông báo lỗi tiếng Việt rõ ràng.

### §PRINTRANGE.4 — P2, effort M — Regression hiện tại xanh nhưng không khóa bất biến chọn trang

**Trạng thái:** `[CONFIRMED]`.

**Bằng chứng:**

- `usePrintDialog.test.tsx` chỉ mở tài liệu 1 trang và tập trung lifecycle/driver/output path/cancel.
- `printPreviewLayout.test.ts` và Rust `print_layout.rs` chỉ kiểm khoảng liên tục, subset, reverse và layout.
- Không có test cho parser `27-28,30-33`, current workspace page, selected thumbnails, trạng thái rỗng khi nhập hoặc parity giữa preview và payload native.

**Tác động:** 10 test liên quan vẫn xanh trong khi cả ba triệu chứng người dùng báo đều tái hiện được.

**Hướng sửa:** thêm contract test ở từng biên và một ca end-to-end tạo output PDF thật, kiểm cả số trang lẫn fingerprint nội dung để chứng minh trang 29 không lọt vào.

## 5. Ràng buộc thiết kế khi sửa

1. Một danh sách canonical phải là nguồn duy nhất cho preview, subset lẻ/chẵn, reverse, copies/collate và mọi layout Size/Multiple/Booklet/Poster.
2. Không được “sửa UI trước” rồi tiếp tục hạ danh sách thành `min/max`; cách đó vẫn in sai trang bị bỏ qua.
3. `selectedIndices` là 0-based theo thứ tự Viewer; `viewerActivePage` là 1-based. Sau `applyAcrobatEdits`, số trang in phải tham chiếu PDF đã bake.
4. System PrintDlg hiện chỉ giữ một khoảng liên tục. Với danh sách rời rạc, fallback phải materialize PDF subset tạm hoặc khóa fallback kèm giải thích; tuyệt đối không âm thầm nới thành 27–33.
5. Parser lỗi hoặc danh sách rỗng phải fail-closed trước khi tạo job. Trang ngoài `1..numPages` phải được chỉ rõ, không tự kẹp khiến người dùng tưởng đã chọn đúng.
6. Không thay đổi giới hạn worker/RAM hoặc kiến trúc process trong đợt sửa này.

## 6. Kế hoạch sửa đề xuất — chờ duyệt

Mỗi lô tối đa 5 file source/test, verify xong mới sang lô kế.

### Lô 1 — Parser, UI và preview

1. Thêm helper parse/format danh sách trang và test biên.
2. Đổi mode range sang ô danh sách có thể nhập `27-28,30-33`; cho phép state rỗng khi đang sửa.
3. Dựng preview từ danh sách canonical thay vì hai biên.
4. Thêm `initialPage/initialSelectedPages` vào contract dialog và test payload phía frontend.

### Lô 2 — IPC, worker và Rust/GDI

1. Truyền `pages?: number[]` qua TypeScript IPC, Tauri command và worker JSON.
2. Rust validate trang 1-based, áp subset/reverse trên danh sách explicit và dùng danh sách đó cho mọi layout.
3. Khóa parity preview ↔ Rust bằng cùng fixture `27-28,30-33`.
4. Giữ backward compatibility cho caller chỉ dùng tất cả hoặc một khoảng liên tục.

### Lô 3 — Snapshot workspace và fallback

1. Nối trang hiện tại của workspace vào hộp In.
2. Chụp selection thumbnail theo đúng tab tại thời điểm mở In, không tạo rerender nóng khi cuộn.
3. Chốt hành vi **Các trang đang chọn** và default hợp lý khi selection chỉ có một trang.
4. Với Windows fallback, materialize subset tạm hoặc chặn rõ ràng nếu không thể bảo toàn danh sách.
5. Bổ sung i18n Việt/Anh và regression multi-tab/page-order/bake.

### Lô 4 — Verify cuối và artifact

1. Frontend targeted + typecheck.
2. Rust print layout + worker protocol test khi tài nguyên dev không còn bị khóa.
3. Smoke Microsoft Print to PDF trên tài liệu ≥40 trang: output đúng 6 trang và đúng fingerprint `27,28,30,31,32,33`.
4. Kiểm tay trên app: xóa/gõ lại ô; trang hiện tại 27; Ctrl/Shift chọn thumbnail; Size/Multiple/Booklet; lẻ/chẵn; reverse; fallback Windows.

## 7. Chốt bằng chứng còn thiếu

- Chưa có artifact PDF in thật cho danh sách rời rạc vì source hiện không thể biểu diễn danh sách đó.
- Rust baseline chưa chạy lại do file/tài nguyên Tauri đang bị process dev giữ (`os error 32`); không suy diễn lỗi nghiệp vụ từ lỗi môi trường này.
- Chưa xác nhận hành vi mong muốn khi danh sách có trang lặp hoặc thứ tự giảm; cần khóa bằng test trong Lô 1 trước khi truyền xuống native.
- Chưa smoke printer vật lý; Microsoft Print to PDF là artifact gate phù hợp cho correctness page selection, không thay thế smoke thiết bị thật.

Theo quy trình audit PrynX, dừng tại đây để chờ người dùng duyệt trước khi sửa code.
