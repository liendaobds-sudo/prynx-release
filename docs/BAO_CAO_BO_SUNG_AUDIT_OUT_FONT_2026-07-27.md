# BỔ SUNG AUDIT `OUTLINE_FONTS` / OUT FONT

**Ngày:** 2026-07-27  
**Báo cáo gốc:** `docs/BAO_CAO_AUDIT_GS_REPLACEMENT_ENGINE_2026-07-27.md`  
**Phạm vi:** đường live từ UI “Khóa Font” tới backend, bộ chuyển native fontTools, chốt verify PPE và fallback Ghostscript.  
**Trạng thái:** chỉ audit và dựng fixture đối kháng; chưa sửa hành vi sản phẩm.

## 1. Điều chỉnh phạm vi theo quyết định chủ dự án

Telemetry “≥95% job/30 ngày” **không còn là tiêu chí chặn** của đợt audit này. Finding telemetry §4.2 và Lô B trong báo cáo gốc được coi là **đã rút khỏi phạm vi**, không đề xuất triển khai thêm.

Điều chỉnh này không đổi kết luận giữ Ghostscript fallback, vì riêng `OUTLINE_FONTS` đã có lỗi correctness độc lập được xác minh dưới đây.

## 2. Kết luận ngắn

`OUTLINE_FONTS` có implementation thật và 12 test tập trung đang xanh, nhưng hiện tại **chưa được phép mô tả là “an toàn 100%”**.

Hai lỗi P0 đã tái hiện được:

1. Native có thể trả `supported=True`, `warnings=[]` dù **không outline glyph nào và output vẫn còn nguyên text sống** trong Form XObject.
2. Native đổi sai text rendering mode (ví dụ stroke thành fill), còn chốt verify có thể chấp nhận sai lệch nhỏ trên trang 1 và **không kiểm bất kỳ trang nào sau trang 1**.

Do đó, mệnh đề trong kế hoạch rằng chốt verify hiện tại “chặn mọi kết quả sai” là **không đúng với implementation đang chạy**.

## 3. Đường live và hiện trạng thật

Đường gọi đang dùng thật:

`PreflightTool/PreflightTab` → `POST /api/preflight/fix` → `ActionEngine.execute()` → `_action_outline_fonts()` → `outline_text.outline_fonts()` → nếu native từ chối thì fallback Ghostscript.

Các điểm đã xác minh:

- Bộ out font hiện tại là **Python + pikepdf + fontTools**, chưa dùng PPE để thu thập glyph outline.
- Không có binding hoặc symbol `ppe_text_outlines`/`glyph_run` trong `print_engine`, `native` hay backend. Thiết kế PPE collector ở §19.7 mới là đề xuất, chưa triển khai.
- Native hỗ trợ có điều kiện: font đã nhúng dạng simple `/FontFile2`, `/FontFile3` CFF/OpenType và Type0 `/Identity-H` + `/CIDFontType2`. Nó chủ động loại Type3, Identity-V, Type1 `/FontFile` và các CMap ngoài phạm vi.
- Con số **22/33 corpus** là số ghi trong kế hoạch; không thể tái lập từ checkout vì corpus 33 PDF không nằm trong repo.
- Khi native trả `supported=True`, `ActionEngine` nhận ngay là thành công tại `backend/app/core/action_engine.py:717-723`; đường này không chạy `count_live_text()` hậu kiểm.
- UI đang ghi “Chữ → Vector (An toàn 100%)” và “đảm bảo an toàn 100%” tại `desktop/src/components/PreflightTab.tsx:37` và `desktop/src/components/preprocess-tools/PreflightTool.tsx:50`.

## 4. Phát hiện có bằng chứng

### §4.1 — [VERIFIED] P0: Form XObject có thể bị bỏ qua nhưng action vẫn báo thành công

**Nguyên nhân code:** trong `_outline_document()`, nếu trang không có `/Resources/Font`, vòng lặp `continue` ngay tại `backend/app/core/outline_text.py:993-999`. Vì vậy `_outline_forms()` ở `:1005-1010` không chạy, dù chính Form XObject có `/Resources/Font` riêng và chứa text.

**Fixture đối kháng:** một trang chỉ gọi `/Fm Do`; trang không có `/Font`, Form `/Fm` có font TrueType nhúng và chuỗi `FORMTEXT`.

Kết quả thực thi:

```text
result = {'supported': True, 'glyphs': 0, 'warnings': []}
live text trước = 8 ký tự
live text sau   = 8 ký tự
Form sau xử lý vẫn còn /Font và toán tử Tj
```

Đây không phải fallback hợp lệ: native tự nhận là thành công nên Ghostscript không được gọi. Với biến thể Form dùng font chưa nhúng, cùng nhánh bỏ qua này cũng không đi qua bước cảnh báo/nhúng font của fallback.

**Ảnh hưởng:** người dùng nhận file “Khóa Font thành công” nhưng file vẫn phụ thuộc font và vẫn còn text sống.

**Yêu cầu sửa:** traversal Form phải chạy độc lập với việc trang có `/Font` trực tiếp hay không; trước khi nhận native thành công phải có hậu điều kiện không còn text sống/annotation text. Nếu hậu điều kiện không đạt, trả `supported=False` để fallback, không được báo success.

### §4.2 — [VERIFIED] P0: xử lý sai `Tr`; verify bị pha loãng và chỉ kiểm trang 1

**Nguyên nhân code:**

- `outline_content_stream()` vẽ glyph cho mọi mode trừ 3 và 7 (`outline_text.py:636-646`) nhưng sau mỗi lệnh show luôn phát toán tử fill `f` (`:754-757`).
- Vì vậy stroke-only `Tr=1` bị đổi thành fill; fill+stroke `Tr=2` mất stroke; các mode clip `Tr=4..7` không dựng đúng text clipping path.
- `_plate_stats()` gọi `facade.separations(pdf_path, 1, ...)` cố định ở **trang 1** (`outline_text.py:789-803`). `verify_outline()` vì thế không nhìn trang 2 trở đi.
- Verify dùng mean và coverage của cả trang (`:824-835`), nên lỗi cục bộ nhỏ có thể bị diện tích trắng của trang pha loãng xuống dưới ngưỡng.

**Fixture A — một trang, stroke-only 12 pt:**

```text
native result = supported=True, glyphs=5, warnings=[]
verify        = True
Black plate   = 327 pixel đổi
mean delta    = 0.0396/255
coverage diff = 0.0155 điểm %
```

Output thực tế đã đổi chữ stroke thành chữ fill, nhưng hai chỉ số toàn trang đều dưới ngưỡng nên được chấp nhận.

**Fixture B — hai trang, lỗi lớn ở trang 2:**

```text
native result       = supported=True, glyphs=7, warnings=[]
verify toàn tài liệu = True
trang 2 Black mean   = 23.3003/255
trang 2 coverage diff= 6.2298 điểm %
```

Sai lệch trang 2 vượt xa cả hai ngưỡng hiện hành (`5.0/255` và `1.5 điểm %`) nhưng vẫn lọt vì code chỉ render trang 1.

**Ảnh hưởng:** native có thể giao file thay đổi hình in mà không fallback. Đây là lỗi dữ liệu in, không phải nợ tài liệu.

**Yêu cầu sửa:** trước mắt fail-closed với mọi `Tr` chưa được triển khai đúng; verify toàn bộ trang; thêm kiểm cục bộ theo vùng/tile hoặc theo bounding box chữ để lỗi nhỏ không bị nền trắng pha loãng. Các mode clip cần regression riêng.

### §4.3 — [VERIFIED] P1: fallback GS có cảnh báo nhưng UI vẫn hứa tuyệt đối

Đường Ghostscript có các hardening tốt: thử embed trước, flatten annotation/form và đếm text sống sau xử lý. Tuy nhiên:

- Nếu font thật sự không có trong hệ thống, code vẫn outline bằng font thay thế, thêm warning rồi trả success (`action_engine.py:783-804,840-864`).
- Nếu GS còn để lại text sống, code thêm warning nhưng vẫn trả success (`:843-864`).
- Warning có được ghép vào log và UI hiển thị, nhưng lời mô tả “an toàn 100%” khiến trạng thái sản phẩm mâu thuẫn với chính cảnh báo runtime.

**Yêu cầu:** bỏ cam kết “100%”; phân biệt rõ “đã outline sạch”, “thành công có cảnh báo/font thay thế” và “không thể outline an toàn”.

## 5. Test hiện có và khoảng phủ

Đã chạy đúng từ thư mục `backend/`:

```text
venv\Scripts\python.exe -m pytest -q \
  tests/test_outline_text_native.py \
  tests/test_outline_fonts_hardening.py
→ 12 passed
```

Các test hiện có kiểm được simple TrueType, verify bắt chữ dịch 30 pt, fallback no-GS, annotation/form flatten và cảnh báo font chưa nhúng. Chúng chưa phủ:

- trang không có `/Font` nhưng Form XObject có font riêng;
- `Tr=1..7`, đặc biệt stroke và text clipping;
- tài liệu nhiều trang với lỗi ở trang sau;
- hậu điều kiện “success ⇒ không còn text sống”.

Vì vậy 12 test xanh không phủ nhận hai lỗi P0 ở trên.

## 6. Thứ tự sửa đề xuất — chờ duyệt

### Lô OUT-FONT A — correctness/fail-closed (tối đa 5 file)

1. Thêm regression cho ba fixture: Form-only font, stroke nhỏ lọt ngưỡng, lỗi lớn ở trang 2.
2. Sửa traversal Form XObject không phụ thuộc page-level `/Font`.
3. Fail-closed hoặc triển khai đúng `Tr=0..7`; không được tự đổi mọi mode thành fill.
4. Verify mọi trang và thêm hậu điều kiện không còn text sống trước khi native báo success.
5. Bỏ chữ “an toàn 100%” ở hai UI; hiển thị trạng thái có cảnh báo đúng bản chất.

### Lô OUT-FONT B — mở rộng PPE (sau khi A đã xanh)

Đánh giá lại thiết kế §19.7: PPE thu thập glyph path + Python ghi content stream. Đây là hướng giảm code font/encoding viết tay, nhưng không thay thế cho các hậu điều kiện và regression ở Lô A.

Theo workflow audit, dừng tại báo cáo và **chờ duyệt trước khi sửa code**.
