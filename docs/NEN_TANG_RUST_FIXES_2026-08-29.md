# NHẬT KÝ SỬA — NỀN TẢNG / ỨNG VIÊN RUST

**Báo cáo gốc:** `docs/BAO_CAO_AUDIT_NEN_TANG_UNG_VIEN_RUST_2026-08-29.md`
**Máy đo:** Windows, 31,77 GB RAM, 16 CPU logic
**Baseline:** `8bc0a21`, branch `codex/pre-release-audit-2026-08-04`

> Lưu ý phạm vi: báo cáo gốc tập trung vào khuôn bế. Theo chỉ đạo của chủ dự án
> (2026-08-29), phần khuôn bế được **để nguyên, không sửa**; đợt sửa này chỉ làm các
> phát hiện NGOÀI khuôn bế, phát sinh từ khảo sát bổ sung cùng ngày. Báo cáo gốc
> chưa chứa các phát hiện đó và cần phụ lục riêng khi được duyệt.

---

## Lô T1-a — Nguồn text của bước CĂN TRANG: pdfplumber → PDFium ✅

**Trạng thái:** hoàn tất, verify hẹp đạt. Chưa `RUNTIME` (chưa thao tác trên app thật).

### Vấn đề

Bước căn trang của so sánh PDF lấy text bằng `PDFProcessor.extract_text_blocks`, tức
`pdfplumber` → `pdfminer.six`, một **parser PDF thuần Python** (đã kiểm: không có
`.pyd`/`.dll` nào trong package). Đo được ~86 ms/trang.

Nhưng consumer duy nhất của nó — `_sim` trong `run_comparison_pipeline` — chỉ dùng
**chuỗi text đã normalize** để tính `difflib` ratio. Nó không đọc `bbox`, `fontname`
hay `size` — đúng ba trường mà `extract_text_blocks` trả về. Tức pipeline đang trả
giá một parser đầy đủ để dùng một trường.

Đường này bật khi `use_alignment` (`comparison_engine.py:1569`): hai file **lệch số
trang**, không phải chế độ imposition, không phải CMYK — tức ca so hai bản revision
có chèn/xoá trang.

### Thay đổi

| File | Thay đổi |
|---|---|
| `backend/app/core/comparison_engine.py` | Thêm `_extract_page_texts_for_alignment` ở mức module (`:744`, 83 dòng gồm docstring). Xoá nested `_page_texts` (13 dòng). Nối hai call site. Gỡ `normalize_text` khỏi import cục bộ vì không còn dùng trong scope đó. |
| `backend/tests/test_compare_align_text_source.py` | **Mới** — 10 test khoá 5 bất biến. |

Diff gọn đúng 4 hunk, không chạm gì khác:
```
@@ -743,0  +744,83 @@   thêm helper
@@ -1492   +1575   @@   sửa import (bỏ normalize_text)
@@ -1507,13 +1589,0 @@   xoá _page_texts
@@ -1522,2  +1592,5 @@   nối call site + comment tag
```

Chi tiết đáng lưu ý trong bản sửa:

- **Khóa PDFium theo TỪNG TRANG**, không giữ cả vòng lặp (AGENTS.md rule #3). Giữ khóa
  suốt 40 trang sẽ chặn mọi preview khác. Theo đúng tiền lệ `pdf_processor.convert_to_images`:
  mở dưới một `pdfium_guard`, mỗi trang một `pdfium_guard` riêng, `normalize_text`
  (regex thuần) làm NGOÀI khóa.
- **Đóng `textpage`/`page` tường minh ngay trong khóa.** Nếu để GC dọn, finalizer của
  pypdfium2 có thể chạy trên thread khác ngoài `pdfium_guard` → access violation
  (tiền lệ đã ghi tại `pdf_processor.py:59-61`).
- **Không fallback về pdfplumber khi text rỗng.** Trang ảnh trả `""` là hành vi ĐÚNG và
  giữ nguyên như cũ; `_sim` tự rơi về chỉ dùng thumbnail khi một phía dưới 20 ký tự.
  Thêm fallback sẽ kéo lại đúng chi phí vừa bỏ, và kéo nặng nhất ở file bao bì nhiều ảnh.
- **Hủy hợp tác giữ nguyên** — `_raise_if_cancelled(cancel_check)` trước mỗi trang.
- Yêu cầu nhiều trang hơn số trang thật → list vẫn đúng độ dài, phần thừa `""`.

### Vì sao không đổi kết quả căn trang

`_sim` so text của A với text của B, và **cả hai phía đều lấy từ cùng một extractor**.
Khác biệt hệ thống giữa hai parser (thứ tự đọc, cách gộp khoảng trắng) triệt tiêu trong
tỉ số `difflib`. Điều quyết định là tính nhất quán giữa hai phía, không phải khớp từng
ký tự với pdfminer. Điều này được **đo**, không suy luận — xem bảng dưới.

### Số đo trước/sau

Harness: `tmp/bench_boa/bench_t1a_before_after.py`. Đường "CŨ" dựng lại nguyên văn logic
trước lô. PDF A4 dày chữ, B thêm 1 trang để `use_alignment` bật.

| Ca | CŨ (pdfplumber) | MỚI (PDFium) | Nhanh hơn | Tiết kiệm | `align_pairs` giống nhau |
|---|---:|---:|---:|---:|:---:|
| 10 trang vs 11 trang | 1.851,6 ms | **35,4 ms** | 52,3× | 1.816,2 ms | **True** |
| 20 trang vs 21 trang | 3.507,0 ms | **51,8 ms** | 67,7× | 3.455,2 ms | **True** |
| 40 trang vs 41 trang | 6.871,9 ms | **95,6 ms** | 71,9× | **6.776,3 ms** | **True** |

Bối cảnh: audit 2026-08-13 đo cả job so sánh 20 trang là 3,454 s. Trước lô này, riêng
bước trích text ở ca lệch trang đã tốn nhiều hơn toàn bộ job đó.

### Kiểm tra đã chạy

| Kiểm tra | Kết quả |
|---|---|
| `py_compile app/core/comparison_engine.py` | Đạt |
| `pytest tests/test_compare_align_text_source.py` | **10 passed** |
| `pytest` 7 file compare/align hiện có¹ | **115 passed** |
| Benchmark trước/sau (bảng trên) | Đạt, `align_pairs` khớp cả 3 ca |
| grep `_page_texts` trong `tests/` | 0 test tham chiếu hàm đã xoá |
| Lint Python | Không có cấu hình ruff/flake8 cho backend (chỉ `pytest.ini`) → không áp dụng |

¹ `test_compare_engine.py`, `test_compare_pipeline.py`, `test_compare_queue.py`,
`test_compare_parallel_parity.py`, `test_page_aligner.py`, `test_compare_tiled.py`,
`test_compare_region_render.py`.

### Bất biến được test khoá

1. **Cùng `align_pairs`** giữa nguồn PDFium và nguồn pdfplumber, trên 4 kịch bản
   (chèn giữa, xoá giữa, thêm cuối, thiếu đầu). So bằng similarity **chỉ-text** — cố ý
   không blend thumbnail, vì thumbnail giống nhau sẽ che khác biệt nguồn text và làm
   test mất tác dụng.
2. **Chống test xanh giả:** chốt cả hai nguồn đều vượt ngưỡng 20 ký tự và tương đồng
   ≥ 0,9 trên cùng trang, đồng thời hai trang khác nhau phải phân biệt được (< 0,9).
   Không có test này thì bất biến 1 vẫn xanh một cách vô nghĩa khi PDFium trả rỗng.
3. Trang ảnh → `""`.
4. Yêu cầu quá số trang thật → đúng độ dài, phần thừa `""`; `n_pages=0` → `[]`.
5. `cancel_check` → `ComparisonCancelled`.

Test đầu-cuối `test_text_heavy_inserted_page_does_not_cascade` bổ khuyết một khoảng
trống thật: test căn trang sẵn có (`test_compare_pipeline.test_inserted_page_does_not_cascade_false_diffs`)
dựng PDF **chỉ có hình chữ nhật, không có chữ**, nên nó đi nhánh `vis`-only và chưa bao
giờ phủ nhánh text.

### Còn lại / giới hạn

- **Chưa `RUNTIME`**: chưa mở app thật, chưa so hai file khách lệch số trang qua UI.
- Số đo dùng PDF sinh bằng reportlab (Helvetica base-14). File khách có font nhúng/CID
  làm pdfminer chậm hơn nữa, nên tỉ số thực tế có thể **cao hơn** 52–72×; chưa đo trên
  corpus khách.
- `pdfplumber` **vẫn còn** trong `pdf_processor.extract_text_blocks` vì `qc.py:92-96`
  và `rust_bridge._fallback_get_objects` còn dùng. Lô này cố ý không chạm hai chỗ đó —
  chúng cần bbox và đụng các bẫy di trú khác (xem dưới).
- Không sửa `preflight_rules/structure.py` và `fonts.py` (cũng chạy pdfplumber trên mọi
  trang) — thuộc lô T1-b/T2, chưa duyệt.

### Bẫy di trú đã tránh trong lô này (áp dụng cho lô sau)

Lô T1-a **không** đụng bẫy nào vì consumer chỉ cần text. Các lô sau thì có:

1. `qc.py:100` dùng `"(cid:" in raw_text.lower()` làm tín hiệu fallback OCR — đó là
   artifact riêng của pdfminer. PDFium không phát `(cid:N)`. Đổi parser ở đó mà không
   thay detector sẽ làm PDF scan/CID hỏng **không còn được OCR**, âm thầm. PrynX đã có
   heuristic phía PDFium: `geometry_reader._looks_unreliable:72`.
2. Số ký tự hai parser **không khớp**: đo được PDFium 190.185 vs pdfplumber 185.865 trên
   40 trang (lệch 2,3%). Rule `TEXT_DETECTED` báo đúng con số này ra người dùng
   (`structure.py:33`).
3. Gộp ký tự → word/dòng là thuật toán riêng của pdfplumber và **đã từng sai một lần** —
   `document_tools.py:236-237` ghi rõ gộp thủ công từng "nuốt dòng kề".
4. Hệ toạ độ ngược nhau: pdfplumber `top`/`bottom` gốc trên-trái; PDFium bottom-left.
5. Hợp đồng block có producer thứ hai: `ocr_engine.py:33` cố ý sinh đúng shape dict của
   pdfplumber.

---

## Chưa làm (chờ duyệt)

| Mục | Việc | Cần Rust? | Ghi ở |
|---|---|---|---|
| PNG optimize | `highlight_renderer.py:280` `optimize=True` → `compress_level=6`: đo được 2,4–3,1× nhanh hơn, **cùng dung lượng** | Không | thảo luận 2026-08-29 |
| `pdf_wrapper.save` | `pdf_wrapper.py:203-204` bỏ qua cả `garbage` và `deflate`; 4 call site tưởng đang điều khiển nén | Không | thảo luận 2026-08-29 |
| Encode GIF | `image_comparator.py:846-854` — 92–131 ms; crate `image` đã là dep của `native/` | Có | thảo luận 2026-08-29 |
| T1-b | `_check_live_text` → PDFium `CountChars` | Không | đụng bẫy #2 |
| T2 | Consumer cần bbox → PDFium per-char (đo được 7,4–7,7× nhanh hơn) | Không | đụng cả 5 bẫy |
| T3 | Vòng per-char → Rust (~10× trên T2) | Có | chỉ nếu T2 còn chậm |
| Tokenizer `channel_remover` | 1,4 MiB/s vs qpdf 7–8,6 MiB/s | Có | §RS.02 |
| Khuôn bế §RS.01, R-A…R-F | **Để nguyên theo chỉ đạo** | — | báo cáo gốc |

## Harness benchmark

Ở `tmp/bench_boa/` (`tmp/` bị gitignore). Theo bài học §PA.R2 của
`BAO_CAO_RE_AUDIT_HIEU_NANG_LO_P_A_2026-08-13.md` — benchmark dùng để nghiệm thu mà nằm
trong `tmp/` thì mất — cần promote sang `scripts/` khi có thêm lô được duyệt.

| File | Đo gì |
|---|---|
| `bench_t1a_before_after.py` | Trước/sau lô T1-a + đối chiếu `align_pairs` |
| `bench_pdfium_chars.py` | Ba tầng T1/T2/T3 của trích text |
| `bench_text_extract.py` | pdfplumber vs PDFium theo số trang |
| `bench_encode.py` | PNG `optimize` + GIF |
| `bench_tokenizer.py` | Lexer `channel_remover` vs qpdf |
| `bench_py_hot.py` | LUT argmin ΔE + lấy mẫu Bézier |
| `src/main.rs`, `bench_node.mjs`, `dump_node.mjs` | Boa vs V8 (khuôn bế) |
