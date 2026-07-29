# Báo cáo audit bù xén / tạo đường cắt — 2026-07-28

## 1. Phạm vi và kết luận điều hành

Phạm vi audit là luồng **Bế tem nhãn → Tạo đường cắt → Tràn màu → Lấy theo màu
viền tem**, từ giao diện tới PDF đầu ra. Nhánh Xén vuông chỉ được đối chiếu ở biên để
không nhầm hai thuật toán.

Kết luận: quan sát của người dùng là **đúng và đã xác minh**. Kết quả trong ảnh không
phải chỉ “hơi nhạt”; vành bù xén đã đổi từ nền xanh đồng nhất thành nhiều vệt nhạt
hướng tâm. Nguyên nhân chính là engine lấy từng pixel trên một shell rất mỏng ở mép
raster rồi dùng nearest-neighbor kéo pixel gần nhất ra ngoài. Pixel AA/JPEG halo có
màu hơi cyan không bị bộ lọc “gần trắng” loại bỏ, sau đó bị phóng thành các miếng quạt.

Đo trên ảnh output người dùng gửi (tâm xấp xỉ `(356,353)`):

| Vị trí đo | Gần màu xanh nền tem | Pixel nhạt |
|---|---:|---:|
| Bán kính 305 px, ngay trong đường cắt | **100,0%** | 0,0% |
| Bán kính 315 px, trong vành bù xén | **3,0%** | **86,3%** |
| Bán kính 320 px, trong vành bù xén | **2,2%** | **90,0%** |

Đây là chênh lệch đủ lớn để xếp **P0 correctness của đầu ra bù xén** cho ca file này.

Audit cũ về Flatten/PPE đã khoanh rủi ro sticker vào nhánh **Xén vuông + Làm mượt
thông minh**. Phạm vi đó quá hẹp đối với lỗi hiện tại. Ca người dùng đang chạy là
**Bế tem nhãn + `bleed_color_type=image`**, đi thẳng qua PDFium và thuật toán nearest;
không chạm nhánh rectangle/inpaint đã nêu trước đây.

## 2. Đường chạy thật đã trace

```text
StickerTool.tsx:34-38
  chọn “Lấy theo màu viền tem” (`image`)
    → StickerTool.tsx:301-307
      gửi remove_white_bg + bleed_color_type=image + edge_bite_mm=0
        → POST /pdf-tools/sticker-dieline
          → pdf_tools.py:1291,1354-1358,1451-1467
            → StickerEngine.process_pdf()
              → sticker_engine.py:1669 render trang bằng PDFium RGB
              → :1690-1735 tạo silhouette/mask và contour đường cắt
              → :2009-2029 dùng lại mask đó để lấy shell màu mép
              → :2129-2141 nearest-neighbor kéo màu shell ra bleed ring
              → :2179-2277 nhúng vành dưới dạng ảnh ICCBased sRGB + SMask
              → :2234-2362 đặt artwork gốc dạng Form XObject ở lớp trên
                → pdf_tools.py:1534-1537 chỉ chuyển warning nếu engine có tạo warning
                  → StickerTool.tsx:352-354 hiện warning trên UI
```

Đây là code sống. Nhánh nhiều trang gọi `_process_parallel()` rồi mỗi worker quay lại
`StickerEngine.process_pdf()` qua `_process_sticker_chunk()`
(`sticker_engine.py:1372-1422,1531-1538,2700+`), nên vẫn dùng cùng sink tạo màu.

## 3. Phát hiện

### §BX.1 — [VERIFIED] P0 / effort M — Nearest-neighbor biến nhiễu mép thành vệt hướng tâm

**Sink live:** `_build_edge_color_source_mask()` tại
`backend/app/workers/sticker_engine.py:215-285` chọn một shell mép; nhánh `image` tại
`:2129-2141` gọi `_banded_nearest_fill()` (`:681-719`). Hàm dùng
`distance_transform_edt` để mỗi pixel ngoài lấy màu của pixel nguồn gần nhất.

Với đường tròn, miền Voronoi của các pixel chu vi là các dải tỏa từ tâm. Chỉ cần màu
chu vi thay đổi từng pixel do AA/JPEG halo, những thay đổi rất nhỏ đó lập tức thành vệt
dài toàn bộ 3 mm bù xén. Hình người dùng gửi có đúng hình thái này.

**Probe bằng venv dự án:** tạo đĩa xanh có fringe cyan xen kẽ 24 cung, chạy chính
`_build_edge_color_source_mask()` + `_nearest_color_fill()`:

```text
pale_cyan_is_filtered_as_white = False
source_pale_share              = 0.335
outer_ring_pale_share          = 0.536
outer_ring_blue_share          = 0.464
```

Nghĩa là 33,5% pixel nguồn nhạt đã chiếm 53,6% vành ngoài. Đây là cơ chế gây lỗi,
không phải lỗi hiển thị của viewer.

### §BX.2 — [VERIFIED] P1 / effort M — Một mask đang gánh hai mục tiêu xung đột

`remove_white_bg` dựng `base_mask/mask` rất bảo thủ tại
`sticker_engine.py:1690-1735` để không xóa nhầm artwork xám/pastel. Cùng `mask` đó lại
được dùng làm `padded_original_mask` và làm nguồn lấy màu tại `:2009-2029`.

Hai mục tiêu có yêu cầu trái nhau:

- hình học đường cắt phải bảo thủ, giữ cả chi tiết sáng;
- nguồn màu bù xén phải mạnh tay bỏ halo nền/AA và lấy được màu ổn định sâu bên trong.

Ngưỡng `_near_white_mask_rgb()` (`:138-150`) chỉ loại pixel có `max >= 248` và
`chroma <= 18`. Pixel cyan rất sáng `RGB(210,245,250)` có chroma 40 nên vẫn được coi
là màu tem. `peel` cố định 0,08 mm và shell 0,25 mm (`:2022-2023`) không đủ cho halo
dày/nén JPEG, nhưng tăng cố định lại có nguy cơ ăn qua một viền màu thật mỏng.

Vì UI luôn gửi `edge_bite_mm=0` cho Bế tem nhãn (`StickerTool.tsx:307`), người vận hành
không có cách dịch nguồn lấy mẫu vào trong khi auto-sampling thất bại.

### §BX.3 — [VERIFIED] P1 / effort L — “Cùng màu” hiện chỉ là cùng RGB preview, không cùng mực in

Nhánh sticker `image` lấy RGB trực tiếp từ PDFium (`sticker_engine.py:1669`) rồi nhúng
vành bù xén dưới dạng ICCBased sRGB (`:2273-2277`). Artwork gốc vẫn là Form XObject
giữ CMYK/ICCBased/spot (`:2234-2362`). Vì vậy một vùng CMYK hoặc Pantone ở tem và phần
bù xén tương ứng không còn cùng colorant; chúng chỉ có thể trông gần nhau sau một phép
render RGB cụ thể.

Trên RIP khác profile/render intent, CMYK/spot gốc và sRGB sinh thêm có thể tách màu.
PPE chưa được import/call trong `sticker_engine.py`. PPE có hai đường ứng viên nhưng
không thể thay mù:

- `softproof()` cho RGB đã quản lý màu nhưng vẫn không giữ kênh mực;
- `separations()` trả plate process/spot, phù hợp hơn cho mục tiêu cùng mực nhưng cần
  thiết kế cách nhúng bleed CMYK/Separation và xử lý cờ `ink_unsound`.

Đây là lý do phải tạo golden mép trim trước khi đổi renderer, đúng cảnh báo của audit
PPE trước.

### §BX.4 — [VERIFIED] P1 / effort S–M — Test xanh nhưng không có quality oracle

Toàn bộ `backend/tests/test_sticker_engine_e2e.py` hiện đạt **36/36**, nhưng:

- `test_process_pdf_modes_succeed` (`:148`) chỉ kiểm file hợp lệ/không crash;
- `test_sampled_bleed_stays_lossless_icc_rgb` (`:255`) khóa việc nhúng sRGB + Flate,
  không so màu vành với màu viền;
- `test_edge_color_source_uses_rim_not_core` (`:345`) dùng hình chữ nhật hai màu sạch;
- `test_edge_color_source_skips_near_white_aa` (`:381`) chỉ dùng AA gần trắng trung
  tính `RGB(252,250,250)`, không có halo cyan có chroma cao;
- không có fixture tròn/logo nén, không đo ΔE, không đo dải tần màu theo chu vi và
  không có golden PDF→raster cho bù xén.

Engine vẫn trả `success=True`; warning chỉ được tạo khi không dò được đường cắt
(`sticker_engine.py:2593-2627`). Không có cảnh báo khi màu nguồn phân tán mạnh hoặc
vành sinh ra lệch rõ với dải màu ngay trong đường cắt. Trong khi đó UI hứa “Lấy đúng
màu dọc viền tem” (`StickerTool.tsx:35`) nên người dùng nhận tín hiệu thành công sai.

## 4. Không phải nguyên nhân của ca này

- Không phải PPE làm sai: PPE chưa tham gia đường chạy này.
- Không phải JPEG ở PDF output bù xén: vành hiện được nén Flate lossless.
- Không phải đường cắt magenta bị lấy làm nguồn: đường CutContour được vẽ sau lớp bleed
  và artwork; `img_native` được render từ file nguồn trước đó.
- Không phải “Làm mượt thông minh”: ảnh UI cho thấy mode đang chọn là `image`.
- `Bỏ nền trắng` không đồng nghĩa đã khử mọi halo sáng có sắc độ; code hiện cố ý bảo
  thủ để giữ artwork nhạt.

## 5. Đề xuất sửa theo lô — chờ duyệt

### Lô A — khóa bằng chứng, chưa đổi output (≤5 file)

1. Thêm fixture logo tròn xanh có white/cyan halo và fixture CMYK/spot/transparency.
2. Thêm golden PDF→raster cho dải từ 1 mm trong trim tới hết bleed.
3. Thêm quality oracle: ΔE/độ lệch RGB cục bộ giữa bleed và dải mẫu sâu bên trong,
   cộng chỉ số biến thiên cao tần theo chu vi để bắt “nan quạt”.
4. Thêm cảnh báo qua `meta → X-Sticker-Warning → UI` khi nguồn mép có độ phân tán/
   tỷ lệ sáng bất thường. Việc này không thay một byte PDF output.

### Lô B — sửa thuật toán màu (đổi output có chủ đích, cần soi golden)

1. Tách **mask hình học đường cắt** khỏi **mask lấy mẫu màu**.
2. Nguồn màu dùng phép dò thích nghi vào trong: bỏ halo dựa trên màu nền cục bộ và độ
   ổn định nhiều pixel, không dùng một `peel=0,08 mm` cố định.
3. Khử nhiễu màu cao tần dọc chu vi trước khi extrusion, nhưng giữ các đoạn màu có độ
   dài vật lý đủ lớn để không làm mất viền nhiều màu có chủ đích.
4. Khi confidence thấp, fail-loud/đề nghị “Đổ màu trơn” thay vì xuất nearest streaks
   rồi báo thành công.

### Lô C — PPE/màu in (đổi color pipeline, rủi ro cao)

1. Đo cùng fixture bằng PDFium, PPE soft-proof và renderer tham chiếu.
2. Thử tạo bleed theo plate PPE để giữ DeviceCMYK/spot; nếu phải flatten spot thì cảnh
   báo rõ.
3. Chỉ chuyển engine sau khi golden ngoại hình và kiểm cấu trúc color space/spot đều
   được duyệt. Không dùng `softproof RGB` như bằng chứng “giữ nguyên mực”.

## 6. Verify đã thực hiện

| Phép kiểm | Kết quả |
|---|---|
| Trace UI → route → engine → PDF image sink | Đạt |
| Đo pixel trên ảnh người dùng | Sai khác lớn, tái hiện đúng vệt nhạt |
| Probe nearest với halo cyan bằng `backend/venv` | Tái hiện cơ chế khuếch đại halo |
| Full `test_sticker_engine_e2e.py` | **36 passed**, 4 warning |
| Thay đổi code/output production | **Không** |
| Snapshot/golden cập nhật | **Không** |

## 7. Chốt duyệt

Khuyến nghị duyệt **Lô A trước**, sau đó **Lô B** ngay trên fixture tròn giống ca người
dùng. Lô C/PPE là việc riêng vì nó thay hệ màu đầu ra; không nên gộp vào một bản vá
nearest nhỏ.
