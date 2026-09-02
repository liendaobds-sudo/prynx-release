# Fix §NFP-CONVEX — `KERNEL_NOT_CONVEX` trên khuôn gần lồi

Ngày: 2026-08-28. Nhánh `codex/pre-release-audit-2026-08-04`. Máy Windows thật.

Lỗi người dùng báo khi bấm Bình với "Nesting tối ưu theo đường bế":

```
Không bình được trang: KERNEL_NOT_CONVEX | Phép Minkowski nhanh chỉ nhận đa giác lồi.
```

## 1. Nguyên nhân gốc

**Hai vị từ lồi dùng liền nhau trong cùng một chuỗi gọi, lệch dung sai 1000×.**

| Nơi | Ngưỡng cross | Nguồn |
|---|---|---|
| `geometry::convex_decompose` | `Tolerance::linear_mm × P` = **`1e-6 × P`** | `cross_tolerance_mm2` |
| `kernel::minkowski_convex` | **`1e-9 × P`** viết cứng | `is_convex_ccw` |

`no_fit_polygon` gọi `convex_decompose` rồi đưa từng mảnh vào `minkowski_convex`. Mảnh có đỉnh
lõm nằm trong dải `[1e-9·P, 1e-6·P]` được phân rã **nhận là lồi** và trả về **một mảnh duy nhất**,
rồi kernel chặn ngay sau đó. Comment tại `nfp.rs:156` ghi "Mảnh đã lồi nên đây là phép chính xác;
lỗi chỉ xảy ra khi dữ liệu bệnh" — giả định đó không đúng, và vì vậy **thông điệp lỗi chỉ sai chỗ**:
người dùng đọc "chỉ nhận đa giác lồi" trong khi khuôn của họ *là* lồi về ý nghĩa cơ khí.

### Đo trước bản vá

Vòng 6 đỉnh, đỉnh giữa cạnh dưới lõm `sag` mm:

```text
sag=1e-8  is_convex_ring(lỏng)=true   pieces=1  nfp=Kernel(NotConvex)
sag=1e-7  is_convex_ring(lỏng)=true   pieces=1  nfp=Kernel(NotConvex)
sag=1e-6  is_convex_ring(lỏng)=true   pieces=1  nfp=Kernel(NotConvex)
sag=1e-5  is_convex_ring(lỏng)=false  pieces=2  nfp=Ok        ← lõm HƠN lại chạy
```

Nghịch lý ở dòng cuối là bằng chứng khoá cơ chế: khuôn **lõm rõ** chạy tốt vì nó mới được tam giác
hoá đúng; chỉ khuôn **gần lồi** mới hỏng. Sag `1e-6 mm` là một **nanomet** — dao bế không tồn tại
sai số đó, nên đây thuần là nhiễu làm tròn toạ độ.

### Vì sao lỗi xuất hiện bây giờ

Bug nằm sẵn trong `imposition_core`, **không phải** do lô nesting tạo ra. Nhưng lô §A4b-2 làm nó
từ hiếm thành gặp được: trước đó contour đi qua `unary_union` của Shapely nên được GEOS chuẩn hoá;
sau khi giữ lỗ khuôn, contour giữ **nguyên đỉnh thô của bộ trích nét PDF** — gồm đỉnh trùng (đo
được: chữ nhật 4 góc ra **8 đỉnh**) và đỉnh gần thẳng từ sample bezier. Đó đúng là nhóm đỉnh có
thể lõm nhẹ do làm tròn.

## 2. Bản vá

Hai bước phải đi cùng nhau:

1. **Một luật lồi duy nhất.** Hằng tỉ lệ chuyển về `model::CONVEX_STRICT_TOL_RATIO`, dùng chung cho
   `kernel::is_convex_ccw` và `geometry::is_convex_strict`. Đặt ở `model` vì `geometry` **cố ý không
   phụ thuộc** `kernel` (ghi rõ ở doc đầu `geometry.rs`), nên `model` là nơi duy nhất hai bên gặp nhau.
   `convex_decompose` giờ xét lồi và gộp mảnh theo luật **nghiêm** — luật mà consumer đòi.
2. **Dọn đỉnh vô nghĩa trước.** `drop_near_straight_vertices` bỏ đỉnh trùng và đỉnh có độ võng dưới
   dung sai. Bước này làm bước 1 an toàn: đỉnh còn lại có `|cross|` vượt dung sai lỏng, nên hai luật
   đồng ý. Không có bước này, luật nghiêm sẽ tam giác hoá cả contour bezier nhiều đỉnh và đụng
   `MAX_CONVEX_PAIRS` — đổi một lỗi thành lỗi khác.

`minkowski_convex` **giữ nguyên** hành vi từ chối hình lõm. Kernel cố ý không tự chữa ("dùng phép
này cho hình lõm sẽ cho kết quả sai âm thầm"); việc chữa thuộc upstream, và đó đúng là nơi bản vá đặt.

### Sau bản vá

```text
sag=1e-8 … 1e-6  pieces=1  nfp=Ok    ← bỏ đỉnh vô nghĩa ⇒ lồi thật ⇒ đường nhanh nhất
sag=1e-5         pieces=2  nfp=Ok
```

## 3. Bằng chứng không hồi quy hình học

| Bất biến | Kết quả |
|---|---|
| Hình L (1 đỉnh lõm) vẫn ra **2 mảnh**, không phải 4 tam giác | giữ |
| Đỉnh lõm **thật** (5 mm) vẫn được phân rã, diện tích phủ đúng vòng gốc | giữ |
| Đường tròn sample 72 điểm vẫn **1 mảnh** và **không mất đỉnh nào** | giữ |
| Chữ nhật có đỉnh trùng ⇒ 1 mảnh, gộp về đúng 4 góc | mới đúng |

Bất biến thứ ba quan trọng nhất: nó chứng minh `drop_near_straight_vertices` **không** ăn vào hình
học thật. Đỉnh đường tròn R20 sample 72 điểm có độ võng ~0,019 mm — cao hơn dung sai `1e-6` bốn bậc.

## 4. Phạm vi — 6 file

| File | Thay đổi |
|---|---|
| `imposition_core/src/mixed_nesting/model.rs` | +`CONVEX_STRICT_TOL_RATIO` |
| `imposition_core/src/mixed_nesting/kernel.rs` | dùng hằng chung thay số viết cứng |
| `imposition_core/src/mixed_nesting/geometry.rs` | +`is_convex_strict`, +`drop_near_straight_vertices`, `convex_decompose` dùng luật nghiêm |
| `imposition_core/src/mixed_nesting/mod.rs` | export hai hằng để test dùng |
| `imposition_core/tests/mixed_nesting_convex_tolerance.rs` | mới, 7 test |
| `backend/tests/test_mixed_nesting_native.py` | +8 test qua biên native |

Vượt trần ≤5 file. Lý do: sửa một luật lồi bắt buộc chạm cả hai bên dùng nó cộng module nền giữ
hằng; tách ra sẽ để lại trạng thái nửa vời có hai luật.

## 5. Verify

| Bộ | Kết quả |
|---|---|
| `cargo test imposition_core` | **299 passed, 0 failed** (nền 292 + 7 mới) |
| `test_mixed_nesting_native.py` riêng | **46 passed** |
| Toàn bộ `backend/tests` | **4451 passed, 19 skipped**, 1 đỏ không liên quan (xem §5.1) |
| Số test | 4451 + 1 + 19 = 4471 = nền 4463 + 8 mới ✓ |

**Đã build lại `pdfcompare_native`** (`maturin develop --release`); nếu không build lại thì bản vá
Rust không có hiệu lực ở Python.

### 5.1 Một test đỏ không liên quan

`test_pdf_manifest_jobs.py::test_failed_job_has_terminal_message_and_removes_partial_and_upload`
— `assert list(tmp_path.iterdir()) == []` gặp một file `.partial.pdf` mà job nền chưa kịp dọn.

Bằng chứng là flake có sẵn, không phải hồi quy: chạy riêng **3/3 xanh**; thuộc luồng ghép PDF
manifest, không có đường import nào tới `mixed_nesting`; và chính file test đó ở chỗ khác **có**
vòng chờ `deadline` cho assert cùng dạng, tức tác giả đã biết đua này. Ghi thành finding
**MANIFEST-JOB-1** mức P3, không sửa trong lô này vì ngoài phạm vi.

### 5.2 Rác build đã dọn

`maturin develop` khi có process đang giữ `.pyd` sẽ để lại thư mục `~*fcompare_native` **chứa code
cũ** (pip tự cảnh báo). Đã tích lũy **5 thư mục** từ 27/08 tới nay; xoá được 4, còn
`~=fcompare_native` bị sidecar dev đang chạy khoá — sẽ xoá được sau khi khởi động lại sidecar.

## 6. Việc người dùng cần làm

**Khởi động lại sidecar backend** (hoặc chạy lại `run_dev.bat`). Tiến trình uvicorn đang chạy giữ
bản `.pyd` **cũ** trong bộ nhớ, nên lỗi vẫn xuất hiện tới khi nó nạp lại.

## 7. Còn hở

| Mã | Nội dung | Mức |
|---|---|---|
| NFP-CONVEX-1 | Thông điệp `KERNEL_NOT_CONVEX` tới người dùng vẫn là câu kỹ thuật của kernel ("Phép Minkowski nhanh chỉ nhận đa giác lồi"). Nếu còn ca nào chạm mã này, người dùng không biết phải làm gì. Nên có lớp dịch sang tiếng người ở tầng service | P2 |
| NFP-CONVEX-2 | `decomposition_covers` so diện tích mảnh với vòng **gốc** trong khi mảnh dựng từ vòng đã dọn đỉnh. Sai lệch nằm dưới ngưỡng tương đối `1e-6 × area` trong mọi test, nhưng chưa có ca cực đoan (rất nhiều đỉnh gần thẳng trên hình nhỏ) | P2 |
| MANIFEST-JOB-1 | Flake dọn file `.partial.pdf` ở `test_pdf_manifest_jobs.py` — thiếu vòng chờ deadline | P3 |
| BUILD-1 | `maturin develop` để lại thư mục `~*` chứa code cũ mỗi lần build khi có process giữ `.pyd`. Nên thêm bước dọn vào `run_dev.bat` | P3 |
