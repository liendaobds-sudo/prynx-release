# Báo cáo audit — Hệ toạ độ của `extract_vector_paths`

Ngày: 2026-07-28
Phạm vi: `backend/app/workers/pdf_content_parser.py` và toàn bộ consumer của nó.
Trạng thái: **chờ duyệt** (giai đoạn 2 của `prynx-audit-workflow`). Chưa sửa gì.

## Tóm tắt điều hành

Parser trả toạ độ path theo một hệ **thứ ba** — không phải PDF-native, cũng không phải tương đối gốc trang. Khi MediaBox có gốc khác (0,0), sai số là

```
Δ = (+mb[0], −mb[1])
```

Đo được (trang MediaBox `[50,30,250,130]`, nét tại raw y = 40):

```
raw y trong file        = 40.0
parser trả y            = 60.0   | page-relative đúng = 90.0
```

**Không có lỗi nào đang chảy máu.** Δ là phép **dịch thuần**, và mọi consumer tôi kiểm đều bất biến với phép dịch: hoặc chỉ dùng `width`/`height`, hoặc tự trừ bbox của chính nó (`_poly_to_trim_coords`, `_normalize_polygon_to_unit`, `transform_die_point`). Rủi ro ở đây là **hợp đồng và bẫy hồi quy**, không phải sai kết quả hiện tại.

Vì vậy đề xuất của tôi là **không đổi hợp đồng parser** (lô 3 bên dưới), chỉ dựng lưới an toàn và bịt đường hở. Lý do nêu ở §3.2 và §4.1: sửa "cho đúng" một phía sẽ làm hỏng thứ đang chạy tốt.

---

## §1 — Hợp đồng hệ toạ độ

| Mã | Mức | Effort | Phát hiện |
|---|---|---|---|
| §1.1 | P1 | M | Parser lật y quanh sai pivot |

`pdf_content_parser.py:601` truyền `page_h = mb[3] - mb[1]`; `_parse_stream` lật y bằng `page_height - ty` (các nhánh `m`/`l`/`c`/`v`/`y`/`re`, dòng 260-323) và giữ x **raw**. Đúng ra phải `mb[3] - ty` cho y và `tx - mb[0]` cho x. Hiệu số không phụ thuộc điểm nên toàn bộ path bị dịch đều.

| Mã | Mức | Effort | Phát hiện |
|---|---|---|---|
| §1.2 | P2 | S | `page_rect()` bỏ gốc box |

`pdf_ops.py:275-279` — `page_rect()` trả `Rect(0, 0, mb[2]-mb[0], mb[3]-mb[1])`, ném bỏ `mb[0]`/`mb[1]`. Đây là nguồn của giả định "trang bắt đầu tại (0,0)" lan khắp tầng layout.

| Mã | Mức | Effort | Phát hiện |
|---|---|---|---|
| §1.3 | P1 | S | Docstring không khai báo hệ toạ độ |

`pdf_content_parser.py:489-508` liệt kê đủ các khoá trả về nhưng **không nói** `rect`/`items` thuộc hệ nào. Consumer mới buộc phải đoán. Đây là nguyên nhân gốc khiến §1.1 tồn tại lâu mà không ai phát hiện.

---

## §2 — Đường đi không qua chốt canonicalize

Chốt `nup_engine._canonicalize_page_space` (thêm 2026-07-28) chuẩn hoá gốc MediaBox về (0,0), nhưng nó chỉ được gọi tại **một** chỗ: `nup_engine.run_nup_engine:273`.

| Mã | Mức | Effort | Phát hiện |
|---|---|---|---|
| §2.1 | P2 | M | Preview và detect-shape không canonicalize |

`_canonicalize_page_space` **không xuất hiện** trong `backend/app/api/routes/imposition.py`. Các route mở file trực tiếp:

- `imposition.py:819` — `detect_shape` → `detect_die_shapes`
- `imposition.py:1841` — `preview-layout`
- `imposition.py:536`, `:4063`, `:4114`

Hệ quả: với file gốc lệch **hoặc** `/Rotate ≠ 0`, preview đọc một hệ, export đọc hệ khác. Riêng ca `/Rotate ≠ 0` đáng lo hơn ca gốc lệch, vì canonicalize **hoán w/h** (`nup_engine.py:154-160`) còn preview đọc `page.rect` bỏ cả rotation → trim preview có thể khác trim export. Chưa đo ca này.

| Mã | Mức | Effort | Phát hiện |
|---|---|---|---|
| §2.2 | P3 | S | FIX_HAIRLINES không qua chốt |

`action_engine.py:1096` (`_action_fix_hairlines`, route `/preflight/fix`). Hiện vô hại — xem §3.2.

---

## §3 — Hai chỗ thật sự giả định gốc (0,0)

Trong ~25 consumer đã kiểm, chỉ hai chỗ không bất biến dịch.

| Mã | Mức | Effort | Phát hiện |
|---|---|---|---|
| §3.1 | P1 | S | `artwork_bbox` trả Rect tuyệt đối rồi dùng làm `clip=` |

`sticker_homogeneous.py:287-325` trả `Rect(min(xs0), min(ys0), max(xs1), max(ys1))` — toạ độ **tuyệt đối** theo hệ parser. Giá trị này được truyền làm tham số `clip=` của `show_pdf_page` (`nup_artwork.py:806-812`, nguồn `nup_process_chunk.py:819`), tức trộn hệ parser với hệ trang nguồn. Hiện an toàn vì cả hai đều nằm sau chốt (nhóm A), nhưng đây là chỗ duy nhất mà một consumer ngoài chốt làm tương tự sẽ lệch ngay.

| Mã | Mức | Effort | Phát hiện |
|---|---|---|---|
| §3.2 | P0 **nếu sửa nửa vời** | S | Round-trip FIX_HAIRLINES đang tự triệt tiêu |

`_action_fix_hairlines` đọc path bằng parser rồi vẽ lại bằng `pdf_ops.ShapeBuilder`. Hai phía dùng **cùng một pivot sai**:

- parser: `y_out = page_height − ty`, `page_height = mb[3] − mb[1]`
- ShapeBuilder: `self.page_height − p.y`, với `page_height()` cũng `= mb[3] − mb[1]` (`pdf_ops.py:57-91, 287-289, 302-305`)

Đo thực tế trên trang MediaBox `[50,30,250,130]`:

```
raw y trong file        = 40.0
parser trả y            = 60.0   | page-relative đúng = 90.0
ShapeBuilder ghi lại y  = 40.0
=> round-trip           = TRIỆT TIÊU (đúng chỗ)
```

**Đây là lý do chính không nên sửa parser một mình.** Sửa `pdf_content_parser` mà không sửa `ShapeBuilder` (hoặc ngược lại) sẽ làm mọi nét hairline được "sửa dày" bị vẽ lệch `(+mb[0], −mb[1])`, và **không test nào bắt được**.

---

## §4 — Bẫy test

| Mã | Mức | Effort | Phát hiện |
|---|---|---|---|
| §4.1 | P1 | S | Test đang ghim hành vi SAI làm baseline |

`backend/tests/test_nup_canonical_origin.py:118`:

```python
assert _die_rect(src) == pytest.approx((60.0, -20.0, 240.0, 60.0), abs=1e-3)
```

Test này (tôi viết ở đợt trước) cố ý ghim bbox lệch để chứng minh chốt canonicalize có tác dụng. Hệ quả ngoài ý muốn: ai sửa parser thành page-relative sẽ thấy test **đỏ dù sửa đúng** — bẫy hồi quy ngược chiều. Cần viết lại thành assert Δ tường minh, nêu rõ đang ghim cái gì và vì sao.

| Mã | Mức | Effort | Phát hiện |
|---|---|---|---|
| §4.2 | P2 | M | Thiếu test bất biến dịch |
| §4.3 | P2 | M | `detect-shape` chỉ test bằng `_FakeDoc` |
| §4.4 | P3 | M | Thiếu parity preview ↔ export |

§4.2 là lưới rẻ nhất chặn rủi ro của §1.1: cùng nội dung, hai MediaBox khác gốc → kết quả consumer phải **trùng nhau**. Phủ `_select_from_paths`, `classify_shape`, `_poly_to_trim_coords`, `transform_die_point`, `build_shapely_polygon_from_paths`.

§4.3: `test_die_detection_pbt.py:41` dùng `_FakeDoc.extract_vector_paths`, không có PDF thật gốc lệch nào chạy qua `detect_die_shapes`.

---

## §5 — Phát hiện thêm (ngoài phạm vi, không sửa trong đợt này)

- §5.1 `pdf_wrapper.py:26` re-export `parse_content_stream as _parse_content_stream` — **không nơi nào dùng**, import chết.
- §5.2 `desktop/src/components/workspace/editGeometry.ts:32-68` đã làm **đúng** công thức mà backend thiếu: `pageHeightPt - (yt - by0)` và `x - bx0`, trừ gốc box trước khi lật. Quy ước đúng đã có sẵn trong repo, chỉ backend lệch.
- §5.3 `cut_export` dùng parser **riêng** (`cut_layer_extractor.extract_cut_contours`, toạ độ raw, không lật y) — hai bộ parse content stream song song trong dự án. Đường "Gửi Máy Bế" không đi qua `pdf_content_parser` nên không bị §1.1.

---

## Đề xuất thứ tự sửa theo lô

### Lô 1 — Lưới an toàn, không đổi hành vi (khuyến nghị làm)

3 file. Không đổi một dòng logic nào.

1. `pdf_content_parser.py` — khai báo hệ toạ độ trong docstring `parse_content_stream`, ghi rõ Δ và lý do giữ nguyên (§1.3, §1.1).
2. `test_nup_canonical_origin.py` — viết lại §4.1 thành assert Δ tường minh kèm giải thích.
3. Test mới `test_parser_translation_invariance.py` — §4.2, phủ 5 consumer chính.

Verify: `pytest tests`.

### Lô 2 — Bịt đường hở (khuyến nghị làm)

2 file. Gọi `_canonicalize_page_space` ở `detect-shape` và `preview-layout` (§2.1), để preview/detect đọc cùng hệ với export.

Rủi ro: hai route này chạy nóng, canonicalize ghi file tạm → cần đo thời gian preview trước/sau. Nếu chậm rõ, chuyển sang chuẩn hoá **trong bộ nhớ** thay vì ghi file tạm.

Verify: `pytest tests` + đo thời gian `/preview-layout`.

### Lô 3 — Đổi hợp đồng parser (khuyến nghị **KHÔNG** làm)

4 file, phải đi cùng một lô vì là cặp phụ thuộc: `pdf_content_parser.py` + `pdf_ops.ShapeBuilder`/`page_rect` + `sticker_homogeneous.artwork_bbox` + toàn bộ golden.

Lý do khuyên không làm:

- Lợi ích thực tế **bằng 0**: mọi consumer đã bất biến dịch (§3), hai ngoại lệ thì một được chốt bảo vệ, một tự triệt tiêu.
- Chi phí và rủi ro cao nhất trong ba lô: §3.2 cho thấy sửa lệch pha một phía là hỏng nét hairline im lặng.
- Sau lô 1 + lô 2, rủi ro còn lại chỉ là "consumer mới viết sai" — mà lô 1 đã chặn bằng docstring + test bất biến.

Nếu vẫn muốn làm, điều kiện bắt buộc: lô 1 xong trước (để có lưới), và sửa đồng thời cả 4 file trong một commit.

---

## Chốt duyệt

Xin duyệt danh sách trước khi tôi sửa. Đề xuất: **làm lô 1 và lô 2, bỏ lô 3**.
