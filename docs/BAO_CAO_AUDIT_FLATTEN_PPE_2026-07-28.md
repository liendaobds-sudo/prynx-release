# BÁO CÁO AUDIT FLATTEN / PPE — 2026-07-28

**Phạm vi:** kiểm chứng lại phân tích cũ về nút **Flatten Visible**, mức độ thay thế
Ghostscript của PrynX Print Engine (PPE), đường cảnh báo suy giảm chất lượng, và nhánh
sticker/bleed có liên quan.

**Baseline:** `HEAD 2815386` cộng toàn bộ working tree tại thời điểm audit. Working tree
không sạch: **87 mục** (`59` tracked, `28` untracked; `3` mục có thay đổi ở index,
`56` mục có thay đổi ở worktree). Vì vậy báo cáo phân biệt rõ cái đã nằm trong HEAD với
cái mới chỉ tồn tại ở working tree.

**Nguyên tắc:** đợt này chỉ khảo sát, thực thi kiểm chứng và viết báo cáo. Không đổi
hành vi file đầu ra, không cập nhật golden/snapshot, không sửa code sản xuất.

---

## 1. Kết luận điều hành

Phân tích cũ **đúng về hậu quả chính**, nhưng có ba chỗ cần sửa lại:

1. Nút thật không đi theo một chuỗi
   `SelectionLayersPanel → preflight.py → edit_session.py`. Có **hai entry độc lập**
   cùng gọi `LayerEngine.flatten_visible`:
   - nút UI đi qua `useEditSession → /edit/session/flatten → edit.py → edit_session.py`;
   - route `/preflight/layers/flatten` ở `preflight.py` là đường riêng và hiện không
     tìm thấy caller frontend.
2. “Đổi sang pikepdf thì chỉ bỏ OCG và giữ nguyên nội dung” mới là **phương án thiết
   kế**, chưa được triển khai. Chỉ xóa `/OCProperties` là chưa đủ để bảo đảm trạng thái
   layer đang ẩn/hiện; còn phải xử lý marked-content `/OC`, `/OCMD`, Form XObject và
   chính sách visibility. Nếu làm nửa vời, layer đang ẩn có thể hiện lại.
3. Nhận định sticker đổi màu khi chuyển PPE là **rủi ro hợp lý nhưng chưa có số đo
   golden**. Code hiện tự ghi nhận PDFium có thể lấy sai màu chưa composite ở mép
   transparency group, nhưng test hiện chỉ mock renderer chứ chưa so PDFium ↔ PPE trên
   fixture thật.

Hiện trạng quan trọng nhất:

- **Flatten Visible vẫn raster hóa mọi trang thành JPEG 300 DPI DeviceRGB.** PPE không
  tham gia đường này.
- Working tree đang có bản vá tạo `last_flatten_warning`, trả nó từ core và đọc nó ở
  hook/UI, nhưng cảnh báo **vẫn chưa tới mắt người dùng**: `EditResponse` làm rơi field
  `warning`, và `reportMsg` hiện không có nơi render.
- **FLATTEN_TRANSPARENCY là chức năng khác**: chức năng này đã dùng PPE; trang không có
  transparency được copy nguyên, trang có transparency được raster thành ảnh CMYK và
  cảnh báo mất vector/gộp spot.
- PPE/no-GS sống được ở các đường chức năng chính: survival suite hiện đạt **24/24**.
  Tuy nhiên corpus gate chính thức hiện **không chạy được**, nên trạng thái release là
  **NO-GO** cho đến khi gate được sửa và chạy lại.
- P0 NOTICE đã có bản sửa đúng hướng trong working tree (`ghostscript.bundled=false`
  + test khóa hồi quy), đạt **24/24** policy test, nhưng chưa thể coi là artifact phát
  hành vì thay đổi chưa được chốt và chưa build/verify installer mới.

---

## 2. Kiến trúc / đường chạy đã trace

### 2.1. Nút Flatten Visible thật

```text
SelectionLayersPanel.tsx:268 handleFlatten()
  → useEditSession.ts:335 flatten()
  → POST /edit/session/flatten
  → edit.py:1369 session_flatten()
  → edit_session.py:2122 flatten()
  → layer_engine.py:1456 LayerEngine.flatten_visible()
  → _flatten_raster_fallback()
  → Working File mới + output_fid
  → hook onCommit đổi viewer sang Working File đó
```

Bằng chứng consumption: `edit_session.flatten()` di chuyển engine output vào đường
Working File, đăng ký `output_fid`, gán `session.last_commit_path` rồi trả đường dẫn
tuyệt đối. Vì vậy ảnh hưởng không chỉ là file tải xuống; đây là bản tiếp tục được dùng
cho các thao tác sau.

### 2.2. Route preflight là đường độc lập

`preflight.py:877-893` có `/preflight/layers/flatten` và cũng gọi
`LayerEngine.flatten_visible`, nhưng tìm kiếm toàn repo không thấy frontend gọi URL này.
Không được mô tả nó như một mắt xích nằm giữa nút UI và edit session.

### 2.3. Vì sao hiện tại Flatten Visible luôn raster

- `layer_engine.py:1475-1503` vẫn dựng lệnh Ghostscript `-dFlattenOCGs`.
- `config.py:96,106-108` khóa `GHOSTSCRIPT_PATH = ""` sau khi đọc mọi cấu hình.
- `subprocess_utils.py:52-77` chặn lệnh Ghostscript tại chốt toàn cục.
- `flatten_visible()` bắt exception và gọi `_flatten_raster_fallback()`.
- `_flatten_raster_fallback()` render PDFium ở `300/72`, ghi từng ảnh tạm `.jpg`
  `quality=95`, rồi reportlab đặt ảnh lên trang.

Đây không còn là “fallback đôi lúc xảy ra”; với contract no-GS hiện tại, nó là đường
sản xuất duy nhất của nút Flatten Visible.

### 2.4. Flatten Transparency của PPE là chức năng khác

`ActionEngine._action_flatten_transparency()` (`action_engine.py:516-591`) gọi
`pdf_actions_native.flatten_transparency()`:

- không có transparency: copy file, `pages_rasterized=0`;
- có transparency: PPE render ink-space, dựng ảnh `/DeviceCMYK`, giữ page boxes;
- spot được gộp vào process và có cảnh báo đích danh;
- nếu PPE không hỗ trợ thì contract no-GS hiện từ chối ở chốt chung, không thật sự chạy
  nhánh Ghostscript legacy.

Vì dự án đã có hai chức năng tách biệt, tên sản phẩm nên phản ánh rõ:

- **Gộp layer đang hiển thị / bỏ OCG** — mục tiêu giữ vector;
- **Làm phẳng trong suốt** — raster PPE có chủ đích và cảnh báo mất mát.

### 2.5. Sticker/bleed

Rủi ro nằm ở nhánh hẹp:

```text
rectangle_mode
+ bleed_color_type == "inpaint"
+ bleed_mm > 0
+ không phải selection mode
```

Nhánh này gọi `_render_page_rgb_ghostscript()` để lấy màu trang đã composite. Nhưng
`GHOSTSCRIPT_PATH` luôn rỗng nên hàm trả `None`, sau đó `sticker_engine.py:1654-1669`
ghi log và dùng PDFium RGB. PPE chưa được import/nối vào `sticker_engine.py`.

Route và UI đã có cơ chế `X-Sticker-Warning`, nhưng fallback màu này không được đưa vào
`meta["warning"]`; người dùng không thấy cảnh báo.

---

## 3. Đối chiếu từng nhận định cũ

| Nhận định cũ | Kết luận audit lại |
|---|---|
| Nút Flatten là nút thật | **Đúng.** `SelectionLayersPanel.tsx:581-588`. |
| Nút đi qua `preflight.py` rồi `edit_session.py` | **Sai đường gọi.** Đây là hai entry độc lập; nút thật đi qua `edit.py`. |
| Kết quả trở thành Working File | **Đúng.** `edit_session.py:2150-2189`. |
| Output là JPEG 300 DPI RGB | **Đúng.** Code ghi JPEG quality 95; mẫu chạy thật có 1 image `/DeviceRGB`, filter `/DCTDecode`. |
| Chữ/vector/CMYK/spot bị mất | **Đúng về khả năng và cấu trúc đầu ra.** Trang bị thay bằng ảnh RGB; text/vector/Separation không còn là object sản xuất. |
| Dung lượng luôn phình | **Quá tuyệt đối.** Có thể phình mạnh với file vector/text nhiều trang, nhưng file nguồn chứa ảnh nặng có thể nhỏ đi; phải nói “có thể phình”. |
| pikepdf sẽ giữ nguyên ruột file và chỉ bỏ OCG | **Đúng như mục tiêu, chưa đủ như thuật toán.** Phải rewrite optional-content đúng visibility, không chỉ xóa catalog. Chưa có implementation/test. |
| Hai nghĩa của “Flatten” gây quyết định sản phẩm | **Đúng**, nhưng code hiện đã có action Flatten Transparency riêng, nên có cơ sở mạnh để nút trong panel Layer chỉ mang nghĩa gộp OCG giữ vector. Vẫn cần duyệt vì output cũ sẽ đổi. |
| Golden chắc chắn lệch | **Chưa có bằng chứng cho LayerEngine.** Repo chưa có golden end-to-end cho Flatten Visible; cần tạo baseline trước khi đổi. Golden PPE hiện phủ Flatten Transparency, không thay thế được. |
| Sticker sang PPE sẽ đổi màu mép transparency group | **Chưa được đo.** Code thừa nhận PDFium có rủi ro sai màu composite, nhưng chưa có fixture/golden PDFium ↔ PPE ở mép trim. |
| Thêm cảnh báo là bước an toàn không đổi output | **Đúng về chiến lược.** Bản vá hiện tại chưa hoàn tất end-to-end nên chưa đạt mục tiêu “fail loud”. |

---

## 4. Phát hiện có bằng chứng

### §FL.1 — P0 / effort S — Flatten Visible vẫn âm thầm phá cấu trúc file in

**Bằng chứng:** `layer_engine.py:1456-1544`; phép chạy thật tạo PDF một trang chỉ có
image `/DeviceRGB`, `/DCTDecode`, không còn `/OCProperties`; content stream chỉ gọi
image XObject.

**Tác động:** nếu nguồn có chữ, vector, CMYK, Pantone hoặc CutContour thì Working File
mới không còn các đối tượng/kênh đó. Mọi thao tác và xuất file tiếp theo chạy trên bản
đã raster hóa.

**Điểm làm rủi ro tăng:** hộp xác nhận `SelectionLayersPanel.tsx:270-276` nói “các hiệu
ứng layer phức tạp *có thể* được raster hóa”, trong khi contract no-GS khiến **mọi lần**
đều raster hóa.

### §FL.2 — P0 / effort S — Bản vá cảnh báo hiện bị ngắt ở hai chốt

Working tree đã thêm cảnh báo ở:

- `layer_engine.py:1450-1503` — `last_flatten_warning`;
- `edit_session.py:2145-2189` — trả `warning`;
- `useEditSession.ts:341-348` — đọc `data.warning`;
- `SelectionLayersPanel.tsx:288-293` — gọi `setReportMsg`.

Nhưng:

1. `EditResponse` (`edit.py:164-178`) không khai field `warning`, và
   `session_flatten()` (`edit.py:1376-1382`) không truyền field đó. Phép thử trực tiếp
   tạo `EditResponse(..., warning="CANH_BAO")` cho `model_dump()` không có `warning`.
2. Tìm toàn frontend cho thấy `reportMsg` chỉ được đọc/ghi trong store và
   `ImpositionTab`, không có JSX/component nào render giá trị. Vì vậy kể cả route giữ
   field thì `setReportMsg` vẫn chưa bảo đảm người dùng thấy nó.

Các test mới chỉ khóa engine warning, chưa khóa hợp đồng API hay UI. Đây là lý do bộ
test hẹp vẫn xanh trong khi đường người dùng vẫn im lặng.

### §FL.3 — P1 / effort M — `PPE_CURRENT_STATE.md` đang gộp nhầm hai loại Flatten

`PPE_CURRENT_STATE.md:49` ghi “flatten raster PPE có cảnh báo” và đánh gate Flatten là
ĐẠT. Câu này đúng cho `FLATTEN_TRANSPARENCY`, nhưng không đúng cho nút Flatten Visible
trong panel Layer. Nút đó dùng PDFium → JPEG RGB và cảnh báo hiện chưa đến UI.

Hệ quả: SSOT có thể khiến release reviewer kết luận nhầm rằng mọi chức năng mang tên
Flatten đều đã qua PPE/fail-loud.

### §FL.4 — P1 (release blocker) / effort S — Corpus gate no-GS hiện crash trước khi đo

Lệnh tài liệu công bố:

```powershell
backend\venv\Scripts\python.exe scripts\gs_dependency_audit.py private_test_corpus\incoming --limit 18 --gate
```

hiện dừng với:

```text
AttributeError: 'Settings' object has no attribute 'PRYNX_ALLOW_GS_FALLBACK'
```

Nguyên nhân: `config.py` đã chuyển sang contract no-GS cố định và xóa field này, nhưng
`gs_dependency_audit.py:382-384` vẫn đọc nó. `run_release_qa.ps1:52-54` bắt buộc gọi
đúng script này, nên Release QA hiện không thể xanh trên source hiện tại.

Do đó các số `276 OK, 12 REFUSED, 0 GS, 0 ERROR` trong SSOT là bằng chứng lịch sử,
không phải số vừa tái lập trên working tree hiện hành.

### §FL.5 — P1 / effort M — Sticker “color-managed renderer” thực tế luôn là PDFium

**Bằng chứng:** `config.py:106-108` ép đường GS rỗng;
`sticker_engine.py:369-371` trả `None` ngay; `:1654-1669` fallback PDFium. Không có
import/call PPE trong `sticker_engine.py`.

**Phạm vi tác động:** Xén vuông + Làm mượt thông minh + có bleed; không phải mọi job
sticker. Nhánh “Kéo giãn mép ảnh” của rectangle dùng Form XObject/vector và không đi
qua renderer này.

**Khoảng trống bằng chứng:** test `test_rectangle_inpaint_uses_color_managed_page_renderer`
mock hàm Ghostscript nên chỉ chứng minh downstream dùng ảnh trả về; test fallback chỉ
chứng minh PDFium vẫn tạo được file. Chưa test màu mép trên transparency group thật và
chưa test cảnh báo route/UI.

### §FL.6 — P1 / effort S — Tài liệu và dead branch Ghostscript không còn khớp contract

- `PPE_CURRENT_STATE.md:23` nói còn legacy opt-in/dev có chủ đích.
- `config.py` và `_guard_ghostscript()` hiện chặn vô điều kiện.
- Nhiều hàm/comment vẫn nói “fallback Ghostscript” hoặc “Ghostscript is already
  bundled/discovered”, dù đường đó không thể chạy.

Không nhất thiết phải xóa ngay toàn bộ code legacy trong cùng lô, nhưng SSOT và comment
trên đường sống phải nói đúng để tránh audit nhầm engine.

### §FL.7 — RESOLVED IN WORKTREE — NOTICE không còn dễ tái sinh sai AGPL

Working tree đã:

- đặt component `ghostscript` thành `bundled: false` trong
  `scripts/bundled_components.json`;
- sinh lại `THIRD_PARTY_NOTICES.md` không có Ghostscript/Artifex/AGPL;
- thêm ba test khóa data source và NOTICE.

`test_release_no_gs_policy.py`: **24 pass**. Đây là cách sửa gốc tốt hơn việc phụ thuộc
caller luôn nhớ truyền `--no-ghostscript`. Trạng thái vẫn là “đã sửa trong working
tree”, chưa phải “đã phát hành”.

---

## 5. Kết quả kiểm chứng

| Phép kiểm | Kết quả |
|---|---|
| Targeted Flatten/edit/PPE/sticker | **8 pass** |
| No-GS survival suite | **24 pass** |
| Release no-GS policy + NOTICE | **24 pass** |
| Frontend TypeScript typecheck | **Đạt** |
| Mẫu output Flatten Visible | 1 image `/DeviceRGB`, `/DCTDecode`; không `/OCProperties`; content gọi image XObject |
| Pydantic response contract | `warning` bị loại khỏi `EditResponse.model_dump()` |
| No-GS corpus gate 18×16 | **Không chạy được** — `AttributeError PRYNX_ALLOW_GS_FALLBACK` |

Không chạy full backend 1467 test, full Vitest 1140 test, Rust 565 test hay build installer
trong audit hẹp này. Không có snapshot nào được cập nhật.

---

## 6. Trạng thái PPE hiện tại

### Đã có bằng chứng hiện hành

- Contract runtime là **no-GS tuyệt đối**: config và subprocess guard cùng khóa.
- Separations/TAC, soft-proof, Overprint Preview, các action chính, Flatten
  Transparency và PDF/X có survival test không GS; suite đạt 24/24.
- Flatten Transparency dùng PPE và nói rõ mất vector/gộp spot ở report engine.
- NOTICE/policy fix trong working tree đạt test hẹp.

### Chưa đạt / chưa được chứng minh lại

- Flatten Visible của panel Layer chưa dùng PPE hay structural OCG rewrite.
- Cảnh báo Flatten Visible chưa tới UI.
- Sticker smart rectangle bleed chưa dùng PPE và chưa có golden mép transparency.
- Corpus gate release đang crash, nên số ma trận hiện tại chưa tái lập được.
- Các chốt public release trong SSOT vẫn chưa có bằng chứng mới trong đợt này:
  validator PDF/X độc lập, smoke UI trên máy sạch, artifact no-GS mới đã cài và verify.

**Kết luận phát hành:** PPE đã thay Ghostscript ở phần lớn lõi prepress và đường sống
chính, nhưng trạng thái source hiện tại vẫn là **NO-GO cho release** vì release gate bị
gãy và hai đường suy giảm chất lượng (Layer Flatten, sticker smart bleed) chưa fail-loud.

---

## 7. Đề xuất sửa theo lô — chờ duyệt

### Lô A — không đổi output, tối đa 5 file

1. Sửa `gs_dependency_audit.py` theo contract no-GS cố định; thêm regression để gate
   không đọc field cấu hình đã xóa.
2. Thêm `warning` vào `EditResponse` và truyền qua `session_flatten()`.
3. Hiện cảnh báo bằng một UI surface thật sự nhìn thấy (toast/modal/banner có render),
   không dựa vào `reportMsg` đang chết.
4. Thêm integration test API chứng minh `warning` sống qua response model.
5. Thêm frontend test chứng minh người dùng thấy cảnh báo sau Flatten.

Sau lô: chạy targeted tests, full `test_no_ghostscript_survival.py`, corpus gate 18×16,
typecheck + Vitest phạm vi; không đổi golden output.

### Lô B — quyết định sản phẩm, có thể đổi output

Khuyến nghị dựa trên cấu trúc hiện có:

- nút trong panel Layer = **Gộp layer đang hiển thị (giữ vector)**;
- action riêng = **Làm phẳng trong suốt (PPE raster)**.

Trước khi làm structural OCG flatten:

1. tạo fixture OCG gồm ON/OFF, nested order, `/OCMD`, Form XObject, text/vector,
   CMYK/Separation/CutContour;
2. chụp baseline của output hiện tại;
3. kiểm text/vector/colorspace/spot bằng cấu trúc và so ngoại hình raster;
4. chỉ cập nhật golden sau khi đã duyệt diff.

### Lô C — sticker PPE, đo trước khi đổi

1. Tạo fixture transparency group sát trim (ít nhất RGB blend group và CMYK/spot).
2. Đo PDFium hiện tại, PPE và renderer chuẩn tham chiếu trên đúng dải bleed.
3. Trong lúc chưa đổi engine, nếu nhánh color-managed phải rơi về PDFium thì đưa cảnh
   báo qua `meta → X-Sticker-Warning → UI`.
4. Chỉ nối PPE khi golden mép trim cho thấy sai khác được hiểu và chấp nhận.

### Lô D — đồng bộ SSOT

Sau khi A/B/C được duyệt và verify, cập nhật `PPE_CURRENT_STATE.md` để tách rõ
Flatten Visible, Flatten Transparency và sticker; thay số corpus bằng số vừa đo, không
giữ số lịch sử dưới nhãn “hiện hành”.

---

## 8. Chốt duyệt cần từ chủ dự án

Đề nghị duyệt **Lô A trước** vì không đổi một byte đầu ra, chỉ phục hồi release gate và
làm suy giảm đang có lộ rõ cho người dùng.

Lô B cần chốt riêng: nút trong panel Layer có được xác định chính thức là “bỏ OCG nhưng
giữ vector” hay vẫn phải giữ hành vi raster cũ. Cấu trúc sản phẩm hiện tại nghiêng mạnh
về phương án đầu, vì “Làm phẳng trong suốt” đã là action PPE riêng.
