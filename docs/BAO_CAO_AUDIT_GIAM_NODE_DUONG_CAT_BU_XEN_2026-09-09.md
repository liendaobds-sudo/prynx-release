# Audit giảm node đường cắt trong Bù xén - 2026-09-09

## 1. Kết luận điều hành

**Có giải pháp giảm node mà giữ quỹ đạo trong sai số có kiểm chứng:** gộp/refit các đoạn Bézier liền nhau trên cùng phần cong trơn; giữ nguyên góc, điểm đặc biệt, lỗ và đường chuẩn; chỉ nhận phép gộp khi sai lệch hai chiều theo mm đạt ngưỡng. Không xóa node đơn thuần theo khoảng cách và không đặt trần node cho mọi hình.

“Giữ đúng tuyệt đối” chỉ có thể bảo đảm trong các trường hợp dư thừa chính xác, như điểm thẳng hàng hoặc các đoạn vốn được chia từ cùng một cubic. Với đường cong tổng quát, giảm node là xấp xỉ có dung sai, không phải biến đổi luôn chính xác 100%.

Mã hiện tại **đã có** simplify, bỏ neo ngắn, fitter Bézier, Newton reparameterization, spline C2 và các chốt topology/khoảng lùi. Không phải toàn bộ đường cắt vẫn là polyline theo từng pixel. Tuy nhiên:

1. **§NODE.1 / P1:** “Tách nhiều tem” làm rơi Khử răng cưa khi xuất; PDF không còn là đường vừa xem trước.
2. **§NODE.2 / P2:** live fitter có thể chọn đường G1 có bước nhảy độ cong lớn trước một ứng viên C2 hợp lệ, vì nhận ứng viên đầu tiên qua chốt. Tiếp tuyến liền chưa đồng nghĩa độ cong chuyển tiếp mượt.
3. Chưa có bước hậu fit chuyên **tối thiểu số đoạn dưới một dung sai độc lập**. Đây là khoảng trống thiết kế, không phải bằng chứng rằng mọi node đang dư.

Chưa có đúng PDF đầu vào/đầu ra mà người dùng đang thấy dày node; chưa kiểm Illustrator/Corel, bộ điều khiển hoặc máy bế vật lý. Không khẳng định tỷ lệ giảm node hay mức tăng tốc máy cho ca đó.

**Trạng thái: chỉ audit + probe + báo cáo; chưa sửa mã sản phẩm. Chờ duyệt trước khi triển khai.**

## 2. Baseline và phạm vi

- HEAD: `641fdc46958b7a17365b9ef5685bedbf9f54e67e`; worktree sạch lúc bắt đầu.
- Phạm vi: Bế tem nhãn / Tách nhiều tem -> chuẩn bị đường -> preview -> PDF CutContour. Không sửa artwork/màu bù xén, nesting, logo vectorization, worker/RAM, build hoặc license.
- `QUAY_LUI_HOP_NHAT_BU_XEN_2026-09-07.md` xác nhận rollback trước hợp nhất. Không dùng số 45 -> 8 cubic của workflow 06/09 làm bằng chứng hiện hành.
- Đã đối chiếu các báo cáo/fixes Alpha 04/08, freeform máy cắt 07/08, điều khiển làm mượt 10/08, Bù xén 16/08, shadow 05/09 và ghi chú rollback.
- Số liệu và hash nguồn: `docs/audit/CUTLINE_NODE_2026-09-09/evidence.json`.
- Harness tái lập: `docs/audit/CUTLINE_NODE_2026-09-09/probe.py`.

Quy ước số đo: “đoạn” là lệnh cubic/line thật, không cộng hai tay nắm thành hai node. Khoảng cách hai neo và chiều dài chạy trên cubic là hai số khác nhau. Probe đo lệnh theo mm, không theo pixel trên màn hình.

## 3. Trace đang sống

### 3.1 Entry chung và hình học

- `desktop/src/components/imposition-tools/sections/PreprocessingRouter.tsx:300` -> `StickerCutlineTool.tsx:277` chọn panel.
- Router backend được đăng ký tại `backend/app/main.py:376` và `:377`.
- Preview sheet: `backend/app/api/routes/sticker_sheet.py:427` -> `sticker_cutline_preview.py` -> `sticker_engine.py:5448` (`prepare_alpha_cutline_geometry`) -> `:5791` (`fit_prepared_alpha_cutline_geometry`).
- `prepare` đổi pixel -> point PDF theo DPI x/y, dựng biên 127,5, xử lý lỗ/offset; `fit_prepared` gọi fitter và oracle cuối.
- Fitter live: `sticker_engine.py:5059`; C2 spline -> cubic theo từng khoảng knot tại `:2132`.
- Preview ghi `path_groups`, fingerprint và quality tại `sticker_cutline_preview.py:1216`.
- Frontend vẽ thẳng `d={path.d}` tại `StickerSheetWorkspace.tsx:70`; không có bước frontend lấy mẫu lại làm tăng node.

### 3.2 Classic Bế tem nhãn

`useClassicCutlinePreview.ts:575` gửi preview; smoothness/fidelity cố định 50 tại `:585-586`, denoise vẫn được truyền. `/sticker-dieline` đăng ký tại `pdf_tools.py:1449`; canonical snapshot được lấy tại `:1755` rồi vào `approved_contour_overrides` tại `:1812`, `:1893`.

`StickerEngine.process_pdf` dùng override tại `sticker_engine.py:10003`, writer ghi cubic tại `:11156`. **Không gọi toàn bộ classic là bỏ qua oracle:** đường có canonical override giữ đúng đường đã duyệt. Nhánh direct/legacy không override còn fitter riêng tại `:10017`; phải kiểm từng caller, không suy từ một nhánh sang tất cả UI.

### 3.3 Tách nhiều tem

`StickerSheetPanel` -> `stickerSheetStore` -> `stickerSheetApi` -> schema/route -> `export_sticker_sheet_document` -> `_cutline_overrides_with_preview_fallback` -> `_build_cutline_pdf_from_pngs` -> `StickerEngine.process_pdf` -> lệnh `/CutContour CS` trong PDF. Đây là đường đã tái hiện §NODE.1.

## 4. Findings đã xác minh

### §NODE.1 - P1 / effort M / [CONFIRMED][VERIFIED][ARTIFACT]

**Khử răng cưa bị mất khi xuất “Tách nhiều tem”; tự dựng lại quỹ đạo.**

Bằng chứng truyền dữ liệu:

- UI có slider Khử răng cưa: `StickerSheetPanel.tsx:357`.
- Preview gửi denoise: `stickerSheetApi.ts:392`; schema nhận tại `backend/app/schemas/sticker_sheet.py:245`.
- Cache preview đưa denoise vào khóa: `sticker_cutline_preview.py:1232`.
- Export không có field tương ứng: `stickerSheetApi.ts:457-482`; schema page/export tại `sticker_sheet.py:217-225`, `:293-302`; store tại `stickerSheetStore.ts:1534-1565`.
- **Consumer live:** `sticker_sheet_export.py:1314` gọi helper; `:892-907` dựng khóa thiếu denoise nên thành `None`; cache miss dẫn đến `:923-939` gọi preview lại, cũng thiếu denoise. Writer dùng override mới tại `:1020-1024`.

Tái hiện độc lập bằng fixture `_session` trong `test_sticker_cutline_preview.py`: ảnh AI 180 x 140 px, 100 DPI, preserve, offset/bleed 0, denoise 50; gọi export document cùng đường UI.

| Số đo | Trước export | Sau export |
|---|---:|---:|
| Cubic | 19 | **14 trong PDF đọc lại** |
| Requested denoise trong cache | 50 | **None** |
| `path_groups` | Bản đã preview | **Khác** |

Khoảng cách hai chiều giữa biên canonical trước/sau refit, lấy mẫu 256 điểm/cubic: **0,724770 mm**. Đây là số đo xấp xỉ trên hai bộ đường canonical, không gọi là cận toán học của mọi điểm trên cubic. PDF sau xuất đã parse và raster bằng Poppler; một trang, đúng 14 cubic. Chênh kích thước byte/hash giữa các lượt có metadata PDF thay đổi, không dùng byte tổng làm oracle quỹ đạo.

**Bất biến vi phạm:** đường được xem trước phải là đường giao cho writer; người dùng không yêu cầu đổi denoise khi bấm xuất. Ít node hơn ở đây không phải tối ưu thành công: nó đi cùng thay đổi đường ngoài ý muốn.

Phạm vi: sheet; không gán finding này sang classic có snapshot canonical. Chưa xác minh qua thao tác Tauri.

### §NODE.2 - P2 / effort M / [CONFIRMED][VERIFIED][PROBE]

**Chọn G1 đầu tiên dù một C2 hợp lệ phía sau có chuyển tiếp độ cong tốt hơn.**

- `sticker_engine.py:5260-5261`: vòng ngoài là strength, vòng trong `("c2", "g1")`.
- `:5229`: nhánh G1 dùng Catmull-Rom tension 0,18.
- `:5306`: trả ngay khi ứng viên qua guard, chưa so với C2 ở strength tiếp theo.
- **Consumer live:** `fit_prepared_alpha_cutline_geometry` nhận candidate live tại `:6027`; oracle `:4987` không đưa bước nhảy độ cong vào `machine_safe`.
- Metric độ cong đã có trong `cutline_machine_path.py:111`; bộ xếp hạng `sticker_engine.py:3225` có đọc metric, nhưng nhánh live này không dùng bộ xếp hạng đó.

Probe đầu vào trơn, 400 điểm, `r=20+5*cos(12θ)` mm; source pixel 25,4/300 mm, controls 50/50/0, offset 0. Root đã tự chạy lại, không chỉ dùng kết luận subagent.

| Candidate | Cubic | Đoạn ngắn nhất (mm) | Nhảy độ cong max (1/mm) | Khoảng cách mẫu tới chuẩn (mm) | Budget hiện có (mm) |
|---|---:|---:|---:|---:|---:|
| Live hiện tại | 104 | 0,925 | **6,150379** | 0,152423 | 0,29718 |
| C2 phía sau | 101 | 0,700 | ~6,8e-14 | 0,245316 | 0,29718 |

Cả hai có góc nối xấp xỉ 0°, không cusp, không đoạn dưới 0,25 mm và đều qua oracle. Mẫu nhỏ `r=8+cos(3θ)` tái hiện cùng pattern: 16 -> 15 cubic; nhảy độ cong 2,051769 -> xấp xỉ 0.

Đối chứng chỉ bỏ G1 trong process probe để quan sát C2 phía sau; **không phải bản vá**, không sửa file sản phẩm. C2 trong đối chứng lệch chuẩn hơn và có đoạn min ngắn hơn; không được trình bày là tốt hơn ở mọi tiêu chí. Hai kết quả cùng đạt budget hiện tại, chưa chứng minh budget ấy phù hợp máy của người dùng.

Kết luận giới hạn: xác nhận thiếu tiêu chí chuyển tiếp độ cong/thiếu xếp hạng candidate. Chưa đo gia tốc, jerk, tốc độ hay chất lượng cắt trên thiết bị cụ thể.

## 5. Điều đã kiểm nhưng không gọi là bug mới

- Ba PDF direct-engine từ fixture hiện hành có 30 / 104 / 118 cubic, đoạn min 0,668 / 0,650 / 1,059 mm; **không có đoạn dưới 0,25 mm**. Không từ đây khẳng định đúng file người dùng không có node sát.
- Circle direct-engine dùng default legacy có 2 join lớn hơn 1°, max 32,528°. Không gán P1 cho UI hiện tại vì route/canonical caller có policy khác. Đây là ca bổ sung cần khóa khi bao phủ direct/legacy.
- Circle qua shared live fitter đã chỉ còn **8 cubic**, không phải hàng trăm. Candidate circle lý tưởng 4 cubic trong probe lệch đường hiện tại khoảng **0,164 mm**; phải từ chối nếu budget giảm node là 0,02-0,05 mm. Không mặc định circle nào cũng được thay bằng 4 node.
- Hàng `W2-U05` cũ nói fallback không qua oracle đã stale: `fit_prepared...` hiện đưa mọi fallback qua `accept_candidate`. Báo cáo ngày 10/08 phần 12 cũng ghi đã sửa.
- Newton-Raphson đã có tại `cutline_geometry.py:432`, được gọi ở `:543`; không đề xuất “bổ sung Schneider còn thiếu” theo audit Logo khác luồng.
- Short arc của fillet giải tích được phân biệt với short line tại `sticker_engine.py:4808`; đây là chủ đích, không gọi mọi cung ngắn là lỗi.
- Classic cố định smoothness/fidelity; sheet phối hợp Bám sát với smoothness và corner style. UI chưa có điều khiển “chỉ giảm node” hay đọc ra sai số mm. Khoảng trống UX này đã có trong backlog, không phải discovery mới.

## 6. Giải pháp đề nghị: giảm node trên chính quỹ đạo đã duyệt

### 6.1 Tách ba thao tác

1. **Khử răng cưa:** sửa biên raster/nhiễu, có thể thay hình.
2. **Làm mượt/bo:** điều chỉnh độ cong/góc, có thể thay hình theo ý người dùng.
3. **Giảm node:** nén biểu diễn của đường đã duyệt, không tự detect lại, bo góc hay nới offset.

Không dùng slider 1/2 làm thay thế cho 3. Sửa parity §NODE.1 trước để đường chuẩn không bị đổi ở lúc xuất.

### 6.2 Thuật toán giảm node

- Đóng băng quỹ đạo hiện tại sau offset/bo đã duyệt; giữ cả biên nguồn để kiểm phần ngân sách tổng còn lại.
- Bỏ điểm trùng/điểm thẳng dư và hợp nhất chính xác khi chứng minh được. Không đụng các điểm đánh dấu start, góc, notch, junction hoặc tính liên tục của lỗ.
- Chia thành từng nhịp cong giữa các góc thật/điểm đặc biệt; không gộp xuyên góc, cổ hẹp hoặc điểm uốn không được kiểm.
- Thử gộp 2, 3... cubic liền nhau thành ít cubic hơn; giữ hai đầu và hướng tiếp tuyến biên. Với B-spline có thể thử loại knot có kiểm soát.
- Xét ứng viên theo thứ tự: **đạt mọi chốt hình học -> đạt tiêu chí độ mượt -> ít đoạn -> sai lệch nhỏ**. Dùng tối ưu đường đi/nghiệm gộp trên từng nhịp nếu gộp tham lam bỏ lỡ kết quả tốt.
- Nếu candidate thất bại, giữ nguyên span cũ; không âm thầm đổi sang polyline hoặc tăng dung sai.
- Hình tròn/ellipse/đoạn thẳng đã có bằng chứng hình học có thể dùng biểu diễn gọn riêng. Nhận dạng lại hình raster là chế độ tùy chọn khác, không được thay quỹ đạo freeform để đạt con số 4/8 node.

Ý tưởng gộp các Bézier cùng độ lồi, bảo toàn góc và chọn ít đoạn dưới tolerance có cơ sở ở [Potrace, mục 2.4](https://potrace.sourceforge.net/potrace.pdf). Đây là tham khảo thiết kế, không đề nghị thay engine bằng Potrace hay sao chép nguyên ngưỡng pixel của thư viện.

### 6.3 Chốt giữ quỹ đạo

- Dung sai giảm node theo mm; thử nghiệm **0,02 và 0,05 mm** trước, không coi đó là chuẩn mọi máy. Không dùng budget cũ 0,29718 mm trong probe như cam kết giữ nguyên.
- Kiểm **hai chiều** đường cũ -> mới và mới -> cũ; kiểm thêm độ lùi/offset theo pháp tuyến và khoảng cách vùng hẹp.
- Lấy mẫu thích ứng bằng chia Bézier có cận sai số hình học; tổng sai số xấp xỉ đường cũ/mới phải nằm trong budget. Khoảng cách polygon lấy mẫu đơn thuần chưa phải chứng minh cho cubic liên tục: [Shapely ghi rõ Hausdorff là phép đo rời rạc](https://shapely.readthedocs.io/en/stable/reference/shapely.hausdorff_distance.html).
- Giữ component/lỗ/winding, góc thật, không self-intersection, không đổi thứ tự đi trên đường hoặc tạo cú quay ngược/gai.
- Đo góc nối, bước nhảy và dao động độ cong; ưu tiên liên tục độ cong ở đoạn vốn trơn, không ép G2 tại góc/cusp thật.
- Đếm đoạn min/P10/median và tỷ lệ đoạn dưới ngưỡng profile máy. Không ép bỏ mọi đoạn dưới 0,25 mm: cung/góc thật nhỏ có thể cần thiết.
- Preview và writer dùng cùng canonical path/fingerprint. Parse lại lệnh PDF đã làm tròn tọa độ để kiểm lần cuối; không chỉ kiểm object trong RAM.

## 7. Thứ tự sửa đề nghị, mỗi lô tối đa 5 file

| Lô | Mục tiêu | Verify bắt buộc |
|---|---|---|
| A1 - backend | Mang denoise qua schema/route/export, cả theo trang và fallback; giữ đúng None/0/>0 | Regression preview -> PDF cho 0/50/100, cache hit/miss, nhiều trang; đúng path/fingerprint |
| A2 - desktop | Mang denoise từ state vào export API, không làm rơi giá trị theo trang | Payload/store test và typecheck; tương thích backend A1 |
| B - chọn quỹ đạo | Xếp hạng C2/G1 theo chất lượng cong dưới cùng ngân sách; khóa §NODE.2 | Hai flower, corner/notch/hole; parse PDF; không nới budget để xanh |
| C - giảm node | Post-fit merge/knot removal có hard geometric guards | Trước/sau node, sai số hai chiều, topology, curvature; fail giữ nguyên span |
| D - điều khiển | Hiển thị node trước/sau, sai số mm, so đường gốc/đường mới; tách giảm node khỏi bo/denoise | UI/i18n/typecheck; thao tác thật rồi thử đúng phần mềm điều khiển/máy |

Không refactor toàn bộ `sticker_engine.py` trong lô giảm node. Tái sử dụng helper thuần trong `cutline_geometry.py`; không thêm cap chất lượng/worker/RAM.

Mẫu nghiệm thu: circle/ellipse, đường hữu cơ ít/nhiều cánh, đường S, sao, hõm, hai biên sát nhau, lỗ, seam đóng; 72/150/300 DPI, kích thước vật lý cố định; đúng PDF nguồn/đầu ra người dùng phản ánh. Phân biệt số anchor PDF với số lệnh driver tạo sau khi flatten.

## 8. Verify đã thực hiện và giới hạn

- `test_sticker_cutline_tuning.py` + `test_cutline_contour.py`: **80 passed**, 1 warning Pydantic có sẵn.
- `test_cutline_machine_path.py` + 3 ca PDF Alpha chọn lọc trong E2E: **17 passed / 155 deselected**, 1 warning Pydantic có sẵn.
- Vitest Windows: `StickerSheetPanel`, `useClassicCutlinePreview`, `stickerSheetApi`: **3 file / 34 test passed**.
- Probe root chạy lại hai flower, shared-live circle, ba PDF direct-engine và một PDF sheet denoise. PDF sheet đã render Poppler 300 DPI và xem ảnh. Các PDF/session tạm của probe đã được tự dọn; giữ JSON/hash và ảnh QA.
- Probe lần đầu hoàn thành tính toán nhưng lỗi in tiếng Việt do stdout CP1252; đã sửa **harness** dùng JSON ASCII cho stdout và chạy lại exit 0. Không phải lỗi của sản phẩm.
- Không sửa golden, không chạy full suite/typecheck/build vì không đổi source TS/Python sản phẩm; không commit/release.
- Chưa chạy đúng file người dùng đang phản ánh, Tauri/native click, Illustrator/Corel/driver hoặc máy cắt; chưa đo benchmark optimizer vì chưa triển khai optimizer.

Thẻ audit `W2-U05-NODE`: entry/schema/handler/engine/writer/consumer đã trace; §NODE.1 đạt **ARTIFACT** trên fixture sheet, §NODE.2 đạt **TRACED + PROBE**. Không nâng toàn bộ tính năng thành RUNTIME hay bảo đảm mọi máy chạy mượt.

## 9. Chốt duyệt

Đề nghị duyệt A1-A2 để giữ đúng đường đã xem, rồi B-C để làm mượt chuyển tiếp và giảm node có kiểm chứng. Cần chốt dung sai mm bằng đúng PDF và yêu cầu máy bế trước khi đặt mặc định sản xuất. Không tự sửa sản phẩm trong lượt audit này.
