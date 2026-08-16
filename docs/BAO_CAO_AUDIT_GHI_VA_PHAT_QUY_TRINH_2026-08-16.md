# Báo cáo re-audit — Ghi & Phát quy trình (Recipe)

**Ngày:** 2026-08-16
**Audit unit:** `W6-U02` (master matrix hàng 8a)
**Baseline:** `4f513d8` — nhánh `codex/pre-release-audit-2026-08-04`
**Phạm vi:** `desktop/src/lib/recipe/*`, `desktop/src/components/recipe/*`, điểm nối trong `ImpositionTab.tsx`, `processHandlers.ts`, `PreprocessingRouter.tsx` + các tool prepress/VDP/edit, lưu trữ Tauri/localStorage, capability `src-tauri`, và các route backend mà playback gọi lại.
**Đối chiếu:** `.kiro/specs/recipe-record-playback/*`, `docs/BAO_CAO_AUDIT_RECIPE_2026-07-27.md`, `docs/BAO_CAO_AUDIT_GHI_VA_PHAT_QUY_TRINH_2026-08-15.md`, `docs/RECIPE_FIXES_2026-08-15.md`, `docs/PRYNX_MASTER_AUDIT_MATRIX.md`.
**Trạng thái:** GIAI ĐOẠN 2 — chờ duyệt danh mục. **Chưa sửa production code trong đợt này.**

> **Lưu ý worktree:** worktree đang có thay đổi chưa commit thuộc đợt audit "Bù xén / Tạo đường cắt" (`docs/BAO_CAO_AUDIT_BU_XEN_TAO_DUONG_CAT_2026-08-16.md`), trong đó có `desktop/src/lib/recipe/recipeRunners.ts` và `recipeRunners.test.ts`. Đợt này **không trộn vào phạm vi sửa** của Recipe; các finding có bằng chứng nằm trong phần chưa commit đều được ghi rõ.

---

## 1. Kết luận điều hành

Lô R1 (2026-08-15) đã đóng đúng phần khó nhất: chuỗi working artifact `path | bytes`, outcome Hủy và commit tuần tự. Đợt R2A/R3 sau đó cũng đã vào code: recorder có **vé thao tác** (`RecipeOperationTicket`) + `tabId` sở hữu, sanitize tham số theo tài liệu, fail-closed cho `detect-shape` và download prepress, chặn Split nhiều output ở cả hai đầu. **Cả 4 P0 của báo cáo 2026-08-15 đều không còn tái hiện trên baseline hiện tại.**

Nhưng trọng tâm rủi ro đã **dịch chỗ, chưa mất đi**:

- Guard `assertRecipeCommitAllowed` là fail-closed đúng nguyên tắc, nhưng **11 đường thay working file chưa được nối vé**. Khi đang ghi, các đường này không tạo Step mà **ném lỗi vào một Promise không ai await** → thao tác im lặng không xảy ra, và ít nhất 4 tool vẫn **bật cờ thành công**. Người dùng tin là đã đóng dấu / đã sửa metadata / đã cắt khổ, trong khi file không đổi. Đây là finding nặng nhất còn lại (§REC.4).
- `handleEditCommit` (sửa đối tượng) **không đi qua `commitWorkingFile`** nên không có cả guard: nó thay working file giữa phiên ghi mà recorder không biết gì (§REC.11).
- Chuỗi Merge vẫn chưa có hợp đồng input ngoài theo vai trò: `interleave` chắc chắn dừng recipe, `insert_pages` vỡ bằng `TypeError` vì `insertFile` bị `JSON.stringify` thành `{}` (§PLAY.5).
- Xóa recipe trên bản desktop vẫn **không hoạt động** vì thiếu `fs:allow-remove`, mà UI vẫn toast "Đã xóa" (§STORE.1).
- Ô nhập số trong panel vẫn ép chuỗi trung gian về `0` **và lưu ngay xuống đĩa mỗi phím** (§STORE.5).

Bằng chứng cao nhất của toàn luồng vẫn là **`TRACED`**; các hợp đồng đã khóa bằng regression đạt **`AUTO`**. Chưa có `ARTIFACT` (chưa parse PDF thật của chuỗi record→play) và chưa có `RUNTIME` (chưa chạy Tauri thật). Không được coi "Phát quy trình" là đã nghiệm thu.

**Tổng: 26 finding còn mở** — 1× P0, 10× P1, 12× P2, 3× P3. **11 finding cũ đã đóng** (verify lại từng cái ở §3).

---

## 2. Audit unit và đường chạy sống

| Mã | Hành động người dùng → kết quả | Đường trace chính | Bằng chứng | Khoảng trống |
|---|---|---|---|---|
| `REC-01` | Ghi → chạy thao tác → Dừng → danh sách Step | `RecipeRecordControl.tsx:46-60` → hook `ImpositionTab.tsx:1699-1860` / tool prepress → `RecipeRecorder.ts:104-140` (`createPending`) → `commitWorkingFile` `ImpositionTab.tsx:927-1092` → `noteCommit` `:1076` | `TRACED + AUTO` (146 test, xem §6) | Không phủ 11 đường commit không vé; không phủ Undo; không phủ đóng file giữa phiên |
| `STORE-01` | Đặt tên/Lưu → restart → rename/xóa/import/export | `RecipeRecordControl.tsx:127-145` / `RecipePanel.tsx:139-197` → `recipeStore.ts:78-182` → `write_file_atomic` / `read_dir_json` | `TRACED + AUTO` chỉ nhánh localStorage | Nhánh Tauri, quyền xóa, merge fallback, quota, migration vẫn không test |
| `PLAY-01` | Chọn recipe → Phát → output bước N là input N+1 | `RecipePanel.tsx:168-172` → `ImpositionTab.tsx:1865-1986` → `workingArtifact.ts:107-186` → `PlaybackRunner.ts:76-232` → `recipeRunners.ts` → backend | `TRACED + AUTO` cho artifact controller và orchestrator | Không có test đi qua chính `playRecipe`; không có PDF artifact; không runtime |
| `OWN-01` | Ghi/phát/Hủy/đóng tab trong nhiều tab | `App.tsx` giữ mọi tab mounted → `recipeOwnerTabId` `ImpositionTab.tsx:174` → `setTabActive` `:340` → `cancel` on unmount `:347` | `TRACED + AUTO` (`RecipeRecordControl.test.tsx`, `RecipeRecorder.test.ts`) | `forceReset` không kết thúc phiên; chưa runtime hai tab thật |

**Đang đạt và cần giữ:** entitlement kiểm toàn chuỗi trước mutation đầu (`PlaybackRunner.ts:87-104`) rồi kiểm lại từng bước (`:131-142`), unknown op fail-closed (`recipeEntitlements.ts:49-66`); vé thao tác chống tráo Step giữa các tab (`RecipeRecorder.ts:200-215`).

---

## 3. Finding cũ đã đóng — đã verify lại trên baseline hiện tại

| Mã cũ | Trạng thái | Bằng chứng đóng |
|---|---|---|
| `§PLAY.1` mất native path / carrier 0-11 byte | **Đã đóng / AUTO** | `workingArtifact.ts:29-46` union `path\|bytes`; `:139-186` commit path xóa bytes cũ; `ImpositionTab.tsx:1897-1936` dựng controller |
| `§PLAY.2` stale source path | **Đã đóng / AUTO** | `workingArtifact.ts:83-90` facade dựng lại `file/getWorkingBytes/getWorkingSourcePath` mỗi Step; `ImpositionTab.tsx:1955-1959` |
| `§PLAY.3` Booklet mang page state file cũ | **Đã đóng phần phá hoại** | `recipeImpositionParams.ts:3-16` tước `pageOrder/pageRotations` cho **mọi** op bình bài; áp tại `ImpositionTab.tsx:1726`. **Còn dư nợ ngữ nghĩa → §PLAY.3R** |
| `§PLAY.4` Split multi-output/ZIP | **Đã đóng bằng chặn** | Chặn lúc ghi `ImpositionTab.tsx:1816-1822`; chặn lúc phát `recipeRunners.ts:62-74`; `recipeTypes.ts:15-17` |
| `§PLAY.6` Hủy bị tính completed | **Đã đóng / AUTO** | `ProcessOutcome` xuyên registry; `PlaybackRunner.ts:196-232` |
| `§PLAY.7` thiếu await commit | **Đã đóng** | `processHandlers.ts` các call site đã `await` |
| `§PLAY.8` thiếu `rectangle_mode` | **Đã đóng (bằng chứng ở worktree chưa commit)** | `recipeRunners.ts:284-303` dùng chung `buildStickerDielineFields` với `StickerTool.tsx:475` |
| `§PLAY.9` detect-shape lỗi vẫn bình tiếp | **Đã đóng** | `recipeRunners.ts:201` kiểm `res.ok/data.success/Array.isArray(shapes)`; backend trả 200+`success:false` tại `imposition.py:503-505` |
| `§PLAY.10` autosave/order code đơn cũ | **Đã đóng** | `recipeImpositionParams.ts:8-9` tước `autoSavePrint/savePrintConfig` |
| `§PLAY.11` `file_id` bị đè, thiếu `dl.ok`, `hiddenOcgLayerIds` | **Đã đóng** | `recipeRunners.ts:113` (`file_id` sau spread), `:124` kiểm `dl.ok`, `recipeImpositionParams.ts:6` |
| `§REC.1` pending rò sau Hủy | **Đã đóng / AUTO** | `ImpositionTab.tsx:99-113` `runRecordedProcess` dọn theo đúng vé ở cả `then` và `catch` |
| `§REC.3` recorder last-wins, không token | **Đã đóng / AUTO** | `RecipeRecorder.ts:104-140`, `:200-239`; `RecipeRecorder.test.ts:127-143` |
| `§REC.6` singleton không có owner | **Đã đóng** | `ImpositionTab.tsx:174`, `:340-342`; `RecipeRecordControl.tsx:36-44` |
| `§REC.7` phát trong khi đang ghi | **Đã đóng** | `ImpositionTab.tsx:1867-1871`; `RecipeRecordControl.tsx` `disabled={isRecipePlaying}` qua `:3144` |
| `§TEST.3` không có component test | **Đã đóng một phần** | `RecipeRecordControl.test.tsx` (3 ca ownership), `RecipeToolTicket.integration.test.tsx` (2 ca callback bất đồng bộ). `RecipePanel` vẫn trắng test |

---

## 4. Finding còn mở

### §REC — tầng ghi

| Mã | Mức / effort | Finding `[CONFIRMED]` | Bằng chứng |
|---|---|---|---|
| **§REC.4** | **🔴 P0 / L** | **11 đường thay working file không mang vé → khi đang ghi trở thành no-op im lặng, một số còn báo thành công.** `commitWorkingFile` ném lỗi nếu không có vé hợp lệ, nhưng các caller gọi `onFileFixed(...)` **không await** nên rejection rơi vào void: try/catch của tool không thấy, `setIsSuccess(true)` vẫn chạy. Người dùng thấy "thành công" mà file không đổi; nếu lưu ra đĩa thì giao cho khách bản **chưa** đóng dấu / chưa sửa metadata. | Guard `ImpositionTab.tsx:936-942`, `:1029`. Không vé: `PreprocessingRouter.tsx:228-229` (Preflight), `:237` (FontTools), `:262` (OCR), `:291` (Watermark), `:299` (Upscale), `:310` (Encrypt), `:314` (Metadata), `:322` (Office); `ImpositionTab.tsx:1118` (Cắt khổ, có await), `:1291` (Xóa đối tượng, **không** await), `:3410` (Header/Footer), `:3041` + `:3429` (`onFileFixed={commitWorkingFile}`). Báo thành công sai: `WatermarkTool.tsx:329-331`, `StickTextNumberTool.tsx:220-221`, `EncryptTool.tsx:83`, `:128`, `MetadataTool.tsx:122`, `PreflightTool.tsx:127`, `FontToolsTool.tsx:322`, `OcrTool.tsx:85` |
| **§REC.11** | **🟠 P1 / M** | **Sửa đối tượng thay working file ngoài mọi guard.** `handleEditCommit` tự `setFile/setPdfUrl/setSelectionFileId`, không đi qua `commitWorkingFile` nên recorder không biết và cũng không chặn. Ghi quy trình rồi sửa/di chuyển/xóa object ⇒ mọi Step **sau đó** được ghi trên nội dung đã sửa nhưng phát lại trên file mới sẽ chạy trên nội dung chưa sửa. | `ImpositionTab.tsx:1317-1391` (`setFile` tại `:1372`); được nối qua `editSession.onCommit` `:1396-1405` và `onEditCommit` `:3135` |
| **§REC.5** | 🟠 P1 / M | **Undo không rút Step đã ghi.** `handleUndo` chỉ pop `history` và `setFile`; recorder không có API rollback. Ghi → Optimize → Ctrl+Z ⇒ recipe lưu ra vẫn còn bước Optimize người dùng đã bỏ. | `ImpositionTab.tsx:1427-1477`; `RecipeRecorder.ts` không có API rút Step |
| **§REC.8** | 🟠 P1 / M | **`viewerPageOrder`/`viewerPageRotations` vẫn là hợp đồng chết.** 16 lời gọi `noteOperation` đều truyền `extras = undefined`; `PlaybackRunner` không có consumer. Yêu cầu 1.6 vẫn KHÔNG ĐẠT dù `tasks.md` đánh `[x]`. | `ImpositionTab.tsx:1727-1732`, `:1767`, `:1784`, `:1801`, `:1825`, `:1845`; `recipeTypes.ts:44-53`; điền duy nhất ở `RecipeRecorder.test.ts:184` |
| **§REC.2** | 🟡 P2 / S | `shuffle` + `specialAction='split_odd_even'` vẫn bỏ qua `spawnNewTab=false`: spawn hai tab rồi trả `PROCESS_COMPLETED` mà không commit. Không còn rò pending (đã có `runRecordedProcess`), nhưng Step **mất im lặng** — đúng lớp lỗi mà Split đã được chặn tường minh. | Hook ép cờ `ImpositionTab.tsx:1764-1772`; handler `processHandlers.ts:622-641` |
| **§REC.9** | 🟡 P2 / S | **Đóng file giữa phiên ghi làm khóa tính năng Ghi toàn app.** `forceReset` set `file=null` nhưng không `recipeRecorder.cancel`; nút Ghi/Dừng chỉ render `file ? …` ⇒ nút Dừng biến mất, `isRecording` vẫn true, mọi tab khác bị `isRecordingElsewhere` khóa cho tới khi đóng chính tab đó. | `ImpositionTab.tsx:2212-2245` (không gọi cancel), `:3139-3146`; `RecipeRecordControl.tsx:40-44`, `:67` |
| **§REC.10** | 🟡 P2 / S | X / nền / Huỷ dialog lưu ⇒ **mất trắng** draft đã Dừng, không xác nhận, không đường mở lại (`draftSteps` còn trong store nhưng không còn UI truy cập, và bị xóa ở lần `start` sau). | `RecipeRecordControl.tsx:55-60`, `:113-118`, `:157-165`, `:210-215`; `RecipeRecorder.ts:143-152` (`stop` không xóa draft), `:155-165` (`start` xóa) |

### §PLAY — tầng phát

| Mã | Mức / effort | Finding `[CONFIRMED]` | Bằng chứng |
|---|---|---|---|
| **§PLAY.5** | 🟠 P1 / M | **Merge chưa có vai trò/số lượng cho input ngoài.** `interleave`: recorder tước `oddFile/evenFile`, picker chỉ trả `files[0]` gắn vào `filesToMerge` ⇒ engine ném "Vui lòng chọn đủ 2 file nguồn" và **dừng cả recipe** sau khi đã bắt người dùng chọn file. `insert_pages`: `insertFile` **không** nằm trong danh sách tước ⇒ `JSON.stringify(File)` = `{}` (truthy, qua được guard) ⇒ `settings.insertFile.name.toLowerCase()` ném `TypeError` thô. Thêm nữa `afterPageNum` là chỉ số trang tuyệt đối = file-dependent trá hình. | Tước `ImpositionTab.tsx:1843-1844`; clone `recipeOps.ts:144`; runner `recipeRunners.ts:77-80`; consumer `PdfMerger.ts:54-57`, `:83-97`, `:135-141`; `processHandlers.ts:1226-1235` |
| **§PLAY.3R** | 🟠 P1 / S | **Thứ tự/góc xoay trang bị bỏ im lặng khi ghi.** Sau khi tước `pageOrder/pageRotations`, lượt chạy thật vẫn dùng chúng (`ImpositionTab.tsx:2034`, `:2153` → `pdfImposer.ts:596`) nhưng Step lưu lại thì không ⇒ phát lại **trên chính file đó** cũng không tái lập được kết quả đã duyệt, và không có một cảnh báo nào. Đây là dư nợ của quyết định sản phẩm #3 chưa chốt. | Tước `recipeImpositionParams.ts:4-5`; ghi `ImpositionTab.tsx:1726`; tiêu thụ `pdfImposer.ts:588-624` |
| **§PLAY.12** | 🟠 P1 / M | **Bước bị bỏ qua không có cảnh báo cụ thể; không có Hủy cấp recipe.** `onWarn` không được nối ở call site ⇒ chỉ hiện số đếm "bỏ qua N". `requestExternalInput` vẫn dựa vào `input.oncancel` không timeout/fallback ⇒ nếu WebView không bắn event thì Promise treo và `playingId` kẹt, mọi nút Phát lại disable vĩnh viễn. Recipe 0 bước chạy được vẫn báo "xong 0 bước". | API `PlaybackRunner.ts:55-61`, `:85-88`; call site không có `onWarn` `ImpositionTab.tsx:1955-1972`; picker `:1943-1953`; toast `:1974-1979`; nút play `RecipePanel.tsx:229-238` |
| **§PLAY.13** | 🟡 P2 / M | **Closure `base` cũ dùng cho mọi bước phát lại** ⇒ `commitWorkingFile` chụp `file`/`pdfUrl` của thời điểm bắt đầu: (1) mỗi bước đẩy **cùng một revision gốc** vào `history` nên Undo sau khi phát phải bấm N lần mới nhích; (2) `URL.revokeObjectURL(pdfUrl)` luôn thu hồi **URL đầu tiên**, nên các blob URL trung gian rò lại — mỗi bước một bản PDF đầy đủ trong RAM WebView. | `base` dựng một lần `ImpositionTab.tsx:1886`, dùng lại `:1956-1959`; `commitWorkingFile` đọc `file` `:1035`, `pdfUrl` `:1067-1068`; deps `:1084-1094` |
| **§PLAY.14** | 🟡 P2 / S | Trong nhánh có `existingPath`, `setPdfUrl(URL.createObjectURL(committedBlob))` tạo blob URL từ **carrier rỗng**. Native Viewer dùng `path` nên không lộ, nhưng đây là nguồn "trang trắng" khi bất kỳ consumer nào đọc `pdfUrl` (react-pdf fallback, in, preview) trong lượt phát lại. | `ImpositionTab.tsx:1068`; carrier `processHandlers.ts:301-307`, `pdfImposer.ts:786-798` |

### §STORE — lưu trữ và UI quản lý

| Mã | Mức / effort | Finding `[CONFIRMED]` | Bằng chứng |
|---|---|---|---|
| **§STORE.1** | 🟠 P1 / S | **Xóa recipe không hoạt động trên Tauri.** Capability chỉ cấp 5 quyền fs, **không có `fs:allow-remove`** ⇒ `tauriFs.remove` bị ACL từ chối ⇒ catch nuốt ⇒ ghi localStorage (đang rỗng) ⇒ toast "Đã xóa" ⇒ `refresh()` đọc lại đĩa và recipe hiện lại. | `capabilities/default.json:20,60,100,139,180`; `recipeStore.ts:130-141`; UI `RecipePanel.tsx:175-181` |
| **§STORE.2** | 🟠 P1 / M | **Ghi một nơi / đọc một nơi.** `saveRecipe` khi cả hai đường ghi đĩa fail thì âm thầm rơi localStorage và vẫn báo thành công; `loadRecipes` khi `read_dir_json` chạy được thì `return` danh sách đĩa, **không merge** ⇒ recipe "đã lưu" biến mất. `tauriFs.writeTextFile` (fallback `:122`) là code chết vì cũng thiếu quyền. | `recipeStore.ts:78-101` vs `:106-128`; `_tauriTried` một lần/phiên `:20,27-28`; toast `RecipeRecordControl.tsx:135` |
| **§STORE.5** | 🟠 P1 / S | **Ô số ép chuỗi trung gian về `0` rồi lưu ngay.** `'-'`, `'0.'`, xóa trắng đều thành `0`; mỗi phím là một `saveRecipe` (một atomic write). Trúng đúng tham số in thật: `offsetMm`, `bleedMm`, `gapX/gapY`, `marginLeft…`. | `RecipePanel.tsx:82-86`, `:139-143`, `:161-168`; `recipeStore.ts:106-128` |
| **§STORE.3** | 🟡 P2 / M | Không có validation/migration schema đúng nghĩa: `isRecipeStep` nhận **mọi** chuỗi `opId`, `isRecipe` nhận mọi `number` `schemaVersion`; import lại **ép** `schemaVersion = RECIPE_SCHEMA_VERSION` bất kể giá trị cũ ⇒ recipe v2 tương lai bị dán nhãn v1 và diễn giải sai. `design.md:125` yêu cầu migrate — không có code migrate. | `recipeTypes.ts:116-134`; `recipeStore.ts:163-175` |
| **§STORE.4** | 🟡 P2 / M | Recipe JSON hỏng bị bỏ **im lặng** (trái comment ngay dưới); không cap số lượng/kích thước khi đọc và import; `lsWrite` không try/catch ⇒ `QuotaExceededError` bị gộp thành "File quy trình không hợp lệ" — chẩn đoán sai hoàn toàn. | `recipeStore.ts:66-76`, `:89-94`, `:176-182`; `RecipePanel.tsx:191-198` |
| **§STORE.6** | 🟡 P2 / S | Ô JSON **không xóa trắng được** (`jsonText \|\| JSON.stringify(value)` — chuỗi rỗng falsy nên hiện lại giá trị cũ, `onBlur` bỏ qua parse); thu gọn bước khi JSON đang sai làm mất chữ đã gõ, không cảnh báo. | `RecipePanel.tsx:99-113` |
| **§STORE.8** | 🟡 P2 / S | `toggleStep` cho bật `recordable=true` trên op vốn file-dependent, **không có bất biến nào canh giữ**. Hiện vô hại vì mọi op non-recordable đều không có runner (bị bỏ qua `unsupported_op`), nhưng thêm một runner là Property 6 thủng ngay và bước `crop`/`object_edit` sẽ chạy trên tài liệu khác. | `RecipePanel.tsx:157-159`; `recipeOps.ts:58-90` vs `recipeRunners.ts:322-347` |
| **§STORE.7** | 🟢 P3 / S | `description` nhập lúc tạo, lưu xuống đĩa, **không hiển thị và không sửa được** ở panel (Requirement 2.2 chưa đủ). | `RecipeRecordControl.tsx:180-190`; `RecipePanel.tsx:183-190` |
| **§STORE.9** | 🟢 P3 / S | `recipe.id` được dùng trực tiếp làm tên file (`${dir}/${id}.json`) mà không validate token. Import tự sinh id nên **không có đường khai thác từ file người khác gửi**; chỉ trở thành traversal nếu attacker đã ghi được vào `%APPDATA%/…/recipes`. Đề nghị hardening (regex `^[a-z0-9-]+$`), không xếp vào lỗ hổng. | `recipeStore.ts:113`, `:133`, `:163-175` |

### §TEST — chất lượng kiểm thử và hồ sơ spec

| Mã | Mức / effort | Finding | Bằng chứng |
|---|---|---|---|
| **§TEST.1** | 🟠 P1 / M | **Không có test nào đi qua `playRecipe`** — chính wrapper nơi §PLAY.13/§PLAY.12 sống. Test gần nhất là `workingArtifact.test.ts` (mức lib, tự dựng controller). Task 12.1 vẫn `[ ]`. | Không có hit `playRecipe` trong toàn bộ `*.test.ts(x)`; `tasks.md:84-91` |
| **§TEST.4** | 🟡 P2 / S | Runner test còn thiếu ca nguy hiểm: Merge `interleave`/`insert_pages`, cancel giữa bước, và **toàn bộ nhóm §REC.4** (commit không vé khi đang ghi). Mock `../processHandlers` trong `recipeRunners.test.ts` từng thiếu `runTrimShift` — cần xác nhận lại sau khi worktree BX được commit. | `recipeRunners.test.ts` |
| **§TEST.2** | 🟡 P2 / M | `recipeStore.test.ts` chỉ phủ localStorage; nhánh Tauri (`read_dir_json` / `write_file_atomic` / `remove`) — đúng nơi §STORE.1/§STORE.2 sống — vẫn không có test. | `recipeStore.test.ts:5-23` |
| **§TEST.5** | 🟢 P3 / S | `tasks.md` còn đánh `[x]` cho hạng mục chưa đạt (page order/rotations của Task 4.2 — xem §REC.8). Hồ sơ spec đang nói quá thực trạng. | `.kiro/specs/recipe-record-playback/tasks.md` |

### §UX — thông báo

| Mã | Mức | Finding | Bằng chứng |
|---|---|---|---|
| **§UX.1** | 🟡 P2 / S | Một key `tabs.imposition:dang_xu_ly_file` = **"Đang xử lý"** đang gánh 6 tình huống chặn khác nhau: vé bị từ chối (4 chỗ), Catalog không ghi được, phát-trong-lúc-ghi. Người dùng nhận thông báo không liên quan đến lý do thật và không biết phải làm gì. | `ImpositionTab.tsx:1734`, `:1750`, `:1770`, `:1787`, `:1804`, `:1828`, `:1852`, `:1869`; `vi.json:5332` |

---

## 5. Đã bác bỏ / có chủ đích — ghi lại để lần sau không điều tra lại

| Nghi vấn | Kết luận | Bằng chứng |
|---|---|---|
| Recipe import từ đồng nghiệp có thể inject qua `preset` của bước Nén (Ghostscript `-dPDFSETTINGS`) | `[DISPROVED]` — backend allowlist và hạ về `ebook` nếu lạ | `pdf_tools.py:1115-1116` |
| Playback gán hình tem sai trang do lệch base khóa (0-based vs 1-based) | `[DISPROVED]` — runner dùng 0-based, khớp store và consumer | `recipeRunners.ts:207-211`; `GridSettingsSection.tsx:146`; `processHandlers.ts:215`; test `recipeRunners.test.ts:205` |
| `ctx.viewerNumPages` cũ làm bước sau tính sai số trang | `[DISPROVED]` — chỉ khai báo trong `ProcessContext`, không có consumer trong `processHandlers` | `processHandlers.ts:85` |
| `targetQuantitiesByPage` bị tước cho tem nhiều mẫu | `[EXPECTED v1]` — chủ đích, nhưng UI vẫn chưa nói rõ (giữ như 2026-07-27 §C.10) | `recipeImpositionParams.ts:19-24` |
| Recipe multi-output (Split ZIP) | `[EXPECTED v1]` — đã chặn tường minh hai đầu thay vì hỗ trợ | `ImpositionTab.tsx:1816`; `recipeRunners.ts:62-74` |

---

## 6. Verify đã chạy trong đợt audit

```text
npx.cmd vitest run src/lib/recipe src/components/recipe \
  src/components/preprocess-tools/RecipeToolTicket.integration.test.tsx \
  src/lib/processHandlers.test.ts

12 test files passed
146 tests passed        (29,94 s)

npm.cmd run typecheck
PASS  (tsc --noEmit -p tsconfig.app.json)
```

Không build, không tạo installer, không chạy backend để lấy PDF artifact, không mở Tauri runtime, không commit/push. Worktree giữ nguyên thay đổi của đợt BX.

---

## 7. Coverage gap và proof gap

**Coverage gap:** chưa đọc hết `ImposerDashboard.tsx` (chỉ trace các `onFileFixed` liên quan); chưa rà `UpscaleTool`/`BgRemover` ở mức nội bộ; chưa rà `OfficeConvertTool` chi tiết; backend chỉ kiểm các biên mà runner gọi.

**Proof gap:**
1. Không có PDF artifact cho chuỗi `convertcolors → N-Up → optimize` và `sticker_dieline → detect → sticker_imposer`.
2. Không có runtime Tauri: §STORE.1 (ACL), §PLAY.12 (`oncancel` của picker), §PLAY.13 (rò blob URL) chỉ ở mức đọc code.
3. §REC.4 chưa có reproducer tự động: cần một component test "đang ghi + tool không vé" để chứng minh no-op + cờ thành công sai.
4. `§PLAY.8` dựa trên code chưa commit của đợt BX; nếu đợt đó bị revert thì finding sống lại.

---

## 8. Quyết định sản phẩm cần chốt trước khi sửa

1. **§REC.4 — hướng xử lý cho 11 đường không vé:** (a) nối `noteNonRecordable` + cảnh báo cho tất cả (đúng Yêu cầu 1.4, nhiều việc), hay (b) chặn tường minh ở đầu vào khi đang ghi như Catalog đang làm ("Hãy dừng ghi rồi chạy tác vụ này"), hay (c) cả hai theo nhóm. **Khuyến nghị: (b) trước cho toàn bộ nhóm để dứt điểm no-op im lặng trong một lô, rồi (a) dần theo nhóm tool.**
2. **§REC.11 — Sửa đối tượng khi đang ghi:** chặn phiên ghi, hay cho phép và ghi Step `recordable=false` + cảnh báo? **Khuyến nghị: chặn**, vì edit theo toạ độ không thể phát lại và làm mọi Step sau lệch nguồn.
3. **§PLAY.5 — Merge:** đổi `needsExternalInput` thành schema có vai trò + số lượng (`files[]`, `odd`, `even`, `insert`), hay hạ `interleave`/`insert_pages` xuống `recordable=false` ở v1? **Khuyến nghị: hạ xuống v1**, mở lại khi có schema role/cardinality.
4. **§PLAY.3R — thứ tự/góc xoay trang:** materialize vào working input trước khi ghi Step, hay giữ tước + cảnh báo tường minh ("Quy trình sẽ không lưu thứ tự trang đã sắp")? **Khuyến nghị: cảnh báo trước, materialize sau** (rẻ và trung thực ngay).
5. **§STORE.1 — quyền xóa:** thêm `fs:allow-remove` scoped, hay viết command Rust `delete_recipe_json` chỉ cho phép đúng `%APPDATA%/…/recipes/*.json`? **Khuyến nghị: command Rust**, tránh mở quyền remove rộng cho renderer.

---

## 9. Lô sửa đề xuất (≤5 file/lô, verify hết lô mới sang lô kế)

| Lô | Mục tiêu | File dự kiến | Verify |
|---|---|---|---|
| **S1 — Dứt điểm no-op im lặng** | §REC.4 (theo quyết định #1), §REC.11, §REC.2 | `ImpositionTab.tsx`, `PreprocessingRouter.tsx`, `imposition-tools/types.ts`, + 1 test component mới | typecheck; vitest `src/lib/recipe src/components/recipe` + test mới chứng minh "đang ghi + tool không vé" không còn báo thành công sai |
| **S2 — Hợp đồng Merge + page state** | §PLAY.5, §PLAY.3R | `recipeOps.ts`, `recipeTypes.ts`, `ImpositionTab.tsx`, `recipeRunners.ts`, `recipeRunners.test.ts` | vitest recipe + ca `interleave`/`insert_pages`; thử tay 1 file |
| **S3 — Lưu trữ desktop fail-loud** | §STORE.1, §STORE.2, §STORE.3, §STORE.4 | `recipeStore.ts`, `recipeTypes.ts`, `src-tauri/src/lib.rs` **hoặc** capability đã duyệt, `recipeStore.test.ts` | vitest store (thêm mock nhánh Tauri) + thử xóa/rename/restart thật trên AppData sạch |
| **S4 — UI nhập liệu và phản hồi phát lại** | §STORE.5, §STORE.6, §STORE.8, §PLAY.12, §UX.1 | `RecipePanel.tsx`, `RecipeRecordControl.tsx`, `ImpositionTab.tsx`, `vi.json`/`en.json`, 1 test component mới | typecheck + vitest; thử tay gõ `-0.5` vào `offsetMm` |
| **S5 — Vòng đời phiên ghi** | §REC.5, §REC.9, §REC.10, §REC.8 | `RecipeRecorder.ts`, `RecipeRecordControl.tsx`, `ImpositionTab.tsx`, `RecipeRecorder.test.ts` | vitest; thử tay Undo / đóng file giữa phiên / hai tab |
| **S6 — Vệ sinh chuỗi phát lại** | §PLAY.13, §PLAY.14 | `ImpositionTab.tsx`, `workingArtifact.ts` (nếu cần), + test integration `playRecipe` | vitest + đo số blob URL và số entry history sau chuỗi 4 bước |
| **S7 — Test & hồ sơ** | §TEST.1, §TEST.2, §TEST.4, §TEST.5 | các `*.test.ts(x)`, `tasks.md`, master matrix | vitest đầy đủ; chỉ đánh Task 12.1 khi đã có PDF artifact + runtime Tauri |

---

## 10. Cổng nghiệm thu (giữ nguyên từ 2026-08-15, bổ sung 2 cổng)

1. **Chain artifact:** `convertcolors → N-Up → optimize` và `sticker_dieline → detect → sticker_imposer`, parse được PDF cuối.
2. **Native path:** Booklet/N-Up trả path, không có carrier 0/11 byte trong Viewer hay chuỗi bytes.
3. **Cancel/Undo:** Hủy không tăng `completed`, không để pending; Undo rút hoặc vô hiệu Step tương ứng.
4. **Multi-tab:** tab nền/đã đóng không ghi, không commit, không nhận cảnh báo của tab khác.
5. **Persistence Tauri:** tạo/restart/rename/delete/import/export thật trên AppData sạch; lỗi quyền/đĩa fail-loud.
6. **Artifact parity:** Xén vuông và tem dò-hình-lỗi có fixture thật.
7. **Installed smoke:** chỉ sau khi source đã commit theo rule build.
8. **[MỚI] Không no-op im lặng:** với mỗi tool có thể thay working file, chạy khi đang ghi phải cho **một** trong hai kết cục — tạo Step (recordable hoặc không) **hoặc** bị chặn kèm lý do đúng. Không tool nào được báo thành công mà file không đổi.
9. **[MỚI] Vệ sinh RAM khi phát:** chuỗi 4 bước không để lại blob URL trung gian và không đẩy N entry Undo trùng revision.

---

## 11. Chốt duyệt

Chưa sửa gì. Cần user chốt 5 quyết định ở §8 và duyệt thứ tự lô ở §9 (đề nghị bắt đầu **S1**, vì §REC.4 là P0 duy nhất và là thứ có thể giao file sai cho khách hàng). Sau mỗi lô sẽ ghi tiếp `docs/RECIPE_FIXES_2026-08-16.md` và cập nhật `docs/PRYNX_MASTER_AUDIT_MATRIX.md` hàng `W6-U02`.

---

## 12. Cập nhật sau Lô S1 — trạng thái worktree lúc 2026-08-16 19:00

User đã duyệt phương án **(b) chặn tường minh** cho `§REC.4`. Lô S1 được triển khai trong **worktree, CHƯA commit** (một phiên làm việc song song). Ghi lại ở đây để lần sau không audit lại phần đã sửa.

**File thuộc lô S1 (chưa commit):** `desktop/src/lib/recipe/unrecordedCommit.ts` (mới), `unrecordedCommit.test.ts` (mới), `desktop/src/lib/recipe/recipeTypes.ts`, `desktop/src/lib/recipe/recipeRunners.ts`, `desktop/src/components/ImpositionTab.tsx`, `desktop/src/i18n/locales/vi.json`, `en.json`.

| Finding | Trạng thái | Cách sửa đã dùng |
|---|---|---|
| `§REC.4` | **Đã sửa / AUTO-PARTIAL** | Cửa chung `commitToolWorkingFile` (`ImpositionTab.tsx:1109-1126`) + module thuần `unrecordedCommit.ts`. Quyết định lấy **trước** commit và trả về giá trị, không phải exception. Vì `ImposerDashboard` truyền `onFileFixed` xuống `PreprocessingRouter:1683`, một chỗ sửa phủ Preflight, FontTools, OCR, Watermark, Upscale, Encrypt, Metadata, Office, Header/Footer (`:3490`) và Output Preview (`:3121`). Chặn kèm lý do bằng toast `thao_tac_chua_ghi_duoc_vao_quy_trinh`. **Còn dư → §REC.4R.** |
| `§REC.11` | **Đã sửa / TRACED** | Không chặn mà **ghi Step trung thực**: `handleEditCommit` gọi `noteNonRecordable('object_edit')` (`ImpositionTab.tsx:1366-1381`), `noteCommit` sau khi đổi xong working file, `discardPending` ở `catch`. Người dùng không mất op đang nằm trong RAM phiên sửa, phát lại sẽ bỏ qua + cảnh báo. Tốt hơn phương án chặn đã đề xuất ở §8. |
| `§REC.2` | **Đã sửa** | Chặn `split_odd_even` khi đang ghi (`ImpositionTab.tsx:1832-1838`), cùng khuôn với Tách nhiều file. |
| `§PLAY.5` | **Đã sửa** | `isLinearRecipeMergeMode` (`recipeTypes.ts:20-30`); chặn lúc ghi (`ImpositionTab.tsx:1914-1918`), chặn lúc phát (`recipeRunners.ts:78-90`), và tước `insertFile` khỏi params ghi. |
| `§PLAY.3R` | **Đã sửa** | `hasDocumentBoundPageState` (`recipeTypes.ts:35-52`) + toast `quy_trinh_khong_luu_thu_tu_trang` (`ImpositionTab.tsx:1787-1793`). |

### Finding phát sinh trong khi verify lô S1

| Mã | Mức | Nội dung | Trạng thái |
|---|---|---|---|
| **§I18N.1** | 🟠 P1 / S | Khóa `lib.processHandlers:merge_mode_khong_the_phat_noi_tiep` chỉ có ở `vi.json`, thiếu `en.json` ⇒ `i18nCatalog.test.ts` đỏ (release gate). | **Đã sửa** — thêm bản EN tại `en.json:2008` |
| **§REC.4R** | 🟠 P1 / M | Tool bị chặn vẫn **bật cờ thành công**: người dùng thấy đồng thời toast chặn và dấu tick xanh. Và việc chặn xảy ra **sau** khi tool đã xử lý xong (đóng dấu cả tập rồi mới báo). Cổng nghiệm thu #8 đạt phần "chặn có lý do", chưa đạt phần "không báo thành công sai". | **Mở** |
| **§REC.4S** | 🟡 P2 / S | `StickerCutlineTool.tsx:109` (đường AI Tách nhiều tem) commit **không mang vé** nên bị cửa chung chặn thay vì tạo Step. File thuộc đợt BX đang sửa dở → xử lý sau khi đợt đó commit. | **Mở** |

### Verify sau lô S1 (đã chạy trên Windows thật)

```text
npx.cmd vitest run src/lib/recipe src/components/recipe \
  src/components/preprocess-tools/RecipeToolTicket.integration.test.tsx \
  src/lib/processHandlers.test.ts
13 test files passed · 151 tests passed

npx.cmd vitest run src/i18n/i18nCatalog.test.ts
1 file · 5 tests passed

npm.cmd run typecheck
PASS
```

Chưa build, chưa commit, chưa chạy `run_dev.bat`. `§REC.4` vẫn thiếu test "đang ghi + tool không vé" nên chỉ đạt AUTO-PARTIAL.

### Còn mở sau S1

21 finding: `§REC.4R`, `§REC.4S`, `§REC.5`, `§REC.8`, `§REC.9`, `§REC.10`, `§PLAY.12`, `§PLAY.13`, `§PLAY.14`, `§STORE.1–9`, `§TEST.1`, `§TEST.2`, `§TEST.4`, `§TEST.5`, `§UX.1`. Không còn P0. Thứ tự lô đề xuất ở §9 giữ nguyên, bỏ S1; lô kế an toàn nhất là **S3 (lưu trữ desktop fail-loud)** vì không chạm file mà phiên song song đang mở.
