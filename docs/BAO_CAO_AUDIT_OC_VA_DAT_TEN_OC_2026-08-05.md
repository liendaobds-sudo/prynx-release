# Báo cáo audit tạo ốc và đặt tên ốc — Bình Tem Bế / CNC

> Ngày audit: 2026-08-05
> Baseline: commit `51c2397`, branch `codex/pre-release-audit-2026-08-04`
> Audit unit: `W2-U02-OC`
> Mức bằng chứng: `ARTIFACT` cho các nhánh đã liệt kê; chưa có `RUNTIME` trên app cài đặt
> Trạng thái sửa: **đã sửa và verify tự động/artifact**; chưa smoke app cài đặt/cắt máy

## 1. Kết luận điều hành

**Ba finding §OC.1–§OC.3 đã được xử lý; phạm vi hiện đạt mức `ARTIFACT`, chưa phải `RUNTIME`.**

- Bình Tem Bế thường và Bình Nguyên Tấm Decal đã tạo đúng 4 ốc, giữ đúng `itemName`, tên layer/group/Graphtec và xử lý đúng tùy chọn có/không có ốc trên trang khuôn trong các artifact đã kiểm.
- Ba hình ốc `circle`, `l_corner`, `l_inverted` đều được tạo trong artifact Bình Tem Bế.
- CNC 1 mặt và 2 mặt tạo đúng ốc ở mặt trước, không tạo ở mặt sau 2 mặt, giữ `itemName` và cây OCG Graphtec/layer/group trên Front/Cut.
- Frontend và backend cùng chặn shape/số/tên/lề/guide không hợp lệ; engine không còn xuất thành công với ốc 0 mm hoặc tên rỗng.
- Hợp đồng CNC đã chốt: luôn vẽ ốc ở Front + Cut, không ở Back; frontend không gửi `pontsOnCutFile` sang CNC.

Phần còn thiếu trước khi dùng làm release gate là smoke app thật, mở bằng Illustrator/Graphtec Studio và kiểm multi-unit/cắt máy; xem fixes log `OC_VA_DAT_TEN_OC_FIXES_2026-08-05.md`.

## 2. Phạm vi và bất biến đã kiểm

Phạm vi audit:

1. UI chọn loại ốc, cấu hình hình/kích thước/độ dày/lề/tên.
2. Store, preset/profile và payload preview/export.
3. Route backend, chuẩn hóa cấu hình và nhánh render.
4. PDF đầu ra: số trang, số ốc, kích thước vector, marked-content `/NM`, OCG `/Name`.
5. Bình Tem Bế thường, tách trang khuôn bật/tắt, Bình Nguyên Tấm Decal, CNC 1 mặt/2 mặt, tên Unicode/ký tự đặc biệt và đầu vào biên.
6. Va chạm vùng cấm ốc, parity preview/output và cut-export naming qua các test hiện có.

Bất biến dùng để đánh giá:

- Bật ốc phải tạo 4 dấu hữu hình ở bốn góc với kích thước dương và hữu hạn.
- Mỗi ốc phải giữ đúng `itemName` khi người dùng yêu cầu đặt tên.
- Nếu UI cho nhập layer/group/Graphtec thì artifact phải giữ đúng các tên đó, hoặc UI phải nói rõ chế độ không hỗ trợ.
- Bình Tem Bế tách trang khuôn phải luôn có ốc ở trang in; trang khuôn chỉ có ốc khi `pontsOnCutFile=true`.
- CNC 2 mặt không có ốc ở mặt sau theo quy ước hiện hành trong `cnc_render.py`.
- Giá trị rỗng/0/âm/không thuộc enum phải bị từ chối hoặc chuẩn hóa minh bạch, không được xuất PDF “thành công” nhưng sai âm thầm.

Ngoài phạm vi: Guillotine thường, vì capability hiện hành cố ý không hỗ trợ ốc; kiểm cắt vật lý trên máy Graphtec/CNC; smoke app release đã cài đặt.

## 3. Trace dọc luồng sống

| Tầng | Điểm sống | Kết quả trace |
|---|---|---|
| UI | `desktop/src/components/imposition-tools/sections/AdvancedSettingsSection.tsx:287-335` | Cùng một bộ chọn/cấu hình ốc được dùng cho Sticker và CNC. |
| Dialog | `desktop/src/components/imposition-tools/PontSettingsDialog.tsx:8-24, 201-230` | Cho nhập Graphtec/layer/group/item/size/thickness nhưng không validate trước khi lưu. |
| Hợp đồng TS | `desktop/src/components/imposition-tools/types.ts:31-57, 483-498` | `PontConfig` đầy đủ; capability bật ốc cho `diecut` và `cnc`. |
| Store/profile | `desktop/src/components/imposition-tools/store/slices/marksSlice.ts:42-46, 82-85`; `store/profiles.ts:20-24` | Persist cả `pontConfig`, `pontsOnCutFile`; profile có thể đưa lại giá trị cũ vào CNC. |
| Payload | `desktop/src/components/imposition-tools/ImposerDashboard.tsx:1059, 1311-1314`; `desktop/src/lib/processHandlers.ts:167-198` | Sticker và CNC đều gửi PontConfig; `pontsOnCutFile` cũng được gửi cho cả hai. |
| Route/schema | `backend/app/api/routes/imposition.py:737-740, 957-970, 3387-3412` | Final settings là `dict`; preview nhận `Optional[Dict[str, Any]]`; không có schema/range/name validation cho PontConfig. |
| Sticker writer | `backend/app/workers/nup_process_chunk.py:988-1042, 1235-1253, 1425-1438` | Tạo Graphtec/die/layer/group OCG, đặt `itemName`, và tôn trọng `pontsOnCutFile`. |
| CNC writer | `backend/app/workers/cnc_render.py:167-251, 254-264` | Gọi helper vẽ trực tiếp trên front/cut; không tạo OCG và không đọc layer/group/Graphtec hoặc `pontsOnCutFile`. |
| Mark writer | `backend/app/workers/nup_marks.py:14-72` | Vẽ 4 mark; hỗ trợ 3 shape; không validate size/thickness/shape/name. |
| Tên object PDF | `backend/app/workers/pdf_ops.py:150-224` | Khi `item_name` có giá trị, ghi marked-content và `/NM`; tên rỗng thì bỏ metadata tên. |

Hợp đồng Rust sinh type chỉ có `shape/size/thickness/disable_collision` tại `imposition_core/src/model.rs:177-183`, trong khi UI dùng interface riêng đầy đủ hơn. Type Rust/generated hiện không nằm trên đường chạy sống, nên đây là drift cần dọn nhưng chưa được xếp là bug runtime độc lập.

## 4. Ma trận artifact thực tế

Các PDF dưới đây được tạo trực tiếp từ engine hiện tại rồi mở lại bằng `pikepdf` và parser vector của PrynX.

| Ca kiểm | Kết quả artifact | Đánh giá |
|---|---|---|
| Sticker thường, ốc tròn, không tách trang khuôn | 1 trang; 4 object `/NM=AUDIT_ITEM`; đủ OCG Graphtec/layer/group | PASS |
| Sticker thường, `l_corner` | 4 object được đặt tên; 4 vector L kích thước 5 mm | PASS |
| Sticker thường, `l_inverted` | 4 object được đặt tên; 4 vector L kích thước 5 mm | PASS |
| Sticker tách trang khuôn, `pontsOnCutFile=false` | Trang in 4 ốc; trang khuôn 0 ốc; Graphtec + die OCG | PASS |
| Sticker tách trang khuôn, `pontsOnCutFile=true` | Trang in 4 ốc; trang khuôn 4 ốc có `/NM`; đủ layer/group trên trang khuôn | PASS |
| Bình Nguyên Tấm Decal, toggle false/true | Test artifact hiện có xác nhận trang in luôn 4; trang khuôn 0/4; `/NM=MKLINE` | PASS |
| Sticker với tên Unicode và ký tự `/`, `#` | Layer/group/item giữ nguyên `LỚP ỐC / 01`, `NHÓM ỐC #1`, `ỐC ĐỊNH VỊ / #1` | PASS |
| CNC 1 mặt, Graphtec + tên tùy chỉnh | `[Front, Cut]`; mỗi trang 4 ốc 5 mm; `/NM=AUDIT_ITEM`; danh sách OCG rỗng | **FAIL layer/group/Graphtec** |
| CNC 2 mặt, Graphtec + tên tùy chỉnh | `[Front, Back, Cut]` có số ốc `4/0/4`; `/NM` đúng ở Front/Cut; danh sách OCG rỗng | **FAIL layer/group/Graphtec** |
| CNC 1/2 mặt với `pontsOnCutFile=false` | Trang khuôn vẫn có 4 ốc | **MISMATCH hợp đồng field** |
| `itemName=""` | Vẫn có 4 vector ốc nhưng 0 marked-content `/NM` | **FAIL đặt tên âm thầm** |
| `layerName/groupName=""` ở Sticker | PDF vẫn xuất; OCG chứa hai tên rỗng | **FAIL validation** |
| `size=0` | PDF vẫn xuất; 4 path có bounding box `0 × 0 pt` | **FAIL: ốc vô hình** |
| `size=-1` | PDF vẫn xuất; 4 path thành kích thước tuyệt đối khoảng `1 × 1 mm` thay vì bị từ chối | **FAIL validation/ngữ nghĩa** |

## 5. Findings đã xác nhận

### §OC.1 — P1 — CNC làm mất tên layer/group/Graphtec

**Trạng thái:** `[CONFIRMED → FIXED 2026-08-05]` · Likelihood `M` · Impact `H`

Điều kiện: chọn công cụ CNC, bật ốc tùy chỉnh, nhập `layerInfoName/layerName/groupName/itemName`, rồi xuất PDF.

Kết quả: `itemName` được giữ, nhưng root PDF không có OCG tương ứng; layer Graphtec, layer ốc và group ốc đều mất. Hai artifact CNC 1 mặt và 2 mặt đều tái hiện giống nhau.

Nguyên nhân: `cnc_render.py:194-196, 247-249` gọi `_draw_ponts_on_page` trực tiếp mà không tạo/truyền `ocg_xref`; module không đọc ba field layer/group và hai field Graphtec.

Ảnh hưởng: người dùng thấy một bộ trường đặt tên giống Bình Tem Bế nhưng file CNC không giữ cấu trúc tên cần cho Illustrator/Graphtec/quy trình hậu kỳ. Đây là sai hợp đồng trên đầu vào bình thường.

**Kết quả sửa:** renderer CNC tạo Graphtec/layer/group OCG và truyền group OCG + `itemName` vào cả Front/Cut. Artifact regression kiểm `/OCProperties`, `/Order` và `/NM` đã đạt cho CNC 1/2 mặt.

### §OC.2 — P1 — PontConfig không được validate, cho phép xuất ốc vô hình/không tên

**Trạng thái:** `[CONFIRMED → FIXED 2026-08-05]` · Likelihood `M` · Impact `H`

Điều kiện: để trống tên item/layer/group hoặc nhập size bằng 0/số âm trong dialog hay profile.

Kết quả artifact:

- `itemName=""`: vector vẫn tồn tại nhưng hoàn toàn không có `/NM`.
- layer/group rỗng: PDF có OCG tên rỗng.
- `size=0`: engine báo thành công nhưng tạo path `0 × 0 pt`, tức ốc vô hình.
- `size=-1`: engine báo thành công và tạo hình khoảng 1 mm do bán kính âm bị chuẩn hóa ngầm trong thư viện.

Nguyên nhân: input số gọi `Number(e.target.value)` và Save trực tiếp; route dùng `Dict[str, Any]`; writer nhân giá trị rồi vẽ mà không kiểm tra hữu hạn/phạm vi/tên bắt buộc.

Ảnh hưởng: lỗi sản xuất có thể chỉ lộ khi mở file/cắt máy; API vẫn trả thành công nên người dùng không có cảnh báo.

**Kết quả sửa:** validator chung được áp tại dialog, preview schema, route tạo job và engine. Ca rỗng, 0/âm, NaN, shape sai, tên rỗng và guide sai đều có regression test.

### §OC.3 — P2 — `pontsOnCutFile` có hai hợp đồng khác nhau ở CNC

**Trạng thái:** `[CONFIRMED → FIXED 2026-08-05]` · Likelihood `L` · Impact `M`

Frontend persist/profile và payload coi `pontsOnCutFile` là field chung cho Sticker/CNC. Renderer CNC không đọc field, đồng thời comment module quy định CNC luôn vẽ ốc ở Front + Cut. Artifact với `false` vẫn có 4 ốc trên trang khuôn ở cả CNC 1 mặt và 2 mặt.

Đây là drift hợp đồng, không khẳng định quy tắc “luôn có ốc trên Cut” là sai. Cần chọn một trong hai hướng trước khi sửa:

1. Giữ quy tắc CNC luôn Front + Cut: không gửi/không persist field này cho CNC và khóa bằng test; hoặc
2. Cho CNC hỗ trợ toggle giống Sticker: renderer phải tôn trọng `false` và UI phải hiển thị tùy chọn rõ ràng.

Khuyến nghị mặc định: giữ quy tắc hiện hành Front + Cut, vì comment nghiệp vụ trong CNC nêu rõ và UI hiện không hiển thị toggle này; dọn payload/profile để không tạo kỳ vọng giả.

**Quyết định đã triển khai:** giữ CNC luôn Front + Cut. Dashboard/process handler không còn serialize field này cho CNC; test payload và artifact khóa hai đầu hợp đồng.

## 6. Hành vi đã bác bỏ là bug

- `[EXPECTED]` CNC 2 mặt không vẽ ốc ở mặt sau: code quy định ốc chỉ dành cho mặt trước và trang khuôn; artifact đạt `4/0/4`.
- `[EXPECTED]` Sticker tách trang khuôn vẫn vẽ ốc trên trang in nhưng không gắn OCG layer ở trang in: mục đích là để ốc in trực tiếp; `itemName` vẫn được giữ.
- `[DISPROVED]` Tên Unicode hoặc ký tự `/`, `#` tự làm hỏng PDF Sticker: artifact mở lại và giữ nguyên cả layer/group/item.
- `[DISPROVED]` `pontsOnCutFile=false` của Sticker bị bỏ qua: cả Sticker thường và Page Sheet đều cho 0 ốc trên trang khuôn như mong đợi.

## 7. Test đã chạy và khoảng trống còn lại

Kết quả verify sau sửa:

- Backend full: **2.302 passed, 4 skipped**; 5 regression route/shape thêm sau full suite đạt **20/20** trong file đích.
- Frontend full: **195 test file; 1.893 passed, 2 skipped**.
- Typecheck và lint budget đạt; ESLint riêng validator/test mới đạt.
- Regression mới kiểm validation UI/backend, cả ba shape, CNC OCG/order/item, số ốc `4/4` và `4/0/4`, cùng payload CNC không có `pontsOnCutFile`.

§OC.1–§OC.3 hiện đã có assertion tự động và artifact mở lại. Chi tiết lệnh/kết quả ở `OC_VA_DAT_TEN_OC_FIXES_2026-08-05.md`.

Khoảng trống trước khi có thể tuyên bố “mọi trường hợp”:

- Chưa có ma trận tự động 3 shape × Sticker/CNC × tách trang khuôn × Graphtec.
- Chưa kiểm multi-sheet tên OCG/suffix bằng artifact.
- Chưa smoke trên app thật và chưa mở file bằng Illustrator/Graphtec Studio/CNC workflow thực tế.
- Chưa cắt vật lý để xác nhận độ dày, registration color và vị trí ốc theo máy.

## 8. Kết quả triển khai

### Lô 1 — Khóa hợp đồng và validation

- Hoàn thành validator PontConfig dùng chung ở backend cho preview/final/engine.
- Hoàn thành validation dialog và thông báo i18n; Save/preset bị chặn khi sai.
- Hoàn thành test biên để không còn silent-success.

### Lô 2 — Hoàn thiện tên ốc CNC

- Hoàn thành cấu trúc OCG Graphtec → layer ốc → group ốc ở Front/Cut.
- Hoàn thành `itemName`, semantics Front + Cut và artifact test CNC 1/2 mặt.

### Lô 3 — Ma trận hồi quy và runtime

- Phủ ba shape, Unicode, separate cut, Page Sheet, CNC, multi-sheet, collision on/off.
- Typecheck, full Vitest, full Pytest và lint budget đã đạt.
- Smoke app thật và mở artifact bằng công cụ downstream trước khi nâng `W2-U02-OC` lên `RUNTIME`.

Code và test đã hoàn thành sau khi người dùng duyệt; runtime/downstream smoke vẫn là bước kế tiếp.
