# Requirements Document

## Introduction

Hoàn thiện và đấu nối end-to-end loại hộp mới **"Hộp treo có cửa sổ"** (`boxType = 'hanging_window'`) vào tính năng khuôn bế của PrynX. Mẫu tham chiếu: bản vẽ khuôn "hanging electronic product box with window" của nhà cung cấp Dacdora, kích thước mẫu L=80, W=30, D=140 (cửa sổ ~40×71 căn giữa mặt trước, một lớp tai treo 35mm, lỗ euro 28×6mm kèm gờ chống trượt 6×3mm).

Thân, đáy, tai chống bụi và mí dán keo giữ nguyên hợp đồng hình học của hộp nắp gài Reverse Tuck End (ECMA A20.20): nắp gài so le, nắp trên ở mặt TRƯỚC, nắp dưới ở mặt SAU, 4 tai bụi. Hai khác biệt riêng của loại hộp này:

1. Mặt SAU nối tiếp một **Tai_Treo_Euro** gập đôi: mặt sau ─cấn─ Lớp_1 (có Lỗ_Euro) ─cấn─ Lớp_2 (có Lỗ_Euro) ─cấn─ Lưỡi_Khoá gài vào lòng hộp. Lớp_2 gập úp 180° lên Lớp_1 để hai Lỗ_Euro trùng khít thành tai treo hai lớp giấy.
2. Mặt TRƯỚC có **Cửa_Sổ** bo góc (dán màng PVC/PET ở mặt trong), có công tắc bật/tắt.

Hiện trạng đã xác minh trong workspace: `HangingWindowBox.ts` mới dựng tới khối tai chống bụi rồi dừng đột ngột (thiếu cửa sổ, thiếu toàn bộ tai treo euro và lưỡi khoá, thiếu bounding box và câu `return`), nhiều import/biến khai mà chưa dùng nên gần như chắc chắn không typecheck được; các hàm `hangingWindowDims()`, `buildRoundedWindow()`, `buildEuroSlot()` đã có và dùng lại được; `types.ts` và `constants.ts` đã khai `boxType`, `WNW`/`WNH`/`HTH` và bộ hằng `HGB_*`; toàn bộ phần đấu nối engine, validate, UI, i18n, test, parity Rust và sidecar chưa làm. Vì vậy phạm vi gồm cả **viết nốt hình học** chứ không chỉ đấu nối.

## Glossary

- **Generator_Hộp_Treo**: hàm `generateHangingWindowBox(params)` trong `desktop/src/lib/dieline/HangingWindowBox.ts`, sinh `DielineModel` cho `boxType = 'hanging_window'`.
- **Hàm_Kích_Thước**: hàm `hangingWindowDims(params)` trong cùng file, suy ra mọi kích thước phụ (cửa sổ, tai treo, lỗ euro) từ `L, W, D, T, C, TH` và ba tham số riêng, có kẹp min/max.
- **Cửa_Sổ**: lỗ khoét hình chữ nhật bo bốn góc trên mặt trước, luôn căn giữa mặt trước, dựng bởi `buildRoundedWindow()`.
- **Công_Tắc_Cửa_Sổ**: tham số boolean `hgbWindow` trong `BoxParams`, theo khuôn mẫu `envWindow` của bì thư, bật/tắt việc dựng Cửa_Sổ.
- **Tai_Treo_Euro**: cụm chi tiết nối tiếp mặt sau gồm Lớp_1, Lớp_2 và Lưỡi_Khoá.
- **Lớp_1**: lớp tai treo nối trực tiếp với mặt sau qua một đường CREASE, cao `tabH`.
- **Lớp_2**: lớp tai treo nối với Lớp_1 qua Nếp_Gấp_Chung, cao `tabH + T`, gập úp 180° lên Lớp_1.
- **Nếp_Gấp_Chung**: đường CREASE giữa Lớp_1 và Lớp_2.
- **Lưỡi_Khoá**: chi tiết nối tiếp Lớp_2, gập vào lòng hộp để giữ tai treo, rộng `lipW` cao `lipH`.
- **Lỗ_Euro**: khe treo ngang bo bán nguyệt hai đầu kèm gờ chống trượt ở giữa, dựng bởi `buildEuroSlot()`; tham số `nibDir` (+1 / −1) quyết định chiều nhô của gờ.
- **slotPos**: khoảng cách từ tâm Lỗ_Euro tới Nếp_Gấp_Chung, dùng chung cho cả Lớp_1 và Lớp_2.
- **Dieline_Engine**: `desktop/src/lib/dieline/engine.ts`, chứa `dispatchGenerator` chọn generator theo `boxType`.
- **Runtime_Validator**: `desktop/src/lib/dieline/runtimeValidation.ts`, chứa `ENUM_VALUES.boxType`.
- **Param_Validator**: `desktop/src/lib/dieline/validateParams.ts`, kiểm tra miền giá trị tham số nhập.
- **Box_Store**: `desktop/src/store/useBoxStore.ts`, giữ preset theo loại hộp và cờ `isStanding`.
- **Param_Panel**: form nhập thông số hộp trong UI khuôn bế.
- **Dieline_Gallery**: thư viện mẫu hộp trong UI.
- **Native_Engine**: engine khuôn bế bản Rust `native/src/dieline_engine.rs`.
- **Fixture_Parity**: `native/tests/fixtures/dieline_default_request.json` cùng test `nativeFixtureParity.test.ts`, dùng đối chiếu kết quả TypeScript ⇄ Rust.
- **Mockup3D**: lớp render 3D `desktop/src/lib/mockup3d`, dựng hoạt ảnh gập từ `Panel.parent`, `pivotEdge`, `foldAngle`, `foldPhase`, `renderZShift`.
- **Preset_Dacdora**: bộ tham số mẫu L=80, W=30, D=140 kèm T/C/G/TH hợp lý cho loại hộp treo có cửa sổ.
- **Tag_Truy_Vết**: chuỗi `[HANGING-WINDOW 2026-07-27]` gắn vào comment mọi chỗ sửa thuộc tính năng này.

## Requirements

### Requirement 1: Hình học thân hộp và cửa sổ mặt trước

**User Story:** Là người chế bản bao bì, tôi muốn sinh được khuôn bế hộp treo có cửa sổ hoàn chỉnh từ L/W/D, để xuất PDF khuôn dùng ngay cho khách hàng ngành điện tử.

#### Acceptance Criteria

1. WHEN `dispatchGenerator` nhận `boxType = 'hanging_window'`, THE Generator_Hộp_Treo SHALL trả về một `DielineModel` đầy đủ gồm `panels`, `allPaths`, `boundingBox`, `params` và `warnings`.
2. THE Generator_Hộp_Treo SHALL dựng thân hộp, nắp gài so le (nắp trên ở mặt trước, nắp dưới ở mặt sau), bốn tai chống bụi và mí dán keo theo cùng hợp đồng hình học của hộp Reverse Tuck End.
3. WHERE Công_Tắc_Cửa_Sổ bật và `hangingWindowDims().hasWindow` bằng `true`, THE Generator_Hộp_Treo SHALL thêm đúng một chuỗi CUT kín của Cửa_Sổ vào mặt trước và ghi hình dạng đó vào `holes` của panel mặt trước.
4. WHERE Công_Tắc_Cửa_Sổ tắt, THE Generator_Hộp_Treo SHALL sinh mô hình không chứa đoạn nào thuộc Cửa_Sổ và không chứa phần tử nào trong `holes` của panel mặt trước.
5. THE Generator_Hộp_Treo SHALL căn giữa Cửa_Sổ theo cả hai trục của mặt trước.
6. IF `hangingWindowDims().hasWindow` bằng `false`, THEN THE Generator_Hộp_Treo SHALL bỏ Cửa_Sổ và thêm một cảnh báo vào `DielineModel.warnings`.

### Requirement 2: Tai treo euro gập đôi trên mặt sau

**User Story:** Là người chế bản, tôi muốn tai treo hai lớp giấy với hai lỗ euro trùng khít sau khi gập, để hộp treo được trên thanh ngang mà không xé giấy.

#### Acceptance Criteria

1. THE Generator_Hộp_Treo SHALL dựng chuỗi panel `back → Lớp_1 → Lớp_2 → Lưỡi_Khoá`, trong đó mỗi cặp panel liền kề nối nhau bằng đúng một đường CREASE.
2. THE Generator_Hộp_Treo SHALL dựng Lớp_1 cao `tabH` và Lớp_2 cao `tabH + T`.
3. WHERE `hangingWindowDims().hasSlot` bằng `true`, THE Generator_Hộp_Treo SHALL dựng đúng một Lỗ_Euro trên Lớp_1 và đúng một Lỗ_Euro trên Lớp_2.
4. THE Generator_Hộp_Treo SHALL đặt tâm hai Lỗ_Euro cùng khoảng cách `slotPos` tới Nếp_Gấp_Chung và cùng hoành độ tâm, với `nibDir` của hai lớp ngược dấu nhau.
5. IF `hangingWindowDims().hasSlot` bằng `false`, THEN THE Generator_Hộp_Treo SHALL dựng tai treo không lỗ và thêm một cảnh báo vào `DielineModel.warnings`.
6. THE Generator_Hộp_Treo SHALL dựng Lưỡi_Khoá rộng `lipW` cao `lipH` với chuỗi CUT kín, nối Lớp_2 bằng một đường CREASE.

### Requirement 3: Bất biến hình học 2D

**User Story:** Là người thẩm định khuôn, tôi muốn mô hình 2D tuân thủ đúng các bất biến hình học của PrynX, để không phát sinh hồi quy ở validator, bleed và xuất PDF.

#### Acceptance Criteria

1. THE Generator_Hộp_Treo SHALL sinh chuỗi CUT ngoài của mỗi panel khép kín với sai số nối đầu-cuối nhỏ hơn 0,01 mm.
2. THE Generator_Hộp_Treo SHALL sinh mọi đoạn CREASE có hai đầu chạm đúng biên panel liền kề, không để đầu CREASE lơ lửng.
3. THE Generator_Hộp_Treo SHALL giữ `points[0]` trùng `controlPoints[0]` và điểm cuối của `points` trùng `controlPoints[3]` với sai số nhỏ hơn 1e-6 cho mọi đoạn `type = 'bezier'`.
4. THE Generator_Hộp_Treo SHALL bỏ bo góc tại các đỉnh nằm trên đường gấp.
5. THE Generator_Hộp_Treo SHALL biểu diễn mọi tọa độ theo đơn vị mm và đưa qua hàm `snap()`.
6. WHEN phát hiện điều kiện khó sản xuất, THE Generator_Hộp_Treo SHALL ghi cảnh báo vào `DielineModel.warnings`.
7. THE Generator_Hộp_Treo SHALL sinh mọi giá trị tọa độ và kích thước là số hữu hạn.

### Requirement 4: Tham số, mặc định và kiểm tra hợp lệ

**User Story:** Là người dùng form thông số, tôi muốn bật/tắt cửa sổ và nhập ba số đo riêng của hộp treo, để tự điều chỉnh mà không sợ nhập giá trị vô nghĩa.

#### Acceptance Criteria

1. THE Param_Validator SHALL bổ sung Công_Tắc_Cửa_Sổ `hgbWindow` vào `BoxParams` và `DEFAULT_PARAMS` với giá trị mặc định `true`.
2. THE Runtime_Validator SHALL bổ sung `'hanging_window'` vào `ENUM_VALUES.boxType`.
3. WHEN người dùng nhập `WNW`, `WNH` hoặc `HTH` bằng 0, THE Hàm_Kích_Thước SHALL suy giá trị tự động theo hằng `HGB_*` tương ứng.
4. WHEN người dùng nhập `WNW`, `WNH` hoặc `HTH` lớn hơn giới hạn hình học cho phép, THE Hàm_Kích_Thước SHALL kẹp giá trị về giới hạn đó.
5. IF tham số nhập nằm ngoài miền hợp lệ, THEN THE Param_Validator SHALL trả về thông báo lỗi tiếng Việt nêu rõ tên tham số và miền cho phép.
6. THE Hàm_Kích_Thước SHALL giữ lề tối thiểu `HGB_WINDOW_MARGIN_MM` giữa mỗi cạnh Cửa_Sổ và cạnh mặt trước.

### Requirement 5: Đấu nối engine, thư viện mẫu và giao diện

**User Story:** Là người dùng PrynX, tôi muốn chọn "Hộp treo có cửa sổ" trong thư viện mẫu và thấy ngay khuôn theo số đo mẫu Dacdora, để bắt đầu chỉnh sửa nhanh.

#### Acceptance Criteria

1. THE Dieline_Engine SHALL định tuyến `boxType = 'hanging_window'` tới Generator_Hộp_Treo trong `dispatchGenerator`.
2. THE Dieline_Engine SHALL xuất Generator_Hộp_Treo, Hàm_Kích_Thước và các hàm phụ trợ liên quan qua `desktop/src/lib/dieline/index.ts`.
3. THE Dieline_Gallery SHALL hiển thị mục "Hộp treo có cửa sổ" kèm mã tiêu chuẩn và mô tả tiếng Việt.
4. WHEN người dùng chọn loại hộp "Hộp treo có cửa sổ", THE Box_Store SHALL nạp Preset_Dacdora gồm L=80, W=30, D=140 kèm T, C, G, TH tương ứng.
5. WHEN người dùng chuyển từ "Hộp treo có cửa sổ" sang loại hộp khác, THE Box_Store SHALL nạp lại bộ tham số mặc định chung của loại hộp mới.
6. WHILE loại hộp đang chọn là `'hanging_window'`, THE Param_Panel SHALL hiển thị các điều khiển `hgbWindow`, `WNW`, `WNH`, `HTH` với nhãn tiếng Việt.
7. THE Box_Store SHALL phân loại `'hanging_window'` theo cờ `isStanding` giống hộp Reverse Tuck End.
8. THE Param_Panel SHALL lấy nhãn loại hộp và nhãn tham số từ tệp i18n tiếng Việt và tiếng Anh.
9. THE Dieline_Engine SHALL cung cấp dữ liệu chú giải cho `'hanging_window'` để bảng chú giải và `geometryHelpers` xử lý loại hộp này như các loại đã có.

### Requirement 6: Mô hình 3D gập

**User Story:** Là người kiểm mẫu, tôi muốn xem hoạt ảnh gập hộp treo đúng thứ tự, để xác nhận tai treo hai lớp và lưỡi khoá khớp trước khi làm khuôn.

#### Acceptance Criteria

1. THE Generator_Hộp_Treo SHALL khai `pivotEdge` của mỗi panel là biên chung hình học thật với panel `parent`.
2. THE Generator_Hộp_Treo SHALL khai `foldAngle` của Lớp_2 bằng 180 độ để lớp này gập úp lên Lớp_1.
3. THE Generator_Hộp_Treo SHALL khai `renderZShift` của Lớp_2 và Lưỡi_Khoá là bội số của độ dày `T` để các lớp giấy chồng nhau không đồng phẳng.
4. THE Generator_Hộp_Treo SHALL khai `foldPhase` sao cho các chi tiết con gập trước thân hộp và pha gập cuối kết thúc quanh giá trị 0,95.
5. WHILE `foldProgress` chạy từ 0 tới 1, THE Mockup3D SHALL dựng mọi panel của hộp treo mà không có panel nào xuyên qua panel khác hoặc quay ngược hướng khai báo.

### Requirement 7: Parity engine Rust (sidecar)

**User Story:** Là người phát triển, tôi muốn engine Rust sinh cùng kết quả với engine TypeScript, để bản đóng gói và bản preview không lệch nhau.

> **Đã xác minh (hiệu chỉnh giả định ban đầu):** Native_Engine KHÔNG tự dựng hình học. `native/src/dieline_engine.rs` nạp `ENGINE_PAYLOAD = include_str!(concat!(env!("OUT_DIR"), "/dieline_payload.txt"))` — chính bundle TypeScript do `npm run build:dieline-sidecar` sinh ra, đã mã hoá — rồi gọi `__prynxGenerateDieline` qua Boa. Vì vậy KHÔNG cần port hình học sang Rust; parity đạt được bằng cách build lại bundle. Hạng mục nặng nhất của kế hoạch ban đầu được cắt bỏ.

#### Acceptance Criteria

1. THE Native_Engine SHALL dùng chung hình học với engine TypeScript qua bundle `dieline_payload`, không có bản port hình học riêng bằng Rust.
2. WHEN phần hình học TypeScript hoàn tất, THE Dieline_Engine SHALL được đóng gói lại bằng `npm run build:dieline-sidecar` để bundle nhúng trong Native_Engine chứa loại hộp mới.
3. THE Fixture_Parity SHALL chứa đủ mọi khoá mới của `DEFAULT_PARAMS` gồm `hgbWindow`, `WNW`, `WNH`, `HTH`, vì Runtime_Validator từ chối yêu cầu thiếu bất kỳ khoá nào.
4. WHEN `cargo test` chạy trong `native/`, THE Fixture_Parity SHALL giữ hai test `bundled_engine_warms_then_generates_default_dieline` và `bundled_slb_has_only_one_visible_tuck_fold` ở trạng thái đạt.
5. WHEN `nativeFixtureParity.test.ts` chạy, THE Bộ_Test SHALL kiểm rằng fixture Rust và `DEFAULT_PARAMS` phía TypeScript có cùng tập khoá, bao gồm các khoá mới của loại hộp treo.

### Requirement 8: Bộ test bốn tầng và golden master

**User Story:** Là người bảo trì, tôi muốn loại hộp mới có đủ bốn tầng test và một snapshot chuẩn, để mọi thay đổi hình học sau này đều bị chặn khi lệch.

#### Acceptance Criteria

1. THE Bộ_Test SHALL bổ sung nhóm kiểm thử `'hanging_window'` trong `generators.test.ts` kiểm số panel, quan hệ `parent`/`pivotEdge` và số đoạn đặc thù của Lỗ_Euro, Cửa_Sổ, Lưỡi_Khoá.
2. THE Bộ_Test SHALL kiểm cả nhánh bật và nhánh tắt Công_Tắc_Cửa_Sổ.
3. THE Bộ_Test SHALL bổ sung case `'hanging_window'` vào `contourValidator.test.ts`, `bleedContours.test.ts`, `geometry.test.ts` và danh sách `ALL_TYPES` của `legend.test.ts`.
4. THE Bộ_Test SHALL bổ sung arbitrary sinh tham số hợp lệ cho `'hanging_window'` trong `arbitraries.ts`.
5. THE Bộ_Test SHALL bổ sung một case chuẩn `'hanging_window'` vào `goldenMaster.test.ts`.
6. WHEN sinh snapshot golden master lần đầu, THE Bộ_Test SHALL cập nhật snapshot đúng một lần có chủ đích kèm soát diff.

### Requirement 9: Quy ước code và truy vết

**User Story:** Là người bảo trì dự án, tôi muốn code mới theo đúng quy ước PrynX, để dò lại lịch sử thay đổi dễ dàng.

#### Acceptance Criteria

1. THE Generator_Hộp_Treo SHALL dùng comment tiếng Việt với thuật ngữ ngành in.
2. THE Param_Panel SHALL hiển thị mọi văn bản giao diện của loại hộp này bằng tiếng Việt ở gói ngôn ngữ tiếng Việt.
3. THE Generator_Hộp_Treo SHALL gắn Tag_Truy_Vết vào comment tại mỗi vùng code thêm mới hoặc sửa cho tính năng này.
4. THE Generator_Hộp_Treo SHALL loại bỏ mọi import và biến khai mà không dùng trong `HangingWindowBox.ts`.

### Requirement 10: Xác minh và đóng gói

**User Story:** Là người phát hành, tôi muốn quy trình xác minh chạy xanh và sidecar được build lại, để bản đóng gói có loại hộp mới.

#### Acceptance Criteria

1. WHEN chạy `npm run typecheck` trong `desktop/`, THE Bộ_Test SHALL kết thúc không có lỗi biên dịch.
2. WHEN chạy `npx vitest run src/lib/dieline` trong `desktop/` trên Windows, THE Bộ_Test SHALL báo toàn bộ test khuôn bế đạt.
3. WHEN chạy `cargo check` trong `native/`, THE Native_Engine SHALL biên dịch không lỗi.
4. WHEN hoàn tất phần hình học và đấu nối, THE Dieline_Engine SHALL được đóng gói lại qua `npm run build:dieline-sidecar` và kiểm bằng `npm run check:dieline-webview`.
5. WHEN xuất PDF khuôn cho Preset_Dacdora, THE Dieline_Engine SHALL cho kích thước đo được khớp tham số nhập trong sai số 0,1 mm.

## Correctness Properties (property-based testing — fast-check)

Các thuộc tính dưới đây chạy trên arbitrary sinh tham số hợp lệ cho `boxType = 'hanging_window'` (L, W, D, T, C, G, TH, WNW, WNH, HTH, `hgbWindow`, `glueSide`, `panelOrder`) trên dải kích thước rộng.

1. **CUT kín** — Với mọi tham số hợp lệ, mọi chuỗi CUT ngoài của mỗi panel và mọi chuỗi CUT của Cửa_Sổ, Lỗ_Euro đều khép kín: khoảng cách điểm đầu tới điểm cuối nhỏ hơn 0,01 mm và mọi đoạn liền kề nối nhau trong cùng ngưỡng.
2. **Không NaN** — Với mọi tham số hợp lệ, mọi thành phần tọa độ trong `allPaths`, `panels[].outline`, `panels[].holes`, `panels[].pivotEdge` và `boundingBox` đều là số hữu hạn.
3. **Hai lỗ euro trùng khít sau gập** — Với mọi tham số hợp lệ có `hasSlot = true`, phép phản chiếu tập điểm Lỗ_Euro của Lớp_2 qua Nếp_Gấp_Chung cho tập điểm trùng tập điểm Lỗ_Euro của Lớp_1 (kể cả gờ chống trượt) trong sai số 0,01 mm.
4. **Cửa sổ nằm trong lề an toàn** — Với mọi tham số hợp lệ có `hgbWindow = true` và `hasWindow = true`, mọi điểm của chuỗi CUT Cửa_Sổ cách mỗi cạnh mặt trước ít nhất `HGB_WINDOW_MARGIN_MM` trừ sai số 0,01 mm.
5. **Đơn điệu và kẹp của `hangingWindowDims`** — Với mọi tham số hợp lệ: (a) mọi giá trị trả về nằm trong khoảng kẹp do hằng `HGB_*` quy định; (b) khi giữ nguyên các tham số khác và tăng `L`, `winW` và `slotW` không giảm; (c) khi giữ nguyên các tham số khác và tăng `D`, `winH` và `tabH` không giảm; (d) `tab2H` luôn bằng `tabH + T`; (e) `slotPos` luôn thoả `slotPos ≥ slotH/2 + nibD + 3` và `slotPos ≤ tabH − slotH/2 − 3` khi `hasSlot = true`.
