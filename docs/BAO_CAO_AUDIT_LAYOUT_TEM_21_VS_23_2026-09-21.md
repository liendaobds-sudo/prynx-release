# Audit bố cục tem 21 so với 23 — Untitled-1.pdf

Ngày 2026-09-21. HEAD `d3388be91d776b74cd873588c61aeac3c662fbb3`, đọc working tree hiện tại. **Chỉ audit, chưa sửa code hoặc PDF khách.**

## Kết luận

Người dùng xếp tay 23 tem là có cơ sở. Đã dựng và kiểm độc lập phương án **3 cột × 6 hàng =18 tem hướng gốc, cộng1 cột ×5 tem xoay90° =23 tem**, trên đúng kích thước nguồn, khổ320×430mm, vùng in314×424mm và boong5mm cách mép7mm. Phương án này không đè tem, không vượt vùng in, không chạm vùng cấm boong có đệm3mm. Không cần mặc định hạ xuống22 với cấu hình đã kiểm.

Không tuyên bố23 là tối ưu toàn cục; đây là **một nghiệm hợp lệ tốt hơn21**, đủ bác bỏ việc21 là giới hạn bắt buộc.

Nguyên nhân bố cục quái dị: nhánh chữ nhật chọn một candidate L-shape có **24 ô nhưng chồng lấn**, dọn va chạm còn23, rồi xóa/dồn hàng để né boong còn21. Không quay lại cạnh tranh với candidate23 hợp lệ hai khối. Căn riêng hàng bị xóa tạo ô khuyết góc trên-trái và dải ba tem xoay nằm lẻ phía dưới.

## Nguồn và artifact thực tế

- Nguồn: `D:/pdfcompare/test/Untitled-1.pdf`, 1 trang, 4.354.238byte, SHA256 `f96a27c1a4f93d3e4b55d4187bdf3bc90d06de841b23aa3255b000f56d51d376`.
- MediaBox/CropBox/TrimBox/BleedBox cùng226.917×184.238pt = **80.051275×64.995072mm**. Không có spot CutContour; helper fallback trang xác nhận RECTANGLE. Không phải lỗi nhận dạng con gà thành contour cần lồng.
- PDF đã xuất của người dùng: `C:/Users/Khanh Pham/AppData/Local/Temp/PrynX-dev/results/nup_b2d700fa.pdf`, 2 trang IN/CUT, 2.087.106byte, SHA256 `788a96f1d447e9c25837416f73a4e10878f1d0950acb3630c675768c3c2102f3`.
- Log preview_perf session08:46:32 ghi nguồn mới80.1×65mm; các lượt preview08:46:33,08:46:43,08:47:12 trả21. Export job b2d700fa08:47:15..16 có preview_capacity21, usable314×424mm, gap0, bleed0, split_gap0 và render21.
- Phân biệt bản nguồn08:38 trước đó86×72.5mm: **không dùng bản này làm oracle** cho file đã đổi08:46.
- app.log08:46:33 và08:47:12 ghi `shape=RECTANGLE`, `strategy=l_shape`.
- Đã render Poppler và xem trọn trang nguồn cùng2trang IN/CUT. PDF thực tế đúng bố cục screenshot, không chỉ preview xấu còn file in đẹp.
- Parse21 clip rectangles gắn các Do artwork trên trang IN, đối chiếu đủ21placement tái hiện; độ lệch lớn nhất **0.0018473pt**, do hằng số/quy tròn. Boong trong content stream có đường kính5mm, tâm cách mép9.5mm, khớp cấu hình margin7mm.

## Trace đường chạy

Path tương đối với D:/pdfcompare, số dòng ở working tree audit:

1. `desktop/src/components/imposition-tools/sections/GridPreview.tsx:2429,2488` gửi strategy/layout, request backend `/imposition/preview-layout`.
2. Route `backend/app/api/routes/imposition.py:2115` → nhánh S&R `:3939` → `compute_sticker_layout_for_page` `:4089-4111`.
3. `backend/app/workers/sticker_imposer_pkg/layout_compute.py:169+` fallback khuôn chữ nhật theo page box → orchestrator.
4. `sticker_imposer_pkg/orchestrator.py:276-288` sinh grid0/grid90/L-shape; `:359-360` chọn winner theo count/bonus/area; `:563` mới loại tem chồng của winner.
5. `shape_layouts.py:821` gọi native khi secondary_gap=None; native `shape_l_layout` → `imposition_core/src/shape.rs:l_layout`. split_gap0 ở request được `imposition_preview_helpers.py:57-63` quy vềNone. Đã thử native đang cài và Python fallback: **cả hai đều trả24 với block15+5+4**.
6. Route `:4228-4229` finalize/căn giữa rồi `resolve_pont_collisions_on_placements`; `imposition_finalize.py:192+` gọi smart_resolve_collisions → response abs cells → GridPreview vẽ trực tiếp.
7. Export S&R dùng cùng finalize/resolver và precalculated placements; log job worker xác nhận21 trước/render. PDF thật đo được cùng toàn bộ21pose. Không suy parity chỉ từ tên helper.

## Finding

### RECTPACK21.01 — P1, effort M — Chấm sức chứa candidate đang đè nhau

**[CONFIRMED / AUTO + ARTIFACT]**

Trong Python `shape_layouts.py:680-705`, khối phụ bên phải dùng toàn chiều cao vùng in, khối phụ dưới dùng toàn chiều rộng vùng in. Hai vùng này giao nhau ở góc phải-dưới. Dòng721 ghép cả hai và728 xếp hạng bằng số ô chưa hợp lệ. Rust `shape.rs:910-934,975-986` có cùng cấu trúc.

Ca này:

| Bước | Khối chính | Khối phải | Khối đáy | Tổng |
|---|---:|---:|---:|---:|
| Candidate được chọn |15|5|4|24|
| Sau bỏ tem chồng |15|4|4|23|
| Sau né boong |14|4|3|21|
| Nghiệm hợp lệ đối chứng |18|5|0|23|

Hai item raw index19/23 (zero-based) chồng **1.492,556303mm²**, không phải tiếp tuyến hoặc nhiễu float. Candidate24 thắng candidate23 hợp lệ vì số lượng ảo lớn hơn. `collision.py:130-146` xóa tham lam sau đó, nhưng candidate đã bị loại khỏi cuộc so sánh không được gọi lại.

Không nói PDF cuối vẫn chồng tem: cleanup có loại ô chồng. Lỗi là **quyết định bố trí dựa trên count sai**, làm mất phương án tốt trước khi xuất.

### RECTPACK21.02 — P1, effort M — Né boong sau khi chốt winner, xóa/căn lại thay vì chọn layout hợp lệ tốt hơn

**[CONFIRMED / AUTO + ARTIFACT]**

Trước né boong có3placement va vùng cấm. Resolver giữ/điều chỉnh phần có thể giữ, xóa2 ô, còn21. `pont_collision.py:1137-1142` có đường reflow khối chính rồi trả; `:1223-1228` nhánh không interlock cạnh tranh kết quả dồn cột/dồn hàng. `_resolve_one_orientation:1231+` xóa rồi căn lại từng hàng. Nó không chạy lại danh mục grid/L-shape/phase trên toàn tờ.

Lỗi không phải “boong an toàn không cần thiết”. Không tắt boong, không giảm safety_padding3mm để lấy23. Vấn đề là tiêu chí chọn winner chưa nhìn thấy **số tem hợp lệ sau mọi ràng buộc**.

Nghiệm đối chứng dùng đúng boong, giữ23 và ít khối hơn. Vì vậy các khoảng trống lớn của layout21 không phải hy sinh bắt buộc cho boong.

### Vì sao nhìn rời rạc

Hệ thống tối ưu tuần tự: chọn số ô cao → xóa đè → xóa va boong → căn lại từng phần. Nó không so lại toàn cục sau các bước xóa, cũng không dùng độ đều hàng/số khối/số tem xoay làm tiêu chí phá hòa cuối cùng. Nhiều bước hợp lệ cục bộ ghép thành bố cục xấu và ít tem hơn.

Đổi sang “lưới đơn giản” không phải sửa đúng lỗi tối ưu: cùng điều kiện, lưới hướng gốc18 tem, lưới xoay20 tem, đều qua boong. Cần solver biết chọn bố cục hỗn hợp tốt, không ép toàn bộ về lưới và mất sản lượng.

## Nghiệm23 đã kiểm

Đơn vị mm; gốc trên-trái tờ:

```text
w = 80.051275
h = 64.99507222222222
Khối chính: x = 3.5 + c*w; y = (430-6*h)/2 + r*h
             c=0..2, r=0..5; rộng w, cao h; hướng gốc
Cột phải:   x = 3.5 + 3*w; y = (430-5*w)/2 + r*w
             r=0..4; rộng h, cao w; xoay90°
```

- 23 hình đều nằm trong vùng `[3,3]..[317,427]`mm.
- Kiểm độc lập từng cặp bằng Shapely:0 overlap.
- Kiểm độc lập từng hình với cả4 vùng boong:0 giao diện tích; khoảng cách nhỏ nhất tới vùng an toàn khoảng0.188mm, **ngoài vùng đệm3mm đã có**, không phải chỉ cách mép dấu mực0.188mm.
- Chạy thêm `detect_collisions` và `_has_any_sticker_overlap` của production:đều không có lỗi.
- Không co tem, không đổi kích thước trang/khổ giấy/hở0, không sửa bitmap/PDF nguồn. Dịch bố cục sang trái so với căn giữa mặc định để tránh boong; không cần đối xứng mép tuyệt đối nếu nó làm giảm sản lượng.
- Ảnh xếp tay23 mà người dùng bổ sung có cùng cấu trúc18+5, là đối chứng độc lập về topology; không lấy pixel screenshot thay các số đo PDF.

## Test và giới hạn

```powershell
# cwd D:/pdfcompare/backend
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_sticker_imposer.py tests/test_pont_collision_lshape_auxiliary_reflow.py tests/test_pont_collision_column_reflow.py tests/test_compute_layout_facade.py
```

**53 passed**,1cảnh báo Pydantic có sẵn. Test hiện có kiểm yield>=grid hoặc resolver an toàn nhưng chưa khóa ca23này. `test_sticker_imposer.py:131,138` không kiểm mọi cặp trong candidate raw trước khi so count. Không cập nhật snapshot để che lỗi.

Harness: `D:/printsolutions-main/product/xep quan ao/tmp/audit_untitled_layout.py`; số liệu đầy đủ `untitled-layout-evidence.json`, contact sheet `untitled-layout-compare.png`. Evidence gọn trong `docs/audit/RECTPACK_21_VS_23_2026-09-21.json`.

Mức bằng chứng: **ARTIFACT** trên job thật đã xuất và tái hiện production helpers. Chưa thao tác lại GUI, chưa build/restart, chưa kiểm máy bế thật; không gọi là nghiệm thu RUNTIME. Nghiệm23 hiện là geometry witness đã validate, chưa đưa vào PDF xuất mới hoặc code sản phẩm. Không tuyên bố mọi loại tem đã tối ưu.

## Hướng sửa đề xuất — chờ duyệt

1. Sửa sinh candidate L-shape **cả Python và Rust**: phân vùng phụ không giao nhau (phải toàn chiều cao + đáy giới hạn chiều rộng khối chính; hoặc đáy toàn chiều rộng + phải giới hạn chiều cao). Validate trước chấm count; giữ cả candidate hữu ích, không chỉ một winner raw.
2. So sánh candidate theo số tem hợp lệ sau boong/lề/hở; thử dịch toàn khối/phase hữu hạn trước khi xóa. Tái so khi cleanup làm giảm số lượng. Dùng cùng kết quả cho preview và export.
3. Khi bằng sản lượng: ưu tiên ít khối, hàng/cột thẳng, ít xoay, giữ hướng gốc; không hy sinh số tem chỉ để căn giữa đẹp. Khóa case này đạt ít nhất23 khi cấu hình giữ nguyên.

Lô sửa tối đa5file theo skill audit của dự án; mỗi lô có test+đo artifact. Không vá riêng kích thước80×65, không gán cứng23, không bỏ boong hoặc tăng dung sai để ép pass. Giữ các bản sửa VDP/viewer của người dùng.

## Kết quả triển khai và nghiệm thu (2026-09-21)

Đã triển khai bản sửa theo đúng đề xuất và được người dùng duyệt (`duyệt, tiến hành đi`):

1. **Phân hoạch hình học L-shape không giao nhau**:
   - `backend/app/workers/sticker_imposer_pkg/shape_layouts.py` và `imposition_core/src/shape.rs` đều áp dụng phân hoạch 2 phân vùng không giao nhau:
     - **Partition A**: Khối phải full chiều cao `[right_x, usable_w] × [0, usable_h]` + Khối đáy hẹp theo chiều rộng khối chính `[0, tbw] × [bottom_y, usable_h]`.
     - **Partition B**: Khối đáy full chiều rộng `[0, usable_w] × [bottom_y, usable_h]` + Khối phải thấp theo chiều cao khối chính `[right_x, usable_w] × [0, tbh]`.
   - Kết quả: Loại bỏ 100% hiện tượng sinh tem chồng lấn góc dưới-phải (0 mm² overlap). Không còn hiện tượng sinh 24 ô ảo.
2. **Tie-breaking thông minh**:
   - Cải tiến hàm so sánh ứng viên `candidate_is_better` / `l_candidate_is_better`: khi bằng sản lượng (`total`), ưu tiên theo độ hở `min(spare_x, spare_y)`, sau đó ưu tiên ít khối phụ hơn (`-n_blocks`), diện tích và chu vi.
3. **Cơ chế dịch toàn khối (whole-block shift) tôn trọng lề trang in**:
   - `backend/app/workers/pont_collision.py`: Cho phép `_try_whole_block_shift` chạy trước khi dồn hàng/xóa tem đối với bố cục L-shape/chữ nhật.
   - `backend/app/workers/imposition_finalize.py`: Truyền đúng `sheet_left/right/top/bottom` (3.0mm) thay vì nhầm với lề boong (7.0mm). Nhờ đó, bố cục 23 tem được dịch trái an toàn 4.0mm (tọa độ x từ 7.43mm $\to$ 3.43mm $\ge 3.0$mm lề in), mép phải lùi về cách boong an toàn và giữ trọn vẹn 23 tem mà không va chạm 4 vùng cấm boong.
4. **Biên dịch Native Rust**:
   - Đã biên dịch `pdfcompare_native` bằng `maturin develop --release` vào môi trường Python backend.
5. **Kiểm thử tự động (64/64 passed)**:
   - `backend/tests/test_rectpack_lshape_partition.py` (6 tests): kiểm tra độc lập 0 overlap hình học giữa mọi cặp tem trên cả Python và Rust, khóa kết quả 23 tem cho `Untitled-1.pdf` qua toàn bộ pipeline boong, kiểm tra 0 overlap qua các bước hở 0, 1, 2, 3 mm.
   - 58 tests regression (`test_sticker_imposer.py`, `test_pont_collision_lshape_auxiliary_reflow.py`, `test_pont_collision_column_reflow.py`, `test_compute_layout_facade.py`, `test_preview_export_parity.py`, `test_sticker_homogeneous_parity.py`): toàn bộ đều PASS.

