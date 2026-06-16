# Design Document — Edit PDF Object

> Thiết kế kỹ thuật cho tính năng `pdf-object-edit` (chọn/xóa/di chuyển/resize/xoay/thêm object + sửa text), **an toàn màu in**.

## Overview

Tính năng cho phép chỉnh sửa trực tiếp object trên canvas kiểu Acrobat, nhưng tuân thủ ràng buộc đã **chốt bằng spike chạy thật**:

- **pikepdf = engine GHI (color-safe).** Mọi thay đổi được lưu đi qua `parse_content_stream` → sửa danh sách operator → `unparse_content_stream`. Spike xác nhận giữ nguyên `k` (CMYK) và `scn` (spot).
- **PDFium (pypdfium2.raw) = engine ĐỌC hình học (read-only).** Liệt kê object, lấy bbox/type chính xác, hit-test, và render ảnh preview. **CẤM** `FPDFPage_GenerateContent` để ghi file in — spike chứng minh nó hủy CMYK/spot → RGB đen.

Vấn đề lõi cần giải: **PDFium cho object rời rạc (type + bbox), pikepdf làm việc trên chuỗi operator phẳng.** Phải có `Object_Mapper` nối hai mô hình một cách bền vững, theo dõi đầy đủ graphics-state/CTM.

## Architecture

```
                 ┌──────────────────────────── FRONTEND (desktop/) ────────────────────────────┐
   người dùng →  │ Canvas_UI (LivePageFrame)                                                    │
                 │  - Selection_Mode overlay bbox + handle (tái dùng vdpInteraction)            │
                 │  - hit-test, kéo move/resize/rotate, editor text inline                      │
                 └───────────────┬───────────────────────────────────────┬─────────────────────┘
        (1) liệt kê object        │                       (3) gửi EditOp   │   (5) lấy preview
                                  ▼                                        ▼
                 ┌──────────────────────────── BACKEND (backend/app) ──────────────────────────┐
                 │ Geometry_Reader (PDFium, READ-ONLY)        Stream_Editor (pikepdf, WRITE)    │
                 │  CountObjects/GetObject/GetType/GetBounds   parse → sửa op → unparse         │
                 │            │  (type+bbox+CTM per object)          ▲                           │
                 │            └──────────► Object_Mapper ────────────┘                           │
                 │                 map (type,bbox,CTM) ↔ dải operator trong content stream       │
                 │ Preview: pikepdf-edited bytes ──► PDFium render (read-only) ─► ảnh base64     │
                 └──────────────────────────────────────────────────────────────────────────────┘
```

Luồng chuẩn của một thao tác sửa:
1. FE bật Selection_Mode → gọi liệt kê object (Geometry_Reader).
2. Người dùng chọn + thao tác trên canvas → FE dựng `EditOp` (mô tả thao tác + object mục tiêu + tham số).
3. BE: `Object_Mapper` xác định dải operator của object mục tiêu → `Stream_Editor` (pikepdf) áp thay đổi → ghi `Working_File` mới (không ghi đè file gốc).
4. BE render preview bằng PDFium từ **bytes vừa ghi bằng pikepdf** (read-only).
5. FE commit qua `commitWorkingFile` (đẩy history cho undo/redo).

## Components and Interfaces

### 1. Geometry_Reader (backend, PDFium read-only)
Trách nhiệm: liệt kê object + bbox/type chính xác; hit-test; KHÔNG ghi.

```python
# pseudo
def list_objects(pdf_path, page_index) -> list[ObjMeta]:
    pdf = pdfium.PdfDocument(pdf_path)
    pg = pdf[page_index]
    n = raw.FPDFPage_CountObjects(pg.raw)
    out = []
    for i in range(n):
        obj = raw.FPDFPage_GetObject(pg.raw, i)
        t = raw.FPDFPageObj_GetType(obj)          # TEXT/IMAGE/PATH/...
        l,b,r,top = c_float()*4
        raw.FPDFPageObj_GetBounds(obj, &l,&b,&r,&top)   # bbox CHÍNH XÁC
        m = raw.FPDFPageObj_GetMatrix(obj, &mat)        # CTM object (nếu có)
        out.append(ObjMeta(draw_index=i, type=map_type(t), bbox=[l,b,r,top], matrix=mat))
    return out   # KHÔNG GenerateContent, KHÔNG save
```
Giải đúng 2 lỗi cũ: **bbox ảnh chính xác** (thay vì cả trang), **liệt kê vector** (`type=PATH`).

### 2. Object_Mapper (backend) — MẤU CHỐT
Trách nhiệm: với một `ObjMeta` (draw_index + type + bbox + matrix từ PDFium), tìm **dải operator** `[start, end]` tương ứng trong content stream pikepdf.

Cơ chế (KHÔNG dựa thuần index):
- `contents_coalesce()` để gộp đa content stream về một.
- `ops = pikepdf.parse_content_stream(page)` → danh sách `(operands, operator)`.
- Quét tuyến tính, **mô phỏng graphics-state machine**: stack `q/Q`, CTM tích lũy (`cm`), text-state (`BT/ET`, `Tm/Td`, font `Tf`), XObject (`Do`), inline image (`BI…ID…EI`).
- Phân đoạn thành **các "object vẽ"** đồng bộ với mô hình PDFium:
  - **text**: mỗi cụm trong `BT…ET` định vị bằng `Tm`×CTM (tái dùng toán trong `remove_text_from_stream`).
  - **image**: mỗi lời gọi `/Name Do` (subtype Image) — phân biệt theo **lần xuất hiện thứ k** của cùng tên.
  - **vector**: nhóm path-construction (`m l c v y re h`) kết thúc bằng painting op (`S s f f* B B* b b* n`).
- **Đối khớp** đoạn ứng viên với `ObjMeta` bằng (type khớp) + (bbox tính từ CTM ≈ bbox PDFium trong tolerance ≤ 1.0pt) + thứ tự vẽ. `draw_index` chỉ dùng làm gợi ý/độ ưu tiên, không phải khóa cứng.
- **Fallback an toàn:** nếu không khớp được duy nhất (đa nghĩa, clip/Form XObject phức tạp, inline image) → **hủy thao tác**, báo lỗi (Yêu cầu 4.7) thay vì đoán liều.

```python
@dataclass
class OpSpan: start:int; end:int; kind:str; ctm:list; bbox:list; resource_name:str|None
def map_object(page, obj_meta) -> OpSpan | None: ...   # None = không chắc chắn → caller hủy
```

### 3. Stream_Editor (backend, pikepdf write) — color-safe
Mọi thao tác sửa danh sách `ops` rồi `page.Contents = pdf.make_stream(unparse_content_stream(ops))`.

- **Delete**: bỏ các op trong `OpSpan` (text: bỏ `Tj/TJ`; image: bỏ `Do` + dọn XObject **chỉ nếu không còn ai tham chiếu**; vector: bỏ nhóm path+painting). KHÔNG đụng op ngoài span.
- **Transform (move/resize/rotate)** — object không có CTM độc lập trong stream → **bọc cô lập**:
  ```
  ... <op trước> ...
  q  <a b c d e f cm>   ← chèn ngay TRƯỚC span object
     <span operator gốc của object>   (giữ nguyên, gồm cả màu)
  Q                      ← chèn ngay SAU span
  ... <op sau> ...
  ```
  Với **text**, ưu tiên sửa `Tm` (nhân ma trận) thay vì bọc, để không lệch text-state.
  - move: `cm = translate(dx,dy)`.
  - resize: `cm = T(anchor)·scale(sx,sy)·T(-anchor)`, **anchor = góc đối diện handle** (kéo se → neo nw…).
  - rotate: `cm = T(c)·rot(θ)·T(-c)`, `c` = tâm bbox.
  - Chuyển trục canvas(top-left) ↔ PDF(bottom-left) qua `MediaBox` (tiền lệ `remove_text_from_stream`).
- **Edit text** (Yêu cầu 8): xóa cụm `Tj` cũ + chèn cụm mới cùng `Tf`(font)/cỡ/`Tm`(vị trí). Không reflow.
- **Add object** (Yêu cầu 9): chèn `BT…ET`(text) hoặc đăng ký XObject ảnh + `Do` tại bbox; tái dùng hệ overlay VDP ở FE để đặt vị trí.
- **Bảo toàn màu (Yêu cầu 4):** vì chỉ thêm/bớt op quanh span và unparse qua pikepdf, các `Color_Operators` của Untouched_Object **không bị chạm**. Bất biến này được PBT canh giữ (property 1 & 5).

### 4. API (backend routes — mở rộng cụm `/preflight` hiện có hoặc nhóm `/edit`)
| Endpoint | Method | Vai trò |
|---|---|---|
| `/edit/objects/{fid}/{page}` | GET | Geometry_Reader: liệt kê object (type+bbox chính xác, text/image/vector) |
| `/edit/delete` | POST | xóa đúng tập object mục tiêu |
| `/edit/transform` | POST | move/resize/rotate (EditOp.matrix) |
| `/edit/text` | POST | sửa nội dung text (xóa+chèn) |
| `/edit/add` | POST | thêm text/image |
| `/edit/preview` | POST | render preview bytes-đã-sửa bằng PDFium (read-only) |

> Có thể nâng cấp tại chỗ `/preflight/objects` & `/preflight/delete-object` (sửa lỗi xóa-hết-ảnh, bbox ảnh) thay vì tạo mới — tùy quyết định khi implement; giữ tương thích Selection_Mode hiện tại.

### 5. Canvas_UI (frontend)
Tái dùng: Selection_Mode, overlay bbox (LivePageFrame ~1012), `vdpInteraction` (move/resize handle nw/ne/sw/se), `editingTextId`/`editTextContent` (editor text inline), `commitWorkingFile` (history).
Bổ sung: handle xoay; gửi `EditOp` tới `/edit/*`; nhận preview; cập nhật overlay real-time (không gọi lưu mỗi frame — Yêu cầu 13.2).

## Data Models

```ts
type ObjType = 'text' | 'image' | 'vector';
interface ObjMeta { id: string; drawIndex: number; type: ObjType; bbox: [number,number,number,number]; matrix?: number[6]; }
interface EditOp {
  page: number;
  kind: 'delete' | 'move' | 'resize' | 'rotate' | 'editText' | 'add';
  targetIds: string[];
  // theo kind:
  delta?: {dx:number; dy:number};
  scale?: {sx:number; sy:number; anchor:'nw'|'ne'|'sw'|'se'};
  rotateDeg?: number;
  text?: { content:string; font?:string; sizePt?:number; bbox?:number[] };
  image?: { dataRef:string; bbox:number[] };
}
```

## Error Handling
- **Hủy-để-an-toàn-màu (Yêu cầu 4.7):** nếu thao tác không thể hoàn tất mà chắc chắn không đổi Color_Operators của Untouched_Object (ví dụ Object_Mapper không map được duy nhất) → trả lỗi rõ ràng, KHÔNG lưu.
- **Thiếu glyph (Yêu cầu 8.4/9.x):** nếu font không đủ glyph cho text mới và không có font dự phòng đủ → báo lỗi, không lưu .notdef.
- **Timeout/file lớn (Yêu cầu 13.4):** vượt ngưỡng → báo lỗi, giữ nguyên Working_File. Áp `merge_rects`/giới hạn để tránh O(N²).
- **Resize ≤ 0 (Yêu cầu 6.5):** từ chối thao tác.
- Mọi lỗi ghi ra Working_File mới, **không ghi đè file gốc** (Yêu cầu 10.4).

## Testing Strategy
- **Property-Based Testing (PBT, 100+ iteration trên PDF sinh ngẫu nhiên có CMYK/spot/overprint/ICC):** 7 thuộc tính trong requirements (#1 bảo toàn màu Untouched, #2 move=dịch bbox, #3 xóa-đúng-mục-tiêu, #4 round-trip nội-dung, #5 round-trip CMYK/spot, #6 rotate khả nghịch, #7 undo/redo theo cặp). Kiểm logic Stream_Editor/Object_Mapper trên PDF in-memory — chi phí thấp.
- **Integration (1–3 ví dụ):** PDFium render preview khớp hình học; hành vi thư viện ngoài (render pixel) KHÔNG đưa vào PBT.
- **Regression:** spike màu (CMYK `k` + spot `scn`) như guardrail tự động cho mọi đường ghi.
- Dùng venv dự án `backend/venv` cho test (theo audit-rules).

## Correctness Properties

### Property 1: Bảo toàn màu của Untouched_Object (Invariant)
Với mọi thao tác sửa, tập Color_Operators (`k/K`, `scn/SCN`, `cs/CS`, `rg/RG`, `g/G`, overprint) của các object KHÔNG mục tiêu là bằng nhau trước/sau khi lưu. **Validates: Requirements 4.2, 3.4**

### Property 2: Move = dịch bbox (Metamorphic)
Sau khi di chuyển object `(dx,dy)`, BBox mới = BBox cũ + `(dx,dy)` mỗi cạnh, sai số ≤ 1.0 point. **Validates: Requirements 5.2**

### Property 3: Xóa chỉ-đúng-mục-tiêu (Invariant)
Sau khi xóa tập mục tiêu, số lượng + nội dung Untouched_Object không đổi; đúng các object mục tiêu biến mất. **Validates: Requirements 3.1, 3.4**

### Property 4: Round-trip không đổi nội dung ngoài thao tác (Round-trip)
Mở → (không sửa) → lưu → mở lại: content tương đương hiển thị + giữ Color_Operators; mở → sửa-1-object → lưu → mở lại: chỉ khác đúng object đó. **Validates: Requirements 10.1, 10.2**

### Property 5: Round-trip màu CMYK/spot (Round-trip)
Object dùng `k`/`scn` sau Round_Trip giữ nguyên operator + giá trị màu + định nghĩa colorspace. **Validates: Requirements 4.3, 4.4**

### Property 6: Rotate khả nghịch (Round-trip)
Xoay `θ` rồi `-θ` quanh cùng tâm trả về BBox ban đầu trong tolerance ≤ 1.0 point. **Validates: Requirements 7.2**

### Property 7: Undo/Redo idempotent theo cặp (Round-trip)
Undo rồi Redo một thao tác cho trạng thái tương đương sau thao tác ban đầu (Color_Operators + BBox giữ nguyên). **Validates: Requirements 11.4**

> Phạm vi PBT: 7 thuộc tính trên kiểm logic Stream_Editor/Object_Mapper trên PDF in-memory (chi phí thấp, hợp PBT 100+ iteration). "Render PDFium đúng pixel" là hành vi thư viện ngoài → integration test 1–3 ví dụ, KHÔNG PBT.

## Prior art / Tham khảo (chỉ học nguyên lý — KHÔNG bê code)
- **Stirling-PDF:** lõi MIT, NHƯNG các thư mục `engine/`, `app/proprietary|saas/`, `frontend/editor/src/{proprietary,saas,desktop,prototypes}/`, `frontend/portal/` có **license riêng** → phần Editor (sửa text/di chuyển ảnh) nằm vùng nhạy cảm: chỉ học UX, không lấy code. Stack Java/PDFBox, khác PrynX.
- **Apache PDFBox / pdf.js editor:** tham khảo nguyên lý chỉnh content stream + UX editor.
- **PyMuPDF (AGPL):** chỉ học nguyên lý, không ship.
- ⚠️ Các công cụ này nhắm PDF văn phòng — **chưa chắc giữ màu in CMYK/spot**; PrynX khắt khe hơn nên không giả định cách họ làm là đúng cho in.

## Risks & Mitigations
| Risk | Giảm thiểu |
|---|---|
| Map object↔operator sai (q/Q lồng, Form XObject, inline image, đa stream) | State-machine đầy đủ + đối khớp bbox/CTM; fallback **hủy** nếu không duy nhất (4.7); PBT #1,#3 |
| Lỡ ghi qua PDFium → mất màu | Rào kiến trúc "pikepdf-only write" + spike màu làm guardrail CI; PBT #5 |
| Font tiếng Việt thiếu glyph | Nhúng/subset + font dự phòng DejaVuSans; báo lỗi nếu thiếu (8.4) |
| Hiệu năng nhiều object/vector | merge_rects/giới hạn; overlay real-time không lưu mỗi frame; timeout an toàn (13) |
| Lệch tọa độ làm tròn | tolerance ≤ 1.0pt + expand_bbox |
| Bọc `q/cm/Q` phá clip/state | Với text sửa `Tm`; với path/image bọc cô lập đúng ranh giới painting op; kiểm bằng PBT #2,#6 |
