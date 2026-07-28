# Implementation Plan

## Overview

Hoàn thiện hình học còn thiếu của `HangingWindowBox.ts` rồi đấu nối `boxType = 'hanging_window'`
vào toàn bộ đường chạy: engine dispatch, validate, store/UI/i18n, test bốn tầng, golden master,
bundle sidecar. Chia lô ≤ 5 tệp mỗi lô theo AGENTS.md; mỗi lô verify xong mới sang lô kế. Mọi
chỗ sửa gắn tag `[HANGING-WINDOW 2026-07-27]`. Comment và text UI bằng tiếng Việt.

## Tasks
- [x] 1. Khai báo tham số `hgbWindow` và mở enum loại hộp
  - Thêm `hgbWindow: boolean` vào `BoxParams` trong `desktop/src/lib/dieline/types.ts` kèm doc tiếng Việt, và `hgbWindow: true` vào `DEFAULT_PARAMS`
  - Thêm `'hanging_window'` vào `ENUM_VALUES.boxType` trong `desktop/src/lib/dieline/runtimeValidation.ts`, khai `hgbWindow` là khoá boolean
  - Kẹp `WNW`, `WNH`, `HTH` trong `desktop/src/lib/dieline/validateParams.ts` theo miền của `hangingWindowDims`, cảnh báo tiếng Việt khi bị kẹp
  - Thêm `hgbWindow`, `WNW`, `WNH`, `HTH` vào `native/tests/fixtures/dieline_default_request.json`
  - _Requirements: 4.1, 4.2, 4.5, 7.3_

- [x] 2. Viết nốt hình học generator — cửa sổ mặt trước
  - Sửa `hasWindow` trong `hangingWindowDims()` thành `params.hgbWindow && winW >= 10 && winH >= 10`
  - Viết khối D trong `HangingWindowBox.ts`: đặt cửa sổ căn giữa mặt trước qua `buildRoundedWindow`, push vào `allPaths`, ghi vòng kín vào `holes` của panel mặt trước
  - Đẩy cảnh báo vào `modelWarnings` khi `hgbWindow` bật nhưng mặt trước quá nhỏ
  - _Requirements: 1.3, 1.4, 1.5, 1.6, 3.5, 4.6_

- [x] 3. Viết nốt hình học generator — nắp đậy và lưỡi gài so le
  - Viết khối E: `closure_top` + `tuck_top` trên mặt trước, `closure_bot` + `tuck_bot` dưới mặt sau, theo đúng khuôn `ReverseTuckEnd.ts` (khe gài, bo góc, nối liền nắp ↔ tai bụi)
  - Khai `parent`, `pivotEdge`, `foldAngle`, `foldPhase` theo bảng panel trong design
  - _Requirements: 1.1, 1.2, 3.1, 3.2, 6.1, 6.4_

- [x] 4. Viết nốt hình học generator — tai treo euro gập đôi
  - Viết khối F: `hang_tab_1` (cao `tabH`, đồng phẳng mặt sau), `hang_tab_2` (cao `tab2H`, gập 180°, `renderZShift = −(T + 0.1)`), `hang_tab_lip` (gập 90° gài vào lòng hộp)
  - Đặt hai Lỗ_Euro tại `yTabMid ∓ slotPos` cùng hoành độ tâm, `nibDir` ngược dấu, ghi vào `holes` của từng lớp
  - Guard `hasSlot = false`: dựng tai treo trơn + cảnh báo vào `modelWarnings`
  - Viết khối G: `computeBoundingBox` + `return DielineModel` với `standardCode = 'HANGING-WINDOW'`; dọn mọi import/biến không dùng
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 6.2, 6.3, 9.4_

- [x] 5. Test bất biến riêng của tai treo và cửa sổ
  - Tạo `desktop/src/lib/dieline/hangingWindowTab.test.ts`: phản chiếu Lỗ_Euro lớp 2 qua Nếp_Gấp_Chung trùng Lỗ_Euro lớp 1 (< 0,01 mm), `tab2H = tabH + T`, `slotPos` trong miền cho phép, cửa sổ căn giữa và trong lề an toàn
  - Chạy `npx vitest run src/lib/dieline/hangingWindowTab.test.ts`
  - _Requirements: 2.4, 8.1, 8.2 (Property 3, 4, 5)_

- [x] 6. Đấu nối engine và tầng dữ liệu
  - `engine.ts`: thêm `case 'hanging_window'` vào `dispatchGenerator`
  - `index.ts`: export `generateHangingWindowBox`, `hangingWindowDims`
  - `geometryHelpers.ts`: thêm nhánh diện tích phẳng kỳ vọng cho loại hộp mới
  - Chạy `npm run typecheck`
  - _Requirements: 5.1, 5.2, 5.9_

- [x] 7. Đấu nối store và giao diện
  - `useBoxStore.applyBoxTypeDefaults`: nạp Preset_Dacdora (L=80, W=30, D=140, T=0.5, C=0.5, G=15, TH=15) khi chọn loại hộp; trả về mặc định chung khi đổi sang loại khác
  - `ParamPanel.tsx`: cờ `isHangingWindow` + ô tích "Cửa sổ mặt trước", thanh trượt "Rộng cửa sổ", "Cao cửa sổ" (chỉ khi bật cửa sổ), "Cao tai treo"
  - `DielineGallery.tsx`: thêm thẻ "Hộp treo có cửa sổ"
  - `desktop/src/i18n/locales/vi.json` + `en.json`: nhãn loại hộp và bốn nhãn tham số mới
  - _Requirements: 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 9.2_

- [x] 8. Test store cho preset
  - Bổ sung case vào `desktop/src/store/useBoxStore.test.ts`: chọn `'hanging_window'` nạp đúng preset, đổi sang loại khác thì trả về mặc định
  - Chạy `npx vitest run src/store`
  - _Requirements: 5.4, 5.5_

- [x] 9. Phủ test bốn tầng cho loại hộp mới
  - `generators.test.ts`: describe `generateHangingWindowBox` — đếm panel theo nhánh bật/tắt cửa sổ và có/không lỗ euro, kiểm `parent`/`pivotEdge` chuỗi tai treo, `renderZShift` âm của lớp 2, `holes` mặt trước
  - Thêm `'hanging_window'` vào `ALL_TYPES` của `contourValidator.test.ts`, `bleedContours.test.ts`, `geometry.test.ts`, `legend.test.ts`
  - `arbitraries.ts`: arbitrary sinh tham số hợp lệ cho loại hộp mới (gồm cả `WNW`/`WNH`/`HTH` = 0 và `hgbWindow` hai giá trị)
  - Chạy `npx vitest run src/lib/dieline` và sửa cho xanh
  - _Requirements: 8.1, 8.2, 8.3, 8.4 (Property 1, 2, 6, 7)_

- [x] 10. Golden master
  - `goldenMaster.test.ts`: thêm case `hanging_window (Hộp treo có cửa sổ)` với L=80 × W=30 × D=140
  - Sinh snapshot bằng `npx vitest -u src/lib/dieline/goldenMaster.test.ts` đúng một lần, soi diff snapshot rồi mới chốt
  - _Requirements: 8.5, 8.6_

- [x] 11. Parity sidecar và Rust
  - Chạy `npm run build:dieline-sidecar` + `npm run check:dieline-webview`
  - Mở rộng `nativeFixtureParity.test.ts` để kiểm fixture Rust có đủ mọi khoá của `DEFAULT_PARAMS` (gồm khoá mới)
  - Chạy `cargo check` và `cargo test` trong `native/`
  - _Requirements: 7.1, 7.2, 7.4, 7.5, 10.3, 10.4_

- [x] 12. Verify tổng và kiểm tay
  - Chạy `npm run typecheck`, `npx vitest run` (toàn bộ), `npm run lint`
  - Kiểm tay bằng `run_dev.bat`: canvas 2D (CUT kín, crease chạm đỉnh, cửa sổ và hai lỗ euro đúng chỗ), 3D (kéo foldProgress 0 → 1, tai treo gập úp trước, nắp gài sau, không panel nào xuyên/bay)
  - Xuất PDF khuôn cho Preset_Dacdora, đo bằng thước trong app, đối chiếu tham số nhập trong sai số 0,1 mm
  - Báo cáo trung thực: test đã chạy, test chưa chạy được và vì sao, snapshot nào đã `-u` kèm lý do
  - _Requirements: 10.1, 10.2, 10.5, 6.5, 9.1, 9.3_

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"], "rationale": "Tham số + enum + fixture — mọi việc sau đều phụ thuộc" },
    { "wave": 2, "tasks": ["2"], "rationale": "Cửa sổ mặt trước (cùng tệp HangingWindowBox.ts ⇒ tuần tự)" },
    { "wave": 3, "tasks": ["3"], "rationale": "Nắp đậy + lưỡi gài so le (cùng tệp)" },
    { "wave": 4, "tasks": ["4"], "rationale": "Tai treo euro + bounding box + return (cùng tệp, đóng generator)" },
    { "wave": 5, "tasks": ["5", "6"], "rationale": "Test bất biến riêng và đấu nối engine — độc lập tệp, chạy song song" },
    { "wave": 6, "tasks": ["7"], "rationale": "Store + UI + i18n, cần engine đã dispatch" },
    { "wave": 7, "tasks": ["8", "9"], "rationale": "Test store và test bốn tầng — độc lập tệp" },
    { "wave": 8, "tasks": ["10"], "rationale": "Golden master, chốt sau khi hình học ổn định" },
    { "wave": 9, "tasks": ["11"], "rationale": "Bundle sidecar + parity Rust, cần hình học hoàn tất" },
    { "wave": 10, "tasks": ["12"], "rationale": "Verify tổng + kiểm tay 2D/3D + đo PDF" }
  ]
}
```

```
1 (tham số + enum + fixture)
├─► 2 (cửa sổ) ─┐
├─► 3 (nắp/lưỡi gài) ─┼─► 5 (test bất biến riêng) ─► 9 (test bốn tầng) ─► 10 (golden master)
└─► 4 (tai treo euro) ─┘                                   │
                                                           ▼
6 (engine + index + geometryHelpers)  ──► 7 (store + UI + i18n) ──► 8 (test store)
                                                           │
                        10 + 8 + 11 ──────────────────────► 12 (verify tổng + kiểm tay)
11 (sidecar + Rust) cần 2, 3, 4 xong (bundle phải chứa hình học đủ)
```

- Task 2, 3, 4 độc lập với nhau về nội dung nhưng cùng sửa `HangingWindowBox.ts` ⇒ làm tuần tự
  để tránh xung đột trong cùng tệp.
- Task 6 chỉ cần Task 1; nhưng chạy `npm run typecheck` ở Task 6 sẽ đỏ nếu Task 4 chưa xong
  (generator chưa có `return`) ⇒ thực tế nên làm sau Task 4.

## Notes

- Test chỉ chạy được trên máy Windows thật của dự án (`node_modules` chứa binary Windows).
- Golden master chỉ `-u` MỘT lần ở Task 10, phải soi diff trước khi chốt; không `-u` cả bộ.
- Không port hình học sang Rust: engine Rust chạy chính bundle TS qua Boa (đã xác minh trong
  design), parity đạt bằng `build:dieline-sidecar`.
- Không refactor phần dùng chung với `ReverseTuckEnd.ts` trong đợt này (nợ kỹ thuật có chủ ý,
  xem Design Decision 4).