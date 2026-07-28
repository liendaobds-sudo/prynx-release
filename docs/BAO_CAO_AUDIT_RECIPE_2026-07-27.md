# Báo cáo Audit — Tính năng Recipe (Ghi & Phát lại quy trình)

**Ngày:** 2026-07-27 · **Phạm vi:** `desktop/src/lib/recipe/*`, `desktop/src/components/recipe/*`, hook ghi trong `ImpositionTab.tsx` + 8 tool prepress, đường phát lại qua `processHandlers.ts`, lưu trữ Tauri/localStorage.
**Đối chiếu spec:** `.kiro/specs/recipe-record-playback/{requirements,design,tasks}.md`
**Trạng thái:** GIAI ĐOẠN 2 — chờ duyệt danh mục trước khi sửa. Chưa sửa dòng nào.

---

## 1. Tóm tắt điều hành

Kiến trúc Recipe đúng và gọn: `recipeOps` là nguồn chân lý phân loại, `PlaybackRunner` thuần DI test được, `recipeRunners` tái dùng đúng đường xử lý cũ (giữ được invariant an toàn màu — **không có đường ghi PDF mới nào được tạo ra**, Property 5 đạt về mặt kiến trúc). Tầng orchestrator (`PlaybackRunner.ts`) gần như sạch.

Hỏng nằm ở **lớp nối dây giữa orchestrator sạch và ứng dụng thật**, đúng chỗ không có test nào chạm tới.

Ba lỗi chặn đường (P0) khiến tính năng **không dùng được cho kịch bản nghiệm thu chính** đã ghi trong `tasks.md:85` ("ruột sách → convertcolors → hairlines → pdfx → optimize → **booklet**"):

1. **§A.1** — Phát lại bất kỳ recipe nào có bước bình bài, trên bản desktop, **phá working file**: wrapper `commitWorkingFile` trong `playRecipe` nuốt tham số thứ 3 (`existingPath`), mà đúng nhánh đó blob chỉ là vật mang rỗng (0 byte cho booklet, 11 byte `"native-path"` cho N-Up/tem/CNC). Kết quả bình thật nằm mồ côi trên đĩa, tab hiển thị file rỗng.
2. **§A.2** — Với N-Up/tem/CNC, bước 2..N **bình lại file gốc**, vứt bỏ mọi bước trước đó: `getWorkingSourcePath` bị đóng băng trong `base` và được `processHandlers` ưu tiên hơn `getWorkingBytes` đã ghi đè. Không lỗi, không cảnh báo — chỉ ra sai kết quả.
3. **§D.1** — **Xoá recipe không hoạt động**: `capabilities/default.json` thiếu `fs:allow-remove`, nên `tauriFs.remove` bị ACL từ chối, catch nuốt lỗi, toast báo "Đã xóa" rồi recipe hiện lại ngay lần refresh kế.

Cả 3 đều nằm ngoài vùng phủ test: `tasks.md:84` (task 12.1 — round-trip thực tế cần backend chạy) là mục **duy nhất chưa đánh dấu hoàn thành**, và đó chính là mục sẽ bắt được cả ba.

Ngoài ra, tầng **ghi** có 2 lỗi P0 riêng làm recipe ghi ra **sai nội dung** (§B.1, §B.2): một `pendingNote` toàn cục không được dọn khi người dùng bấm Huỷ job, nên nó bị ghép vào commit của thao tác **kế tiếp không liên quan** — Step mang nhãn "Bình N-Up" nhưng thực tế là kết quả của thao tác Cắt khổ.

**Tổng: 42 phát hiện** — 6× P0, 13× P1, 17× P2, 6× P3.

Có 1 phát hiện **ngoài phạm vi nhưng nghiêm trọng hơn**, xem §G: cùng gốc thiếu quyền fs làm hỏng cả xoá preset, khôi phục sau crash, và **vô hiệu hoá kiểm tra trùng tên khi tự động lưu file in** → ghi đè file `.pdf` của khách hàng không hỏi.

---

## 2. Bảng phát hiện

### §A — Phát lại làm hỏng/sai file (chuỗi working file)

| Mã | Mức | Phát hiện | Bằng chứng |
|---|---|---|---|
| **A.1** | 🔴 P0 | Wrapper commit trong `playRecipe` chỉ nhận `(blob, name)` — **mất `existingPath`**. Nhánh bình bài truyền blob rỗng làm vật mang: booklet `new Blob([])` = 0 byte, N-Up/tem/CNC `new Blob(['native-path'])` = 11 byte. Hệ quả kép: `currentBytes` của bước sau là rác, và `commitWorkingFile` thật rơi vào nhánh `uploadFileForNup` upload chính file rỗng đó làm working file. | wrapper `ImpositionTab.tsx:1398`; chữ ký `processHandlers.ts:32`; call site `:206`, `:292`; vật mang `:188` và `pdfImposer.ts:786-788` (`preferNativePath` = luôn true trong app desktop, `:757`) |
| **A.2** | 🔴 P0 | `getWorkingSourcePath` không được ghi đè trong `buildContext` → trả `path` của **file lúc bắt đầu phát lại**. `processHandlers` ưu tiên path này và **không bao giờ đọc** `getWorkingBytes` đã nối chuỗi. Recipe `[Chuyển màu → N-Up]` ra tờ in vẫn RGB. Ở `runStickerImposition` còn tệ hơn: dò hình trên file mới, bình trên file cũ → hình và nội dung lệch nhau. | `ImpositionTab.tsx:1371` (base dựng 1 lần), `:1394-1403` (chỉ override 3 field), `:1236-1248`; ưu tiên path `processHandlers.ts:80-85`. Booklet KHÔNG dính (đọc `ctx.file.path`, `:259-266`) |
| **A.3** | 🔴 P0 | `booklet`/`nup` ghi **nguyên khối** `settings`, trong đó có `pageOrder`/`pageRotations` của file đang mở. Bộ lọc per-file chỉ áp cho sticker/cnc. Phát lại file 40 trang bằng recipe ghi trên file 16 trang → chỉ 16 trang được bình, tay sách sai; file 8 trang → trang `undefined`. | ghi `ImpositionTab.tsx:1463-1464`, `:1558-1559`; lọc thiếu `:1296-1305`; tiêu thụ `pdfImposer.ts:593-598`, `:624` |
| **A.4** | 🟠 P1 | `runTrimShift` và `runSplit` **không `await`** `commitWorkingFile`, trái hợp đồng ghi ngay trong file (`processHandlers.ts:30-32`). Bước kế đọc bytes trước khi trim → bước trim thành no-op trong chuỗi. | `processHandlers.ts:620`, `:658` vs các anh em có await `:442`, `:477`, `:501`, `:696` |
| **A.5** | 🟠 P1 | `split` file >1000 trang hoặc >300MB nhận **ZIP** từ backend rồi commit làm working PDF tên `Split_x.pdf`; nhánh file nhỏ chỉ giữ `results[0]`, các file còn lại mất im lặng (báo qua `setReportMsg` nhưng UI phát lại không hiện). | `processHandlers.ts:641-648`, `:656-660`; backend trả zip `pdf_tools.py:389-397` |

### §B — Ghi sai / thiếu bước

| Mã | Mức | Phát hiện | Bằng chứng |
|---|---|---|---|
| **B.1** | 🔴 P0 | **Huỷ job làm rò `pendingNote`.** Nhánh `ABORT_BY_USER`/`isCanceled` `return` mà **không gọi `setError`** → móc dọn duy nhất không chạy. Note treo lại bị commit của thao tác sau nuốt. Kịch bản: Ghi → N-Up → **Huỷ** → Cắt khổ ⇒ recipe có Step "Bình N-Up" với settings của job đã huỷ, còn bước Cắt khổ biến mất. | rò `processHandlers.ts:300-305` + 5 nhánh `if (!isCanceled(err))` (`:480`, `:585`, `:622`, `:663`, `:714`); móc dọn `ImpositionTab.tsx:1258`; ghép `RecipeRecorder.ts:102-122` |
| **B.2** | 🔴 P0 | `runShuffle` nhánh `split_odd_even` bỏ qua `spawnNewTab=false`: spawn 2 tab rồi `return`, không commit, không error → note `shuffle` rò y hệt B.1. | `ImpositionTab.tsx:1324-1325` ép cờ; `processHandlers.ts:444-461` bỏ qua cờ. Cùng lớp: `processHandlers.ts:295-297` |
| **B.3** | 🟠 P1 | **10 đường commit không có hook ghi** → thao tác biến mất khỏi recipe hoàn toàn im lặng (bản release không có cả `console.warn`): Cắt khổ, Xoá đối tượng, Header/Footer, Bình catalog, Preflight fix, OCR, Watermark, Mã hoá, Metadata, Office→PDF. Vi phạm **Yêu cầu 1.4**. | commit không note: `ImpositionTab.tsx:768`, `:940`, `:2659`; `processHandlers.ts:397`; `PreflightTool.tsx:129`; `OcrTool.tsx:85`; `WatermarkTool.tsx:330`; `EncryptTool.tsx:83,128`; `MetadataTool.tsx:116`; `OfficeConvertTool.tsx:159,302`. Cảnh báo chỉ DEV: `RecipeRecorder.ts:107-110` |
| **B.4** | 🟠 P1 | **Undo không rút Step đã ghi.** `handleUndo` set `file` trực tiếp, không qua `commitWorkingFile`. Ghi → Optimize → Ctrl+Z ⇒ recipe vẫn còn bước Optimize người dùng đã bỏ. | `ImpositionTab.tsx:1068-1098` |
| **B.5** | 🟡 P2 | `noteOperation` ghi đè note cũ **không cảnh báo**; store là singleton toàn app **không mang tabId** → thao tác song song ở 2 tab (hoặc job nền + tool) tráo note cho nhau. | `RecipeRecorder.ts:63`, `:78-88`; mọi tab cùng mount `App.tsx:1240` |
| **B.6** | 🟡 P2 | `InkManagerTool` — nơi **duy nhất** ghi `spot_cmyk` — **không được import/render ở đâu**. Op `spot_cmyk` không thể ghi được qua UI, dù có metadata + runner đầy đủ. | `grep -rn "InkManager"` chỉ ra chính file định nghĩa |
| **B.7** | 🟡 P2 | **Yêu cầu 1.6 KHÔNG ĐẠT.** `viewerPageOrder`/`viewerPageRotations` trong `RecipeStep` là **trường chết**: `noteCommit()` gọi không tham số, không lời gọi `noteOperation` nào truyền `extras`, `PlaybackRunner` không đọc. `tasks.md:34` đánh `[x]` là sai sự thật. Dữ liệu thứ tự trang không mất mà đi **cửa sau** qua `settings.pageOrder` (§A.3) — đúng thứ spec cấm. | `ImpositionTab.tsx:740`; 16 lời gọi note đều ≤2 tham số; điền duy nhất ở test `RecipeRecorder.test.ts:82` |

### §C — Sai lệch tham số khi phát lại

| Mã | Mức | Phát hiện | Bằng chứng |
|---|---|---|---|
| **C.1** | 🔴 P0 | `runStickerDieline` **không gửi `rectangle_mode`** mà tool thật luôn gửi cho "Xén vuông". Backend mặc định `false` → bật lại khôi phục page-box (bù xén **không nở khổ**), tắt đường bù xén vector, và chạy **dò contour trên thiết kế chữ nhật**. Xén vuông 90×50 bù 3mm phát lại ra 90×50 thay vì 96×56. | tool `StickerTool.tsx:317-319`; runner thiếu `recipeRunners.ts:196-218`; backend `pdf_tools.py:1251-1252`, `:1377`; `sticker_engine.py:1564-1565`, `:1682-1685` |
| **C.2** | 🟠 P1 | `runStickerImposition` **không kiểm `res.ok`/`data.success`** — backend trả **HTTP 200** kèm `success:false` khi dò hình lỗi → bình bằng bounding-box thay vì silhouette thật ⇒ ít tem/tờ, không một lời cảnh báo. Đường tương tác thì có kiểm. | `recipeRunners.ts:156-165`; backend `imposition.py:1039-1040`; đối chiếu `ImposerDashboard.tsx:542` |
| **C.3** | 🟠 P1 | `merge` mode `interleave` **không thể phát lại**: recorder tước `oddFile`+`evenFile`, runner chỉ khôi phục `filesToMerge`. Người dùng được hỏi file, chọn xong vẫn chết ở bước đó và **dừng cả recipe**. | `ImpositionTab.tsx:1359`; `recipeRunners.ts:57-61`; `PdfMerger.ts:41-44` |
| **C.4** | 🟠 P1 | `merge` mode `insert_pages`: `insertFile` **không nằm trong danh sách tước** → `JSON.stringify(File)` = `{}` (truthy) → qua được guard rồi vỡ `undefined.toLowerCase()`. Thêm nữa `afterPageNum`/`skipPages` là **chỉ số trang tuyệt đối** ⇒ file-dependent trá hình. | `ImpositionTab.tsx:1359`; clone `recipeOps.ts:144`; `PdfMerger.ts:72-80`, `:124`, `:135` |
| **C.5** | 🟡 P2 | `autoSavePrint` + `savePrintConfig.folder` **lưu vào recipe** cho mọi op bình bài. Phát lại đơn hàng mới ⇒ ghi file in vào **thư mục đơn hàng cũ**, đặt tên bằng `orderCode` cũ, và ép tải toàn bộ blob dù đã có path native. Xuất recipe cho đồng nghiệp = lộ đường dẫn khách hàng. | ghi `ImpositionTab.tsx:1295` (không tước), `:1594-1595`; tiêu thụ `processHandlers.ts:181-182`, `:218` |
| **C.6** | 🟡 P2 | `hiddenOcgLayerIds` (id lớp OCG **theo từng tài liệu**) lọt vào params → trên file mới hoặc không khớp gì (lớp ẩn hiện lại trên bản kẽm) hoặc khớp nhầm lớp khác. | `ImpositionTab.tsx:1586`; `processHandlers.ts:147` |
| **C.7** | 🟡 P2 | `spot_cmyk` phát lại: đường object-level trả "không có spot nào" (no-op âm thầm), còn nếu rơi xuống fallback Ghostscript thì `spot_name` **không được dùng** — cả file bị ép CMYK, **nuốt luôn kênh CutContour**. | `ink_manager.py:172-178`, `:186-198` |
| **C.8** | 🟡 P2 | `params.file_id` **đè được** `file_id` thật (spread đứng sau). Không dẫn tới traversal (backend tra DB, pydantic bỏ khoá lạ) nhưng làm bước prepress chạy nhầm upload khác hoặc kẹt 404. Sửa 1 dòng. | `recipeRunners.ts:87`; `preflight.py:192-203` |
| **C.9** | 🟡 P2 | Không kiểm `res.ok`/`dl.ok` trước khi commit file tải về; `authenticatedFetch` không throw khi non-2xx ⇒ **body lỗi 404 trở thành working PDF**. Có đường tới thật: sửa `conversions: []` trong panel làm backend trả `output_filename` là file **input** ở thư mục khác → 404. | `recipeRunners.ts:89-98`; `api.ts:136-141`; `preflight.py:1399-1402`, `:336` |
| **C.10** | 🟢 P3 | Sticker/CNC tước cả `targetQuantitiesByPage` ⇒ đơn nhiều mẫu ("3000 mẫu A, 1000 mẫu B") phát lại chia đều ô. Có chủ đích nhưng người dùng không được báo. | `ImpositionTab.tsx:1301`; `processHandlers.ts:120` |

### §D — Lưu trữ, import/export

| Mã | Mức | Phát hiện | Bằng chứng |
|---|---|---|---|
| **D.1** | 🔴 P0 | **Xoá recipe không hoạt động.** `capabilities/default.json` chỉ cấp 5 quyền fs (`stat`, `read-file`, `read-dir`, `write-file`, `mkdir`) — **không có `fs:allow-remove`** → `tauriFs.remove` bị ACL từ chối → catch nuốt → ghi `"[]"` vào localStorage (đang rỗng) → toast "Đã xóa" → `refresh()` đọc lại đĩa ⇒ **recipe hiện lại ngay**. Không phải hồi quy: `git log -S"fs:allow-remove"` rỗng. | quyền: `capabilities/default.json:20,60,100,139,180` (xác nhận bằng `gen/schemas/capabilities.json`); `recipeStore.ts:133-139`; `RecipePanel.tsx:178-180` |
| **D.2** | 🟠 P1 | **Fallback lai ghi-một-nơi-đọc-một-nơi.** `saveRecipe` khi cả 2 đường ghi đĩa fail thì âm thầm ghi localStorage; `loadRecipes` khi đọc được đĩa thì `return` luôn, **không merge** ⇒ toast "Đã lưu" nhưng recipe biến mất. `tauriFs.writeTextFile` (fallback dòng 120) là **code chết** — cũng thiếu quyền. | `recipeStore.ts:110-126` vs `:81-101`; `_tauriTried` một lần cho cả phiên `:20,27-28` |
| **D.3** | 🟡 P2 | Import **không validate `schemaVersion`/`opId`** dù `design.md:125` yêu cầu; còn **ép** `schemaVersion = 1` bất kể giá trị cũ ⇒ recipe v2 tương lai bị dán nhãn v1 và diễn giải sai. Không có code migrate nào. | `recipeStore.ts:170`; `recipeTypes.ts:115`, `:131` (test tự xác nhận `opId:'x'` là hợp lệ, `recipeTypes.test.ts:41`) |
| **D.4** | 🟡 P2 | Recipe hỏng trong thư mục bị bỏ **im lặng** (trái comment ngay bên dưới); không cap số lượng/kích thước; `lsWrite` không try/catch ⇒ `QuotaExceededError` ở đường import bị nuốt thành **"File quy trình không hợp lệ"** — chẩn đoán sai hoàn toàn. Đo thật: 1 step N-Up = 75 khoá ≈ 4,1 KB; ~208 recipe 3-bước là vỡ quota localStorage. | `recipeStore.ts:89-94`, `:66-69`, `:178-182`; `RecipePanel.tsx:197` |
| **D.5** | 🟡 P2 | Sửa tham số trong panel = **1 lần ghi file nguyên tử mỗi phím**, không debounce; các `invoke` async có thể resolve lệch thứ tự ⇒ đĩa giữ giá trị trung gian. | `RecipePanel.tsx:139-143` → `recipeStore.ts:114-118` |

### §E — Giao diện & trải nghiệm

| Mã | Mức | Phát hiện | Bằng chứng |
|---|---|---|---|
| **E.1** | 🟠 P1 | **Không có cách huỷ phát lại.** `requestExternalInput` dựa vào `oncancel` của `<input type=file>` không timeout/fallback; nếu không bắn ⇒ Promise treo ⇒ `playingId` kẹt ⇒ **mọi nút Phát lại disable vĩnh viễn**, không thông báo. | `ImpositionTab.tsx:1380-1391`; `RecipePanel.tsx:267` |
| **E.2** | 🟠 P1 | Huỷ **job** giữa lúc phát lại: runner `return` im lặng, không `setError` ⇒ `PlaybackRunner` coi bước đó **THÀNH CÔNG** và chạy tiếp bước sau **trên file chưa xử lý**. | `processHandlers.ts:300-302`; `PlaybackRunner.ts:124-141` |
| **E.3** | 🟠 P1 | Tiến trình "Phát lại i/N" **không bao giờ hiện**: `processStatus` chỉ render trong `{isProcessing && …}`, mà lúc `onProgress` chạy thì cờ chưa bật, sau đó bị runner ghi đè rồi `finally` xoá. Người dùng chỉ thấy overlay nhấp nháy N lần. Mỗi bước còn reload cả tài liệu (`setPdfUrl`) + đẩy 1 entry undo (`MAX_HISTORY=12`). | `ImpositionTab.tsx:1406` vs `:2335`; `finally` ở `recipeRunners.ts:102,136,232`; commit `:675-732` |
| **E.4** | 🟠 P1 | Ô nhập số trong panel **không gõ được số âm và số thập phân** (`"-"`, `"0."` bị `<input type=number>` trả `''` → ép về 0 → React ghi lại "0"), xoá trắng thành 0 rồi **lưu xuống đĩa**. Trúng đúng các tham số in thật: `offsetMm`, `bleedMm`, `gapX/gapY`. | `RecipePanel.tsx:83-85`, nhãn `:41-47` |
| **E.5** | 🟡 P2 | Không chặn Phát lại **khi đang Ghi** ⇒ commit của phát lại nuốt `pendingNote` đang treo (Step gán sai vị trí + bước thật bị bỏ), và `setError` của bước lỗi gọi `discardPending` xoá note thao tác thật. `playingId` là state **cục bộ từng tab** ⇒ 2 tab phát lại song song được. | `ImpositionTab.tsx:1369-1415`, `:740`, `:1258`; `RecipePanel.tsx:124` |
| **E.6** | 🟡 P2 | Nút Ghi/Dừng chỉ render `file ? … : undefined` ⇒ đóng file trong lúc đang ghi thì **nút Dừng biến mất** nhưng `isRecording` vẫn true ⇒ kẹt phiên ghi. Recorder cũng không mang tabId ⇒ thao tác ở tab khác lọt vào cùng recipe. | `ImpositionTab.tsx:2424-2429`, `:1612-1614` |
| **E.7** | 🟡 P2 | Đóng dialog lưu (X / nền / Huỷ) = **mất trắng** toàn bộ bước đã ghi, không hỏi, không khôi phục được. | `RecipeRecordControl.tsx:89`, `:129`, `:136`, `:185-188` |
| **E.8** | 🟡 P2 | Ô JSON: **không xoá trắng được** (`jsonText:''` falsy → hiện lại giá trị cũ, `onBlur` bỏ qua parse); thu gọn bước khi JSON đang sai ⇒ mất chữ đã gõ, không cảnh báo. | `RecipePanel.tsx:99-110` |
| **E.9** | 🟢 P3 | 4 chuỗi tiếng Việt **hard-code** chưa i18n; `description` nhập và lưu nhưng **không hiển thị ở đâu** (dead data), không có UI sửa; dialog không đóng bằng Esc (chưa dùng `DialogKeys`). *(Đối chiếu i18n: **0 key thiếu** trong vi.json/en.json — 70 key đều có, kể cả interpolation.)* | `RecipePanel.tsx:176`, `:259`, `:260`; `RecipeRecordControl.tsx:165`; nhãn `'Thiết lập cũ (đã vô hiệu)'` `:43` |
| **E.10** | 🟢 P3 | `toggleStep` cho bật `recordable=true` trên op vốn file-dependent. Hiện **vô hại** (mọi op non-recordable đều không có runner) nhưng **không có bất biến nào canh giữ** — thêm 1 runner là Property 6 thủng ngay. | `RecipePanel.tsx:157-158`; `recipeOps.ts:58,62-76` vs `recipeRunners.ts:238-263` |

### §F — Chất lượng kiểm thử

| Mã | Mức | Phát hiện | Bằng chứng |
|---|---|---|---|
| **F.1** | 🟠 P1 | **Property 3 (tuyến tính) xanh giả** — chỉ khẳng định `onSpawnTab === undefined` và mock nhận `false`; **không bài nào kiểm output bước i = input bước i+1**. `playRecipe` (nơi A.1 + A.2 sống) **0 dòng test**. | `PlaybackRunner.test.ts:46-54`; `recipeRunners.test.ts:58-61` |
| **F.2** | 🟡 P2 | Mock `../processHandlers` **thiếu `runTrimShift`** ⇒ `RECIPE_RUNNERS.trim_shift` chưa từng được gọi trong test (gọi là Vitest ném lỗi mock). | `recipeRunners.test.ts:12-18` vs `recipeRunners.ts:30` |
| **F.3** | 🟡 P2 | `recipeStore.test.ts` tên bài là "sắp xếp mới nhất trước" nhưng `.sort()` **cả hai vế** ⇒ không kiểm thứ tự; **nhánh Tauri hoàn toàn không có test** — đúng nơi D.1/D.2 sống (và nơi bug "panel trắng 2026-07-08" từng sống). | `recipeStore.test.ts:44-52`; gate `recipeStore.ts:22-24` |
| **F.4** | 🟡 P2 | Property 5 (an toàn ghi) **không có test nào**; P6 thiếu bất biến registry (§E.10); P7 không test việc recorder tước blob file ngoài. `makeCtx` luôn trả bytes cố định bất kể `ctx.file` ⇒ runner "gian lận" đọc thẳng `ctx.file` vẫn pass. | `PlaybackRunner.test.ts`, `recipeRunners.test.ts` |
| **F.5** | 🟢 P3 | Không có test component nào cho `RecipePanel`/`RecipeRecordControl`, dù dự án đã có hạ tầng testing-library. | `find src/components -name '*.test.*'` |

---

## 3. Phát hiện thêm — NGOÀI phạm vi audit này (§G)

Cùng gốc với D.1 (thiếu quyền plugin-fs), nhưng chạm module khác nên **không sửa trong đợt này** — đề nghị mở việc riêng:

| Mã | Mức | Phát hiện | Bằng chứng |
|---|---|---|---|
| **G.1** | 🔴 P0 | `savePrintFiles.fileExists` dùng `fs.exists` (thiếu `fs:allow-exists`) ⇒ **luôn trả `false`** ⇒ vòng chống trùng tên vô hiệu ⇒ **`atomicWrite` ghi đè im lặng file `.pdf` đã có** của người dùng khi tự động lưu file in. Đúng thứ mà comment ngay trên đó tuyên bố đã chặn. | `savePrintFiles.ts:74`, `:79`, `:87-92` |
| **G.2** | 🟠 P1 | `recovery.listSnapshots` dùng `readTextFile` (thiếu quyền) ⇒ catch per-file ⇒ **luôn trả rỗng** ⇒ toàn bộ khôi phục sau crash chết lặng. `recovery.remove` (dọn snapshot) cũng bị từ chối. | `recovery.ts:108`, `:111`, `:95`, `:125` |
| **G.3** | 🟠 P1 | `presetManager.deletePreset` hỏng y hệt D.1 — và tệ hơn: fallback `lsWrite(loadPresets())` ghi **toàn bộ danh sách từ đĩa** vào localStorage. | `presetManager.ts:177` |

---

## 4. Quick-win (sửa nhỏ, chặn thiệt hại lớn)

| # | Sửa | Đóng được | Kích thước |
|---|---|---|---|
| 1 | Wrapper commit nhận đủ 3 tham số + khi có `existingPath` thì đọc bytes **từ path** thay vì từ blob rỗng | **A.1** | ~8 dòng |
| 2 | Ghi đè `getWorkingSourcePath: async () => undefined` trong `buildContext` của playback | **A.2** | 1 dòng |
| 3 | Tước `pageOrder`/`pageRotations`/`autoSavePrint`/`savePrintConfig`/`hiddenOcgLayerIds` khỏi `recordParams` cho **mọi** op bình bài | **A.3, C.5, C.6** | ~5 dòng |
| 4 | Thêm `fs:allow-remove` (+ `exists`, `read-text-file`, `write-text-file`) vào `capabilities/default.json` với cùng allow/deny list như `fs:allow-write-file` | **D.1** (+ G.1, G.2, G.3) | 1 file |
| 5 | `fd.append('rectangle_mode','true')` khi `productType==='rectangle'` trong `runStickerDieline` | **C.1** | 1 dòng |
| 6 | `{ ...params, file_id: up.id }` (đảo thứ tự spread) | **C.8** | 1 dòng |
| 7 | Gọi `discardPending()` ở các nhánh huỷ/`isCanceled` của `processHandlers` | **B.1, B.2** (một phần) | ~6 dòng |
| 8 | `if (!res.ok \|\| !dl.ok) → setError` trước khi commit | **C.9** | ~4 dòng |

---

## 5. Đề xuất thứ tự sửa theo lô (≤5 file/lô, verify hết lô mới sang lô kế)

| Lô | Nội dung | File chạm | Verify |
|---|---|---|---|
| **L1 — Chặn phá file khi phát lại** | A.1, A.2, A.3, C.5, C.6 | `ImpositionTab.tsx` | `npm run typecheck` + `npm run build` + `npx vitest run src/lib/recipe` + **test mới** cho `buildContext` (bắt A.1+A.2) |
| **L2 — Quyền fs** | D.1 (+ G.1–G.3 nếu duyệt mở rộng), D.2 | `capabilities/default.json`, `recipeStore.ts` | build tauri dev + thử xoá recipe thật; test nhánh Tauri có mock |
| **L3 — Đúng tham số phát lại** | C.1, C.2, C.8, C.9, C.3/C.4 (hoặc hạ `merge` xuống non-recordable ở v1) | `recipeRunners.ts`, `recipeOps.ts` | vitest recipe + thử tay 1 file tem |
| **L4 — Sạch tầng ghi** | B.1, B.2, A.4, A.5, E.2 | `processHandlers.ts`, `ImpositionTab.tsx` | vitest toàn bộ FE (baseline 333) |
| **L5 — Ghi đủ bước / cảnh báo** | B.3 (gắn `noteNonRecordable` ở 10 điểm commit + toast), B.4, B.7 | `ImpositionTab.tsx`, các tool | vitest + thử tay chuỗi Crop→Chuyển màu→Booklet |
| **L6 — UI/UX & lưu trữ** | E.1, E.3, E.4, E.5, E.6, E.7, E.8, D.3, D.4, D.5 | `RecipePanel.tsx`, `RecipeRecordControl.tsx`, `recipeStore.ts` | typecheck + build + thử tay |
| **L7 — Test & tài liệu** | F.1–F.5, cập nhật `tasks.md` (bỏ `[x]` sai ở 4.2/5.3/5.4), i18n E.9 | `*.test.ts`, `tasks.md`, `vi/en.json` | vitest đầy đủ |

**Quyết định sản phẩm cần user chốt trước khi làm L3:**
- `merge` (interleave/insert_pages) — sửa cho phát lại được, hay **hạ xuống `recordable:false`** ở v1 cho đúng bản chất file-dependent? (Khuyến nghị: hạ xuống, vì `afterPageNum` là chỉ số trang tuyệt đối.)
- `spot_cmyk` (§C.7, §B.6) — nối `InkManagerTool` vào UI, hay bỏ op này khỏi v1?

---

## 6. Đối chiếu spec — trạng thái yêu cầu

| Yêu cầu | Trạng thái | Ghi chú |
|---|---|---|
| 1.1 badge trạng thái ghi | ✅ ĐẠT | trừ E.6 (mất nút khi đóng file) |
| 1.2 mỗi thao tác → 1 Step đúng thứ tự | ⚠️ MỘT PHẦN | B.1, B.2, B.3 |
| 1.3 params chụp lúc chạy | ✅ ĐẠT | |
| 1.4 cảnh báo bước không ghi được | ❌ KHÔNG ĐẠT | B.3 |
| 1.5 đặt tên + lưu / huỷ | ✅ ĐẠT | trừ E.7 |
| 1.6 chụp kèm page order/rotations | ❌ KHÔNG ĐẠT | B.7 — trường chết |
| 2.1–2.5 lưu trữ & CRUD | ⚠️ MỘT PHẦN | D.1 (xoá hỏng), D.2 |
| 3.1–3.6 phát lại tuần tự | ⚠️ MỘT PHẦN | orchestrator đạt; nối dây hỏng (A.1, A.2), tiến trình vô hình (E.3) |
| 4.1 phân loại | ✅ ĐẠT | |
| 4.2 bỏ qua + cảnh báo file-dependent | ⚠️ MỘT PHẦN | `onWarn` không được nối, chỉ hiện số đếm |
| 4.3 hiển thị trực quan | ✅ ĐẠT | |
| 5.1–5.3 input ngoài | ⚠️ MỘT PHẦN | không lưu blob ✅ (C.4 là ngoại lệ: `insertFile` lọt), nhưng E.1 treo |
| 6.1–6.3 UI | ✅ ĐẠT | |
| 7.1 tái dùng đường xử lý, không tạo đường ghi mới | ✅ ĐẠT | invariant an toàn màu giữ nguyên |
| 7.2 không sửa file nguồn trên đĩa | ⚠️ MỘT PHẦN | C.5 ghi ra thư mục lưu file in cũ |
| 7.3 lưu kết quả solver | — hoãn có chủ đích | `tasks.md:78-81` |

---

*Báo cáo lập bằng 4 mũi khảo sát song song + xác minh chéo tay mọi phát hiện P0 (đọc lại code hai phía, kiểm `gen/schemas/capabilities.json` đã sinh). Chưa sửa file nào.*
