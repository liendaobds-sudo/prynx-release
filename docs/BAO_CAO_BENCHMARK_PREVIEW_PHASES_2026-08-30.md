# Benchmark preview nesting theo pha — vì sao preview vẫn chậm sau NF-3

Ngày: **2026-08-30**. Đơn vị: `W2-U09 / W7-U11`.
Trạng thái: **BÁO CÁO ĐO — chờ duyệt lô tối ưu. Chưa sửa production.**

Bối cảnh: sau khi rebuild binary (portfolio song song đã bật, `portfolioParallelEnabled=true`),
người dùng báo preview **vẫn chậm**. Báo cáo này đo trực tiếp để chỉ ra pha nào đốt thời gian —
không đoán.

Công cụ: `backend/.audit-tmp/bench_preview_phases.py` (read-only, chạy đúng seam
`build_nesting_preview`). Dữ liệu thô: `backend/.audit-tmp/bench_preview_phases/bench-autofill.json`.

## 0. Điều kiện đo (đọc trước khi tin số)

| | |
|---|---|
| File | `test/test nesting.pdf` (13 mẫu CUSTOM, die-cut autofill) |
| Tờ / lề / gap | 320×430mm / 5mm / 2mm |
| Máy | 16 logical CPU |
| Native buildIdentity | `b2cd6b46f80427650cbbc7dc6ba206f889f83af37499998e761ddd5580732d79` (bản vừa rebuild) |
| N | 5 cold + 1 warm |
| **Nhiễu** | **run_dev.bat đang chạy** (4 python sidecar nền). Đây là **PROBE**, KHÔNG phải P50/P95 sạch. |

Cột "share %" và kết luận "pha nào chi phối" vẫn đúng dưới tải vì nhiễu tác động gần như đồng đều;
riêng **con số tuyệt đối** và cpuToWall cần rerun máy rảnh để chốt.

## 1. Số đo

Cold wall: **median 17.849 ms**, min 10.966, max 18.834. Warm (cache hit): **109 ms**.
`cpuToWall = 1.523` trên máy 16 lõi.

Tách pha của run đại diện (17.849 ms):

| Pha | ms | % wall | Song song? |
|---|---:|---:|---|
| **Python overhead** (pin + resolve geometry 13 trang + render bundle + đổi 46 cell) | **4.559** | **26%** | Không — single-thread |
| native total | 12.916 | 72% | một phần |
| ├ **baseline** (greedy true-shape, xếp 46 con) | **8.257** | **46%** | NFP prewarm 13 worker |
| ├ baselineValidation | 462 | 3% | — |
| ├ rotationProbe (Direct-15) | 0 | 0% | — |
| ├ **search** (4 trial portfolio) | **3.386** | **19%** | 4 trial song song |
| └ publication | 809 | 5% | — |

NFP trong baseline: `nfpBuild = 33.670 ms **CPU**` nén còn `prewarmWall = 6.694 ms` nhờ
**13 worker** (≈5×); difference 509 ms; cacheMiss 169 / hit 1.728; feasibleRegionCalls 65.

Portfolio (search): planned 4, concurrency 4, waves 1, **completedTrials 0, interruptedTrials 4**.

## 2. Ba kết luận thẳng

### 2.1 Portfolio song song (NF-1/2/3) KHÔNG dời kim cho preview autofill

4 trial **đã chạy song song thật** (concurrency=4, interrupted=4) nhưng ngân sách 3 giây
không đủ để **một** trial nào hoàn tất → `completedTrials=0` → phương án công bố **vẫn là
baseline** (46 con). Việc vừa làm là **đúng và cần** (tất định, log trung thực), nhưng với đúng
ca người dùng đang chạy, nó **không** làm preview nhanh hơn. Nói thẳng để không nhầm.

### 2.2 Bottleneck #1 = baseline (46% wall)

baseline **bỏ qua deadline** và xếp greedy 46 con bằng NFP true-shape. Nó ngốn **33,7 giây CPU**
dựng NFP — đã được nén xuống 6,7 giây wall nhờ 13 worker prewarm, nhưng vẫn là pha lớn nhất.
Đây là chỗ phải đánh nếu muốn preview nhanh. Ba hướng (loại trừ nhau ở ngắn hạn):

- **(a) Giảm giá NFP**: decimate footprint mạnh hơn cho *preview* (không đổi CUT thật), hoặc
  cải thiện tỉ lệ cache hit / giảm cacheMiss (169 miss × NFP đắt). Rẻ, không đổi kiến trúc.
- **(b) Preview dùng baseline "nhẹ" hơn export**: preview chỉ cần **con số + bố cục gần đúng**;
  có thể chạy baseline ở độ phân giải hình học thấp hơn rồi export mới full. Đổi hợp đồng
  preview ≡ export → cần cân nhắc kỹ.
- **(c) Tăng mức song song của baseline**: hiện 33,7s CPU / 6,7s wall = 5×; máy 16 lõi còn dư.
  Nhưng prewarm đã 13 worker — trần nằm ở phần tuần tự giữa các đợt prewarm, không phải số worker.

### 2.3 Bottleneck #2 = Python overhead 4,6s (26%), single-thread, CACHE ĐƯỢC

Đây là phát hiện đáng giá nhất vì rẻ và an toàn. 4,6 giây này là pin nguồn + **resolve geometry
13 trang** (đọc PDF, trích contour die) + build render bundle + đổi cell — chạy **một luồng
Python**, **mỗi lần** người dùng tinh chỉnh tham số preview. Nhưng **nguồn PDF không đổi** giữa
các lần tinh chỉnh gap/lề/số lượng. Vì vậy phần resolve geometry (nặng nhất trong 4,6s) **cache
được theo (source fingerprint, page set)** — tinh chỉnh lần sau bỏ hẳn khoản này.

### 2.4 search 3,4s là lãng phí cho autofill

Với autofill die-cut, search cho `completedTrials=0` và không đóng góp vào kết quả (baseline
thắng). 3,4s (19%) này gần như thuần phí cho ca đang xét. Ứng viên: **cắt/giảm ngân sách search
khi intent là autofill** — cần xác nhận trên vài ca khác để chắc không có ca autofill nào mà
trial kịp hoàn tất và cải thiện.

## 3. Ưu tiên đề xuất (mỗi lô ≤5 file, chờ duyệt)

Xếp theo **lợi ích / rủi ro**:

1. **PV-CACHE — cache resolve geometry theo source fingerprint** (đánh §2.3). Kỳ vọng: bỏ phần
   lớn 4,6s Python ở **mọi lần tinh chỉnh sau lần đầu**. Không đổi kết quả hình học. Rủi ro thấp.
   Khoá cache phải gồm fingerprint nguồn + tập trang; sai khoá là trả contour cũ (bẫy đã biết).
2. **NF-BUDGET — cắt search budget cho autofill** (đánh §2.4). Kỳ vọng: −3,4s cold cho autofill.
   Cần A/B chứng minh `placedCount`/`sheetCount` không đổi trên corpus autofill.
3. **NF-BASELINE — giảm giá NFP baseline** (đánh §2.2a). Kỳ vọng lớn nhất nhưng rủi ro cao nhất
   (đụng hình học). Bắt buộc golden + regression `placedCount`/`layoutFingerprint`. Làm sau cùng.

Không đề xuất đụng portfolio thêm cho preview: §2.1 cho thấy nó không phải nút thắt của ca này.

## 4. Việc cần trước khi cam kết lô sửa

- **Rerun máy rảnh** (tắt run_dev.bat, N≥20) để có P50/P95 sạch và cpuToWall thật. Số hiện tại đủ
  để chọn hướng, chưa đủ để làm mốc KPI.
- Đo thêm ca **quantity_fulfillment** (không chỉ autofill) và ca **CNC** — bức tranh pha có thể
  khác (quantity chạy trial thật, search có thể không phí).
- Với PV-CACHE: đo riêng thời gian resolve geometry để biết trần lợi ích thực của lô 1.

## 5. Giới hạn báo cáo

- N=5 dưới tải; variance lớn (run 1 baseline 2.903 ms vs median 8.257 ms) do tranh CPU. Kết luận
  **share/định tính** vững; **số tuyệt đối** chưa chốt.
- Chỉ đo autofill die-cut một cấu hình tờ. Chưa phủ quantity/CNC/nhiều khổ.
- Không sửa production trong lô đo này. Mọi con số ở §1 tái lập bằng
  `backend\venv\Scripts\python.exe backend\.audit-tmp\bench_preview_phases.py`.

---

## PHỤ LỤC — Rerun máy rảnh (đính chính số đo dưới tải) + PV-CACHE đã revert

Sau khi tắt dev loop (uvicorn `--reload` + workers), chạy lại `bench_preview_phases.py` N=8,
autofill, cùng file khách, cùng binary. **Số đo trên đổi hẳn kết luận — chúng đo dưới tải nên
đã méo.**

### Số sạch vs số dưới tải

| Chỉ số | Dưới tải (§1 ở trên) | **Máy rảnh (đúng)** |
|---|---:|---:|
| cold preview median | ~17.849 ms | **8.065 ms** |
| baseline | 8.257 ms | **2.694 ms** |
| search | 3.386 ms | 3.199 ms |
| pyOverhead | 4.559 ms | **1.403 ms** |
| cpuToWall | 1,52 | **2,88** |
| warm | 109 ms | 31 ms |

**Gần một nửa thời gian cold là do dev loop tranh CPU với solver, không phải engine.** Bản
production (Nuitka, không `--reload`) sẽ gần 8 s hơn 17 s.

### Phase split ĐÚNG (máy rảnh, cold ~8 s)

| Pha | ms | % |
|---|---:|---:|
| **search** (4 trial portfolio, `completedTrials=0`) | 3.199 | **40%** |
| **baseline** (NFP 8,4 s CPU → 2,0 s wall @13 worker) | 2.694 | **34%** |
| pyOverhead (pin + geometry + bundle + cell) | 1.403 | 17% |
| publication + validation | ~0.7k | 9% |

So với §1 (baseline 46%, py 26%): tải làm baseline và pyOverhead phình lên vì chúng CPU-bound,
bị đói lõi khi có contention. Số sạch cho thấy **search mới là pha lớn nhất**.

### PV-CACHE: A/B máy rảnh → không có lợi → ĐÃ REVERT

| | cache TẮT (fresh mỗi lượt) | cache BẬT |
|---|---:|---:|
| pyOverhead median | 1.403 ms | 1.650 ms |
| cold median | 8.065 ms | 8.925 ms |

Cache BẬT **không nhanh hơn** (còn nhỉnh cao hơn, trong biên nhiễu). Nguyên nhân: geometry-resolve
chỉ là phần nhỏ của 1,4 s pyOverhead; con số "4,6 s" ở §1 là ảo do contention làm PDFium (CPU-bound)
đói lõi. Vì clean benefit ≈ 0 và dự án kỵ cache không kiếm đủ ăn (cache key là nguồn bug), **PV-CACHE
đã được revert** (`nesting_production_pipeline.py` trả về `_resolve_geometry` gốc; test/tool đã xóa).
Parity của nó vẫn đúng (pose/cell trùng khít) — revert vì vô ích, không vì sai.

### Ưu tiên đã sửa

1. **NF-BUDGET là lever thật (search ~3,2 s = 40%).** NHƯNG không cắt phẳng: autofill file khách
   `completedTrials=0`, 46 con dù có/không trial → search phí; nhưng §3.3 báo cáo gốc đo hình lồng
   chữ L trial giúp **24→27 con**. Nên phải **adaptive theo intent + A/B đa hình** trước khi sửa.
2. baseline 2,7 s: NFP đã song song tốt (13 worker), khó giảm thêm nếu không đổi hình học.
3. Một phần "chậm" của người dùng là contention dev env — sẽ tự giảm ở bản production.

Số sạch: `backend/.audit-tmp/bench_preview_phases/bench-autofill.json` (chạy lại được bằng
`bench_preview_phases.py`).
