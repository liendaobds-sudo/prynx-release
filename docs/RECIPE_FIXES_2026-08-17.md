# Nhật ký sửa Ghi & Phát quy trình — 2026-08-17

**Baseline:** `4f513d8` — nhánh `codex/pre-release-audit-2026-08-04`
**Báo cáo gốc:** `docs/BAO_CAO_AUDIT_LAI_GHI_VA_PHAT_QUY_TRINH_2026-08-17.md`
**Phạm vi được duyệt:** Lô A — hợp đồng commit có kết quả (không tool nào báo thành công khi bị chặn).
**Không thực hiện:** build/installer, commit/push, chạy Tauri runtime, PDF artifact, các lô B–E.

---

## 1. Kết quả Lô A

| Finding | Trạng thái sau sửa | Thay đổi chính |
|---|---|---|
| `§REC.4R` — cửa chặn báo thành công giả | **Đã sửa / AUTO** | `commitToolWorkingFile` trả `Promise<boolean>` (`false` = bị chặn). Chuỗi `onFileFixed` đổi kiểu trả về và propagate qua `PreprocessingRouter`. Mỗi tool `await` kết quả và chỉ báo thành công khi `!== false`. |
| `§REC.4S` — "Tách nhiều tem" báo xuất thành công dù bị chặn | **Đã sửa / AUTO** | `StickerCutlineTool.handleExport` kiểm kết quả commit; `false` → không hiện thẻ hoàn tất / toast, dọn `exportedFilenameRef`. |

## 2. Hợp đồng mới

`onFileFixed` (và `commitToolWorkingFile`) trả `void | boolean | Promise<void | boolean>`:

- `false` → commit bị chặn (đang ghi quy trình mà thao tác chưa nối vé). Tool KHÔNG được đổi state thành công.
- `true`/`undefined` → đã commit (hoặc caller không dùng cửa chặn). Giữ hành vi cũ để tương thích.

Quyết định lấy **trước** commit và trả về bằng **giá trị**, không phải exception — vì phần lớn tool gọi callback không `await`, rejection sẽ rơi vào Promise không ai bắt.

## 3. File đã sửa

Lõi + propagation:
1. `desktop/src/components/ImpositionTab.tsx` — `commitToolWorkingFile` trả boolean; wrapper StickTextNumber propagate.
2. `desktop/src/components/imposition-tools/types.ts` — kiểu `onFileFixed`.
3. `desktop/src/components/imposition-tools/sections/PreprocessingRouter.tsx` — kiểu + 6 adapter `return` kết quả.

Tool tiêu thụ (await + kiểm `!== false` trước khi báo thành công):
4. `WatermarkTool.tsx`
5. `EncryptTool.tsx` (lock + unlock)
6. `MetadataTool.tsx` (không đổi field/expected name khi bị chặn)
7. `OcrTool.tsx` (không hiện thẻ kết quả khi bị chặn)
8. `StickTextNumberTool.tsx`
9. `PreflightTool.tsx` (không bỏ chọn action khi bị chặn)
10. `FontToolsTool.tsx` (dọn ref outlined khi bị chặn)
11. `OfficeConvertTool.tsx` (file + google)
12. `StickerTool.tsx` — đồng bộ kiểu trả cho StickerCutline
13. `StickerCutlineTool.tsx` — `§REC.4S`

Test mới:
14. `desktop/src/components/preprocess-tools/UnrecordedCommitBlock.integration.test.tsx` — chặn (false) không báo thành công; commit (true) có báo.

## 4. Verify

```text
npx.cmd vitest run src/components/preprocess-tools src/lib/recipe \
  src/components/recipe src/i18n/i18nCatalog.test.ts
33 test files passed · 292 tests passed

npm.cmd run typecheck
PASS
```

Chưa build, chưa commit/push, chưa chạy Tauri runtime. `§REC.4R/§REC.4S` đạt **AUTO**; chưa nâng `ARTIFACT/RUNTIME`.

## 5. Còn mở (theo thứ tự lô đề xuất)

- **Lô B:** `§REC.11A/§REC.11R` — lifecycle commit sửa đối tượng (vé lấy sai thời điểm, không await, không recheck sau await).
- **Lô C:** `§PLAY.5R` (Merge cardinality/order), `§PLAY.BX01-LEGACY` (recipe đường cắt cũ) — **cần chốt 2 quyết định sản phẩm** ở §8 báo cáo.
- **Lô D:** `§STORE.1/.2/.5/.10` — lưu/xóa fail-loud, nhập số, chống Enter trùng.
- **Lô E:** `§PLAY.12/.13/.14`, native path runner đường cắt.

---

## 6. Lô B — Lifecycle sửa đối tượng (§REC.11A/§REC.11R)

| Finding | Trạng thái | Thay đổi |
|---|---|---|
| `§REC.11R` — Step object edit gán sai phiên | **Đã sửa / AUTO** | Chụp phiên ghi tại thời điểm BẮT ĐẦU sửa (op đầu làm session dirty) vào `objectEditRecordingRef`. Step chỉ gán khi phiên ghi lúc commit vẫn đúng phiên đó → sửa-trước-khi-Ghi không gán nhầm; Ghi-rồi-Dừng-giữa-chừng không thêm Step vào phiên đã kết thúc. |
| `§REC.11A` — không await consumer + không recheck vé | **Đã sửa / AUTO** | `onCommit` giờ trả `Promise` và `useEditSession` **await** nó trong `doCommit`/`flatten`. `handleEditCommit` recheck `canCommitWorkingFile` NGAY TRƯỚC `setFile`; vé hết hiệu lực (Dừng/Hủy trong lúc stat/fetch) → discard, không gán Step, nhưng vẫn cập nhật working file. |

File: `ImpositionTab.tsx`, `useEditSession.ts`.

## 7. Lô C — Merge cardinality + recipe cắt legacy

| Finding | Trạng thái | Thay đổi |
|---|---|---|
| `§PLAY.5R` — Merge mất số lượng/thứ tự file (Hướng 1) | **Đã sửa / AUTO** | Thêm `RecipeStep.externalInputCount`; recorder ghi số file ngoài (`RecorderExtras` + `buildRecipeStep`); `handleStartMerge` truyền count; `requestExternalInput` hỏi ĐỦ N file TỪNG cái theo thứ tự (toast báo "file thứ i/N"), huỷ giữa chừng = huỷ cả bước. Recipe cũ thiếu count → coi như 1. |
| `§PLAY.BX01-LEGACY` — recipe cắt cũ phát sai contour (Hướng 1, fail-closed) | **Đã sửa / AUTO** | Chỉ ép contour khi bản ghi MỚI có `forceContour===true`; recipe cũ (thiếu cờ) theo mặc định an toàn của builder, không suy ngược `shapeMode='contour'`. |
| `§PLAY.BX-MIRROR` — nhánh Lật gương bỏ clamp | **Đã sửa / AUTO** | `bleed_mm` nhánh mirror clamp qua `clampStickerMm(..., bleedMm{0..10})` như UI chạy tay. |
| `§PLAY.PATH` — runner đường cắt rơi native path | **Đã sửa / AUTO** | Đọc `X-Sticker-Output-Path` và truyền vào `commitWorkingFile` để bước sau đi fast-path. |

File: `recipeTypes.ts`, `recipeOps.ts`, `RecipeRecorder.ts`, `ImpositionTab.tsx`, `recipeRunners.ts`, `recipeRunners.test.ts`, `recipeOps.test.ts`, `vi.json`/`en.json`.

## 8. Lô D — Lưu trữ desktop fail-loud

| Finding | Trạng thái | Thay đổi |
|---|---|---|
| `§STORE.1` — xóa recipe không hoạt động | **Đã sửa / TRACED** (Rust chưa build được) | Thêm lệnh Rust scoped `delete_file_scoped` (chỉ `.json`, chặn path nhạy cảm, idempotent) + đăng ký `invoke_handler`. `deleteRecipe` gọi lệnh này và **ném lỗi** nếu thất bại; `RecipePanel.handleDelete` báo lỗi thật thay vì "đã xóa" giả. |
| `§STORE.2` — ghi một nơi đọc một nơi | **Đã sửa / AUTO** | `saveRecipe` trên desktop coi đĩa là nguồn duy nhất; lỗi ghi **ném ra** (bỏ fallback `writeTextFile` là code chết + fallback localStorage âm thầm). `handleRename` báo lỗi. |
| `§STORE.5` — ô số ép về 0 mỗi phím | **Đã sửa / AUTO** | `ParamField` số dùng buffer chuỗi (`type=text` inputMode decimal); gõ được `-`/`.`/rỗng mà không ép 0; commit số hữu hạn, blur không hóa 0. |
| `§STORE.10` — Enter tạo recipe trùng | **Đã sửa / AUTO** | `handleSave` guard bằng `savingRef` chặn double-invoke trước khi state `saving` cập nhật. |

File: `src-tauri/src/lib.rs`, `recipeStore.ts`, `RecipePanel.tsx`, `RecipeRecordControl.tsx`, `vi.json`/`en.json`.

**Proof gap:** `cargo check` cho `src-tauri` không chạy được do file lock (`os error 32` khi build script copy `pdfium.dll` — nhiều tiến trình nền của phiên khác đang chạy). Lệnh `delete_file_scoped` mới **chỉ review tĩnh** (mirror `write_file_atomic`, dùng `std` + `is_sensitive_write_path` có sẵn, đăng ký đúng handler). Cần build lại Tauri để nghiệm thu runtime; app CHƯA rebuild sẽ thiếu lệnh → `deleteRecipe` ném lỗi (fail-loud, không báo sai).

## 9. Lô E — Vệ sinh phát lại (§PLAY.12)

| Finding | Trạng thái | Thay đổi |
|---|---|---|
| `§PLAY.12` — bước bỏ qua không rõ lý do + 0 bước vẫn báo xong | **Đã sửa / AUTO** | Nối `onWarn` gom lý do bỏ qua; khi `completed===0` báo **info** "Không có bước nào được phát lại. Lý do: …" thay vì "thành công 0 bước". |

File: `ImpositionTab.tsx`, `vi.json`/`en.json`.

**Còn mở (P2, không thuộc phạm vi đã duyệt):** `§PLAY.13` (closure `base` cũ → Undo lặp revision gốc + rò blob URL trung gian) và `§PLAY.14` (blob URL từ carrier rỗng). Cả hai đòi refactor `commitWorkingFile` (dùng khắp nơi) — rủi ro cao, chỉ là RAM-hygiene không sai kết quả xuất, nên KHÔNG sửa liều trong lượt này. Cùng với `§REC.5`, `§REC.8`, `§REC.9`, `§REC.10`, `§STORE.3/.4/.6/.8`, `§UX.1`, `§TEST.*` là backlog kế tiếp.

## 10. Verify tổng (Lô A–E)

```text
npx.cmd vitest run src/lib/recipe src/components/recipe src/components/preprocess-tools \
  src/hooks/useEditSession.test.ts src/i18n/i18nCatalog.test.ts
34 test files passed · 303 tests passed

npm.cmd run typecheck   PASS
```

Chưa build installer, chưa chạy Tauri runtime, chưa PDF artifact. `cargo check` bị chặn bởi file lock môi trường. Các finding đã khóa bằng test đạt **AUTO**; `§STORE.1` đạt **TRACED** (chờ Rust build).

---

## 11. Backlog P2 — Lô F/G/UX (2026-08-17, đợt 2)

Đã đóng thêm các P2 an toàn, verify từng phần:

| Finding | Trạng thái | Thay đổi |
|---|---|---|
| `§REC.5` — Undo không rút Step | **Đã sửa / AUTO** | Recorder thêm `rollbackDraftTo(tab, len)`; `commitWorkingFile` gắn `__recipeDraftLen` vào entry history; `handleUndo` rút draft về đúng độ dài khi về revision đó. Test recorder. |
| `§REC.8` — hợp đồng page order chết | **Đã sửa (hồ sơ)** | Giữ field optional (vô hại) nhưng sửa `tasks.md` Task 4.2/1.6: page order là dữ liệu theo tài liệu (§PLAY.3R), KHÔNG lưu vào Step ở v1; thôi over-claim. |
| `§REC.9` — đóng file khoá phiên ghi | **Đã sửa / AUTO** | `forceReset` gọi `recipeRecorder.cancel(tab)` để không kẹt isRecording khi nút Dừng biến mất. |
| `§REC.10` — mất draft khi đóng dialog | **Đã sửa / AUTO** | `SaveRecipeDialog` xác nhận trước khi bỏ (X/nền/Hủy) khi còn bước chưa lưu. |
| `§STORE.3` — không validate/migrate schema | **Đã sửa / AUTO** | Import từ chối schema mới hơn (không dán nhãn lại) và opId lạ (fail-closed). |
| `§STORE.4` — JSON hỏng/quota nuốt lỗi | **Đã sửa / AUTO** | `lsWrite` ném lỗi quota rõ ràng; `importRecipeFromFile` không nuốt lỗi; UI hiện đúng nguyên nhân. |
| `§STORE.6` — ô JSON không xóa trắng | **Đã sửa / AUTO** | Buffer dùng `?? ` + sentinel null; chuỗi rỗng giữ được. |
| `§STORE.8` — toggle bật op file-dependent | **Đã sửa / AUTO** | Chặn bật phát lại cho op không recordable (giữ bất biến Property 6). |
| `§UX.1` — key "Đang xử lý" đa nghĩa | **Đã sửa / AUTO** | Đổi text `dang_xu_ly_file` thành "đang bận ghi thao tác khác"; tách key riêng cho Catalog và play-while-recording. |

Verify: vitest recipe/preprocess/useEditSession/i18n **304 pass**; typecheck **PASS**.

## 12. Vẫn còn mở (cố ý dừng vì rủi ro, không sai kết quả xuất)

- `§PLAY.13/.14` — closure `base` trong `playRecipe` khiến Undo lặp revision gốc và rò blob URL trung gian. Đòi đổi đường publish của playback (hoặc `commitWorkingFile` dùng khắp nơi). **KHÔNG sửa** vì chưa có integration test cho `playRecipe` (§TEST.1) và lỗi ở đây hiển thị sai trên Viewer — refactor mù rủi ro cao. Chờ dựng harness test trước.
- `§TEST.1/.2/.4` — round-trip `playRecipe`, Tauri store test, thêm ca runner. Cần harness riêng.
- Toàn luồng vẫn ở mức **AUTO**; nâng RUNTIME cần chạy Tauri thật + PDF khách + build installer.
