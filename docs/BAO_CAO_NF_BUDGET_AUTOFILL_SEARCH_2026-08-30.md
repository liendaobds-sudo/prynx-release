# NF-BUDGET — search phase phí cho autofill lane (Tem/CNC)

Ngày: **2026-08-30**. Đơn vị: `W2-U09 / W7-U11`.
Trạng thái: **ĐỀ XUẤT CHỜ DUYỆT — chưa sửa production.**

Tiếp nối `docs/BAO_CAO_BENCHMARK_PREVIEW_PHASES_2026-08-30.md`: số sạch cho thấy pha **search
chiếm ~40% (3,2s)** thời gian cold preview autofill. Báo cáo này trả lời câu hỏi trước khi cắt:
**search có bao giờ giúp autofill trong lane thật (cardinal + fast + 3s) không?**

## 1. Bằng chứng — search KHÔNG thắng baseline ở autofill cardinal

A/B trên binary hiện hành (`b2cd6b46…`), `layoutIntent=autofill_single_sheet`, rotation
cardinal, profile `fast`, `timeBudgetMs=3000`, worker_grant=15 (đúng lane production). Công cụ:
`backend/.audit-tmp/ab_autofill_search.py`.

| Ca | placed | trialsRun | selectedCandidate | elapsedMs | termination |
|---|---:|---:|---|---:|---|
| simple_rect (1 hình chữ nhật) | 20 | 4 | **baseline** | 48 | sheet_full |
| l_interlock (chữ L lõm) | 8 | 4 | **baseline** | 90 | sheet_full |
| poly32 (đa giác 32 đỉnh) | 8 | 4 | **baseline** | 2.428 | sheet_full |
| mixed5 (5 loại khác nhau) | 57 | 0 | **baseline** | 5.470 | deadline |
| **file khách** (13 mẫu contour) | 46 | 0 | **baseline** | ~8.000 | deadline |

`anySearchHelped = False` trên **cả 5 ca**.

**Điểm mấu chốt:** ở simple/l/poly, cả 4 trial **đã hoàn tất** (48–2.428ms) mà **vẫn thua
baseline**. Nên đây không phải "trial hết giờ" — mà là **trial không cho bố cục tốt hơn greedy
baseline khi rotation là cardinal**. Với ca nhiều hình (mixed5, file khách), trial bị deadline
cắt (`trialsRun=0`) — cũng ra baseline. Dù đường nào, kết quả công bố là baseline.

## 2. Vì sao (mechanism)

- Lane Tem/CNC hardcode **cardinal** (`_CARDINAL_ROTATION_POLICY`, §6 audit gốc) + **fast** +
  **3000ms** (`nup_true_shape_nesting.py:DEFAULT_TIME_BUDGET_MS`).
- `run_autofill_baseline` là greedy bottom-left quét cardinal — với miền góc rời rạc 4 hướng nó
  đã gần tối ưu cho bài lấp đầy. `run_autofill_trial` thêm beam/refine/hoán vị thứ tự, nhưng
  **không mở rộng miền góc** (vẫn cardinal) nên không tìm ra bố cục dày hơn greedy.
- Lợi ích của trial mà báo cáo gốc §3.3 đo (chữ L 24→27) đến từ **free-angle + Balanced**, KHÔNG
  phải cardinal + fast. Lane này không dùng cả hai điều kiện đó.

Hệ quả: với contour thật (file khách, mixed5), search đốt trọn ~3s ngân sách rồi bị bỏ; với
hình đơn giản search rẻ nhưng vẫn vô ích. **Cả hai trường hợp search = 0 giá trị cho autofill
cardinal.**

## 3. Đề xuất — cắt search cho autofill cardinal (backend-only, có cổng, đảo được)

Không đụng Rust. Trong `nup_true_shape_nesting.py`, khi `layout_intent == autofill_single_sheet`
(và lane đang cardinal — hiện luôn đúng), đặt search budget ≈ 0 để vòng trial `break` ngay ở
checkpoint đầu:

- Cơ chế: `RunControl` re-arm deadline sau baseline; budget ~0 ⇒ checkpoint đầu của trial trả
  `DeadlineReached` ⇒ `trialsRun=0` ⇒ công bố baseline. **Baseline vẫn chạy đầy đủ** (nó cố ý bỏ
  qua deadline), nên chất lượng không đổi.
- Tách hằng: `AUTOFILL_TIME_BUDGET_MS` riêng với `DEFAULT_TIME_BUDGET_MS` (quantity giữ 3000ms).
- Escape hatch: env `PRYNX_NEST_AUTOFILL_SEARCH_MS` để bật lại search nếu cần đo/hồi quy.

**Kỳ vọng:** contour-heavy autofill (file khách) `search 3,2s → ~0` ⇒ cold ~8s → **~4,8s** máy
rảnh, `placedCount` **không đổi** (baseline vốn là phương án công bố). Hình đơn giản gần như
không đổi (search vốn đã rẻ).

## 4. Ràng buộc & rủi ro (phải giữ khi triển khai)

1. **Chỉ autofill.** `quantity_fulfillment` GIỮ search — corpus `ANGLE_ONLY` chứng minh search
   thiết yếu cho quantity (baseline cardinal xếp 0 con, trial free-angle xếp được). Không đụng.
2. **Chỉ cardinal.** Nếu sau này lane mở free-angle (cổng server-owned §6), search có thể giúp
   trở lại → phải gate theo rotation policy và re-audit. Ghi TODO tường minh.
3. **Không xóa code trial.** Chỉ đưa budget về ~0 cho autofill; giữ đường trial nguyên vẹn để
   quantity và tương lai free-angle dùng.
4. Vẫn cần **A/B trên vài file tem/CNC thật khác** trước merge (5 ca ở §1 + file khách là đủ
   chọn hướng, chưa phải mọi hình sản xuất).

## 5. Verify khi triển khai

- A/B trước/sau trên file khách + mixed5: `placedCount`, `sheetCount`, `poseRecordsSha256` **y
  hệt**; `searchMs` → ~0; cold wall giảm ~3s.
- Regression: `quantity_fulfillment` KHÔNG đổi (search vẫn chạy 3000ms).
- Test backend chốt: autofill request → manifest `trialsRun=0`, `selectedCandidate=baseline`,
  và budget quantity vẫn 3000ms.

## 6. Giới hạn

- Đo bằng LAB solve hand-built (đủ đọc `selectedCandidate`/`trialsRun`), không qua PDF thật cho
  4 ca synthetic; file khách thì đo qua đúng lane preview. Pattern nhất quán 5/5.
- Chưa phủ mọi hình sản xuất; đề nghị mở rộng A/B khi triển khai.
- Số cold "~4,8s sau cắt" là ngoại suy từ phase share máy rảnh, cần đo lại thực sau khi sửa.

---

## PHỤ LỤC — Đã triển khai + verify (2026-08-30)

Duyệt xong, đã sửa **backend-only** (không rebuild Rust):

- `nup_true_shape_nesting.py`: thêm `AUTOFILL_TIME_BUDGET_MS = 1` + `_time_budget_ms(layout_intent)`
  + env `PRYNX_NEST_AUTOFILL_SEARCH_MS`. Job builder dùng `_time_budget_ms(layout_intent)`:
  autofill → 1ms, quantity → 3000ms (không đổi).
- `test_nup_true_shape_nesting_entry.py`: `test_mac_dinh_luon_co_tran_thoi_gian` nay assert
  theo intent (quantity=DEFAULT, autofill=AUTOFILL_TIME_BUDGET_MS), giữ bất biến gốc
  (không None, `0 < budget ≤ 10000`).

### Kết quả đo (máy rảnh, N=8, autofill, file khách, binary hiện hành)

| Chỉ số | Trước NF-BUDGET | **Sau** |
|---|---:|---:|
| cold preview median | 8.065 ms | **5.027 ms** (−38%) |
| search | ~3.199 ms | **~214 ms** |
| baseline | ~2.694 ms | ~2.640 ms (không đổi) |
| **placedCount (cả 8 run)** | 46 | **46** (không đổi) |
| warm | 31 ms | 30 ms |

`search 3.199 → 214 ms`: không về 0 được vì adapter chặn `timeBudgetMs ≤ 0`, nên một trial
khởi động rồi ngắt sau ~một lời NFP (~200ms). Cắt được ~93% chi phí search. **placedCount y
hệt 46 cả 8 run** ⇒ kết quả bình không đổi, đúng thiết kế (baseline vốn là phương án công bố).

### Verify

- `py_compile` OK.
- pytest `test_nup_true_shape_nesting_entry.py` + `test_nesting_production_pipeline.py`:
  **66 passed**.
- Benchmark autofill: 46/46 placed mọi run, search collapse, cold −38%.

### Phát hiện KÈM THEO (KHÔNG do NF-BUDGET) — cần chủ dự án quyết

`test_mixed_nesting_lifecycle.py::test_deadline_tra_best_so_far_da_validate[1500|3000]` **đỏ**
trên binary hiện hành: `terminationReason='work_budget_exhausted'` trong khi test kỳ vọng
`{deadline, all_placed}`.

- **Không phải do NF-BUDGET**: test này đi đường standalone `/api/mixed-nesting/jobs`,
  `quantity_fulfillment` + `tight` + `time_budget_ms` tường minh — KHÔNG gọi
  `build_true_shape_nesting_job` (code tôi sửa). `_time_budget_ms` cho quantity vẫn trả DEFAULT.
- **Nguyên nhân**: binary hiện hành đã bật portfolio song song (NF-3), engine nhanh hơn nên
  workload "đủ nặng để không xong trước deadline" mà tác giả test thiết kế nay **xong work-plan
  TRƯỚC deadline** ⇒ `work_budget_exhausted`. `valid=True` vẫn đúng — không phải lỗi correctness,
  mà là **giả định thời gian của test đã cũ sau khi engine nhanh lên**. Bản chất test này
  timing-fragile (phụ thuộc tốc độ máy/tải).
- **Đề xuất** (lô riêng, chờ duyệt): hoặc (a) nhận `work_budget_exhausted` vào tập terminal
  hợp lệ (điểm cốt lõi "best-so-far đã validate" vẫn giữ), hoặc (b) tăng workload để chắc chắn
  không xong trước deadline (nhưng vẫn fragile theo máy). Tôi nghiêng (a).
