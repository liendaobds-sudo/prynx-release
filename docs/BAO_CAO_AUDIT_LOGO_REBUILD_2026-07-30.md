# Báo cáo audit — Phục hồi & Vector hóa Logo, đợt 2026-07-30

**Trạng thái:** CHỜ DUYỆT TRƯỚC KHI SỬA
**Phạm vi audit:** độ chính xác **đường nét** và **màu sắc** cho ca dùng chính đã được chủ dự án chốt:
*"đầu vào chủ yếu là file logo đã bị chuyển thành hình ảnh, cần tái tạo lại thành vector"*.
**Ngoài phạm vi (chủ dự án loại bỏ):** logo chụp trên áo, vải nhăn, ảnh chụp có phối cảnh lệch.
**Tài liệu liên quan:** `BAO_CAO_AUDIT_LOGO_REBUILD_CHAT_LUONG_2026-07-29.md` (5 phát hiện §LR.01–05),
`LOGO_REBUILD_FIXES_2026-07-29.md` (Lô 1 đã xong, tính năng đang HOLD).

---

## 1. Tóm tắt điều hành

Engine **đủ tốt cho phạm vi này**. Đo trên bộ ground-truth tự dựng (8 logo SVG → rasterize →
vector hóa → so lại với SVG gốc), khi palette đúng thì **ΔE00 = 0,00** ở mọi logo, mọi độ phân giải,
và boundary F-score ngặt 2px đạt **0,995**. Nói cách khác: engine trả lại *đúng* màu được cấp và
*gần đúng tuyệt đối* đường nét, miễn là được cấu hình đúng.

Vấn đề nằm ở **cấu hình mặc định của sản phẩm**, không ở engine. Ba mặc định hiện tại đều sai
hướng cho ca "tái tạo logo":

| Mặc định hiện tại | Hệ quả đo được |
|---|---|
| mode = `monochrome` | Vứt bỏ toàn bộ màu: ΔE50 = 26–44. Khối vàng `#f9a825` **biến mất hoàn toàn** (bF 0,757, IoU 0,749) vì nằm trên ngưỡng nhị phân 128 |
| `smoothing` = 1,0 khi chọn màu | Giảm độ chính xác nét ở mọi độ phân giải; ở 300px bF2 tụt 0,917 → 0,840 |
| Không có bước nâng độ phân giải | Ảnh 300px mất nét (bF2 0,917) trong khi upscale 4× nearest kéo lại 0,990 |

Đây là tin tốt: cả ba đều là **thay đổi tham số**, không phải viết lại thuật toán.

Hai điều chỉnh so với các kết luận trước của chính tôi trong phiên này, đã bị số đo bác bỏ —
ghi lại để không ai đi lại đường cũ:

1. **"Gợi ý màu k-means làm tệ hơn"** — SAI trong phạm vi này. Kết luận đó đo trên *ảnh chụp áo*.
   Trên artwork phẳng, k-means **ngang bằng palette do người dùng nhập tay**: bF2 0,995 cả hai,
   ΔE50 0,32 so với 0,00, số node y hệt (59). §LR.03 vì vậy đổi từ "gợi ý cần xác nhận" thành
   **đường mặc định khả thi** cho ca này.
2. **"Bật `binary_adaptive` giảm 92× pixel nền nhận sai"** — con số đó từ fixture synthetic
   (gradient mượt). Trên ảnh thật nó nằm trong nhiễu. Với phạm vi mới (không còn ảnh chụp),
   `binary_adaptive` **rơi khỏi danh sách ưu tiên** — nhánh nhị phân không còn là đường chính.

---

## 2. Phương pháp đo

Vòng đo mô phỏng đúng ca dùng: **SVG gốc → rasterize → (mô phỏng suy giảm) → đường sản phẩm →
SVG kết quả → rasterize lại cùng khung 1024px → so với gốc.** Vì SVG gốc do harness tự dựng
nên ground truth là *chính xác*, không phải nhãn tay.

- **8 logo ground-truth** (`backend/scratch/main_check/gt_logos.py`), mỗi hình đối đầu một điểm yếu
  đã biết: vòng khuyên có lỗ, sao 5 cánh (góc nhọn), hình L (góc vuông), nét mảnh 3–12px,
  khối nhỏ mô phỏng chữ, 4 màu phẳng kề nhau, đường cong mượt, vòng đồng tâm.
- **4 mức đầu vào**: PNG 1200/600/300px và JPEG 600px q75.
- **Chỉ số dùng lại `tools/logo_rebuild_spike/metrics.py`** để so được với baseline spike cũ:
  boundary F-score, ΔE00 trên **vùng mực** (không toàn khung), IoU, số node.
- Thêm **bF ngặt 2px** cạnh bF chuẩn spike (0,75% đường chéo ≈ 11px). Lý do: ở 11px, tolerance
  *hấp thụ hết* việc bo góc — bF11 bão hòa 1,000 ở gần như mọi ca nên không phân biệt được gì.
  Mọi kết luận về nét trong báo cáo này dựa trên **bF2**.

Hai lỗi harness đã bắt và sửa trong lúc đo (ghi lại vì mỗi lỗi từng cho kết luận sai):

1. **Truyền chiều rộng ảnh làm tolerance bF** → bF = 1,000 mọi ca. Sửa: tolerance = 0,75% đường chéo.
2. **`convert("RGB")` trên SVG không nền** → pixel trong suốt thành ĐEN, mặt nạ mực bị đảo,
   bF = 0,000 đồng loạt và IoU/ΔE giống hệt nhau ở mọi độ phân giải. Sửa: ghép nền trắng
   (`flatten_white`) trước khi đo — cũng đúng với thực tế in trên giấy trắng.

Một chỉ số tôi **đã loại bỏ**: "precision vết mực" tự viết cho bộ ảnh thật cho kết quả 1,00 trên
cả 15 ảnh với 0 pixel sai — bão hòa do mặt nạ phủ 49,6% khung. Không dùng, không đưa vào kết luận.

---

## 3. Bảng phát hiện

| Mã | Mức | Effort | Kết luận |
|---|---|---:|---|
| §LG.01 | P0 | S | Mặc định `monochrome` vứt bỏ màu và **làm mất hẳn** vùng màu sáng (khối vàng biến mất: bF2 0,751, IoU 0,749) |
| §LG.02 | P1 | S | `smoothing` mặc định 1,0 cho chế độ màu làm **giảm độ chính xác nét** ở mọi độ phân giải |
| §LG.03 | P1 | M | Không có bước nâng độ phân giải trước khi trace; ảnh ≤300px mất nét mà lẽ ra cứu được |
| §LG.04 | P1 | M | §LR.03 (gợi ý màu) — đo lại cho thấy k-means **ngang palette tay** trên artwork phẳng, nên làm được ngay |
| §LG.05 | P1 | S | Ảnh CMYK có ICC bị sai màu ΔE76 12–71 do áp ICC **sau** khi đã convert sang RGB |
| §LG.06 | P2 | S | SVG xuất ra không có `viewBox` và không mang đơn vị vật lý; DPI đọc ở preflight nhưng không dùng |
| §LG.07 | P2 | S | Chỉ nhận PNG/JPEG/WebP; file `.avif` trong bộ test bị từ chối thẳng ở route |
| §LG.08 | P3 | M | SVG là điểm cuối: không có đường đưa kết quả trở lại dieline/imposition trong PrynX |

## 4. Phát hiện chi tiết

### §LG.01 — P0: mặc định monochrome làm mất vùng màu sáng

**Bằng chứng.** UI khởi tạo `mode: 'monochrome'`
([LogoRebuildWorkspace.tsx:46](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L46)).
Nhánh này đặt `Clustering::Binary`
([logo_vectorizer.rs:110](../native/src/logo_vectorizer.rs#L110)), và crate mặc định
`binary_threshold: 128`, `binary_adaptive: false` (`vtracer-1.0.0-alpha.2/src/config.rs:138-141`).

Đo trên logo `four_colors` (4 khối phẳng đỏ/xanh/lục/vàng), trung bình 4 mức đầu vào:

| Cấu hình | bF11 | bF2 | IoU | ΔE50 | node |
|---|---|---|---|---|---|
| mặc định mono | 0,757 | 0,751 | 0,749 | 39,70 | 6 |
| palette đúng | **1,000** | **0,988** | **0,998** | **0,00** | 44 |

Khối vàng `#f9a825` có độ sáng trên 128 nên bị xếp vào nền và **biến mất khỏi SVG**. Đây không
phải "màu hơi lệch" mà là **mất một phần logo**. Toàn bộ nhóm logo màu ở chế độ mono có ΔE50 26–44.

**Hướng sửa.** Đổi mặc định sang `fixed_palette`. Giữ `monochrome` như lựa chọn cho logo 1 màu thật.

**Tiêu chí đạt.** `four_colors` ở mặc định mới: bF2 ≥ 0,95, IoU ≥ 0,99, ΔE50 ≤ 3,0; không vùng nào mất.

### §LG.02 — P1: smoothing mặc định 1,0 giảm độ chính xác nét

**Bằng chứng.** Schema đặt `smoothing = 1.0` khi `mode == "fixed_palette"`
([logo_rebuild.py:64](../backend/app/schemas/logo_rebuild.py#L64)); UI cũng đặt 1 khi bấm chế độ màu
([LogoRebuildWorkspace.tsx:500](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L500)).
Giá trị này map sang `config.simplify` ([logo_vectorizer.rs:100](../native/src/logo_vectorizer.rs#L100)).

Đo bF2 (trung bình 8 logo) theo độ phân giải đầu vào:

| Đầu vào | smoothing 1,0 | smoothing 0,0 | chênh |
|---|---|---|---|
| PNG 1200px | 1,000 | 1,000 | 0 |
| PNG 600px | 0,991 | **0,995** | +0,004 |
| JPEG 600px q75 | 0,992 | **0,997** | +0,005 |
| PNG 300px | 0,840 | **0,917** | **+0,077** |

Theo từng logo, chênh lệch tập trung đúng vào hình có cong và góc: `ring_hole` 0,911 → **0,985**,
`sharp_star` 0,896 → **0,944**, `concentric` 0,921 → **0,948**, `smooth_curve` 0,947 → **0,969**.

**Đánh đổi thật, phải nêu rõ:** `smoothing=0` làm **tăng số node** (ví dụ `ring_hole` 163 → 315,
`sharp_star` 152 → 352). Với mục tiêu "càng chính xác càng tốt" thì đánh đổi này đúng hướng, nhưng
nếu ưu tiên file gọn để chỉnh tay thì cần một nút chọn thay vì đổi cứng mặc định.

**Hướng sửa.** Hạ mặc định `smoothing` cho chế độ màu từ 1,0 xuống 0,0–0,2, và nói rõ trong UI rằng
thanh này đánh đổi *độ mượt* với *độ trung thực nét*.

**Tiêu chí đạt.** bF2 trung bình ≥ 0,99 ở đầu vào ≥600px; không ca nào tụt so với mặc định cũ.

### §LG.03 — P1: thiếu bước nâng độ phân giải trước khi trace

**Bằng chứng.** `prepare_logo_image` chỉ *giảm* kích thước khi RAM thiếu
([logo_rebuild.py:281-284](../backend/app/workers/logo_rebuild.py#L281-L284)); không có đường nào
nâng ảnh nhỏ lên trước khi trace. Trong bộ ảnh thật của chủ dự án, **6/15 file dưới 512px** —
chính route đã cảnh báo "độ phân giải thấp" ([logo_rebuild.py:109-110](../backend/app/api/routes/logo_rebuild.py#L109-L110))
nhưng không làm gì để bù.

Đo trên đầu vào 300px, palette đúng, smoothing 0 (trung bình 8 logo):

| Xử lý trước khi trace | bF2 | IoU | node |
|---|---|---|---|
| 300px nguyên | 0,917 | 0,955 | 57 |
| upscale 2× LANCZOS | 0,965 | 0,970 | 397 |
| upscale 4× LANCZOS | 0,986 | 0,971 | 3.197 |
| **upscale 4× NEAREST** | **0,990** | 0,959 | **1.108** |

Điểm đáng chú ý: **NEAREST tốt hơn LANCZOS** cả về nét (0,990 vs 0,986) *và* gọn hơn 3× về node
(1.108 vs 3.197). Lý do: NEAREST giữ biên pixel cứng, còn LANCZOS tạo viền chuyển màu mượt khiến
tracer sinh thêm path để mô tả vùng nhòe đó. Ca cải thiện mạnh nhất là `sharp_star`
(0,778 → 0,979) và `concentric` (0,808 → 0,988).

**Hướng sửa.** Nếu cạnh ngắn < 600px thì nâng bằng NEAREST lên khoảng 1200px trước khi trace.
Phải gate theo RAM đúng quy tắc dự án (chỉ máy <16GB mới hạ mục tiêu), không hard-cap vô điều kiện.

**Tiêu chí đạt.** Ảnh 300px đạt bF2 ≥ 0,98; số node không vượt 3× so với cùng logo ở 600px.

### §LG.04 — P1: gợi ý màu (§LR.03) — đo lại, khả thi ngay

**Bằng chứng.** Palette đang hardcode `['#000000', '#ffffff']`
([LogoRebuildWorkspace.tsx:36](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L36)),
người dùng phải tự nhập đúng mã `#RRGGBB` — không có eyedropper, không có gợi ý.

Đo k-means (k = số màu + 1) so với palette đúng, artwork phẳng, PNG 600px, trung bình 8 logo:

| Palette | bF11 | bF2 | IoU | ΔE50 | node |
|---|---|---|---|---|---|
| đúng (người dùng biết) | 1,000 | 0,995 | 0,980 | 0,00 | 59 |
| **k-means gợi ý** | 1,000 | **0,995** | 0,980 | **0,32** | 59 |

Hình học **y hệt**, số node **y hệt**, sai màu 0,32 — dưới ngưỡng ΔE ≤ 3,0 của dự án cả chục lần.
Sai lệch chỉ xuất hiện ở logo có nét mảnh/chữ nhỏ (`thin_strokes` 1,32; `small_text` 1,03) do
anti-alias trộn màu, vẫn trong ngưỡng.

**Điều này bác kết luận trước của tôi trong cùng phiên** ("gợi ý màu làm tệ hơn"), vì kết luận đó
đo trên ảnh chụp áo — nơi palette lấy từ pixel mô tả *vân vải* chứ không mô tả *màu thiết kế*.
Trong phạm vi đã chốt (artwork phẳng), k-means là đường dùng được.

**Hướng sửa.** Chạy k-means ở `/preflight`, trả palette + tỷ lệ phủ, điền sẵn vào UI cho người dùng
sửa. Vẫn **không** gọi là "màu in gốc" hay auto-color: đây là gợi ý theo pixel nhìn thấy.

**Tiêu chí đạt.** Fixture 4 màu phẳng: k-means trả đủ 4 màu với ΔE ≤ 3,0 so với màu gốc;
pixel trong suốt không lọt vào palette; người dùng vẫn phải bấm Áp dụng.

### §LG.05 — P1: ảnh CMYK có ICC bị sai màu

**Bằng chứng.** `_convert_to_srgb` gọi `image.convert("RGB")` ở
[dòng 179](../backend/app/workers/logo_rebuild.py#L179) **trước** khi áp ICC ở
[dòng 185](../backend/app/workers/logo_rebuild.py#L185). Với ảnh CMYK,
`profileToProfile(rgb_input, cmyk_source_profile, sRGB)` raise `PyCMSError: cannot build transform`
(đã tái hiện), bị bắt ở [dòng 191](../backend/app/workers/logo_rebuild.py#L191) → chỉ thêm cảnh báo,
giữ nguyên kết quả convert naive.

Đo với profile SWOP thật của Windows:

| Ca CMYK | naive convert | ICC đúng | ΔE76 |
|---|---|---|---|
| đỏ 100M100Y | (255,0,0) | (237,28,36) | 17,6 |
| xanh 100C100M | (0,0,255) | (46,48,146) | **71,5** |
| đen 100K | (0,0,0) | (35,31,32) | 12,3 |
| cam 60M100Y | (255,102,0) | (245,130,31) | 17,4 |

Route còn cảnh báo "Ảnh CMYK sẽ được chuyển về sRGB"
([logo_rebuild.py:113-114](../backend/app/api/routes/logo_rebuild.py#L113-L114)) nên người dùng
tin bước này hoạt động.

**Lưu ý phạm vi:** 16 ảnh thật của chủ dự án đều là RGB nên lỗi này **chưa phải** thủ phạm ca hiện tại.
Nhưng file logo nhà in nhận từ khách rất thường là CMYK, nên vẫn để P1.

**Hướng sửa.** Dựng transform trực tiếp từ profile nguồn sang sRGB trên ảnh **gốc** (chưa convert),
dùng rendering intent relative colorimetric cho logo. Nếu không dựng được transform thì cảnh báo
nói rõ "màu có thể sai" thay vì im lặng.

**Tiêu chí đạt.** Fixture CMYK+SWOP: ΔE00 ≤ 3,0 so với đường ICC đúng; ảnh không ICC giữ nguyên hành vi.

### §LG.06 — P2: SVG không có viewBox, không mang kích thước vật lý

**Bằng chứng.** Crate chỉ ghi `width`/`height` dạng số pixel trần
(`vtracer-1.0.0-alpha.2/src/svg.rs:55-56`), không có `viewBox`. Đo trực tiếp đường sản phẩm:

```
<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="200" height="120">
```

`viewBox` không có; worker không thêm. DPI được đọc ở preflight
([logo_rebuild.py:59-68, 103](../backend/app/api/routes/logo_rebuild.py#L59-L68)) nhưng không đi vào SVG.

Hệ quả: logo scan 300 DPI và 72 DPI ra kích thước vật lý khác nhau mà không sửa được trong file;
SVG vào Illustrator/CorelDRAW không scale theo khổ. Với nghề in đây là bất tiện thật.

Liên quan: mask khoét lỗ dựng rect từ `root.attrib.get("width", "100%")`
([logo_rebuild.py:357](../backend/app/workers/logo_rebuild.py#L357)) — hiện chạy đúng vì crate ghi
số trần, nhưng phụ thuộc vào chi tiết đó và sẽ vỡ nếu crate đổi sang ghi kèm đơn vị.

**Hướng sửa.** Thêm `viewBox="0 0 w h"`, và khi biết DPI thì ghi `width`/`height` theo mm.
Dựng mask rect từ `viewBox` thay vì từ attribute `width`.

**Tiêu chí đạt.** SVG mở trong Illustrator ra đúng kích thước mm mong đợi; mask khoét lỗ vẫn đúng.

### §LG.07 — P2: chỉ nhận PNG/JPEG/WebP

**Bằng chứng.** `_ALLOWED_EXTENSIONS` chặn ở
[logo_rebuild.py:131-132](../backend/app/api/routes/logo_rebuild.py#L131-L132). File `1.avif`
trong `test/logo test/` bị từ chối ngay, không tới engine. File logo nhà in còn thường là
TIFF/BMP, và PDF/AI/EPS (những cái này là vector sẵn nên nên đi đường khác, không qua vector hóa).

**Hướng sửa.** Mở thêm TIFF/BMP (Pillow đọc được sẵn). AVIF cần plugin nên cân nhắc riêng.
Với PDF/AI/EPS: phát hiện và nói rõ "file này đã là vector, không cần tái tạo".

### §LG.08 — P3: SVG là điểm cuối trong PrynX

Kết quả chỉ tải xuống được ([LogoRebuildWorkspace.tsx:409-416](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L409-L416)).
Tìm `importSvg|loadSvg|svgToPath|parseSvg` trong `desktop/src/lib/dieline` và `desktop/src/lib`:
không có kết quả. Thợ phải qua Illustrator rồi quay lại PrynX. Ghi nhận, chưa đề xuất sửa trong đợt này.

---

## 5. Giả thuyết đã BỊ BÁC bằng số đo

Ghi lại để không ai tốn công đi lại. Mỗi dòng đều đã đo, không phải suy từ đọc code.

| Giả thuyết | Kết quả | Bằng chứng |
|---|---|---|
| `despeckle_size_px` lệch đơn vị (diện tích vs cạnh) | **BÁC** | `config.rs:207-209` bình phương giá trị thành diện tích; doc dòng 78 ghi "given as a side length". Tên hiện tại ĐÚNG |
| `fixed_palette` + PNG nền trong suốt đọc nhầm RGB ẩn | **BÁC** | Đo 4 tổ hợp (RGB ẩn đen/trắng × logo 25%/90%): đều 1 path, đúng màu. Nhánh màu CÓ keying (`color_cluster.rs:61-68`). Thêm 4 ca biên alpha thưa: cũng đúng |
| Heuristic loại nền phụ thuộc thứ tự vẽ nên dễ sai | **BÁC** ở ca thường | Khối đặc: bỏ nền còn đúng 1 path. Vòng khuyên có lỗ: removed=2, dựng mask `prynx-background-cutout`, giữ lỗ. So màu hoa/thường hoạt động đúng |
| Nên đổi `Hierarchical::Stacked` sang `Cutout` cho in | **BÁC** | `config.rs:36-37`: Cutout "not yet implemented (separate milestone)". Stacked là lựa chọn duy nhất |
| Thiếu license guard trên route | **BÁC** | `routes/logo_rebuild.py:39` gắn `Depends(require_feature("util.logo_rebuild"))` ở cấp router; `main.py:218` include đúng |
| Bật `binary_adaptive` cứu được ca người dùng | **BÁC trong phạm vi mới** | Trên ảnh thật: 29 path/1.093 node vs 32 path/985 node của mặc định — trong nhiễu. Con số "92×" trước đó từ fixture synthetic. Với phạm vi không còn ảnh chụp, nhánh nhị phân không còn là đường chính |
| Gợi ý màu k-means làm chất lượng tệ hơn | **BÁC trong phạm vi mới** | Xem §LG.04: trên artwork phẳng, k-means ngang palette tay (bF2 0,995 cả hai) |

### Về §LR.04 (FitMode::Polygon) — hạ ưu tiên, không bỏ

Audit 2026-07-29 mở §LR.04: native hardcode `FitMode::Spline`
([logo_vectorizer.rs:99](../native/src/logo_vectorizer.rs#L99)), nên "độ mượt 0 vẫn không giữ được góc sắc".
Điều đó đúng về mặt hợp đồng. Nhưng đo ở mức raster: logo `right_angles` (toàn góc vuông 90°) đạt
**bF2 = 1,000 và IoU 0,992 ngay với Spline**, chỉ 10 node cho hình 6 đỉnh.

Nghĩa là Spline *không* làm sai hình ở mức nhìn thấy được; nó chỉ mô tả đoạn thẳng bằng cubic gần-phẳng.
Giá trị thật của Polygon là **dễ chỉnh tay** (đoạn thẳng thật thay vì cubic), không phải độ chính xác.
Vì phạm vi bạn chốt là "chính xác nét và màu", tôi **hạ §LR.04 xuống sau** §LG.01–04 —
nó cần rebuild native mà không đổi được con số chính xác.

---

## 6. Trần chất lượng đo được

Để biết "tốt nhất có thể" là bao nhiêu, đây là số ở cấu hình tốt nhất tìm được
(fixed_palette + palette đúng + smoothing 0), trung bình 8 logo:

| Đầu vào | bF11 | bF2 | IoU | ΔE50 | node |
|---|---|---|---|---|---|
| PNG 1200px | 1,000 | **1,000** | 0,980 | **0,00** | 142 |
| PNG 600px | 1,000 | 0,995 | 0,980 | **0,00** | 59 |
| JPEG 600px q75 | 1,000 | 0,997 | 0,980 | **0,00** | 553 |
| PNG 300px | 1,000 | 0,917 | 0,955 | **0,00** | 57 |
| PNG 300px + upscale 4× NEAREST | 1,000 | **0,990** | 0,959 | **0,00** | 1.108 |

Ba điều rút ra:

1. **Màu là bài toán đã giải.** ΔE50 = 0,00 ở mọi mức. Engine trả đúng màu được cấp. Không cần
   nghiên cứu thêm về màu — chỉ cần *cấp đúng palette*, và §LG.04 cho thấy k-means làm được việc đó.
2. **Độ phân giải đầu vào là biến quyết định về nét**, không phải nén JPEG. JPEG 600px q75 (bF2 0,997)
   *ngang* PNG 600px (0,995). Nhưng 300px tụt xuống 0,917. Về độ chính xác nét: ảnh nhỏ đáng lo,
   nén JPEG không.

   **Nhưng nén JPEG hại độ gọn của file:** cùng bF2 tương đương, JPEG 600px sinh **553 node**
   so với **59 node** của PNG 600px — gấp **9×**. Nhiễu nén tạo thêm path mô tả vùng lẫn màu ở biên.
   Nghĩa là với file JPEG, kết quả *đúng hình* nhưng *khó chỉnh tay hơn nhiều*. Nếu khách gửi JPEG,
   nên khử nhiễu nhẹ trước khi trace hoặc nâng `despeckle` — cần đo thêm, chưa nằm trong 5 lô.
3. **Upscale bù được gần hết** phần mất do ảnh nhỏ (0,917 → 0,990), với chi phí node cao hơn.

## 7. Thứ tự sửa đề xuất

Xếp theo *đòn bẩy trên mỗi đơn vị rủi ro*. Mỗi lô ≤5 file, verify xong mới sang lô kế
(theo `prynx-audit-workflow`).

### Lô 1 — Mặc định backend + schema (3 file, không cần rebuild native)

- `backend/app/schemas/logo_rebuild.py`: hạ mặc định `smoothing` cho `fixed_palette` (§LG.02);
  giữ alias cũ để project đã tạo không gãy.
- `backend/app/workers/logo_rebuild.py`: sửa thứ tự ICC (§LG.05); thêm `viewBox` + kích thước
  vật lý theo DPI (§LG.06); thêm upscale NEAREST khi ảnh nhỏ, gate theo RAM (§LG.03).
- `backend/tests/test_logo_rebuild.py`: test hồi quy cho cả ba.
- Verify: `py_compile` + `pytest backend/tests/test_logo_rebuild.py` + chạy lại
  `backend/scratch/main_check/gt_bench.py`, đối chiếu bảng §6 (bF2 không được tụt ở bất kỳ ca nào).

### Lô 2 — Gợi ý màu backend (3 file)

- Schema response cho palette gợi ý; bộ trích màu trong worker; route `/preflight` trả palette.
- pytest: fixture 4 màu phẳng, ảnh alpha, ảnh nhiễu, giới hạn 12 màu.
- Verify: pytest + đối chiếu §LG.04 (ΔE ≤ 3,0 so với màu gốc).

### Lô 3 — Frontend: mặc định mode + palette gợi ý + nhãn độ mượt (3 file)

- Đổi mặc định UI sang chế độ màu (§LG.01); hiển thị palette gợi ý cho người dùng Áp dụng;
  đổi nhãn thanh "Độ mượt" để nói rõ đánh đổi mượt ↔ trung thực nét.
- Verify: `npm run typecheck` + vitest workspace + thử runtime Tauri thật.

### Lô 4 — Mở rộng định dạng đầu vào (2 file)

- TIFF/BMP (§LG.07); phát hiện PDF/AI/EPS và nói rõ "đã là vector".

### Lô 5 — §LR.04 FitMode::Polygon (cần maturin rebuild)

- Chỉ làm sau khi Lô 1–3 đã qua runtime thật. Giá trị là dễ chỉnh tay, không phải độ chính xác (xem §5).

## 8. Cổng dừng và rủi ro

- **Không đổi golden/corpus để làm đẹp số.** Mọi so sánh phải chạy lại `gt_bench.py` trên cùng 8 logo,
  cùng 4 mức đầu vào.
- **Mức bằng chứng hiện tại: Mức 2 — tự động.** Toàn bộ số trong báo cáo này là ground-truth synthetic
  do harness tự dựng. Chưa có ca nào chạy xuyên UI Tauri thật, và chưa có file logo gốc *kèm vector gốc*
  của khách để so. Cần bổ sung trước khi tuyên bố đạt.
- **Tính năng đang HOLD** (`LOGO_REBUILD_ENABLED = false`,
  [preprocessRouterTools.ts:21](../desktop/src/components/imposition-tools/sections/preprocessRouterTools.ts#L21)).
  Chỉ bật lại sau khi Lô 1–3 qua verify và chủ dự án thử runtime đạt.
- **Đánh đổi node đã nêu ở §LG.02 và §LG.03**: cấu hình chính xác nhất cũng là cấu hình nhiều node nhất.
  Nếu chủ dự án ưu tiên file gọn hơn độ trung thực tuyệt đối thì phải chốt lại mặc định trước khi sửa.
- **Ngoài phạm vi, không tiện tay sửa:** ảnh chụp áo/vải nhăn. Số đo cho thấy nhóm này chỉ đạt
  2/7 ca dưới ngưỡng 1.500 node so với 6/8 của artwork phẳng — muốn làm phải có bước tách logo
  khỏi ảnh, lớn hơn nhiều so với 5 lô trên.

## 9. Phụ lục — script đo

Toàn bộ trong `backend/scratch/main_check/` (không phải mã sản phẩm, đã gitignore):

| File | Việc |
|---|---|
| `gt_logos.py` | 8 logo SVG ground-truth |
| `gt_bench.py` | vòng đo chính: GT → raster → sản phẩm → so lại |
| `gt_palette_upscale.py` | k-means vs palette tay; quét upscale |
| `real_run.py`, `flat_art.py` | đo trên 16 ảnh thật, tách nhóm phẳng/chụp |
| `icc_delta.py` | đo ΔE của lỗi thứ tự ICC với profile SWOP |
| `thresh.py`, `thresh2.py` | đo ngưỡng nhị phân cố định vs adaptive |
| `nodes2.py`, `nodes3.py` | đo bung node theo nhiễu và quét despeckle |
| `bg_order.py`, `alpha_color.py`, `alpha_edge.py` | các ca bác giả thuyết |
| `ket_qua_do_chinh.md` | số đo thô đợt đầu |

Chạy lại: `cd backend && ./venv/Scripts/python.exe scratch/main_check/gt_bench.py`
