# Nhật ký sửa bù xén / shadow - 2026-09-05

Theo `BAO_CAO_AUDIT_BU_XEN_SHADOW_2026-09-05.md`; người dùng đã duyệt triển khai bằng yêu cầu "làm đi".

## Lô A - Bảo vệ thân tem trước khi nâng biên AI

**Trạng thái Lô A: source + kiểm thử + artifact đã verify; người dùng xác nhận "đã test, tiếp lô B".** Lô A riêng chưa sửa bộ loại bóng màu `§SHADOW.1`; kết quả Lô B ở cuối nhật ký. Chưa build/commit.

### Phạm vi 5 file

| File | Thay đổi |
|---|---|
| `backend/app/workers/sticker_artwork_guard.py` | Helper đánh giá từng cụm AI định bỏ, không thay mask/Alpha |
| `backend/app/workers/sticker_source_pipeline.py` | Gắn guard sau IoU; legacy không có canonical preview cũng đi qua cùng chốt |
| `backend/tests/test_sticker_ai_artwork_guard.py` | 42 ca hồi quy, có phát lại raw Alpha thật đã lưu trong audit, kiểm promote và PDF SMask |
| `docs/BU_XEN_SHADOW_FIXES_2026-09-05.md` | Nhật ký lô, đo trước/sau, giới hạn và bước nghiệm thu |
| `docs/PRYNX_MASTER_AUDIT_MATRIX.md` | Cập nhật riêng audit unit SHADOW, giữ các thay đổi của phiên khác |

Không chạm source nesting/auth, worker pool, cache/model của ứng dụng hoặc giới hạn chất lượng. Các ảnh evidence đã có từ lượt audit được dùng lại làm fixture; chúng cần đi cùng test khi commit sau này. Test PDF tự dựng từ raster đã capture, không phụ thuộc `test/test bu xen.pdf` vốn bị gitignore; file PDF khách gốc được kiểm riêng ở probe artifact dưới đây.

### Cơ chế bảo vệ `§SHADOW.2`

1. Giữ gate cũ: một instance và IoU >=0,80.
2. Chia phần `reference & ~candidate` thành từng cụm. Bỏ vùng nhiễu nhỏ; lấy lõi cụm cách biên hơn collar để không coi mép thân/bóng là chi tiết bên trong bóng.
3. Nếu lõi mất có nhiều chi tiết RGB thì từ chối ứng viên. Không dùng màu vàng/chroma làm chân lý vì bóng nâu cũng có màu.
4. Với mảng màu đặc: từ chối đoạn biên mới lùi sâu vào reference nhưng không có mép tương ứng trong RGB nguồn.
5. Giữ nguyên analysis `simple-bg` khi từ chối; đặt `needs_review` và warning `simple-bg-ai-artwork-loss-rejected`. Không trộn lại/nhị phân hóa Alpha. Vì boundary vẫn là simple-bg, promote không lưu raw Alpha AI sai cho thao tác Refine về sau.
6. Khi phép kiểm lỗi cấp phát/OpenCV/lưới dữ liệu, giữ mask nguồn và warning `simple-bg-ai-validation-unavailable`.
7. AI tốt tiếp tục giữ nguyên Alpha mềm và màu nền. Composite/Alpha/vector/CutContour đã chắc chắn không bị đưa thêm vào nhánh AI.

**Legacy đã được nối:** `build_legacy_single_page_approved_contour` trước đây gọi AI riêng, không qua IoU/guard. Khi đã có một reference simple-bg hợp lệ, nay dùng chung `_upgrade_single_simple_background_geometry`. Canonical preview và bộ writer không cần đổi.

### Những lần hiệu chỉnh có bằng chứng

- Test ca thật đỏ trước: backend trả `boundary_source='ai'`, ROI bên phải bị mất. Sau bản vá giữ simple-bg và toàn ROI.
- Bản helper đầu từ chối nhầm khi chỉ bỏ dải bóng thật ở ảnh 0,25x/0,5x vì độ dốc/pixel tăng khi thu nhỏ. Đã chuẩn hóa phép đo detail cả hai chiều phóng/thu; giữ contrast riêng cho phép đối chiếu biên. Khóa test 0,25x/0,5x/1x/2x: AI mất artwork bị từ chối, bỏ riêng dải bóng được chấp nhận.
- Ngưỡng hỗ trợ biên 6 từ chối bóng rất nhạt quanh thân gần trắng ở ba mức ảnh. Đo đối chứng ngưỡng 3 vẫn chặn notch qua vùng đặc nhưng giữ biên nhạt; bổ sung test riêng, không hạ assertion để làm xanh.
- Guard này là heuristic bảo thủ. Không bảo đảm bắt mọi chi tiết cực mảnh, lỗ trắng hoặc mọi mảng đặc nếu biên AI trùng một đường in thật. Trên file mẫu, chốt vùng phải từ chối toàn ứng viên, nhờ đó giữ cả phần trắng bên trong đã bị AI bỏ.

## Kiểm chứng trên PDF gốc của người dùng

Nguồn: `D:\pdfcompare\test\test bu xen.pdf`, SHA-256 trước/sau không đổi:

`C601B12447EF362A7F9EAE77AD18630A360E8150B8E85A5174C1A1CFBD10B08B`.

Probe chạy `inspect -> detect(auto, preview_only=False) -> promote -> preview -> confirm -> export_sticker_sheet_document -> mở lại bằng pikepdf -> render Poppler`. Phát lại **raw Alpha ONNX thật của lượt audit**, không chạy inference mới; đã assert toàn bộ RGB render hiện tại khớp ảnh RGB đã capture. Đây là bằng chứng detector/guard/writer source hiện hành, không phải thao tác Tauri/runtime model mới.

| Đại lượng | Trước Lô A | Sau Lô A |
|---|---:|---:|
| Boundary được nhận | AI | simple-bg, có warning từ chối AI |
| ROI thân x=[495,520), y=[198,224): pixel đục trong SMask PDF | 0/650 | **650/650** |
| Lá xanh tại (550,210): Alpha PDF | 0 | **255** |
| Raw AI sai được mở lại qua Refine | Có dữ liệu raw AI | **Không**; `refinement_available=false` |
| Trang / CutContour của PDF | 1 / 1 | **1 / 1** |
| Số đường / segment preview sau sửa | - | 1 / 35 |
| Bóng tại (295,590): Alpha PDF | 0 trong mask AI bị khuyết | **255**, còn giữ ở fallback |

Lưới phân tích 591 x 594, DPI 300,228 x 300,0973. Thiết lập probe: original, offset/bleed 0 mm, preserve, đặc ruột, không crop; smoothness/fidelity/tension 50, denoise 50, min detail 1 mm². Đã soi PNG render: thân tem bên phải nguyên vẹn, bóng dưới vẫn còn. **Đây chưa phải artifact đã loại bóng để đưa in.**

Số segment không phải bằng chứng chất lượng máy bế toàn diện; chưa đo máy vật lý. Probe tạm đã dọn sau khi xác minh, số đo giữ ở nhật ký này; evidence trước sửa vẫn nguyên.

## Verify

```powershell
# D:\pdfcompare\backend
.\venv\Scripts\python.exe -X utf8 -B -m pytest -q -p no:cacheprovider tests/test_sticker_ai_artwork_guard.py
# 42 passed, 1 warning, 6,20 giây

.\venv\Scripts\python.exe -X utf8 -B -m pytest -q -p no:cacheprovider tests/test_sticker_source_pipeline.py tests/test_sticker_sheet_engine.py tests/test_sticker_cutline_preview.py tests/test_sticker_sheet_api.py::test_detect_preview_only_truyen_hop_dong_fast_path_den_pipeline --basetemp=../tmp/shadow_guard_regression_verified --junitxml=../tmp/shadow_guard_regression_verified.xml
# 122 passed, 2 warnings, 15,97 giây; JUnit: failures=0, errors=0, skipped=0

.\venv\Scripts\python.exe -X utf8 -B -m py_compile app/workers/sticker_artwork_guard.py app/workers/sticker_source_pipeline.py tests/test_sticker_ai_artwork_guard.py
# đạt
```

Tổng hai tập không trùng: **164 passed**. Warning Pydantic/Starlette-httpx có sẵn. Lượt regression đầu bị wrapper bỏ mất session handle; số 122 ở trên lấy từ lượt chạy lại có exit code/JUnit, không suy từ dấu chấm tiến độ.

`git diff --check` đạt. Chưa chạy full backend, frontend typecheck/Vitest mới, Tauri hoặc installer; lô chỉ đổi backend, không đổi UI/API schema/Rust. Không cập nhật golden/snapshot hiện hữu, không tải model, không can thiệp tiến trình app/dev server.

Hash source đã verify:

- Guard: `FAFCA80F3E686BC5F91A4EA6313648326074D29F1A9F0B03B3AC21FC7F281292`.
- Pipeline: `765A63B33C3BE499DFD5990D919DFF198CD653B16039000FB4DC2D90FF6E33B6`.
- Test: `DB242E1D52FE03969B48D0B7C17D8690D1096B654D38FE29203D5B348388FF8B`.

## Chốt nghiệm thu và phần còn lại

Theo `prynx-audit-workflow`, chờ người dùng xác nhận chạy thật Lô A trước khi chuyển Lô B. Sau khi backend bản dev nạp source mới, **mở/nhận diện lại PDF trong session mới**; session đã promote từ trước vẫn có mask cũ và không tự được sửa.

Kiểm: Tách nhiều tem -> nhận diện -> mảng bên phải phải còn nguyên -> preview -> xác nhận -> xuất/mở lại. Lựa chọn Khử bóng có thể không hiện khi đã rơi về simple-bg, vì không được dùng lại raw AI sai; đây chưa phải bước khử bóng màu.

Ở cuối Lô A, `§SHADOW.2` đã có guard và artifact đúng vùng thân cho ca mẫu; người dùng đã xác nhận chạy thử. `§SHADOW.1` được tiếp tục trong Lô B dưới đây. Lô C UX vùng mơ hồ chưa triển khai.

## Lô B - Biên bóng mềm có màu dùng chung (2026-09-06)

**Trạng thái: đã triển khai và verify source + 197 test + PDF gốc; chờ nghiệm thu trên ứng dụng.** Không tự làm Lô C, không build bản cài đặt.

### Phạm vi 5 file

- Thêm `backend/app/workers/sticker_shadow_boundary.py`.
- Sửa tiếp `backend/app/workers/sticker_source_pipeline.py`.
- Mở rộng `backend/tests/test_sticker_ai_artwork_guard.py` thay vì tạo thêm fixture/file test rời.
- Cập nhật nhật ký này và `docs/PRYNX_MASTER_AUDIT_MATRIX.md`.

### Cách nhận diện và các chốt bảo vệ

1. Chỉ xử lý nhánh `auto/simple-bg` có nền phẳng, sau các nhánh white-offset/composite đã có. Không sửa `detect_background` dùng chung, không thay vector/CutContour/Alpha sạch.
2. Mỗi component có ROI và các tem hàng xóm làm vật cản. Phép loang 4 hướng chỉ gieo từ nền đã biết, so RGB với điểm kề để đi qua gradient bóng; không gieo trên artwork đang chạm mép ảnh.
3. Ứng viên phải giữ ít nhất 80% diện tích, ổn định giữa hai mức loang, có dải bị bỏ đủ dày và có biến thiên màu phù hợp với bóng mềm. Các lỗ JPEG 2..6 px nằm trong bóng không được tính như lỗ bế; chốt lỗ có ý nghĩa dùng mức 64 px đã có ở Refine.
4. Không coi mảng màu phẳng là bóng: viền hồng JPEG cũ chỉ có dải màu p90-p10 = 7, trong khi mẫu bóng nâu hơn 100. Chốt này giữ nguyên test halo/no-shadow cũ và nhánh AI Alpha mềm của nó.
5. Bảo vệ tai và viền: kiểm bước nhảy qua **mép reference gốc** so với bước đi tiếp vào trong; chặn cung mép in thật bị bỏ. Thêm chốt vùng mất kéo quá xa thân còn lại và kiểm đảo chiều màu theo pháp tuyến, để không xuyên qua bóng rồi ăn luôn vành sáng.
6. Giữ chốt artwork Lô A. Không đủ bằng chứng thì `None`/fallback, không đoán hình tròn, không hardcode màu vàng và không tự union mask AI.
7. Tạo dải Alpha mềm nhưng giữ nguyên membership ở ngưỡng 128. Các component không được cải thiện giữ Alpha nguồn; đối chiếu ID/overlap với labels gốc để bỏ bóng không đảo thứ tự tem.
8. Marker `simple-bg-colored-shadow-removed` ngăn classic/multi/legacy gọi AI đè lại biên sạch. Marker `simple-bg-drop-shadow-removed` dùng đúng profile fitter/fringe đã có; không gắn marker denoise-fallback cho biên đã khử bóng.

Không thêm cap RAM/worker/cache hoặc hạ lưới ảnh. Bảng ngưỡng trong helper là tiêu chí chấp nhận hình học/màu, không phải giới hạn hiệu năng máy mạnh.

### Vòng đỏ - xanh và lỗi trung gian đã loại

- Hai test chế độ đỏ trước: classic còn Alpha 255 ở điểm bóng; multi gọi AI trong khi ca này phải có thể dùng biên deterministic.
- Bản thử đầu làm test `test_auto_mot_tem_dung_ai_cho_hinh_hoc_va_giu_mau_nen_khi_xuat` đỏ vì nhầm viền hồng phẳng thành bóng. Đã sửa bằng bằng chứng biến thiên màu, **không đổi kỳ vọng của test hiện hữu**.
- Probe độc lập phát hiện tai màu nhạt bị xóa, kể cả JPEG95. Guard lõi/IoU và đảo chiều màu không đủ vì pháp tuyến còn nằm trong tai dài. Đã thêm kiểm mép gốc và khóa các ca tai 15..69 px, cao 3..13 px; giữ trọn tai hoặc fallback.
- Khoảng cách phía ngoài candidate ban đầu dùng zero-padding, vô tình coi mép ROI là thân tem. Đã tách `_distance_to_candidate` không padding và thêm regression: điểm ở mép ảnh phải cách thân 7 px, không phải 1 px.
- Ở ảnh 0,25x, một điểm sát biên có Alpha=1 do dải AA. Test scale kiểm điểm nằm ngoài silhouette (`<128`), không ép Alpha mềm về nhị phân. Test nguồn gốc vẫn yêu cầu hai điểm bóng bằng 0; writer multi cũng xóa Alpha ngoài labels.
- Test Lô A vẫn giữ nguyên oracle mask cũ/IoU 0,89 bằng cách cô lập trường hợp helper bóng trả None. Test Lô B đi qua helper thật, không dùng bypass đó.

### Đúng PDF khách, không gọi AI

Nguồn `D:\pdfcompare\test\test bu xen.pdf`, SHA-256 vẫn:

`C601B12447EF362A7F9EAE77AD18630A360E8150B8E85A5174C1A1CFBD10B08B`.

Đã chạy `inspect -> detect -> promote -> preview` rồi cả hai đường xuất:

- Classic: `snapshot_classic_cutline_preview -> StickerEngine.process_pdf -> restore_sticker_page_canvas`.
- Multi: `confirm -> export_sticker_sheet_document`.

Chạy cả bleed 0 và 2 mm, offset 0, original/preserve/đặc ruột/không crop; smoothness/fidelity/tension 50, denoise 50. Ở probe, lời gọi AI được thay bằng hàm báo lỗi ngay nếu chạy; **0 lời gọi AI**, không phải phát lại raw Alpha như Lô A. Không gọi route HTTP/Tauri hay watermark/licensing.

| Đại lượng | Sau Lô B |
|---|---:|
| Diện tích silhouette | 273.962 px (reference trước 284.623 px) |
| Alpha điểm bóng (295,590) / (200,578), nguồn 591 x 594 | 0 / 0 |
| ROI phải 650 px | 650/650 đục |
| Lá xanh (550,210) | Alpha 255 |
| Alpha classic/multi | bằng nhau từng byte |
| Đường preview classic/multi với cùng thiết lập | bằng nhau |
| Mỗi PDF mở lại | 1 trang, 1 CutContour |
| Đường preview | 45 segment; không short segment/join rời/cusp không bảo vệ theo oracle hiện có |
| Sai lệch fitter báo cáo | 0,10415 mm; không phải chứng nhận máy bế vật lý |

Đã đọc lại image/SMask và render đủ 4 PDF bằng Poppler, soi toàn trang: đường cắt bám vành vàng, hình bên phải nguyên vẹn. Multi có SMask vùng bóng 0 và ROI thân 255 ở cả bleed 0/2; classic giữ artwork gốc 594 x 594, không tự thay bằng ảnh AI. Bù xén 2 mm lấy vùng mực viền, không lấy cả bóng làm footprint.

**Giới hạn quan trọng của quy tắc xuất giữ nguyên:** ở classic, bleed=0 vẫn có thể thấy bóng trong artwork gốc **ngoài CutContour**. Bản vá sửa biên nhận diện/đường dao, không thay quy tắc giữ artwork gốc của classic. Multi xuất RGBA nên bóng ngoài biên bị xóa khỏi Alpha. Không tuyên bố hai PDF giống từng pixel hoặc đều trở thành ảnh đã xóa nền.

Hash bốn artifact đã kiểm (probe tạm dọn sau verify):

- Classic 0 mm: `62ED38A20D17835067C8A447D08C39E442684164F09E99DB3CAD2C02BA45B841`.
- Classic 2 mm: `5F4C78FDDB8B52A02F4946387790EFC17EDA251BCBCF67F8F02C6BB660EF247AB`.
- Multi 0 mm: `0BB699971892854BE3F5AF54317D279CE1C15FDB44BEF58BF051574F9FBA76B0`.
- Multi 2 mm: `C35AFA14601C799C5ED03FD87FA524B6735F48C215F45246323D76685FF59F13`.

### Verify cuối

```powershell
# D:\pdfcompare\backend
.\venv\Scripts\python.exe -X utf8 -B -m pytest -q -p no:cacheprovider tests/test_sticker_ai_artwork_guard.py tests/test_sticker_source_pipeline.py tests/test_sticker_sheet_engine.py tests/test_sticker_cutline_preview.py tests/test_sticker_sheet_api.py::test_detect_preview_only_truyen_hop_dong_fast_path_den_pipeline --basetemp=../tmp/shadow_b_complete --junitxml=../tmp/shadow_b_complete.xml
# 196 passed, 2 warning có sẵn, 27,34 giây; 0 fail/error/skip

.\venv\Scripts\python.exe -X utf8 -B -m pytest -q -p no:cacheprovider tests/test_sticker_ai_artwork_guard.py::test_lo_b_giu_id_theo_vi_tri_khi_nhieu_tem
# Thêm ca ID nhiều tem sau lượt trên: 1 passed, 1 warning, 1,42 giây

.\venv\Scripts\python.exe -X utf8 -B -m py_compile app/workers/sticker_shadow_boundary.py app/workers/sticker_source_pipeline.py tests/test_sticker_ai_artwork_guard.py
# đạt
```

Tổng 197 ca không trùng: 75 test trong module A+B và 122 regression/contract. Đã giữ các test màu viền, Alpha mềm, composite, white-shell, vector/banner, CutContour sẵn và canonical cache. Bộ mới còn kiểm scale 0,25x..2x, notch, lỗ, component không bóng cạnh component có bóng, tai nhạt PNG/JPEG, viền sáng 235..239, ID và parity hai chế độ. `git diff --check` đạt; không update golden/snapshot cũ.

Hash source cuối:

- Shadow helper: `71C4EC0C9803C9B930BAD719EA68E42255BF542D6E3DE4848A5CD04AD37348BD`.
- Pipeline: `4693A4B0C9C8256E62F8131EC7A5D7640EE98DAAB60E09DB53E14369F59C6AFE`.
- Test: `6A9CDFCEE8108CEF82BC58EDEBA291D7A66FB66381DB41813706B392FF53755D`.

### Phạm vi còn mở

- Chưa thao tác Tauri/installer/máy bế; chưa build bản cài đặt, không commit. Người dùng cần backend dev nạp source mới và mở/nhận diện lại nguồn trong session mới.
- Cơ chế mới dành cho nền phẳng + biên bóng mềm đủ bằng chứng. `strategy='ai'` tường minh và nhánh nền thiếu tin cậy vẫn dùng pipeline AI/khử bóng trung tính hiện hữu; không mô tả chúng là đã được thay toàn bộ.
- Bóng quá rộng, biên hòa màu, hiệu ứng in cố ý giống bóng hoặc dữ liệu quá ít có thể fallback. Không bảo đảm tự phân biệt mọi ảnh AI; giữ review/chỉnh tay.
- Lô C về biểu diễn vùng mơ hồ/cọ chưa triển khai. Không đổi chủ đích ẩn warning hiện có trong UI trong lô này.
