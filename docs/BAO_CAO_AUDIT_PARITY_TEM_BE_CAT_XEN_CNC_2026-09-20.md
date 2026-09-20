# Audit parity toàn diện Bình tem bế / Bình cắt xén / CNC - 2026-09-20

Trạng thái: **CHỜ DUYỆT SỬA**. Chỉ audit, không sửa mã production trong lượt này.

## 1. Kết luận điều hành

Xác nhận **11 lỗi: 10 P1, 1 P2**. Không chỉ lệch số tờ: có lỗi sai loại tem, bỏ lựa chọn hàng/cột hoặc chia cụm, thay đổi số lượng khi bật boong, và preview lật mặt sau CNC sai trục so với PDF.

Không nên dùng preview làm bản duyệt sản xuất tin cậy ở các tổ hợp nêu dưới đây cho tới khi sửa và nghiệm thu. Không suy rộng thành “mọi chế độ đều hỏng”.

- Baseline: working tree D:/pdfcompare, HEAD 0c8a347e11dfb9857b2a31433cfebce3cedccbd0, có nhiều thay đổi của các tác vụ khác. Hash 16 source trọng yếu tại thời điểm chốt nằm trong JSON.
- Danh mục: 83 trường NupSettings, 25 trường PontConfig, 22 trường ReportDisplayConfig, 8 trường SavePrintConfig, 4 trường CutBorderConfig. Danh sách đầy đủ theo interface nằm trong docs/audit/IMPOSITION_PARITY_2026-09-20.json.
- Đã chạy **75 ca probe độc lập preview/settings xuất/PDF**, đọc object/source index, số trang và report; render/xem 11 trang đại diện cho các lỗi hình học/loại/marks. 75 là số phép đo, **không phải 75 ca đạt**.
- Suite backend rộng: 1.734 test; lần đầu 1.730 pass, 4 bị chặn do ngân sách RAM an toàn 2,6-2,7 GB thấp hơn nhu cầu 2,9 GB. Chạy riêng toàn file chứa 4 ca: **18/18 pass**. Không chỉnh giới hạn RAM để ép xanh.
- Bổ sung 4 file chia cụm/canonical: **46/46 pass**. Không cộng các lượt rerun chồng lấp thành tổng mới.
- Frontend hiện hữu: **400/400 pass, 29 file**; typecheck đạt. Ba test chẩn đoán mới **đỏ đúng lỗi** (2 payload zero, 1 CNC mirror); không đổi kỳ vọng để làm xanh.
- Mức bằng chứng: AUTO + ARTIFACT và DOM cho hai lỗi xuyên frontend. **Chưa RUNTIME Tauri/bản cài/thiết bị xưởng**.

“Tất cả thông số” ở đây nghĩa là toàn bộ trường được lập danh mục và phân luồng kiểm, có ma trận biên/tổ hợp bên dưới. Không thể chứng nhận mọi giá trị thực và mọi tích Descartes của các trường bằng một số test hữu hạn. Các hàng chỉ TRACED hoặc AUTO không được nâng thành ARTIFACT/RUNTIME.

## 2. Phạm vi và bất biến

Bao gồm tem bế Từng tem/Nguyên tấm decal; N-Up/S&R; simple/manual/optimal và auto-route true-shape; sequential/cut_stacks/ratio_stack/mixed-guillotine khi công cụ hỗ trợ; chia cụm; CNC một/hai mặt; boong, marks, bleed/khổ/lề; số lượng chung/riêng; report, unique, working source và state/cache.

Bất biến cần kiểm:

1. Cùng cấu hình hiệu dụng, cùng nguồn và thứ tự trang.
2. Cùng loại tem, số bản và cách chia tờ; không chỉ cùng tổng số ô.
3. Cùng kích thước thành phẩm, tọa độ, hướng, khoảng hở và vùng cấm.
4. Cùng cặp Front/Back và đúng trục phản chiếu.
5. Report, số lần in, IN/CUT và file giao sau cùng mô tả đúng kế hoạch đó.
6. Các giá trị 0, trống, không gửi và mặc định không được bị tráo nghĩa.

Giữ nguyên quyết định nghiệp vụ đã duyệt: N-Up Từng tem trống = một bản mỗi loại, SL riêng 0 là loại bỏ; cut_stacks nguyên tấm được in bù cuối bộ theo quy tắc đã duyệt. Không coi bản bù được duyệt là bug.

## 3. Đường chạy live đã trace

T0 (UI chung): GridSettingsSection.tsx:527/596/775, AdvancedSettingsSection.tsx:1196/1236 -> ImposerDashboard.tsx:1720/2200 -> ImpositionTab.tsx:3236 -> processHandlers.ts:297-414.

T1 (preview): GridPreview.tsx:2417-2526 -> /api/imposition/preview-layout, /preview-layout/jobs hoặc /preview-layouts-batch -> imposition.py:2115/2374/2480/2827/3940/4752 -> JSON -> GridPreview.tsx:3148/3257/3969 (SVG và bảng số lượng).
Router live: app/main.py:382; export /nup-start: imposition.py:1339.

T2 (legacy xuất): processHandlers -> nup-start -> _launch_impose_job (imposition.py:1150+) -> run_nup_engine -> chuẩn hóa nguồn -> nup_engine.py -> sticker_grid_order / cluster_tile_engine / nup_layout_solver -> process_chunk (nup_process_chunk.py:1031+) -> place_one_artwork -> nup_output_finalize -> PDF mở lại/Save/Print.

T3 (CNC legacy): nup_engine.py:453 -> cnc_render.run_cnc_two_sided:290 -> build_cnc_gang_layout hoặc compute_sticker_layout_for_page:394 -> _render_cnc_unit:195 -> Front/[Back]/CUT -> PDF + report.

T4 (true-shape): trueShapeNestingRollout.shouldUseTrueShapeNesting -> settings_from_preview_request -> nup_true_shape_nesting.route_true_shape/build job -> nesting_production_pipeline/adapter -> native -> session/manifest -> nesting_imposition_render. Bộ test baseline chạy cả handover, source geometry, finishing, quantity, cancel và manifest validation.

Trong báo cáo, đường dẫn source tương đối đều dưới D:/pdfcompare. Không xem TS NupRenderer cũ như sink N-Up hiện hành: processHandlers hiện route N-Up sang backend.

## 4. Phát hiện đã xác nhận

### PAR20.01 - P1 - Giá trị 0 của dấu xén bị đổi thành mặc định

[CONFIRMED] Công cụ cắt xén và nguyên tấm decal; marginMode=include_marks.

- UI MarksSettingsDialog.tsx:84-94 cho nhập 0; ImposerDashboard dùng length/distance thực để tính lề preview.
- Sink: processHandlers.ts:305 dùng markLength || 5 và markOffset || 3. Độ dày cũng dùng || .25.
- Probe chạy runProcessEngine thật: input offset=0, payload exportOffset=3; hai test đỏ 3 != 0.
- Artifact: 20 loại 70x70 mm, giấy 220x220, hở/lề gốc 0, length=5, offset=0. Preview **9+9+2 = 3 tờ**; PDF **4+4+4+4+4 = 5 tờ**.
- Consumer live: nup_engine cộng mark_len + mark_off vào lề trước solve; không phải field thừa.
- Ca: guillotine-zero-mark-boundary, page_sheet-zero-mark-boundary.
- Hướng sửa: nullish/default có phân biệt 0, validation thống nhất; test từ UI payload tới PDF ở ngưỡng vừa hàng/cột.

### PAR20.02 - P1 - CNC bỏ số hàng/cột thủ công

[CONFIRMED] CNC legacy, N-Up và S&R, cả một/hai mặt.

- UI GridSettingsSection.tsx:536-538/596 cho manual + rows/columns.
- Batch imposition.py:4752 gọi planner manual đúng hàng/cột, nhưng single preview nhánh CNC và cnc_render.py:394 không truyền rows/cols tới solver; gang không đọc chiến lược lưới.
- Ca chọn **1x1**, nguồn 70x70, giấy 226x226: batch capacities={0:1,1:1,2:1}; preview main=9 và PDF=9 artwork/tờ.
- Ca hai mặt manual cũng ra 9+9+0 thay vì lưới người dùng yêu cầu.
- Ca: cnc-manual-batch-repeat, cnc-manual-batch-sequential, cnc-duplex-manual.
- Hướng sửa: kế hoạch CNC hỗ trợ thật manual hoặc chặn rõ tổ hợp chưa hỗ trợ ở mọi cổng; không giữ dropdown có tác dụng ở một nơi nhưng vô hiệu ở nơi khác.

### PAR20.03 - P1 - CNC preview chia cụm, xuất bỏ toàn bộ cách chia cụm

[CONFIRMED] cluster_tile, các kiểu replicate_mixed/zone_per_type/zone_ratio, S&R/N-Up và một/hai mặt.

- UI AdvancedSettingsSection.tsx:1236+ cho CNC chọn cụm và kích thước; payload giữ grouping/tileGap/cluster dimensions.
- Preview vào cluster branch imposition.py:2480 trước nhánh CNC:2827.
- Export route sớm sang cnc_render.py, _layout_for chỉ phân biệt repeat/gang, không consume groupingStrategy/cluster dimensions.
- Tờ 226x226, cụm 148x148: preview **4** ô, PDF **9** ô.
- Tờ 320x430, cụm 148x148, tileGap 3/5: preview **16**, PDF **20**; cả ba kiểu ghép tái hiện.
- Hai mặt còn có nguy cơ preview coi các trang Back như mẫu riêng trong nhánh cluster trong khi writer chỉ dùng Front.
- Ca: cnc-cluster-False/True, cluster-cnc-*.
- Hướng sửa: CNC preview và export nhận cùng plan theo grouping; unsupported phải fail-closed, không lặng lẽ chuyển sang gang.

### PAR20.04 - P1 - CNC legacy in dấu canh hai mặt lên artwork

[CONFIRMED] CNC two-sided + cncDuplexMarks + vùng in sát mép.

- cnc_render.py:230/252 vẽ dấu sau artwork. Chỗ solve/collision chỉ đọc boong, không đưa dấu canh vào vùng cấm.
- Dấu thật: cnc_marks.py:21+, tâm giữa bốn cạnh, cách mép 3 mm; đường thập dài 5 mm.
- Ca giấy 140x140, tem 70x70, lề/hở 0: bật/tắt marks vẫn 4 ô ở preview/PDF. Bật marks, cả bốn dấu in đè lên vùng artwork trên Front và Back.
- Đo bbox 5,1x5,1 mm quanh mỗi dấu: toàn bộ bbox giao artwork (26,01 mm2). Đây là diện tích vùng bao, **không phải diện tích mực nét thực**. Raster đã xác nhận nét dấu nằm trên mảng màu.
- True-shape đã có cơ chế obstacle cho marks; không được suy ra legacy cũng đã có.
- Ca: cnc-duplex-marks-overlap-False/True.
- Hướng sửa: đưa dấu canh vào kế hoạch/vùng cấm chung trước chia tờ; kiểm Front và Back, không chỉ boong.

### PAR20.05 - P1 - Bật boong làm đổi nghĩa SL trống của nguyên tấm

[CONFIRMED] Nguyên tấm decal, N-Up lần lượt, một loại, SL trống.

- Không boong: nhánh sequential cũ coi một loại/0 là autofill. Có boong: sticker_grid_order.py:74 gọi sticker_order_quantities, trống thành 1.
- Ca 70x70, giấy 226x226: tắt boong PDF **9 bản**; bật boong PDF **1 bản**, preview cũng đổi 9 -> 1.
- Đây không phải khác sức chứa vì va chạm: số bản yêu cầu bị thay nghĩa theo tùy chọn gia công.
- UI còn dùng placeholder tự lấp đầy cho nguyên tấm; quy tắc đơn hàng phải được chốt thống nhất với yêu cầu một bản mỗi loại, không phụ thuộc boong.
- Ca: page-sheet-one-blank-pont-False/True.
- Hướng sửa: chung chính sách quantity trước định tuyến, boong chỉ ảnh hưởng ô hợp lệ/số tờ.

### PAR20.06 - P2 - Có boong thì Xếp tối ưu âm thầm thành lưới đơn giản

[CONFIRMED] Nguyên tấm + optimal_auto + boong bật kiểm va chạm.

- sticker_grid_order.py:142 gọi solve_optimal_layout mà không truyền strategy; mặc định ở nup_layout_solver.py:339 là simple_auto.
- Ca 6 loại 60x40, giấy 110x110, lề 5, hở 0: không boong **3+3 = 2 tờ**; boong 1 mm cách mép 1 mm **2+2+2 = 3 tờ**.
- Đã kiểm nghiệm 3 ô optimal đối chứng với bốn vùng cấm: **0 va chạm**. Vì vậy không quy chênh lệch này cho việc phải chừa boong.
- Ca: optimal-safe-pont-False/True.
- Hướng sửa: truyền đầy đủ strategy/split-gap và giữ cùng solver contract; test chất lượng có obstacle nhưng không giao nhau.

### PAR20.07 - P1 - S&R chia cụm cắt xén/nguyên tấm bị trộn mẫu khi xuất

[CONFIRMED] repeat + cluster_tile + nhiều nguồn.

- Preview imposition.py:2711 lọc một mẫu đang xem; export nhánh _gui_cluster (nup_engine.py:2826-2872) gom mọi trang thành _gui_page_infos, không tách đơn vị S&R.
- Ca 4 mẫu, cụm 148x148, giấy 320x430: preview 16 ô **đều mẫu 1**. PDF chỉ một tờ có **mỗi mẫu 1..4 lặp 4 lần**.
- Số ô 16 == 16 nên test chỉ đếm capacity sẽ xanh dù nội dung sai.
- Tem bế Từng tem cùng ca xuất 4 tờ riêng, mỗi tờ 16 bản đúng một loại; là đối chứng hợp đồng S&R.
- Ca: cluster-guillotine-repeat-replicate_mixed, cluster-page_sheet-repeat-replicate_mixed.
- Hướng sửa: tách plan theo source/cặp Front-Back trước nhân bản cụm.

### PAR20.08 - P1 - Preview cụm cắt xén dùng TrimBox khác bản xuất

[CONFIRMED] PDF MediaBox khác TrimBox, bleed UI=0, cluster_tile.

- Preview imposition.py:2532-2533 và :2638-2639 ưu tiên TrimBox nếu lệch page.rect.
- Export nup_engine.py:2870 gọi resolve_guillotine_trim -> mixed_guillotine_adapter.py:112: trang logic trừ bleed do người dùng nhập, không dùng TrimBox nhúng để ghi đè.
- Ca nguồn 100x70 mm, TrimBox 60x40, cụm 148x148 trên tờ 320x430: preview **24 ô 60x40**; PDF **8 artwork khổ 100x70**.
- Đây là sai footprint/kích thước, không phải chỉ khác cách vẽ hình schematic.
- Ca: guillotine-cluster-trimbox.
- Hướng sửa: dùng resolver page geometry canonical ở cả hai điểm preview cluster; ma trận Media/Crop/Trim/Rotate/UserUnit và bleed explicit.

### PAR20.09 - P1 - SL riêng 0 vẫn được vẽ trong preview cụm tem bế

[CONFIRMED] Từng tem, N-Up optimal, cluster_tile, override một loại bằng 0.

- Preview _qty_c (imposition.py:2506+) biến q<=0 thành 1 và dựng page_infos_c cho mọi trang.
- Export nup_engine.py:1013 lọc theo _sticker_requested nên loại có override 0 không được in.
- Ca 4 loại, loại 1=0: preview **{1:4,2:4,3:4,4:4}**; PDF **{2:8,3:4,4:4}**. Tổng đều 16 nhưng khác loại/vị trí.
- Ca: cluster-sticker-explicit-zero.
- Hướng sửa: cùng quantity/membership policy ở planner cluster; đối soát theo từng loại, không chỉ tổng.

### PAR20.10 - P1 - Preview S&R chia cụm khóa ở mẫu đầu khi đổi thumbnail

[CONFIRMED] Tem bế/cắt xén/nguyên tấm, repeat + cluster_tile.

- Frontend GridPreview.tsx:1894/2460 gửi page_idx; PreviewLayoutRequest chỉ có page_idx.
- Cluster preview imposition.py:2712 lại đọc view_page_idx (không tồn tại), luôn mặc định 0.
- Gửi page_idx=1 (mẫu 2), cả ba công cụ vẫn trả 16 ô có pageIdx=0. Với tem bế, PDF có các tờ riêng đúng source nên preview đang mô tả nhầm tờ.
- Ca: cluster-view-page2-guillotine/page_sheet/sticker.
- Hướng sửa: dùng đúng chỉ số trang viewer/source đã normalize; kiểm reorder, xóa, master khuôn và nhiều trang.

### PAR20.11 - P1 - CNC S&R cạnh ngắn: preview và PDF phản chiếu khác trục

[CONFIRMED] CNC legacy S&R hai mặt, cncFlipEdge=short.

- Preview branch A trả cells/absPlacement nhưng không trả isCncPreview/cncTwoSided/cncFlipEdge (imposition.py:4193+).
- Consumer GridPreview.tsx:3257-3268 chỉ dùng trục Y khi isCncPreview=true. Thiếu cờ -> group mặt sau luôn scale(-1,1).
- Probe dùng **response backend thật** đưa vào component GridPreview: DOM ghi translate(133.818...,0) scale(-1,1); test yêu cầu scale(1,-1) đỏ.
- PDF thật page 2 có cm=[1,0,0,-1,0,0] quanh tâm tờ; raster Front/Back xác nhận lật dọc. Writer đúng cạnh ngắn, preview sai.
- Ca: cnc-sr-short-edge; raw response: cnc-sr-short-edge-raw.json; fixture source 50x70, giấy 180x220, lề bất đối xứng 8/3/5/17.
- Hướng sửa: metadata mặt/cạnh thuộc plan chuẩn, không suy route từ cờ tùy chọn thiếu trong response; test cả legacy/nesting, N-Up/S&R và hai cạnh.

## 5. Ma trận trường và audit unit

T0-T4 là đường live ở mục 3. Mọi hàng có ngày 2026-09-20, cùng source snapshot trong JSON. ARTIFACT chỉ áp cho những ca nêu tên, không cho toàn tích tham số.

| Unit | Trường/nhóm đầy đủ liên quan | Đường và ca biên | Bằng chứng / khoảng trống |
|---|---|---|---|
| P20-U01 Chọn công cụ/tác vụ | taskMode, layoutType, isDieCutMode, pageSheetMode, cncMode, impositionUnit ở store | T0 -> T1/T2/T3/T4; N-Up/S&R, chuyển đơn vị, mode ẩn | AUTO store/policy + 24 ca nền; ARTIFACT; PAR.02/03/07 |
| P20-U02 Khổ/vùng in | formsize, customSheetWidth/Height, paperClassification, marginTop/Bottom/Left/Right, marginMode, gripperMargin | T0 -> solver -> PDF MediaBox; lề 0/5/8, bất đối xứng, nhíp | AUTO + ARTIFACT; giữ regression 72 loại 4 tờ; PAR.01 |
| P20-U03 Hình học nguồn | bleed, source order/rotation, Media/Crop/Trim/UserUnit, shapeType/Params, detectedShapesByPage/Params | T0 working source -> canonical -> resolver -> writer | AUTO canonical/source suite + ARTIFACT TrimBox; PAR.08; chưa mọi PDF khách |
| P20-U04 Hở/cụm phụ | gapX/Y, splitGap, clusterGap/Mode, fillBlockGap | mm -> pt -> solver; 0/2, hai trục, số lẻ trong baseline | AUTO + probe; chưa quét mọi số thực tại ngưỡng |
| P20-U05 Bộ xếp | gridStrategy, columns/rows, clusterNesting | T0 -> batch/single -> plan; simple/manual/optimal, CUSTOM auto-route | AUTO + ARTIFACT; PAR.02/06 |
| P20-U06 Số lượng | targetQuantity, targetQuantitiesByPage | trống/0/1/2, loại bị bỏ, N=1/nhiều, 72/73, quantity lớn trong suite | AUTO + ARTIFACT; PAR.05/09; số lượng cực đại chưa benchmark runtime |
| P20-U07 Cách chia cụm | groupingStrategy, clusterSizingMode, clusterTileW/H, clusterCols/Rows, clusterCombineMode, tileGapX/Y | T0 -> cluster_sheets/CNC -> PDF; 3 kiểu combine, S&R/N-Up, tileGap 3/5 | AUTO + ARTIFACT 16 ca cluster; PAR.03/07/08/09/10 |
| P20-U08 Chia cọc/xếp chồng | clusterMode/Count/Gap/GapMode/Distribution, layoutType=cut_stacks/ratio_stack | T1/T2; type/row/column, nhiều tờ, in bù nguyên tấm | AUTO suite; ARTIFACT lịch sử 72/70; không coi toàn trường hợp đã RUNTIME |
| P20-U09 Hướng/căn | alternateRotation, align, mirrorAlign | T1/T2/T3 -> affine -> PDF; original/90/180, hàng/cột, căn bất đối xứng | AUTO inking/affine/gripper; ARTIFACT CNC short; mirrorAlign là cờ legacy, không thêm control mới |
| P20-U10 Hai mặt | duplexFlow, duplexFlipEdge, cncTwoSided, cncFlipEdge, cncDuplexMarks | pair mapping -> writer -> Front/Back/CUT; chẵn/lẻ, long/short | AUTO + ARTIFACT + DOM; PAR.04/11 |
| P20-U11 Dấu xén | markType/Offset/Length/Thickness/Style | Marks dialog -> lề/splitGap -> renderer; none/corners/guillotine, Japanese, 0 | AUTO + ARTIFACT + payload probe; PAR.01 |
| P20-U12 1 Dao | cutType, dieSizeMode, dieOffsetMm, fillBlockGap | geometry policy -> planner -> cut/artwork; page/die, offset, reset | AUTO source/inherit tests; UI không cho CNC chọn 1 Dao, không coi payload giả là bug live |
| P20-U13 Boong | pontType, pontConfig.shape/size/thickness/4 margins/disableCollision | T1/T2/T3/T4 -> obstacle -> IN/CUT | AUTO 3 shapes/collision + ARTIFACT; PAR.04/05/06; không máy bế thật |
| P20-U14 Guide/OCG boong | guide1/2Enabled, Pos, Length, Thickness, OffX/OffY; isGraphtec, layerInfoName/layerName/groupName/itemName | schema -> marks writer -> PDF OCG/NM | AUTO finishing/naming/obstacle tests; ARTIFACT lịch sử; Illustrator/Graphtec runtime UNKNOWN |
| P20-U15 Viền cắt | cutBorder.enabled/position/color/thickness | capability -> payload -> resolve_cut_border -> PDF | AUTO nup_cut_border/preview UI; không áp cơ học sang CNC/tem |
| P20-U16 Tách/xuất | separateCutPage, pontsOnCutFile, exportUniqueSheets, mixedExcessPercent | plan recipe/runCount -> finalizer -> trang/metadata | AUTO + ARTIFACT IN/CUT/duplex/cluster; số trang PDF không đồng nghĩa số tờ in |
| P20-U17 Report | reportDisplay: 22 field, reportMaterial/Lamination/LaminationSides/OrderCode | UI -> report data/bundle -> stamp -> PDF/notification | AUTO + ARTIFACT số liệu; vị trí report tùy chọn có thể đè artwork nếu không chừa chỗ, chưa có chính sách auto-avoid được duyệt |
| P20-U18 Lưu/mở | spawnNewTab, savePrintConfig:8 field, autoSavePrint, saveByReport deprecated | ctx working -> artifact lease -> save helper/native | AUTO processHandlers/save; filesystem/UI Save/Print ngoài app đang chạy chưa RUNTIME |
| P20-U19 Cache/revision | hiddenOcgLayerIds, diagnosticTrace/Preview/PendingRequestId/Capacity/State, forceLegacyGrid, working-source key | T0 -> request/cache/session -> job -> writer | AUTO stale/owned cancel/handover/revision; không click-race native nhiều tab |
| P20-U20 Field legacy | clusterBorder, mirrorAlign, saveByReport, aliases | trace consumer; TS NupRenderer không phải sink N-Up live | TRACED, không gắn P1 chỉ vì field không còn tác dụng; cleanup phải là lô riêng |

Danh sách field nguyên văn trong JSON là danh mục kiểm soát khi thêm parameter. Không có nghĩa mọi tổ hợp của các field đó đều đã thử nghiệm.

## 6. Bác bỏ và giới hạn

[DISPROVED / KHÔNG NÂNG THÀNH FINDING]

- Bốn lỗi baseline đầu không chứng minh sai solver: tất cả dừng ở memory-admission, chạy cô lập 18/18 xanh.
- Handcrafted CNC one_dao stale làm preview 4/PDF 9, nhưng UI không cho chọn 1 Dao ở CNC và reset cutType/dieSizeMode/offset khi vào tool. Không đưa thành lỗi reachable bình thường.
- Sparse positive quantity làm FE/BE chọn khác engine: đã đọc lại shouldUseTrueShapeNesting, có normalize blank->1 cho N-Up tem; không kết luận từ helper trueShapeJobPages đứng riêng.
- S&R hình schematic đầy sức chứa khác số con thực với target nhỏ không tự động là lỗi: phải phân biệt capacity/template với đơn hàng. Các finding chính đều có bất biến cụ thể hơn.
- Bản bù cut_stacks, report thay đổi nhưng manifest hình học giữ nguyên, unique recipe/runCount là hành vi đã duyệt khi đúng mode.
- Ca boong 5 mm gần góc có thể thật sự giảm capacity; PAR.06 chỉ xác nhận sau đối chứng boong 1 mm ngoài mọi footprint.

[UNKNOWN / CÒN PHẢI NGHIỆM THU]

- Desktop Tauri thật, bản cài/release, restore profile người dùng thực, ngôn ngữ/locale nhập số, picker/drop native và nhiều tab.
- Mọi tổ hợp min/max số lượng, số hàng/cột, custom giấy cực đại và số mm liên tục; chỉ có suite biên + fixture đã nêu.
- Kết quả Illustrator/Corel/Graphtec/máy in-bế vật lý, calibration dung sai cơ khí.
- Các shape/custom hole phức tạp có AUTO native/source/artifact tests nhưng chưa corpus xưởng đầy đủ cho mọi tổ hợp grouping/marks.
- Chưa đo lại performance toàn công cụ, không thay giới hạn worker/RAM, không build bản cài.

## 7. Đề xuất thứ tự sửa

Mỗi lô con tối đa 5 file; trước sửa giữ regression đỏ, sau sửa kiểm source-index + tọa độ + dấu/khuôn trong PDF, không chỉ capacity.

1. **A - Chuẩn hóa đầu vào:** PAR.01; dùng một resolver config hiệu dụng với zero/empty/default rõ ràng. Khóa ca preview 3/export 5 và lề 72 loại trước.
2. **B - Cụm cùng nguồn sự thật:** PAR.07/08/09/10. Plan theo source/cặp + membership, chung resolver PageBox/bleed; thumbnail dùng đúng page_idx. Tách từng lô nhỏ theo boundary/planner.
3. **C - CNC hợp đồng đầy đủ:** PAR.02/03. Manual và cluster phải được hỗ trợ thật hoặc bị chặn nhất quán; không để dropdown/batch nói khác writer.
4. **D - CNC hai mặt:** PAR.04/11. Mark obstacles và metadata/mirror chung cho preview/render; test hai cạnh với lề bất đối xứng, dấu ở sát artwork.
5. **E - Nguyên tấm:** PAR.05/06. Quantity policy không phụ thuộc boong; optimal dùng đúng strategy và secondary gap.
6. **F - Cổng nghiệm thu lâu dài:** sinh test pairwise từ inventory; input UI và input backend dựng độc lập; so ledger từng loại, pose, recipe/runCount, IN/Back/CUT, mark exclusions, report và hashes. Kết thúc bằng thao tác desktop/bản cài thật, không lấy test unit thay runtime.

Không đề nghị thay hàng loạt solver hoặc đóng hết HOLD lịch sử. User cần duyệt danh sách/lô trước khi triển khai.

## 8. Tái hiện và bảo toàn môi trường

Workspace evidence root: D:/printsolutions-main/product/xep quan ao/tmp/parity-audit-20260920/.

- Mỗi ca có <name>.json (request, settings, preview, report, artwork refs) và <name>-output.pdf.
- Harness: audit_three_imposers.py; audit_three_imposers_edges.py; audit_optimal_pont_control.py; audit_cnc_duplex_marks.py; audit_three_imposers_clusters.py; audit_cluster_boundaries.py; audit_cnc_short_edge.py.
- Dùng D:/pdfcompare/backend/venv/Scripts/python.exe -B -X utf8 để chạy các harness. PDF là fixture audit lỗi, **không phải file sản xuất giao khách**.
- Probe frontend giữ dạng patch trong workspace/tmp/parity-ui-probe.patch và parity-cnc-short-ui.patch; các file test tạm đã gỡ khỏi source sau khi kiểm.
- Log baseline: workspace/tmp/parity-audit-backend-20260920.log và parity-audit-frontend-20260920.log.
- Tổng hợp portable: docs/audit/IMPOSITION_PARITY_2026-09-20.json chứa field inventory, source SHA256 và 75 ca.
- Không kill/restart tiến trình user, không commit/reset/clean, không sửa snapshot, không thay production source, không gửi lệnh in.
