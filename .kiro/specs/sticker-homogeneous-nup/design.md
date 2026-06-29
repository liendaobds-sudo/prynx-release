# Design Document

> Thiết kế — Dàn nhiều mẫu CÙNG KHUÔN (1 khuôn – nhiều nội dung) cho Bình Tem Bế / Bế Rớt

## Overview

Thêm một **chế độ đồng nhất (homogeneous)** vào luồng "Dàn nhiều mẫu" của tem bế: khi **chỉ trang đầu có khuôn**, dùng hình học khuôn đó làm **bản mẫu (master)** để xếp **shape-aware** (so le/head-to-tail...) như bình-1-mẫu, rồi **căn từng nội dung (trang 2→N) về đúng tâm khuôn** và **co cho khít** trước khi rải vào các ô. Mục tiêu: tem tròn (và mọi hình) dàn nhiều mẫu cùng khuôn cho ra **so le** thay vì lưới, trong khi dù các tem lệch vị trí trên trang gốc vẫn **ráp khít khuôn**.

Nguyên tắc kiến trúc (kế thừa hiện trạng):
- **Tái dùng, không viết lại**: nesting dùng lại `compute_sticker_layout_for_page`; căn giữa + va chạm boong dùng lại `imposition_finalize` (đã là SSOT preview↔output); registration/co-khít dùng primitive `pdf_ops.show_pdf_page` (clip + rect + keep_proportion).
- **Một nguồn sự thật cho cả preview & output** → parity (R7).
- **Cô lập lỗi / fallback an toàn** về bin-pack trộn cũ (R8).

## Architecture

```
                 ┌─────────────────────────────────────────────┐
 detect-shape →  │ HomogeneityDetector                          │
 (mỗi trang)     │  đúng 1 trang có khuôn (master) + còn lại    │
                 │  không khuôn ?  → homogeneous=True            │
                 └───────────────┬─────────────────────────────┘
                                 │ master_page_idx, master DetectedShape
                                 ▼
        ┌───────────────────────────────────────────────────────┐
        │ Nesting (1 LẦN)                                        │
        │  compute_sticker_layout_for_page(master_page, ...)     │
        │   → items (cells so le/head-to-tail) + shapeType/props │
        └───────────────┬───────────────────────────────────────┘
                         │ items (tương đối)
                         ▼
        ┌───────────────────────────────────────────────────────┐
        │ ContentAssigner: ô ↔ trang nội dung                    │
        │  - thứ tự trang 1→N, cuốn chiếu sang tờ (C ô/tờ)       │
        │  - số lượng/auto-fill như Dàn nhiều mẫu                │
        └───────────────┬───────────────────────────────────────┘
                         │ items + (mỗi item: src_page_idx nội dung)
                         ▼
        ┌───────────────────────────────────────────────────────┐
        │ finalize_placements()  → placements tuyệt đối, căn giữa │  ← imposition_finalize
        │ resolve_pont_collisions_on_placements() (boong)         │     (SSOT parity)
        └───────────────┬───────────────────────────────────────┘
            preview ◄────┴────► output (render)
        (vẽ schematic + nội dung)   (đặt artwork: ArtworkRegistrar — căn tâm + co khít + clip khuôn)
```

**Đường chạy:**
- Preview: `/imposition/preview-layout` (nhánh `is_nup_multi`) → nếu homogeneous → đường mới; ngược lại giữ `solve_auto_fill_mixed`.
- Output: `nup_engine`/`nup_process_chunk` → nếu homogeneous → đường mới; ngược lại bin-pack cũ.

## Components and Interfaces

| Thành phần | Vai trò | File |
|---|---|---|
| **HomogeneityDetector** | Quyết định bật chế độ + chọn trang master | MỚI: `backend/app/workers/sticker_homogeneous.py` |
| **ArtworkRegistrar** | Dò bbox artwork từng trang (vector-first), tính transform căn-tâm + co-khít | MỚI: `sticker_homogeneous.py` |
| **ContentAssigner** | Ánh xạ ô ↔ trang nội dung (thứ tự, cuốn chiếu, số lượng) | MỚI: `sticker_homogeneous.py` |
| Nesting | Layout shape-aware từ master (tái dùng) | `sticker_imposer_pkg/layout_compute.py` |
| Finalize/parity | Căn giữa + va chạm boong (tái dùng) | `imposition_finalize.py` |
| Registration render | Đặt artwork căn-tâm + co-khít + clip khuôn | `pdf_ops.show_pdf_page`, `nup_artwork.place_one_artwork` (SỬA nhẹ) |
| Output engine | Nhánh đồng nhất trong render | `nup_engine.py` / `nup_process_chunk.py` (SỬA) |
| Preview | Nhánh đồng nhất trong `/preview-layout` | `api/routes/imposition.py` (SỬA) |

### Giao diện hàm (đề xuất) trong `sticker_homogeneous.py`
```python
def detect_homogeneous(shapes: list[DetectedShape]) -> Optional[HomogeneousPlan]:
    """Trả HomogeneousPlan nếu đúng 1 trang có khuôn + còn lại không; else None."""

def artwork_bbox(page, *, raster_dpi_fallback: int = 72) -> Optional[Rect]:
    """bbox vùng có mực của tem (vector-first; raster DPI thấp khi cần). None nếu rỗng."""

def registration_for(content_bbox: Rect, die_rect: Rect) -> RegTransform:
    """Tham số đặt: clip=content_bbox, rect=die_rect, keep_proportion=True (căn tâm+co khít)."""

def assign_contents(items, content_pages, quantities, cells_per_sheet) -> list[CellContent]:
    """Ánh xạ ô→trang nội dung, cuốn chiếu sang tờ; tất định."""
```

### Thuật toán lõi

**(a) Phát hiện đồng nhất (R1):**
```
die_pages = [i for i,s in enumerate(shapes) if s.type != CUSTOM and có_đường_bế(s)]
content_pages = [các trang khác]
homogeneous = (len(die_pages) == 1) and (len(content_pages) == total - 1)
master_idx = die_pages[0]   # thường = 0
```
≥2 khuôn → không bật (R1.3); 0 khuôn → giữ cũ (R1.4); toggle thủ công ghi đè (R1.6).

**(b) Hình học master (R2):** từ `DetectedShape[master_idx]`: `shapeType`, `trim`, `poly`, `tâm khuôn = tâm bbox(poly)`.

**(c) Dò bbox + Registration (R3, R4) — mấu chốt:** với mỗi trang nội dung `p`:
1. `B_p = artwork_bbox(p)` — vector-first (hợp path từ `extract_vector_paths`), raster DPI thấp khi là ảnh (R9.2).
2. Mốc căn = **tâm `B_p`** (R3.2).
3. Đặt vào ô k (rect khuôn đích `R_k`): `show_pdf_page(dest, rect=R_k, src=p, clip=B_p, keep_proportion=True)`:
   - `clip=B_p` → chỉ lấy đúng vùng tem (bỏ lệch vị trí trang gốc — R3.6);
   - `rect=R_k`+`keep_proportion` → **co ĐỀU cho khít** + **căn tâm** B_p vào tâm khuôn (R3.3, R4.1, R4.2);
   - đường **cắt** theo **footprint master** tại ô (R3.4).
4. Trang rỗng → rỗng-an-toàn (R3.5); lệch kích thước > 20% → cảnh báo nhưng vẫn co (R4.3).

**(d) Nesting (R5):** `compute_sticker_layout_for_page(master_page, ...)` → `items` so le, **1 lần** (R9.1), `C=len(items)`.

**(e) Gán nội dung & nhiều tờ (R6):** danh sách nội dung theo thứ tự 1→N (nhân theo số lượng / auto-fill như Dàn nhiều mẫu); rải tuần tự `C` ô/tờ; vượt `C` → tờ mới `[t*C:(t+1)*C)`; ánh xạ tất định (R6.2, R6.3); mỗi item mang `src_page_idx` nội dung (R6.4).

**(f) Finalize & va chạm (R7):** `finalize_placements(...)` + `resolve_pont_collisions_on_placements(..., base_poly=master_poly)` — preview & output gọi CÙNG 2 hàm.

## Data Models

```python
@dataclass(frozen=True)
class HomogeneousPlan:
    master_page_idx: int          # trang có khuôn
    content_pages: tuple[int, ...] # các trang nội dung theo thứ tự
    shape_type: ShapeType
    trim_w: float; trim_h: float  # point
    poly: tuple[tuple[float,float], ...]  # footprint khuôn (đã chuẩn hoá TRIM)
    die_center: tuple[float, float]       # tâm khuôn (point)

@dataclass(frozen=True)
class RegTransform:
    clip: Rect            # = bbox artwork trên trang nguồn (point)
    rect: Rect            # = rect khuôn đích tại ô (point)
    keep_proportion: bool # = True (co đều, căn tâm)

@dataclass(frozen=True)
class CellContent:
    cell_index: int       # chỉ số ô trong layout (ổn định)
    sheet_index: int      # tờ thứ mấy
    src_page_idx: int     # trang nội dung gán cho ô
```
- Quy ước toạ độ theo `imposition_finalize`: `abs_x` mép trái từ trái tờ, `abs_y` mép dưới từ đáy (Y↑), `original_cell_y` top-down cho render. Đơn vị **point**. KHÔNG tự suy bottom-up bằng tay (audit §6).

## Correctness Properties

### Property 1: Phát hiện chế độ đồng nhất
*For any* tập kết quả nhận diện theo trang, `detect_homogeneous` SHALL trả về một plan KHI VÀ CHỈ KHI đúng 1 trang có khuôn (shape ≠ CUSTOM, có đường bế) và mọi trang còn lại không có khuôn; có ≥2 khuôn ⇒ trả None.
**Validates: Requirements 1.2, 1.3**

### Property 2: Layout shape-aware, không phải lưới
*For any* bộ tem đồng nhất, layout sinh ra SHALL bằng layout bình-1-mẫu của trang master (cùng số ô và cùng toạ độ ô, kiểu so le/head-to-tail), và KHÁC kết quả lưới của `solve_auto_fill_mixed` với hình tròn/elip.
**Validates: Requirements 5.1, 5.2**

### Property 3: Registration căn đúng tâm khuôn
*For any* vị trí lệch của bbox artwork `B_p` trên trang nội dung, sau biến đổi (clip=B_p → rect=R_k) **tâm B_p trùng tâm R_k** trong dung sai ≤ 1e-6 (độc lập vị trí tuyệt đối trên trang gốc).
**Validates: Requirements 3.3, 3.6**

### Property 4: Co cho khít, giữ tỉ lệ
*For any* `B_p` khác kích thước khuôn, phép biến đổi SHALL là **scale ĐỀU (uniform)**; bbox sau biến đổi vừa khít `R_k` (không tràn/không hụt quá tolerance) và tỉ lệ khung hình được bảo toàn.
**Validates: Requirements 4.1, 4.2**

### Property 5: Gán ô↔nội dung tất định + cuốn chiếu
*For any* N trang nội dung và C ô/tờ, ánh xạ ô→trang SHALL tất định (cùng input → cùng kết quả) và cuốn chiếu đúng: tờ t chứa nội dung `[t*C, (t+1)*C)` theo thứ tự trang 1→N.
**Validates: Requirements 6.2, 6.3**

### Property 6: Parity preview == output
*For any* cấu hình đồng nhất (kể cả có boong), danh sách ô của preview SHALL khớp placements của output trong dung sai ≤ 0.1mm vị trí/kích thước và ≤ 0.01° góc, sau cả bước va chạm/dịch chuyển boong.
**Validates: Requirements 7.2, 7.3**

### Property 7: Fallback an toàn
*For any* trường hợp master lỗi nhận diện hoặc có ≥2 khuôn, hệ thống SHALL đi đúng đường bin-pack trộn cũ và KHÔNG sập job.
**Validates: Requirements 8.1, 8.2**

### Property 8: Nesting tính đúng một lần
*For any* N trang nội dung, `compute_sticker_layout_for_page` SHALL được gọi đúng **một lần** (đếm bằng spy), không tính lại theo từng trang.
**Validates: Requirements 9.1**

### Property 9: bbox ưu tiên vector
*For any* trang nội dung là vector, việc dò bbox SHALL KHÔNG kích hoạt nhánh raster (đếm bằng spy).
**Validates: Requirements 9.2**

## Error Handling
- Master không dò được khuôn hợp lệ → **fallback** bin-pack trộn + log lý do (R2.4, R8.2).
- Lỗi ở 1 trang (bbox/registration/scale) → trang đó **rỗng-an-toàn**, không sập job (R3.5).
- Điều kiện đồng nhất không thoả (≥2 khuôn / 0 khuôn) → **giữ nguyên** đường cũ (R8.1, R8.3).
- Mọi thông báo lỗi tiếng Việt, không lộ stacktrace ra UI.

## Testing Strategy
- **Property-based (Hypothesis)** cho P1–P9 (mỗi property gắn `Feature: sticker-homogeneous-nup, Property N`).
- **Parity test** `assert_parity(preview_items, output_placements, tol)` ≤ 0.1mm / ≤ 0.01° — gồm ca có boong (va chạm/dịch chuyển).
- **Regression**: bình-1-mẫu, dàn-nhiều-mẫu khác-khuôn, CNC, bình bài xén KHÔNG đổi (R8.3) — chạy lại test sticker/die/cnc hiện có.
- **Benchmark (venv)**: chế độ đồng nhất vs Bình trang vs Dàn nhiều mẫu trên cùng bộ tem (vd 100 tem tròn vector) — đo thời gian thật, xác nhận không regression bất thường (R9.5); dọn artifact sau đo.
- Chạy bằng `backend/venv/Scripts/python.exe`; PBT chạy nhiều lần (seed ngẫu nhiên).

## Dependencies / Reuse
- `die_detection.detect_die_shapes` (phát hiện khuôn theo trang).
- `sticker_imposer_pkg.layout_compute.compute_sticker_layout_for_page` (nesting shape-aware).
- `imposition_finalize.finalize_placements` + `resolve_pont_collisions_on_placements` (parity SSOT).
- `pdf_ops.show_pdf_page` (clip + rect + keep_proportion → registration + co khít).
- `nup_diecut` (footprint khuôn master), `nup_artwork.place_one_artwork` (điểm đặt artwork).
