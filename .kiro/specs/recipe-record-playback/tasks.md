# Implementation Plan

## Overview

Hiện thực tính năng Recipe (Ghi & Phát lại) theo 6 nhóm, tăng dần từ nền (model + ops) → recorder → playback → UI → mở rộng ops → kiểm thử. Tái dùng tối đa `processHandlers.ts`, `commitWorkingFile`, mẫu `presetManager.ts`. KHÔNG tạo đường ghi PDF mới (giữ invariant an toàn màu). Mỗi nhóm verify `npm run typecheck && npm run build && npx vitest run` (và pytest nếu chạm backend).

## Tasks

### Nhóm 1 — Nền: mô hình & bảng thao tác (thuần, test được, chưa chạm UI)

- [x] 1. Định nghĩa mô hình Recipe
  - [x] 1.1 `desktop/src/lib/recipe/recipeTypes.ts`: `RecipeStep`, `Recipe`, `RecipeOpId` (union khớp handler hiện có)
  - [x] 1.2 Test type-guards + serialize/deserialize round-trip (vitest)
  - _Requirements: 2.4, 2.5_

- [x] 2. Bảng định nghĩa thao tác `recipeOps`
  - [x] 2.1 `recipe/recipeOps.ts`: map `opId → { label, recordable, needsExternalInput }` cho toàn bộ thao tác (theo bảng phân loại trong design)
  - [x] 2.2 Hàm `capture(opId, state)` đọc params từ store/cấu hình (tái dùng `partialize` của useImposerSettingsStore + *Settings)
  - [x] 2.3 Test: mọi opId có classification hợp lệ; file-dependent đánh dấu `recordable=false`; external đúng ('csv'/'file')
  - _Requirements: 4.1, 4.3, 5.1_

### Nhóm 2 — Lưu trữ recipe (sao mẫu presetManager)

- [x] 3. RecipeStore
  - [x] 3.1 `recipe/recipeStore.ts`: CRUD + persist (Tauri AppData JSON `ps_recipes`, fallback localStorage) theo đúng mẫu `presetManager.ts`
  - [x] 3.2 Export/import recipe ra/từ file
  - [x] 3.3 Test CRUD + export/import với fs mock
  - _Requirements: 2.1, 2.2, 2.3_

### Nhóm 3 — Recorder (ghi)

- [x] 4. RecipeRecorder core
  - [x] 4.1 `recipe/RecipeRecorder.ts` (zustand store): `isRecording`, `draftSteps`, `start/stop/cancel`, `noteOperation(opId, params)`, `noteNonRecordable(opId)`
  - [x] 4.2 Logic ghép `noteOperation` với lần `commitWorkingFile` kế tiếp → push Step; chụp kèm `viewerPageOrder/Rotations` khi cần
  - [x] 4.3 Test recorder (mock commit): thứ tự Step đúng, file-dependent → recordable=false
  - _Requirements: 1.2, 1.3, 1.4, 1.6_

- [x] 5. Gắn record hook vào ImpositionTab
  - [x] 5.1 Bọc/observe `commitWorkingFile` để recorder bắt sự kiện hoàn tất (noteCommit)
  - [x] 5.2 Mỗi `handleStart*` (booklet/nup/sticker/cnc/shuffle/resize/split/merge) gọi `recorder.noteOperation(opId, capturedParams)` trước khi chạy
  - [x] 5.3 Tool prepress JSON (convertcolors/hairlines/trapping/pdfx/spot_cmyk) note params trước khi áp dụng. (OCR/optimize multipart, watermark/stick overlay, bgremover/upscale AI: ranh giới MVP — chưa note/phát lại)
  - [x] 5.4 Thao tác VDP (datamerge/numbering/cover_numbering) gọi `noteNonRecordable`. (object edit dùng đường commit nhẹ → không ghi)
  - _Requirements: 1.1, 1.2, 1.4_

### Nhóm 4 — Playback (phát lại)

- [x] 6. PlaybackRunner
  - [x] 6.1 `recipe/PlaybackRunner.ts`: `runRecipe(recipe, deps)` — lặp Step, ép spawnNewTab=false (onSpawnTab=undefined), gọi runner theo opId (DI). Registry thật ở `recipe/recipeRunners.ts`
  - [x] 6.2 Bỏ qua + cảnh báo Step `recordable=false`/unsupported; hỏi input ngoài cho Step `needsExternalInput`
  - [x] 6.3 Await tuần tự; báo tiến trình Step i/N (onProgress)
  - [x] 6.4 Lỗi 1 Step (throw HOẶC ctx.setError) → dừng + báo rõ, không hỏng file gốc
  - [x] 6.5 Test runner (mock run*): thứ tự đúng, ép spawnNewTab=false, bỏ qua file-dependent, dừng khi lỗi
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.2, 5.2, 5.3, 7.1, 7.2_

- [x] 7. Tái dùng buildProcessContext cho playback
  - [x] 7.1 `recipeRunners.ts` tái dùng processHandlers.run*/endpoint hiện có; ép spawnNewTab=false. ImpositionTab cấp `buildContext` qua `buildProcessContext()` (Task 9)
  - [x] 7.2 Chuỗi working file qua `getWorkingBytes`/`commitWorkingFile` giữa các bước (mỗi runner upload bản working hiện tại)
  - _Requirements: 3.1, 7.1, 7.2_

### Nhóm 5 — Giao diện

- [x] 8. Nút Ghi/Dừng trên toolbar workspace
  - [x] 8.1 `recipe/RecipeRecordControl.tsx`: nút Ghi/Dừng + badge số bước đang ghi (mount ở toolbarExtra của AcrobatViewer, hiện khi có file)
  - [x] 8.2 Dialog dừng ghi: nhập tên/mô tả + xem trước Step + lưu/hủy
  - _Requirements: 1.1, 1.5, 6.1_

- [x] 9. Panel "Quy trình đã lưu"
  - [x] 9.1 `recipe/RecipePanel.tsx`: liệt kê recipe — ▶ Phát lại, ✎ Sửa tên, 🗑 Xóa, ⤓ Export, ⤒ Import; hiển thị danh sách Step + cờ phát-lại-được; `playRecipe` nối PlaybackRunner + buildProcessContext (chuỗi working file cục bộ)
  - [x] 9.2 Gợi ý recipe khớp số trang file đang mở (badge "phù hợp")
  - _Requirements: 2.5, 4.3, 6.2, 6.3_

- [x] 10. Dialog input ngoài khi phát lại
  - [x] 10.1 `requestExternalInput` mở file picker (CSV cho datamerge / PDF cho merge) trước khi chạy Step tương ứng; hủy → bỏ qua + cảnh báo
  - _Requirements: 5.2, 5.3_

### Nhóm 6 — Hoàn thiện & kiểm thử tổng

- [ ] 11. (Tùy chọn) Ghi kết quả solver đã giải
  - [ ] 11.1 Với nup/sticker dùng `optimal_auto`, lưu cols/rows đã giải vào Step để giảm sai lệch khi phát lại file khác (thêm trường vào response job + test)
  - _Requirements: 7.3_
  - _Ghi chú: hoãn — chỉ làm nếu sai lệch solver gây vấn đề thực tế (xem Notes)._

- [-] 12. Kiểm thử tổng & xác nhận không hồi quy
  - [ ] 12.1 Round-trip recipe (record→save→load→playback) 2 kịch bản THỰC TẾ:
    - **Ruột sách**: PDF nhiều trang → convertcolors → hairlines → pdfx → optimize → booklet.
    - **Tem nhãn**: file tem → tạo đường cắt (sticker_dieline) → bình tem (sticker_imposer). Phát lại trên tem MỚI: dieline + detect-shape DÒ LẠI hình theo từng file → bình đúng (không đóng băng hình cũ). *Cần backend chạy để nghiệm thu tay.*
  - [x] 12.2 Verify FE typecheck/build/vitest xanh (333 pass; thêm runner optimize + sticker_dieline + sticker_imposer dò-lại-hình). BE không đụng → pytest giữ nguyên
  - _Requirements: 3.1, 3.4, 7.1_
  - _Ghi chú: tách nền (bgremover) là công cụ ảnh tương tác theo lô (store/preview riêng, ngoài chuỗi PDF) → KHÔNG nằm trong recipe; tem dùng tùy chọn "Bỏ nền trắng" sẵn trong bước tạo đường cắt._

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"], "parallel": false },
    { "wave": 2, "tasks": ["2", "3"], "parallel": true },
    { "wave": 3, "tasks": ["4"], "parallel": false },
    { "wave": 4, "tasks": ["5", "6"], "parallel": true },
    { "wave": 5, "tasks": ["7"], "parallel": false },
    { "wave": 6, "tasks": ["8", "9", "10"], "parallel": true },
    { "wave": 7, "tasks": ["11"], "parallel": false },
    { "wave": 8, "tasks": ["12"], "parallel": false }
  ],
  "dependencies": {
    "2": ["1"],
    "3": ["1"],
    "4": ["2"],
    "5": ["4"],
    "6": ["2"],
    "7": ["6"],
    "8": ["5", "3"],
    "9": ["6", "3"],
    "10": ["6"],
    "11": ["6"],
    "12": ["8", "9", "10"]
  }
}
```

Thứ tự đề xuất: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12**.
- Nhóm 1–2 là nền thuần (test được, không chạm UI) → làm trước, rủi ro thấp.
- 5 (gắn hook vào ImpositionTab) là điểm chạm component lớn → làm sau khi recorder core (4) đã có test.
- 11 tùy chọn, chỉ làm nếu sai lệch solver gây vấn đề thực tế.

## Notes

- **Không tạo đường ghi PDF mới**: mọi bước phát lại tái dùng `processHandlers.run*` / endpoint backend hiện có → giữ invariant an toàn màu (pikepdf là đường ghi duy nhất; không ghi đè file gốc).
- **Verify sau mỗi nhóm**: `npm run typecheck` + `npm run build` + `npx vitest run` (FE 278 baseline); chạy `pytest` nếu chạm backend (BE 407 baseline). Không để giảm số test cũ.
- **MVP chỉ hỗ trợ thao tác param-based**; thao tác file-dependent (object edit/crop/VDP-XY) chỉ ghi nhận `recordable=false` + cảnh báo, KHÔNG phát lại.
- **Commit theo checkpoint** từng nhóm để dễ revert (đã có backup trên GitHub).
- Kịch bản nghiệm thu chính (task 12.1): ruột sách nhiều trang → convertcolors → hairlines → pdfx(nhúng font) → optimize → booklet, phát lại 1-click ra thành phẩm. (Tách nền AI là công cụ ảnh tương tác theo lô, không thuộc chuỗi PDF nên KHÔNG nằm trong kịch bản booklet.)
