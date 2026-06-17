# Implementation Plan: Edit PDF Object (`pdf-object-edit`)

## Overview

Kế hoạch triển khai theo kiến trúc đã chốt: **pikepdf = engine GHI (color-safe)**, **PDFium (pypdfium2.raw) = engine ĐỌC hình học (read-only)**, và **Object_Mapper** nối hai mô hình. Backend viết bằng **Python** (`backend/app`), frontend bằng **TypeScript/React** (`desktop/src`). Mỗi task xây trên task trước và kết thúc bằng việc wiring frontend ↔ backend ↔ preview ↔ history. Property-Based Tests canh giữ 7 thuộc tính đúng đắn trong design, đặc biệt là bảo toàn màu in.

> Chạy test bằng venv dự án `backend/venv` theo audit-rules. Các test watcher/dev-server phải chạy thủ công; dùng chế độ chạy đơn (`--run` / `pytest`) khi verify.

## Tasks

- [x] 1. Thiết lập cấu trúc module edit và data models
  - [x] 1.1 Định nghĩa data models backend cho edit
    - Tạo `backend/app/schemas/edit.py`: `ObjMeta` (id, drawIndex, type∈{text,image,vector}, bbox, matrix), `EditOp` (page, kind, targetIds, delta/scale/rotateDeg/text/image), `OpSpan` (start, end, kind, ctm, bbox, resource_name)
    - Viết validator: từ chối resize có sx/sy dẫn tới kích thước ≤ 0; chuẩn hóa tolerance bbox
    - _Requirements: 1.4, 6.5_

  - [x] 1.2 Định nghĩa TypeScript types cho frontend edit
    - Tạo file types (vd. `desktop/src/components/workspace/editTypes.ts`): `ObjType`, `ObjMeta`, `EditOp` khớp schema backend
    - _Requirements: 1.4_

- [x] 2. Geometry_Reader — liệt kê object chính xác (PDFium read-only)
  - [x] 2.1 Implement `list_objects` đọc hình học bằng PDFium
    - Tạo `backend/app/core/geometry_reader.py`: dùng `FPDFPage_CountObjects`/`FPDFPage_GetObject`/`FPDFPageObj_GetType`/`FPDFPageObj_GetBounds`/`FPDFPageObj_GetMatrix`
    - Trả `type`∈{text,image,vector} (PATH→vector), BBox bao đúng vùng ảnh (không lấy cả trang), id ổn định trong một lần liệt kê, danh sách rỗng khi không có loại nào
    - Chỉ-đọc tuyệt đối: KHÔNG `FPDFPage_GenerateContent`, KHÔNG save; áp merge_rects/giới hạn để tránh O(N²) với trang nhiều object
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 13.1, 13.3_

  - [x] 2.2 Viết unit tests cho Geometry_Reader
    - Test bbox ảnh đúng vùng (không phải cả trang), liệt kê vector type=PATH, danh sách rỗng khi thiếu loại, tolerance ≤ 1.0pt
    - _Requirements: 1.2, 1.3, 1.5, 1.7_

- [x] 3. Object_Mapper — ánh xạ object PDFium ↔ dải operator (MẤU CHỐT)
  - [x] 3.1 Implement graphics-state machine + phân đoạn OpSpan
    - Tạo `backend/app/core/object_mapper.py`: `contents_coalesce()` + `parse_content_stream`, mô phỏng stack `q/Q`, CTM tích lũy (`cm`), text-state (`BT/ET`,`Tm/Td`,`Tf`), XObject (`Do`), inline image (`BI…ID…EI`)
    - Phân đoạn thành "object vẽ": text-cluster, image `Do` (theo lần xuất hiện thứ k), vector group (path-construction → painting op) → trả danh sách `OpSpan`
    - _Requirements: 1.4_

  - [x] 3.2 Implement `map_object` đối khớp ObjMeta ↔ OpSpan + fallback an toàn
    - Đối khớp bằng (type khớp) + (bbox từ CTM ≈ bbox PDFium, tolerance ≤ 1.0pt) + thứ tự vẽ; `draw_index` chỉ là gợi ý
    - Trả `None` khi không khớp duy nhất (đa nghĩa/clip/Form XObject/inline image) để caller HỦY thao tác
    - _Requirements: 1.7, 4.7_

  - [x] 3.3 Viết unit tests cho Object_Mapper
    - Test khớp duy nhất cho text/image/vector; q/Q lồng; trả None khi đa nghĩa (kích hoạt fallback)
    - _Requirements: 1.7, 4.7_

- [x] 4. Stream_Editor — Xóa đúng object mục tiêu (color-safe)
  - [x] 4.1 Implement `delete` qua pikepdf stream surgery
    - Tạo `backend/app/core/stream_editor.py`: xóa op trong `OpSpan` (text: bỏ `Tj/TJ`; image: bỏ `Do` + dọn XObject CHỈ nếu không còn tham chiếu; vector: bỏ nhóm path+painting); KHÔNG đụng op ngoài span
    - Lưu qua `page.Contents = pdf.make_stream(unparse_content_stream(ops))`; tập rỗng → no-op; HỦY + báo lỗi nếu Object_Mapper trả None (4.7)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.7_

  - [x] 4.2 Viết property test: Xóa chỉ-đúng-mục-tiêu
    - **Property 3: Xóa chỉ loại đúng object mục tiêu (Invariant)**
    - **Validates: Requirements 3.1, 3.4**

  - [x] 4.3 Viết property test: Bảo toàn màu Untouched_Object khi xóa
    - **Property 1: Bảo toàn màu của Untouched_Object (Invariant)**
    - **Validates: Requirements 4.2, 3.4**

- [x] 5. Stream_Editor — Transform (move / resize / rotate)
  - [x] 5.1 Implement `move` (tịnh tiến) bằng bọc cô lập `q/cm/Q`
    - Chèn `q <translate(dx,dy) cm>` trước span, `Q` sau span; chuyển trục canvas(top-left)↔PDF(bottom-left) qua MediaBox; áp cùng `(dx,dy)` cho nhiều object được chọn
    - _Requirements: 5.1, 5.4, 5.5, 4.1_

  - [x] 5.2 Viết property test: Move = dịch bbox
    - **Property 2: Move = dịch bbox (Metamorphic)**
    - **Validates: Requirements 5.2**

  - [x] 5.3 Implement `resize` (anchor = góc đối diện handle)
    - `cm = T(anchor)·scale(sx,sy)·T(-anchor)`, anchor theo handle nw/ne/sw/se; từ chối thao tác nếu w hoặc h ≤ 0
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 4.1_

  - [x] 5.4 Implement `rotate` quanh tâm BBox
    - `cm = T(c)·rot(θ)·T(-c)`, c = tâm bbox; bọc cô lập `q/cm/Q`; với text ưu tiên sửa `Tm`
    - _Requirements: 7.1, 7.4, 4.1_

  - [x] 5.5 Viết property test: Rotate khả nghịch
    - **Property 6: Rotate khả nghịch (Round-trip)**
    - **Validates: Requirements 7.2**

- [x] 6. Checkpoint — Đảm bảo test pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Stream_Editor — Sửa text & Thêm object
  - [x] 7.1 Implement `editText` (xóa + chèn lại, không reflow)
    - Xóa cụm `Tj/TJ` cũ + chèn cụm mới cùng `Tf`(font)/cỡ/`Tm`(vị trí); nhúng/tham chiếu font đủ glyph cho ký tự tiếng Việt; báo lỗi + KHÔNG lưu nếu thiếu glyph và không có font dự phòng (không ghi .notdef)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 4.1_

  - [x] 7.2 Implement `add` object (text / image)
    - Text: chèn `BT…ET` với font/cỡ chọn; Image: đăng ký XObject + `Do` tại bbox; chỉ bổ sung, không sửa object cũ; nhúng font đủ glyph tiếng Việt
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 4.1_

  - [x] 7.3 Viết unit tests font fallback / thiếu glyph
    - Test báo lỗi khi font không đủ glyph (8.4); test chèn text tiếng Việt dùng font dự phòng (DejaVuSans)
    - _Requirements: 8.4, 9.3_

- [x] 8. Round-trip save & guardrail màu
  - [x] 8.1 Implement lưu ra Working_File mới (pikepdf, không ghi đè gốc)
    - Lưu kết quả ra Working_File mới; giữ nguyên tài nguyên không liên quan (XObject/font/colorspace/OCG); chỉ đổi đúng object mục tiêu
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 4.1_

  - [x] 8.2 Viết property test: Round-trip không đổi nội dung ngoài thao tác
    - **Property 4: Round-trip lưu không đổi nội dung ngoài thao tác (Round-trip)**
    - **Validates: Requirements 10.1, 10.2**

  - [x] 8.3 Viết property test: Round-trip màu CMYK/spot
    - **Property 5: Round-trip màu CMYK/spot (Round-trip)**
    - **Validates: Requirements 4.3, 4.4**

  - [x] 8.4 Viết regression test guardrail màu (spike)
    - Kiểm giữ nguyên `k` (CMYK), `scn` (spot), overprint (`OP`/`op`/`OPM`), tham chiếu `/ICCBased` qua mọi đường ghi
    - _Requirements: 4.3, 4.4, 4.5, 4.6_

- [x] 9. API routes (mở rộng cụm `/edit` hoặc nâng cấp `/preflight`)
  - [x] 9.1 Implement các endpoint edit
    - Tạo `backend/app/api/routes/edit.py`: `GET /edit/objects/{fid}/{page}` (Geometry_Reader), `POST /edit/delete`, `POST /edit/transform`, `POST /edit/text`, `POST /edit/add`; trả lỗi rõ ràng + giữ Working_File khi vượt thời gian xử lý
    - Đăng ký router vào `backend/app/main.py`
    - _Requirements: 3.6, 5.1, 6.1, 7.1, 8.1, 9.1, 9.2, 4.7, 13.4_

  - [x] 9.2 Implement `POST /edit/preview` render bằng PDFium từ bytes pikepdf
    - Render preview (read-only) từ bytes đã ghi bằng pikepdf → base64; CẤM dùng PDFium để ghi file kết quả
    - _Requirements: 12.1, 12.2, 12.3_

  - [x] 9.3 Viết integration tests preview khớp hình học
    - 1–3 ví dụ: vị trí/kích thước/hướng object đã sửa khớp tolerance ≤ 1.0pt; kết quả lưu pikepdf nhất quán với preview
    - _Requirements: 12.1, 12.3_

- [x] 10. Canvas_UI (frontend, tái dùng Selection_Mode + vdpInteraction)
  - [x] 10.1 Hit-test + overlay chọn object
    - Trong `LivePageFrame.tsx`: gọi `GET /edit/objects`, hit-test chọn object chứa điểm bấm, ưu tiên bbox diện tích nhỏ nhất; Ctrl+A chọn tất cả, Esc bỏ chọn; vẽ overlay bbox quanh object được chọn
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 10.2 Tương tác move/resize/rotate + overlay real-time
    - Tái dùng handle nw/ne/sw/se (`vdpInteraction`), thêm handle xoay; cập nhật overlay theo thời gian thực KHÔNG gọi lưu mỗi frame; gửi `EditOp` tới `/edit/transform`, nhận preview
    - _Requirements: 5.3, 6.3, 7.3, 13.2_

  - [x] 10.3 Editor text inline + overlay thêm object
    - Tái dùng `editingTextId`/`editTextContent` cho editor text tại vị trí cụm; overlay đặt object mới (text/image) tái dùng hệ overlay VDP; gửi `/edit/text` và `/edit/add`
    - _Requirements: 8.5, 9.5_

- [x] 11. Undo / Redo (history qua `commitWorkingFile`)
  - [x] 11.1 Wire history cho mọi thao tác edit
    - Mỗi thao tác (xóa/move/resize/rotate/editText/add) ghi mục lịch sử qua `commitWorkingFile`; Undo khôi phục trạng thái trước thao tác; Redo áp dụng lại
    - _Requirements: 11.1, 11.2, 11.3_

  - [x] 11.2 Viết property test: Undo/Redo idempotent theo cặp
    - **Property 7: Undo/Redo idempotent theo cặp (Round-trip)**
    - **Validates: Requirements 11.4**

- [x] 12. Tích hợp & wiring end-to-end
  - [x] 12.1 Wire luồng FE EditOp → BE routes → preview → commit
    - Nối Canvas_UI ↔ `/edit/*` ↔ preview ↔ history thành luồng hoàn chỉnh; đảm bảo kết quả lưu nhất quán hình học với preview
    - _Requirements: 10.1, 12.3_

  - [x] 12.2 Viết integration tests luồng end-to-end
    - 1–3 ví dụ: liệt kê → sửa → preview → lưu → mở lại; xác nhận chỉ object mục tiêu thay đổi
    - _Requirements: 10.1, 12.3_

- [x] 13. Final checkpoint — Đảm bảo toàn bộ test pass
  - Ensure all tests pass, ask the user if questions arise.

## Hardening sau MVP (audit follow-up)

> Các hạng mục bổ sung sau khi MVP chốt, từ audit + phản hồi sử dụng thực tế. Đều đã verify (backend 214 pass, typecheck exit 0, vitest edit 16 pass).

- [x] H1. Sửa thao tác text GRANULAR (delete/move/rotate/editText theo từng run)
  - `object_mapper`/`stream_editor`: `map_text_show_op`, `text_show_op_for_move`, `_iter_text_show_ops`, `inverse_matrix`, `_shifted_text_tm`, `_rotated_text_tm`; ghim `Tm` tuyệt đối từng run, chỉ run mục tiêu đổi (không còn xóa/di chuyển cả cụm `BT…ET`)
- [x] H2. Editor text: điền nội dung gốc + chọn font + style
  - Trích `content`/`color`/`fontName` qua PDFium; `_looks_unreliable` bỏ điền khi ToUnicode hỏng; tái dùng `FontSelector`; `chosen_font_path` nhúng font người dùng chọn; tự khớp font gốc (`pickFontForName`)
- [x] H3. Undo/Redo riêng cho object-edit + cap 30 bước
  - `objectEditPast/objectEditFuture` + `useObjectEditHistory` + wire `useViewerHotkeys`; dọn Working_File trung gian khi snapshot rời stack (`DELETE /edit/working/{fid}`)
- [x] H4. CropBox offset: `/edit/objects` trả `pageBox`; FE trừ/cộng gốc CropBox
- [x] H5. Banner cảnh báo fallback font khi `used_fallback` mà chưa chọn font
- [x] H6. Lazy trích text-props: `list_objects(include_text_props=False)` + `GET /edit/text-props/{fid}/{page}/{index}`; FE fetch lazy khi mở editor
- [x] H7. Pure-math geometry FE: `editGeometry.ts` + `editGeometry.test.ts` (16 vitest pass), refactor `LivePageFrame.tsx`
- [x] H8. CJK: xác nhận hoạt động + vá subset `.ttc` (fontNumber=0)
- [x] H9. Complex-script shaping (HarfBuzz): `text_shaping.py` (`needs_shaping`/`shape_text`), `_make_shaped_show` (nhúng full font CID=GID, `/W` theo advance); wire vào `edit_text` + `add_text`; chỉ kích hoạt cho Arabic/Thai/Indic/Hebrew (Latin/CJK/Việt giữ đường codepoint)
  - _Giới hạn v1 đã biết: advance qua `/W`, chưa xử lý x/y offset dấu chồng (Thai marks có thể lệch nhẹ); ToUnicode shaped chưa map → extraction complex-script không round-trip._
- [x] H10. Bổ sung test: PBT editText/add, integration edit→imposition, benchmark lazy vs full, `test_text_shaping.py`

## Notes

- Tasks đánh dấu `*` là tùy chọn (test) và có thể bỏ qua để ra MVP nhanh; task lõi không bao giờ tùy chọn.
- Mỗi task tham chiếu sub-requirement cụ thể để truy vết.
- Đường ghi DUY NHẤT là pikepdf; mọi nhánh PDFium chỉ đọc/render — guardrail màu (task 8.4) canh giữ CI.
- 7 property test ánh xạ trực tiếp tới 7 Correctness Properties trong design; đặt sát task implement để bắt lỗi sớm.
- Chạy test trên venv `backend/venv`; không dùng watch mode trong verify.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "3.2"] },
    { "id": 3, "tasks": ["3.3", "4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "5.1"] },
    { "id": 5, "tasks": ["5.2", "5.3"] },
    { "id": 6, "tasks": ["5.4"] },
    { "id": 7, "tasks": ["5.5", "7.1"] },
    { "id": 8, "tasks": ["7.2", "7.3"] },
    { "id": 9, "tasks": ["8.1"] },
    { "id": 10, "tasks": ["8.2", "8.3", "8.4", "9.1"] },
    { "id": 11, "tasks": ["9.2", "10.1"] },
    { "id": 12, "tasks": ["9.3", "10.2"] },
    { "id": 13, "tasks": ["10.3", "11.1"] },
    { "id": 14, "tasks": ["11.2", "12.1"] },
    { "id": 15, "tasks": ["12.2"] }
  ]
}
```
