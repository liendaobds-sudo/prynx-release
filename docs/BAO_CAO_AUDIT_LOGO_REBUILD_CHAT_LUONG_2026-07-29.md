# Báo cáo audit chất lượng Phục hồi & Vector hóa Logo — 2026-07-29

**Trạng thái:** CHỜ DUYỆT TRƯỚC KHI SỬA  
**Phạm vi:** tải SVG, Undo/Redo, gợi ý màu từ ảnh nguồn và bảo toàn góc sắc  
**Không thuộc phạm vi:** AI phục dựng phần bị che, suy ra màu Pantone/CMYK gốc từ ảnh chụp

## 1. Tóm tắt điều hành

Bốn phản hồi của người dùng đều có cơ sở. Hai mục là lỗi chức năng hiện hữu (không lưu được
SVG trong Tauri và hình học luôn đi qua spline), một mục là thiếu hợp đồng UI (Undo/Redo), và
một mục trước đây bị loại khỏi MVP (tự nhận màu) nhưng có thể mở lại ở mức **gợi ý màu cục bộ
cần người dùng xác nhận**, không phải auto-color hay AI.

Không nên tiếp tục gọi workspace hiện tại là bản sẵn sàng phát hành. Đề xuất sửa theo năm lô
nhỏ, mỗi lô không quá 5 file và có cổng kiểm thử riêng.

## 2. Bảng phát hiện

| Mã | Mức | Effort | Kết luận |
|---|---|---:|---|
| §LR.01 | P0 | S | Nút Tải SVG dùng cơ chế browser-only, không có nhánh ghi file Tauri |
| §LR.02 | P1 | M | Workspace không có history stack, nút Undo/Redo hoặc phím tắt scoped |
| §LR.03 | P1 | M | Không có bước phân tích/gợi ý palette; UI luôn bắt đầu bằng đen và trắng |
| §LR.04 | P1 | M | Native luôn dùng `FitMode::Spline`; độ mượt 0 vẫn không thể giữ polygon/góc sắc |
| §LR.05 | P0 | M | Preview cũ vẫn tải được sau khi file/settings đã đổi; job thiếu revision chống kết quả trễ |

## 3. Phát hiện chi tiết

### §LR.01 — P0: Tải SVG không dùng đường ghi file của Tauri

**Bằng chứng:**

- `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx:204-212` chỉ tạo `blob:`,
  gọi `anchor.click()` rồi thu hồi URL ở timeout 0 ms;
- anchor không được gắn vào DOM, không có `__TAURI_INTERNALS__`, hộp thoại Save,
  `writeTextFile`, thông báo thành công hoặc xử lý lỗi;
- `desktop/src/lib/dieline/saveJsPdfDoc.ts:1-5` ghi rõ WebView2 có thể nuốt cơ chế
  `<a download>`; đường chuẩn dùng Save dialog và command Rust `write_file_atomic`;
- `desktop/src-tauri/src/lib.rs:1169` đã cho phép đuôi `.svg`, nên không cần thay Rust/capability;
- test workspace chỉ kiểm nút được bật, không hề bấm nút hoặc xác nhận file đã được ghi.

**Hướng sửa đề xuất:** tạo helper lưu blob/text dùng chung: Tauri mở Save dialog và ghi UTF-8
nguyên tử qua `write_file_atomic`; browser dùng anchor gắn DOM. Nút phải báo đã lưu, người dùng
hủy dialog không phải lỗi.

**Tiêu chí đạt:** bản Tauri lưu được SVG không rỗng vào Desktop/Document/Download; mở lại được;
cancel không báo lỗi; fallback browser vẫn tải được.

### §LR.02 — P1: Không có Undo/Redo

**Bằng chứng:**

- `LogoRebuildWorkspace.tsx:45-54` giữ mode, palette, nền, crop, perspective, smoothing,
  despeckle và illumination bằng các `useState` độc lập;
- mọi control ở các dòng 263-405 gọi setter trực tiếp; không có snapshot, `past/future`, Undo,
  Redo hoặc listener Ctrl+Z/Ctrl+Y;
- preview là dữ liệu dẫn xuất nhưng hiện không bị vô hiệu hóa khi tham số thay đổi, nên còn có
  nguy cơ tải nhầm SVG cũ sau khi chỉnh setting.

**Hướng sửa đề xuất:** gom các setting chỉnh sửa thành một `LogoEditorState`; history tối đa 50
bước, coalesce thao tác slider/text liên tiếp; Ctrl+Z, Ctrl+Y/Ctrl+Shift+Z chỉ hoạt động khi focus
nằm trong workspace. Thay file sẽ xóa history; Undo/Redo phải vô hiệu preview cũ.

**Tiêu chí đạt:** hoàn tác/làm lại được palette, mode, crop, perspective và tham số trace; không
can thiệp Undo của tab PDF nền; nút bị disable đúng khi stack rỗng.

### §LR.05 — P0: Preview và file tải có thể không khớp trạng thái đang hiển thị

**Bằng chứng:**

- sau khi có preview, đổi palette/smoothing/crop không xóa `preview`; nút tải tại dòng 441 vẫn bật
  và `exportSvg()` tiếp tục ghi SVG cũ;
- `selectFile()` chỉ `setPreview(null)` nhưng không dọn/revoke `previewUrl` qua helper thống nhất;
- kết quả async chỉ so `jobId`; nếu file/settings đổi khi job đang chạy, kết quả của revision cũ
  vẫn có thể được nhận;
- `LogoRebuildWorkspace` chưa nhận `isActive` từ `ImpositionTab.tsx:2421`, trong khi các tool
  lân cận đã nhận cờ này; hotkey Undo mới sẽ đụng tab nền nếu không sửa wiring.

**Hướng sửa đề xuất:** một `clearPreview()` duy nhất; tăng revision/fingerprint khi file hoặc editor
state đổi; chỉ nhận kết quả nếu revision còn khớp; truyền `isActive` để hotkey chỉ chạy ở tab thật.

**Tiêu chí đạt:** thay bất kỳ setting/file nào sẽ vô hiệu nút tải ngay; response trễ bị bỏ; object
URL cũ được revoke đúng một lần; tab nền không nhận Ctrl+Z/Y.

### §LR.03 — P1: Không có nhận diện/gợi ý màu từ ảnh nguồn

**Bằng chứng:**

- `LogoRebuildWorkspace.tsx:18` hardcode palette đầu vào `#000000`, `#ffffff`;
- `desktop/src/lib/logoRebuildApi.ts` chỉ gọi capabilities, preview và cancel; endpoint preflight
  có ở backend nhưng frontend không gọi;
- preflight backend chỉ trả metadata/ICC/alpha, không phân tích màu;
- báo cáo G1 trước đây HOLD/NO-GO cho **auto-color** trên ảnh chụp; palette oracle giúp ΔE rõ rệt
  nhưng không chứng minh có thể suy ra màu mực/brand gốc từ ảnh cũ.

**Phạm vi khả thi:** thêm nút **Gợi ý màu từ ảnh** chạy hoàn toàn cục bộ. Backend chuyển ảnh về
sRGB, bỏ pixel alpha trong suốt, lấy mẫu có trọng số, lượng tử hóa không dither về 1–12 màu và
trả palette cùng tỷ lệ phủ/confidence. Người dùng phải bấm Áp dụng và vẫn chỉnh được mã màu.
Đây là gợi ý theo pixel nhìn thấy, không được gọi là màu in gốc, Pantone hay auto-color.

**Tiêu chí đạt:** fixture PNG alpha phẳng đen/xám trả đủ hai màu trong sai số màu đã định;
transparent RGB không lọt vào palette; ảnh chụp được gắn nhãn “gợi ý, cần xác nhận”; không gọi
mạng và không thêm API AI.

### §LR.04 — P1: Điều khiển “Độ mượt” không thể giữ góc sắc

**Bằng chứng:**

- `native/src/logo_vectorizer.rs:99` hardcode `FitMode::Spline` cho mọi ảnh;
- dòng 100 chỉ ánh xạ slider sang `config.simplify`; ngay cả smoothing 0 vẫn chạy spline;
- `corner_threshold` và `length_threshold` giữ mặc định VTracer, không đổi theo slider;
- UI tự đặt smoothing 1 khi chọn màu ở `LogoRebuildWorkspace.tsx:272`;
- spike đã có nhánh `polygon` riêng nhưng adapter sản phẩm không đưa năng lực này vào hợp đồng.

**Hướng sửa đề xuất:** bổ sung lựa chọn **Góc sắc** / **Đường cong** xuyên suốt schema → API →
native. Góc sắc dùng `FitMode::Polygon`; đường cong dùng `FitMode::Spline` và slider độ mượt.
Không âm thầm coi smoothing 0 là polygon vì như vậy hợp đồng khó hiểu và project cũ đổi nghĩa.

**Tiêu chí đạt:** fixture hình học 90° ở chế độ Góc sắc không phát sinh cubic spline, boundary
F-score đạt ngưỡng đã chốt và góc không bị bo; chế độ Đường cong vẫn giữ hành vi hiện tại.

## 4. Thứ tự sửa đề xuất

### Lô 1 — Lưu SVG + history/revision frontend (5 file)

- helper lưu blob theo Tauri/browser và test riêng;
- state history, Undo/Redo, revision chống response trễ và vô hiệu preview cũ;
- test component cho save, cancel, undo, redo, stale preview và hotkey;
- truyền `isActive` từ `ImpositionTab` để tab nền không nhận phím;
- verify: typecheck + vitest workspace + thao tác thật trong Tauri.

### Lô 2 — Gợi ý màu backend (4 file)

- schema response;
- bộ trích màu cục bộ trong worker;
- route preflight/analyze;
- pytest alpha, màu phẳng, ảnh nhiễu và giới hạn 12 màu.

### Lô 3 — Gợi ý màu frontend (3 file)

- hợp đồng API;
- UI xem trước/Áp dụng palette gợi ý;
- test không tự áp dụng khi người dùng chưa xác nhận.

### Lô 4 — Hợp đồng hình học backend/native (tối đa 4 file)

- schema `geometry_mode`;
- worker truyền mode;
- adapter Rust chọn Polygon/Spline và test góc;
- backend regression test; sau đó maturin rebuild.

### Lô 5 — Điều khiển hình học frontend (3 file)

- API type;
- UI Góc sắc/Đường cong, mặc định được chốt sau A/B;
- test payload và trạng thái Undo.

## 5. Cổng dừng và rủi ro

- Sau mỗi lô phải verify rồi người dùng thử runtime trước khi sang lô kế.
- Không quảng bá “nhận đúng màu gốc” cho ảnh chụp không ICC; chỉ cam kết gợi ý màu pixel sRGB.
- Không đổi golden/corpus để làm đẹp số đo; mọi thay đổi Polygon/Spline phải so cùng fixture.
- Nếu file PNG gốc của ca người dùng chưa được cung cấp, kết luận hình học chỉ ở mức fixture và
  cần retest chính file đó trước khi đóng audit.
