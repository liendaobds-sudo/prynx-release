# BÁO CÁO AUDIT — BÙ XÉN / TẠO ĐƯỜNG CẮT / LÀM MƯỢT THÔNG MINH — 2026-07-30

> **CẬP NHẬT 2026-07-30 (sau khi đo trên file thật `Binder162.pdf`):**
> Chẩn đoán BX-01 ban đầu ("thuật toán không có phân kỳ") đã bị **BÁC BỎ bằng đo**.
> Gốc rễ thật là **BX-07 — quỹ đạo nhiễu/đứt đoạn**, đã SỬA + verify bằng số.
> Xem mục 3b và mục 8. Đọc mục 3 (BX-01/BX-03) với lưu ý là chẩn đoán cũ đã sai.

## 1. Kết luận điều hành

Than phiền của người dùng: *"dải màu kéo ra không đúng quỹ đạo — nền hoa văn mặt
trời (tia tỏa) rộng dần ra mép, bù xén xong không theo quỹ đạo rộng dần."*

**Kết luận cuối (sau khi đo):** thuật toán **CÓ** phân kỳ, nhưng trường quỹ đạo bị
**nhiễu và xé thành từng đoạn**, đồng thời **kéo màu từ khoảng cách phi lý** (tới
1,25× bề rộng dải). Đó là thứ mắt người dùng thấy là "không theo quỹ đạo".

Số đo trên `Binder162.pdf` (bù xén 3mm = 35px @300DPI), trước → sau bản vá:

| Mép | tầm với (\|d\|max/amount) | số đoạn xé (đổi dấu) | gãy khúc lớn nhất |
|---|---|---|---|
| phải | 1,25 → **0,60** | 8 → **4** | 19,0px → **2,2px** |
| trái | 1,11 → **0,60** | 7 → **5** | 19,0px → **0,6px** |
| trên | 1,25 → **0,51** | 24 → **2** | 19,0px → **1,0px** |
| dưới | 1,25 → **0,60** | 7 → **1** | 19,0px → **0,2px** |

Đồng thời có test khẳng định **phân kỳ KHÔNG bị giết** (tia tỏa vẫn loe).

## 2. Phạm vi và luồng đã trace

UI: `desktop/src/components/preprocess-tools/StickerTool.tsx` — 2 tab
`productType`: `sticker` (Bế tem) / `rectangle` (Xén vuông).

Hai trục điều khiển độc lập:
- `cut_mode` (`original`/`bleed`/`none`) — vị trí đường cắt (`sticker_engine.py:100-116`).
- `bleed_color_type` (`image`/`inpaint`/`solid`/`mirror`) — cách sinh màu vùng bù xén
  (phân nhánh `sticker_engine.py:2563-2607`).

Bảng mode theo tab (`StickerTool.tsx:35-46`):

| Tab | Mode UI | `bleed_color_type` | Thuật toán backend |
|---|---|---|---|
| Bế tem | 🖼️ Lấy theo màu viền tem | `image` | `_banded_nearest_fill` / `_nearest_color_fill` (`:951`/`:547`) |
| Bế tem | ✨ Làm mượt thông minh | `inpaint` | `_banded_inpaint_fill` / `_inpaint_color_fill` NS (`:992`/`:570`) |
| Bế tem | 🎨 Đổ màu trơn | `solid` | đổ màu phẳng (`:2599`) |
| Xén vuông | 🪞 Lật gương tự động | `mirror` | `page_boxes.add_mirror_bleed` (`page_boxes.py:1074`) |
| Xén vuông | ✨ Làm mượt thông minh | `inpaint`+`rectangle_mode` | `_rectangle_smooth_color_fill` → `_trajectory_*` (`:820`/`:799`/`:693`) |
| Xén vuông | 🖼️ Kéo giãn mép ảnh | `image` | vector `_rectangle_vector_bleed_commands` (`:1231`) hoặc nearest |
| Xén vuông | 🎨 Đổ màu trơn | `solid` | đổ màu phẳng |

Mặc định: `bleed_color_type = 'image'` (`StickerTool.tsx:276`; backend
`process_pdf` default `image`). Tab mặc định `sticker` (`:227`).

**Chỉ `_trajectory_*` (quỹ đạo) mới có khái niệm "theo hướng nét"**, và nó CHỈ chạy
khi `inpaint` + `rectangle_mode==True` (`sticker_engine.py:2578`). Mọi đường khác
không dùng quỹ đạo.

## 3. Findings

### BX-01 — P1 — Thuật toán quỹ đạo chỉ "trượt nghiêng" (shear 1D), không phân kỳ (fan-out) → không tái tạo được tia tỏa

**Bằng chứng.** `_trajectory_right_strip` (`sticker_engine.py:693-796`):

- Nguồn màu là **một cột mép duy nhất**: `edge = img[:, -1:]` (`:704`), rồi
  `cv2.remap(edge, map_x, map_y_all, ...)` (`:790`).
- Với mỗi hàng, ước lượng **một độ dốc vô hướng** `slopes[row]` từ structure tensor
  (`:756-769`), rồi ngoại suy tuyến tính `forward_y = source_y + slopes * step`
  (`:782`).
- `map_x = np.zeros(...)` (`:776`): toạ độ X nguồn **không đổi theo bước** — mọi cột
  bù xén đều lấy từ đúng cột mép, chỉ dịch theo Y.

**Vì sao không loe.** Mô hình này là **advection tuyến tính 1D dọc trục**: mỗi hàng
trượt theo một góc cố định. Tia mặt trời cần các hàng lân cận có góc **khác nhau và
mở rộng dần theo khoảng cách ra mép** (phân kỳ từ tâm). Với `slopes` là hằng theo
`step`, hai tia gần nhau giữ **song song**, không mở. Thêm nữa bước
`np.maximum.accumulate` (`:784-786`) **cưỡng chế đơn điệu** để chống giao cắt — điều
này chính xác **triệt tiêu** khả năng hai đường loe ra (loe = các đường phải rời xa
nhau phi tuyến). Kết quả: dải màu tỏa thành các vệt gần song song, đúng như mô tả.

**Tác động.** Đây là gốc rễ than phiền. Mọi hoa văn phân kỳ (tia mặt trời, quạt,
xoáy, gradient tỏa tròn) đều bị kéo thành vệt thẳng thay vì loe.

**Hướng sửa (đề xuất, chờ duyệt).** Cần một mode "bù xén theo trường hướng" thật:
ước lượng **trường vector 2D** (không phải 1 slope/hàng) và advect theo dòng chảy
(line integral / edge-tangent flow), cho phép phân kỳ; hoặc mode radial khi phát
hiện tâm đối xứng. Đây là **effort L** và là thay đổi thuật toán — nên tách project
riêng, không nhét vào lô sửa nhanh.

**Effort:** L. **Confidence:** cao (đọc trực tiếp toán trong hàm).

### BX-02 — P1 — Mode mặc định `image` ("Kéo giãn mép ảnh") không có quỹ đạo, dễ bị hiểu là "kéo ra sai"

**Bằng chứng.** Mặc định `bleed_color_type='image'` (`StickerTool.tsx:276`). Đường
này chạy nearest-neighbor (`_nearest_color_fill:547-567`) — nhân bản pixel mép ra
ngoài theo khoảng cách gần nhất, tức **vuông góc với mép**. Docstring tự mô tả:
"nhân bản pixel mép vuông góc ra ngoài" (`:549-550`). Nhánh vector rectangle
(`_rectangle_vector_bleed_commands:1231`) cũng chỉ **scale/kéo giãn** dải mép bằng
affine `a 0 0 d` (`:1301`) — **không có shear**, nên không nghiêng theo nét chứ đừng
nói loe.

**Tác động.** Người dùng chọn (hoặc để mặc định) "Kéo giãn mép ảnh" trên hoa văn tỏa
→ ra vệt thẳng vuông góc. Đây có thể chính là mode bạn đã thử khi thấy "kéo ra không
đúng quỹ đạo".

**Hướng sửa.** (a) Làm rõ trong UI rằng "Kéo giãn" = vuông góc, "Làm mượt thông minh"
mới bám nét; (b) hoặc route hoa văn phức tạp sang mode quỹ đạo. Phụ thuộc BX-01.

**Effort:** S (nếu chỉ UI) / L (nếu đổi thuật toán). **Confidence:** cao.

### BX-03 — P2 — Độ dốc quỹ đạo bị chặn ở ±1.25 → tia dốc/gần đứng bị bẻ phẳng

**Bằng chứng.** `np.clip(-direction_x/direction_y, -1.25, 1.25)` (`:759-761`), lặp
lại ở `:769`. Slope 1.25 ≈ 51°. Tia mặt trời gần phương đứng (ví dụ tia ở cạnh
trái/phải khi tâm nằm giữa) có góc > 51° so với phương ngang → bị ép về 51°, sai
hướng rõ.

**Tác động.** Ngay cả khi BX-01 được cải thiện, các tia dốc vẫn bị bẻ. Với cạnh
trên/dưới thì transpose (`:866-871`) đổi vai trò trục nên clamp áp lên phương khác —
vẫn cùng giới hạn.

**Hướng sửa.** Nới/loại clamp có kiểm soát, hoặc chuyển sang biểu diễn góc thay vì
slope (arctan) để không suy biến ở phương đứng.

**Effort:** S. **Confidence:** cao.

### BX-04 — P2 — Chỉ dùng 1 cột/hàng mép làm nguồn màu → mất cấu trúc theo chiều sâu

**Bằng chứng.** `edge = img[:, -1:]` (`:704`) — toàn bộ dải bù xén remap từ **đúng
một cột biên**. Structure tensor có nhìn `lookback` cột (`:710-714`) để ước lượng
hướng, nhưng **màu** thì chỉ lấy từ cột ngoài cùng.

**Tác động.** Nếu mép có nhiễu/anti-alias/sợi trắng mảnh (file không tràn lề), cả
dải bù xén thừa hưởng đúng hàng pixel đó. Kết hợp với BX-01, tia bị "bôi" một màu
biên thay vì tiếp nối gradient sâu bên trong.

**Hướng sửa.** Lấy nguồn từ dải sâu vài px (đã có `edge_bite`/`sample_depth` ở nhánh
vector) và nội suy theo chiều sâu khi advect.

**Effort:** M. **Confidence:** trung bình-cao.

### BX-05 — P2 — Không có test trực tiếp cho `_trajectory_right_strip` / `_trajectory_extend_axis` / `_rectangle_smooth_color_fill`

**Bằng chứng.** Rà `backend/tests/`: `test_sticker_engine_e2e.py` parametrize
`inpaint` nhưng với `rectangle_mode` mặc định False (đi nhánh NS, không phải
trajectory). Không file test nào gọi thẳng 3 hàm quỹ đạo. `test_mirror_bleed_origin.py`
chỉ phủ mirror; `test_sticker_bleed_seam.py` phủ `image`.

**Tác động.** Bất kỳ thay đổi thuật toán quỹ đạo (kể cả bản vá BX-01/03/04) đều
không có lưới an toàn — dễ hồi quy thầm lặng.

**Hướng sửa.** Thêm test tổng hợp: ảnh có band chéo/tỏa đã biết hướng, assert góc dải
bù xén khớp hướng nguồn trong sai số; test clamp; test đơn điệu.

**Effort:** M. **Confidence:** cao.

### BX-06 — P3 — Nhãn UI không truyền đạt được giới hạn từng mode

**Bằng chứng.** Nhãn "✨ Làm mượt thông minh" (`StickerTool.tsx:35-46`) gợi ý AI hiểu
nội dung, nhưng thực chất là advection tuyến tính; "🖼️ Kéo giãn mép ảnh" không nói
rõ là vuông góc. Người dùng kỳ vọng "thông minh" = bám mọi quỹ đạo.

**Hướng sửa.** Mô tả ngắn dưới mỗi mode (khi nào nên dùng), hoặc tooltip ví dụ.

**Effort:** S. **Confidence:** cao.

## 3b. BX-07 — P1 — GỐC RỄ THẬT: quỹ đạo nhiễu, xé đoạn, kéo màu từ khoảng cách phi lý → ĐÃ SỬA

**Cách phát hiện.** Dựng ảnh sunburst tổng hợp rồi đo trường dịch nội bộ (bắt
`cv2.remap`): dịch **đổi dấu đúng quanh tâm** (r0=+18,4 → r120=0,0 → r239=−18,3).
→ **BÁC BỎ** giả thuyết "không có phân kỳ" của BX-01. Sau đó đo trên file thật
`Binder162.pdf` bằng `backend/scripts/measure_bleed_trajectory.py`.

**Bằng chứng (trước bản vá, mép phải, dải 35px).**
- Tầm với: dịch tới **±63px** — tức lấy màu từ chỗ cách xa **1,8× bề rộng dải**.
- Trường dịch đổi dấu **8 lần** (hoa văn tỏa thật chỉ đổi 1 lần quanh tâm).
- Gãy khúc **19px** giữa hai hàng liền kề; mép trên xé thành **24 đoạn**.
- Chuỗi dịch thực: `−27, −44, +4, −5, −23, −41, −58, −5, −22, −40, −57, −6, +57, +40…`

**Root cause.** Ba khuyết điểm cộng dồn trong `_trajectory_right_strip`:
1. **Không giới hạn tầm với**: `forward_y = source_y + slopes*step` không chặn theo
   bề rộng dải, nên hướng ước lượng sai bị nhân lên theo `step`.
2. **Làm trơn quá yếu**: sigma cũ `0.18×px_per_mm` (≈2,1px @300DPI, trần cứng 4.0)
   không dập được dao động structure-tensor giữa các hàng kề. Mép dài 1738px mà sigma
   12 vẫn để xé 26 đoạn — **trần sigma 24 chính là nút thắt**.
3. **`np.interp` bắc cầu tuyến tính** qua các hàng không-valid (nền trơn) → hàng
   không có nét vẫn thừa hưởng độ dốc của cụm nét ở xa, tạo bậc giả.

**Bản vá (`sticker_engine.py`).**
- Điểm 1: `_TRAJ_MAX_REACH_FACTOR = 0.6` — clip `offset` theo `0.6×amount`.
- Điểm 2: sigma theo `max(DPI, 0.35×amount, 0.03×chiều_dài_mép)`, trần nới 24 → 64
  (`_TRAJ_SMOOTH_PER_AMOUNT`, `_TRAJ_SMOOTH_PER_EDGE`, `_TRAJ_SMOOTH_MAX_SIGMA`).
  Thêm `median_filter` (scipy — `cv2.medianBlur` không nhận float32 khi ksize>5) dập
  bậc rời rạc trước Gaussian.
- Điểm 3: nhân `slopes` với "độ tin cậy" (khoảng cách tới vùng có nét đã làm trơn) để
  hàng không-valid đi thẳng thay vì thừa hưởng dốc từ xa.
- BX-03: **GIỮ clamp 1.25**, không nới. Đo cho thấy nới đơn lẻ khi chưa dập nhiễu làm
  biên độ bung ±63px (tệ hơn). Clamp phải đi cùng giới hạn tầm với.

**Verify.** `tests/test_sticker_trajectory_bleed.py` — **12 passed**, trong đó
`test_sunburst_keeps_divergence` (phân kỳ còn nguyên), `test_trajectory_reach_bounded_by_strip_width`,
`test_trajectory_field_is_continuous`. Không hồi quy: 55 test sticker/bleed/mirror
sẵn có xanh. Số đo trước/sau ở mục 1.

**Effort thực tế:** M (không phải L như BX-01 dự đoán).

## 4. Vì sao "tia mặt trời" là ca khó nhất

Bù xén giữ được nét chỉ khi có mô hình hình học đúng:

- **Mirror** đối xứng gương qua mép — luôn "đúng" về liên tục tại mép nhưng **đảo
  hướng** tia (tia đi vào thay vì ra). Không phải "rộng dần".
- **Nearest/stretch (`image`)** — vuông góc, đúng cho nền trơn/kẻ sọc thẳng, sai cho
  mọi thứ nghiêng/cong.
- **Advection tuyến tính (`inpaint` rectangle hiện tại)** — bám nét **thẳng nghiêng**,
  nhưng không phân kỳ.
- **Trường hướng phân kỳ / radial** (CHƯA có) — mới tái tạo được tia tỏa loe ra.

Do đó BX-01 không phải "bug một dòng" mà là **thiếu một mode**. Đề nghị xem nó là
hạng mục R&D riêng với tiêu chí nghiệm thu bằng ảnh (corpus có sunburst/quạt/xoáy).

## 5. Kế hoạch sửa đề xuất theo lô (chờ duyệt)

### Lô A — Quick-win không đổi kiến trúc (an toàn, làm trước)
- BX-03: nới/bỏ clamp slope (chuyển sang góc) — `sticker_engine.py` (1 file).
- BX-05: thêm test trực tiếp cho `_trajectory_*` để có lưới an toàn TRƯỚC khi động
  vào thuật toán.
- BX-06: mô tả/tooltip mode trong `StickerTool.tsx`.

### Lô B — Cải thiện nguồn màu quỹ đạo (vừa)
- BX-04: lấy nguồn từ dải sâu + nội suy chiều sâu; giữ nét, chống sợi biên.

### Lô C — Mode mới "bù xén trường hướng phân kỳ" (R&D, effort L, tách riêng)
- BX-01/BX-02: trường vector 2D + advection có phân kỳ (edge-tangent flow), hoặc
  detect tâm radial. Nghiệm thu bằng corpus ảnh tỏa. **Chỉ khởi động sau khi bạn
  duyệt vì đây là thay đổi lớn**, phải gate RAM theo quy tắc dự án (máy yếu mới giảm
  chất lượng) và không được làm chậm đường bù xén đơn giản.

## 6. Coverage & proof gap

- **Đã đọc:** `sticker_engine.py` (offset, nearest, inpaint, trajectory, vector,
  phân nhánh mode), `bleed_sides.py`, `page_boxes.py` (mirror), `StickerTool.tsx`
  (UI/payload), danh mục test. Map luồng qua 1 subagent read-only.
- **Chưa đo runtime:** chưa render thử một file sunburst thật để chụp ảnh trước/sau
  (proof gap — cần 1 PDF mẫu có hoa văn tỏa để xác nhận định lượng góc dải bù xén).
  Kết luận BX-01/03 dựa trên đọc toán trong code (confidence cao) chứ chưa có ảnh đo.
- **Ngoài phạm vi:** `trim_shift_engine`, đường mirror vector chi tiết, hiệu năng.

## 7. Chốt duyệt

**Đã sửa + verify (chưa commit):**
- **BX-07** (gốc rễ thật) — `sticker_engine.py`: giới hạn tầm với, làm trơn theo
  amount + chiều dài mép, median filter, trust-weight cho hàng không-valid.
- **BX-05** — `tests/test_sticker_trajectory_bleed.py` mới (12 test).
- **BX-03** — quyết định GIỮ clamp 1.25 (đo cho thấy nới đơn lẻ làm tệ hơn).
- Công cụ đo: `backend/scripts/measure_bleed_trajectory.py` (so trước/sau bằng số).

**Bị bác bỏ:** BX-01 như đã viết ban đầu (thuật toán *có* phân kỳ — chứng minh bằng
probe sunburst). Bài học: đã suy từ đọc toán mà chưa dựng ảnh tỏa để đo; ghi
confidence "cao" là không chính đáng.

**Còn mở:**
- **BX-06** (P3) — mô tả/tooltip mode trong `StickerTool.tsx`, chưa làm.
- **BX-02** (P1) — mode mặc định `image` là kéo giãn vuông góc, không có quỹ đạo. Cần
  quyết định sản phẩm: có nên đổi mặc định sang `inpaint` cho tab Xén vuông, hay chỉ
  làm rõ ở UI.
- **BX-04** (P2) — nguồn màu vẫn chỉ 1 cột mép (`edge = img[:, -1:]`).
- **Proof gap:** chưa render ảnh trước/sau để bạn soi bằng mắt — số đo đã tốt nhưng
  nghiệm thu cuối vẫn cần bạn chạy thử `Binder162.pdf` qua tab Xén vuông + "Làm mượt
  thông minh" và xác nhận nhìn đúng.

Đề nghị bạn **chạy thử trên máy** rồi cho biết kết quả nhìn thế nào, trước khi tôi
làm BX-06/BX-02/BX-04 hoặc commit.
