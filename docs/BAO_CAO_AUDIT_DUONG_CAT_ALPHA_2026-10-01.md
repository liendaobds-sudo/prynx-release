# Audit chất lượng đường bế theo biên trong suốt — 2026-10-01

## 1. Kết luận điều hành

Phản ánh trong ảnh là có cơ sở về mặt hình học: đường bế Alpha bắt đầu từ mask raster nên luôn bắt đầu như một đa giác nhiều cạnh. Engine hiện có fitter Bézier và nhánh preview canonical đã giảm mạnh số node, nhưng **đường thẳng vẫn là kết quả hợp lệ của một số nhánh fallback/policy**.

Đã tái hiện trên source hiện tại:

| Cấu hình | Kết quả probe |
|---|---:|
| `cut_mode="original"`, `corner_style="preserve"`, `alpha_corner_policy="legacy"`, nguồn có SMask | 165 `l`, 0 `c` |
| Cùng nguồn, `alpha_corner_policy="adaptive"` | 0 `l`, 85 `c` |
| `cut_mode="alpha"`, preserve, legacy | 0 `l`, 37 `c` |

Do đó ảnh người dùng có thể đến từ nhánh `original/legacy`, bản output cũ, hoặc fallback khi fitter không tìm được cubic an toàn. Resolver hiện tại thường đổi route UI `original` sang chính sách `adaptive`; vì vậy probe `original/legacy` là bằng chứng chắc chắn rằng nhánh legacy/API còn tồn tại, nhưng chưa đủ để kết luận riêng ảnh đính kèm là output của route mặc định trong UI.

## 2. Luồng đã truy vết

1. UI tạo payload tại `desktop/src/components/preprocess-tools/stickerToolPolicy.ts:9-14,87-95,114-123`.
   `alpha` luôn dùng `shape_mode="contour"` và `corner_style="preserve"`; trạng thái mặc định
   của công cụ vẫn là `original` tại `StickerTool.tsx:329`, nên cần xác nhận user đã chọn đúng
   “Theo biên trong suốt”.
2. Route nhận và truyền tham số tại `backend/app/api/routes/pdf_tools.py:1479-1987`.
3. Alpha được đổi thành contour từ raster bằng `skimage.measure.find_contours()` tại `backend/app/workers/sticker_engine.py:5607-5679`.
4. Offset/buffer và guard topology nằm tại `sticker_engine.py:5746-5802,6091-6459`.
5. Preview canonical serialize các đoạn cubic thành SVG `C` tại `backend/app/workers/sticker_cutline_preview.py:768-799,1620-1637`.
6. Writer dùng path cubic đã duyệt tại `sticker_engine.py:12829-12867`; nếu không có `cut_fitted_paths`, fallback `build_contour_path_stream()` tại `12868-12906`.
7. `build_contour_path_stream()` chỉ chọn Bézier cho `round/alpha_smooth`; `preserve/miter/...` dùng `m/l/h` tại `backend/app/workers/cutline_geometry.py:1308-1317`.

## 3. Findings

### §ALPHA.DELTA-01 — P1 — [CONFIRMED] Fallback Alpha có thể xuất polyline

`_fit_alpha_bezier_paths()` có thể trả `None`; nếu `_safe_alpha_bezier_tension()` cũng không tìm được mức an toàn, `cut_fitted_paths` vẫn rỗng và writer đi vào serializer `preserve`, sinh toàn lệnh thẳng. Đây là đường chạy thật tại `sticker_engine.py:10042-10088,10248-10275` và nhánh tương ứng `11374-11516,12829-12906`.

Probe trên cùng nguồn hữu cơ cho thấy `original + legacy` tạo 165 lệnh `l`, còn `original + adaptive` tạo 85 cubic. Đây là rủi ro của nhánh legacy/API hoặc khi fitter bị từ chối; route UI bình thường cần được replay để xác nhận có đi vào nhánh này hay không. Một contour ít node hoặc có góc/đoạn hẹp có thể rơi vào fallback dù mask không hỏng.

### §ALPHA.DELTA-02 — P2 — [CONFIRMED/EXPECTED] Alpha mặc định khóa `preserve`

UI và backend cố ý không cho Alpha dùng kiểu góc `round`. Điều này bảo vệ mép mềm, notch và góc thật, nhưng cũng khiến nhánh fallback giữ đường thẳng. Các hình chữ nhật, tam giác, sao và notch có góc thật có thể chứa đoạn `l` đúng chủ đích; không thể coi mọi `l` là lỗi.

### §ALPHA.DELTA-03 — P1 — [CONFIRMED] Có cubic nhưng vẫn có thể nhìn như đoạn thẳng

`_linear_bezier_ring()` tại `sticker_engine.py:4417-4433` mã hóa mỗi chord bằng một cubic có hai control point nằm trên chính chord. Một số guard trong fitter cũng ép control point về chord khi tay nắm không đơn điệu. Vì vậy đếm token `c` chưa đủ; phải đo cross-product của control point, độ nhảy tiếp tuyến/độ cong và render zoom cao.

### §ALPHA.DELTA-04 — P2 — [GAP] Chưa phủ hết các nhánh legacy/fallback

Test hiện có khóa tốt các ca `cut_mode="alpha"` tròn, hữu cơ, 72 DPI và `original + adaptive`, nhưng chưa khóa đầy đủ:

- `original + legacy` với nguồn SMask/Alpha;
- fitter bị từ chối hoặc không có safe tension;
- contour ít node, đa component, cổ hẹp, notch dày, lỗ trong;
- offset âm/lớn, DPI 72/150/300 và DPI X/Y khác nhau;
- parity SVG preview ↔ PDF khi không có canonical preview reference;
- cảnh báo rõ cho người dùng khi fallback polyline xảy ra.

### §ALPHA.DELTA-05 — P2 — [GAP] Chưa có runtime downstream đầy đủ

Chưa chạy lại thao tác trên Tauri/WebView và chưa mở artifact trong Acrobat/Illustrator/Corel hoặc driver máy bế. Vì vậy chưa thể chứng nhận hình học nhìn thấy trên mọi renderer và máy thật.

## 4. Bằng chứng đã kiểm

- Audit cũ đã tái hiện artifact 72 trang với 1.201 `l`/trang và 0 `c` trước bản sửa (`docs/BAO_CAO_AUDIT_DUONG_CAT_ALPHA_2026-08-04.md`).
- Bản sửa sau đó ghi nhận 72/72 trang có Bézier, 0 lệnh thẳng, median 144,5 node (`docs/DUONG_CAT_ALPHA_FIXES_2026-08-04.md:80-125`).
- Test hiện tại: 5 regression Alpha E2E đạt; `test_sticker_cutline_preview.py` + `test_cutline_contour.py`: **89 passed, 1 warning**.
- Bộ E2E Alpha được kiểm ở `backend/tests/test_sticker_engine_e2e.py:2576-2787`; các test này xác nhận `l=0` cho các fixture đã chọn, chưa bao phủ toàn bộ fallback.
- Ma trận tổng thể ghi W2-U03 ở mức `ARTIFACT`, còn W2-U05 ở mức `TRACED + PROBE`; chưa có bằng chứng GUI/driver/máy bế (`docs/PRYNX_MASTER_AUDIT_MATRIX.md:520-523`).

## 5. Ma trận trường hợp

| Trường hợp | Hành vi hiện tại | Đánh giá |
|---|---|---|
| Alpha tròn/elip đủ độ phân giải | cubic sau fitter | Tốt, đã có test |
| Biên hữu cơ/wavy, canonical preview | cubic, guard machine path | Tốt ở fixture đã kiểm |
| `original + adaptive` | cubic nếu candidate qua guard | Tốt theo fixture; cần thêm ca fallback |
| `original + legacy` | có thể toàn polyline | Rủi ro P1 |
| Góc thật/chữ nhật/tam giác khi preserve | đoạn thẳng là đúng chủ đích | Expected |
| Chữ L/notch/cổ hẹp | có thể cubic hoặc fallback tùy guard | Cần artifact test riêng |
| Lỗ trong với `fill_holes=false` | giữ ring lỗ; `true` chủ động lấp lỗ | Expected, phải kiểm đúng lựa chọn |
| Nhiều component/tiny sliver | lọc contour nhỏ hoặc MultiPolygon | Cần kiểm không mất mảnh có ý nghĩa |
| ThruCut `contour_offset` | serializer riêng có thể dùng `L` | Không được nhầm với CutContour |

## 6. Đề xuất lô sửa sau khi được duyệt

1. Khóa `adaptive`/canonical path cho mọi luồng Alpha hợp lệ; chỉ cho `legacy` khi caller nói rõ.
2. Khi fallback polyline xảy ra, ghi `fit_mode`, primitive counts và warning vào metadata/UI; không im lặng coi là đường cong.
3. Thêm oracle “cubic có độ cong thật” (cross-product control point, curvature jump, short segment) bên cạnh kiểm `c/l`.
4. Thêm regression PDF cho `original + legacy`, candidate bị reject, low-DPI, notch/lỗ/đa component và preview không có reference.
5. Chạy smoke Tauri/WebView + render 600–1600% và đối chiếu Acrobat/Illustrator/Corel trước khi gọi là `RUNTIME`.

## 7. Trạng thái sau lô sửa 2026-10-02

Đã triển khai lô sửa §ALPHA.DELTA-01:

- Trang ảnh phủ kín có `/SMask` được nhận diện theo từng trang ngay cả khi caller chọn
  `cut_mode="original"`; route này dùng Alpha threshold, lưới pixel nguồn và fitter
  adaptive có guard. Metadata trả `contour_source="alpha"`.
- Khi fitter chính và safe tension đều bị loại, biên trơn được thử spline cubic có
  kiểm Hausdorff, topology, khoảng hở và machine-path. Biên có góc thật bị từ chối
  fallback spline để giữ góc bằng đoạn thẳng khi cần.
- Không ép mọi `cut_mode="alpha"` cũ sang adaptive, vì làm thay đổi hợp đồng inset
  của caller legacy. Chỉ route `original/bleed + SMask` mới nâng policy nội bộ khi
  cần, còn Alpha rõ ràng vẫn tôn trọng policy caller.

Đã kiểm chứng: `test_sticker_engine_e2e.py` **165 passed**, gồm `original + SMask` ở
72/150/300 DPI, fallback cubic và guard góc thật; `py_compile` và `git diff --check`
đều đạt. Kiểm tra Tauri/WebView và driver máy bế vẫn chưa chạy trong lượt này.
