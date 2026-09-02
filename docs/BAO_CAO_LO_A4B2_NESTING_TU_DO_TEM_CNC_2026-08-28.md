# Báo cáo Lô A4b-2 — Giữ lỗ khuôn trong bộ dò đường bế

Ngày: 2026-08-28. Nhánh `codex/pre-release-audit-2026-08-04`. Máy Windows thật, `D:\pdfcompare`.
Đóng finding **A4b-3** của báo cáo Lô A4b-1.

## 1. Vấn đề

`extract_page_die_cut_polygon` trả về biên ngoài **đặc**, `holes = 0`. Với packing thì
bảo thủ và an toàn, nhưng lớp CUT **không có nét dao cửa sổ** — thợ bế ra sản phẩm
không đục được cửa sổ, lỗ treo, lỗ khoét tay cầm.

Nguyên nhân gốc nằm ở `_path_items_to_polygon`: mỗi subpath thành một `Polygon` **đặc**
riêng rồi `unary_union` tất cả. Hợp của hình ngoài với hình trong = hình ngoài, nên vòng
lỗ bị nuốt. Khuôn thật vẽ biên ngoài và lỗ trong **cùng một path** (cùng spot CutContour),
nên mất vòng trong là mất nét dao.

Writer đã hỗ trợ lỗ từ Lô A1c (`test_trang_cut_co_du_vong_ngoai_va_vong_lo` khoá 2 vòng
mỗi instance). `_polygon_to_canonical_mm` cũng đã đọc `polygon.interiors` và dựng
`RenderPolygonV1(outer, holes)`. Mắt xích thiếu duy nhất là **bộ dò**.

## 2. Quyết định sản phẩm

Chủ dự án chọn **(a) nâng cấp bộ dò tại gốc**. Bỏ (b) resolver riêng cho đường manifest
(lý do: thành hai bộ dò song song, đúng loại nợ Lô A4a vừa dọn) và (c) chỉ mở nesting cho
khuôn không lỗ (lý do: loại đúng nhóm hàng hưởng lợi nhiều nhất).

## 3. Cách làm giữ an toàn cho lane legacy

`_path_items_to_polygon` có 4 callsite legacy, tất cả dựa vào hành vi hình đặc:

| Callsite | Việc |
|---|---|
| `nup_diecut.py:274` (trong `extract_page_die_cut_polygon`) | biên khuôn cho collision |
| `nup_diecut.py:405` | head-to-tail overlap |
| `die_detection.py:1058` | contour CNC |
| `pont_collision.py:158` | polygon tem cho va chạm pont |

Consumer đáng lo nhất là `layout_compute.py:425` → `base_poly` → `resolve_layout_collisions`.
Nếu polygon có lỗ, collision sẽ cho xếp tem **vào lòng lỗ** của tem khác → đổi layout mọi
job tem bế đang chạy.

Vì vậy tham số mới mặc định **tắt**:

```python
def _path_items_to_polygon(path_items, *, keep_holes=False)
def extract_page_die_cut_polygon(src_page, *, keep_holes=False)
```

Bốn callsite legacy gọi không tham số nên đi **đúng nhánh code cũ**, không đổi một byte.
Chỉ `nesting_source_geometry.resolve_sticker_source_geometry` truyền `keep_holes=True`,
qua `functools.partial` để hợp đồng `polygon_extractor(page)` của test injection không đổi.

`nup_engine.py` import `extract_page_die_cut_polygon` nhưng **không gọi** — đã xác minh
bằng grep, không có rủi ro.

## 4. Thuật toán phân loại vòng

Hàm mới `_rings_to_polygon_with_holes(rings)` phân loại theo **độ sâu lồng (even-odd)**:
vòng nằm trong số **chẵn** vòng khác là vật liệu, số **lẻ** là lỗ. Vòng cha trực tiếp là
vòng bao có diện tích **nhỏ nhất**, tìm được bằng cách sắp vòng giảm dần theo diện tích rồi
lấy vòng bao cuối cùng trong tiền tố. Nhờ vậy khuôn lồng nhiều tầng (vành khuyên có đảo)
ra đúng, không chỉ ca một lỗ.

## 5. Bằng chứng end-to-end đã đo

Đo trên artifact production thật (`quantity=3`, 3 con trên 1 tờ, `outputSides=[front, cut]`):

| Trang | `m` | `h` | `S` | `Do` |
|---|---|---|---|---|
| 0 (front) | 3 | 3 | 0 | 3 |
| 1 (cut) | **6** | **6** | 3 | 0 |

Trang CUT có **2 vòng mỗi con** (biên ngoài + cửa sổ). Trang front có **1 vòng mỗi con** —
clip artwork chỉ lấy vòng ngoài, đúng quyết định §7.2 (a) "vùng lỗ CÓ in mực"; kẹp lỗ vào
clip sẽ chừa trắng cửa sổ, sai hành vi xưởng.

`resolve_sticker_source_geometry` trên fixture 30×30 giờ trả `holes = 1` với biên lỗ đúng
`HOLE_LO..HOLE_HI`, thay vì `holes = 0` như trước.

### Test có thật sự bắt lỗi

Đã tạm đổi `keep_holes=True` → `False` và chạy lại: **2 test đỏ** đúng chỗ.

```
assert 3 == (2 * 3)
FAILED test_fixture_cho_dung_contour_khuon_30x30
FAILED test_lo_khuon_di_tu_bo_do_den_lop_cut_cua_artifact
```

Content stream khi đó chỉ có 3 lệnh `m` — biên ngoài, không cửa sổ. Đã khôi phục cờ và
chạy lại xanh.

## 6. Phạm vi lô — 4 file

| File | Trạng thái | Thay đổi |
|---|---|---|
| `backend/app/workers/nup_diecut.py` | tracked, M | +90 / −5 — file tracked **duy nhất** bị chạm |
| `backend/app/core/nesting_source_geometry.py` | untracked WIP | `partial(..., keep_holes=True)` + import |
| `backend/tests/test_nup_diecut_holes.py` | mới | 10 test |
| `backend/tests/test_nesting_production_pipeline.py` | untracked WIP | +assert lỗ, +1 test end-to-end |

## 7. Verify

| Bộ | Kết quả | Baseline |
|---|---|---|
| Bộ 12 file bắt buộc + file mới | **469 passed** | 458 (+10 mới +1 end-to-end) |
| Toàn bộ `backend/tests` | **4261 passed, 19 skipped, 0 failed**, 665s | 4251 passed, 19 skipped |
| Callsite legacy (`custom_nfp_fast_path`, `lazy_nfp`, `cnc_collision`, `die_spot_deny_and_zorder`, `one_dao_shape_force_rectangle`, `sticker_homogeneous`) | **61 passed** | không đổi |

Chênh đúng +10 test mới của lô. Không có test cũ nào đổi kết quả ⇒ **parity legacy đã chứng minh**
trên toàn bộ suite, không chỉ trên bộ liên quan.

Không chạy `cargo test` và `vitest`/`tsc`: lô chỉ chạm Python, không có file Rust hoặc
TypeScript nào thay đổi, không cần sinh lại ts-rs.

## 8. Còn hở

| Mã | Nội dung | Mức |
|---|---|---|
| A4b-2a | Lane legacy vẫn nhận biên đặc. Chủ đích và an toàn, nhưng nghĩa là collision tem–tem chưa hưởng lợi từ lỗ khuôn. Đổi nó là đổi layout job đang chạy ⇒ cần duyệt riêng | P3 |
| A4b-2b | `resolve_cnc_source_geometry` đi qua `DetectedShape` nên **không** dùng bộ dò này. Lỗ khuôn cho đường CNC chưa được kiểm | P2 |
| A4b-2c | Nếu nhiều path cùng màu và một path phủ lên lỗ của path khác, `unary_union` ở `extract_page_die_cut_polygon` sẽ **bít** lỗ. Đúng về ngữ nghĩa (có nét cắt phủ lên thì không còn là lỗ) nhưng chưa có test | P3 |

## 9. Việc kế tiếp

**A4b-3**: đóng ô CNC Cổng A (truyền `detected_shape`), rồi nối route + `processHandlers`.
Rủi ro đã biết: 3 callsite payload lệch naming/đơn vị (EXECUTE camelCase+mm, PREVIEW
snake_case+point, `preview-layouts-batch`).

Finding còn chờ chủ dự án quyết: **F3-1** (`build_production.ps1` chưa nung cặp cờ Mixed
Nesting), **A2-1** (nén `gap = max(gap_x, gap_y)` ở CNC gang), **A4a-2** (wire format tagged
`{kind}` cho `GridStrategy`). Chặng B: **C0-6** (worker/RAM grant cho kernel PyO3), **C0-7**
(ngân sách profile không đơn điệu — đã đo, `orientationEvaluations` giảm 180→144→138 từ
fast→tight).
