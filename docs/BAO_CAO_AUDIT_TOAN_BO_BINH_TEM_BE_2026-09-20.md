# Audit chức năng toàn luồng Bình tem bế - 2026-09-20

Trạng thái cập nhật: người dùng đã duyệt “sửa hết đi”; BE.01–BE.08 đã triển khai và nghiệm thu SOURCE + AUTO + ARTIFACT. Xem [nhật ký sửa](BINH_TEM_BE_AUDIT_FIXES_2026-09-20.md): 1005 backend + 342 frontend đạt, TypeScript đạt, đã kiểm14 trang PDF thực. Chưa nghiệm thu cửa sổ desktop/installer/máy bế. Nội dung phát hiện bên dưới giữ làm bằng chứng trước sửa.

## 1. Kết luận

Xác nhận **8 nhóm lỗi chức năng**, trong đó 7 nhóm P1 và 1 nhóm P2. Ưu tiên đầu tiên là hai đường xuất có thể mất mẫu nhưng vẫn báo thành công.

| Mã | Mức / effort | Lỗi đã tái hiện |
|---|---|---|
| BE.01 | P1 / M | Tránh boong ở bước ghi PDF loại mẫu mà không phân tờ lại: preview 9, PDF 7 |
| BE.02 | P1 / S-M | Nhánh tối ưu legacy không chặn đơn hàng có mẫu quá khổ; xuất thiếu và báo thành công |
| BE.03 | P1 / M | Chọn lưới tùy chỉnh 2x2 nhưng N-Up xuất 5 ô/tờ, Bình trang xuất 9 ô/tờ |
| BE.04 | P1 / S-M | Đổi nguyên tấm sang từng tem để lại cut_stacks ẩn, khóa SL nhưng backend vẫn nhân số lượng cũ |
| BE.05 | P1 / S | SL chung trống + SL riêng 0 bị hiểu thành 1, không loại mẫu đã nhập 0 |
| BE.06 | P1 / M | N-Up tối ưu một loại, SL=1: preview vẽ 9 ô nhưng PDF có 1 |
| BE.07 | P1 / M | Báo cáo sản xuất tính từ sức chứa/SL ẩn, không từ số thật: 30 thành 36; 70 loại thành yêu cầu 7000 |
| BE.08 | P2 / M | Nhánh lưới đơn giản bỏ qua exportUniqueSheets: preview 2 bố cục, PDF vẫn chứa 4 tờ vật lý |

BE.05, BE.07a và BE.08 nằm ở hoặc liên quan trực tiếp tới nhánh lưới N-Up vừa bổ sung. Không quy tất cả cho code legacy. Bản vá Xếp chồng lấp kín không giải quyết được chốt boong ở writer hoặc các hợp đồng report còn lại.

Không kết luận “toàn công cụ hết bug”. Audit này xét tính đúng của workflow sản xuất; không thay cho pentest, audit dependency/CVE, benchmark tất cả tier RAM, kiểm bản cài hoặc nghiệm thu dao bế vật lý.

## 2. Baseline và nguồn bằng chứng

- HEAD lúc audit: `0c8a347`; đọc nội dung working tree đang có thay đổi, không coi HEAD là toàn bộ mã đã kiểm.
- Windows thật; backend dùng `D:/pdfcompare/backend/venv/Scripts/python.exe`; frontend dùng node_modules Windows.
- Không sửa production code, không đổi native/DLL, không cập nhật snapshot, không commit/push/restart hay dừng tiến trình người dùng.
- Probe chỉ tạo PDF tổng hợp ở workspace ngoài repo. Không ghi đè PDF của người dùng.
- Đã đọc AGENTS, architecture, imposition, audit-workflow, deep-audit, testing, conventions, audit-rules và các báo cáo M72/CS.FILL liên quan.
- Chốt phê duyệt theo skill audit: báo cáo này chưa cho phép tự sửa tiếp.

SHA256 tại thời điểm kiểm:
- nup_engine.py: `C494FB34CC7F0C537165F129882AA23746CB7821CE37B9E88E495746B21396B7`
- sticker_grid_order.py: `BAFC8A0E3FAFBD243A816CD86F2BF9A2AA9DA36702E3870DD4E2B64506E27F90`
- routes/imposition.py: `C8B3F96622B6BC8CE4CFACF54EE7108FCA27184BF28139FA86D39655F55A6B3F`
- GridSettingsSection.tsx: `817D8D614C325F7D3A8A4A79B6C9B6C6400DE604555349509A2AD296C7F10E02`

## 3. Các đường chạy đã nối

T0 - UI/payload: GridSettingsSection → store/slices/nupSlice.ts → ImposerDashboard.handleExecute (:1713) → ImpositionTab.handleStartNup (:3236, columns→cols :3269) → lib/processHandlers.runProcessEngine (:223, payload :317-404).

T1 - Preview: GridPreview (:2434 payload, :2729 fetch) → /imposition/preview-layout (routes/imposition.py:2115) → nhánh simple (:2363), multi (:2402, :2790), single (:3947) → response cells/sheets → GridPreview svgCells (:3154), visibleCells (:3312). N-Up tem bế không được cắt bớt số ô bằng _nupTotal vì _isNupFill đòi !isDieCut (:3033).

T2 - Xuất legacy/lưới: /imposition/nup-start (:1339), router đăng ký ở main.py:382 → run_nup_engine (:252) → _run_nup_engine_impl (:311) → nup_process_chunk.process_chunk → nup_output_finalize.finalize_nup_output (:591) → PDF IN/CUT → viewer/save-plan/report đọc lại.

T3 - True-shape: GridPreview job API → nesting_preview_jobs / nesting_preview_capacity → nup_true_shape_nesting → nesting_production_pipeline → native baseline/validator → nesting_imposition_render; order gate ở nesting_order_plan và chốt handover/session. Bộ test hiện hành đã chạy nhưng không tuyên bố tương đương toàn bộ T2.

Lưu ý alias: nup_sticker.py chỉ re-export sticker_imposer_pkg/layout_compute.py. Việc import khác tên không phải bằng chứng khác solver.

## 4. Phát hiện đã xác minh

### BE.01 [CONFIRMED/VERIFIED] P1 - mất mẫu sau tránh boong

- Entry/consumer: T0 → T1 preview nguyên tấm; T2 → nup_process_chunk.py:858-955 gọi smart_resolve_collisions rồi dùng danh sách ngắn hơn để ghi PDF. pont_collision.py:1099 có chiến lược xóa tối thiểu + canh giữa.
- Bất biến: tránh boong không được âm thầm làm mất loại/SL đã được đưa vào kế hoạch.
- Ca: 9 trang 70x70 mm; tờ 226x226, lề 5, hở 2; boong tròn 5 mm cách mép 7 mm; simple_auto.
- Từng tem: preview [5,4], PDF [5,4], đủ 9.
- Nguyên tấm decal: preview [9], plan đủ trang 0..8, PDF chỉ 7 artwork. Các Form được vẽ là source 3,0,7,4,1,5,2; mất source 6 và 8 (mẫu số 7 và 9).
- Tái hiện cả sequential và cut_stacks. Engine vẫn trả “Hoàn tất! Xuất thành công”.
- Đã parse Do/Form và xem PNG IN/CUT: không chỉ là counter preview sai, file thật bị đổi hình học và mất mẫu.
- Đề xuất: đưa vật cản vào kế hoạch trước phân tờ; sau mọi điều chỉnh hình học phải đối soát từng loại. Nếu không có kế hoạch đủ lượng, chặn xuất thay vì hoàn tất một file thiếu.

### BE.02 [CONFIRMED/VERIFIED] P1 - mẫu quá khổ chỉ ghi log

- Entry/consumer: T0 optimal_auto → T1 imposition.py:3253 solve_offset_mixed; T2 nup_engine.py:2398-2487. _ms_missing chỉ logger.error, không raise. Finalizer :617 vẫn tạo thông báo thành công.
- Ca: hai mẫu chữ nhật 70x70 và 300x70 mm, vùng dùng 216x216; mỗi loại 1. Mẫu thứ hai không vừa kể cả xoay.
- simple_auto chặn đúng ở preview và export.
- optimal_auto legacy trả sheets [[0],[]], export thành công ra PDF 3 trang: IN có mẫu 0, CUT của mẫu 0 và một trang trắng. Mẫu 1 không được sản xuất.
- Đã parse và render cả ba trang.
- Đề xuất: chốt đủ lượng dùng chung trước writer; missing/unplaced phải thành lỗi nghiệp vụ có tên mẫu. Không dựa vào log mà người dùng không thấy.

### BE.03 [CONFIRMED/VERIFIED] P1 - lưới tùy chỉnh không được thực thi

- Entry: GridSettingsSection.tsx:529-538 có option manual. Columns/rows được truyền thật qua ImpositionTab.tsx:3269 và processHandlers.ts:330, không phải mất field ở frontend.
- Consumer: nhánh sticker simple chỉ nhận simple_auto (sticker_grid_order.py:14); manual rơi vào nup_engine.py:863 và multi-sheet bin-pack :2398. layout_compute.py:16 nhận strategy nhưng không nhận số hàng/cột.
- Ca N-Up: 10 mẫu 70x70, mỗi loại 1, vùng 216x216, nhập 2x2. Preview bin_pack_mixed và PDF đều 5+5 ô; đúng lưới 2x2 phải tối đa 4 ô/tờ.
- Ca Bình trang: một mẫu, SL=12, manual 2x2. Preview và PDF tờ mẫu đều 9 ô; report yêu cầu in tờ đó 2 lần (18 tem).
- Đã xem PDF N-Up: có ba ô ở hàng trên, không phải 2x2.
- Đề xuất: lane manual riêng dùng đúng hàng/cột hoặc thông báo không hỗ trợ; không lặng lẽ đổi sang bộ ghép tự động. Không chỉ thay nhãn.

### BE.04 [CONFIRMED/VERIFIED] P1 - trạng thái cách ráp ẩn vẫn điều khiển job

- Entry: setImpositionUnit ở nupSlice.ts:96 chỉ đổi đơn vị/profile; không chuẩn hóa layoutType.
- Consumer UI: GridSettingsSection.tsx:142 khóa SL theo cut_stacks nhưng :339 ẩn cách ráp ở Từng tem. Sau chuyển đơn vị, không còn điều khiển để sửa trạng thái này.
- Consumer chạy: Dashboard.tsx:1716-1718 và :1761 vẫn gửi layoutType/targetQuantity; safety effect :734 chỉ sửa repeat, không sửa cut_stacks/ratio_stack. sticker_nup_policy + simple_grid vẫn dùng targetQuantity.
- Probe component/store thật: bắt đầu page_sheet + cut_stacks + SL cũ 100; chuyển sang sticker → layoutType vẫn cut_stacks, input SL disabled, combobox cách ráp biến mất, vẫn hiện lời “mỗi trang đúng một lần”.
- Log runtime đã có trên máy (preview_perf.log, 05:48:22–05:48:30): cùng file 72 trang, is_die_cut=True, cut_stacks, simple_auto, target_qty=100 → sheets=300, items=7200. Không coi đây là click-smoke do agent thực hiện; trace UI riêng xác nhận đường reachable.
- Đề xuất: chuẩn hóa task/layout theo đơn vị ở một nguồn chung khi chuyển/restore; không xóa SL đã nhập, nhưng phải hiển thị cho người dùng sửa. Backend từ chối tổ hợp không hỗ trợ.

### BE.05 [CONFIRMED/VERIFIED] P1 - số 0 tường minh biến thành 1

- Entry: GridSettingsSection.tsx:948-969 cho nhập số riêng min=0; xóa ô thì xóa key, nhập 0 thì lưu 0. Hai ý định phân biệt được ở UI.
- Consumer: sticker_nup_policy.py:39-59 empty_order suy từ SL chung=0 và không có override dương; override=0 bị nâng thành 1.
- Ca 3 mẫu, SL chung trống (0), targetQuantitiesByPage={"0":0}: preview, plan và PDF vẫn có cả 3 mẫu. Loại số 1 đã nhập 0 vẫn in một bản.
- Test hiện có với global dương không bảo vệ ca này. Việc tương thích profile cũ không đủ căn cứ để đổi mọi số 0 mới nhập.
- Đề xuất: tách migration cấu hình cũ khỏi hot path; giữ undefined/trống khác 0. Cấm đơn hàng rỗng phải báo rõ thay vì tự sinh mẫu.

### BE.06 [CONFIRMED/VERIFIED] P1 - N-Up một loại vẫn preview theo sức chứa đầy

- Entry: T0 Từng tem, N-Up, optimal_auto, một trang, SL=1.
- Consumer: imposition.py:2402 chỉ đi is_nup_multi khi >1; nhánh single :3947 gọi bộ xếp sức chứa không áp lượng N-Up. Export đã áp lượng=1.
- Ca 70x70 trên vùng 216x216: API trả 9 cells (3x3), PDF chỉ một artwork và một khuôn ở giữa.
- Consumer UI không che lỗi: _nupTotal chỉ áp !isDieCut; visibleCells ở GridPreview.tsx:3312 giữ nguyên các ô với tem bế.
- Regression hiện có cũng tái hiện 13/12 ô preview so với 1 khuôn PDF ở hai cấu hình kích thước.
- Đề xuất: preview lấy cùng kế hoạch lượng với export cho cả N=1, phân biệt capacity với placedCount. Không sửa bằng việc in thêm trái SL.

### BE.07 [CONFIRMED/VERIFIED] P1 - report không mô tả lượng thực

a. N-Up lưới đơn giản:
- Consumer: nup_output_finalize.py:434-471 lấy max số ô trên các tờ và tổng tờ, compute_report_data nhân capacity x sheetCount.
- Ca một loại SL=30, capacity=9: PDF thật 9+9+9+3; trên PDF lại ghi “SL thực: 36”. Tờ cuối chỉ 3 ô nhưng ghi “SL/tờ: 9”.
- Parse text và xem PNG tờ cuối đều xác nhận. Đây không phải bản dư được duyệt cho cut_stacks.

b. Xếp chồng nguyên tấm:
- Consumer: nup_engine.py:825-845 cộng targetQuantity đã bị UI vô hiệu hóa.
- Ca 70 loại, SL cũ 100, cut_stacks: 80 artwork là đúng theo in bù đã duyệt, nhưng thông báo LỆNH IN ghi “7000 tấm decal — SL/tờ 20 → in 4 tờ”.
- Report IN vẫn ghi SL thực 80, tạo hai nguồn số liệu mâu thuẫn.
- Đề xuất: report lấy từ kế hoạch có requested/placed/extra/physical/template/runCount; mỗi tờ phải có số con thực và số lượt in đúng. Không tính ngược từ sức chứa lớn nhất.

### BE.08 [CONFIRMED/VERIFIED] P2 - xuất tờ duy nhất bị bỏ qua ở simple N-Up

- Entry: Dashboard.tsx:1771 bật exportUniqueSheets cho sticker; processHandlers.ts:403 giữ true.
- Consumer preview: sticker_grid_order.py:112-141 gộp recipe bằng nguồn và cấp runCount.
- Consumer export: nup_engine.py:849-863 đưa toàn bộ simple_order.placements vào writer, không áp cờ unique; khác nhánh legacy :2433.
- Ca một loại, 30 bản, capacity 9, exportUniqueSheets=True: preview 2 bố cục, runCount [3,1], 4 tờ vật lý. PDF lại 8 trang = 4 IN + 4 CUT thay vì 2 cặp mẫu.
- Đề xuất: một kế hoạch recipe chung cho preview/writer/report. Chế độ expanded vẫn được xuất đủ mọi tờ; unique chỉ bỏ tờ trùng, không bỏ loại hoặc tờ bù.
- Chưa đo hiệu năng file lớn; không khẳng định phần trăm tăng dung lượng/thời gian.

## 5. Những điều không gọi là lỗi / khoảng trống

[EXPECTED]
- In dư lấp kín cut_stacks nguyên tấm được người dùng duyệt. Không yêu cầu bỏ chính sách này.
- 70/72 loại dưới cut_stacks không boong va chạm: 4x20 đúng, nguồn + bản bù giữ thứ tự.
- S&R/Bình trang in tờ mẫu nhiều lần có thể dư lượng; không áp bất biến N-Up exact-quantity lên S&R.
- Từng tem simple đã không gọi nesting và giữ đủ số lượng trong các ca đã đo; lỗi BE.03 thuộc manual.
- Khác nhau giữa capacity hình học và số đã đặt không tự nó là lỗi: homogeneous UI có nhãn riêng “Sức chứa”/“Đang ghép”. Test đòi cells.length == capacity có thể lỗi thời, không gắn P1 chỉ vì assert đỏ.

[SUSPECTED / CHƯA NGHIỆM THU]
- Chưa click trên app thật: chuỗi nhiều tab, materialize trong lúc sửa trang, đổi loại giấy, đóng tab khi export, restart/profile cũ và bản cài.
- Chưa kiểm thiết bị Illustrator/CorelDRAW/Graphtec thật; test mock không chứng minh handoff ứng dụng ngoài.
- Chưa làm benchmark cold/warm nhiều lần trên corpus hình phức tạp/tất cả tier RAM.
- Canonicalization fail-open và các HOLD lịch sử trong master matrix không được tự đóng bởi audit này.
- Chưa audit toàn bộ chế độ tạo đường bế trong công cụ tiền xử lý StickerTool; đây là công cụ khác với Bình tem bế. Boundary nhận trang/khuôn đã được kiểm bằng các fixture cùng test nup/source/holes.

## 6. Kiểm thử thực tế

Không sửa test để ép xanh.

| Lượt | Kết quả | Diễn giải |
|---|---|---|
| Backend A, 27 file | 622 pass / 6 fail (628 test) | 5 kỳ vọng cũ quanh N-Up trống/autofill/sparse-map; 1 Hypothesis health-check sinh dữ liệu chậm |
| Rerun Hypothesis riêng, seed 296795324194234433734047607357467286158 | 19 pass | Lỗi health-check không tái hiện khi chạy riêng; không tính thành lỗi sản phẩm |
| Backend B, 15 file, chạy hết | 274 pass / 12 fail (286 test) | Có lỗi parity thật BE.06; còn các kỳ vọng autofill/flag/so capacity với placed đã cũ. Không đánh đồng 12 fail với 12 lỗi mới |
| Frontend imposition-tools, 27 file | 332 pass / 1 fail (333 test) | OpenInDesignModal Free: test không tìm thấy chuỗi notice; guard chặn launch vẫn đạt trước assertion đó. Chưa có bằng chứng bypass quyền |
| UI probe đổi đơn vị | 1 pass | Test chẩn đoán xác nhận hành vi lỗi BE.04, không phải test nghiệm thu |
| npm run typecheck | đạt | Kiểm tĩnh, không thay cho runtime |

Backend B đã có lượt dừng sau 8 fail/18 pass trước khi chạy hết; không cộng lượt này vào số kiểm thử cuối. Không cộng các rerun chồng lấp thành tổng test “đạt”.

Đã kiểm các nhóm: số lượng/multi-sheet, nguyên tấm, homogeneous, S&R, master một khuôn, clip/holes, page boxes/canonical cleanup, report, unique, phiên/handover/manifest, cancel/lifecycle, entitlement và các điều khiển panel.

## 7. Ma trận audit unit

Ngày tất cả hàng: 2026-09-20, nguồn working tree tại HEAD nêu trên. T0/T1/T2/T3 là đường liên kết đã định nghĩa ở mục 3.

| Unit | Đường từ entry đến consumer | Hợp đồng/biên đã kiểm | Mức bằng chứng và việc còn lại |
|---|---|---|---|
| W2-ST20-01 | T0 setter → T1/T2, store/panel/payload | đơn vị sticker/page_sheet, mode ẩn, SL cũ | AUTO UI + log backend; BE.04; cần click-smoke sau sửa |
| W2-ST20-02 | T0 SL → sticker_nup_policy → T1/T2 → PDF | trống/0/1/SL riêng, đúng loại và lượng | ARTIFACT; BE.05; cần oracle migration |
| W2-ST20-03 | T0 manual → layout_compute/bin-pack → T1/T2 → PDF | 2x2, N-Up/S&R, giữ hướng/lưới | ARTIFACT; BE.03; cần kiểm cả manual ngoài phạm vi tem |
| W2-ST20-04 | T0 N=1 → single preview → T2 → SVG/PDF | một loại, SL=1, cells thực so capacity | ARTIFACT + consumer TRACED; BE.06; chưa GUI |
| W2-ST20-05 | T0 boong → T1/T2 → smart_resolve → PDF IN/CUT | lề 5/hở 2/boong 5, mẫu 7/9, sequential/cut_stacks | ARTIFACT; BE.01; phải chốt đủ lượng sau collision |
| W2-ST20-06 | T0 optimal → solve_offset_mixed → T2 → PDF/notification | quá khổ 300x70, xoay, unplaced/không tờ rỗng | ARTIFACT; BE.02; thêm gate chung |
| W2-ST20-07 | T0 report/unique → plan → finalizer → PDF/save consumer | 30=9+9+9+3, recipe [3,1], 70+10 extra, SL ẩn100 | ARTIFACT; BE.07/08; chưa bấm Save/Print |
| W2-ST20-08 | T0 true-shape → T3 → manifest/writer → PDF/session | 72/73 loại, SL100, unique/expanded, số lần in | AUTO hiện tại; giữ lịch sử artifact M72, chưa runtime |
| W2-ST20-09 | T0 S&R/1 Dao/master → geometry/render → IN/CUT | page boxes, holes, layer, polygon, clip | AUTO theo suite; còn test stale, chưa corpus khách đủ mọi tổ hợp |
| W2-ST20-10 | T0 preview/export/cancel → job store/session → output/cleanup | cancel/retry/handover/ownership/gate | AUTO theo suite; GUI nhiều tab/installer UNKNOWN |

Không nâng trạng thái toàn W2/W7 thành RUNTIME hoặc xóa HOLD lịch sử.

## 8. Các lô đã được duyệt và triển khai

1. **Lô A - không xuất thiếu**: BE.02 và chốt đối soát chung; sau đó BE.01 plan-aware boong. Mỗi lô con tối đa 5 file, test đỏ ca mất mẫu trước, PDF sau phải đủ hoặc fail rõ; không bỏ boong.
2. **Lô B - chuẩn hóa ý định**: BE.04/05. State/restore/schema/quantity cần đồng bộ; không thêm Mục đích và không âm thầm xóa SL người dùng.
3. **Lô C - bộ xếp đúng lựa chọn**: BE.03/06, helper kế hoạch dùng chung preview/export cho manual, simple và N=1. Giữ oracle kích thước/rotation/holes.
4. **Lô D - số liệu sản xuất**: BE.07/08, report theo actual ledger + recipe/runCount; test file IN/CUT, unique/expanded và tờ bù.
5. **Lô E - chốt regression/runtime**: cập nhật kỳ vọng test lỗi thời theo hợp đồng được duyệt, không thay golden hình học đại trà; click lại đúng chuỗi UI và mở lại PDF trên app.

Điều kiện nghiệm thu: không mất mẫu, không nhân ngoài chính sách đã chọn, không đổi bộ xếp trái UI, mọi tờ preview khớp PDF, report khớp actual; báo lỗi phải chặn thông báo thành công.

## 9. Dấu vết tái hiện

Workspace: `D:/printsolutions-main/product/xep quan ao/tmp/`.
- `audit_sticker_contracts.py`: manual/zero/unique/report/optimal/cut-stack report.
- `audit_sticker_ponts.py`: boong 5 mm, source refs và hai đơn vị bình.
- `audit_sticker_edges.py`: single N-Up, manual S&R, mẫu quá khổ.
- `audit-sticker-ui-probe.patch`: mã probe component/store để tái lập trong repo khi cần.
- PDF/PNG chẩn đoán: `tmp/pdfs/audit-sticker-20260920/`. Đây là fixture lỗi để audit, **không phải file sản xuất giao khách**.
- Test UI tạm trong source được gỡ sau khi kiểm; giữ patch tái hiện ngoài repo. Không sửa các test lỗi thời hoặc production source trong đợt audit.
