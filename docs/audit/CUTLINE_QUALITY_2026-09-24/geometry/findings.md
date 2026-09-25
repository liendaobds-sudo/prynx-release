# Bằng chứng hình học — 24/09/2026

Chỉ audit + harness, không sửa production. Các A/B nạp hàm khác trong bộ nhớ
process probe rồi khôi phục bằng `unittest.mock.patch`. Không có PDF nguồn
hay artwork bị ghi lại. Các số là probe tự động trên đường cubic thật trong
bộ nhớ; chưa phải Tauri, driver hoặc máy bế. Đọc lại audit/fixes giảm node
09/09, fairing 10/09 và runtime/core 11/09 trước khi kết luận.

## GEOM.1 — P1/M: ngắt fairing theo số đoạn, mất chất lượng trên cùng quỹ đạo

**CONFIRMED / AUTO, mới so với hợp đồng fairing đã ghi 10/09.**

- `backend/app/workers/cutline_fair_simplify.py:240–247` trả nguồn ngay khi
  `len(values) > 100`, không xét RAM hay mức dung sai. Comment nói chi phí
  solver O(N³), nhưng đây không phải chứng minh rằng mọi ring 101 đoạn đều
  nặng hoặc không thể có nghiệm an toàn.
- Caller thật: `cutline_cubic_simplify.py:503` gọi fair_refit_ring;
  dispatcher `:611–619` thử fair trước khi preview_fast và dung sai ≥0,075.
  Preview `sticker_cutline_preview.py:1394`, writer
  `sticker_engine.py:11418` bật preview_fast; sheet export `:1171/:1734`
  truyền simplify_fast. Không chỉ là helper không dùng.
- `hard_gate.json`: live flower3 (r=8+cos(3θ) mm, 400 điểm nguồn, 300 DPI,
  smoothness/fidelity 50, round0) cho 16 cubic. Simplify 0,10 mm giảm 16→7,
  cận sau writer 0,06840625 mm, Δκ max 2,051769→0,545257/mm. Chia de
  Casteljau đúng cùng quỹ đạo thành 128 cubic khiến public dispatcher trả
  nguyên128, 38 đoạn <0,25 mm. Đây là tính phụ thuộc biểu diễn, không phải
  hình khác hay tolerance khác.
- `hard_gate_ab.json`: bỏ **duy nhất** điều kiện `len(values)>100` trong hàm
  nạp bằng AST, giữ solver/verifier/topology/writer guards, cùng đầu vào128
  giảm xuống7; cận0,06840625mm, sample độc lập0,06600226mm, Δκmax0,545748/mm.
- Đối chứng tránh hiểu nhầm nguồn bị loại vì đoạn ngắn:
  `hard_gate_safe.json` phóng cùng hình3× trước chia, đoạn ngắn nhất0,456075mm
  và không có đoạn<0,25mm. Hiện128→128; bỏ guard duy nhất→15, cận
  0,098875mm, sample0,096509mm, không thêm join gãy/hở. Max Δκ
  0,683923→0,574556/mm. P95 Δκ tăng vì số join thay đổi; không gọi mọi
  metric cải thiện.

Các timing trong JSON chỉ N=1 fixture nhỏ trên máy dùng chung; không dùng
để hứa speedup. Đề nghị phân biệt chi phí theo hình học/seed thực, giữ
verifier và khả năng hủy; không dùng số đoạn nguồn như công tắc tắt chất
lượng vô điều kiện. Có thể rút các phép chia dư trước fairing rồi kiểm lại
với cubic nguồn bất biến, nhưng cần lô riêng và regression.

## GEOM.2 — P2/M: span cap làm mất nghiệm ít node dù cùng guard nhận được

**CONFIRMED / AUTO; secondary của GEOM.1.**

- `cutline_global_simplify.py:143,160` cắt DAG bằng max_span;
  `:237–238` dùng12 khi candidate_attempts≤3, còn lại24.
  `cutline_cubic_simplify.py:598–601` đặt3 cho preview_fast.
- Cùng public dispatcher, tolerance0,05mm, preview_fast=True, vòng
  polygon đều bán kính30mm mã hóa bằng line-cubic:

| Nguồn | Cap12 hiện tại | Xét toàn span, cùng guard | Cận toàn span |
|---|---:|---:|---:|
| 128 đoạn | 11 | 4 | 0,04917706mm |
| 256 đoạn | 22 | 4 | 0,04839105mm |

Mỗi A/B giữ nguyên input; không coi polygon128 và polygon256 cùng hình
chính xác. Các nhánh pairwise/fallback vẫn chạy thật trong public dispatcher.
Nghiệm4 lệch nguồn hơn và Δκmax lớn hơn nghiệm hiện tại, dù vẫn G1 và qua
cùng guard. Bằng chứng chỉ ra trade-off ít node bị khóa bởi số đoạn thay vì
tolerance; không khẳng định nghiệm4 tốt hơn mọi tiêu chí.

`span_limit.json` và chế độ `span_limit` trong harness tái lập. Không đề nghị
bật brute force O(N²) vô điều kiện: lượt256 hiện~1,32s, toàn span~12,71s
trên probe có cả metric/sample. Cần pruning theo cận hình học hoặc chế độ
chất lượng có giải thích. Comment `:148–150` nói cubic chỉ thay được12–24
đoạn không phải bất biến toán học (chia một cubic tạo được bao nhiêu đoạn
nguồn tùy ý).

## GEOM.3 — P2/M: node còn phụ thuộc vị trí seam dù có nghiệm giữ nguyên seam

**CONFIRMED / AUTO; cải thiện optimizer, không phải bằng chứng đường bị hở.**

- Pairwise `cutline_cubic_simplify.py:318–320` gộp cặp theo thứ tự bắt đầu
  tại0; không xét offset ghép khác. Global `cutline_global_simplify.py:200`
  khóa index0 cùng góc và `:238` chọn đường trong một DAG.
- Cùng vòng tròn4 cubic bán kính10mm được chia32 cubic: seam gốc cho4;
  cyclic-shift1/3/5 cho8. Hình đầu vào không thay đổi, mọi output vẫn kín/G1
  và giữ Δκ gần0. Probe public dispatcher tolerance0,05mm.
- Không yêu cầu xóa/chuyển seam của người dùng. Đối chứng cho shift1 có
  **5 cubic giữ chính xác cùng start**, tạo bằng de Casteljau nguyên4 cubic
  gốc tại1/8, không xấp xỉ hình. `verify_fair_ring` nhận candidate này,
  sample thích ứng~2,0e-7mm, cận bảo thủ0,001390625mm, Δκmax~7,9e-15/mm.
- Output8 hiện sai lệch mẫu~0,009213mm; cận0,044515mm. Có nghiệm5 chính
  xác hơn dưới cùng tolerance cho thấy không chỉ là chi phí một node seam.

`seam.json`. Đề nghị xét phase ghép / exact subdivision coalescing, vẫn
giữ start hoặc thay seam chỉ khi hợp đồng cho phép. Không gọi đây là chứng
minh tìm được tối thiểu trên mọi spline.

## GEOM.4 — P2/M: §NODE.2 cũ vẫn mở — G1 đầu tiên thắng C2 phù hợp phía sau

**CONFIRMED / AUTO, tái xác minh backlog 09/09; không discovery mới.**

- `sticker_engine.py:5354–5355` lặp strength rồi builder c2/g1;
  `:5399` trả ứng viên đầu tiên đạt band. Caller live `:6110–6125`.
  Oracle `:5081–5087` không đưa jump độ cong vào machine_safe.
- Probe `flowers.json` chạy lại harness09/09 với source hiện tại:
  flower12 hiện104 cubic/Δκmax6,150379/mm; C2 sau101/~6,8e-14/mm.
  Khoảng lệch mẫu .152423 vs .245316mm, cùng budget .29718mm, cùng qua
  oracle, không short segment/cusp/gãy tiếp tuyến. Flower3 hiện16/
  2,051769 vs C2 sau15/~1,7e-15/mm; deviation .116603 vs .186314mm.
- C2 sau lệch nguồn hơn, min segment ngắn hơn nên cần xếp hạng có thứ tự
  geometry→độ mượt→node dưới dung sai đã chốt; không đơn giản xóa nhánhG1.
- Probe chặn Catmull bằng patch return[] để quan sát candidate tiếp theo,
  không phải bản vá. Chưa đo jerk/tốc độ dao vật lý.

## Tái chạy

Từ D:/pdfcompare:

```
backend\venv\Scripts\python.exe docs/audit/CUTLINE_QUALITY_2026-09-24/geometry/probe.py flowers
backend\venv\Scripts\python.exe docs/audit/CUTLINE_QUALITY_2026-09-24/geometry/probe.py hard_gate
backend\venv\Scripts\python.exe docs/audit/CUTLINE_QUALITY_2026-09-24/geometry/probe.py hard_gate_ab
backend\venv\Scripts\python.exe docs/audit/CUTLINE_QUALITY_2026-09-24/geometry/probe.py hard_gate_safe
backend\venv\Scripts\python.exe docs/audit/CUTLINE_QUALITY_2026-09-24/geometry/probe.py span_limit
backend\venv\Scripts\python.exe docs/audit/CUTLINE_QUALITY_2026-09-24/geometry/probe.py seam
```

Tất cả probe trên đã exit0, mỗi lượt dưới1phút. Không chạy suite pytest
riêng để tránh tranh CPU benchmark chính; root phụ trách suite/đối chứng.
Các phép đo mật độ mẫu độc lập trong harness là số đo, không được gọi là
cận toán học; cận trong stats/verifier dùng đúng guard sản phẩm hiện tại.
