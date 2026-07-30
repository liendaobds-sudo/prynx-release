# BÁO CÁO AUDIT BÙ XÉN — LẦN 2 (kiểm bản vá BX-07) — 2026-07-30

> **CẬP NHẬT 2026-07-30 (sau khi bạn duyệt):** **lô A ĐÃ SỬA + verify**
> (BX-09 xoá khuỷu gập, BX-08 định lại trần dốc, BX-13 thêm test khoá độ lớn).
> Số đo trước/sau và đối chiếu tiêu chí nghiệm thu: `docs/BU_XEN_FIXES_2026-07-30.md`.
> Lô B (BX-10 — "loang") và lô C **chưa làm**.

> Tiếp nối `docs/BAO_CAO_AUDIT_BU_XEN_2026-07-30.md`. Lần 1 đã sửa BX-07 và báo
> "đạt" dựa trên 3 chỉ số trơn (tầm với / số đoạn xé / gãy khúc). Lần 2 đo **phần
> mà 3 chỉ số đó không nhìn thấy** — và tìm ra nguyên nhân hình học của đúng hai
> triệu chứng bạn mô tả: **gãy khúc** và **loang**.
>
> Trạng thái: **CHỈ KHẢO SÁT + ĐO. Không sửa một dòng nào của engine.**

## 1. Kết luận điều hành

Bản vá BX-07 làm quỹ đạo **trơn hơn thật**, nhưng nó đạt được điều đó bằng cách
**làm phẳng hướng** — và cái giá phải trả tạo ra hai lỗi mới, đúng khớp với than
phiền "gãy khúc và loang rất nhiều":

1. **Gãy khúc = KHUỶU GẬP hình học có thể đo bằng độ.** Hằng
   `_TRAJ_MAX_REACH_FACTOR = 0.6` được clip **theo từng bước** trong vòng lặp, nên
   vệt màu đi đúng hướng nét một đoạn rồi **bẻ ngang song song mép** cho hết dải.
   Với hoa văn dốc 1.25, **48,6% bề rộng dải đi ngang**, góc bẻ **31°**.
2. **Loang = hướng bị trải XUYÊN ranh giới hoa văn.** Sigma làm trơn (tới 64px)
   lớn hơn nhiều khoảng cách giữa các mảng hoa văn khác hướng, nên dải bù xén của
   vùng B thừa hưởng hướng của vùng A. Đo: mép 3508px → **167 hàng** quanh mỗi
   ranh giới bị nhiễm hướng.
3. **Chỉ số của lần 1 không thể phát hiện hai lỗi trên** — cả ba đều đạt **điểm
   tối đa khi thuật toán làm phẳng hoàn toàn** (`slopes ≡ 0` → tầm với 0, đổi dấu
   0, gãy 0). Bảng "trước → sau" của lần 1 chứng minh **độ trơn**, không chứng
   minh **độ đúng**.

Đo bổ sung: độ bám nét (sai số so với ground truth) **tệ đi 5–15×** sau bản vá.

| Hoa văn | Sai số dốc TRƯỚC vá | SAU vá |
|---|---:|---:|
| một hướng, dốc 0,2 | 0,050 | 0,058 |
| một hướng, dốc 0,4 | 0,048 | 0,081 |
| một hướng, dốc 0,8 | 0,032 | **0,200** |
| một hướng, dốc 1,2 | 0,041 | **0,600** |

## 2. Phương pháp và công cụ đo mới

Ba script mới (untracked, `backend/scripts/`) — chạy bằng `backend/venv`:

| Script | Đo gì |
|---|---|
| `measure_bleed_fidelity.py` | Độ **bám nét** so ground truth + nhiễm chéo + Jacobian + tỉ lệ chạm trần |
| `probe_bleed_regimes.py` | Bốn probe A–D: trần dốc, hội tụ/phân kỳ, vị trí `jac=0`, bề rộng loang |
| `probe_bleed_before_after.py` | So TRƯỚC/SAU bản vá bằng cách khôi phục tham số cũ |
| `probe_bleed_fold.py` | Nếp gấp nằm ở biên hay giữa dải |
| `probe_bleed_elbow.py` | Vị trí và góc khuỷu gập |

Hoa văn tổng hợp `chevron()` có **ground truth độ dốc biết trước bằng toán** (sọc
theo hướng `(1, s)` ⇒ isophote `y − s·x = const` ⇒ `dy/dx = s`), nên đo được sai
số tuyệt đối — điều file thật không cho phép.

**Sửa một lỗi phương pháp của lần 1:** `map_y` là ánh xạ **nghịch**, nên độ dốc
thuận là `−(map_y − row)/step`. Script cũ bỏ dấu trừ; điều này không đổi biên độ
`|d|` nhưng đổi dấu, nên mọi kết luận về **hướng** của lần 1 cần đọc lại.

## 3. Findings

### BX-08 — P0 — `_TRAJ_MAX_REACH_FACTOR` thực chất là TRẦN ĐỘ DỐC 0.6, không phải trần tầm với; `_TRAJ_MAX_SLOPE = 1.25` là code chết

**Bằng chứng.** `sticker_engine.py:844-850`:

```python
max_reach = _TRAJ_MAX_REACH_FACTOR * float(amount)   # = 0.6 × amount
for step in range(1, amount + 1):
    offset = np.clip(slopes * float(step), -max_reach, max_reach)
```

Clip áp **trong vòng lặp, theo từng `step`**. Tại `step = amount`, điều kiện không
bị chặn là `|slopes| × amount ≤ 0.6 × amount`, tức `|slopes| ≤ 0.6`. Vậy trần tầm
với **biến thành trần độ dốc = 0.6**.

Đo (probe A, hoa văn một hướng, mép 1200px, dải 35px):

| Dốc thật | Dốc hiệu dụng | Sai số | % hàng chạm trần |
|---:|---:|---:|---:|
| 0,10 | 0,062 | 0,038 | 0,0% |
| 0,40 | 0,319 | 0,081 | 0,0% |
| 0,60 | 0,498 | 0,102 | 0,0% |
| **0,80** | **0,600** | 0,200 | **88,3%** |
| **1,00** | **0,600** | 0,400 | **97,7%** |
| **1,25** | **0,600** | 0,650 | **93,8%** |

Ba dốc cuối cho **cùng một** dốc hiệu dụng 0,600 — thông tin hướng bị xoá hoàn
toàn. Và vì 0,6 chặt hơn 1,25, `_TRAJ_MAX_SLOPE` **không bao giờ có hiệu lực**:
comment ở `:693-697` giải thích vì sao "GIỮ clamp 1.25" trong khi hằng đó đã chết.

**Tác động.** Mọi hoa văn nghiêng hơn ~31° bị ép về đúng 31°. Tia mặt trời gần
phương đứng — chính ca của bạn — nằm hết trong vùng này.

**Effort:** S. **Confidence:** cao (đo trực tiếp, 7 điểm dốc).

### BX-09 — P1 — GỐC RỄ CỦA "GÃY KHÚC": clip theo từng bước tạo KHUỶU GẬP giữa dải

**Bằng chứng.** Cùng dòng `:849`. Vì clip theo `step`, quỹ đạo là đường **hai
đoạn**: đi đúng dốc `slopes` tới bước `⌈max_reach / |slopes|⌉`, rồi từ đó **đi
ngang song song mép** cho hết dải.

Đo (probe khuỷu, dải 35px, trần 21px):

| Dốc thật | Bước chạm trần | % bề rộng dải đi ngang | Góc bẻ |
|---:|---:|---:|---:|
| 0,20 | 35 (không chạm) | 0,0% | 7,8° |
| 0,60 | 35 (không chạm) | 0,0% | 25,3° |
| **0,80** | **28** | **20,0%** | **31,0°** |
| **1,00** | **23** | **34,3%** | **31,0°** |
| **1,25** | **18** | **48,6%** | **31,0°** |

Đây **không phải nhiễu** mà là **khuỷu xác định, lặp lại được** — mắt thấy ngay
dưới dạng nét đang chạy chéo thì gập vuông rồi chạy song song mép. Trên file thật
`Binder162.pdf`, 75–78% số hàng chạm trần (probe fold), nên khuỷu này phủ phần lớn
chu vi.

**Vì sao lần 1 không thấy.** Chỉ số `max_jump` của lần 1 đo **hiệu giữa hai hàng
kề ở cột xa nhất** — khuỷu là gập **dọc theo bước ra ngoài**, cùng một hàng. Trục
đó không có chỉ số nào.

**Hướng sửa (đề xuất, chờ duyệt).** Clip **`slopes` một lần** trước vòng lặp thay
vì clip `offset` theo từng bước: quỹ đạo trở lại đường **thẳng** (mất khuỷu), tầm
với vẫn bị chặn đúng bằng `trần × amount`. Đây là thay đổi ~2 dòng và **không**
làm tệ bất kỳ chỉ số nào của lần 1.

**Effort:** S. **Confidence:** cao.

### BX-10 — P1 — GỐC RỄ CỦA "LOANG": sigma trải hướng xuyên ranh giới hoa văn

**Bằng chứng.** `:797-816` — sigma `max(0.18×px_per_mm, 0.35×amount, 0.03×h)`,
trần 64. Với mép dài, số hạng `0.03×h` thắng và sigma đạt trần.

Đo (probe D, hoa văn 3 vùng khác hướng, dải 35px):

| Chiều dài mép | sigma | Bề rộng nhiễm quanh ranh giới | % mép |
|---:|---:|---:|---:|
| 480px | 14,4 | 24 hàng | 5,0% |
| 960px | 28,8 | 70 hàng | 7,3% |
| 1920px | 57,6 | 124 hàng | 6,5% |
| 3508px | 64,0 | **167 hàng** | 4,8% |
| 4960px | 64,0 | **179 hàng** | 3,6% |

167 hàng ở 300 DPI ≈ **14 mm** dọc mép bị lấy hướng của mảng hoa văn bên cạnh.
Đây đúng nghĩa "loang": không phải màu bị nhoè, mà **hướng bị vay của vùng khác**
nên màu bị kéo từ chỗ không liên quan.

Bản vá BX-07 **có** giảm tỉ lệ nhiễm (12,2% → 4,7% ở mép 3508px) nhưng **đổi bản
chất lỗi**: trước là nhiễu rời rạc, sau là **trải trơn xuyên biên** — trơn hơn nên
3 chỉ số cũ khen, mà nhìn thì loang thành dải rộng liền.

**Hướng sửa (đề xuất).** Làm trơn **có bảo toàn biên** (bilateral / joint theo độ
tương đồng hướng, hoặc chỉ trơn trong đoạn cùng dấu dốc) thay vì Gaussian đồng
nhất; hoặc tách sigma khỏi `h` (chiều dài mép không phải lý do vật lý để trơn
mạnh hơn — nó chỉ là tương quan trong đo lần 1).

**Effort:** M. **Confidence:** cao.

### BX-11 — P2 — Bản vá BX-07 đánh đổi độ bám nét lấy độ trơn, mức 5–15×

**Bằng chứng** (probe before/after, khôi phục tham số cũ `sigma = min(4, 0.18×px_per_mm)`,
không median, không trust-weight, không clip reach):

| Mép | Phiên bản | Sai số nội vùng | Nhiễm | Gãy | Tầm với |
|---:|---|---:|---:|---:|---:|
| 480 | TRƯỚC | **0,037** | 15,8% | 16,4px | 0,78 |
| 480 | SAU | 0,200 | 14,6% | **7,8px** | 0,60 |
| 1200 | TRƯỚC | **0,037** | 16,1% | 19,0px | 0,78 |
| 1200 | SAU | 0,200 | **8,2%** | **1,3px** | 0,60 |
| 3508 | TRƯỚC | **0,034** | 12,2% | 19,0px | 0,78 |
| 3508 | SAU | 0,200 | **4,7%** | **1,0px** | 0,60 |

Đọc bảng: bản vá **thắng rõ** ở gãy khúc và nhiễm, **thua 5,4×** ở bám nét. Sai số
nội vùng 0,200 chính là dấu vết của BX-08 (dốc ground truth 0,8 bị ép về 0,6).

Điều này nghĩa là **BX-08/BX-09 không phải hồi quy do bản vá gây ra một cách ngẫu
nhiên** — chúng là cơ chế mà bản vá dùng để đạt điểm trơn. Sửa BX-08/09 sẽ lấy lại
phần bám nét **mà không** trả lại gãy khúc, vì hai nguồn gãy khác nhau (nhiễu
structure-tensor vs khuỷu clip).

**Effort:** — (không phải finding độc lập; là phép đo hệ quả). **Confidence:** cao.

### BX-12 — P2 — `min_spacing = 0.05` cho phép kéo dãn tới 20× ở quỹ đạo HỘI TỤ

**Bằng chứng.** `:851-854`:

```python
min_spacing = 0.05
forward_y = np.maximum.accumulate(forward_y - source_y * min_spacing) + source_y * min_spacing
```

Trần kéo dãn lý thuyết = `1/0.05 = 20×`. Đo (probe B, mép 1200px):

| Kiểu | jac min | jac max |
|---|---:|---:|
| hội tụ (+0,8 rồi −0,8) | 0,00 | **1,72** |
| phân kỳ (−0,8 rồi +0,8) | 0,73 | 1,07 |

Ca **hội tụ** (hai mảng hoa văn chụm hướng vào nhau — rất thường gặp ở hoa văn
đối xứng) bị kéo dãn 1,72× → vệt bị bôi dài, trong khi ca phân kỳ lành.

**Xác minh chéo (quan trọng — tránh lặp lỗi lần 1).** `jac_min = 0` **KHÔNG** phải
nếp gấp giữa dải: probe fold cho thấy toàn bộ đoạn `jac < 0.02` nằm **sát biên**
(hàng 0..13 của mép 1200px), tức là **kẹp `left/right` của `np.interp`** ở
`:855-857`, không phải khuỷu nội vùng. Vì vậy xếp **P2** chứ không P0, và mô tả
đúng là "kéo dãn ở ca hội tụ", không phải "gấp nếp".

**Effort:** S (nới `min_spacing`) — nhưng cần đo lại vì nó tồn tại để chống giao
cắt quỹ đạo. **Confidence:** trung bình-cao.

### BX-13 — P1 (phương pháp) — Bộ chỉ số của lần 1 không phân biệt "bám nét đúng" với "không bám gì cả"

**Bằng chứng.** Ba chỉ số của `measure_bleed_trajectory.py` — `reach_ratio`,
`sign_flips`, `max_jump` — đều là hàm của **trường dịch**. Đặt `slopes ≡ 0` (làm
phẳng hoàn toàn, bù xén thành kéo giãn vuông góc) thì cả ba **về 0**, tức **điểm
hoàn hảo**. Không có chỉ số nào phạt việc mất hướng.

Đây là lý do lần 1 báo "đạt" trong khi hai lỗi nhìn thấy được vẫn còn nguyên (và
một lỗi — khuỷu gập — do chính bản vá tạo ra).

**Hướng sửa.** Bổ sung ground-truth oracle (`measure_bleed_fidelity.py` đã có) vào
bộ verify chuẩn; test hiện có `test_sunburst_keeps_divergence` chỉ khẳng định **dấu**
đổi quanh tâm, không khẳng định **độ lớn** — nó vẫn xanh khi dốc bị ép từ 1,25 về
0,6.

**Effort:** S (đã có script; cần thêm test khoá ngưỡng). **Confidence:** cao.

## 4. Không phải nguyên nhân (đã kiểm, loại)

- **Không phải `_TRAJ_MAX_SLOPE = 1.25` quá chặt.** Hằng này chết (BX-08); nới nó
  đơn lẻ không đổi một pixel nào.
- **Không phải median filter làm phẳng.** Probe before/after cho thấy phần lớn sai
  số nội vùng đến từ clip 0.6, không từ median.
- **Không phải nếp gấp giữa dải.** `jac_min = 0` là kẹp biên `np.interp` (BX-12).
- **Không phải nhánh `image`/mirror/solid.** Cả ba không dùng quỹ đạo; findings này
  chỉ chạm `inpaint` + `rectangle_mode` (Xén vuông + Làm mượt thông minh).

## 5. Đề xuất sửa theo lô — CHỜ DUYỆT

### Lô A — hình học quỹ đạo (1 file, `sticker_engine.py`, effort S)
1. **BX-09**: clip `slopes` **một lần** trước vòng lặp thay vì clip `offset` mỗi
   bước → xoá khuỷu gập, giữ nguyên trần tầm với.
2. **BX-08**: sau khi (1) xong, trần tầm với và trần dốc là **hai đại lượng khác
   nhau** → định lại giá trị bằng đo (ứng viên: nới trần dốc về 1,0–1,25 như
   `_TRAJ_MAX_SLOPE` đã định, giữ tầm với chặn ở `1.0×amount`), và **xoá hoặc dùng
   thật** `_TRAJ_MAX_SLOPE`.
3. **BX-13**: thêm test khoá **độ lớn** dốc hiệu dụng (không chỉ dấu) vào
   `test_sticker_trajectory_bleed.py`.

Tiêu chí nghiệm thu lô A: sai số dốc nội vùng ≤ 0,08 ở mọi dốc ≤ 1,0 (hiện 0,20–0,60),
đồng thời gãy khúc **không** tăng so với hiện tại (≤ 1,3px ở mép 1200px).

### Lô B — làm trơn bảo toàn biên (1 file, effort M)
4. **BX-10**: thay Gaussian đồng nhất bằng trơn có bảo toàn ranh giới; tách sigma
   khỏi `0.03×h`.

Tiêu chí: bề rộng nhiễm quanh ranh giới ≤ 30 hàng ở mép 3508px (hiện 167).

### Lô C — sau cùng, nếu còn thấy (effort S–M)
5. **BX-12**: đo lại `min_spacing` ở ca hội tụ.
6. **BX-04** (từ lần 1, chưa làm): nguồn màu vẫn chỉ 1 cột mép `img[:, -1:]`.
7. **BX-06/BX-02** (từ lần 1, chưa làm): nhãn UI và mặc định mode.

## 6. Coverage & proof gap

- **Đã đo:** trần dốc (7 điểm), khuỷu gập (6 điểm), loang theo chiều dài mép
  (5 điểm), trước/sau bản vá (3 mép × 2 phiên bản + 4 dốc × 2), hội tụ vs phân kỳ,
  vị trí `jac = 0` (3 cột × 3 cấu hình). Tất cả bằng `backend/venv`, gọi thẳng hàm
  production qua spy `cv2.remap`.
- **Regression check:** `test_sticker_trajectory_bleed.py` — **12 passed** (không
  sửa code nên đây chỉ là xác nhận baseline sạch).
- **Proof gap 1:** chưa render **ảnh** trước/sau cho mắt soi. Số đo là gián tiếp
  (trường dịch), không phải pixel cuối. Vẫn cần bạn chạy thật để đối chiếu.
- **Proof gap 2:** hoa văn tổng hợp là **sọc thẳng nhiều vùng**, không phải tia tỏa
  liên tục. Ground truth chỉ có được với hoa văn tổng hợp; ca radial thật chỉ đo
  được gián tiếp (tầm với/jac/clip%).
- **Ngoài phạm vi:** nhánh `image`/mirror/solid, PPE/màu mực (§BX.3 lần 1), hiệu
  năng, `trim_shift_engine`.

## 7. Chốt duyệt

**Chưa sửa gì.** Bốn file untracked mới trong `backend/scripts/` là công cụ đo —
giữ lại để verify lô A/B, hoặc nói nếu bạn muốn tôi dọn.

Câu hỏi cần bạn quyết trước khi tôi vào lô A:

1. **Duyệt lô A không?** Đây là ~2–5 dòng, xoá khuỷu gập và trả lại độ bám nét.
   Rủi ro thấp, đo được cả hai chiều.
2. **Trần dốc nên là bao nhiêu?** Đề xuất 1,0 (≈45°) làm mặc định an toàn, hoặc
   1,25 (≈51°) như `_TRAJ_MAX_SLOPE` từng định. Tôi sẽ đo cả hai rồi báo số trước
   khi chốt.
3. Có muốn tôi **render ảnh trước/sau** trên `Binder162.pdf` để soi bằng mắt song
   song với số đo không? (đóng proof gap 1)
