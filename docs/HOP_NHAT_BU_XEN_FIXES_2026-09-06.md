# Nhật ký triển khai hợp nhất Bù xén - Tạo đường cắt lần 2

**Kế hoạch:** `KE_HOACH_HOP_NHAT_BU_XEN_TAO_DUONG_CAT_LAN2_2026-09-06.md`

**Trạng thái:** Đã triển khai và commit luồng workspace chung, thiết lập bù xén, vòng đời nhận diện, nhận file và recipe giới hạn; kiểm thử tự động đạt. Characterization toàn bộ artifact và nghiệm thu app Tauri còn thiếu bằng chứng runtime.

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
