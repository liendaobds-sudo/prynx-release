# Báo cáo spike polygon kernel cho Mixed Nesting (P2b0)

**Ngày:** 2026-08-26
**Phase:** P2b0 — Chốt polygon kernel và dependency
**Kế hoạch gốc:** `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §6.1, §11.2, §18
**Toolchain đo:** cargo 1.94.0 (85eff7c80 2026-01-15), Windows, build `--release`
**Nơi chạy spike:** thư mục tạm ngoài repo (`%TEMP%\mn_kernel_spike`, `%TEMP%\mn_kernel_spike2`) — spike **không** để lại file nào trong repo

## 0. Kết luận trước

**NO-GO cho P2b0 theo đúng đặc tả hiện tại.**

Kế hoạch §6.1 giả định có **một** kernel cung cấp cả ba phép: offset, boolean và Minkowski.
Đo thực tế: hai phép đầu **đạt**, phép Minkowski **trượt ở mọi phương án đã khảo sát** —
kể cả bản C++ gốc của Clipper2. Vì gate ghi rõ "nếu chưa đạt thì NO-GO", lượt này
**không** chạm `imposition_core/Cargo.toml`, hai lockfile và `THIRD_PARTY_NOTICES.md`.

Cần chủ dự án chọn một amendment ở §7 trước khi land dependency.

## 1. Phương án đã khảo sát

| Crate | Phiên bản | Giấy phép | Boolean | Offset | Minkowski | Số học | Toolchain |
|---|---|---|---|---|---|---|---|
| `clipper2-rust` | 1.1.0 | BSL-1.0 | có | có | có (SAI) | `i64` fixed-point | thuần Rust |
| `i_overlay` | 8.1.0 | MIT OR Apache-2.0 | có | có | **không có** | số nguyên qua `i_float` | thuần Rust |
| `clipper2` (bọc C++) | 0.6.0 | MIT OR Apache-2.0 | có | có | có (SAI) | `i64` fixed-point | **cần MSVC** |
| `cavalier_contours` | 0.9.0 | MIT OR Apache-2.0 | polyline | có | không | `f64` | thuần Rust |
| `geo-buffer` | 0.2.0 | Apache-2.0 | không | có | không | `f64` | thuần Rust |

Hai crate cuối chỉ làm offset và dùng `f64`, không đáp ứng yêu cầu "robust fixed-point
kernel" của §6.1 nên chỉ ghi nhận, không đo sâu.

`clipper2` bọc C++ kéo theo `cc` + `clipper2c-sys`, build lạnh **135,5 giây** và cần
MSVC trên máy build. Riêng điều đó đã xung đột với yêu cầu "đường đóng gói native được
chứng minh" (maturin + Nuitka), nên nó chỉ được dùng làm **đối chứng** cho phép Minkowski.

## 2. Boolean — ĐẠT

Union trên bộ fixture khó mà gate yêu cầu. Hai engine độc lập được so **parity**:

| Fixture | clipper2-rust (mm²) | i_overlay (mm²) | Kỳ vọng | Lệch |
|---|---|---|---|---|
| rời nhau | 200,000000 | 200,000000 | 200 | 0 |
| chồng một nửa | 150,000000 | 150,000000 | 150 | 0 |
| **tangency** cạnh–cạnh | 200,000000 | 200,000000 | 200 | 0 |
| **tangency** đỉnh–đỉnh | 200,000000 | 200,000000 | 200 | 0 |
| **near-overlap** hở 1e-5 mm | 200,000000 | 200,000000 | 200 | 0 |
| **near-overlap** chồng 1e-5 mm | 199,999900 | 199,999900 | 199,9999 | 1,4e-7 |
| **concave** L + ô vuông lấp lõm | 2820,000000 | 2820,000000 | 2820 | 0 |
| **sliver** 100×0,002 mm + chữ nhật | 1000,000000 | 1000,000000 | 1000 | 0 |

8/8 khớp. Hai engine dùng thuật toán khác nhau nên trùng khớp ở cả bốn ca bệnh
(tangency, near-overlap, sliver) là bằng chứng đủ mạnh cho tính robust.

## 3. Offset — ĐẠT

### 3.1 Offset hình lõm

Hình L 60×47 khoét, diện tích gốc 1718,0000 mm².

| delta | clipper2-rust | i_overlay |
|---|---|---|
| +1,50 mm | 1 vòng, 2048,0000 mm² | 1 vòng, 2042,3750 mm² |
| +0,50 mm | 1 vòng, 1826,0000 mm² | 1 vòng, 1825,3750 mm² |
| −0,50 mm | 1 vòng, 1612,0000 mm² | 1 vòng, 1612,1250 mm² |
| −1,50 mm | 1 vòng, 1406,0000 mm² | 1 vòng, 1407,1250 mm² |

Chênh ≤0,3% và đến từ **kiểu bo góc mặc định khác nhau** (miter vs bo tròn/vát), không
phải sai số robustness. Với PrynX, `gap/2` chỉ cần offset **ra ngoài** ở mức mm nên
chênh này nằm sâu dưới dung sai sản xuất; tuy vậy kiểu bo góc phải được **chốt tường
minh** trong `kernel.rs` chứ không dùng mặc định của thư viện.

### 3.2 Offset split-collapse — ca gate quan trọng nhất

Hình quả tạ: hai đầu 30×30 nối bằng cổ rộng **đúng 2 mm**. Lý thuyết: offset vào
1,0 mm (đúng nửa bề rộng cổ) là ngưỡng tách thành hai mảnh.

| delta | clipper2-rust | i_overlay |
|---|---|---|
| −0,50 mm | 1 vòng, 1703,0000 mm² | 1 vòng, 1703,5000 mm² |
| −0,90 mm | 1 vòng, 1594,8400 mm² | 1 vòng, 1596,4600 mm² |
| **−1,00 mm** | **2 vòng** (đã tách), 1568,0000 mm² | **2 vòng** (đã tách), 1570,0000 mm² |
| −1,10 mm | 2 vòng, 1545,6800 mm² | 2 vòng, 1547,6800 mm² |
| −2,00 mm | 2 vòng, 1352,0000 mm² | 2 vòng, 1354,0000 mm² |
| −8,00 mm | 2 vòng, 392,0000 mm² | 2 vòng, 394,0000 mm² |
| −20,00 mm | **0 vòng** (sập hết) | **0 vòng** (sập hết) |

Cả hai engine tách **đúng ngưỡng lý thuyết**, không sớm không muộn, và sập về rỗng
thay vì trả vòng rác.

Chữ nhật 4×4 (bán kính nội tiếp đúng 2 mm):

| delta | clipper2-rust | i_overlay |
|---|---|---|
| −1,00 mm | 1 vòng, 4,000000 mm² | 1 vòng, 4,000000 mm² |
| −1,90 mm | 1 vòng, 0,040000 mm² | 1 vòng, 0,040000 mm² |
| **−2,00 mm** | **0 vòng** | **0 vòng** |
| −2,10 mm | 0 vòng | 0 vòng |
| −3,00 mm | 0 vòng | 0 vòng |

Sập **đúng tại bán kính nội tiếp**. Đây là hành vi cần thiết: nếu engine trả một vòng
suy biến ở delta ≤ −2,0 thì clearance geometry sẽ nói dối về chỗ trống.

## 4. Minkowski — TRƯỢT ở mọi phương án

### 4.1 Phép đo

Oracle độc lập: với **hai polygon lồi**, Minkowski sum là **bao lồi** của mọi tổng cặp
đỉnh (định lý cơ bản) — nên nó **không thể có lỗ**. Oracle được viết riêng trong spike
bằng bao lồi Andrew monotone chain.

`clipper2-rust 1.1.0`, `minkowski_diff`, mọi input đều LỒI:

| Ca (đều lồi) | Vòng | Lỗ | Tổng có dấu (mm²) | Oracle (mm²) | Kết quả |
|---|---|---|---|---|---|
| rect80×40 ⊕ rect30×20 | 2 | 1 | 5600,0000 | 6600,0000 | **SAI** |
| rect10×10 ⊕ rect10×10 | 1 | 0 | 400,0000 | 400,0000 | OK |
| rect80×40 ⊕ tri20 | 2 | 1 | 4198,0000 | 5558,8000 | **SAI** |
| tri30 ⊕ tri20 | 2 | 1 | 1558,8000 | 1602,1000 | **SAI** |
| bát giác r20 ⊕ rect10×6 | 2 | 1 | 1251,8335 | 1831,3709 | **SAI** |
| poly16 r30 ⊕ poly8 r5 | 2 | 1 | 1831,0545 | 3744,4716 | **SAI** |

5/6 ca lồi sai. Ca rect80×40 ⊕ rect30×20 trả vòng ngoài 11 đỉnh (+6600, đúng) **cộng
một lỗ 4 đỉnh −1000 mm² không tồn tại**.

### 4.2 Không phải do dùng sai API

Thử đủ 8 biến thể: `sum` vs `diff`, đổi thứ tự `pattern`/`path`, đảo chiều từng vòng.
Thêm `union` với cả `NonZero` và `Positive` sau đó.

| Biến thể | Đúng trên mọi ca lồi? |
|---|---|
| `diff(B, A)` | KHÔNG |
| `diff(B_rev, A)` | KHÔNG |
| `diff(B, A_rev)` | KHÔNG |
| `diff(B_rev, A_rev)` | KHÔNG |
| `sum(B, A)` | KHÔNG |
| `sum(B_rev, A)` | KHÔNG |
| `sum(B, A_rev)` | KHÔNG |
| `sum(B_rev, A_rev)` | KHÔNG |

**0/8 biến thể đúng.** `union_subjects(NonZero)` và `union_subjects(Positive)` đều
**không** loại được lỗ rác (lỗ đã là vòng có hướng hợp lệ nên fill rule giữ nó lại).

### 4.3 Bản C++ gốc cho kết quả Y HỆT

Chạy lại đúng bộ fixture và đúng oracle trên `clipper2 0.6.0` (bọc Clipper2 C++ của
Angus Johnson qua `clipper2c-sys`):

| Ca (đều lồi) | Vòng | Lỗ | Tổng (mm²) | Oracle (mm²) | Kết quả |
|---|---|---|---|---|---|
| rect80×40 ⊕ rect30×20 | 2 | 1 | 5600,0000 | 6600,0000 | **SAI** |
| rect10×10 ⊕ rect10×10 | 1 | 0 | 400,0000 | 400,0000 | OK |
| rect80×40 ⊕ tri20 | 2 | 1 | 4198,0000 | 5558,8000 | **SAI** |
| tri30 ⊕ tri20 | 2 | 1 | 1558,8000 | 1602,1000 | **SAI** |
| bát giác r20 ⊕ rect10×6 | 2 | 1 | 1252,1124 | 1831,3708 | **SAI** |
| poly16 r30 ⊕ poly8 r5 | 2 | 1 | 1832,8976 | 3744,4716 | **SAI** |

Số trùng nhau tới 4 chữ số thập phân. Kết luận: **đây là hành vi của Clipper2 upstream,
không phải lỗi của bản port Rust.** Clipper2 trả "quad soup" chưa hợp nhất đúng và để
người dùng tự xử lý; tài liệu của nó không nêu rõ cách xử lý an toàn cho hình lõm.

### 4.4 Cách chữa cháy "chỉ giữ vòng dương" — đúng cho lồi, KHÔNG an toàn cho lõm

| Ca lồi | Tổng thô | Chỉ vòng dương | Oracle | Vòng dương đúng? |
|---|---|---|---|---|
| rect80×40 ⊕ rect30×20 | 5600,0000 | 6600,0000 | 6600,0000 | OK |
| rect10×10 ⊕ rect10×10 | 400,0000 | 400,0000 | 400,0000 | OK |
| rect80×40 ⊕ tri20 | 4198,0000 | 5558,8000 | 5558,8000 | OK |
| tri30 ⊕ tri20 | 1558,8000 | 1602,1000 | 1602,1000 | OK |
| bát giác r20 ⊕ rect10×6 | 1251,8335 | 1831,3709 | 1831,3708 | OK |
| poly16 r30 ⊕ poly8 r5 | 1831,0545 | 3744,4716 | 3744,4716 | OK |
| poly32 r25 ⊕ tri8 | 1194,6310 | 2577,7503 | 2577,7503 | OK |

7/7 ca **lồi** đúng. Với hình lõm, Clipper2 trả thêm vòng âm:

```text
NFP(chữ C 60×50 hõm sâu, probe 8×8) theo Clipper2: 2 vòng
   vòng[0]: 18 đỉnh, +3116,0000 mm²
   vòng[1]: 12 đỉnh,  −620,0000 mm²
```

> **Cải chính (đo lại ở §11).** Bản đầu của báo cáo này viết lỗ −620 mm² là "lỗ thật
> của NFP". **Sai.** Oracle raster ở §11.2 cho thấy NFP đúng của ca này là **một vòng
> 3116,00 mm², không có lỗ** (8100/8100 điểm lưới khớp). Vòng −620 cũng là rác của
> Clipper2, không phải hình học thật.

Điều đó **không** làm cách chữa cháy trở nên an toàn, vì hai lý do vẫn còn nguyên:

1. Nó chỉ được chứng minh đúng trên các fixture đã thử. Lỗ **thật** trong NFP xuất
   hiện khi part tĩnh có **hốc kín** đủ lớn để part động nằm hẳn bên trong mà không
   chạm biên ngoài. MVP coi lỗ là vật liệu đặc (§5.3) nên hiện chưa dựng được ca đó,
   nhưng dựa vào một sự trùng hợp của phạm vi hiện tại là nợ kỹ thuật, không phải bằng
   chứng.
2. Hiệu năng ở §4.5 vẫn loại phép này bất kể đúng sai.

### 4.5 Hiệu năng cũng loại phép này

| Phép | clipper2-rust (thô) | clipper2-rust (thô + union) | clipper2 C++ |
|---|---|---|---|
| NFP 6 đỉnh ⊕ 4 đỉnh | 0,025 ms | 0,019 ms | 0,035 ms |
| NFP 50 đỉnh ⊕ 4 đỉnh | 0,395 ms | 0,374 ms | 0,433 ms |
| NFP 50 đỉnh ⊕ 50 đỉnh | **12,670 ms** | **84,242 ms** | **6,356 ms** |

Corpus `C100` của kế hoạch §17 có contour 500–2000 đỉnh trước simplify. Solver phải
tính NFP cho từng cặp part × từng góc đề xuất; ở 6–84 ms một phép thì `balanced`
(12 trial × 32 proposal) đã tiêu hàng chục giây chỉ để dựng NFP. Ngay cả nếu Minkowski
đúng, con số này vẫn cần một đường khác.

Đối chiếu: oracle bao lồi cho một cặp **lồi** chạy ở thang **micro-giây** — tức đường
"phân rã lồi + Minkowski lồi chính xác" ở §7 amendment A nhanh hơn nhiều bậc.

## 5. Số liệu benchmark boolean/offset

| Phép (500 lần, release) | clipper2-rust | i_overlay |
|---|---|---|
| union 500 đỉnh × 500 đỉnh | **0,1769 ms** | 0,2184 ms |
| offset 500 đỉnh (miter) | **0,2515 ms** | 0,5314 ms |

clipper2-rust nhanh hơn ~19% ở union và ~2,1× ở offset.

## 6. Kiểm dependency và đóng gói (cho `clipper2-rust 1.1.0`)

### 6.1 Fixed-point an toàn ở thang tờ in

Union hình chữ nhật 700×1000 mm ở nhiều thang fixed-point, kỳ vọng 700000 mm²:

| Thang | Độ phân giải | Toạ độ max | Kết quả | |
|---|---|---|---|---|
| 1e4 | 1e-4 mm | 1,0e7 | 700000,0000 | OK |
| 1e5 | 1e-5 mm | 1,0e8 | 700000,0000 | OK |
| **1e6** | **1e-6 mm** | 1,0e9 | 700000,0000 | OK |
| 1e7 | 1e-7 mm | 1,0e10 | 700000,0000 | OK |

Thang **1e6** khớp đúng `Tolerance::v1().linear_mm = 1e-6` đã chốt ở P1, và còn cách
`i64::MAX` nhiều bậc. Đề xuất chốt `KERNEL_FIXED_POINT_SCALE = 1e6` với version riêng.

### 6.2 Delta lockfile — đo trên bản copy, không chạm repo

`cargo add clipper2-rust@1.1.0` vào bản copy của `imposition_core`:

```text
crate trước: 45
crate sau  : 46
crate mới  : + clipper2-rust 1.1.0
crate đổi phiên bản: (không có)
```

Cây phụ thuộc: `clipper2-rust 1.1.0 → num-traits 0.2.19 → libm 0.2.16`.
**Cả `num-traits 0.2.19` và `libm 0.2.16` đã có sẵn trong cả `imposition_core/Cargo.lock`
và `native/Cargo.lock` ở đúng phiên bản đó** — nên tổng crate mới thực sự là **1**.

Không có `cc`, `cmake`, `bindgen`, `*-sys` hay build script ⇒ **không cần toolchain
C/C++**, maturin dựng cdylib thuần Rust như hiện tại.

**Cảnh báo quy trình:** `cargo generate-lockfile` làm **trôi 15 crate không liên quan**
(serde 1.0.228→229, geo-types 0.7.19→0.7.20, syn, thiserror, memchr…). Khi land phải
dùng `cargo add` rồi verify bằng `--locked`, **tuyệt đối không** `generate-lockfile`.

### 6.3 cargo audit

| Lockfile | Kết quả |
|---|---|
| `imposition_core/Cargo.lock` (hiện tại) | exit 0, không advisory |
| `imposition_core/Cargo.lock` + clipper2-rust | exit 0, không advisory (46 crate) |
| `native/Cargo.lock` (hiện tại) | 3 cảnh báo *unmaintained* có sẵn (`ttf-parser`, …) |

Dependency mới **không** thêm advisory nào. Ba cảnh báo của `native` là tồn đọng sẵn,
không liên quan phase này.

### 6.4 Hồi quy

Toàn bộ test hiện có chạy lại trên bản copy có dependency mới, bằng `--locked`:

```text
lib unit                 37 passed
grid_parity               1 passed
mixed_nesting_contract   44 passed
mixed_nesting_transform  43 passed
TEST_EXIT=0
```

### 6.5 Giấy phép

`clipper2-rust 1.1.0` dùng **BSL-1.0** (Boost Software License 1.0) — permissive, không
copyleft, không buộc công bố nguồn, chỉ yêu cầu giữ thông báo bản quyền trong bản phân
phối dạng nguồn. Phù hợp sản phẩm desktop thương mại. Đây là giấy phép **mới** với repo
(chưa xuất hiện ở §4 `THIRD_PARTY_NOTICES.md`), nên khi land phải thêm cả dòng crate lẫn
ghi chú nghĩa vụ.

`i_overlay 8.1.0` dùng MIT OR Apache-2.0, khớp với phần còn lại của cây, nhưng kéo thêm
**5 crate mới** (`i_float`, `i_key_sort`, `i_shape`, `i_tree`) và **không có Minkowski**.

## 7. Amendment cần chủ dự án chọn

Kế hoạch §6.1 hiện viết: "`nfp.rs` là NFP mới theo relative orientation" và `kernel.rs`
là "fixed-point polygon kernel cho offset/boolean/Minkowski". Phần Minkowski của câu này
**không có phương án thực thi nào đạt**. Ba đường đi:

### Amendment A — khuyến nghị

Chốt `clipper2-rust 1.1.0` cho **offset + boolean**. NFP ở P2c dựng bằng:

1. Phân rã lồi cả hai part (kernel không cần lo).
2. Minkowski của **từng cặp lồi** bằng hợp nhất vector cạnh theo góc — thuật toán sách
   giáo khoa, `O(m+n)`, **chính xác**, và kiểm được trực tiếp bằng oracle bao lồi mà
   spike này đã viết.
3. Hợp nhất mọi cặp bằng boolean union của kernel đã vetted.

Điều này **không** vi phạm "không tự viết offset bằng `geo` để lách gate": offset vẫn
đến từ kernel đã kiểm, chỉ phần hợp nhất vector cạnh của Minkowski lồi là tự viết — và
nó exact, có oracle độc lập, không phải phép xấp xỉ.

Chi phí: P2c cần thêm bước phân rã lồi, tức `nfp.rs` phình hơn dự kiến. Có thể phải tách
thành một lô riêng.

### Amendment B — bỏ NFP khỏi MVP

Kế hoạch §11.2 đã tự ghi: "NFP/IFP là **bộ sinh candidate và broad-phase accelerator**;
final validator không gọi lại NFP làm authority." Nếu vậy MVP có thể sinh candidate từ
contact event + kiểm collision trực tiếp, và để NFP cho phase tối ưu sau.

Ít code hơn, ít rủi ro hình học hơn, nhưng tìm kiếm chậm hơn và §11.2/§16.1 phải sửa
để bỏ các hạng mục parity NFP.

### Amendment C — tiếp tục khảo sát

Tìm crate NFP chuyên dụng hoặc port một bản Minkowski đã được kiểm chứng. Chưa có ứng
viên nào lộ ra trong lượt khảo sát này; tốn thêm thời gian và không bảo đảm kết quả.

## 8. Diff sẽ áp dụng nếu Amendment A hoặc B được duyệt

Bốn file còn lại của P2b0 **chưa được sửa**. Nội dung dự kiến:

**`imposition_core/Cargo.toml`** — thêm đúng một dòng vào `[dependencies]`:

```toml
# Kernel polygon fixed-point (spike P2b0): CHI dung boolean + offset.
# Minkowski cua crate nay da duoc do la SAI (xem docs/BAO_CAO_SPIKE_MIXED_NESTING_KERNEL.md §4)
# nen tuyet doi khong goi minkowski_sum/minkowski_diff.
clipper2-rust = "1.1.0"
```

**`imposition_core/Cargo.lock`** — thêm đúng một block `clipper2-rust 1.1.0`, không đổi
phiên bản crate nào khác (dùng `cargo add`, không `generate-lockfile`).

**`native/Cargo.lock`** — thêm cùng một block, giữ lock skew bằng 0.

**`THIRD_PARTY_NOTICES.md`** — thêm vào §4 bảng crate Rust:

```text
| [clipper2-rust](https://github.com/larsbrubaker/clipper2-rust) | 1.1.0 | BSL-1.0 |
```

và một dòng ở §1 ghi nhận BSL-1.0 là giấy phép permissive mới xuất hiện trong cây.

## 9. Rủi ro còn lại

1. **Kiểu bo góc offset phải chốt tường minh.** Hai engine chênh ~0,3% chỉ vì mặc định
   khác nhau. `kernel.rs` phải ghi rõ `JoinType` và `miter_limit`/`arc_tolerance` cùng
   version, không dùng mặc định thư viện — nếu không, đổi phiên bản crate là đổi hình
   học mà không ai thấy.
2. **Minkowski của crate phải bị chặn ở tầng code.** Nếu land dependency, cần một chốt
   (test hoặc lint) cấm gọi `minkowski_sum`/`minkowski_diff` để người sau không "tiện tay"
   dùng lại phép đã biết là sai.
3. **BSL-1.0 là giấy phép mới trong cây.** Cần chủ dự án xác nhận trước khi land.
4. **Đường đóng gói native chỉ được chứng minh ở mức "thuần Rust, không build script,
   không `*-sys`, cây phụ thuộc đã có sẵn".** Bằng chứng end-to-end qua `maturin develop
   --release` và `build_production.ps1` chỉ có được **sau** khi land — chưa chạy được ở
   lượt NO-GO này.
5. **Chưa đo corpus C100 (500–2000 đỉnh).** Benchmark dừng ở 500 đỉnh cho boolean/offset
   và 50 đỉnh cho Minkowski. Nếu chọn Amendment A thì phải đo lại NFP trên C100 ở P2c.

## 10. Trạng thái gate P2b0

| Hạng mục gate | Kết quả |
|---|---|
| Fixture concave | ĐẠT (boolean + offset) |
| Fixture sliver | ĐẠT |
| Fixture tangency | ĐẠT |
| Fixture near-overlap | ĐẠT |
| Fixture offset split-collapse | ĐẠT (tách/sập đúng ngưỡng lý thuyết) |
| Benchmark offset | ĐẠT |
| Benchmark boolean | ĐẠT |
| Benchmark Minkowski | **TRƯỢT** (sai kết quả + quá chậm) |
| Giấy phép phù hợp | ĐẠT, nhưng BSL-1.0 là loại mới, cần xác nhận |
| `cargo audit` xanh | ĐẠT |
| Lock skew xanh | ĐẠT (0 crate đổi phiên bản) |
| Đường đóng gói native | ĐẠT ở mức tĩnh; end-to-end chỉ có sau khi land |
| Không thêm `[profile.release]` | ĐẠT (không chạm Cargo.toml) |

**Kết luận vòng đầu: NO-GO** cho đặc tả gốc (một kernel làm cả ba phép).
**Sau khi chủ dự án duyệt Amendment A: GO** — xem §11 và §12.

## 11. Kiểm chứng Amendment A trước khi land

Chủ dự án chọn "phương án tối ưu và mạnh nhất" ⇒ **Amendment A**. Trước khi land
dependency, đường A được đo lại để chứng minh nó thật sự chạy, không chỉ chứng minh
Clipper2 sai. Probe chạy trong `%TEMP%\nfp_probe`, ngoài repo, đã dọn.

Cấu trúc đường A:

```text
NFP(A, B) = ∪(i,j)  ( A_i ⊕ (−B)_j )     với A_i, B_j đều LỒI
   A_i, B_j : phân rã lồi
   ⊕ lồi–lồi: hợp nhất vector cạnh theo góc, O(m+n), CHÍNH XÁC
   ∪        : boolean union của clipper2-rust (đã vetted ở §2)
```

### 11.1 Minkowski lồi–lồi chính xác — 7/7

Đối chiếu với oracle bao lồi (bao lồi của mọi tổng cặp đỉnh):

| Ca (đều lồi) | Đỉnh kết quả | Tính được (mm²) | Oracle (mm²) | |
|---|---|---|---|---|
| rect80×40 ⊕ rect30×20 | 4 | 6600,000000 | 6600,000000 | OK |
| rect10×10 ⊕ rect10×10 | 4 | 400,000000 | 400,000000 | OK |
| rect80×40 ⊕ tri20 | 6 | 5558,800000 | 5558,800000 | OK |
| tri30 ⊕ tri20 | 3 | 1082,500000 | 1082,500000 | OK |
| poly8 r20 ⊕ rect10×6 | 12 | 1831,370850 | 1831,370850 | OK |
| poly16 r30 ⊕ poly8 r5 | 24 | 3744,471629 | 3744,471629 | OK |
| poly32 r25 ⊕ tri8 | 35 | 2577,750340 | 2577,750340 | OK |

Sai 0/7, khớp tới `1e-9` tương đối. Khác hẳn Clipper2: **không** vòng rác, số đỉnh đúng
bằng `m+n` tối giản chứ không phải 11 đỉnh cho một hình chữ nhật.

### 11.2 NFP hình lõm — oracle raster 8100/8100

Oracle độc lập thứ hai, không dùng chung một dòng code nào với đường tính:
`NFP = { t : A ∩ (t+B) ≠ ∅ }`, quét lưới 90×90 = 8100 điểm, mỗi điểm kiểm giao bằng
segment-intersection + point-in-polygon.

| Ca | Số mảnh | Cặp | Vòng KQ | Diện tích (mm²) | Raster khớp | Thời gian |
|---|---|---|---|---|---|---|
| L lõm ⊕ rect8×8 | 4 × 2 | 8 | 1 | 2638,00 | **8100/8100** | 79,6 µs |
| chữ C hõm sâu ⊕ rect8×8 | 6 × 2 | 12 | 1 | 3116,00 | **8100/8100** | 41,1 µs |
| chữ C ⊕ L lõm (cả hai lõm) | 6 × 4 | 24 | 1 | 10538,00 | **8100/8100** | 166,8 µs |

Không một điểm lưới nào lệch. Ca thứ hai chính là ca đã làm rõ cải chính ở §4.4: NFP
đúng có **một vòng 3116,00 mm², không lỗ** — nên vòng −620 mm² của Clipper2 cũng là rác.

### 11.3 Hiệu năng

| Ca | Số cặp | Đường tổng quát | Đường nhanh lồi–lồi |
|---|---|---|---|
| L 6 đỉnh ⊕ 4 đỉnh | 8 | 0,0101 ms | — |
| C 8 đỉnh ⊕ 4 đỉnh | 12 | 0,0138 ms | — |
| C 8 đỉnh ⊕ L 6 đỉnh | 24 | 0,0389 ms | — |
| poly16 lồi ⊕ poly8 lồi | 84 | 0,4777 ms | **0,00071 ms** |
| poly50 lồi ⊕ poly8 lồi | 288 | 4,7948 ms | **0,00161 ms** |
| poly50 lồi ⊕ poly50 lồi | 2304 | 298,2730 ms | **0,00140 ms** |

So trực tiếp trên cùng ca 50 ⊕ 50 đỉnh:

| | Kết quả | Thời gian |
|---|---|---|
| Minkowski của Clipper2 | **SAI** | 12,670 ms thô / 84,242 ms kèm union |
| Amendment A, đường lồi–lồi | **ĐÚNG** (2 oracle) | **0,00133 ms** |

Nhanh hơn khoảng **10.000×** và đúng.

### 11.4 Ràng buộc bắt buộc cho P2b/P2c rút ra từ probe

1. **Phải có đường nhanh lồi–lồi.** Khi cả hai part lồi thì bỏ hẳn bước phân rã và
   union: một phép `O(m+n)` là đủ, chạy ở thang micro-giây.
2. **Không được dùng tam giác hoá làm phân rã lồi.** Probe cố ý dùng ear-clipping để đo
   **ca xấu nhất**: 50 ⊕ 50 lõm cho 2304 cặp và 298 ms. Phân rã lồi thật (Hertel–Mehlhorn:
   tam giác hoá rồi bỏ các đường chéo không cần thiết) cho tối đa `r+1` mảnh với `r` là số
   đỉnh lõm. Khuôn bế thật có rất ít đỉnh lõm: hình L có 1 ⇒ 2 mảnh thay vì 4; chữ C có
   2 ⇒ 3 mảnh thay vì 6. Đây là điều kiện chặn của P2c, không phải tối ưu tùy chọn.
3. **Cache NFP theo cặp geometry + orientation quantum** như §11.2 kế hoạch đã ghi, để
   ca lõm–lõm nhiều đỉnh không phải tính lại.

## 12. Trạng thái gate sau Amendment A

| Hạng mục | Kết quả |
|---|---|
| Kernel cho boolean | `clipper2-rust 1.1.0`, 8/8 fixture, parity với `i_overlay` |
| Kernel cho offset | `clipper2-rust 1.1.0`, tách/sập đúng ngưỡng lý thuyết |
| Đường NFP | Amendment A: 7/7 lồi exact + 8100/8100 raster lõm |
| Minkowski của crate | **BỊ CẤM GỌI** — ghi rõ trong `Cargo.toml` |
| Benchmark | boolean 0,177 ms; offset 0,252 ms; NFP lồi 0,0013 ms |
| Giấy phép | BSL-1.0, permissive, đã ghi §1 và §4 `THIRD_PARTY_NOTICES.md` |
| `cargo audit` | exit 0, không advisory mới |
| Lock skew | `+10/−0` dòng mỗi lockfile, cùng checksum, 0 crate đổi phiên bản |
| Đóng gói native | thuần Rust, không build script, `cargo check native` xanh |
| `[profile.release]` | không thêm |
| Hồi quy | 125 test cũ xanh với `--locked` |

**GATE P2b0: ĐẠT.**

## 13. Cách xử lý `THIRD_PARTY_NOTICES.md` — và một phát hiện phụ

`THIRD_PARTY_NOTICES.md` là file **sinh tự động** bằng `scripts/gen_third_party_notices.py`
và tự ghi ở đầu file "Đừng sửa tay". Vì vậy lượt này **không** sửa tay tùy ý mà làm theo
cách kiểm chứng được:

1. Chạy generator ra một file tạm (`--out`), không ghi đè bản trong repo.
2. Đối chiếu: generator sinh đúng dòng
   `| [clipper2-rust](https://github.com/larsbrubaker/clipper2-rust) | 1.1.0 | BSL-1.0 |`
   **giống từng ký tự** với dòng thêm bằng tay, kể cả URL (generator ưu tiên `repository`
   hơn `homepage`) và vị trí sắp xếp (giữa `cipher 0.5.2` và `color_quant 1.1.0`).
3. Kết quả: **§4 khớp generator hoàn toàn** — 800 crate ở cả hai bản, 0 dòng khác.
   Diff thực tế trên file: `+1 / −0`.

Bản nháp đầu của lượt này còn thêm một mục "Permissive — BSL-1.0" vào §1. **Đã bỏ**, vì
generator chỉ sinh §1 cho copyleft mạnh/yếu (`COPYLEFT_MARKERS`, `WEAK_COPYLEFT_MARKERS`
tại `scripts/gen_third_party_notices.py:47-49`) — BSL-1.0 không khớp marker nào nên mục
đó sẽ **bị xoá âm thầm** ở lần sinh lại. Ghi chú nghĩa vụ để ở đây thay vào đó:

> **BSL-1.0 (Boost Software License 1.0)** là giấy phép permissive, không copyleft: không
> buộc công bố nguồn, không lây sang mã PrynX. Nghĩa vụ duy nhất là giữ thông báo bản
> quyền khi phân phối **dạng nguồn**; PrynX phát hành nhị phân nên thực tế không phát
> sinh nghĩa vụ đính kèm.

### Phát hiện phụ — không thuộc phase này

Bản `THIRD_PARTY_NOTICES.md` đang commit **đã lệch sẵn 222 dòng** so với môi trường hiện
tại, trước khi tôi chạm vào: 149 dòng ở mục Python (ví dụ `hypothesis 6.155.3` → `6.155.7`,
`pikepdf 9.5.0` → `10.9.1`, cộng nhiều gói `docling`/`easyocr` chưa có trong file) và 73
dòng ở mục npm. Nghĩa là `gen_third_party_notices.py --check` sẽ **đỏ** ở release QA vì lý
do không liên quan Mixed Nesting.

Tôi **không** chạy generator ghi đè, vì làm vậy sẽ kéo 222 dòng thay đổi lạ vào diff của
phase này. Đây là việc của một lô riêng: đồng bộ lại notices với venv/node_modules hiện
hành rồi soi diff.

## 14. Việc còn lại

1. **Sửa kế hoạch §6.1 một dòng**: ghi rằng `nfp.rs` dựng NFP theo Amendment A (phân rã
   lồi + Minkowski lồi chính xác + union) thay vì gọi Minkowski của kernel. Sửa file kế
   hoạch là **file thứ sáu** của phase này nên chưa làm — đề nghị gộp vào đầu lô P2b.
2. **Chốt cứng việc cấm gọi Minkowski của crate.** Hiện chỉ có comment trong
   `imposition_core/Cargo.toml`. Cần một test hoặc kiểm tra tĩnh trong P2b để người sau
   không "tiện tay" dùng lại phép đã biết là sai.
3. **Chốt tường minh `JoinType` + `miter_limit` + `arc_tolerance`** kèm version trong
   `kernel.rs` ở P2b (xem rủi ro §9.1).
4. **Đồng bộ lại `THIRD_PARTY_NOTICES.md`** cho phần Python/npm — lô riêng.
