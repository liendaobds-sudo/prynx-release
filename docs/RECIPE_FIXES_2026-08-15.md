# Nhật ký sửa Ghi & Phát quy trình — 2026-08-15

**Baseline audit:** `f1e18ffd4f50`  
**Báo cáo gốc:** `docs/BAO_CAO_AUDIT_GHI_VA_PHAT_QUY_TRINH_2026-08-15.md`  
**Phạm vi được duyệt:** Lô R1 — working artifact, Hủy và commit tuần tự.  
**Không thực hiện:** build/release, public GitHub, thay đổi schema Recipe, Split multi-output, Booklet page-order, ownership đầy đủ theo tab.

---

## 1. Kết quả Lô R1

| Finding | Trạng thái sau sửa | Thay đổi chính | Bằng chứng |
|---|---|---|---|
| `§PLAY.1` — làm rơi native output path | **Đã sửa / AUTO** | `WorkingArtifact` dạng union `path | bytes`; facade truyền đủ `existingPath`; carrier 0/11 byte không được coi là PDF. | Regression path/carrier + chain qua `runRecipe`. |
| `§PLAY.2` — bước sau đọc lại path gốc | **Đã sửa / AUTO** | Mỗi Step dựng `file/getWorkingBytes/getWorkingSourcePath` từ cùng revision; commit bytes xóa path, commit path xóa bytes cũ. | Chain `path gốc → path N-Up → bytes Optimize → Resize`. |
| `§PLAY.6` — Hủy bị tính completed | **Đã sửa / AUTO** | Toàn bộ process handler trả `ProcessOutcome`; outcome `canceled` đi xuyên registry/orchestrator, không tăng completed và không chạy bước kế. | Test N-Up cancel, TrimShift AbortError, runner cancel và thrown AbortError. |
| `§PLAY.7` — commit chưa được await | **Đã sửa / AUTO** | TrimShift và Split nhỏ `await commitWorkingFile`; Catalog cũng được sửa cùng pattern. | Deferred-promise test chứng minh handler chưa resolve trước commit. |
| `§REC.1` — pending note rò sau Hủy/no-commit | **Đã sửa trong wrapper handler / AUTO-PARTIAL** | Wrapper chụp identity pending lúc bắt đầu và chỉ dọn đúng note đó; completed-without-commit cũng không rò sang thao tác kế. | Code-path + typecheck; còn thiếu component test riêng và ownership đầy đủ theo tab thuộc Lô R3. |

Hai P0 ngoài R1 vẫn mở: `§PLAY.3` Booklet mang page-order của tài liệu cũ và `§PLAY.4` Split nhiều output/ZIP trong pipeline một file.

---

## 2. Các tiểu lô và giới hạn file

### R1-A — nguồn working path/bytes

1. `desktop/src/lib/recipe/workingArtifact.ts`
2. `desktop/src/lib/recipe/workingArtifact.test.ts`
3. `desktop/src/components/ImpositionTab.tsx`

Điểm kỹ thuật:

- File sạch có path không bị đọc toàn bộ vào V8 lúc bắt đầu phát.
- Native output path được giữ làm nguồn chân lý; bytes chỉ materialize khi runner thật sự cần.
- Kích thước path lấy qua `stat_system_file` có deadline; nếu không xác định được thì dùng size bảo thủ để Resize không chọn nhầm nhánh nạp RAM.
- Publisher lỗi giữ nguyên revision cũ.

### R1-B1 — outcome và commit tuần tự

1. `desktop/src/lib/processHandlers.ts`
2. `desktop/src/lib/processHandlers.test.ts`
3. `desktop/src/components/ImpositionTab.tsx`

Mọi handler liên quan trả một trong ba trạng thái `completed | canceled | error`. Không còn dùng `return` im lặng làm tín hiệu thành công.

### R1-B2 — truyền outcome qua Playback

1. `desktop/src/lib/recipe/PlaybackRunner.ts`
2. `desktop/src/lib/recipe/PlaybackRunner.test.ts`
3. `desktop/src/lib/recipe/recipeRunners.ts`
4. `desktop/src/lib/recipe/recipeRunners.test.ts`
5. `desktop/src/components/ImpositionTab.tsx`

Hủy hiện dùng toast thông tin, không hiển thị lỗi đỏ và không có `failedStep` giả.

---

## 3. Verify

Đã đạt:

```text
npx.cmd vitest run src/lib/recipe \
  src/lib/processHandlers.test.ts \
  src/lib/processHandlers.mixedGuillotine.test.ts \
  src/lib/combineTransport.integration.test.tsx \
  src/components/preprocess-tools/PageToolsPanel.test.ts

12 test files passed
128 tests passed

npm.cmd run typecheck
PASS

npm.cmd run test
235 test files passed
2356 tests passed, 2 skipped
```

`npm.cmd run lint` toàn repo vẫn đỏ ở baseline với 1.592 vấn đề lịch sử; lint hẹp các god-file liên quan cũng còn báo nợ cũ. Hai file `workingArtifact` mới không phát sinh lỗi lint, và `git diff --check` đạt. Không dùng nợ lint lịch sử để quy lỗi cho R1.

---

## 4. Bằng chứng còn thiếu

- Chưa chạy Tauri runtime bằng PDF khách thật.
- Chưa tạo/parse artifact thật cho chain Booklet/N-Up native path → prepress → Resize.
- Chưa có component test riêng cho cleanup pending theo identity.
- Chưa nghiệm thu Hủy giữa job thật trong app.

Vì vậy Lô R1 hiện đạt tối đa **AUTO**, chưa nâng lên `ARTIFACT` hoặc `RUNTIME`.

---

## 5. Bước kế tiếp

Sau khi runtime smoke R1 đạt, thứ tự an toàn tiếp theo là:

1. **R2A:** bỏ page state/autosave theo tài liệu cũ; bổ sung Rectangle mode và fail-closed detect/download.
2. **R2B:** quyết định Split multi-output và schema vai trò input Merge.
3. **R3:** ownership `tabId + recordingSessionId + operation token`, Undo và đóng tab.
