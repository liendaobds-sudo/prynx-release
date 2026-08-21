# BÁO CÁO AUDIT MÀU VÀ HIỆU ỨNG SAU BÙ XÉN

**Ngày:** 2026-08-19
**Audit unit:** `W2-U03-COLOR` — Bù xén → PDF kết quả → Viewer PPE/PDFium
**Baseline mã:** `8dd6006a91d89fbe0fb4df5c392530b0cb7d9335` (`1.0.0-rc.7`)
**Trạng thái:** `LÔ A + LÔ B ĐÃ SỬA + VERIFIED`

## 1. Kết luận điều hành

Lỗi người dùng thấy gồm **hai lỗi độc lập chồng lên nhau**:

1. **PDF kết quả bị sai màu thật ở dải sát mép:** chế độ `Xén vuông góc + Theo quỹ đạo dải màu` render artwork bằng PDFium thành RGB, nhúng phần bù xén dưới dạng ảnh `ICCBased sRGB`, trong khi artwork gốc vẫn là `DeviceN/Separation/DeviceCMYK`. Với `Độ lẹm mép = 1 mm`, engine còn clip bỏ khoảng `0,93 mm` artwork gốc ở bốn cạnh và thay dải đó bằng RGB. Đây là lỗi artifact, có thể hiện ra khác nhau trên RIP/profile khác nhau.
2. **Toàn trang đổi màu trong Viewer:** trang gốc là PDF CMYK/DeviceN/transparency rủi ro cao nên được dựng bằng PPE. Khi PPE trả `PPE_NATIVE_UNSUPPORTED: geometry_approximation`, UI tự tắt chế độ màu chính xác và chuyển toàn trang sang PDFium. Trên đúng file này, PPE và PDFium lệch màu rất lớn; PDFium làm lộ rõ vòng cung/transparency mà PPE dựng mượt. Vì vậy người dùng thấy cả trang đổi màu dù vùng giữa artwork trong PDF kết quả vẫn là vector gốc.

Không có bằng chứng cho giả thuyết “ảnh bù xén đang phủ kín toàn trang”. SMask của ảnh bù xén bằng 0 ở toàn bộ vùng giữa; cùng một renderer cho thấy vùng giữa trước/sau gần như trùng tuyệt đối.

## 2. Phạm vi và dữ liệu tái hiện

### 2.1 File khách

| File | SHA-256 | Ghi chú |
|---|---|---|
| `CMNM2026 - Giay moi_BLUE - in_OUTLINE_FONTS_5e2846.pdf` | `E657EAB1A222CA11CCBE01554F663405251BFB0952FB79EEE5083F9C0CE06DD1` | File người dùng yêu cầu test, trang 1 |
| `CMNM2026 - Giay moi_BLUE - in.pdf` | `95F38CF429FE7DD7C6500043CE308FD2E87E80A2290217D428FE0C68C6098184` | Tên khớp log `autobleed_...in.pdf` người dùng gửi |

Hai file đều có khổ trang 1 là `748,346 × 561,260 pt` (`264 × 198 mm`). File nguồn không có `OutputIntent`; trang chứa `DeviceN`, hai màu spot (`VietinBank Dark Blue`, `VTB RED`), ảnh `DeviceCMYK`, transparency group, soft mask và blend mode `/Overlay`, `/SoftLight`.

### 2.2 Thiết lập tái hiện

- Trang: `1`
- Loại: `Xén vuông góc`
- Bù xén: `2 mm`
- Độ lẹm mép: `1 mm`
- Cạnh: cả bốn cạnh
- Màu nền bù xén: `Theo quỹ đạo dải màu`
- DPI engine: `300`

Artifact chính:

- `AUDIT_CMNM2026_HEAD_RECT_TRAJECTORY.pdf`
- SHA-256 `2E9412B5EB46E87293406DE3A1494F1F872CEE12003C402C260F681F6BB21D5C`
- Kích thước `18.372.739 byte`

Artifact đối chứng vector `Lấy theo màu viền tem`:

- `AUDIT_CMNM2026_HEAD_RECT_IMAGE.pdf`
- SHA-256 `75B66D3B3D385662BBAA96A92EDD91786A5BF096C8D7D53367EA000DE91001D9`

## 3. Luồng dọc đã truy vết

1. UI dựng một payload chung trong `desktop/src/components/preprocess-tools/stickerToolPolicy.ts:176`.
2. Với `rectangle`, UI gửi `cut_mode=none`, `rectangle_mode=true`; `edge_bite_mm` chỉ còn hiệu lực cho `image/trajectory/inpaint` tại `stickerToolPolicy.ts:96-105` và được đưa vào payload tại `:206-210`.
3. `StickerTool.tsx:481-520` gửi payload tới `POST /pdf-tools/sticker-dieline`.
4. Route đọc `bleed_color_type`, `rectangle_mode`, `edge_bite_mm` tại `backend/app/api/routes/pdf_tools.py:1458-1554`, rồi truyền nguyên hợp đồng xuống `StickerEngine` tại `:1657-1666`.
5. `StickerEngine` chỉ dùng bleed vector khi `rectangle_mode && bleed_color_type == "image"` tại `backend/app/workers/sticker_engine.py:7901-7903`.
6. `trajectory/inpaint` render trang bằng PDFium, tạo một ảnh raster RGB có SMask, nén Flate và gắn ICC sRGB tại `sticker_engine.py:9288-9318` và `:9367-9397`.
7. Artwork gốc được giữ trong Form XObject tại `sticker_engine.py:9333-9338`, nhưng nhánh rectangle raster clip bỏ dải `edge_bite_px / scale` tại `:9465-9486`.
8. Viewer đánh dấu PDF có CMYK/DeviceN/spot/transparency là rủi ro cao tại `desktop/src-tauri/src/pdf_color_risk.rs:259-289`, tự bật PPE tại `desktop/src/components/AcrobatViewer.tsx:386-396`.
9. PPE từ chối frame `color-verified` khi có `geometry_approximate` tại `desktop/src-tauri/src/pdf_engine/render_worker.rs:1359-1364`.
10. `useTileRenderer` ghi log “refusing display fallback” tại `desktop/src/hooks/viewer/useTileRenderer.ts:620-629`, nhưng `AcrobatViewer` sau đó tự tắt accurate color cho đúng lỗi này tại `AcrobatViewer.tsx:461-468`; policy tiếp theo cho phép lớp PDFium display tại `LivePageFrame.tsx:375-386`.

## 4. Bằng chứng artifact

### 4.1 Artwork giữa trang không bị raster hóa hoặc phủ RGB

PDF kết quả trang 1 có đúng hai XObject cấp trang:

- Một `/Form`: artwork nguồn giữ nguyên resources `DeviceN/Separation/DeviceCMYK`.
- Một `/Image`: `3171 × 2391`, `/ColorSpace [/ICCBased ... N 3]`, có `/SMask`.

SMask đo được:

| Vùng | Số pixel alpha khác 0 |
|---|---:|
| Toàn ảnh bù xén | `425.047` |
| Nằm trong hình chữ nhật artwork gốc | `152.040` |
| Dải mép được lẹm | `152.040` |
| Vùng giữa, sâu hơn dải lẹm | **`0`** |
| Ngoài artwork gốc | `273.007` |

Content stream xác nhận ảnh bù xén được vẽ dưới artwork. Artwork được clip từ `(8,3093; 8,3093)` trong khi TrimBox bắt đầu ở `(5,6693; 5,6693)`. Chênh lệch `2,64 pt` tương đương `0,931 mm`: gần đúng giá trị lẹm 1 mm sau lượng tử 300 DPI.

### 4.2 So sánh trước/sau bằng cùng renderer

Đo ở DPI được chọn để 1–2 mm rơi đúng biên pixel, tránh sai số crop:

| So sánh | MAE RGB | Tỷ lệ pixel lệch >10 |
|---|---:|---:|
| PDFium nguồn ↔ PDFium output, vùng giữa sau khi bỏ dải lẹm | `0,00279` | `0,00%` |
| PDFium nguồn ↔ PDFium output, dải mép | `2,92366` | `11,74%` |
| PPE nguồn ↔ PPE output, vùng giữa sau khi bỏ dải lẹm | `0,00000078` | `0,00%` |
| PPE nguồn ↔ PPE output, dải mép | **`12,53549`** | **`65,34%`** |

Kết luận: vùng giữa không bị writer đổi màu; dải lẹm sát mép bị thay màu thật và sai rõ dưới pipeline màu chính xác.

### 4.3 Độ gãy tại đường tiếp giáp

Ở 127 DPI, đo độ nhảy trung bình giữa hai pixel hai bên đường clip dải lẹm:

| Mẫu | Nhảy RGB trung bình | P95 | Tỷ lệ >10 |
|---|---:|---:|---:|
| Gradient tự nhiên trong file nguồn | `0,723` | `4,000` | `0,30%` |
| Output `trajectory` | **`9,094`** | **`22,333`** | **`29,76%`** |
| Output đối chứng vector `image` | `0,080` | `0,333` | `0,065%` |

Đây là bằng chứng trực tiếp cho hiện tượng dải gradient “không mượt” tại mép sau bù xén.

### 4.4 Toàn trang đổi màu do PPE ↔ PDFium

Trên chính trang nguồn, cùng kích thước 127 DPI:

- PPE ↔ PDFium: MAE `12,2593`.
- `92,33%` pixel có ít nhất một kênh lệch quá 10.
- Sai khác cực đại: `208`.

Ảnh PPE tương ứng với trạng thái gradient mượt người dùng gửi. Ảnh PDFium tương ứng với trạng thái vòng cung/transparency hiện rõ sau bù xén. Log người dùng cũng xác nhận PPE bị từ chối:

```text
PPE_NATIVE_UNSUPPORTED:{"reason":"geometry_approximation", ...}
[VIEWER-COLOR] Accurate render failed; refusing display fallback
```

Ngay sau lỗi đó, policy hiện hành tự đặt `accurateColorPreference.enabled=false`, làm lần render kế tiếp đi PDFium. Dòng log “refusing display fallback” vì vậy không phản ánh trạng thái cuối cùng của Viewer.

## 5. Findings

### §BXC.1 — `[CONFIRMED · ARTIFACT]` P1: dải lẹm đổi từ mực in sang ICC-sRGB

Nguồn là DeviceN/spot/CMYK nhưng `trajectory/inpaint` chỉ có RGB do PDFium đã composite. Việc gắn ICC sRGB làm RGB có định nghĩa tốt hơn DeviceRGB trần, nhưng **không biến nó trở lại cùng plate/mực với artwork gốc**. Khi `edge_bite_mm > 0`, RGB còn thay thế một dải nằm bên trong thành phẩm.

**Ảnh hưởng:** đường tiếp giáp đổi màu; gradient gãy; RIP/profile khác có thể cho sai khác lớn hơn Viewer; spot/process không còn cùng plate tại vùng bù.

### §BXC.2 — `[FIXED · AUTO + RUNTIME]` P1: Viewer âm thầm đổi engine cho toàn trang

PPE fail vì `geometry_approximation` → `AcrobatViewer` tự tắt accurate color → PDFium dựng lại toàn trang. Với file khách, hai engine lệch trên hơn 92% pixel nên hành vi này tạo đúng triệu chứng “toàn trang chuyển màu, hiệu ứng biến dạng”.

**Ảnh hưởng:** người dùng không thể dùng Viewer để đánh giá file trước/sau; cùng một revision có thể đổi diện mạo sau khi lỗi PPE tới muộn.

### §BXC.3 — `[CONFIRMED · AUTO GAP]` P1: test hiện tại khóa định dạng sRGB nhưng không khóa parity màu

Năm test backend liên quan đều xanh. Chúng xác nhận output có Form vector, ảnh sRGB lossless và không hở mép; chúng không so:

- nguồn ↔ output bằng cùng PPE;
- dải lẹm bằng plate/color-managed oracle;
- độ gãy tại seam;
- một file thật có DeviceN + spot + transparency + thiếu OutputIntent.

Hai test Viewer (`55/55`) cũng khóa hành vi tự tắt PPE khi `geometry_approximation`; tức chính hành vi gây đổi toàn trang đang được coi là expected.

### §BXC.4 — `[RESOLVED POLICY]` P1: font thay thế không được làm mất ảnh PPE

Runtime log xác nhận worker Tauri trả `geometry_approximation`, nhưng probe artifact mới trên HEAD chưa tái hiện bằng facade PPE backend:

- File `OUTLINE_FONTS`: không có resource Font ở trang 1.
- File `in.pdf`: có bốn Type1 font và cả bốn đều có `FontFile` nhúng.
- PPE backend trả `degraded=false`, `ink_unsound=false` cho cả nguồn và output.

Không cần kết luận font thay thế là đúng hay false-positive để quyết định hiển thị màu. `RenderWarnings` đã tách hai trục: `ink_unsound()` và `geometry_approximate()`. Font dự phòng chỉ làm hình học chữ xấp xỉ; PPE vẫn dựng đủ pixel qua đúng pipeline mực/ICC. Worker nay chỉ từ chối PNG khi `ink_unsound()`, còn geometry-only vẫn trả PNG PPE. Tên font/provenance còn giá trị chẩn đoán nhưng không còn là blocker khiến trang trắng hoặc đổi sang PDFium.

### §BXC.5 — `[DISPROVED]`: ảnh trajectory phủ hoặc đổi màu toàn bộ vùng giữa

SMask vùng giữa bằng 0 và PPE nguồn/output trùng gần tuyệt đối. Không được tiếp tục sửa layer order, làm mượt toàn ảnh hay thay renderer lấy màu với giả thuyết này.

### §BXC.6 — `[CONFIRMED · MITIGATION]`: rectangle `image` hiện là nhánh giữ màu tốt hơn

Nhánh `rectangle + image` dùng Form vector, không tạo ảnh ICC-sRGB. Trên cùng file, seam MAE `0,080` thay vì `9,094`; PPE edge MAE `1,258` thay vì `12,535`. Đây là biện pháp tạm thời có bằng chứng, không phải lời giải tổng quát cho contour hoặc inpaint.

## 6. Phạm vi ảnh hưởng theo mode

| Chế độ | Cách tạo bù xén | Rủi ro màu |
|---|---|---|
| Rectangle + `mirror` | Route vector mirror riêng | Thấp hơn; cần parity riêng |
| Rectangle + `image` | Form vector kéo dải/cạnh | Thấp nhất trong các mode đã đo; giữ resources mực nguồn |
| Rectangle + `trajectory` | PDFium RGB → ICC-sRGB + SMask | **Cao**; thay dải lẹm trong thành phẩm |
| Rectangle + `inpaint` | PDFium RGB → ICC-sRGB + SMask | **Cao**; cùng fracture colorspace |
| Sticker contour + `image/trajectory/inpaint` | PDFium RGB → ICC-sRGB + SMask | **Cao**; choke overlay còn có thể nằm trên artwork |
| `solid` CMYK từ UI | DeviceCMYK | Không có fracture RGB, nhưng không tự khớp spot/DeviceN nguồn |

## 7. Kế hoạch sửa và trạng thái triển khai

### Lô A — giữ đúng chế độ bù xén người dùng chọn, tối đa 5 file

1. **Đã thay thế sau feedback runtime:** detector/fallback theo resource màu bị bác bỏ vì quá rộng; nó tự đổi `trajectory/inpaint` thành kéo Form vector trên hầu hết PDF in, kể cả resource spot không tham gia artwork, làm mất quỹ đạo dải màu.
2. **Đã làm:** `rectangle + trajectory/inpaint` luôn chạy đúng mode đã chọn. Ảnh bù xén có SMask được vẽ trước, Form artwork CMYK/spot/DeviceN gốc được vẽ sau cùng; không có lớp RGB phủ toàn trang.
3. **Đã làm:** metadata trả `bleed_color_mode_requested == bleed_color_mode_applied`; bỏ cờ fallback và banner tự chuyển mode.
4. **Đã làm:** regression CMYK trực tiếp và spot cho cả lẹm `0/1 mm`, khóa Image + SMask nằm dưới Form gốc, thứ tự `Do` và resource mực nguồn không đổi.
5. **Giới hạn đã biết:** khi người dùng chủ động đặt `Độ lẹm mép > 0`, đúng dải lẹm đó được thay bằng raster ICC-sRGB của mode quỹ đạo/làm mượt; vùng sâu bên trong vẫn là Form gốc. Muốn bảo toàn plate tuyệt đối tại mép thì dùng `Độ lẹm mép = 0` hoặc mode vector `Lấy theo màu viền tem`.

### Lô B — không cho Viewer âm thầm đổi màu toàn trang, tối đa 5 file

1. **Đã làm (§BXC.4):** worker Tauri không còn phân loại `geometry_approximate` là `Unsupported`; PNG PPE được encode và trả về bình thường.
2. **Đã làm:** cổng cuối chỉ từ chối `ink_unsound()`; codec ảnh, colorspace xấp xỉ, mất object và transparency chưa hỗ trợ vẫn fail-closed.
3. **Đã làm (§BXC.2):** frontend không tự tắt PPE trong mode `current`, nên không có đường âm thầm thay toàn trang bằng PDFium.
4. **Đã làm:** regression Rust khóa font không nhúng phải trả PNG; regression frontend khóa không auto-disable.

### Lô C — lời giải màu dài hạn

Thiết kế bù xén theo plate/process/spot hoặc vector geometry. Không dùng lại hướng “lấy RGB từ PPE rồi nhúng sRGB”: PPE RGB vẫn là ảnh composite màn hình, không phục hồi được DeviceN/spot/CMYK gốc.

## 8. Verify đã chạy

- Tạo lại hai artifact từ HEAD bằng `StickerEngine(dpi=300)` với đúng tham số trang 1.
- Parse PageBox, content stream, XObject, ColorSpace, SMask và resources lồng nhau bằng pikepdf.
- Render đối chiếu bằng PDFium và PPE ở DPI khớp biên mm.
- Backend engine + quỹ đạo: `162 passed`.
- Runtime đúng file `CMNM2026 - Giay moi_BLUE - in_OUTLINE_FONTS_5e2846.pdf`, trang 1, trajectory/bleed 2 mm/bite 1 mm: `requested=applied=trajectory`, không warning, `3,017 s`; vùng sâu bên trong có `0%` pixel lệch >10, max lệch `3`.
- Frontend Viewer hẹp: `55 passed`.
- Các test xanh hiện tại được ghi nhận là baseline, không phải bằng chứng lỗi đã được sửa.

### Verify sau Lô A

- Regression đỏ trước sửa: `2 failed` vì chưa có metadata/chính sách bảo vệ màu.
- Sau sửa: `5 passed` cho spot `trajectory/inpaint`, CMYK trực tiếp, vector spot và đối chứng RGB.
- Suite backend liên quan: **`183 passed`** (`test_sticker_engine_e2e.py`, `test_sticker_trajectory_bleed.py`, `test_sticker_parallel_fallback.py`).
- Artifact thật: `tmp/AUDIT_CMNM2026_FIXED_RECT_TRAJECTORY.pdf`, file nguồn `OUTLINE_FONTS`, trang 1, 300 DPI, bù 2 mm, lẹm 1 mm, bốn cạnh.
- Cấu trúc trang 1 sau sửa: chỉ `/Form`, không còn XObject `/Image` RGB bù xén.
- PPE 127 DPI nguồn ↔ output: vùng giữa MAE `0,00000078`; dải mép MAE **`1,508`** (trước sửa `12,535`); cả nguồn và output đều `degraded=false`.
- Viewer regression đỏ trước sửa (`true` auto-disable), sau sửa nhóm renderer/loader/live-tile **`72 passed`**; TypeScript typecheck đạt.
- ESLint hẹp không phát sinh lỗi mới; file `useTileRenderer.ts` còn 5 lỗi baseline ngoài dòng sửa (`no-explicit-any`, `no-async-promise-executor`).
- Hồi quy trang trắng đỏ trước sửa: worker trả `Unsupported/GeometryApproximation`, payload rỗng. Sau sửa cùng fixture trả `Ready`, PNG hợp lệ và có kích thước.
- Rust `render_worker`: **`31 passed`, `2 ignored`**; `rustfmt --check` riêng file sửa đạt. `cargo fmt --check` toàn crate còn diff baseline ở `print.rs`/`print_worker.rs` ngoài phạm vi.
- Runtime đúng `CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1 qua executable worker mới: cold `598 ms`, warm `282 ms`, PNG `488.969 byte`, render sau cancel vẫn đạt.
- Runtime artifact bù xén mới: hai lượt render PPE đầu đều trả PNG (`490.661 byte`) và ảnh hiển thị đầy đủ; harness phụ sau đó vướng assertion hiệu năng “session warm sau cancel”, không ảnh hưởng bằng chứng render/màu và được ghi nhận riêng.

## 9. Chốt duyệt

Lô A đã khóa lỗi artifact đổi mực tại dải bù xén của Xén vuông góc. Lô B đã khóa cả hai hậu quả Viewer: không tự PPE→PDFium và không bỏ PNG PPE chỉ vì font dự phòng. File có geometry chữ xấp xỉ vẫn hiển thị bằng PPE để giữ màu/gradient; chỉ lỗi ảnh hưởng mực hoặc mất nội dung mới bị từ chối.
