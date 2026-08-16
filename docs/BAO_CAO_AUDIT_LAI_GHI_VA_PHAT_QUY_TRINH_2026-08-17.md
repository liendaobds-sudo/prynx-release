# Báo cáo audit lại — Ghi & Phát quy trình (Recipe)

**Ngày:** 2026-08-17  
**Audit unit:** `W6-U02` — Ghi → lưu → phát Recipe trên working file  
**Baseline Git:** `4f513d8` trên nhánh `codex/pre-release-audit-2026-08-04`  
**Trạng thái worktree:** có thay đổi chưa commit của Recipe và đợt Bù xén/Tạo đường cắt; audit này chỉ đọc production code, không sửa hành vi.  
**Đối chiếu:** báo cáo 2026-08-15, báo cáo/cập nhật S1 ngày 2026-08-16, `RECIPE_FIXES_2026-08-15.md`, spec `.kiro/specs/recipe-record-playback/*` và master matrix.

---

## 1. Kết luận điều hành

Lô S1 đã sửa đúng phần nền:

- tab khác không bị phiên Ghi hiện tại khóa;
- commit không có vé trên tab chủ bị chặn có lý do;
- `split_odd_even` và hai mode Merge không tuyến tính bị chặn trước khi ghi;
- thứ tự/góc xoay trang bị tước khỏi Step đã có cảnh báo;
- Merge cũ không tuyến tính fail-closed ở runner;
- payload `sticker_dieline` của recipe mới dùng cùng builder với thao tác chạy tay.

Tuy nhiên tính năng **chưa đạt cổng nghiệm thu**. Bản vá mới vẫn có bốn lỗi P1 ngay trên các đường vừa sửa:

1. Cửa chặn trả `Promise<void>` đã resolve, nên nhiều tool hiểu “bị chặn” là “đã thành công”; một số adapter còn làm rơi Promise.
2. “Tách nhiều tem” không tạo vé Recipe, bị cửa chung chặn nhưng vẫn hiện thẻ/toast xuất thành công.
3. Sửa đối tượng tạo vé ở thời điểm commit-on-exit, không phải thời điểm người dùng sửa; callback không được await và vé không được kiểm lại sau `await`.
4. Merge tuyến tính vẫn mất **số lượng và thứ tự** file ngoài: ghi A+B+C nhưng khi phát chỉ chọn được một file, kết quả thành A+B và vẫn báo hoàn tất.

Ngoài ra, recipe cũ của Bù xén/Tạo đường cắt vẫn có thể phát khác lượt chạy tay do không thể phân biệt `shapeMode='contour'` được ghi sai với lựa chọn ép contour thật; nhánh Xén vuông/Lật gương còn bỏ qua clamp; nhánh runner không giữ native output path.

**Mức bằng chứng hiện tại:** `AUTO-PARTIAL` cho các helper/runner đã có unit test; toàn luồng vẫn chỉ `TRACED`. Chưa có PDF artifact record→save→playback và chưa chạy runtime Tauri.

---

## 2. Đường chạy đã trace

| Mã | Hành động → kết quả | Đường sống | Mức bằng chứng |
|---|---|---|---|
| `REC-01` | Tool tạo file → đưa vào working file → ghi Step | tool/`PreprocessingRouter` → `commitToolWorkingFile` → `commitWorkingFile` → `RecipeRecorder.noteCommit` | `TRACED + AUTO-PARTIAL` |
| `REC-EDIT` | Sửa object trong RAM → thoát edit → commit một lần | `useEditSession.runOp` → `AcrobatViewer` lifecycle → `handleEditCommit` → `RecipeRecorder` | `TRACED` |
| `PLAY-MERGE` | Step Merge → hỏi file → ghép vào working file | `PlaybackRunner` → `requestExternalInput` → `runMergeStep` → `runMerge` → `mergePdf` | `TRACED + AUTO` cho một file |
| `PLAY-STICKER` | Step tạo đường cắt → backend → working file bước kế | `runStickerDieline` → `/pdf-tools/sticker-dieline` → `commitWorkingFile` → `WorkingArtifactController` | `TRACED + AUTO` cho payload recipe mới |
| `STORE-01` | Lưu/xóa/import → restart → đọc lại | `RecipePanel`/`RecipeRecordControl` → `recipeStore` → Tauri command/plugin-fs hoặc localStorage | `TRACED`; test chỉ phủ localStorage |

---

## 3. Finding xác nhận trên thay đổi mới

### `§REC.4R` — P1 — Cửa chặn vẫn báo thành công giả

**[CONFIRMED]** `commitToolWorkingFile` trả `Promise<void>`; nhánh chặn chỉ toast rồi `return`, nên caller nhận một Promise đã resolve như thành công (`ImpositionTab.tsx:1115-1125`). Các wrapper block trong `PreprocessingRouter.tsx:228-230,237,262,291,310,314,322` còn không `return` Promise của parent.

Consumer sống xác nhận hậu quả:

- `WatermarkTool.tsx:325-331` xử lý xong PDF, gọi callback không await rồi bật `setIsSuccess(true)`;
- Encrypt, Metadata, Preflight, FontTools, OCR, Office Convert và Header/Footer có cùng hợp đồng `void`/drop-Promise;
- Crop bị chặn ở parent nhưng dialog vẫn reset sau callback (`CropDialog.tsx:625-630`).

**Tái hiện:** bật Ghi → chạy Đóng dấu/Metadata → nhận toast “thao tác chưa ghi được” đồng thời tool hiện thành công; working file không đổi. Cổng “không no-op im lặng/không báo thành công sai” chưa đạt.

### `§REC.4S` — P1 — “Tách nhiều tem” không có vé nhưng vẫn báo xuất thành công

**[CONFIRMED]** `StickerCutlineTool.tsx:104-109` xuất PDF rồi gọi `onFileFixed` không truyền `RecipeOperationTicket`. Parent chặn nhưng resolve bình thường; dòng `110-114` vẫn tạo thẻ hoàn tất và `toast.success`.

**Tái hiện:** bật Ghi → Tách nhiều tem → Tạo PDF. Backend đã tạo file, nhưng file đang mở không đổi và Recipe không có Step; UI vẫn báo xuất thành công.

### `§REC.11A` — P1 — Commit sửa đối tượng không chờ consumer và không kiểm lại vé

**[CONFIRMED]** `useEditSession.ts:205-218` đánh `dirty=false` rồi gọi `onCommit` đồng bộ, không await. `ImpositionTab.tsx:1453-1462` tiếp tục gọi `void handleEditCommit(...)`. Trong `handleEditCommit`, vé được tạo trước `await stat/fetch`, nhưng trước `setFile` tại `:1421` không gọi lại `canCommitWorkingFile`; kết quả `noteCommit` tại `:1437` cũng bị bỏ qua.

**Tái hiện:** bật Ghi → thoát edit để bắt đầu commit → Dừng/Hủy trong lúc stat/fetch đang chờ. Working file vẫn bị thay, nhưng vé đã hết hiệu lực nên Recipe không có Step.

### `§REC.11R` — P2 — Step object edit bị quy thuộc sai phiên ghi

**[CONFIRMED]** edit thật xảy ra tại `useEditSession.ts:251-272`, nhưng vé `object_edit` chỉ được tạo khi thoát edit/commit tại `ImpositionTab.tsx:1371-1374`.

- Ghi → sửa → Dừng trước khi thoát edit: Recipe không có `object_edit`, file vẫn đổi sau đó.
- Sửa khi chưa Ghi → bật Ghi trước khi thoát edit: Recipe nhận một Step cho thao tác xảy ra trước phiên.

### `§PLAY.5R` — P1 — Merge nhiều file phát lại thiếu file nhưng vẫn hoàn tất

**[CONFIRMED]** UI cho chọn/sắp nhiều file (`MergeTool.tsx:68-93`), nhưng lúc ghi tước toàn bộ `filesToMerge` (`ImpositionTab.tsx:1924-1933`). Metadata chỉ nói input chung là `'file'` (`recipeOps.ts:51`); picker phát lại không bật `multiple` và chỉ lấy `files[0]` (`ImpositionTab.tsx:2025-2033`). Runner ghép đúng danh sách một phần này rồi trả completed.

**Tái hiện:** ghi thao tác A+B+C → phát trên A mới → chỉ chọn được B → output A+B, mất C, không lỗi. S1 mới đóng mode, chưa đóng role/cardinality/order.

### `§PLAY.BX01-LEGACY` — P1 — Recipe đường cắt cũ vẫn phát sai hình học

**[CONFIRMED]** comment tại `recipeRunners.ts:312-313` nói chỉ tin `forceContour` của bản ghi mới, nhưng biểu thức `:314-315` vẫn biến `{ forceContour: undefined, shapeMode: 'contour' }` thành ép contour. Đây chính là payload recorder cũ tạo cho mặc định `cornerStyle='preserve'`, trong khi lượt chạy tay cũ gửi `auto_safe`.

Không thể tự động suy ngược ý định: recipe cũ có `shapeMode='contour'` có thể là dữ liệu ghi sai mặc định hoặc lựa chọn ép contour thật. Cần quyết định migration/fail-closed; không nên âm thầm đoán.

### `§PLAY.BX-MIRROR` — P2 — Nhánh Lật gương bỏ qua clamp

**[CONFIRMED]** nhánh thường dùng `buildStickerDielineFields` và clamp, nhưng nhánh `rectangle + mirror` gửi thẳng `p.bleedMm || 0` (`recipeRunners.ts:271-282`). `AddBleedRequest` backend không đặt `ge/le` (`preflight.py:348-354`). RecipePanel cho nhập số không giới hạn.

**Tái hiện:** sửa Step thành `bleedMm=999` rồi phát nhánh mirror; backend nhận nguyên 999 mm.

### `§PLAY.PATH` — P2 — Runner đường cắt làm rơi native output path

**[CONFIRMED]** backend trả `X-Sticker-Output-Path` (`pdf_tools.py:1728-1730`), thao tác chạy tay dùng header này (`StickerTool.tsx:556-557`), nhưng recipe runner chỉ đọc blob và commit hai tham số (`recipeRunners.ts:323-333`). `WorkingArtifactController` vì vậy hạ revision path thành bytes và các bước sau mất fast-path native. Chưa chứng minh sai artifact; rủi ro đã xác nhận là sao chép/upload/RAM không cần thiết trên file lớn.

### `§STORE.10` — P2 — Nhấn Enter nhiều lần tạo Recipe trùng

**[CONFIRMED]** `handleSave` không guard `saving` (`RecipeRecordControl.tsx:127-143`); chỉ nút bị disable, input tên vẫn gọi `handleSave` mỗi lần Enter (`:162-166`). Mỗi lời gọi `createRecipe` sinh id mới.

**Tái hiện:** làm chậm `saveRecipe`, nhấn Enter hai lần → hai Recipe cùng nội dung, id khác nhau.

---

## 4. Finding cũ chưa bị thay đổi bởi diff này

Các mục dưới đây đã đọc lại trên code hiện tại và vẫn mở:

| Mã | Mức | Trạng thái hiện tại |
|---|---|---|
| `§REC.5` | P1 | Undo working file chưa rút/vô hiệu Step đã ghi. |
| `§REC.8` | P1 | `viewerPageOrder/viewerPageRotations` vẫn là schema không có consumer; spec Task 4.2 còn nói quá mức. |
| `§REC.9`, `§REC.10` | P2 | Đóng/reset file vẫn có thể khóa phiên Ghi; draft sau Dừng vẫn mất khi đóng dialog. |
| `§PLAY.12` | P1 | Không nối `onWarn`; picker chỉ dựa `oncancel`; không Hủy cấp Recipe; recipe 0 bước vẫn báo xong. |
| `§PLAY.13`, `§PLAY.14` | P2 | `base`/history/blob URL vẫn chụp revision đầu và nhánh path vẫn tạo URL từ carrier. |
| `§STORE.1` | P1 | Xóa trên Tauri thiếu quyền/command phù hợp, UI vẫn toast thành công. |
| `§STORE.2` | P1 | Ghi lỗi rơi localStorage nhưng đọc thành công từ đĩa không merge fallback. |
| `§STORE.5` | P1 | Ô số ép chuỗi trung gian về 0 và lưu mỗi phím; `cutlineDenoise` mới cũng đi qua editor này. |
| `§STORE.3/.4/.6/.8` | P2 | Migration/validation, fail-loud, JSON draft và invariant recordable vẫn mở. |
| `§STORE.7/.9` | P3 | Mô tả chưa CRUD đủ; id path token chưa harden. |
| `§TEST.1/.2/.4/.5` | P1/P2/P3 | Chưa có playRecipe integration, Tauri store test, các ca nguy hiểm và hồ sơ spec vẫn thiếu. |
| `§UX.1` | P2 | Key “Đang xử lý” vẫn gánh nhiều lý do chặn không liên quan. |

---

## 5. Mục đã đóng hoặc không tái hiện

- `§REC.4` nền tảng: helper chặn đúng tab chủ và không ảnh hưởng tab khác; 5 unit test đạt.
- Ownership/ticket cũ hoặc khác tab vẫn fail-closed trong `RecipeRecorder`.
- `§REC.2`: Tách chẵn/lẻ bị chặn trước `runShuffle`.
- `§PLAY.5` phần mode: chỉ `merge_files` được ghi/phát; interleave/insert fail-closed. **Không đồng nghĩa cardinality đã sửa** — xem `§PLAY.5R`.
- `§PLAY.3R`: có cảnh báo khi working document có reorder/rotation; đạt `TRACED`, chưa có test UI.
- i18n Việt/Anh của các key mới đồng bộ; catalog test đạt.
- Payload `sticker_dieline` của recipe **mới** có `forceContour` dùng chung builder và các test clamp/alpha/denoise đạt.

---

## 6. Verify đã chạy

```text
npx.cmd vitest run src/lib/recipe src/components/recipe \
  src/components/preprocess-tools/RecipeToolTicket.integration.test.tsx \
  src/lib/processHandlers.test.ts src/i18n/i18nCatalog.test.ts

14 test files passed
161 tests passed

npx.cmd vitest run \
  src/components/preprocess-tools/StickerCutlineTool.test.tsx \
  src/components/preprocess-tools/StickerTool.ui.test.tsx

2 test files passed
14 tests passed

npm.cmd run typecheck
PASS
```

Không build, không tạo installer, không chạy backend PDF artifact và không mở Tauri runtime. Test xanh hiện tại không phủ các reproducer P1 ở §3.

---

## 7. Cổng còn thiếu

1. Component test xuyên `tool → PreprocessingRouter → commitToolWorkingFile → trạng thái UI` cho cả commit và block.
2. Test Start/Stop/Hủy tại ba thời điểm của edit session: trước op, dirty trước exit, đang await commit.
3. Merge hai/ba file giữ đúng số lượng và thứ tự khi phát lại.
4. Migration/fail-closed cho recipe đường cắt cũ không có `forceContour`.
5. Test trực tiếp wrapper `ImpositionTab.playRecipe`: `onWarn`, cancel picker, history và blob URL.
6. Tauri AppData sạch: create/restart/rename/delete/import/export và lỗi quyền/đĩa fail-loud.
7. PDF artifact thật cho hai chain bắt buộc của Task 12.1.

---

## 8. Thứ tự lô sửa đề xuất — chờ duyệt

| Lô | Mục tiêu | Phạm vi tối đa | Verify bắt buộc |
|---|---|---|---|
| **A — Hợp đồng commit có kết quả** | `§REC.4R`, `§REC.4S`; không tool nào báo thành công khi block | `ImpositionTab.tsx`, `PreprocessingRouter.tsx`, `imposition-tools/types.ts`, `StickerCutlineTool.tsx`, 1 integration test | test commit/block + typecheck; thử tay Watermark và Tách nhiều tem |
| **B — Lifecycle object edit** | `§REC.11A/R`; lấy owner/ticket theo lúc edit, await consumer, recheck trước publish | `useEditSession.ts`, `AcrobatViewer.tsx`, `ImpositionTab.tsx`, 1–2 test | race Start/Stop/Hủy + typecheck |
| **C — Merge + recipe legacy** | `§PLAY.5R`, `§PLAY.BX01-LEGACY`; cần chốt chính sách | `recipeTypes.ts`, `recipeOps.ts`, `PlaybackRunner.ts`, `recipeRunners.ts`, test | merge 1/2/3 file; legacy sticker fail-closed/migration |
| **D — Store fail-loud** | `§STORE.1/.2/.5/.10` | `recipeStore.ts`, `RecipePanel.tsx`, `RecipeRecordControl.tsx`, Tauri command/capability, test | local + Tauri mock + runtime AppData sạch |
| **E — Playback hygiene** | `§PLAY.12/.13/.14`, native path | `ImpositionTab.tsx`, `workingArtifact.ts`, `recipeRunners.ts`, integration test | playRecipe wrapper + history/blob/path |

### Quyết định sản phẩm cần chốt trước Lô C

1. Merge v1: hỗ trợ chọn lại đúng N file theo thứ tự, hay chặn ghi khi có hơn một file ngoài? Khuyến nghị hỗ trợ cardinality/order vì “Ghép nối tiếp” thường dùng nhiều file.
2. Recipe đường cắt cũ thiếu `forceContour`: fail-closed và yêu cầu xác nhận/migrate, hay ưu tiên `auto_safe`? Khuyến nghị fail-closed; dữ liệu cũ không đủ để suy ra ý định an toàn.

---

## 9. Chốt duyệt

Audit dừng tại đây. Chưa sửa production code. Đề nghị duyệt **Lô A trước**, sau đó Lô B; hai lô này xử lý các đường đang hiển thị thành công sai và mất Step. Lô C cần chốt hai quyết định sản phẩm ở trên trước khi triển khai.
