# Báo cáo Lô A4b-3 — Ô CNC của Cổng Chặng A + lỗ khuôn cho lane CNC

Ngày: 2026-08-28. Nhánh `codex/pre-release-audit-2026-08-04`. Máy Windows thật, `D:\pdfcompare`.
Đóng finding **A4b-1** (ô CNC chưa có ca dương) và **A4b-2b** (lỗ khuôn cho đường CNC).

## 1. Ba việc trong lô

1. **Ô CNC Cổng A** — chứng minh `tool="cnc_imposer"` chạy end-to-end với `DetectedShape` **thật**.
2. **Lỗ khuôn cho lane CNC** — lane này lấy contour qua `DetectedShape`, **không** đi qua
   `extract_page_die_cut_polygon`, nên bản vá §A4b-2 một mình không đủ.
3. **Sửa hồi quy hiệu năng** mà chính §A4b-2 vừa đưa vào (phát hiện khi đo lô này).

## 2. Hồi quy hiệu năng §A4b-2 và cách sửa

Nhánh giữ lỗ phân loại vòng bằng cách quét cặp đôi ⇒ O(n²) lời gọi GEOS `contains`.
Đo thật, so với nhánh hợp-đặc:

| Ca | n | Trước | Sau |
|---|---|---|---|
| Vòng rời (lưới) | 400 | 565ms — **×10,8** | 52ms — ×1,69 |
| Vòng lồng sâu | 200 | 154ms — **×18,9** | 42ms — ×6,04 |
| **Panel đục lỗ (thực tế)** | 400 | — | 26ms — **×0,91** |

Hai thay đổi:

- **Chỉ mục không gian.** `STRtree` (Shapely 2.0.6, `query` trả index) lọc ứng viên theo bbox;
  `contains` chỉ chạy trên ứng viên mà bbox đã chứa điểm thăm dò. Có nhánh lùi về quét đầy đủ
  nếu `STRtree` không dùng được.
- **Thoát sớm.** Xét ứng viên từ nhỏ tới lớn, vòng bao đầu tiên gặp chính là vòng bao trực tiếp
  nên dừng ngay. Không có bước này thì khuôn lồng sâu vẫn tốn n lời gọi `contains` mỗi vòng.

Ca **thực tế của xưởng** (một biên ngoài + nhiều lỗ rời: panel đục lỗ, lỗ treo) giờ **nhanh hơn**
nhánh cũ, vì dựng trực tiếp một `Polygon` có 400 lỗ thay vì `unary_union` 401 hình chồng nhau.
Ca lồng sâu 200 tầng vẫn ×6 nhưng không có thật trong ngành in — khuôn thật sâu tối đa 3 tầng.

## 3. Lỗ khuôn cho lane CNC — vì sao phải hai lượt

Contour CNC đi `_same_color_group_poly` → `_polygon_to_page_contour` → `DetectedShape.page_contour`.
Bật cờ giữ lỗ ngay trên lượt đó có **hai** hệ quả đã đo, cả hai đều là đổi hành vi legacy:

| Ca | `keep_holes=False` | `keep_holes=True` |
|---|---|---|
| khuôn không lỗ | contour OK, holes=0, `poly`=8 điểm | **giống hệt** |
| khuôn + cửa sổ | contour OK, holes=0, `poly`=**5** điểm | contour OK, holes=1, `poly`=**8** điểm |
| lồng 3 tầng | contour OK, holes=0, `poly`=5 điểm | contour **None**, `poly`=5 điểm |

- `DetectedShape.poly` đổi từ 5 sang 8 điểm — **cùng hình, khác biểu diễn đỉnh** (`unary_union`
  chuẩn hoá về 5, còn nhánh giữ lỗ giữ nguyên đỉnh trùng từ parser). Đủ để đổi fingerprint và
  phá golden của lane collision/nesting CNC.
- Khuôn lồng nhiều tầng thành `MultiPolygon`; `_polygon_to_page_contour` fail-closed với
  MultiPolygon theo chủ đích, nên contour **mất hẳn** — hồi quy so với trước bản vá.

Vì vậy contour đi **lượt riêng**, `paths` tái dùng nên không trích vector lại:

```python
poly = _same_color_group_poly(page, target_color, paths=paths)              # legacy, đặc
poly_holed = _same_color_group_poly(page, target_color, paths=paths, keep_holes=True)
page_contour = _polygon_to_page_contour(poly_holed, page_idx)
if page_contour is None:
    page_contour = _polygon_to_page_contour(poly, page_idx)                 # lùi, không hồi quy
poly_coords = _poly_to_trim_coords(poly)                                    # legacy giữ nguyên
```

Kết quả đo sau bản vá:

| Ca | contour | holes | `poly` | so với trước |
|---|---|---|---|---|
| khuôn không lỗ | OK | 0 | 8 điểm | `poly` **giữ nguyên** |
| khuôn + cửa sổ | OK | **1** | **5** điểm | `poly` **giữ nguyên**, contour có lỗ |
| lồng 3 tầng | OK | 0 | 5 điểm | `poly` giữ nguyên, contour lùi về đặc |
| panel 4 lỗ | OK | **4** | 5 điểm | 4 lỗ giữ đúng |

Ba số `poly` (8/5/5) khớp **chính xác** số đo trước bản vá ⇒ lane legacy CNC không đổi.

## 4. Ô CNC Cổng A

File mới `backend/tests/test_nesting_cnc_pipeline.py`, 7 test. Điểm quan trọng: chạy
`detect_die_shapes` **thật** trên snapshot rồi truyền `DetectedShape` vào pipeline, thay vì nhồi
contour bằng tay — nhồi tay rất dễ vi phạm bất biến mà vẫn cho test xanh (bài học Lô A4b-1).

| Test | Khoá điều gì |
|---|---|
| `test_fixture_cnc_cho_dung_contour_co_lo` | chốt tự kiểm fixture: bộ dò trả 40×40 với 1 lỗ 14..26 |
| `test_cnc_solve_va_render_duoc_voi_detected_shape_that` | validator sạch, đủ quantity, artifact đủ trang |
| `test_cnc_placed_count_khong_vuot_tran_hinh_hoc` | autofill không vượt trần diện tích |
| `test_cnc_lo_khuon_toi_duoc_lop_cut` | trang CUT có 2 vòng/chi tiết, front có 1 vòng/chi tiết |
| `test_cnc_thieu_detected_shape_thi_fail_closed` | resolver không được dò lại |
| `test_cnc_detected_shape_lech_trang_thi_fail_closed` | shape trang khác bị chặn |
| `test_cnc_shape_khong_co_page_contour_thi_fail_closed` | shape từ cache cũ bị chặn |

## 5. Test có thật sự bắt lỗi

Tạm đổi `keep_holes=True` → `False` ở lượt contour và chạy lại: **5 test đỏ** đúng chỗ.

```
FAILED test_nesting_cnc_pipeline.py::test_fixture_cnc_cho_dung_contour_co_lo
FAILED test_nesting_cnc_pipeline.py::test_cnc_lo_khuon_toi_duoc_lop_cut
FAILED test_die_detection_page_contour.py::test_contour_cnc_giu_cua_so_lam_lo_khuon
FAILED test_die_detection_page_contour.py::test_contour_cnc_giu_nhieu_lo
FAILED test_die_detection_page_contour.py::test_lo_khuon_khong_doi_poly_legacy_cua_detected_shape
```

Đã khôi phục và chạy lại xanh.

## 6. Phạm vi lô — 5 file

| File | Trạng thái | Thay đổi của lô này |
|---|---|---|
| `backend/app/workers/nup_diecut.py` | tracked, M | STRtree + thoát sớm cho phân loại vòng (~33 dòng) |
| `backend/app/workers/die_detection.py` | tracked, M | `keep_holes` + lượt riêng cho contour + nhánh lùi (~20 dòng) |
| `backend/tests/test_nup_diecut_holes.py` | untracked, tạo ở lô trước | +4 test chỉ mục không gian |
| `backend/tests/test_die_detection_page_contour.py` | untracked WIP | +5 test lỗ khuôn CNC |
| `backend/tests/test_nesting_cnc_pipeline.py` | mới | 7 test ô CNC Cổng A |

Hai file tracked có sẵn WIP từ phiên trước nên `git diff --stat` báo tổng lớn hơn phần lô này:
`nup_diecut.py` +123 (gồm +90 của §A4b-2), `die_detection.py` +131 (gồm `DetectedPageContour`
và `_polygon_to_page_contour` của §CONTOUR.1).

## 7. Verify

| Bộ | Kết quả |
|---|---|
| **Toàn bộ `backend/tests`, máy sạch** | **4292 passed, 19 skipped, 0 failed**, 469s |
| Số test thu thập, đo 2 lượt | **4311** cả hai lượt (= 4292 + 19) |
| Bộ 12 file bắt buộc + `test_nup_diecut_holes` + `test_nesting_cnc_pipeline` | **485 passed** |
| `test_nesting_cnc_pipeline.py` riêng | **7 passed** |
| `test_die_detection_page_contour.py` riêng | **24 passed** |
| `test_nup_diecut_holes.py` riêng | **14 passed** |
| `test_mixed_nesting_native.py` riêng | **38 passed** |
| `test_die_detection_pbt.py` riêng | **17 passed** |

Không chạy `cargo test` và `vitest`/`tsc`: lô chỉ chạm Python, không có file Rust hoặc
TypeScript nào thay đổi.

### 7.1 Hai lượt full suite đỏ trước đó là nhiễu tải máy

Trước lượt chốt, hai lượt full suite mỗi lượt báo đúng **1 failed**, và là **hai test khác nhau**:

| Lượt | Thời gian | Test đỏ | Lý do đỏ |
|---|---|---|---|
| B | 1116s | `test_mixed_nesting_native::test_solve_nha_gil_nen_thread_khac_van_chay` | `spins > 1000` — đếm vòng thread chính theo wall-clock |
| C | 589s | `test_die_detection_pbt::test_legacy_response_shape` | Hypothesis `DeadlineExceeded` — 259ms so với deadline 200ms |
| chốt | **469s** | — | máy sạch, **0 failed** |

**Nguyên nhân gốc đã tìm ra và xử lý**: còn **12 tiến trình `pytest backend/tests` treo** từ các
phiên trước (cùng 2 lượt `cargo test` và 1 `vitest`). Chúng tranh CPU nên hai test nhạy thời gian
đỏ. Đã dừng toàn bộ 17 tiến trình; lượt chạy sau đó về 469s và sạch.

Bằng chứng cả hai test **không** liên quan nhân quả tới bản vá:

- `test_solve_nha_gil...`: grep `die_detection|nup_diecut|extract_page_die_cut|_same_color_group_poly`
  trong file cho **0 kết quả**. Test dựng request thuần từ `_rect(90, 60)`, `holes: []`, không mở
  PDF, không dò khuôn.
- `test_legacy_response_shape`: chạy `detect_die_shapes` trên `_FakeDoc`, mà
  `_FakePage.extract_vector_paths()` trả **`[]`**. `_same_color_group_poly` thoát ngay ở
  `if not paths: return None`, nên **lượt dò thêm của lô này không chạy một dòng nào** trong test đó.
- Cả hai xanh khi chạy riêng và khi chạy cả file của chúng.

### 7.2 Ghi chú về số nền

Số nền `4251 passed` trong tài liệu bàn giao được đo ở phiên trước, khi các tiến trình nêu trên
đang chạy, nên **không so trực tiếp được** với số của lô này. Mốc sạch đo lại được:

| Phép đo trên máy sạch | Số thu thập |
|---|---|
| Toàn bộ `backend/tests` | 4311 |
| Loại `test_nup_diecut_holes.py` (14) và `test_nesting_cnc_pipeline.py` (7) | 4290 |

4311 − 14 − 7 = 4290 ⇒ số học tự khớp. Điều chốt lại là **0 failed** trên máy sạch, cùng bằng
chứng nhân quả ở §7.1 cho hai test từng đỏ.

## 8. Còn hở

| Mã | Nội dung | Mức |
|---|---|---|
| A4b-3a | Khuôn **lồng nhiều tầng** (vành khuyên có đảo) vẫn nhận contour đặc qua nhánh lùi, tức lớp CUT không có nét dao các tầng trong. Đây đúng bằng hành vi trước bản vá nên không hồi quy, nhưng vẫn là giới hạn. Sửa đúng cần cho `_polygon_to_page_contour` nhận MultiPolygon, tức đổi hợp đồng fail-closed đang có chủ đích | P2 |
| A4b-3b | Lượt dò thêm cho contour tốn thêm một lần dựng polygon mỗi trang. Ca thực tế nhanh hơn nhánh cũ nên tổng chi phí nhỏ, nhưng chưa đo trên job CNC nhiều trang thật | P3 |
| A4b-3c | **Route và `processHandlers` vẫn chưa gọi pipeline.** Ba callsite payload còn lệch naming/đơn vị: EXECUTE camelCase+mm, PREVIEW snake_case+point, `preview-layouts-batch` | P1 |
| A4b-2a | Lane legacy (collision tem–tem, `DetectedShape.poly`) vẫn nhận biên đặc. Chủ đích và an toàn; đổi là đổi layout job đang chạy ⇒ cần duyệt riêng | P3 |

## 9. Việc kế tiếp

**A4b-4**: nối route + `processHandlers` (finding A4b-3c). Đây là mắt xích cuối để tính năng
tới được người dùng. Rủi ro đã biết là 3 callsite payload lệch naming/đơn vị.

Finding còn chờ chủ dự án quyết: **F3-1** (`build_production.ps1` chưa nung cặp cờ Mixed Nesting),
**A2-1** (nén `gap = max(gap_x, gap_y)` ở CNC gang), **A4a-2** (wire format tagged `{kind}` cho
`GridStrategy`), **A4b-3a** (MultiPolygon cho contour). Chặng B: **C0-6** (worker/RAM grant cho
kernel PyO3), **C0-7** (ngân sách profile không đơn điệu).
