# Báo cáo audit preview ↔ kết quả Bình cắt xén S&R

> Ngày audit: 2026-08-12  
> Audit unit: `W2-U08` — Bình trang (S&R), Xếp tối ưu, preview số bài/tờ ↔ PDF xuất  
> Phạm vi: tờ `330 × 480 mm`, thành phẩm `149,1 × 53,3 mm`, bleed `2 mm`, hở bài `2 × 2 mm`  
> Trạng thái bằng chứng: `ARTIFACT` cho engine hiện tại; runtime thao tác trên app/installer với đúng file khách còn mở

## 1. Kết luận điều hành

Ba ảnh người dùng cung cấp xác nhận bất nhất quan sát được là thật:

- preview ghi `16 tem/tờ` và dựng lưới đều `2 × 8`;
- PDF kết quả có `8` bài ngang ở khối trái và `3 × 3` bài xoay ở khối phải, tổng `17` bài;
- cấu hình hiển thị là Bình trang (S&R), Xếp tối ưu, tờ `330 × 480 mm`, bleed `2 mm`, hở bài `2 × 2 mm`.

Tuy nhiên, mã nguồn và engine hiện tại **không tái hiện được việc preview và PDF tự lệch khi nhận cùng một cấu hình**. Tái hiện end-to-end bằng PDF thật cho kết quả:

| `splitGap` — khe giữa khối chính/phụ | Preview | PDF thật, đếm lệnh đặt trang `Do` |
|---:|---:|---:|
| `0 mm` | 17 | 17 |
| `2 mm` | 16 | 16 |
| `16 mm` | 16 | 16 |

Do đó, finding chính được phân loại như sau:

- `§SRPARITY.1 [CONFIRMED] P1/M`: ứng dụng chưa có **runtime contract/provenance fail-closed** để chứng minh preview và job xuất đã dùng cùng một fingerprint cấu hình/phiên bản. Khi UI, sidecar hoặc artifact không đồng bộ, người dùng chỉ thấy `16 ↔ 17` nhưng không có dữ liệu để phát hiện/chặn trước khi in.
- Giả thuyết “solver preview và renderer hiện tại dùng hai thuật toán khác nhau” là `[DISPROVED]` với ca đã tái hiện.
- Giả thuyết “tuple `main_secondary_gap` bị lệch vị trí trong worker hiện tại” là `[DISPROVED]`.
- Nguyên nhân chính xác của **artifact trong ảnh** vẫn ở mức `[SUSPECTED]`: output tương đương `splitGap=0`, còn preview tương đương `splitGap≥2`; chưa có chính file PDF kết quả/payload runtime của lần chạy đó để quy trách nhiệm cho frontend cũ, sidecar cũ hay cấu hình thay đổi giữa hai thời điểm.

## 2. Bất biến nghiệp vụ

Với một lần bấm Bình, preview và PDF phải dùng cùng:

1. working PDF và PageBox đã chuẩn hóa;
2. khổ tờ, lề, bleed, hở bài và `splitGap`;
3. task/layout/strategy;
4. phiên bản planner/solver;
5. danh sách placement cuối cùng hoặc ít nhất cùng một fingerprint layout.

Nếu một trong các giá trị này thay đổi sau preview hoặc sidecar không cùng build, ứng dụng phải tính lại preview hoặc từ chối xuất; không được im lặng tạo artifact có sức chứa khác.

## 3. Bằng chứng hình học từ ảnh

PDF kết quả trong ảnh gồm:

- khối trái: `1 × 8` bài không xoay;
- khối phải: `3 × 3` bài xoay;
- tổng: `8 + 9 = 17`.

Kích thước footprint thành phẩm:

- cao khối trái: `8 × 53,3 + 7 × 2 = 440,4 mm`;
- cao khối phải: `3 × 149,1 + 2 × 2 = 451,3 mm`;
- rộng hai khối khi không có khe phụ: `149,1 + 3 × 53,3 + 2 × 2 = 313,0 mm`;
- nếu có thêm khe khối phụ `2 mm`, bề rộng thành `315,0 mm`.

Vì vậy ở vùng dùng được xấp xỉ `313–314 mm`, chỉ riêng việc đổi `splitGap` từ `0` sang `2 mm` đã đủ làm layout `17` rơi về `16`. Đây chính là ngưỡng đã được solver production tái hiện.

## 4. Trace dọc luồng đang chạy

### 4.1 Entry và preview

- UI tính `splitGap` tại `desktop/src/components/imposition-tools/pageSheetPolicy.ts:57–79`.
- `ImposerDashboard` dùng cùng helper cho batch capacity, preview và nút Bình tại:
  - `desktop/src/components/imposition-tools/ImposerDashboard.tsx:1004–1072`;
  - `desktop/src/components/imposition-tools/ImposerDashboard.tsx:1250–1297`;
  - `desktop/src/components/imposition-tools/ImposerDashboard.tsx:1675–1717`.
- `GridPreview` đổi mm → point và gửi `split_gap` tại `desktop/src/components/imposition-tools/sections/GridPreview.tsx:1401–1465`.
- route preview gọi `solve_optimal_layout(..., secondary_gap=req.split_gap)` tại `backend/app/api/routes/imposition.py:2997–3021`.

### 4.2 Job xuất PDF

- `ImpositionTab` giữ `config.splitGap` tại `desktop/src/components/ImpositionTab.tsx:1883–1976`.
- `processHandlers` giữ tiếp `settings.splitGap` trong payload backend tại `desktop/src/lib/processHandlers.ts:134–158`.
- API `/nup-start` chỉ sao chép settings và truyền sang process tại `backend/app/api/routes/imposition.py:728–803`.
- engine đổi mm → point và gọi cùng solver tại `backend/app/workers/nup_engine.py:2230–2243`, `2748–2751`.
- engine luồn `secondary_gap` vào tuple worker tại `backend/app/workers/nup_engine.py:3538–3576`.
- worker giải tuple đúng vị trí `main_secondary_gap` tại `backend/app/workers/nup_process_chunk.py:146–175`, rồi dùng lại khi re-solve S&R tại `backend/app/workers/nup_process_chunk.py:346–488`.
- writer đặt artwork thật và PDF được parse lại để đếm lệnh `Do`; đây là nguồn sự thật artifact, không suy từ response preview.

### 4.3 Consumer live của tham số

`secondary_gap` được đọc trực tiếp trong solver production tại `backend/app/workers/nup_layout_solver.py:130–175`. Nó quyết định tọa độ bắt đầu của khối phụ bên phải/ở dưới, nên đây là consumer live, không phải field chết.

## 5. Kết quả tái hiện và kiểm thử

### 5.1 Tái hiện artifact tạm thời

Đã tạo PDF một trang có:

- MediaBox `153,1 × 57,3 mm`;
- TrimBox `149,1 × 53,3 mm`;
- bleed UI `2 mm`;
- tờ `330 × 480 mm`, hở `2 × 2 mm`, lề trái/phải `8 mm` để tạo vùng dùng được `314 mm`;
- mode `repeat`, strategy `optimal_auto`.

Chạy trực tiếp route preview và `run_nup_engine`, sau đó mở PDF kết quả bằng `pikepdf` và đếm lệnh `Do`:

```text
AUDIT 0.0  17 17 [17]
AUDIT 2.0  16 16 [16]
AUDIT 16.0 16 16 [16]
```

Harness tạm đã được xóa sau audit; không để lại file test ngoài chốt duyệt.

### 5.2 Test hiện có đã chạy

- Backend: `19 passed` cho test giữ `splitGap=0` + parity Rust/Python.
- Frontend: `4 passed` cho `pageSheetPolicy.test.ts`.
- Solver Rust và Python cho cùng sức chứa ở ma trận kiểm tra; không có divergence native/fallback.

### 5.3 Bằng chứng lịch sử và release

- `logs/preview_perf.log` có nhiều lần `guillotine-repeat.pdf` trả `16 items`, nhưng log cuối là 2026-08-05.
- commit `89a9048` ngày 2026-08-08 đã sửa việc giữ `splitGap=0` và có regression test.
- manifest rc.5 được build từ commit `f24b7ec6`, và commit này chứa `89a9048`.

Điều này không chứng minh ảnh user đến từ bản cũ, nhưng chứng minh log cũ không đủ đại diện cho source/release hiện tại.

## 6. Finding chính

### §SRPARITY.1 `[CONFIRMED]` — P1 / effort M

**Mô tả:** preview và job xuất không trao đổi/chốt một layout fingerprint có thể kiểm chứng. Backend cũng không từ chối job nếu fingerprint cấu hình mà frontend vừa preview khác fingerprint job xuất.

**Thiệt hại:** số bài/tờ sai ảnh hưởng trực tiếp báo giá, số tờ cần in và thao tác sản xuất. Người dùng có thể tin preview 16 trong khi artifact có 17 hoặc ngược lại.

**Reachability:** entry UI → `GridPreview`/`onStartNup` → `/preview-layout`/`/nup-start` → solver → PDF, đã trace ở §4.

**Consumer live:** solver đọc `secondary_gap` tại `nup_layout_solver.py:132,155,169`.

**Bằng chứng:** cùng ca hình học đổi duy nhất `splitGap` đã làm sức chứa `17 ↔ 16`; cùng payload thì preview/PDF khớp, nên thiếu sót nằm ở khả năng đảm bảo và quan sát contract xuyên hai request/runtime, không nằm ở phép solve hiện tại.

**Đề xuất:** tạo một contract layout canonical, hash các trường ảnh hưởng hình học và trả hash/capacity từ preview. Job xuất phải nhận `expectedLayoutFingerprint` + `expectedCapacity`; backend recompute và fail-closed nếu lệch. Job status/PDF report lưu fingerprint để truy vết.

## 7. Các giả thuyết đã loại trừ

| Giả thuyết | Trạng thái | Bằng chứng |
|---|---|---|
| Preview dùng Python, output dùng Rust nên lệch 16/17 | `[DISPROVED]` | parity Rust/Python 18 ca liên quan đạt; cùng đầu vào cho cùng số lượng |
| Worker giải sai vị trí `main_secondary_gap` | `[DISPROVED]` | tuple engine và destructuring worker khớp; artifact end-to-end giữ đúng `0/2/16` |
| Route `/nup-start` làm rơi `splitGap` | `[DISPROVED]` | route sao chép settings; test artifact nhận đúng sức chứa tương ứng |
| Source hiện tại luôn tạo PDF 17 dù preview 16 | `[DISPROVED]` | cùng payload: `17↔17`, `16↔16` |

## 8. Khoảng trống còn mở

1. Chưa có chính PDF artifact trong ảnh hoặc source PDF khách để đọc Media/Crop/TrimBox và metadata.
2. Chưa có payload của request preview/job tại thời điểm ảnh được chụp.
3. Chưa thao tác lại đúng ca trên app/installer đang chạy; tại thời điểm audit không có sidecar lắng nghe cổng `8321`.
4. Chưa xác định ảnh được tạo trước hay sau commit `89a9048`.

Vì thiếu bốn dữ liệu này, không được gắn `[CONFIRMED]` cho kết luận “frontend cũ” hay “sidecar cũ”.

## 9. Lô sửa đề xuất — chờ duyệt

### Lô 1 — Contract/fail-closed, tối đa 5 file

1. `desktop/src/components/imposition-tools/sections/GridPreview.tsx` — lưu fingerprint/capacity trả từ preview.
2. `desktop/src/components/imposition-tools/ImposerDashboard.tsx` — gửi fingerprint/capacity kỳ vọng khi bấm Bình.
3. `desktop/src/lib/processHandlers.ts` — serialize contract, không dùng `any` cho field này.
4. `backend/app/api/routes/imposition.py` — chuẩn hóa/hash contract và từ chối job khi lệch.
5. `backend/tests/test_guillotine_audit_regressions.py` — regression đúng ca `149,1 × 53,3`, kiểm `16/17` + fail-closed.

### Lô 2 — Quan sát runtime (nếu Lô 1 chưa đủ dữ liệu vận hành)

- bổ sung test frontend cho payload nút Bình;
- hiển thị thông báo tiếng Việt khi preview đã cũ;
- ghi fingerprint/capacity vào job status/report để chẩn đoán, không ghi nội dung nhạy cảm.

Mỗi lô phải verify preview response, PDF artifact thật và thao tác app. Không sửa solver để “ép 16” hay “ép 17”; sức chứa nào đúng phải do cùng một cấu hình đã chốt quyết định.

## 10. Chốt duyệt

Audit dừng tại đây theo quy trình 2 chốt. Chưa sửa source production trong lượt này. Chỉ tiếp tục Lô 1 sau khi người dùng duyệt; nếu người dùng cung cấp PDF nguồn + PDF kết quả trong ảnh, ưu tiên phân tích hai artifact đó trước khi thay đổi contract.
