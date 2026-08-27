# BÁO CÁO AUDIT VÒNG ĐỜI FILE VÀ HỢP ĐỒNG ẢNH

**Ngày:** 2026-08-26

**Baseline:** `codex/pre-release-audit-2026-08-04` tại `b0bfa6aa6e3b2fe6aabb31871aa0a831ec951604`.

**Phạm vi:** startup/Open With/single-instance/native và DOM drop/picker/Recent/remount/multi-tab; path-backed File; JPEG/PNG/WebP/BMP/TIFF; ICC/DPI/alpha; mọi consumer dùng normalizer ảnh.

**Trạng thái:** audit read-only hoàn tất; chưa sửa finding mới, chưa commit/push/build. Hai hotfix đang có trong working tree được giữ nguyên.

## Kết luận

Hai hotfix gần nhất xử lý đúng triệu chứng đã gặp: đổi ngôn ngữ không còn chạy lại effect trong cùng mount; JPEG CMYK ICC hợp lệ không còn bị coi là ảnh hỏng và giữ DCT, Decode, ICCBased N=4 DeviceCMYK.

Audit xuyên luồng xác nhận thêm 10 finding: 6 P1, 3 P2 và 1 P3. Không có bằng chứng `tem-01.jpg` hỏng, path-backed transport mất bytes hay pdf-lib không hỗ trợ JPEG CMYK.

## Finding vòng đời file

### §FILE.A1 — P1 — startup args chưa consume-once

`desktop/src-tauri/src/lib.rs:3404-3406` luôn trả `std::env::args()`. `SystemIntegrations.tsx:94-103` đọc lại mỗi lần mount; `ErrorBoundary.tsx:59-64` reload root. Locale re-render đã được chặn nhưng reload/remount vẫn có thể phát lại batch và mở lại tab.

### §FILE.A2 — P1 — mất ranh giới batch và intent

Native dồn args của mọi second-instance vào một Vec tại `lib.rs:5055,5062-5066`, rồi clone/clear thành mảng phẳng tại `:4083-4087`. `SystemIntegrations.tsx:23-27` lấy action đầu tiên áp cho mọi path; `useIncomingFileDispatcher.ts:180-195` có thể trộn event không intent với explicit intent đang đợi poll. Combine/Convert/drop/picker gần nhau có thể bị định tuyến sai.

### §FILE.A3 — P1 — prefetch giữ quyền tạo tab

`useIncomingFileDispatcher.ts:47-57` chỉ dispatch PDF path-backed sau `primeViewerFirstFrame()`. Prime chờ native bootstrap/render tại `viewerFirstFrame.ts:201-350`; worker có `read_frame` blocking không deadline tại `render_worker.rs:2232`. Nếu PPE treo, tab chưa được tạo và không có lỗi/retry/cancel. Prefetch phải là best-effort.

### §FILE.A4 — P2 — dirty/Recent suy provenance từ tên

`constants.ts:10-44` dùng `includes()` với token phổ thông như `part_`, `converted_`, `Edited_`; App, Imposition và Recent dùng kết quả đó. Probe xác nhận `Hop_dong_converted_2026.pdf` và `Khach_Edited_final.pdf` bị coi là output. Provenance phải là metadata, không phải substring tên.

## Finding hợp đồng ảnh

### §IMG.B1 — P1 — TIFF mất DPI

TIFF 2×3 px @300 DPI tạo MediaBox 2×3 pt, đúng phải 0,48×0,72 pt. `imageNormalizer.ts:281-286` chỉ đọc JPEG JFIF/PNG pHYs; Rust `normalize_image_bytes` decode rồi ghi PNG không chuyển metadata. Kích thước vật lý bị phóng 4,1667 lần.

### §IMG.B2 — P1 — JPEG giả định APP0 ngay sau SOI

`imageNormalizer.ts:305-316` chỉ đọc JFIF khi APP0 ở byte 2. Probe JPEG 600×300 @300 DPI có APP2 trước APP0 cho trang 600×300 pt thay vì 144×72 pt. Parser phải quét marker.

### §IMG.B3 — P1 — Combine quảng cáo định dạng nhưng đưa vào PDF parser

Picker nhận mọi ảnh tại `CombineTab.tsx:428-432`, gồm WebP/BMP/TIFF, nhưng ba nhánh `:706`, `:807`, `:842` chỉ nhận JPG/PNG. Định dạng còn lại đi vào `PDFDocument.load()` và có thể ném `No PDF header found`.

### §IMG.B4 — P2 — lỗi decoder native bị nuốt

`normalizeImageToPngBytes()` tại `imageNormalizer.ts:23-30` catch lỗi Rust rồi trả bytes nguồn; caller `:268-270` gọi `embedPng()` trên TIFF/WebP/BMP gốc. Sentinel decoder bị thay bằng `The input is not a PNG file!`.

### §IMG.B5 — P2 — Imposition generic hóa mọi lỗi ảnh

Catch tại `ImpositionTab.tsx:953-959,2380-2386` bỏ `openError` và luôn báo file hỏng/sai định dạng. ICC, codec, path, decoder hoặc OOM đều trông giống nhau; CompareTab đã giữ cause bằng `formatError`.

### §IMG.B6 — P3 — chọn codec theo extension

`imageNormalizer.ts:257` chọn JPEG/PNG theo tên. Cùng bytes JPEG CMYK hợp lệ đổi tên `.png`/`.webp` bị từ chối; có ICC thì nhánh `:261-265` fail-closed trước content sniff. Fail-closed ICC là đúng, oracle codec phải dùng magic bytes.

## Nghi vấn cần fixture/oracle

- `§FILE.S1`: listener đóng cửa sổ phụ thuộc callback có `t`; đổi locale có thể tạo khoảng trống registration. Cần test race + Alt+F4 runtime.
- `§FILE.S2`: deep-link listener LoginScreen phụ thuộc `t`, chưa guard unmount cho Promise registration.
- `§IMG.S1`: ICC TIFF/WebP/BMP có khả năng bị bỏ và không color-manage; cần profile thật + color oracle.
- `§IMG.S2`: EXIF DPI/orientation bị bỏ; cần fixture ảnh chụp và render oracle.
- `§IMG.S3`: alpha WebP/TIFF qua decoder native chưa có artifact test SMask.
- Browser fallback chưa chứng minh WebP/BMP/TIFF vì ngoài Tauri normalizer trả bytes nguồn.

Scanner `scripts/audit_contracts.ps1` self-test 17/17, quét 1.421 file và sinh 1.056 ứng viên SUSPECTED. Đây không phải 1.056 bug và không dùng làm release gate.

## Đã bác bỏ / hành vi đúng

- Đổi ngôn ngữ thông thường không còn đọc lại startup args trong cùng mount.
- `tem-01.jpg` không hỏng; JPEG CMYK 634×848, ICC SWOP hợp lệ.
- Path-backed File không mất bytes trong luồng đã trace; bytes được đọc lại qua path/localfile.
- pdf-lib nhúng được JPEG CMYK; hotfix giữ DCT và Decode.
- PNG fixture giữ ICCBased N=3, alpha SMask và pHYs 300 DPI.
- ICC sai số kênh bị dừng đúng, không gắn âm thầm.
- Native/DOM listener SystemIntegrations có cleanup; child window không mount component này; receiver ảnh có tabId/feature owner.

## Consumer ảnh

| Consumer | Tác động |
|---|---|
| Imposition/Viewer | B1, B2, B4, B5, B6 |
| Compare | B1, B2, B4, B6; hiện giữ lỗi gốc |
| Combine | B1, B2, B3, B4, B6 |
| Sticker Sheet nhiều ảnh | B1, B2, B4, B6 |
| Upscale | B1, B2 kéo sai kích thước vật lý |
| Watermark | B2/B4/B6 trong phạm vi UI hiện cho phép |
| PdfMerger | UI chỉ PDF/JPG/PNG; chưa chứng minh producer path-backed legacy nên không gọi bug |
| Document Cleanup | chịu normalizer nhưng là consumer ảnh kết quả; giữ lỗi gốc |

## Khoảng trống test

- Remount/reload không phát lại startup batch.
- Hai second-instance intent khác nhau và explicit intent xen picker/drop.
- Prime không settle nhưng tab vẫn xuất hiện theo deadline.
- Tên file khách trùng token output vẫn clean và có Recent.
- JPEG marker ordering, TIFF IFD DPI, EXIF DPI/orientation.
- Signature khác extension; decoder phải giữ cause.
- Gray/RGB/CMYK ICC thực và mismatch số kênh trong test checked-in.
- WebP/BMP/TIFF thật qua command Rust, alpha và color oracle.
- Combine interleave/flat/group với mọi định dạng.
- Runtime Windows/Tauri: cold start, second instance trong splash, root reload, tab nền, native drop, installed release.

## Kế hoạch sửa theo lô tối đa 5 file

1. **Lô A — at-most-once + batch/intent:** `lib.rs`, SystemIntegrations code/test, dispatcher code/test. Queue native thành batch có identity/action; startup consume-once; không trộn intent.
2. **Lô B — giữ cause + CMYK + UI:** imageNormalizer code/test, Imposition và test mở file. Không trả bytes nguồn sau decoder failure; giữ stage/cause; khóa artifact CMYK.
3. **Lô C — DPI:** imageNormalizer code/test và upscale density test. Quét JPEG marker, đọc TIFF IFD, khóa MediaBox.
4. **Lô D — Combine:** CombineTab, test Combine và normalizer test. Dùng một oracle định dạng/helper ở mọi nhánh.
5. **Lô E — prefetch:** dispatcher, viewerFirstFrame và test. Tạo tab ngay, prefetch best-effort có deadline.
6. **Lô F — provenance:** thiết kế metadata trước, chia sub-lô tối đa 5 file cho nativeFileAccess/App/Imposition/Recent/constants/test.
7. **Lô G — ICC/EXIF native:** chỉ mở khi có fixture/oracle; nếu thêm dependency Rust phải review artifact, hiệu năng và RAM.

## Verify audit

- Regression hiện hành: 4 file / 55 test đạt.
- Harness TIFF chủ đích đỏ: expected 0,48 pt, received 2 pt.
- Hotfix CMYK artifact có ICCBased, N=4, Alternate DeviceCMYK, DCTDecode, Decode.
- Scanner self-test 17/17.
- Không build/publish và chưa sửa production finding mới.

## Chốt duyệt

Theo workflow audit, báo cáo dừng tại chốt thứ nhất. Khuyến nghị thứ tự A → B → C → D → E → F; G chỉ mở khi fixture/oracle sẵn sàng. Mỗi lô verify xong mới sang lô kế.
