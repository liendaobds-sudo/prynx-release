# NHẬT KÝ SỬA — BÙ XÉN QUỸ ĐẠO (LÔ A) — 2026-07-30

> Theo `docs/BAO_CAO_AUDIT_BU_XEN_LAN2_2026-07-30.md` mục 5, lô A đã được duyệt.
> Phạm vi: 1 file engine + 1 file test. **Chưa commit.**

## 1. Các thay đổi

| Mã | File | Thay đổi | Lý do |
|---|---|---|---|
| BX-09 | `backend/app/workers/sticker_engine.py:845-857` | Kẹp `slopes` **một lần** trước vòng lặp (`slope_limit = min(_TRAJ_MAX_SLOPE, _TRAJ_MAX_REACH_FACTOR)`) thay vì kẹp `offset` theo từng `step` | Kẹp theo bước biến quỹ đạo thành đường hai đoạn: đi đúng dốc rồi **bẻ ngang song song mép**. Đo được khuỷu 31° và tới 48,6% bề rộng dải đi ngang — đây chính là "gãy khúc" |
| BX-08 | `sticker_engine.py:693-719` | `_TRAJ_MAX_SLOPE` 1.25 (giữ, nhưng **nay có hiệu lực**); `_TRAJ_MAX_REACH_FACTOR` 0.6 → 1.25; comment ghi rõ hai hằng là **hai đại lượng khác nhau** | Với clip-theo-bước cũ, trần tầm với 0.6 tự động biến thành trần dốc 0.6 (≈31°) và làm `_TRAJ_MAX_SLOPE` thành code chết. Sau BX-09 hai khái niệm tách rời nên phải định lại giá trị bằng đo |
| BX-13 | `backend/tests/test_sticker_trajectory_bleed.py` | Thêm `test_effective_slope_tracks_true_slope_magnitude` (khoá **độ lớn** dốc hiệu dụng, không chỉ dấu) và `test_trajectory_has_no_elbow_along_strip` (khoá không có khuỷu dọc dải). Sửa `test_extend_axis_pads_total_width` bị mất tên hàm | Bộ test cũ vẫn xanh khi dốc bị ép từ 1,25 về 0,6 — không phân biệt "bám nét đúng" với "không bám gì cả" |

Chọn trần dốc 1.25 bằng đo, không bằng cảm nhận (sai số dốc nội vùng, mép 1200px, dải 35px):

| trần | d=0,2 | d=0,4 | d=0,6 | d=0,8 | d=1,0 | d=1,25 |
|---:|---:|---:|---:|---:|---:|---:|
| 1,00 | 0,058 | 0,081 | 0,102 | 0,082 | 0,178 | **0,298** |
| 1,25 | 0,058 | 0,081 | 0,102 | 0,082 | 0,178 | **0,090** |
| 2,00 | 0,058 | 0,081 | 0,102 | 0,082 | 0,178 | 0,090 |

Nới 1,00 → 1,25 chỉ đổi hoa văn dốc hơn 45°; nới tiếp lên 2,00 không lợi thêm → 1,25 là điểm dừng.

## 2. Kết quả đo trước/sau lô A

### 2a. Khuỷu gập (gốc rễ của "gãy khúc") — ĐÃ XOÁ

| Dốc thật | % bề rộng dải đi ngang TRƯỚC | SAU | Góc bẻ TRƯỚC | SAU |
|---:|---:|---:|---:|---:|
| 0,80 | 20,0% | **0,0%** | 31,0° | 37,0° (= dốc thật) |
| 1,00 | 34,3% | **0,0%** | 31,0° | 43,2° |
| 1,25 | 48,6% | **0,0%** | 31,0° | 50,6° |

Cột "góc bẻ" sau bản vá không còn là khuỷu mà là **góc đi thẳng của vệt** — nó tiến về góc thật của nét, đúng như mong đợi.

### 2b. Độ bám nét (dốc hiệu dụng vs ground truth)

| Dốc thật | Dốc hiệu dụng TRƯỚC | SAU | % hàng chạm trần TRƯỚC | SAU |
|---:|---:|---:|---:|---:|
| 0,60 | 0,498 | 0,498 | 0,0% | 0,0% |
| 0,80 | 0,600 | **0,753** | 88,3% | **0,0%** |
| 1,00 | 0,600 | **0,822** | 97,7% | **0,0%** |
| 1,25 | 0,600 | **1,160** | 93,8% | **0,0%** |

Ba dốc cuối trước đây cho **cùng một** dốc 0,600 (thông tin hướng bị xoá sạch); nay mỗi dốc ra một giá trị riêng theo đúng thứ tự.

### 2c. File thật `Binder162.pdf` (bù xén 3mm = 35px)

| Mép | tầm với TRƯỚC | SAU | gãy khúc TRƯỚC | SAU | % chạm trần SAU |
|---|---:|---:|---:|---:|---:|
| phải | 0,60 | 1,10 | 2,2px | 2,6px | 0,0% |
| trái | 0,60 | 0,75 | 0,6px | 0,6px | 0,0% |
| trên | 0,51 | 0,51 | 1,0px | 1,0px | 0,0% |
| dưới | 0,60 | 1,25 | 0,2px | 0,2px | 1,8% |

Tầm với tăng là **chủ đích**: trần cũ 0,6 đang chặn oan các hàng có nét dốc thật. Gãy khúc gần như không đổi (mép phải +0,4px) vì nguồn gãy còn lại là nhiễu structure-tensor, không phải khuỷu clip.

## 3. Verify

| Phép kiểm | Kết quả |
|---|---|
| `pytest tests/test_sticker_trajectory_bleed.py` | **15 passed** (12 cũ + 3 mới/sửa) |
| `pytest -k "sticker or bleed or mirror"` | **65 passed** — không hồi quy |
| Render ảnh pixel cuối 3 biến thể (A trước BX-07 / B sau BX-07 / C sau lô A) | `backend/debug_output/bleed_right_SO_SANH.png` |
| Đo lại toàn bộ 4 probe + fidelity trên file thật | số ở mục 2 |

Công cụ đo (untracked, `backend/scripts/`): `measure_bleed_trajectory.py`, `measure_bleed_fidelity.py`,
`probe_bleed_regimes.py`, `probe_bleed_before_after.py`, `probe_bleed_fold.py`, `probe_bleed_elbow.py`,
`render_bleed_before_after.py`.

## 4. Tiêu chí nghiệm thu lô A — đối chiếu thật

Tiêu chí đã đặt trong báo cáo: *"sai số dốc nội vùng ≤ 0,08 ở mọi dốc ≤ 1,0, đồng thời gãy khúc không tăng"*.

- **Gãy khúc: ĐẠT** (không tăng ở 3/4 mép; mép phải +0,4px, trong nhiễu đo).
- **Sai số dốc: ĐẠT MỘT PHẦN.** Đạt ở d=0,2 (0,058), d=0,4 (0,081), d=0,8 (0,082) và d=1,25 (0,090);
  **KHÔNG đạt** ở d=0,6 (0,102) và d=1,0 (0,178).
- Phần sai số còn lại **không do trần dốc** — nó giữ nguyên ở cả ba trần 1,00/1,25/2,00 trong bảng mục 1,
  nên nguồn là **làm trơn hướng (BX-10)**, thuộc lô B.

## 5. Còn mở

- **BX-10** (P1, lô B) — sigma làm trơn (tới 64px) trải hướng **xuyên ranh giới hoa văn**: mép 3508px có
  **167 hàng** (≈14mm @300DPI) bị lấy hướng của mảng bên cạnh. Đây là gốc rễ của "loang", **chưa sửa**.
- **BX-12** (P2) — `min_spacing = 0.05` cho phép kéo dãn tới 20× ở quỹ đạo hội tụ (đo được 1,72×).
- **BX-04 / BX-06 / BX-02** (từ lần 1) — nguồn màu 1 cột mép, nhãn UI, mode mặc định.
- **Nghiệm thu bằng mắt:** cần bạn chạy `Binder162.pdf` qua tab **Xén vuông + Làm mượt thông minh**
  và xác nhận khuỷu gập đã hết trước khi tôi vào lô B.
