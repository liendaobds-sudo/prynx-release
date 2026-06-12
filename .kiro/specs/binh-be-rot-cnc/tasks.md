# Implementation Plan

> Kế hoạch triển khai — Công cụ "Bình Bế Rớt (CNC)".
> Nguyên tắc: tái dùng engine/solver/report/lưu-file; chỉ thêm 2 mặt + lật gương + dấu canh CNC + card mới.

## Overview
Backend lõi thuần (lật gương) + test → mở rộng engine 2 mặt/3 trang → dấu canh CNC → frontend (registry, store, UI, save) → kiểm chứng.

## Tasks

- [x] 1. Backend `app/workers/cnc_geometry.py` (thuần, testable)
  - `mirror_cell(cell, usable_w, usable_h, flip_edge)`: long-edge → `x'=W-(x+w)`; short-edge → `y'=H-(y+h)`; trả cell mới + cờ mirror nội dung.
  - `mirror_layout(items, W, H, flip_edge)`: áp cho cả layout.
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 2. Unit test `backend/tests/test_cnc_geometry.py`
  - Property 1 & 2 (đối xứng long/short-edge), không âm toạ độ, layout rỗng an toàn.
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 3. `cnc_marks.py` — vẽ dấu canh CNC
  - Các loại: `graphtec`, `corner`, `circle`, `none`; hàm `draw_cnc_marks(page, mark_type, sheet_w, sheet_h, ...)`.
  - Vẽ nhất quán trên Mặt trước & Mặt sau (khớp sau lật).
  - _Requirements: 4.1, 4.2_

- [x] 4. `nup_engine.run_nup_engine` — nhánh repeat: chế độ CNC 2 mặt
  - Đọc `imposerMode=='cnc'`, `cncTwoSided`, `cncFlipEdge`, `cncMarkType`.
  - Ghép cặp `(2k, 2k+1)`; số trang lẻ → lỗi rõ ràng.
  - Mỗi cặp xuất 3 trang: Trước (layout) → Sau (mirror layout, artwork back) → Khuôn (separate_cut). 1 mặt → 2 trang (Trước/Khuôn).
  - Vẽ dấu canh CNC trên Trước & Sau.
  - _Requirements: 2.1, 2.2, 2.4, 3.x, 5.1, 5.2, 5.3_

- [x] 5. `processHandlers.ts` — forward settings CNC
  - Thêm `imposerMode:'cnc'`, `cncTwoSided`, `cncFlipEdge`, `cncMarkType` vào backendSettings (khi tool CNC).
  - _Requirements: 1.2_

- [x] 6. `types.ts` — kiểu & capability
  - Thêm `'cnc_imposer'` vào `TaskMode`/`ActiveToolType`; `getImposerCapability('cnc')` (supportsTwoSided, supportsCncMarks, supportsPont=false).
  - _Requirements: 1.2, 1.3_

- [x] 7. `toolRegistry.ts` — thêm card "Bình Bế Rớt (CNC)"
  - Entry mới: icon, mô tả "Cắt rời CNC, bình 2 mặt", `defaultPayload:{ lockedMode:'cnc_imposer' }`.
  - _Requirements: 1.1_

- [x] 8. Store — cấu hình CNC + persist
  - `cncTwoSided`, `cncFlipEdge` (default 'long'), `cncMarkType` + setters; partialize + migrate.
  - _Requirements: 3.2, 4.3_

- [x] 9. UI sections (chỉ `cnc_imposer`)
  - Khối "BÌNH 2 MẶT": checkbox In 2 mặt + select Cạnh lật + **preview ghép cặp**; select **Dấu canh CNC**; ẩn pont/1 Dao.
  - _Requirements: 1.3, 2.3, 3.2, 4.1_

- [x] 10. `SavePrintFilesModal` + `printFileNaming` — hỗ trợ bộ 3 trang
  - Mở rộng `buildSavePlan` nhận kind front/back/cut; tên file: "(front)/(back)/(cut)"; preview cây.
  - _Requirements: 5.4_

- [x] 11. Kiểm chứng tổng thể
  - Backend: `pytest tests/` (giữ pass + test mới); integration 2 mặt → 3 trang đúng + đối xứng + lỗi trang lẻ.
  - Frontend: `tsc --noEmit`; card mở đúng dashboard CNC.
  - Regression: Bế tem/N-Up/Booklet không đổi.
  - _Requirements: 7.1, 7.2, 7.3_

## Task Dependency Graph
```json
{
  "waves": [
    { "wave": 1, "tasks": [1, 6, 7], "description": "Nền: geometry thuần + kiểu/capability + card menu" },
    { "wave": 2, "tasks": [2, 3, 8], "description": "Test geometry, dấu canh CNC, store" },
    { "wave": 3, "tasks": [4, 5, 9], "description": "Engine 2 mặt/3 trang, forward settings, UI CNC" },
    { "wave": 4, "tasks": [10], "description": "Lưu file bộ 3 trang (front/back/cut)" },
    { "wave": 5, "tasks": [11], "description": "Kiểm chứng tổng thể" }
  ]
}
```
- Task 1 nền cho 2, 4. Task 4 cần 1+3. Frontend 6→7→9; 8 cho 9; 5 nối FE→BE. 10 cần 4 (bố cục 3 trang). 11 cuối.

## Notes
- KHÔNG viết lại solver — mặt trước dùng `compute_sticker_layout_for_page` (Rust), mặt sau = lật gương.
- Trang Khuôn tái dùng `separate_cut_page` sẵn có.
- Danh sách loại dấu canh CNC sẽ chốt cụ thể khi làm Task 3 (theo máy người dùng).
- Mặc định `cncFlipEdge='long'` (lật cạnh dài).
