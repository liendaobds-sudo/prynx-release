# Baseline nesting là O(N²) — vì sao preview 35–59s và không xoay

Ngày: **2026-08-30**. Đơn vị: `W2-U09 / W7-U11`.
Trạng thái: **BÁO CÁO ĐO + ĐỀ XUẤT SPEC — chưa sửa production.**

Xuất phát: log ứng dụng của người dùng (`nesting_trace.jsonl`) cho thấy file thật fit **357
tem**, preview **35–59 giây**, mọi lượt `selectedCandidate=baseline`, `trialsRun=0`, 0 con xoay.
Báo cáo này pinpoint gốc O(N²) bằng phép quét khổ tờ trên `test/test nesting.pdf`.

## 1. Số đo — baseline scaling (quét khổ, autofill, 13 design)

Công cụ: `backend/.audit-tmp/baseline_scaling.py` (đo dưới tải dev loop; **counts** không phụ
thuộc tải nên kết luận cấu trúc vững, số thời gian tuyệt đối có nhiễu).

| capacity | baselineMs | blockersConsidered | differenceMs | differenceCalls | feasRegionCalls | bboxRejects | cacheMisses |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 46 | 5.786 | 1.897 | 461 | 264 | 65 | **0** | 169 |
| 110 | 11.378 | 8.166 | 2.573 | 1.070 | 130 | 0 | 169 |
| 195 | 21.256 | 23.972 | 9.300 | 3.094 | 221 | 0 | 169 |
| 297 | 50.550 | 52.219 | 24.269 | 6.649 | 325 | 0 | 169 |
| 457 | 55.080 | 115.117 | 36.487 | 14.583 | 481 | 0 | 169 |

## 2. Phân tích — O(N²) nằm ở đâu

- **`blockersConsidered ~ N²`** (bằng chứng chính): `blockersConsidered/N` = 41 → 74 → 123 →
  176 → 252, tăng **tuyến tính theo N** ⇒ tổng ~ N². Mỗi lần đặt một con, `feasible_region`
  trừ NFP của **MỌI** con đã đặt.
- **`differenceMs ~ N²`**: `differenceMs/N²` ≈ hằng (~0,2). Phép Boolean difference xử lý O(N)
  blocker mỗi lần gọi × N lần gọi = O(N²). Ở 457 con, difference **36,5s**.
- **`feasibleRegionCalls ~ N`** (65→481 ≈ N+13): mỗi placement gọi region đúng một lần — tuyến
  tính, không phải vấn đề.
- **`nfpBuild` PHẲNG, `cacheMisses=169` HẰNG SỐ trên MỌI cỡ**: NFP construction đã được cache
  đúng — chỉ 13 design × góc = 169 lần dựng, **không tăng theo N**. Vậy dựng NFP **KHÔNG** phải
  nút thắt (số nfpBuildMs dao động 10–35s chỉ là nhiễu tải/contention của CPU dùng chung).
- **`bboxRejects = 0` trên MỌI cỡ** — chốt chẩn đoán: bộ lọc broad-phase bbox (`bounds_may_touch`
  trong `nfp.rs`) **không loại được con nào**. Lý do: autofill lấp cả tờ nên IFP (miền đặt hợp
  lệ của con đang xét) ≈ **cả tờ**; mọi con đã đặt đều nằm trong tờ nên NFP của nó luôn "chạm"
  hộp IFP cả-tờ → không con nào bị loại → **quét hết N blocker mỗi lần**.

**Kết luận:** baseline O(N²) vì `feasible_region` trừ NFP của **toàn bộ** tập đã đặt cho mỗi
placement, và broad-phase bbox vô dụng khi IFP là cả tờ. Đây chính là `NEST-AUD-10/19` (đã nêu
trong audit), nay có số định lượng.

## 3. Vì sao điều này giải thích CẢ hai than phiền của người dùng

- **Preview 35–59s** (file 357): baseline O(N²) đặt 357 con. NF-BUDGET (cắt ~3s search) chỉ là
  ~8% ở quy mô này — không chạm gốc. Gốc là O(N²) này.
- **Không xoay:** baseline `FirstAllowed`=0° đã không xoay; và search (thứ sẽ xoay) không bao
  giờ hoàn tất vì baseline ăn hết thời gian. Làm baseline nhanh (bỏ O(N²)) là điều kiện CẦN để
  search kịp chạy và xoay.

Hai vấn đề, một gốc: **baseline feasible_region O(N²)**.

## 4. Đề xuất spec — lô "spatial index cho baseline feasible_region" (B6)

Ý tưởng: chỉ số hoá không gian các con đã đặt; khi tính `feasible_region` cho placement mới,
**chỉ trừ NFP của những con ở GẦN** vùng ứng viên (biên bottom-left đang xét), không phải cả N.
Con ở xa có NFP không thể chạm miền đang xét ⇒ bỏ qua là **chính xác** (không đổi kết quả), chỉ
bỏ công thừa. O(N²) → ~O(N·k) với k = số hàng xóm cục bộ.

Kỳ vọng: ở 457 con, difference 36,5s → cỡ 1–2s; baseline 55s → cỡ vài giây. Vừa giải preview
chậm, vừa để search kịp chạy (mở đường xoay).

**Ràng buộc bắt buộc (đây là Rust core, rủi ro cao):**
1. **Chính xác, không đổi layout.** Chỉ bỏ blocker CHỨNG MINH được không thể chạm miền ứng
   viên. Golden test: `placedCount`/`sheetCount`/`layoutFingerprint`/pose records **y hệt** trên
   corpus (test nesting.pdf + các hình khác) trước/sau.
2. **KHÔNG phải incremental ngây thơ.** Audit đã thử prototype append-only miền chặn → **chậm hơn
   51–57%** (NEST-AUD-10) vì duy trì miền union lớn đắt hơn phần tiết kiệm. Phải là **spatial
   index + candidate cục bộ**, không phải "gom mọi đỉnh rồi hậu kiểm lười" (đã đo >60s, tệ hơn).
3. **Benchmark máy rảnh** trước/sau ở nhiều capacity (46/110/195/297/457) chứng minh scaling đổi
   từ ~N² sang ~N·k, và số con không đổi.
4. Quy trình 2 chốt: spec + golden trước → chờ duyệt → sửa theo lô ≤5 file → verify.

## 5. Giới hạn báo cáo

- Đo dưới tải dev loop; **counts** (blockersConsidered/differenceCalls/feasRegionCalls) là bằng
  chứng cấu trúc vững, còn ms tuyệt đối có nhiễu — cần rerun máy rảnh khi làm benchmark chốt.
- `cap=457` là quét tổng hợp trên test nesting.pdf khổ lớn, xấp xỉ quy mô 357 của người dùng.
- Chưa viết code sửa; đây là đề xuất chờ duyệt. Spatial index là lô rủi ro cao nhất trong
  roadmap (đổi lõi tìm kiếm), phải có golden.
