# Deadline vào trong `feasible_region` — và phát hiện solver chạy 0 trial

Ngày: 2026-08-28. Nhánh `codex/pre-release-audit-2026-08-04`. Máy Windows thật.
Mọi số đo trên **chính file khách**: `test/test nesting.pdf` (13 trang, contour 110–733 đỉnh).

Lô này bắt đầu từ P1 `NFP-DEADLINE-1`, làm xong, rồi trong lúc đo hiệu quả thì lộ ra một
vấn đề lớn hơn hẳn mọi finding trước đó.

## 1. Phát hiện: tờ bình người dùng nhận KHÔNG phải nesting

Manifest nói thẳng, 13 mẫu × 5 con, ngân sách 3000ms:

```json
"selectedCandidate": {"kind": "baseline"},
"trialsRun": 0,
"trialsRejected": 0,
"stats": {"elapsedMs": 14404, "terminationReason": "deadline", "poseRefinements": 0}
```

**Solver chạy 0 trial.** Layout được chọn là **baseline** — thuật toán greedy bottom-left,
không phải nesting tối ưu. Đây chính là "layout thì tùm lum" mà người dùng thấy.

### Không phải do ngân sách nhỏ

Quét ngân sách, 5 con mỗi mẫu:

| mẫu | ngân sách | thời gian | trialsRun | chọn |
|---|---|---|---|---|
| 4 | 3.000ms | 6,1s | **0** | baseline |
| 4 | 10.000ms | 12,9s | **0** | baseline |
| 4 | 30.000ms | 32,7s | **0** | baseline |
| 4 | 60.000ms | 63,7s | **0** | baseline |
| 4 | **300.000ms** | **320,2s** | **0** | baseline |
| 1 | 300.000ms | 22,4s | 4 | baseline |

Một trial với **4 mẫu thật cần hơn 300 giây**. Với 1 mẫu thì 4 trial xong trong 22,4s —
nhưng baseline vẫn thắng điểm.

### Vì sao

Ba thứ cộng lại:

1. **Baseline cố ý bỏ qua deadline và work budget** — nó phải luôn cho ra phương án nền để
   so (test `baseline_bo_qua_deadline_va_work_budget_nhung_van_ton_trong_cancel` chốt điều
   đó). Với 13 mẫu contour thật, baseline một mình tốn ~14,4s.
2. **Trial `quantity_fulfillment` bị ngắt thì LUÔN bị loại** — `multi_start.rs:272`:
   `trials_run += 1` chỉ khi `trial.interrupted` là `None`; và comment ghi rõ "Quantity
   trial bị ngắt vẫn là layout dở và luôn bị loại". Nên mọi tiến bộ dở dang bị bỏ hết.
3. **Tốc độ tìm kiếm thực tế thấp hơn giả định của chính nó bốn bậc.** Đo được
   `attempts = 261` trong 300 giây ⇒ **~1,2 lần thử/giây**. Ngân sách profile `fast` giả
   định `evaluationBudget = 30.000`; doc comment trong `control.rs` ghi "~9.700 pose eval/s".
   Ở 1,2/s thì 30.000 lượt cần **7 giờ**.

Nguyên nhân của (3) là contour thật: mỗi lần thử pose phải kiểm va chạm với mọi chi tiết đã
đặt, trên hình 49–171 đỉnh (sau khi đã đơn giản hoá footprint 0,2mm). Đo trong Rust cho
thấy chi phí NFP theo số mảnh lồi: 24 đỉnh → 0,44ms, còn 127 đỉnh → **510ms**.

## 2. Đã làm: deadline vào trong `feasible_region`

`RunControl::checkpoint()` trước đây chỉ được gọi **giữa các góc**. `feasible_region` dựng
NFP cho từng chi tiết đã đặt rồi `union_many` tất cả, nên một lượt gọi có thể chạy hàng chục
giây không có điểm dừng — ngân sách và nút Hủy đều vô nghĩa.

Bản vá đưa điểm dừng vào **vòng lặp obstacle** và trước `union_many`.

Chi tiết thiết kế đáng ghi: `feasible_region_cached` nhận **closure luật dừng**, không nhận
`RunControl`. Vì solver và baseline có luật **khác nhau** — bản đầu tôi truyền thẳng
`RunControl` và test `baseline_bo_qua_deadline_va_work_budget_nhung_van_ton_trong_cancel`
**đỏ đúng**: tôi vừa phá bất biến "baseline bỏ qua deadline". Closure để mỗi caller tự khai
luật, `nfp` không cần biết ai là ai.

Ngắt trả `None` chứ không trả miền rỗng, để caller báo **đúng lý do** — §11.4 cấm báo hết
ngân sách thành "hình học không vừa".

Hiệu quả đo được:

| | trước | sau |
|---|---|---|
| 13 mẫu × 50 con (650 con, 7 tờ) | 156,7s | **108,2s** |
| 13 mẫu × 5 con | 17,85s | 17,65s |

Ca 650 con giảm 31%. Ca 13 mẫu × 5 con gần như không đổi — và §1 giải thích vì sao: thời
gian ở đó nằm trong **baseline**, mà baseline cố ý không chịu deadline.

## 3. Phạm vi

| File | Thay đổi |
|---|---|
| `imposition_core/src/mixed_nesting/nfp.rs` | `feasible_region_cached` nhận closure luật dừng, trả `Option` |
| `imposition_core/src/mixed_nesting/solver.rs` | truyền `checkpoint()`, báo đúng lý do khi ngắt |
| `imposition_core/src/mixed_nesting/baseline.rs` | truyền `checkpoint_cancel_only()` — giữ bất biến bỏ qua deadline |
| `imposition_core/src/mixed_nesting/mod.rs` | export `feasible_region_cached`, `NfpCache` |
| `imposition_core/tests/mixed_nesting_deadline_in_region.rs` | mới, 5 test |

## 4. Verify

| Bộ | Kết quả |
|---|---|
| `cargo test imposition_core` | **304 passed, 0 failed** (299 + 5 mới) |
| `mixed_nesting_deadline_in_region` riêng | 5 passed |

Đã `maturin develop --release`. Lần đầu build **thất bại** vì sidecar dev đang giữ `.pyd`
("pip could not overwrite the installed extension module because it is in use") — và lượt đo
ngay sau đó là số của bản **cũ**, tôi đã phát hiện vì 13 mẫu không cải thiện. Đã dừng sidecar
(PID 37924) để cài, nên **cần chạy lại `run_dev.bat`**.

## 5. Ý nghĩa: tính năng chưa làm đúng việc nó hứa

Phải nói thẳng. "Nesting tối ưu theo đường bế" hiện **không tối ưu**: với job từ 4 mẫu trở
lên, solver không hoàn thành nổi một trial nên kết quả luôn là greedy baseline. Người dùng
chờ vài phút để nhận thứ mà thuật toán greedy cho ra trong vài giây.

Ba P1 còn lại trong danh sách vì vậy **đổi thứ tự ưu tiên**:

- `NFP-PARALLEL-1` (chạy song song): 4–8× là thật, nhưng cần ~1000× nên một mình nó không
  đủ. Vẫn nên làm vì rẻ và không đổi layout.
- `NFP-PRUNE-1` (spatial index): giúp nhiều cho ca nhiều con, vẫn không đủ một mình.
- `NEST-PREVIEW-1`: preview hiện là lưới. Nếu export thực chất là baseline greedy thì preview
  lưới còn **gần đúng hơn** so với gọi nó là nesting.

Cái thiếu là một bậc độ lớn, và nó nằm ở **giá của một lần kiểm va chạm**. Số đo chỉ đúng
một chỗ: 24 đỉnh → 0,44ms so với 127 đỉnh → 510ms. Engine nesting sản xuất giải bằng cách
đổi biểu diễn — decimate mạnh về ~16–24 đỉnh, hoặc dùng mặt nạ raster/bitmap cho collision.

## 6. Cần chủ dự án quyết

Hai hướng, và chúng loại trừ nhau ở ngắn hạn:

**(A) Decimate footprint mạnh hơn nhiều.** Ép footprint đóng gói về ~20–30 đỉnh thay vì
49–171. Đổi lại footprint phình 0,5–2mm nên mật độ giảm vài phần trăm. Rẻ, làm trong ngày,
và theo số đo Rust thì đây là chỗ duy nhất có sẵn ba bậc.

**(B) Đổi biểu diễn collision sang raster mask.** Đúng cách mà phần mềm chuyên dụng làm, cho
tốc độ ổn định không phụ thuộc số đỉnh. Nhưng là thay lõi kernel — nhiều tuần, và đổi mọi
layout.

Trong lúc chờ quyết, đề nghị **tạm khoá cờ nesting ở release** để không ai bấm vào rồi nhận
greedy baseline dưới cái tên "tối ưu". Cờ hiện đã nung `"false"` trong `build_production.ps1`
nên bản phát hành đang an toàn; chỉ dev là mở.

## 7. Còn hở

| Mã | Nội dung | Mức |
|---|---|---|
| **NEST-TRIALS-0** | Solver chạy 0 trial với ≥4 mẫu thật ⇒ kết quả là baseline greedy, không phải nesting. Cần (A) hoặc (B) ở §6 | **P0** |
| NEST-BASELINE-UNBOUNDED | Baseline bỏ qua deadline theo chủ đích, nhưng với contour thật nó ăn 14,4s trước khi solver bắt đầu. Cần cấp cho baseline một phần ngân sách riêng thay vì để nó ăn hết | P1 |
| NFP-PARALLEL-1 | Engine chạy một lõi; `multi_start` nói song song là việc của lớp gọi mà lớp gọi không làm | P1 |
| NFP-PRUNE-1 | `union_many` trên mọi chi tiết đã đặt + bbox pruning yếu. Đổi layout nên cần duyệt | P1 |
| NEST-PREVIEW-1 | Preview vẫn là lưới; chưa phản ánh kết quả thật | P1 |
