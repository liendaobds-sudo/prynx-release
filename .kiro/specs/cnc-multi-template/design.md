# Design Document

> Tài liệu Thiết kế — Tính năng "CNC ghép nhiều mẫu" (cnc-multi-template)

## Overview

Tính năng mở rộng công cụ **Bình Bế Rớt (CNC)** (`imposerMode='cnc'`) để **trộn nhiều mẫu khác nhau lên cùng một tờ in** cho cả chế độ 1 mặt và 2 mặt, đồng thời bảo đảm **preview khớp khít output**.

Ý tưởng cốt lõi: tách một **Layout_Helper dùng chung** làm **nguồn chân lý duy nhất** để dựng layout trộn 1 tờ. Cả `cnc_render` (xuất file) lẫn nhánh preview (`is_nup_multi` trong `imposition.py`) đều gọi chung helper này với cùng đầu vào → cùng đầu ra → preview luôn bằng output.

Đổi căn bản so với hiện trạng:

- **Hiện tại:** `run_cnc_two_sided` lặp từng cặp trang `(front, back)` và với mỗi cặp gọi solver Rust nhồi **một mẫu** đầy 1 tờ → mỗi mẫu là một cụm trang riêng.
- **Mới:** Gom **tất cả trang Mặt trước** (1 mặt = mọi trang; 2 mặt = trang ở vị trí chẵn) cùng số lượng (SL) của chúng → gọi Layout_Helper để **bin-pack trộn nhiều mẫu** lên một tờ Mặt trước duy nhất. Mặt sau = **lật gương cả cụm**. Khuôn = **gộp đường bế của tất cả mẫu**. Output đúng **một cụm trang**.

Ràng buộc giữ nguyên:
- CNC vẫn được `nup_engine` định tuyến tới `cnc_render.run_cnc_two_sided` (không đi qua nhánh trộn của `nup_engine`).
- Không thay đổi hành vi của Bình Tem Bế, N-Up, Booklet.
- Tái dùng `solve_offset_mixed` / `solve_auto_fill_mixed` (không viết lại bin-pack).

Ngôn ngữ triển khai: **Python** (backend pure-logic + render) và **TypeScript/React** (frontend GridPreview, dashboard, store).

---

## Architecture

### Sơ đồ luồng dữ liệu

```
                         ┌─────────────────────────────────────────┐
                         │     Layout_Helper (cnc_layout.py)        │
                         │  build_cnc_front_layout(...)             │
                         │   • chọn solver theo SL                  │
                         │     - tổng SL>0 → solve_offset_mixed     │
                         │     - tổng SL=0 → solve_auto_fill_mixed  │
                         │   • căn giữa bbox trên usable area       │
                         │   • trả placements (PDF abs) + raw cells │
                         │     + sheets_needed + placed_by_page     │
                         └───────────────┬───────────────┬─────────┘
                                         │               │
                  (nguồn chân lý duy nhất)│               │(cùng input → cùng output)
                                         │               │
              ┌──────────────────────────▼──┐        ┌───▼─────────────────────────┐
              │  cnc_render.run_cnc_two_sided│        │ imposition.py /preview-layout│
              │  (RENDER → file PDF)         │        │  nhánh is_nup_multi (CNC)    │
              │                              │        │                              │
              │  Front: place_one_artwork    │        │  trả về cells (raw, top-down │
              │         theo src_page_idx ô  │        │  sheet-abs) + meta CNC       │
              │  Back : mirror_placements    │        └───────────────┬──────────────┘
              │         (long/short),        │                        │
              │         src→ front_idx+1      │                        ▼
              │  Cut  : draw_die_lines_for_   │             ┌──────────────────────────┐
              │         placement theo từng ô │             │ GridPreview.tsx           │
              │         (die_items theo src)  │             │  • lật xem Trước/Sau/Khuôn│
              │  Boong: chỉ Front + Cut       │             │  • Sau = mirror cụm Front │
              │  Duplex marks: Front + Back   │             │  • SL chỉ ở trang chẵn    │
              │  Report: sheets_needed helper │             └──────────────────────────┘
              └──────────────────────────────┘
```

### Phân tách trách nhiệm

| Thành phần | Trách nhiệm | Vị trí |
|---|---|---|
| **Layout_Helper** | Chọn solver theo SL, căn giữa, trả placements + sheets_needed | `backend/app/workers/cnc_layout.py` (MỚI) |
| **CNC_Renderer** | Front/Back/Cut, artwork, khuôn gộp, boong, duplex, report | `backend/app/workers/cnc_render.py` (SỬA) |
| **Mirror geometry** | Lật gương placement theo cạnh | `backend/app/workers/cnc_render.py::mirror_placements` (tái dùng) |
| **Preview_Service** | Nhánh `is_nup_multi` gọi helper cho CNC | `backend/app/api/routes/imposition.py` (SỬA) |
| **Request schema** | Thêm `imposer_mode`, `cnc_two_sided`, `cnc_flip_edge` | `imposition.py::PreviewLayoutRequest` (SỬA) |
| **GridPreview** | Lật xem 3 chế độ, SL theo trang chẵn | `desktop/src/components/imposition-tools/sections/GridPreview.tsx` (SỬA) |
| **Dashboard** | Truyền cờ CNC/duplex vào GridPreview | `ImposerDashboard.tsx` (SỬA) |
| **Settings + store** | SL từng mẫu, cạnh lật | `CncSettingsSection.tsx`, `useImposerSettingsStore.ts` (SỬA nhỏ) |

---

## Components and Interfaces

### 1. Layout_Helper — `backend/app/workers/cnc_layout.py` (MỚI)

Module thuần (chỉ phụ thuộc `bin_packing`), unit-test trực tiếp. Là **nguồn chân lý duy nhất** cho layout trộn 1 tờ.

```python
from typing import List, Tuple, Dict, Any
from app.workers.sticker_imposer_pkg.bin_packing import (
    solve_offset_mixed, solve_auto_fill_mixed,
)

def build_cnc_front_layout(
    page_dims_qty: List[Tuple[int, float, float, int]],  # (page_idx, trim_w, trim_h, qty)
    usable_w: float,
    usable_h: float,
    gap: float,
    margin_left: float = 0.0,
    margin_bottom: float = 0.0,
    margin_top: float = 0.0,
    allow_rotation: bool = True,
) -> Dict[str, Any]:
    """Dựng layout trộn nhiều mẫu cho MỘT tờ Mặt trước.

    - Chọn solver theo SL:
        * tổng qty > 0 → solve_offset_mixed (trộn theo tỉ lệ, có sheets_needed)
        * tổng qty == 0 → solve_auto_fill_mixed (lấp đầy 1 tờ, sheets_needed=1)
    - Căn giữa bbox nội dung trên usable area (toạ độ tuyệt đối của tờ).
    - Mỗi placement mang src_page_idx = page_idx của mẫu tương ứng.

    Trả về:
      {
        'placements': List[placement],   # PDF abs coords, đã căn giữa, có src_page_idx
        'cells': List[cell],             # raw bin-pack (sheet-abs, top-down) cho preview
        'items_per_sheet': int,
        'placed_by_page': Dict[int, int],
        'sheets_needed': int,
      }
    """
```

**placement** (khớp cấu trúc `_build_placements` hiện có, để `place_one_artwork` / `draw_die_lines_for_placement` dùng nguyên):

```python
{
    'cluster_idx': 0,
    'cell': {'x','y','width','height','isRotated','isRotated180'},
    'src_page_idx': int,          # trang nguồn của mẫu trong ô này
    'abs_x': float,               # PDF x (trái), đã căn giữa
    'abs_y': float,               # toạ độ top-based dùng cho place_one_artwork
    'width': float, 'height': float,
    'original_cell_y': float,     # PDF y (đáy) = sheet_h - abs_y - height; dùng cho khuôn
}
```

**cell** (cho preview — sheet-absolute, top-down y, đã căn giữa):

```python
{'x','y','width','height','isRotated','isRotated180': False, 'pageIdx': int}
```

Triển khai nội bộ:
1. `total_qty = sum(q for _,_,_,q in page_dims_qty)`.
2. Nếu `total_qty > 0`: `res = solve_offset_mixed(usable_w, usable_h, page_dims_qty, gap, allow_rotation)`; `sheets_needed = res['sheets_needed']`.
   Ngược lại: `res = solve_auto_fill_mixed(usable_w, usable_h, [(p,w,h) for p,w,h,_ in page_dims_qty], gap, allow_rotation)`; `sheets_needed = 1`.
3. `raw = res['placements']` (mỗi item: `page_idx,x,y,w,h,is_rotated`; toạ độ origin top-left usable, y xuống).
4. **Căn giữa** (hàm dùng chung `_center_placements`, rút từ `_build_placements`):
   - `content_w = max(x+w)`, `content_h = max(y+h)`.
   - `x_off = margin_left + (usable_w - content_w)/2` (nếu `content_w < usable_w`, ngược lại `margin_left`).
   - `y_off = margin_bottom + (usable_h - content_h)/2` (tương tự).
   - Với mỗi item: `abs_x = x_off + x`; `abs_y = y_off + (content_h - y - h)`; `original_cell_y = (usable_h+margin_bottom+margin_top) - abs_y - h`.
   - `cell.x/cell.y` của preview = sheet-absolute top-down: `cx = x_off + x`, `cy = margin_top + (usable_h - content_h)/2 + y`.
5. Trả về dict ở trên. `placed_by_page = res['placed_by_page']`, `items_per_sheet = res['total_placed']`.

> Lưu ý: `_build_placements` hiện có sẽ được **refactor** để gọi `_center_placements` dùng chung (giữ nguyên hành vi cho các test hiện hữu), bảo đảm cnc_render và helper dùng đúng một công thức căn giữa.

### 2. CNC_Renderer — `backend/app/workers/cnc_render.py` (SỬA)

`run_cnc_two_sided` đổi từ "lặp từng cặp" sang "gom Mặt trước → 1 cụm":

```python
def run_cnc_two_sided(source_path, output_path, settings, job_id=None, progress_callback=None) -> str:
    two_sided = bool(settings.get('cncTwoSided', ...))
    flip_edge = settings.get('cncFlipEdge', 'long')   # mặc định 'long' (Yêu cầu 3.2)
    ...
    # 1) Validate (giữ nguyên): 2 mặt + lẻ → ValueError nêu số trang (Yêu cầu 1.4)

    # 2) Chọn tập trang Mặt trước + back mapping (Yêu cầu 1.1/1.2/1.3)
    front_idxs, back_of = _select_front_pages(page_count, two_sided)
    #   1 mặt : front_idxs=[0..n-1], back_of[i]=None
    #   2 mặt : front_idxs=[0,2,4,...], back_of[i]=i+1

    # 3) Tính trim dims + SL mỗi mẫu (SL lấy từ trang Mặt trước — Yêu cầu 2.3)
    page_dims_qty = []
    for fi in front_idxs:
        tw, th = _trim_dims(src_doc[fi], bleed_pt)       # _find_largest_die_path → fallback MediaBox-bleed
        page_dims_qty.append((fi, tw, th, _qty_for(fi)))

    # 4) GỌI HELPER (nguồn chân lý) — Yêu cầu 5.1/5.2
    layout = build_cnc_front_layout(page_dims_qty, usable_w, usable_h,
                                    gap=max(gap_x, gap_y),
                                    margin_left=margin_left, margin_bottom=margin_bottom,
                                    margin_top=margin_top)
    front_pl = layout['placements']           # mỗi ô có src_page_idx của mẫu
    sheets_needed = layout['sheets_needed']

    # 5) TRANG MẶT TRƯỚC: place_one_artwork theo src_page_idx từng ô
    front_bbox = compute_block_bbox(front_pl)
    out_front = out_doc.new_page(width=sheet_w, height=sheet_h)
    for p in front_pl:
        place_one_artwork(out_front, src_doc, p, ... )   # p['src_page_idx'] → artwork đúng mẫu
    if pont_config: _draw_ponts_on_page(out_front, front_pl, ...)      # boong: Front
    if duplex_marks and two_sided: draw_duplex_marks(out_front, ...)    # duplex: Front

    # 6) TRANG MẶT SAU (chỉ khi 2 mặt): lật gương CẢ CỤM (Yêu cầu 3.1/3.3/3.4)
    if two_sided:
        back_pl = mirror_placements_multi(front_pl, sheet_w, sheet_h, flip_edge, back_of)
        # mỗi ô: lật vị trí (long/short) + đổi src_page_idx = front_src+1
        out_back = out_doc.new_page(...)
        for p in back_pl:
            place_one_artwork(out_back, src_doc, p, ...)
        if duplex_marks: draw_duplex_marks(out_back, ...)              # duplex: Back; KHÔNG boong (Yêu cầu 4.3)

    # 7) TRANG KHUÔN: gộp đường bế tất cả mẫu (Yêu cầu 4.1)
    out_cut = out_doc.new_page(...)
    cut_shape = out_cut.new_shape()
    for p in front_pl:
        cached = die_items_cache.get(f"{job_id}_{p['src_page_idx']}")   # die theo MẪU của ô
        if not cached: continue
        draw_die_lines_for_placement(cut_shape, cached['items'], cached['rect'],
                                     p['abs_x'], p['original_cell_y'],
                                     is_rotated=p['cell']['isRotated'],
                                     is_rotated_180=p['cell']['isRotated180'])
        cut_shape.finish(color=_die_color(cached), width=...)           # finish PER placement
    cut_shape.commit()
    if pont_config: _draw_ponts_on_page(out_cut, front_pl, ...)         # boong: Cut

    # 8) Report: 1 cụm trang; tổng tờ = sheets_needed (Yêu cầu 7.4)
```

Hàm phụ mới (thuần, dễ test):

```python
def _select_front_pages(page_count: int, two_sided: bool) -> Tuple[List[int], Dict[int, int|None]]:
    """1 mặt: mọi trang, back=None. 2 mặt: trang chẵn, back=front+1."""

def mirror_placements_multi(front_pl, sheet_w, sheet_h, flip_edge, back_of) -> List[dict]:
    """Lật gương cả cụm (gọi mirror_placements từng ô) và đổi src_page_idx
    sang trang Mặt sau (front_src+1) của đúng mẫu trong ô đó."""
```

`mirror_placements` hiện có giữ nguyên công thức lật (long: `abs_x' = sheet_w-(abs_x+w)`; short: lật `original_cell_y`/`abs_y` quanh `sheet_h`). `mirror_placements_multi` chỉ thêm việc gán `src_page_idx = back_of[front_src]` cho từng ô (mỗi ô có thể thuộc mẫu khác nhau, nên không thể dùng một `back_idx` chung như cũ).

### 3. Preview_Service — `backend/app/api/routes/imposition.py` (SỬA)

Trong nhánh `is_nup_multi`, thêm sub-branch cho CNC 2 mặt:

```python
imposer_mode = getattr(req, 'imposer_mode', None)
cnc_two_sided = bool(getattr(req, 'cnc_two_sided', False))
is_cnc_preview = (imposer_mode == 'cnc')

if is_cnc_preview:
    from app.workers.cnc_layout import build_cnc_front_layout
    # Chỉ bin-pack trang MẶT TRƯỚC (Yêu cầu 6.2)
    front_idxs = list(range(0, doc.page_count, 2)) if cnc_two_sided else list(range(doc.page_count))
    page_dims_qty = [(pi, *_trim_dims(doc[pi], bleed_pt), _qty_for_page(pi)) for pi in front_idxs]
    layout = build_cnc_front_layout(page_dims_qty, req.usable_w, req.usable_h,
                                    gap=max(gap_x_pt, gap_y_pt),
                                    margin_left=req.margin_left, margin_bottom=req.margin_bottom,
                                    margin_top=getattr(req,'margin_top',0))
    cells = layout['cells']                       # sheet-abs, top-down, đã căn giữa
    return {
        "success": True, "cells": cells,
        "overallWidth": ..., "overallHeight": ...,
        "totalItems": layout['items_per_sheet'],
        "sheetsNeeded": layout['sheets_needed'],
        "strategyUsed": "cnc_mixed",
        "isMixedPreview": True,
        "isCncPreview": True,
        "cncTwoSided": cnc_two_sided,
        "cncFlipEdge": getattr(req, 'cnc_flip_edge', 'long'),
        "sheetW": req.sheet_w, "sheetH": req.sheet_h,
    }
# else: GIỮ NGUYÊN nhánh non-CNC mixed hiện tại (Yêu cầu 9.1)
```

> Mặt sau preview KHÔNG tính ở backend — GridPreview tự lật gương cụm Front bằng cùng công thức (Yêu cầu 6.3). Backend chỉ trả layout Front + meta cờ lật.

### 4. Request/Response schema — `PreviewLayoutRequest` (SỬA)

Thêm 3 field (đặt default an toàn để không phá client cũ; `extra='forbid'` nên phải khai báo):

```python
class PreviewLayoutRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ...
    imposer_mode: Optional[str] = None       # 'cnc' | 'diecut' | ...
    cnc_two_sided: Optional[bool] = False
    cnc_flip_edge: Optional[str] = "long"    # 'long' | 'short'
```

Response thêm (chỉ khi CNC): `isCncPreview`, `cncTwoSided`, `cncFlipEdge`, `sheetW`, `sheetH`, `sheetsNeeded`.

### 5. GridPreview — `GridPreview.tsx` (SỬA)

- Thêm props: `imposerMode?: string`, `cncTwoSided?: boolean`, `cncFlipEdge?: 'long'|'short'`.
- Gửi `imposer_mode`, `cnc_two_sided`, `cnc_flip_edge` trong body fetch.
- Thêm state `viewMode: 'front' | 'back' | 'cut'` + 3 nút lật xem (chỉ hiện khi `isCncPreview`) (Yêu cầu 6.1).
- Với mixed CNC, cells là **sheet-absolute top-down** → bỏ bước tự căn giữa (dùng `isCncPreview` để rẽ nhánh), vẽ trực tiếp `svgX = pad + cell.x*scale`, `svgY = pad + cell.y*scale`.
- **Mặt sau** = lật gương cụm Front trong toạ độ SVG theo `cncFlipEdge` (Yêu cầu 6.3):
  - `long`:  `cell.x' = sheetW - (cell.x + cell.w)`; y giữ.
  - `short`: `cell.y' = sheetH - (cell.y + cell.h)`; x giữ.
- **Khuôn** = vẽ outline các ô Front (cùng vị trí) theo kiểu đường bế (nét đỏ), không tô nền.
- Ô nhập SL: chỉ render cho trang chẵn khi `cncTwoSided` (Yêu cầu 8.1/8.2); mọi trang khi 1 mặt (8.3) — phần input SL nằm ở `GridSettingsSection`, lọc theo `cncTwoSided`.

### 6. Dashboard / Settings / Store (SỬA nhỏ)

- `ImposerDashboard.tsx`: truyền `imposerMode='cnc'`, `cncTwoSided`, `cncFlipEdge` xuống `GridPreview` khi `activeTool==='cnc_imposer'`.
- `CncSettingsSection.tsx`: đã có `twoSided` + `cncFlipEdge`; không đổi logic, chỉ bảo đảm giá trị chảy vào store.
- `useImposerSettingsStore.ts`: `targetQuantitiesByPage` đã có; với CNC 2 mặt, SL nhập theo trang chẵn (front). `GridSettingsSection` lọc danh sách ô SL theo `cncTwoSided` (chỉ trang chẵn).

---

## Data Models

### page_dims_qty (đầu vào helper)

```
List[(page_idx: int, trim_w: float, trim_h: float, qty: int)]
```
- `trim_w/trim_h`: kích thước thành phẩm (ưu tiên đường bế lớn nhất `_find_largest_die_path`, fallback MediaBox − 2·bleed).
- `qty`: SL của mẫu (lấy theo trang Mặt trước); 0 nghĩa là chưa nhập.

### Kết quả helper

```
{ placements: [...], cells: [...], items_per_sheet: int,
  placed_by_page: {page_idx: count}, sheets_needed: int }
```

### Cấu trúc cụm trang output

- 2 mặt: `[Front, Back, Cut]` → `out_doc.page_count == 3`.
- 1 mặt: `[Front, Cut]` → `out_doc.page_count == 2`.
- Độc lập với `sheets_needed` (không lặp cụm).

---

## Error Handling

| Tình huống | Xử lý |
|---|---|
| 2 mặt + số trang lẻ | `ValueError` nêu rõ số trang hiện có + yêu cầu chẵn (Yêu cầu 1.4) — giữ nguyên hiện tại. |
| File nguồn 0 trang | `ValueError` "File nguồn không có trang nào." |
| Một mẫu không có đường bế (`die_items`) | Bỏ qua phần khuôn của ô đó, log cảnh báo; artwork vẫn đặt. |
| Helper trả layout rỗng (không ô nào fit) | Output cụm trang rỗng-an-toàn + report cảnh báo; không crash. |
| `page_dims_qty` rỗng | Helper trả `placements=[]`, `sheets_needed=0`. |
| SL chỉ nhập ở trang lẻ (2 mặt) | Bỏ qua (chỉ đọc SL trang chẵn) — không lỗi. |
| Solver bin-pack lỗi/timeout | Bắt exception, log, trả layout rỗng-an-toàn cho preview; render raise lỗi rõ ràng. |

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Chọn tập trang Mặt trước và liên kết Mặt sau

For any `page_count >= 1`:
- khi 1 mặt, tập trang Mặt trước bằng tất cả các trang `[0..page_count-1]` và mọi `back_of` là `None`;
- khi 2 mặt (và `page_count` chẵn), tập trang Mặt trước bằng đúng các trang ở vị trí chẵn `{0,2,4,...}`, và mỗi trang Mặt trước `i` liên kết duy nhất với Mặt sau `i+1`.

**Validates: Requirements 1.1, 1.2, 1.3, 6.2**

### Property 2: Lật gương là đối xứng và involution

For any placement bất kỳ trên tờ và cạnh lật `e ∈ {long, short}`:
- nếu `e == long` thì tâm-X của ô lật và ô gốc đối xứng qua trục dọc giữa tờ (`cx_front + cx_back == sheet_w`) và tâm-Y giữ nguyên;
- nếu `e == short` thì tâm-Y đối xứng qua trục ngang giữa tờ (`cy_front + cy_back == sheet_h`) và tâm-X giữ nguyên;
- lật gương hai lần trả về đúng vị trí ban đầu (involution).

**Validates: Requirements 3.1, 3.4**

### Property 3: Mỗi ô Mặt sau khớp ô Mặt trước tương ứng

For any layout Mặt trước (gồm nhiều mẫu), kết quả lật gương cả cụm thoả:
- số ô Mặt sau bằng số ô Mặt trước;
- ô Mặt sau thứ `i` đối xứng vị trí với ô Mặt trước thứ `i` theo cạnh lật đã chọn;
- `src_page_idx` của ô Mặt sau thứ `i` bằng `src_page_idx` của Mặt trước cộng 1 (trang Mặt sau của đúng mẫu đó);
- số ô của mỗi mẫu ở Mặt sau bằng số ô của mẫu đó ở Mặt trước.

**Validates: Requirements 2.4, 3.3, 3.4**

### Property 4: Chọn solver theo số lượng và căn giữa tờ

For any `page_dims_qty` hợp lệ:
- nếu tổng SL > 0 thì helper dùng `solve_offset_mixed` và `sheets_needed >= 1`;
- nếu tổng SL == 0 thì helper dùng `solve_auto_fill_mixed` và `sheets_needed == 1`;
- bbox bao các ô được căn giữa trên usable area (lề dư trái bằng lề dư phải, lề dư trên bằng lề dư dưới trong sai số làm tròn).

**Validates: Requirements 2.1, 2.2, 5.1**

### Property 5: Số lượng của mẫu lấy từ trang Mặt trước

For any ánh xạ số lượng theo trang và mọi cặp `(front_idx, back_idx)` khi 2 mặt, số lượng dùng để trộn của một mẫu bằng số lượng ghi ở trang Mặt trước của mẫu đó; số lượng ghi ở trang Mặt sau (nếu có) bị bỏ qua.

**Validates: Requirements 2.3**

### Property 6: Preview khớp output

For any đầu vào CNC hợp lệ giống nhau, layout Mặt trước mà Preview_Service nhận được và layout Mặt trước mà CNC_Renderer dùng để render là **trùng khớp** theo từng ô (vị trí, kích thước, cờ xoay, `src_page_idx`/`pageIdx`), và Mặt sau dựng ở preview (lật gương cụm theo cạnh lật) trùng với Mặt sau output. Số ô từng mẫu trong preview bằng `placed_by_page` của output.

**Validates: Requirements 5.3, 6.3, 6.4**

### Property 7: Khuôn gộp đúng số đường bế theo từng mẫu

For any layout, trang Khuôn vẽ đúng một "đơn vị đường bế" cho mỗi ô trên tờ (tổng số lần vẽ `draw_die_lines_for_placement` bằng số ô có đường bế), và đường bế của mỗi ô lấy từ geometry của đúng mẫu tương ứng (`die_items` theo `src_page_idx` của ô); số ô có đường bế nhóm theo mẫu khớp `placed_by_page`.

**Validates: Requirements 4.1**

### Property 8: Output đúng một cụm trang, độc lập số tờ

For any đầu vào hợp lệ:
- khi 2 mặt, số trang output bằng đúng 3 theo thứ tự `[Front, Back, Cut]`;
- khi 1 mặt, số trang output bằng đúng 2 theo thứ tự `[Front, Cut]`;
- số trang output không phụ thuộc `sheets_needed` (không lặp cụm theo số tờ cần in).

**Validates: Requirements 7.1, 7.2, 7.3**

### Property 9: Report ghi số tờ theo sheets_needed

For any cấu hình số lượng, tổng số tờ ghi trong report bằng `sheets_needed` mà Layout_Helper tính ra.

**Validates: Requirements 7.4**

---

## Testing Strategy

*A property is a characteristic that should hold across all valid executions. Properties bridge human-readable specs and machine-verifiable guarantees.*

### Phương pháp kép

- **Property tests** (Python: `hypothesis` — cần bổ sung vào dev-deps backend): các hàm thuần — chọn front pages, mirror, căn giữa, selector solver, đếm đường bế, preview==output.
- **Unit/Example tests** (`pytest`): default cạnh lật, side-effect boong/duplex (đếm lần gọi qua monkeypatch), validate trang lẻ, cấu trúc cụm trang.
- **Integration/Smoke**: dispatch `imposerMode=='cnc'` → `run_cnc_two_sided`; chạy full suite backend để bảo đảm không hồi quy (Yêu cầu 9.2/9.3).
- **Frontend**: example/component test (Vitest) cho 3 chế độ lật xem và hiển thị ô SL theo trang chẵn; có thể dùng `fast-check` cho phép lật gương trong toạ độ SVG nếu muốn mở rộng.

### Cấu hình property test
- Tối thiểu **100 iteration** mỗi property (randomization).
- Mỗi property test gắn tag: **Feature: cnc-multi-template, Property {number}: {tên}**.
- Generators cần phủ: số mẫu 1..N, kích thước ô đa dạng (có/không xoay), SL hỗn hợp (0 và >0), cạnh lật long/short, page_count chẵn/lẻ.

### Ánh xạ Property → Test (backend)

| Property | Hàm/đối tượng test | Loại |
|---|---|---|
| 1 | `_select_front_pages` | property |
| 2 | `mirror_placements` (long/short, involution) | property (mở rộng test hiện có) |
| 3 | `mirror_placements_multi` | property |
| 4 | `build_cnc_front_layout` (selector + căn giữa) | property |
| 5 | `_qty_for` / trích SL theo front | property |
| 6 | helper gọi từ 2 đường (preview vs render) trả khớp | property |
| 7 | đếm `draw_die_lines_for_placement` (monkeypatch/spy) | property |
| 8 | `run_cnc_two_sided` → `page_count` | property (PDF tối giản như test hiện có) |
| 9 | report string chứa tổng tờ == `sheets_needed` | property |
| 3.2 | default flip_edge=='long' | example |
| 4.2/4.3 | boong: front+cut, không back (spy) | example |
| 4.4 | duplex: front+back (spy) | example |
| 1.4 | trang lẻ → ValueError | example (đã có) |
| 9.1 | non-CNC mixed preview không đổi | regression/example |

### Lưu ý không dùng PBT
- Vẽ boong/duplex (4.2/4.3/4.4), toggle UI (6.1, 8.x), dispatch (5.2/5.4): dùng example/spy/smoke vì là side-effect/cấu hình, hành vi không biến thiên theo input.
- Không PBT cho render PDF thực (chi phí cao); chỉ PBT trên logic thuần và đếm lệnh vẽ qua spy.
