# Báo cáo re-audit — Ghi & Phát quy trình (Recipe)

**Ngày:** 2026-08-15  
**Baseline:** `f1e18ffd4f50` — nhánh `codex/pre-release-audit-2026-08-04`  
**Phạm vi:** `desktop/src/lib/recipe/*`, `desktop/src/components/recipe/*`, các điểm nối trong `ImpositionTab.tsx`, `processHandlers.ts`, các tool prepress, lưu trữ Tauri/localStorage và route backend được Recipe gọi lại.  
**Đối chiếu:** `.kiro/specs/recipe-record-playback/*`, `docs/BAO_CAO_AUDIT_RECIPE_2026-07-27.md`, `docs/PRYNX_MASTER_AUDIT_MATRIX.md`.  
**Trạng thái:** GIAI ĐOẠN 3 — user đã duyệt và Lô R1 đã được triển khai; các finding ngoài R1 vẫn mở.

> Worktree có sẵn các thay đổi chưa commit thuộc quy trình build/release. Đợt Recipe giữ nguyên các thay đổi đó; chúng không được dùng làm bằng chứng và không bị trộn vào phạm vi sửa.

---

## 1. Kết luận điều hành

Phần lõi Recipe có cấu trúc khá tốt: metadata thao tác tập trung, orchestrator có dependency injection, entitlement kiểm toàn chuỗi trước mutation và kiểm lại trước từng bước. Tuy nhiên, **đường tích hợp thật giữa orchestrator và working file vẫn không an toàn**.

Kết luận hiện tại:

- **Chưa nên coi “Phát quy trình” là an toàn cho file khách hàng hoặc chuỗi nhiều bước.** Có bốn lỗi P0 có thể tạo PDF rỗng/rác, âm thầm bỏ kết quả bước trước, bình sai trang hoặc đưa ZIP vào Viewer như PDF.
- **“Ghi quy trình” chưa giữ được quan hệ nhân quả theo thao tác và theo tab.** Recorder toàn app chỉ có một `pendingNote`, không có `tabId`, operation token hay rollback theo Undo/Hủy.
- **CRUD trên desktop chưa đáng tin:** nút Xóa hiện không có quyền Tauri cần thiết; fallback có thể báo “đã lưu” nhưng lần refresh sau không thấy recipe.
- **Test xanh chưa chứng minh luồng người dùng.** `93/93` test liên quan và typecheck đều đạt, nhưng không có test nào đi qua đúng wrapper `playRecipe` đang làm rơi `existingPath`, cũng không có round-trip record → save → load → playback trên app thật.

Đợt re-audit xác nhận **33 finding ở mức contract/dataflow**: **4× P0, 17× P1, 11× P2, 1× P3**. Bằng chứng cao nhất của toàn luồng hiện chỉ là `TRACED`; các helper riêng lẻ có `AUTO`, chưa có `ARTIFACT/RUNTIME` cho Recipe end-to-end.

---

## 2. Audit unit và đường chạy sống

| Mã | Hành động người dùng → kết quả | Đường trace chính | Bằng chứng hiện tại | Khoảng trống |
|---|---|---|---|---|
| `REC-01` | Bấm Ghi → chạy thao tác → Dừng → thấy danh sách Step | `RecipeRecordControl.tsx:30-42` → hook `ImpositionTab.tsx:1642-1733`/tool prepress → `RecipeRecorder.ts:78-122` → `commitWorkingFile` tại `ImpositionTab.tsx:885-1017` | `TRACED + AUTO` cho recorder core | Chưa test operation token, Hủy, Undo, commit trễ, hai tab |
| `STORE-01` | Đặt tên/Lưu → restart → đổi tên/xóa/import/export | `RecipeRecordControl.tsx:109-125` / `RecipePanel.tsx:128-197` → `recipeStore.ts:78-182` → `write_file_atomic`/`read_dir_json` | `TRACED + AUTO` chỉ cho localStorage | Nhánh Tauri, quyền xóa, fallback, quota và migration chưa test |
| `PLAY-01` | Chọn recipe → Phát → từng bước dùng output bước trước → Viewer nhận kết quả cuối | `RecipePanel.tsx:168-172,265-272` → `ImpositionTab.tsx:1739-1802` → `PlaybackRunner.ts:76-178` → `recipeRunners.ts:264-289` → `processHandlers.ts`/backend → `ImpositionTab.tsx:885-1017` | `TRACED + AUTO` cho orchestrator/handler tách rời | Không có current artifact model, integration test, PDF artifact hay runtime Tauri |
| `OWN-01` | Ghi/phát/Hủy/đóng tab trong môi trường nhiều tab | `App.tsx:1394-1421` giữ mọi tab mounted → mỗi tab mount Recipe UI tại `ImpositionTab.tsx:2730-2736,2956-2961` → singleton `RecipeRecorder.ts:63-143` | `TRACED` | Không có session/tab owner, cancel recipe, stale-commit guard |

**Gate entitlement đang đạt:** preflight toàn recipe tại `PlaybackRunner.ts:87-104`, kiểm lại từng bước tại `:131-142`, unknown op fail-closed qua `recipeEntitlements.ts:49-82`, có test tương ứng.

---

## 3. Findings — tính đúng của Playback

| Mã | Mức / effort | Finding đã xác nhận | Bằng chứng |
|---|---|---|---|
| **§PLAY.1** | **P0 / M** | Wrapper playback làm rơi `existingPath`. Kết quả native của N-Up là blob mang chữ 11 byte, của Booklet là blob 0 byte; wrapper biến chúng thành `currentBytes` rồi commit như PDF thật. Viewer/bước kế nhận file hỏng. | Hợp đồng tham số 3 `processHandlers.ts:75-77`; N-Up `:294-324`; Booklet `:396-418`; carrier `:301-307`, `pdfImposer.ts:786-798`; wrapper chỉ hai tham số `ImpositionTab.tsx:1778-1782`. |
| **§PLAY.2** | **P0 / M** | `getWorkingSourcePath` bị đóng băng ở file lúc bắt đầu phát. N-Up và Resize ưu tiên path này hơn bytes mới, nên chuỗi như `Chuyển màu → N-Up/Resize` có thể chạy bước sau trên file gốc và âm thầm bỏ bước trước. | Base dựng một lần `ImpositionTab.tsx:1751-1783`; closure path gốc `:1599-1611`; N-Up ưu tiên path `processHandlers.ts:146-153`; Resize ưu tiên path `:747-780`. |
| **§PLAY.3** | **P0 / M** | Booklet lưu và dùng lại `pageOrder/pageRotations` tuyệt đối của file cũ. Phát recipe 16 trang lên file số trang khác có thể bỏ trang hoặc tham chiếu trang không tồn tại. | Capture `ImpositionTab.tsx:1851-1852`; bộ tước chỉ áp Sticker/CNC `:1660-1675`; consumer `pdfImposer.ts:588-624`. N-Up hiện không còn tiêu thụ hai field này nên finding cũ A.3 còn trực tiếp ở Booklet. |
| **§PLAY.4** | **P0 / M** | `split` là thao tác nhiều output nhưng bị coi là một bước tuyến tính. File lớn có nhiều kết quả nhận ZIP rồi commit với tên PDF; file nhỏ chỉ giữ kết quả đầu và bỏ phần còn lại. | `recipeOps.ts:47`; handler `processHandlers.ts:945-963`; backend trả ZIP `backend/app/api/routes/pdf_tools.py:579-631`. |
| **§PLAY.5** | **P1 / M** | Hợp đồng input ngoài của Merge không mang số lượng/vai trò. Picker chỉ chọn một file và runner luôn gắn vào `filesToMerge`; `interleave` cần `oddFile/evenFile`, `insert_pages` cần `insertFile`, merge nhiều file cũng bị thiếu input. | Record `ImpositionTab.tsx:1724-1731`; picker `:1760-1768`; runner `recipeRunners.ts:57-61`; consumer `PdfMerger.ts:53-69,82-97`. |
| **§PLAY.6** | **P1 / M** | Hủy job bị hiểu là hoàn thành. Handler nuốt `ABORT_BY_USER`/`isCanceled` và return; PlaybackRunner tăng `completed` rồi chạy bước kế trên file chưa xử lý. Không có Hủy cấp toàn recipe. | Nút Hủy `ImpositionTab.tsx:2840-2854`; handler `processHandlers.ts:364-431,1060-1068`; logic thành công `PlaybackRunner.ts:146-175`. |
| **§PLAY.7** | **P1 / S** | TrimShift và Split nhỏ không `await commitWorkingFile`; bước tiếp theo có thể đọc `currentBytes` cũ. | Hợp đồng async `processHandlers.ts:75-77`; call site `:924,962`. |
| **§PLAY.8** | **P1 / S** | Playback “Xén vuông” thiếu `rectangle_mode`; tool thật gửi `true`, backend playback nhận default `false`, làm lệch nhánh hình học/bù xén. | Tool `StickerTool.tsx:453-455`; runner thiếu field `recipeRunners.ts:215-244`; default backend `pdf_tools.py:1375-1376`. Cần artifact Rectangle để định lượng sai số cuối. |
| **§PLAY.9** | **P1 / S** | Dò hình tem lỗi nhưng playback vẫn bình tiếp. Backend trả HTTP 200 + `success:false`; runner không kiểm `res.ok/data.success` và vẫn gọi engine với fallback. | Backend `imposition.py:494-505`; runner `recipeRunners.ts:151-165`; test chỉ phủ response thành công. |
| **§PLAY.10** | **P1 / S** | Recipe mang theo `autoSavePrint/savePrintConfig` của đơn cũ và có thể tự ghi file vào folder/order code cũ khi chạy đơn mới hoặc sau import. | Capture `ImpositionTab.tsx:2011-2012` và không tước tại `:1660-1675`; side effect `processHandlers.ts:299-356`. |
| **§PLAY.11** | **P2 / S** | Một số biên prepress chưa fail-closed: `params.file_id` đè ID upload thật; không kiểm `dl.ok` trước commit; `hiddenOcgLayerIds` theo tài liệu bị phát lại trên tài liệu khác. | `recipeRunners.ts:84-98`; `api.ts:137-142`; `ImpositionTab.tsx:1998`; `processHandlers.ts:233`. |
| **§PLAY.12** | **P2 / S** | Step bị bỏ qua không có cảnh báo cụ thể và tiến trình Step i/N không hiện ổn định. Integration không nối `onWarn`; `onProgress` bị handler ghi đè trong khi overlay chỉ render khi `isProcessing`. Recipe 0 bước playable vẫn có thể báo thành công. | API `PlaybackRunner.ts:55-60`; call site thiếu `onWarn` `ImpositionTab.tsx:1773-1795`; toast `:1798-1800`; overlay `:2840-2855`; nút play `RecipePanel.tsx:228-272`. |

### Gốc kiến trúc chung của §PLAY.1–2

Playback chỉ sở hữu `currentBytes/currentName`; không có `currentPath` hay một artifact union kiểu `{ name, path?, bytes? }` (`ImpositionTab.tsx:1752-1780`). Vì vậy sửa riêng “truyền thêm tham số thứ ba” chưa đủ: bước kế vẫn cần nhận đúng path mới, invalidation đúng bytes/path và không nạp PDF lớn vào V8 khi đã có file native.

---

## 4. Findings — tính đúng và ownership của Recorder

| Mã | Mức / effort | Finding đã xác nhận | Bằng chứng |
|---|---|---|---|
| **§REC.1** | **P1 / S** | Hủy job để lại `pendingNote`. Nếu thao tác kế không có hook nhưng có commit (ví dụ Crop), commit đó nuốt note của job đã hủy và tạo Step sai nhãn/settings. | Cancel return im lặng `processHandlers.ts:364-431`; hook dọn chỉ khi `setError(msg)` `ImpositionTab.tsx:1617-1621`; Crop commit `:1051-1058`; ghép note `RecipeRecorder.ts:102-122`. |
| **§REC.2** | **P1 / S** | `shuffle/split_odd_even` bị ép `spawnNewTab=false` khi ghi nhưng handler vẫn spawn hai tab rồi return không commit; Step biến mất và pending treo. | Hook `ImpositionTab.tsx:1692-1697`; handler `processHandlers.ts:582-600`. |
| **§REC.3** | **P1 / M** | Recorder không có operation token; `pendingNote` là last-wins và `noteCommit` đọc note hiện tại. Nhiều callback làm rơi Promise của commit, trong khi commit desktop yield qua upload/fs rồi mới `noteCommit`; Dừng hoặc chạy thao tác kế có thể mất/tráo Step. | Store `RecipeRecorder.ts:78-122`; test đóng đinh last-wins `RecipeRecorder.test.ts:52-60`; commit trễ `ImpositionTab.tsx:969-1017`; router làm rơi Promise `PreprocessingRouter.tsx:222-260,285,304,308,316`; ConvertColors hạ running `ConvertColorsTool.tsx:123-130`. |
| **§REC.4** | **P1 / L** | Nhiều transformation reachable không có `noteOperation/noteNonRecordable`; bản release chỉ bỏ qua im lặng. Nhóm cũ vẫn gồm Crop, xóa object, Catalog, Preflight, OCR, Watermark, Encrypt, Metadata, Office, Header/Footer; FontTools/Upscale mới cũng chưa có contract. | Cảnh báo chỉ DEV `RecipeRecorder.ts:105-111`; các entry tiêu biểu `ImpositionTab.tsx:1051-1058,1195-1230,1683-1687`; `PreprocessingRouter.tsx:256,285,304,308,316`. |
| **§REC.5** | **P1 / M** | Undo tài liệu không rút Step đã ghi. Recipe lưu vẫn chứa thao tác mà người dùng vừa hoàn tác. | Recorder không có rollback API `RecipeRecorder.ts:39-60`; Undo đổi file/history trực tiếp `ImpositionTab.tsx:1366-1415`. |
| **§REC.6** | **P1 / M** | Recorder là singleton toàn app, không có `tabId/owner`; mọi tab vẫn mounted. Job nền hoặc thao tác ở tab khác có thể ghi đè pending note của tab đang ghi. | `RecipeRecorder.ts:39-143`; `App.tsx:1394-1421`; control từng tab `ImpositionTab.tsx:2956-2961`. |
| **§REC.7** | **P1 / S** | Có thể Phát trong lúc đang Ghi. Commit đầu playback vẫn đi qua singleton recorder và có thể tiêu thụ pending note của thao tác người dùng. | Panel không nhận trạng thái record `RecipePanel.tsx:20-29,118-124,264-272`; `playRecipe` không guard `ImpositionTab.tsx:1739-1751`; mọi commit gọi recorder `:1014-1017`. |
| **§REC.8** | **P2 / M** | `viewerPageOrder/viewerPageRotations` là contract chết: production không truyền extras và playback không đọc; chỉ test tạo ra dữ liệu này. Trong khi đó Booklet lại đưa dữ liệu per-file qua cửa sau trong `params` (§PLAY.3). | Commit production `ImpositionTab.tsx:1014-1017`; field `recipeTypes.ts:47-53`; chỉ test `RecipeRecorder.test.ts:79-85`; playback không có consumer. |
| **§REC.9** | **P2 / S** | Đóng/reset tab hoặc không còn file không kết thúc phiên ghi. Nút Dừng chỉ render khi có `file`; toàn repo không gọi `recipeRecorder.cancel()` khi đóng/reset. | `ImpositionTab.tsx:2956-2961`; reset `:2029-2059`; đóng tab `App.tsx:638-674`; API cancel `RecipeRecorder.ts:136`. |
| **§REC.10** | **P2 / S** | X/nền/Hủy dialog lưu làm mất draft đã stop, không xác nhận và không có đường mở lại. | Steps chuyển vào state local `RecipeRecordControl.tsx:36-42`; các đường đóng `:85-90,128-136,183-188`; lần start sau reset `RecipeRecorder.ts:68`. |

**Finding cũ B.6 đã đóng:** `InkManagerTool` hiện reachable qua `PreprocessingRouter.tsx:239-240` và có hook `InkManagerTool.tsx:91-104`.

---

## 5. Findings — lưu trữ và UI quản lý Recipe

| Mã | Mức / effort | Finding đã xác nhận | Bằng chứng |
|---|---|---|---|
| **§STORE.1** | **P1 / S** | Xóa recipe không hoạt động trên Tauri. `deleteRecipe` gọi plugin-fs `remove` nhưng capability không có `fs:allow-remove`; lỗi bị nuốt, UI vẫn toast “Đã xóa”, refresh đọc file đĩa và recipe hiện lại. | `recipeStore.ts:129-139`; quyền hiện có `default.json:20,60,100,139,180`; UI `RecipePanel.tsx:175-180`. |
| **§STORE.2** | **P1 / M** | Fallback ghi-một-nơi/đọc-một-nơi. Ghi native lỗi thì rơi localStorage và vẫn báo thành công; khi `read_dir_json` hoạt động, load return danh sách đĩa mà không merge fallback. | `recipeStore.ts:78-126`; toast save `RecipeRecordControl.tsx:118-120`. Fallback `writeTextFile` cũng thiếu permission riêng. |
| **§STORE.3** | **P2 / M** | Không có validation/migration schema đúng nghĩa. Guard nhận mọi chuỗi `opId` và mọi number `schemaVersion`; import recipe tương lai rồi ép nhãn v1. | `recipeTypes.ts:111-134`; `recipeStore.ts:163-171`; yêu cầu migration `design.md:125`. |
| **§STORE.4** | **P2 / M** | JSON hỏng bị bỏ im lặng; đọc/import không giới hạn số lượng/kích thước; lỗi quota/lỗi ghi bị gộp thành “file quy trình không hợp lệ”. | `recipeStore.ts:66-69,89-94,176-182`; Rust `lib.rs:3674-3686`; UI `RecipePanel.tsx:191-197`. |
| **§STORE.5** | **P1 / M** | Ô số controlled ép chuỗi trung gian rỗng thành `0` rồi lưu ngay. Việc gõ số âm/thập phân hoặc xóa để nhập lại có thể ghi tham số in sai. | `RecipePanel.tsx:79-85,138-166`. |
| **§STORE.6** | **P2 / M** | Mỗi phím sửa param gây một atomic write; ô JSON không thể xóa trắng và mất bản nháp khi unmount. Phần “race thứ tự ghi” chưa đủ bằng chứng, chỉ disk churn/mất draft được xác nhận. | `RecipePanel.tsx:98-110,138-166`; `recipeStore.ts:105-126`. |
| **§STORE.7** | **P3 / S** | CRUD mô tả chưa đủ: `description` chỉ nhập lúc tạo, không được hiển thị/sửa trong panel. | Requirement 2.2; tạo `RecipeRecordControl.tsx:105-116`; rename chỉ sửa tên `RecipePanel.tsx:183-188`. |

---

## 6. Findings — chất lượng kiểm thử và hồ sơ spec

| Mã | Mức / effort | Finding đã xác nhận | Bằng chứng |
|---|---|---|---|
| **§TEST.1** | **P1 / M** | Không có round-trip integration record → save → load → playback. Task 12.1 vẫn chưa hoàn thành; đúng nơi §PLAY.1–10 sống. | `.kiro/specs/recipe-record-playback/tasks.md:84-91`; không có component/integration test cho `playRecipe`. |
| **§TEST.2** | **P2 / M** | Store test chỉ dùng localStorage; không test Tauri invoke/plugin-fs. Test “sắp xếp mới nhất trước” sort cả hai vế nên không kiểm thứ tự. | `recipeStore.test.ts:5-23,44-52`. |
| **§TEST.3** | **P2 / M** | Không có component test cho `RecipePanel`/`RecipeRecordControl`: thiếu số âm/thập phân, JSON draft, discard dialog, play-while-recording, cảnh báo skip và accessibility dialog. | Không có file test tương ứng trong `desktop/src/components/recipe/`. |
| **§TEST.4** | **P2 / S** | Runner test thiếu các contract nguy hiểm: `existingPath/currentPath`, cancel, Merge interleave/insert, Rectangle, detect failure. Mock còn thiếu `runTrimShift`, nên runner này chưa từng được gọi. | `recipeRunners.test.ts:12-18`; test Rectangle `:178-194` không assert `rectangle_mode`. |

### Verify đã chạy trong đợt audit

```text
npx.cmd vitest run src/lib/recipe \
  src/lib/processHandlers.test.ts \
  src/lib/processHandlers.mixedGuillotine.test.ts \
  src/components/preprocess-tools/PageToolsPanel.test.ts

10 test files passed
93 tests passed

npm.cmd run typecheck
PASS
```

Không chạy build, không tạo installer, không chạy backend PDF artifact và không mở Tauri runtime trong Giai đoạn 1.

---

## 7. Đối chiếu báo cáo 2026-07-27

| Nhóm cũ | Trạng thái re-audit |
|---|---|
| A.1 mất `existingPath` | **Còn nguyên** — §PLAY.1 |
| A.2 stale source path | **Còn nguyên, lan thêm Resize** — §PLAY.2 |
| A.3 page state per-file | **Còn ở Booklet**; N-Up hiện không tiêu thụ trực tiếp — §PLAY.3/§REC.8 |
| A.4 thiếu await commit | **Còn TrimShift + Split nhỏ** — §PLAY.7 |
| A.5 Split ZIP/giữ file đầu | **Còn nguyên** — §PLAY.4 |
| B.1–B.5, B.7 | **Còn** — §REC.1–8 |
| B.6 InkManager không reachable | **Đã sửa** |
| C.1–C.6, C.8–C.9 | **Còn** — §PLAY.5, §PLAY.8–11 |
| C.7 Spot→CMYK | **Đã thay bằng engine object-level fail-closed**; không giữ finding cũ |
| C.10 target quantity per page | **EXPECTED v1**, nhưng UI cần nói rõ nếu tiếp tục giữ |
| D.1–D.4 | **Còn** — §STORE.1–4 |
| D.5 ghi mỗi phím | Disk churn **còn**; claim resolve lệch thứ tự chỉ giữ `[SUSPECTED]` |
| E.1 picker `oncancel` | Chưa đủ runtime để gọi lỗi; giữ `[SUSPECTED]` |
| E.2–E.8, E.10 | Phần lớn **còn** — đã gom vào §PLAY/§REC/§STORE |
| F.1–F.5 | **Còn** — §TEST.1–4 |

Không có tài liệu `RECIPE_FIXES_*` giữa hai lần audit; code hiện tại xác nhận các finding cao nhất trước đây chưa được đóng có hệ thống.

---

## 8. Quyết định sản phẩm cần chốt trước khi sửa

1. **Split trong Recipe:** khuyến nghị v1 đánh `recordable=false` cho mọi mode có thể sinh nhiều file; chỉ mở lại khi Recipe có mô hình multi-output rõ ràng.
2. **Merge input ngoài:** khuyến nghị schema input có role và cardinality (`files[]`, `odd`, `even`, `insert`) thay vì một cờ chung `needsExternalInput: 'file'`.
3. **Page reorder/rotation:** khuyến nghị coi chỉ số trang tuyệt đối là file-dependent; materialize chúng vào working input trước khi ghi hoặc bỏ qua+cảnh báo, không lưu vào params Booklet.
4. **Tự lưu file in:** khuyến nghị không lưu folder/order code vào recipe chia sẻ; khi phát thì dùng cấu hình hiện tại hoặc hỏi lại.
5. **Ownership:** khuyến nghị một phiên ghi thuộc đúng `tabId + recordingSessionId`; playback có `playbackSessionId` và không được chạy trên tab/session đang ghi.

---

## 9. Quick-win và thứ tự sửa đề xuất

### Lô R1 — Working artifact và dừng sạch (≤5 file)

**Mục tiêu:** đóng §PLAY.1, §PLAY.2, §PLAY.6, §PLAY.7; tránh fix nửa vời.

- `desktop/src/components/ImpositionTab.tsx`
- `desktop/src/lib/recipe/PlaybackRunner.ts`
- `desktop/src/lib/recipe/recipeRunners.ts`
- `desktop/src/lib/processHandlers.ts`
- test integration mới cho chain `{ name, path?, bytes? }`

Verify bắt buộc: native-path N-Up/Booklet → bước prepress → bước Resize; cancel tại bước giữa; commit Promise bị trì hoãn; file >300 MB không bị ép nạp vào WebView khi có path.

### Lô R2A — Parity engine khi phát (≤5 file)

**Mục tiêu:** §PLAY.3, §PLAY.8–11.

- `ImpositionTab.tsx`
- `recipeRunners.ts`
- `processHandlers.ts`
- `recipeRunners.test.ts`
- `processHandlers.test.ts`

Tước per-document/autosave fields, gửi `rectangle_mode`, fail-closed detect/download và khóa test response lỗi.

### Lô R2B — Multi-output và external input (≤5 file)

**Mục tiêu:** §PLAY.4–5 sau khi user duyệt quyết định Split/Merge.

- `recipeTypes.ts`
- `recipeOps.ts`
- `PlaybackRunner.ts`
- `RecipePanel.tsx`
- test schema/input mới

### Lô R3 — Recorder có owner và operation token (≤5 file)

**Mục tiêu:** §REC.1–3, §REC.5–7, §REC.9–10.

- `RecipeRecorder.ts`
- `RecipeRecordControl.tsx`
- `RecipePanel.tsx`
- `ImpositionTab.tsx`
- `RecipeRecorder.test.ts`

Verify: hai tab, job nền, Hủy, Undo, Dừng trong lúc commit đang pending, play-while-recording, đóng tab/file.

### Lô R4 — Phủ hook theo nhóm (mỗi lô ≤5 file)

**Mục tiêu:** §REC.4/§REC.8. Chia theo nhóm tool, không sửa hơn năm file/lô. Mọi operation phải hoặc tạo Step đúng, hoặc tạo Step `recordable=false` + cảnh báo; không còn commit im lặng trong release.

### Lô R5 — Lưu trữ desktop fail-loud (≤5 file)

**Mục tiêu:** §STORE.1–4.

- `recipeStore.ts`
- `recipeTypes.ts`
- `RecipePanel.tsx`
- `desktop/src-tauri/src/lib.rs` **hoặc** capability scoped được duyệt
- `recipeStore.test.ts`

Khuyến nghị ưu tiên command Rust xóa JSON giới hạn đúng `%APPDATA%/.../recipes` thay vì cấp quyền remove rộng; merge/migrate fallback có provenance và lỗi lưu phải hiện thật.

### Lô R6 — UI nhập liệu và test round-trip (≤5 file)

**Mục tiêu:** §STORE.5–7, §PLAY.12, §TEST.1–4.

- `RecipePanel.tsx`
- `RecipeRecordControl.tsx`
- hai component/integration test mới
- `.kiro/specs/recipe-record-playback/tasks.md`

Chỉ đánh Task 12.1 hoàn thành sau khi có PDF artifact và runtime Tauri cho ít nhất hai kịch bản ruột sách + tem nhãn.

---

## 10. Cổng nghiệm thu sau sửa

Không nâng toàn luồng lên `AUTO/ARTIFACT/RUNTIME` nếu thiếu một trong các cổng sau:

1. **Chain artifact:** `convertcolors → N-Up → optimize` và `sticker_dieline → detect → sticker_imposer`; output mỗi bước là input bước kế, parse được PDF cuối.
2. **Native path:** Booklet/N-Up trả path, không tạo carrier 0/11 byte trong Viewer hay bytes chain.
3. **Cancel/Undo:** Hủy không tăng completed, không chạy bước kế, không để pending note; Undo rút hoặc đánh vô hiệu Step tương ứng.
4. **Multi-tab:** tab nền/đã đóng không ghi, commit hoặc nhận cảnh báo của tab khác.
5. **Persistence Tauri:** tạo/restart/rename/delete/import/export thật trên clean AppData; lỗi quyền/đĩa phải fail-loud.
6. **Artifact parity:** Xén vuông và tem dò hình lỗi/success có fixture thật; Rectangle phát lại khớp tool tương tác về MediaBox/TrimBox/bleed.
7. **Installed smoke:** chỉ chạy sau khi source đã commit/push theo rule build; không dùng artifact cũ để chứng nhận Recipe mới.

---

## 11. Chốt duyệt

User đã duyệt **Lô R1**. Phần sửa đã hoàn tất ở mức test tự động; chưa build, chưa commit/push và chưa dùng kết quả này để chứng nhận artifact/runtime. Các lô R2A–R6 vẫn phải giữ đúng phạm vi và chốt duyệt tương ứng.

---

## 12. Cập nhật sau sửa — Lô R1

Nhật ký chi tiết: `docs/RECIPE_FIXES_2026-08-15.md`.

| Finding | Trạng thái |
|---|---|
| `§PLAY.1` mất native path/carrier giả | **Đã sửa / AUTO** |
| `§PLAY.2` stale source path | **Đã sửa / AUTO** |
| `§PLAY.6` Hủy bị tính hoàn thành | **Đã sửa / AUTO** |
| `§PLAY.7` thiếu await commit | **Đã sửa / AUTO** |
| `§REC.1` pending sau Hủy/no-commit | **Đã sửa trong wrapper handler / AUTO-PARTIAL**; ownership đầy đủ vẫn thuộc R3 |

Hai P0 còn mở sau R1 là `§PLAY.3` (Booklet page state theo file cũ) và `§PLAY.4` (Split ZIP/multi-output). Chưa có PDF artifact hoặc Tauri runtime nên toàn tính năng chưa được nâng quá `TRACED`; chỉ các contract đã khóa bằng regression mới đạt `AUTO`.
