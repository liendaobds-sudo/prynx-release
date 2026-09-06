# Nhật ký triển khai hợp nhất Bù xén - Tạo đường cắt lần 2

**Kế hoạch:** `KE_HOACH_HOP_NHAT_BU_XEN_TAO_DUONG_CAT_LAN2_2026-09-06.md`

**Trạng thái:** Workspace chung đã được nối thêm custom PDF theo phản hồi người dùng; xem phần cập nhật CUSTOM cuối tài liệu. Characterization toàn bộ artifact và nghiệm thu app Tauri còn thiếu bằng chứng runtime.

Người dùng đã duyệt triển khai toàn bộ kế hoạch và yêu cầu tiếp tục, không xin duyệt lại từng lô.
Các lô vẫn được tách commit và verify; quyền tiếp tục không thay thế bằng chứng nghiệm thu thực tế.

## Lô 0 - Characterization

- Báo cáo: `BAO_CAO_CHARACTERIZATION_HOP_NHAT_BU_XEN_2026-09-06.md`.
- Desktop baseline: 9 file, 106 passed.
- Backend/native baseline dùng lại từ Lô A/B: sticker regression 197 passed; regression source/sheet/cutline/API 122 passed; Rust `imposition_core` đạt.
- Đã lập bản đồ độ phủ U0-01..U0-09 và các khoảng trống: preserve CutContour, Alpha/simple-bg, multi-shadow, multi-page/reorder, Xén vuông góc, recipe, native drop và ring 11 điểm. Đây là characterization một phần, không phải toàn bộ corpus artifact đã đạt.
- Không sửa production code.

## Lô 1 - Preview/export parity

**Commit:** `ef9d025` và `38d6c2a`.

### Thay đổi

1. Export page/common nhận `cutline_denoise` cùng fingerprint preview.
2. Route kiểm fingerprint trước khi chạy writer; frame stale trả lỗi `409` thay vì âm thầm fit lại. `38d6c2a` đặt xử lý xung đột tại đúng endpoint export và thêm regression.
3. Worker đưa denoise vào cache key và preview fallback; cache không khớp fingerprint không được dùng.
4. Store/API gửi fingerprint của cutline preview cho export page.
5. Writer cũ và route cũ vẫn giữ nguyên; đây là parity adapter, chưa đổi UI.

### Verify

- Frontend typecheck: đạt.
- Frontend store/API: 31 passed.
- Backend API/cutline preview: 95 passed trong sandbox; một ca process-pool bị `WinError 5` do sandbox, chạy lại riêng ngoài sandbox đạt 1 passed.
- PyCompile schema/route/worker: đạt.
- Lô A/B regression trước đó vẫn giữ 197 passed.
- Regression bổ sung: denoise 70 dùng cache preview đúng, không refit; thiếu cache hoặc lệch denoise trả xung đột và không ghi output.

### Chờ nghiệm thu runtime

Mở bản dev mới, tạo preview một tem/multi tem, đổi mức khử răng cưa, chờ preview hoàn tất rồi xuất
PDF/ZIP. Cần kiểm rằng file xuất không quay về đường cắt cũ. Sau đó kiểm một lần stale/retry bằng cách
đổi settings trong lúc preview đang cập nhật.

## U0-09 - Ring kín và polyline hở

**Commit:** `86d976a`.

- Backend true-shape phát `diePolylineKinds: ["ring"]`; frontend dùng metadata để đóng vòng.
- Vẫn đọc được cubic hở 11 điểm legacy; không suy ra ring chỉ từ độ dài mảng.
- Verify tại lô: backend 9 tests, GridPreview 51 tests và typecheck đạt. Không cập nhật snapshot.

## Lô 2 - Workspace và thiết lập dùng chung

`0c387f6` là shell bước đầu, vẫn đổi qua lại hai form nên chưa đạt mục tiêu UX. Phần còn thiếu đã
được triển khai trong các commit sau:

| Commit | Phạm vi | Kết quả |
|---|---|---|
| `52964a2` | settings/store và test | Di trú thiết lập, giữ tuning, nhận diện lại/hủy, quyền sửa mask, chặn xuất khi preview chưa sẵn sàng |
| `4fbc9a0` | form/panel/workspace và test | Một form đường cắt, offset, góc, lấp lỗ, bù xén và màu hiển thị trước/sau nhận diện |
| `15ea61d` | nhận file/dispatcher và test | Đăng ký theo tab đang xem, cleanup đúng chủ sở hữu, không hút file của Combine/Convert |
| `7bc80a3` | shell, recipe và test | Workspace chung mặc định; Xén vuông góc và PDF nâng cao là adapter rõ ràng; ghi/phát recipe mới |
| `21015cd` | bản dịch Việt/Anh | Nhãn, hướng dẫn và thông báo của workspace hợp nhất |

### Luồng người dùng

- Chọn nguồn chỉ chọn file, chưa tự chạy AI. Nhận diện có nút riêng; nâng cao cho phép auto,
  Alpha, nền đơn giản, AI hoặc khung trang.
- Thiết lập bù xén/đường cắt sống xuyên suốt trước nhận diện, sau nhận diện và sau xác nhận.
  `Giữ nguyên tấm`/`Tách từng tem` thể hiện ý định xuất, không nhân đôi nút crop trong form chung.
- `Bế tem nhãn` và `Xén vuông góc` luôn có bộ chọn mục tiêu riêng. Xén vuông góc dùng adapter cũ,
  không bị effect của workspace đẩy trở lại chế độ tem.
- `Tùy chọn PDF nâng cao` giữ chọn đối tượng PDF, artwork PDF gốc và workflow/recipe cũ. Có cảnh
  báo raster hóa khi xuất PDF qua mask; không tuyên bố mọi nguồn đều được bảo toàn vector.
- Công cụ cọ chỉ tương tác sau khi mở sửa mask. Giữ CUT vector có sẵn thì không cho tô mask.
- Nhận diện lại giữ nguồn và thiết lập, nhưng tạo revision mask mới. Nếu đã chỉnh mask, UI cảnh
  báo trước khi bỏ các chỉnh sửa đó; không hứa chuyển nét cọ cũ sang mask mới.
- Hủy vô hiệu hóa kết quả đang chờ và dọn session; không tuyên bố dừng tức thì suy luận AI đã chạy.

### Thiết lập và xuất file

- Khóa `ps_sticker_unified_v2` đọc thiết lập legacy khi di trú. Thay đổi ở Xén vuông góc không ghi
  đè preference tem chung; phiên đã có dữ liệu không bị reset khi bật workspace mới.
- Khi chưa từng chọn crop, mặc định giữ nguyên tấm. Existing-cut chỉ tự giữ nguyên khi geometry
  tương thích (original, offset 0, bleed 0, preserve corner, không crop), tránh bỏ qua số bù xén đã nhập.
- Đổi hình học yêu cầu preview mới cho các trang nhận diện. Xuất bị chặn nếu preview thiếu/đang
  cập nhật; người dùng được hướng dẫn chờ rồi xuất lại thay vì xuất hình học chưa xem.
- File hệ thống chỉ vào workspace đang hoạt động. Một PDF hoặc nhiều ảnh được nhận; nhiều PDF
  hay PDF trộn ảnh có thông báo yêu cầu ghép/chọn lại nguồn. Native drop mới đạt mức test dispatcher,
  chưa được thao tác trong Tauri.

## Lô 3 - Recipe và tương thích

**Commit:** `7bc80a3` (cùng phần nối shell của Lô 2).

- Giữ operation `sticker_dieline`; `workflow: "unified-v2"` đi runner mới, recipe legacy đi runner cũ.
- Recipe mới lưu geometry, tuning, strategy và ý định xuất; nhận diện lại từ file đầu vào của lần
  phát, không lưu session ID/mask đông cứng của file đã ghi.
- Ghi recipe từ chối mask edits, thứ tự trang không tuần tự hoặc tuning/preserve khác nhau theo
  trang. Đây là giới hạn có thông báo, không giả vờ hỗ trợ playback các chỉnh sửa gắn với một file.
- Runner nối inspect → detect → preview → confirm → export, truyền denoise/fingerprint/DPI hai trục.
  Độ tin cậy thấp hoặc cảnh báo mất artwork dừng phát để review; cancel dùng AbortController.
- Kết quả được commit bằng bytes trước khi đóng session, không giữ `outputPath` sắp bị cleanup.
- Tests đã kiểm payload, cleanup order, cảnh báo, cancel và từ chối edits. Chưa ghi-lưu-phát recipe
  thật trong app Tauri.

## Verify tổng cuối trên code đã commit

| Kiểm tra | Kết quả |
|---|---|
| `npm run typecheck` | Đạt |
| Vitest: preprocess-tools, recipe, sticker API, incoming sources/dispatcher, i18n | 44 file, 446 tests đạt |
| Pytest: sticker sheet API, source pipeline, cutline preview, AI artwork guard, page canvas | 240 tests đạt; 2 cảnh báo Starlette/Pydantic đã biết |
| ESLint các module mới và component form/shell liên quan | Đạt |
| `git diff --check` | Đạt |

Lệnh frontend cuối:

```powershell
cd D:\pdfcompare\desktop
npx vitest run src/components/preprocess-tools src/lib/recipe src/lib/stickerSheetApi.test.ts src/lib/stickerIncomingSources.test.ts src/hooks/useIncomingFileDispatcher.test.tsx src/i18n
```

Lệnh backend cuối:

```powershell
cd D:\pdfcompare\backend
.\venv\Scripts\python.exe -X utf8 -B -m pytest -q -p no:cacheprovider tests/test_sticker_sheet_api.py tests/test_sticker_source_pipeline.py tests/test_sticker_cutline_preview.py tests/test_sticker_ai_artwork_guard.py tests/test_sticker_page_canvas.py --basetemp=../tmp/unified_sticker_final_backend
```

Backend chạy ngoài sandbox sau lỗi NamedPipe `WinError 5` của multiprocessing trong sandbox.
Không cập nhật golden snapshot; không build installer, push hoặc phát hành.

## Phần chưa có bằng chứng runtime và điều kiện dọn compatibility

- Đã thử mở Vite tại cổng 5175. Phiên trình duyệt dừng ở màn kích hoạt license và thiếu Tauri IPC
  (`invoke`/`transformCallback`), nên không dùng lần mở này để chứng nhận UX/drag-drop/export desktop.
- Không đọc khóa, không vượt xác thực. Tab và tiến trình Vite do lượt này tạo đã được đóng; cổng
  5175 không còn listener của lượt thử.
- Còn phải nghiệm thu trên app Tauri đã kích hoạt: picker/native drop nhiều tab; đổi trang,
  nhận diện lại/cancel; recipe thật; mở lại PDF/ZIP để đối chiếu toàn bộ ma trận artifact U0.
- Route cũ, enum/migration reader và adapter PDF được giữ có chủ đích ít nhất một vòng release.
  Lô 4 dọn compatibility chưa thực hiện vì điều kiện runtime/release chưa đạt, không phải code bị quên.
- Bản sửa bóng A/B `4f914f4` vẫn nguyên vẹn. Nếu cần quay lui hợp nhất, revert các commit hợp nhất
  theo thứ tự phụ thuộc, không revert bản sửa bóng hoặc các commit nesting/auth ngoài phạm vi.

## Cập nhật CUSTOM — giao diện gọn và chọn PDF trong cùng luồng

Phần này thay thế mô tả “Tùy chọn PDF nâng cao” của lô trước. Báo cáo/hợp đồng:
`BAO_CAO_AUDIT_BU_XEN_CUSTOM_PDF_2026-09-06.md`.

### Thay đổi đã triển khai

- Bỏ thẻ tóm tắt đầu panel, bộ chọn/đổi file riêng, đoạn giải thích và nút chuyển form PDF cũ.
- Một panel: nhận diện tự động/nhận diện lại; “Chọn tem” trên canvas; “Dùng phần đã chọn”; cùng
  bộ thiết lập và cách xuất. Xén vuông góc vẫn là mục tiêu hình học riêng.
- Custom nhận object ID vào session chung; preview và export cùng mask revision/fingerprint.
  Nhận diện lại thay đúng trang, tăng revision; lỗi/hủy không chủ động đóng session của sibling.
- Trong lúc chọn, bỏ overlay ảnh đã tách nền để thao tác trên PDF gốc; giữ session khi overlay
  unmount. Không để listener sửa mask nuốt thao tác chọn/sửa PDF.
- Lựa chọn ràng buộc file/generation/page/instance/order/rotation. Edit PDF dùng ID nguồn raw;
  Output Preview/Ink/Crop tiếp tục dùng working PDF. Các upload/response về muộn bị chặn.
- Giữ tấm PDF bảo toàn artwork, text, vector, profile và trạng thái OCG; chỉ thêm bleed/CUT từ
  preview. Split/ZIP dùng pipeline ảnh hiện hữu, có thông báo ngắn khi tách PDF.
- Lỗi tải asset sau publish có retry riêng, không dùng base_revision cũ. Recipe chưa có selector
  tái lập vẫn từ chối object ID gắn với file cụ thể.

### Kiểm tra và giới hạn

- Frontend cuối: 50 file / 516 tests đạt; typecheck đạt; ESLint các file thay đổi 0 lỗi, 1 warning
  có sẵn tại effect trong ImpositionTab (thiếu dependency `store`, ngoài phần sửa).
- Backend cuối: 448 tests / 7 suite đạt, 2 cảnh báo cũ Starlette/Pydantic. Lượt tổng trước
  nạp exporter trước khi helper được đổi tên trong quá trình ghép code, nên không dùng làm bằng
  chứng cuối; đã cố định code giữa các lượt verify. Test shadow artifact cũ được cập nhật theo
  contract giữ PDF gốc, đồng thời giữ oracle Alpha/CUT và thêm nhánh split để không mất độ phủ.
- File khách `test/test bu xen.pdf` vẫn có SHA-256
  `C601B12447EF362A7F9EAE77AD18630A360E8150B8E85A5174C1A1CFBD10B08B`.
- Chưa thể thay tùy ý CUT đã có khi custom chỉ chọn một phần: chưa đủ ownership nên dừng trước
  khi xóa dao của tem khác. Auto thay được CUT spot; CUT chỉ theo OCG chưa tách an toàn thì báo lỗi.
- Chưa nghiệm thu Tauri trong lượt này; không build installer, push hoặc release. Route/recipe
  legacy còn giữ bên trong, không còn cửa chuyển form trên giao diện tem.

Lệnh regression backend cuối (ngoài sandbox vì NamedPipe worker Windows):

```powershell
cd D:\pdfcompare\backend
.\venv\Scripts\python.exe -X utf8 -B -m pytest -q -p no:cacheprovider --tb=short tests/test_sticker_sheet_api.py tests/test_sticker_source_pipeline.py tests/test_sticker_cutline_preview.py tests/test_sticker_ai_artwork_guard.py tests/test_sticker_page_canvas.py tests/test_sticker_custom_pdf_export.py tests/test_sticker_engine_e2e.py --basetemp=../tmp/custom_pdf_unified_verified
```

### Commit checkpoint CUSTOM

| Commit | Phạm vi |
|---|---|
| `def061b` | Detect đối tượng PDF, revision và nhận diện lại theo trang |
| `4f647f1` | Writer PDF gốc dùng CUT/Alpha đã duyệt |
| `c908178` | Regression API và artifact giữ mảng tem |
| `c21f75e` | Fence lựa chọn theo file/trang/instance |
| `c3c1de1` | Canvas gốc, owner raw/working và hồi quy Output Preview/Ink |
| `474b4f8` | API/store custom, hủy và retry asset |
| `71dd1bf` | Một form và thao tác Chọn tem, bỏ text thừa |
| `0184c2e` | Test panel, bản dịch và recipe guard |

Các commit có phụ thuộc; quay lui cả lượt CUSTOM phải thực hiện từ mới về cũ. Không dùng reset
hard hoặc tác động các tài liệu nesting/master audit đang thay đổi ngoài phạm vi.
