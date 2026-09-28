# Nhật ký sửa xóa viền và phủ màu theo biên

Ngày: 2026-09-28. Theo [báo cáo audit](BAO_CAO_AUDIT_XOA_VIEN_PHU_MAU_BIEN_2026-09-28.md), user đã duyệt “tiến hành đi”.

**Duyệt tiếp:** sau bàn giao lô A, user yêu cầu “làm luôn đi”. Tiếp tục các lô còn lại không chờ kiểm tay giữa lô, vẫn giữ ≤5 file/lô và verify trước lô kế. Đây là duyệt tiếp, không phải bằng chứng runtime lô A đã đạt.

## Trạng thái

- **Lô A / §WBR28.01: đã áp dụng, SOURCE + AUTO + ARTIFACT đạt. Runtime vẫn chưa nghiệm thu; user đã duyệt tiếp.**
- **Lô B / §WBR28.02–03: đã sửa và verify AUTO** (26 regression mới; mở rộng sau D2 là 12 file / 137 test, typecheck đạt). Chưa nghiệm thu GUI/native.
- **Lô C: engine `mode="fill"` đã triển khai, 232 test liên quan đạt (85 ca mới)**. Giữ khổ/vị trí/nội dung gốc; lô đầu từ chối trang khai báo transparency hoặc tài nguyên Pattern.
- **Lô D1: API hai mode + echo đã nối, 79 test API/hợp đồng đạt**.
- **Lô D2: frontend gửi/kiểm echo mode trước download, 34 regression mới; mở rộng 12 file / 137 tests và typecheck đạt.**
- **Lô E: UI/i18n đã nối hai lựa chọn, 41 test tập trung; mở rộng 13 file / 144 tests và typecheck đạt.**
- §WBR28.04–05 (OutputIntent và mask/UserUnit của Resize): còn mở; không ghép nguyên Resize vào lựa chọn phủ viền.
- Chưa kiểm GUI Tauri, installer, PDF khách hoặc RIP/bản in. Không tuyên bố toàn bộ tính năng đã hoàn tất.

## Lô A — sửa hệ quy chiếu vùng nhìn thấy

### Phạm vi và nguyên nhân

`PageBoxesEngine.auto_trim` dùng CropBox raw để đổi bbox pixel thành tọa độ PDF, nhưng bitmap PDFium chỉ chứa giao MediaBox/CropBox. Khi CropBox vượt MediaBox, artwork bị định vị sai rồi box kết quả cắt vào nội dung.

Năm file trong lô, không tính các artifact audit có trước:

1. `backend/app/core/page_boxes.py`: lấy `render_page.get_bbox()` ngay trong khóa render, cùng page và tài liệu nguồn với bitmap. Guard tọa độ hữu hạn và diện tích dương trước khi render; thông báo lỗi có số trang. Không thay `_get_page_box` hoặc `_pixel_bbox_to_cropbox` dùng chung.
2. `backend/tests/test_page_boxes_autotrim_visible_box.py`: 59 tổ hợp regression với PDF và ảnh render thật.
3. Nhật ký này.
4. Báo cáo audit: bổ sung trạng thái, giữ nguyên bằng chứng trước sửa.
5. Master matrix: cập nhật riêng mục WBR28, không thay các đợt audit khác.

Tag: `PAGEBOX (audit 2026-09-28 §WBR28.01)`.

### Bất biến được giữ

- Bbox vẫn trong hệ raw chưa xoay; `/Rotate` giữ nguyên. `/UserUnit` chỉ nhân DPI và chia lề mm như trước, không nhân bbox thêm lần nữa.
- Hai consumer xác nhận cạnh được xén và đổi pixel sang box cùng dùng bbox hữu hiệu.
- Cạnh không chọn giữ mép vùng nhìn thấy, không giữ phần CropBox vốn nằm ngoài MediaBox.
- Detector, ngưỡng, DPI, schema, cách ghi nội dung và thứ tự trang không đổi. Không thêm cap/cache/worker hoặc render lần hai.
- PDFium mở/lấy bbox/render/đóng trong khóa; CV ngoài khóa. Lỗi chưa được phép lưu artifact; file nguồn không bị ghi đè.
- Legacy gặp trang trắng/mơ hồ vẫn giữ page box gốc. File không có CropBox hoặc CropBox nằm trong MediaBox giữ hành vi đã kiểm trước sửa.

### Verify tự động

Sau khi sửa helper render của test để dùng `closing()` đúng API pypdfium2 local, **trước khi vá production: 50 failed / 9 passed**. Ca gốc trả `[42, 2.086331, 175.6, 98.345324]` thay vì vùng artwork `[40, 10, 160, 90]`, khớp audit.

Sau bản vá, **59/59 test mới đạt**:

- Cặp nguồn CropBox ngoài Media và giao hợp lệ có ảnh nguồn giống nhau; sau xén so cả MediaBox/CropBox và pixel ảnh, không chỉ kiểm công thức.
- Bốn góc 0/90/180/270; UserUnit 1/2; gốc 0, lệch âm/dương; lề 0/1,5 mm.
- Bốn cạnh theo hệ hiển thị × bốn góc; không xén thêm cạnh chưa chọn.
- CropBox thiếu/nằm trong trang; box kế thừa từ page tree; trang trắng legacy.
- Bytes nguồn và content streams giữ nguyên; trang không chọn giữ box, rotation và pixel.
- Giao rời nhau/chỉ chạm cạnh bị từ chối không xuất file; NaN/Infinity từ bbox renderer bị chặn trước tạo bitmap.

Lượt verify mở rộng: **259 passed, 1 warning Pydantic có sẵn**, gồm 59 ca mới và 200 ca hiện hữu. Không cộng lại các lượt test trùng.

`py_compile` cho core/test mới đạt; `git diff --check` không có lỗi whitespace (Git có cảnh báo LF→CRLF trên master matrix).

```powershell
# Chạy tại D:\pdfcompare\backend
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_page_boxes_autotrim_visible_box.py tests/test_page_boxes_autotrim.py tests/test_mirror_bleed_origin.py tests/test_page_crop_regions.py tests/test_resize_edge_background.py tests/test_resize_smart.py tests/test_resize_rotate_parity.py tests/test_nup_logical_cropbox.py
```

Review độc lập chỉ đọc source/test: không phát hiện blocker có bằng chứng. Hai tổ hợp chưa có test chuyên biệt: lỗi bbox ở trang 2 sau trang 1 thành công và single-side kết hợp đồng thời UserUnit/origin/margin; các trục đã được kiểm riêng. Test atomic explicit-failure nhiều trang hiện hữu vẫn đạt.

### Đo PDF kết quả bằng renderer độc lập

Dùng các PDF do test sinh trong thư mục tạm, gọi lại riêng hàm `render`/`metrics` của probe audit với **Poppler 288 DPI**; không chạy `main()` để tránh ghi đè bằng chứng lịch sử. Đã mở ảnh trước/sau để kiểm tra trực quan.

| Chỉ số, ca CropBox vượt MediaBox, rotation 0 | Trước sửa | Sau sửa |
|---|---:|---:|
| MediaBox | `[42,2.086331,175.6,98.345324]` | `[39.8,10.071942,160.04,90.28777]` |
| Pixel dải xanh sát mép trái | 2.560 | 5.120, bằng nguồn |
| Tỷ lệ trắng còn lại | 26,8607% | 0,5188%, bằng đối chứng |
| Ảnh kết quả so với nguồn đối chứng đã xén | Khác | Giống pixel hoàn toàn |

Cả bốn rotation sau sửa đều giữ 5.120 pixel xanh, trắng 0,5188%, giống pixel với đối chứng tương ứng. Sai số dưới một pixel dò/AA còn như control hiện hữu; không gọi kết quả là “trắng bằng 0” hoặc bảo đảm tuyệt đối mọi PDF.

SHA-256 tại lúc verify:

- `page_boxes.py`: `BF0C34E3FA10D38EA74D544F1A978A6D1BD95632210E7C041D4BCEADDA4BAD7A`.
- Test mới: `5D3602E6BB771BF62CA503D2714ADD266C4CA495A61CF2F8F3444D3132112B61`.
- JSON audit trước sửa giữ nguyên: `211C41FB2D1E8C5BEC4345F25A31677CE91FC40B025B91DB15A510AC54061DE6`.
- PNG audit trước sửa giữ nguyên: `B472519F519BE5466BA93EFADDBFBDC5CF7D322848BF1A6C50D0BEC94230AC3B`.

### Cổng chạy thật đã bàn giao sau lô A (lịch sử)

Theo `prynx-audit-workflow`, đã dừng sau lô A để user xác nhận trên bản dev đã nạp backend mới. User sau đó yêu cầu tiếp tục ngay; checklist này vẫn dành cho nghiệm thu runtime cuối:

1. File thường và file có CropBox vượt MediaBox: xóa đủ bốn viền, kiểm PDF kết quả không mất nội dung sát mép.
2. Thử trang xoay 90 độ và chỉ chọn một cạnh; cạnh phải theo hướng đang xem, ba cạnh khác không bị xén thêm.
3. Kiểm file nhiều trang khi chỉ xén trang hiện tại: trang khác giữ nguyên.

Lô này **chưa sửa Viewer giữ metadata cũ hoặc bake thứ tự/xoay lần hai**. Không dùng riêng nhãn kích thước cũ trên Viewer để nghiệm thu box PDF. Cần đối chiếu artifact kết quả; không coi xác nhận lô A là xác nhận toàn luồng commit.

Không chạy lại typecheck/Vitest/Cargo hoặc build release trong lô backend này; không đổi frontend/Rust/schema và không cập nhật golden. Chưa commit.

## Lô B — commit theo revision, Undo và nạp lại metadata

Phạm vi 5 file: `AcrobatViewer.tsx`, `ImpositionTab.tsx`, `AcrobatViewer.autoTrimCommit.test.tsx`, nhật ký này và master matrix. Giữ nguyên thay đổi Viewer/PPE của phiên khác.

- Viewer gọi `onAutoTrimApply`, chỉ đóng popup/báo thành công khi parent commit thật; không dùng đường `onEditCommit` của sửa đối tượng.
- Parent lấy lease qua `cropUploadCache.ensureLease` sau Edit barrier, kiểm revision sau POST/JSON/download/blob và ngay trước publish sau native I/O. Tab đóng, revision thay đổi hoặc ghi quy trình bắt đầu giữa chừng đều không được ghi đè kết quả mới.
- Artifact đã bake page state đi qua `commitWorkingFile`: nạp lại PDF/metadata, xóa order/rotation ảo để không bake lần hai, lưu Undo từ store hiện hành sau barrier.
- Ảnh nguồn đưa vào Undo phải khớp backing File và editGeneration; không gắn lại ảnh cũ vào PDF vừa sửa. Order/rotation ảo hợp lệ vẫn giữ owner ảnh.
- `onEditCommit`/`__editCommit` dùng chung không thay đổi. `mode` mới chỉ có ở type; chưa gửi API/chưa có UI phủ viền trong lô này.

### Verify

Baseline 15 test đỏ trước bản vá; bổ sung một ca owner ảnh tái hiện đỏ rồi xanh. Cuối lô **26/26 regression mới đạt**, mở rộng sau các guard D2 **12 file / 137 tests đạt**, `npm run typecheck` exit 0; `git diff --check` không lỗi whitespace. Review độc lập đọc code/test không còn blocker có bằng chứng.

```powershell
# Chạy tại D:\pdfcompare\desktop
npx vitest run src/components/AcrobatViewer.autoTrimCommit.test.tsx src/lib/revisionScopedPdfUpload.test.ts src/hooks/useWorkingPdf.test.tsx src/hooks/viewer/usePdfLoader.test.tsx src/lib/workspaceHistory.test.ts src/lib/sourceImageRevision.test.ts src/lib/recipe/RecipeRecorder.test.ts src/lib/recipe/unrecordedCommit.test.ts src/components/impositionSaveArtifactGuard.integration.test.tsx src/components/ImpositionTab.stickerSourceRevision.test.tsx src/components/ImpositionTab.fileOpening.test.ts src/components/ImpositionTab.panelResize.test.tsx
npm run typecheck
```

Test dùng host/store/materializer/lease thật và bytes PNG/PDF thật; HTTP, native I/O và PDF.js được mock. Metadata test chứng minh reload, không chứng minh kích thước renderer. Undo chạy callback hydrate/applyOrderChange production qua AST; không thay thế nghiệm thu GUI/native. History chung chưa snapshot/restore đầy đủ explicit OCG visibility; lô này chỉ chứng minh OCG thay đổi chặn response cũ, không tuyên bố sửa Undo OCG toàn hệ thống.

## Lô C — tái dùng engine kéo màu vector

Phạm vi 5 file: `backend/app/core/page_boxes.py`, `backend/app/workers/sticker_engine.py`, `backend/tests/test_page_boxes_autofill.py`, nhật ký này và master matrix.

- `auto_trim(..., mode="trim")` giữ mặc định cũ; `fill` chỉ nhận lề bổ sung 0 mm, dùng chung detector và bbox hữu hiệu. Bốn padding độc lập được truyền vào helper vector; nhánh scalar/consumer Sticker không đổi.
- Giữ mọi page box, Rotate, UserUnit, OutputIntent, annotation và vị trí/tỷ lệ artwork. Form chụp bytes Contents/tài nguyên độc lập, không dùng `as_form_xobject`; tách cả dictionary XObject để tránh tự tham chiếu.
- Helper nhận point vật lý; Matrix/CTM đổi UserUnit đúng một lần. Vành clip chẵn-lẻ không cho lớp phủ vẽ vào bbox nội dung. Bao Contents gốc bằng q/Q để CTM/clip cuối nguồn không rò sang lớp phủ.
- Lấy mẫu sâu vào mép 0,5 mm, dải mẫu 0,24 pt; không dùng độ lẹm mép. Chồng mí 0,24 pt chỉ trong adapter phủ và vẫn bị chặn bởi clip bảo vệ lõi; không đổi default của Sticker.
- Loại trang trùng, chỉ lưu sau khi mọi trang/cạnh yêu cầu đều đạt. Trang không chọn và bytes nguồn giữ nguyên. Sai mode/lề bị từ chối trước I/O engine.

### Quyết định an toàn sau thử artifact

Prototype nhận SMask giữ đúng dữ liệu nhưng render có alpha cực đại **218 thay vì 128**, và Poppler làm trắng một số góc. Ba đối chứng (knockout riêng lớp phủ; BBox nhỏ cho từng dải; bỏ Group trong artifact tạm) không giải quyết được. Không áp các thử nghiệm này vào production, không raster/flatten ngầm hoặc nới clip vào artwork để che lỗi.

**Hợp đồng lô đầu được thu hẹp có chủ đích:** fill từ chối trang có khai báo transparency và Pattern, trả lỗi có số trang, không tạo artifact, không tự chuyển sang trim. Tái dùng `detect_transparent_pages`; detector bảo thủ cả Group đục hoặc resource alpha không được gọi. Pattern được chặn qua resource walker có sẵn, bổ sung resource font Type3; đây không phải mở thêm thuật toán tô màu. Trang ngoài phạm vi có transparency/Pattern vẫn được giữ nguyên và không chặn trang đục đã chọn.

`FPDFPage_HasTransparency` đã được thử trực tiếp nhưng âm giả trên SMask/alpha; không dùng làm guard. Bộ dò/walker hiện hữu vẫn best-effort và có giới hạn duyệt cũ; chưa chứng minh mọi cấu trúc PDF bất thường. Không tuyên bố hỗ trợ Alpha hoặc mọi Pattern.

### Verify và giới hạn độ chính xác biên

Root chạy độc lập **226 passed**, 1 warning Pydantic có sẵn, 13,23 s; trong đó **79 ca mới**. Bao phủ rotation 0/90/180/270, UserUnit 0,5/1/2/4, gốc âm/dương, CropBox vượt MediaBox, viền không đều/từng cạnh, pixel lõi, tài nguyên CMYK/Separation, metadata, nguồn không đổi, subset/duplicate, lỗi atomic và guard transparency/Pattern. Test SMask ở hợp đồng cuối chứng minh từ chối an toàn và trim vẫn chạy; không gọi đây là hỗ trợ SMask.

```powershell
# Chạy tại D:\pdfcompare\backend
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_page_boxes_autofill.py tests/test_page_boxes_autotrim_visible_box.py tests/test_page_boxes_autotrim.py tests/test_mirror_bleed_origin.py tests/test_sticker_bleed_seam.py tests/test_sticker_trajectory_bleed.py
```

Fixture CMYK đồng màu, tọa độ lẻ, Rotate 90/UserUnit 2: 600 DPI giữ pixel lõi. Chồng mí giảm pixel lệch màu PDFium **6.851 → 5.373**, Poppler **4.964 → 3.936**, trên ảnh 1.667×1.250. Đường nối dài ngoài bbox giảm, **vẫn còn vệt mảnh sát bbox do lượng tử detector 200 DPI/AA**. Poppler đo ngoài bbox bằng 0 khi bỏ 2 pixel mép giấy; PDFium có halo clip cần phân biệt theo tâm pixel. Poppler build bỏ UserUnit nên probe dùng 1.200 DPI để đạt cùng kích thước pixel vật lý. Root đã mở ảnh 600 DPI trước chồng mí; số đo sau do agent triển khai báo, không suy thành nghiệm thu RIP.

Các PDF/PNG thí nghiệm nằm trong thư mục tạm `prynx_white_border_fill_k2nb8_ce`; không ghi đè evidence audit trước vá. Không tuyên bố viền trắng còn lại bằng 0 hay màu in tuyệt đối trên mọi PDF. Đây là giới hạn chất lượng phải kiểm trên PDF khách; ưu tiên không phủ mất nội dung gốc.

### Re-audit formatter trước D1

Review độc lập phát hiện `.16g` có thể sinh `1e-05` khi origin nhỏ hoặc UserUnit lớn; PDF không nhận ký pháp số mũ. Sáu fixture đã sửa nguồn sang decimal hợp lệ tái hiện **6 đỏ → 6 xanh** sau khi đổi đúng ba dòng ghi số thành `.16f`. Ca mới: origin `1e-5`, UserUnit `20.000/75.000`, Rotate `0/90`; kiểm stream, màu viền và pixel lõi. Suite C cuối **232 passed** (85 ca mới + 147 cũ), 1 warning cũ, diff-check sạch. Không đổi helper/detector/guard.

Số đo overlap cuối: PDFium 5.373 pixel lệch = 2.686 trong bbox bảo vệ + 2.687 halo clip ≤1 pixel; Poppler 3.936 = 2.686 trong bbox + 1.250 tại mép canvas. Không còn pixel lệch ở vành xa bbox sau khi loại halo ≤1 pixel và 2 pixel mép giấy. Đây là số đo fixture đồng màu, không phải bảo đảm mọi tài liệu.

## Lô D1 — API hai chế độ và xác nhận chế độ thật

Phạm vi 5 file: schema preflight, route preflight, `test_api_contract.py`, `test_auto_trim_route.py`, nhật ký này.

- Request nhận `mode: trim|fill`, mặc định trim; giữ `pages/trim_sides` legacy, lề 0–20 hữu hạn.
- Response riêng `AutoTrimResponse` kế thừa success/output_filename và bắt buộc mode không có default. Không đổi FixFileResponse của các route khác.
- Route vẫn threadpool, chuyển mode vào engine; ValueError nghiệp vụ trả 422 có lý do, file không tồn tại vẫn 404, lỗi bất ngờ vẫn 500. Quyền Free `pdf.crop` giữ nguyên.
- Baseline test API đỏ vì response cũ thiếu mode; sau vá **79 tests đạt** (16 integration route + 63 contract). Test đi qua DB UploadedFile → HTTP POST → download PDF thật → parse/render, không mock engine trừ ca lỗi500. Có fill giữ khổ/vị trí/TrimBox, subset cạnh/trang, legacy trim parity, atomic trang2 lỗi/alpha, nguồn không đổi, unknown/invalid mode và cả hai mode dưới Free override có bật gate thật.

```powershell
# Chạy tại D:\pdfcompare\backend
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_auto_trim_route.py tests/test_api_contract.py
```

Ba warning dependency hiện có (Starlette/httpx/anyio và Pydantic); không thay dependencies. Test response-model exact của các endpoint khác vẫn giữ, không nới assertion thành subclass cho cả nhóm.

### Lô D2 — request/echo fail-closed ở parent

Phạm vi 4 file: `desktop/src/components/ImpositionTab.tsx`, `desktop/src/components/AcrobatViewer.autoTrimCommit.test.tsx`, nhật ký này và master matrix.

- Request luôn gửi `mode` (mặc định `trim`); fill ép `margin_mm=0` từ Viewer ở lô E.
- Fill yêu cầu response có `mode="fill"`; thiếu hoặc sai mode dừng trước download và commit, báo khởi động lại PrynX. Trim chấp nhận response legacy thiếu mode nhưng từ chối echo `fill`.
- Các guard lease/revision/recording/tab và Undo của lô B giữ nguyên.

Verify lô D2: **34/34 test mới đạt**, mở rộng **12 file / 137 tests đạt**, `npm run typecheck` exit 0. HTTP/PDF/native I/O vẫn mock ở ranh giới; chưa phải click-test Tauri.

### Lô E — lựa chọn UI và i18n

Phạm vi: `desktop/src/components/AcrobatViewer.tsx`, `desktop/src/components/AcrobatViewer.autoTrimCommit.test.tsx`, `desktop/src/i18n/locales/vi.json`, `desktop/src/i18n/locales/en.json` và phần parent đã nối ở D2.

- Mặc định là **Xóa viền**; lựa chọn **Phủ màu theo biên** gửi `mode="fill"` và ép `marginMm=0`, ẩn ô lề bổ sung không áp dụng.
- Fill giữ scope tất cả/trang hiện tại và cạnh đã chọn; khóa toàn bộ control khi đang xử lý; hint/cảnh báo nêu rõ giữ khổ trang/vị trí artwork và fail-closed với transparency/Pattern.
- Chuỗi hiển thị đi qua VI/EN i18n; copy toolbar/loading/error trung tính, không khẳng định viền liền màu tuyệt đối.

Verify: **41 test tập trung đạt**, mở rộng **13 file / 144 tests đạt**, `npm run typecheck` exit 0. Đây là test DOM/contract với HTTP/native boundary mock; chưa phải click-test Tauri.

## Cổng nghiệm thu còn lại

Không gọi nguyên chuỗi Resize; các finding Resize §WBR28.04–05 vẫn mở. Chưa kiểm Tauri runtime, installer, PDF khách hoặc RIP/bản in. Seam anti-aliasing/lượng tử gần bbox còn giới hạn đã đo ở fixture; cần kiểm tay artifact trên PDF khách trước khi tuyên bố hoàn tất sản phẩm.
