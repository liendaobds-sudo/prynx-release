# Audit Trim & Shift (phạm vi đã chốt)

> Ngày: 2026-08-24  
> Luồng kiểm: một trang PDF đã bình → chia dọc/ngang thành 2–3 mảnh → đặt lề trắng riêng cho từng mảnh → xuất mỗi mảnh thành trang mới để bình lại.  
> Báo cáo baseline trước bản vá; phần triển khai đã được ghi ở mục **Follow-up triển khai** bên dưới.

## Kết luận

Trim & Shift hiện không có capability mà luồng này cần. Đây là thiếu contract xuyên suốt công cụ, không phải lỗi thao tác người dùng:

- UI chỉ có trim bốn cạnh, shift X/Y, binding, creep, mirror, clip/original, keep bleed và phạm vi trang.
- Không có trục chia, số mảnh, rectangle mảnh, thứ tự mảnh hay margin theo từng mảnh.
- Handler/API chỉ gửi các giá trị scalar và nhận một Blob PDF.
- Engine chỉ sửa các trang đã tồn tại; không clone/insert/append page. Vì vậy một trang đầu vào luôn vẫn là một trang đầu ra.
- Nới box không vẽ nền trắng đục; vùng mới là vùng không có nội dung (viewer thường tô nền trắng). Nếu yêu cầu là trắng thật khi compositing/bình lại, cần white-fill rõ ràng.

## Trace có bằng chứng

### UI/state

- [TrimShiftTool.tsx](/D:/pdfcompare/desktop/src/components/preprocess-tools/TrimShiftTool.tsx:22) khai báo `TrimShiftSettings` chỉ với `trimTop/Bottom/Left/Right`, `shiftX/Y`, binding, creep, mirror, content mode, `keepBleed`, `applyToStr`.
- Các ô cạnh nằm tại [TrimShiftTool.tsx](/D:/pdfcompare/desktop/src/components/preprocess-tools/TrimShiftTool.tsx:106); phạm vi `all/even/odd/custom` tại [TrimShiftTool.tsx](/D:/pdfcompare/desktop/src/components/preprocess-tools/TrimShiftTool.tsx:126).
- Router chỉ render một form Trim/Shift, checkbox mở tab và nút chạy tại [PreprocessingRouter.tsx](/D:/pdfcompare/desktop/src/components/imposition-tools/sections/PreprocessingRouter.tsx:208).
- State mặc định không có field split/piece tại [preprocSlice.ts](/D:/pdfcompare/desktop/src/components/imposition-tools/store/slices/preprocSlice.ts:48).

### Handler/API/route

- Handler đổi đơn vị sang mm và serialize trim/shift/binding/creep/mirror/content/keepBleed tại [processHandlers.ts](/D:/pdfcompare/desktop/src/lib/processHandlers.ts:1198); sau đó nhận Blob và commit hoặc mở một PDF tại [processHandlers.ts](/D:/pdfcompare/desktop/src/lib/processHandlers.ts:1226).
- API chỉ gửi `file`, `apply_to`, `config` tại [api.ts](/D:/pdfcompare/desktop/src/lib/api.ts:1181).
- Route nhận cùng ba dữ liệu, gọi một lần `trim_shift`, trả một `FileResponse` tại [pdf_tools.py](/D:/pdfcompare/backend/app/api/routes/pdf_tools.py:958).

### Engine/writer

- Chữ ký engine chỉ có tham số trim/shift/binding/creep/mirror/content/keep bleed tại [trim_shift_engine.py](/D:/pdfcompare/backend/app/workers/trim_shift_engine.py:197).
- Engine resolve các page index hiện có rồi loop `page = pdf.pages[idx]` tại [trim_shift_engine.py](/D:/pdfcompare/backend/app/workers/trim_shift_engine.py:244).
- Phần xử lý trim chỉ gán `MediaBox`/`CropBox` tại [trim_shift_engine.py](/D:/pdfcompare/backend/app/workers/trim_shift_engine.py:272); box Trim/Bleed/Art chỉ đổi khi `keep_bleed=true` tại [trim_shift_engine.py](/D:/pdfcompare/backend/app/workers/trim_shift_engine.py:290).
- Không có phép chia rectangle, không tạo page mới, không có output order, không có per-piece margin.

## Findings

| Mã | Mức | Finding |
|---|---:|---|
| `§TRIM.F1` | P1/M | Không thể chia một trang theo dọc/ngang thành 2–3 trang mảnh trong Trim & Shift. |
| `§TRIM.F2` | P1/M | Không có margin riêng cho từng mảnh; đặc biệt không biểu diễn được lề phải của mảnh trái/lề trái của mảnh phải. |
| `§TRIM.F3` | P1/M | Writer giữ nguyên page cardinality, nên không thể xuất kết quả để bình lại theo từng mảnh. |
| `§TRIM.F4` | P1/M | “Lề trắng” hiện chỉ là page box mở rộng; không có white-fill đục. Artifact RGBA với nền trong suốt cho góc lề `[0,0,0,0]`. |
| `§TRIM.F5` | P1/M | Media/Crop và TrimBox có thể biểu diễn hai khổ khác nhau (`keepBleed=false` mặc định); cần box policy tường minh cho kết quả dùng để bình lại. |
| `§TRIM.F6` | P2/S | `custom` rỗng có thể tạo output no-op: `_resolve_pages()` trả tập rỗng nhưng route vẫn lưu/trả file. |
| `§TRIM.F7` | P2/S | Không có preview số mảnh, thứ tự, kích thước sau lề hoặc box/background policy. |

## Artifact/test evidence

Artifact probe một PDF 1 trang chạy Trim +10 mm mỗi cạnh:

```text
input_pages  = 1
output_pages = 1
Media/Crop   = [-28.346457, -28.346457, 228.346457, 128.346457] pt
RGBA corner  = [0, 0, 0, 0]  # vùng lề không có white paint
```

- `backend/tests/test_trim_shift.py`: **25 passed, 1 warning**.
- Test hiện có bao phủ trim/shift/binding/creep/rotate/mirror/clip/keep-bleed/apply-to; chưa có test split axis/count, page count tăng, piece order, per-piece margin hoặc white opacity.
- `tsc --noEmit -p desktop/tsconfig.app.json`: **passed**.
- Tauri runtime thao tác thật: chưa xác minh; mức bằng chứng dừng ở `ARTIFACT + AUTO`.

## Contract đề xuất cho chính Trim & Shift

```text
split.enabled       = true
split.axis          = vertical | horizontal
split.count         = 2 | 3
split.pieces[]      = { left, right, top, bottom }  # mm, riêng từng mảnh
split.order         = natural (dọc: trái→phải; ngang: trên→dưới)
split.background    = opaque_white
split.boxPolicy     = canonical Media/Crop/Trim/Bleed/Art = output page
```

Engine cần dựng rectangle theo hệ tọa độ hiển thị, tạo page mới cho từng mảnh theo thứ tự ổn định, vẽ nền trắng đục, clip/nạp nội dung nguồn, cộng padding riêng rồi ghi box canonical. Quy tắc áp `shift`, binding và creep trước/sau split phải được ghi rõ trong contract.

Đề xuất sửa sau khi được duyệt: lô UI/state + handler; lô route/engine writer; lô regression artifact cho 2/3 mảnh dọc/ngang, lề trái/phải khác nhau, rotate và box lệch nhau. Mỗi lô tối đa 5 file và verify riêng.

**Kết luận:** Trim & Shift không bị loại bỏ; chính nó cần được mở rộng để thực hiện trọn luồng tách mảnh + lề mà người dùng yêu cầu.

## Follow-up triển khai (2026-08-24)

Đã triển khai đúng contract trong chính Trim & Shift:

- UI có chế độ **Tách mảnh để bình lại**, chọn dọc/ngang và 2/3 mảnh.
- Mỗi mảnh có bốn ô lề riêng; lề được đổi sang mm ở handler.
- Engine thay trang được chọn bằng các trang con theo thứ tự ổn định, clip đúng rectangle, vẽ nền trắng đục, và đặt Media/Crop/Trim/Bleed/Art đồng nhất trên khổ kết quả.
- Trang không được chọn giữ nguyên vị trí; /Rotate được bake về 0 trước khi chia.
- Custom range rỗng bị từ chối thay vì trả file no-op.

Bằng chứng sau bản vá:

- backend/tests/test_trim_shift.py + backend/tests/test_trim_shift_split.py: **33 passed, 1 warning**.
- desktop typecheck (tsc --noEmit -p tsconfig.app.json): **passed**.
- Frontend handler/store regression: **71 passed**.
- Artifact PDFium: lề mảnh trái/phải trả RGBA (255,255,255,255), không còn alpha trong suốt.
