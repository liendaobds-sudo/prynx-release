# Implementation Plan

## Overview

Phase 1 — CHỈ IN NHANH. Xây lớp `ProductAdvisor` (thuần toán) đề xuất thiết lập từ
sản phẩm + khổ giấy in nhanh, áp dụng vào store hiện có, kèm UI `ProductFirstPanel`.
Tái dùng engine sẵn có (`NupGridSolver` fit, `VirtualMap` số tay/mặt). Test-first cho
phần lõi; UI giữ luồng "Nâng cao" hiện tại làm override.

## Task Dependency Graph

```
1 (ProductAdvisor core) → 2 (unit tests) → 3 (applyRecommendation→store) → 4 (UI panel) → 5 (verify)
```

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"], "parallel": false },
    { "wave": 2, "tasks": ["2"], "parallel": false },
    { "wave": 3, "tasks": ["3"], "parallel": false },
    { "wave": 4, "tasks": ["4"], "parallel": false },
    { "wave": 5, "tasks": ["5"], "parallel": false }
  ]
}
```

## Tasks

- [ ] 1. Module lõi `ProductAdvisor.recommendInNhanh` (thuần toán, không UI/PDF)
  - Tạo `desktop/src/lib/imposerEngine/ProductAdvisor.ts` với types `InNhanhBinding`,
    `ProductInput`, `RecommendationOption`, `RecommendResult`, `BookletSettingsBundle`.
  - Map sản phẩm → `signatureMode`: saddle→saddle, thread→thread, perfect→continuous,
    cut_stacks→cut_stacks, flush_mount→flush_mount.
  - Tính spread (2-up) từ khổ thành phẩm + bleed (đồng bộ `SheetOptimizer.calcSpreadSize`).
  - Fit "1 tờ mấy con": dùng `NupGridSolver.solveOptimalNupLayout` (thử cả khổ gốc + xoay
    90°), lấy số cell = copiesPerSheet; ghi `rotatedSheet`.
  - Số tay/mặt: `VirtualMap.generateBindingMap(pageCount, signatureMode, foliosize)`.
  - Sinh option: `one_up` (N=1, scaleMode '100'/'fit'), `multi_up` (N≥2, chainNup),
    `cut_stack`. Mỗi option fit-checked + `wastePercent` + `explanation` + `settings`
    bundle (paperClassification='in_nhanh', KHÔNG foldPattern/gripper/interleave).
  - Fail-loud: khổ < 1 spread → `errors` + gợi ý khổ tối thiểu, KHÔNG trả option sai.
  - _Requirements: 1.1, 1.3, 2.2, 3.1, 3.2, 3.4, 6.1, 6.2, 7.1, 7.2_

- [ ] 2. Unit test cho `recommendInNhanh` (khoá Correctness Properties)
  - Tạo `__tests__/ProductAdvisor.test.ts`:
    - saddle A6 trên SRA3 → multi_up, copiesPerSheet ≥ 1, options không rỗng.
    - khổ quá nhỏ (spread > sheet) → options=[], errors không rỗng (Property 2).
    - mọi bundle có `paperClassification==='in_nhanh'` và KHÔNG foldPattern/gripperMargin/
      interleave (Property 1).
    - khổ dọc vs spread ngang → `rotatedSheet=true` chỉ khi copiesPerSheet ≥ phương án
      không xoay (Property 6).
    - khổ lớn hơn (cùng tỉ lệ) → copiesPerSheet không giảm (Property 5).
    - cut_stacks → strategy 'cut_stack', signatureMode 'cut_stacks'.
    - pageCount lẻ (không bội 4) → warnings nêu chèn trang trắng + vị trí.
  - _Requirements: 5 (toàn bộ Properties), 3.4, 6.4_

- [ ] 3. `applyRecommendation` → đổ vào store + test
  - Hàm `applyRecommendation(store, option)` set đầy đủ knob qua `useImposerSettingsStore`
    (setTaskMode 'booklet', setSignatureMode, setScaleMode, setPaperClassification 'in_nhanh',
    setCustomSheetWidth/Height + setFormsize, setBleed, setGapX/Y, setBlankPlacement,
    setFoliosize cho thread).
  - Test: sau apply, store có đúng knob; multi_up ⇒ chainNup, paperClassification 'in_nhanh',
    không có knob offset.
  - Parity: bundle sau apply → serializeBookletPlan cho plan có `phase2.mode` đúng
    (step_repeat / cut_stack) — tái dùng test phase-2 đã có.
  - _Requirements: 5.1, 6.3, 2.2_

- [ ] 4. UI `ProductFirstPanel` + cắm vào dashboard (giữ Nâng cao)
  - Tạo `desktop/src/components/imposition-tools/ProductFirstPanel.tsx`: chọn sản phẩm →
    khổ thành phẩm (tự điền từ file) + số trang → chọn khổ giấy **lọc in_nhanh** + số lượng.
  - Hiển thị option-card xếp hạng (explanation, copiesPerSheet, tờ in, %hao, cảnh báo) +
    nút "Dùng thiết lập này" (gọi applyRecommendation) + link "Chỉnh nâng cao".
  - Lọc khổ: chỉ `PREDEFINED_SIZES[*].classification==='in_nhanh'` + preset in_nhanh.
  - Cắm vào ImposerDashboard/ImpositionTab như một entry, KHÔNG gỡ UI power-user.
  - _Requirements: 1.1, 1.2, 2.1, 2.4, 3.3, 3.5, 4.2, 5.2, 5.3, 5.4_

- [ ] 5. Xác minh
  - `npm run typecheck` sạch; vitest (ProductAdvisor + phase-2 parity) xanh.
  - Smoke render ProductFirstPanel không lỗi.
  - Commit riêng tính năng product-first (không lẫn).
  - _Requirements: 5_

## Notes

- Tách in_nhanh/offset là bất biến: `printMethod` khoá `in_nhanh`; bundle KHÔNG bao giờ
  chứa foldPattern/gripperMargin/interleave (test Property 1 chặn).
- Fit dùng `NupGridSolver.solveOptimalNupLayout` (đã có sẵn, xử lý xoay) — không tự cài lưới.
- Metric in-nhanh: "số tờ in + %hao" (model riêng, KHÔNG nhân bản ProductionCalculator offset).
- Đường chạy thật sau apply = booklet viaBackend phase-2 (đã raster-verify ở audit trước).
