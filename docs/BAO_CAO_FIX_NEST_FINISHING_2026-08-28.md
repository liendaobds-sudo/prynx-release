# Nối đủ gia công cho nhánh nesting — ốc bế, trang CUT, tách nét bế, dấu xén, report

Ngày: 2026-08-28. Nhánh `codex/pre-release-audit-2026-08-04`. Máy Windows thật.
Mọi số đo và test dùng **chính file khách**: `test/test nesting.pdf` (13 trang).

Xuất phát từ báo cáo của người dùng sau khi bình thật:

> "tao ghép 13 loại lên 1 trang, sao kết quả lại chỉ bình loại đầu tiên, ốc bế các thứ ko
> có, layout thì tùm lum, đường bế vẫn nằm bên trang in, luồng xử lý ko đi cùng với lựa
> chọn xếp tối ưu và lưới đơn giản à"

Cả bốn điểm đều đúng. Câu cuối chính là nguyên nhân gốc.

## 1. Nguyên nhân gốc

Nesting đi **renderer khác**. "Xếp tối ưu" và "Lưới đơn giản" dùng renderer của
`nup_engine` — nơi đã cài ốc bế, dấu xén, tách nét bế, trang CUT riêng, report. Nhánh
nesting đi `nesting_imposition_render`, và lô nối dây đầu **chỉ map hình học**: khổ tờ, lề,
khoảng hở, số lượng.

Mọi thiết lập gia công vì vậy rơi về mặc định của dataclass:

| Spec | Mặc định | Hệ quả người dùng thấy |
|---|---|---|
| `ImpositionPontSpec.type` | `"none"` | **không có ốc bế** |
| `ImpositionTrimSpec.type` | `"none"` | **không có dấu xén** |
| `ImpositionArtifactOptions.report` | disabled | **không có report** |
| `ImpositionCutStyleSpec` | mặc định | nét bế không theo cấu hình |

Cộng thêm hai lỗi riêng:

- **`pages = [0]` viết cứng** trong nhánh tự lấp đầy tờ ⇒ ghép 13 mẫu, để trống SL thì tờ
  bình **chỉ có mẫu đầu**, 12 mẫu còn lại bị bỏ **im lặng**. Preview vẫn hiện đủ 13 vì
  preview đi đường lưới cũ, nên lệch càng khó phát hiện.
- **Nét bế bị in lên trang in.** Nguồn tem bế mang nét CutContour trong chính artwork.
  Đường cũ gọi `nup_artwork.strip_color_from_stream` để bỏ nét đó; renderer nesting paint
  nguyên trang nguồn nên in cả đường bế.

## 2. Đã sửa

### 2.1 Tự lấp đầy tờ lấy đủ mọi mẫu

`_autofill_pages()` lấy **hợp** khoá của `targetQuantitiesByPage`, `detectedShapesByPage`
và `detectedShapeParamsByPage` — mỗi nguồn thiếu một kiểu (UI có thể chưa mở bảng SL bao
giờ), nên phải hợp cả ba. Khoá rác bị bỏ, không có nguồn nào thì mới về `[0]`.

Xác minh trên file khách, tờ A3 lở 320×430: **13/13 mẫu có mặt**, 44 con/tờ (preview báo 41).

### 2.2 Module map gia công

`backend/app/workers/nup_nesting_finishing.py` — năm hàm thuần, đọc đúng các khoá mà
`processHandlers` gửi và `nup_engine` đọc, **không phát minh tên mới**:

| Hàm | Từ settings |
|---|---|
| `build_trim_spec` | `markType`, `markLength`, `markOffset`, `markThickness`, `markStyle` |
| `build_pont_spec` | `pontType`, `pontConfig` (shape/size/thickness/isGraphtec/layer*/group/item/disableCollision/margin*/guide{i}*) |
| `build_cut_spec` | `separateCutPage`, `cutType`, `dieSizeMode`, `dieOffsetMm`, `fillBlockGap`, `pontsOnCutFile` |
| `build_cut_style_spec` | giữ mặc định — xem finding NEST-CUTSTYLE-1 |
| `build_artifact_options` | `exportUniqueSheets`, `reportDisplay`, `reportMaterial`, `reportLamination(Sides)`, `reportOrderCode` |

Hai quy tắc giữ đúng hành vi đường cũ:

- **Lề ốc thiếu thì dùng lề tờ** — hợp đồng rút gọn mà `normalize_pont_settings` đã ghi.
- **`cutType = "one_dao"` luôn ép tách trang CUT**, kể cả khi `separateCutPage` là False.

Fail-soft cho phần trang trí nhưng **không âm thầm**: `pontType` có mà `pontConfig` thiếu
thì log warning rồi trả "không ốc", chứ không ném lỗi làm hỏng lượt bình.

### 2.3 Tách nét bế khỏi trang in

Đây là phần khó nhất, và writer đã có sẵn một guard đúng chặn tôi:

> "formVariant chưa được materialize; không được chỉ đổi cache key để giả lập tách CUT."

Nên phải materialize thật. Thêm `DIE_STRIPPED_FORM_VARIANT` với `die_filter` bắt buộc, suy
từ `cutStyle.sourceFilter` thành đúng cặp `(target_color, target_spot)` mà
`strip_color_from_stream` nhận — để hai nhánh nhận diện nét bế theo **cùng** tiêu chí.

Hai phát hiện phải đo mới ra:

**Phải tách trên TRANG NGUỒN, không trên Form đã nhúng.** Gọi `strip_color_from_stream`
trên Form đã nhúng: **0 byte đổi**. `strip_color_from_stream` là bộ đi content stream của
lane cũ, nó cần trang thật với `/Resources` đầy đủ, và cần `contents_coalesce()` trước —
đúng như lane cũ làm.

**Khớp tên kênh PHÂN BIỆT hoa/thường.** File khách khai `CutContour`, còn
`cutStyle.sourceFilter.spotNames` mặc định là `cutcontour`. Đo được:

```text
target_spot='CutContour'  → tra ve True,  stroke 'S' 1 → 0   (bỏ được nét)
target_spot='cutcontour'  → tra ve False, stroke 'S' 1 → 1   (không bỏ được gì)
```

Thêm `_resolve_actual_spot_name()` quét resources (đệ quy cả Form con) tìm tên **thật**
khớp không phân biệt hoa/thường. Không tìm thấy thì trả lại tên yêu cầu, để lỗi không bị
che bởi một tên tự bịa.

**Cách xác minh đúng là đếm mực, không đếm resource.** Entry `/ColorSpace` vẫn còn sau khi
tách và điều đó **vô hại** — không toán tử nào dùng tới. Bản test đầu của tôi assert theo
resource nên đỏ oan; đã đổi sang đếm toán tử `S`.

## 3. Test — dùng file thật, không dùng fixture tự dựng

`backend/tests/test_nesting_finishing_parity.py`, **12 test**, đọc `test/test nesting.pdf`
(skip nếu thiếu file).

Lý do ghi thẳng trong docstring của file: fixture tự dựng của tôi là khuôn vuông vẽ tay,
không có ốc, không dấu xén, không report — nên **mọi assert đều xanh trên một tờ bình thiếu
hết gia công**. Đúng cái bẫy `prynx-dieline` cảnh báo, và là lý do lỗi này ra tới người dùng.

Phủ: mọi mẫu lên tờ, SL tường minh vẫn theo đúng khai, ốc bế tới job, thiếu `pontConfig`
không giả lập ốc, lề ốc lấy lề tờ, dấu xén, trang CUT riêng, `one_dao` ép tách trang,
report, report tắt, `_die_strip_target` cho spot/process và 5 ca rác, và nét bế không còn
trên trang in.

**Đã kiểm test bắt lỗi**: trả `form_variant` về `"artwork-raw"` thì
`test_net_be_khong_con_tren_trang_in` đỏ.

## 4. Phạm vi

| File | Thay đổi |
|---|---|
| `backend/app/workers/nup_nesting_finishing.py` | mới — 5 hàm map gia công |
| `backend/app/workers/nup_true_shape_nesting.py` | `_autofill_pages`, `_page_index_keys`, nối 5 spec vào job |
| `backend/app/workers/imposition_pdf_form.py` | biến thể tách nét bế + `die_filter` + resolve tên kênh |
| `backend/app/workers/nup_artwork.py` | `render_manifest_artwork` nhận `die_filter` |
| `backend/app/workers/nesting_imposition_render.py` | dùng biến thể đã tách nét bế |
| `backend/tests/test_nesting_finishing_parity.py` | mới — 12 test trên file thật |

## 5. Verify

| Bộ | Kết quả |
|---|---|
| `test_nesting_finishing_parity.py` | **12 passed** |
| `test_nesting_imposition_render` + `test_imposition_pdf_form` | **37 passed** |
| **Toàn bộ `backend/tests`** | **EXITCODE=0**, **4473 passed, 19 skipped, 0 failed**, 808s |

### 5.1 Chốt số

| | số |
|---|---|
| passed | 4473 |
| skipped | 19 |
| tổng | **4492** |
| `--collect-only` | **4492** |

Khớp tuyệt đối. Nền trước lô này 4479; +12 test `test_nesting_finishing_parity.py`
+1 test `test_mac_dinh_luon_co_tran_thoi_gian` = **4492**.

## 6. Còn hở

| Mã | Nội dung | Mức |
|---|---|---|
| NEST-CUTSTYLE-1 | `build_cut_style_spec` giữ mặc định (100% Magenta CMYK, 0,25mm). UI hiện chưa có ô riêng cho màu/độ dày nét bế nên tôi **không bịa ánh xạ**. Cần xác nhận mặc định này đúng thói quen xưởng, hoặc mở ô cấu hình | P2 |
| NEST-LAYOUT-1 | "Layout tùm lum": nesting đặt tự do, không theo hàng cột. Đó là bản chất, nhưng cần cho người dùng thấy trước khi bình — hiện preview vẫn là lưới nên họ không biết tờ ra sẽ khác | P1 |
| NEST-PREVIEW-1 | Preview vẫn đi đường lưới cũ (A4b-6a chưa xong), nên số "Sức chứa 41 tem/tờ" không phải số của nesting. Đây cũng là lý do lỗi `pages=[0]` không bị phát hiện sớm | P1 |
| NFP-PARALLEL-1 | Engine chạy **một lõi**; `multi_start.rs` nói song song là việc của lớp gọi mà lớp gọi không làm | P1 |
| NFP-DEADLINE-1 | `checkpoint()` chỉ kiểm giữa các góc, chưa kiểm trong `feasible_region` ⇒ ngân sách và Hủy chưa dứt | P1 |
| NFP-PRUNE-1 | `union_many` trên **mọi** chi tiết đã đặt + bbox pruning yếu ⇒ nhiều con vẫn chậm. Sửa đúng cần spatial index nhưng **đổi layout** nên cần duyệt | P1 |

## 7. Bài học về cách tôi verify

Ba lần liên tiếp tôi verify sai cùng một kiểu, và đều là **đo một thứ khác thứ được giao**:

1. Đo tốc độ bằng `profile="fast"` + `time_budget_ms=3000` trong khi production dùng
   `balanced` + `None`.
2. Test gia công bằng fixture khuôn vuông tự dựng — quá sạch nên không chạm ốc bế, dấu xén,
   hay nét bế trong artwork.
3. Assert tách nét bế theo `/ColorSpace` resource thay vì theo mực thật.

Quy tắc tự đặt từ đây: test đường nesting phải dùng **file thật của khách** và assert theo
**thứ người dùng nhìn thấy** (mực trên trang, số mẫu trên tờ), không assert theo cấu trúc
trung gian. Test mới trong lô này viết theo đúng quy tắc đó, và mỗi cái đã được kiểm là
**đỏ khi bỏ bản vá**.
