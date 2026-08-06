# Báo cáo audit — Tính năng IN và BẾ (2026-08-06)

Phạm vi: đường IN native (Ctrl+P / nút In) và đường BẾ (xuất file khuôn, lưu file in
tách In/Bế, mở khuôn bằng Illustrator/CorelDRAW, gửi máy bế).
Phương pháp: `prynx-deep-audit` (thang bằng chứng UNKNOWN→TRACED→AUTO→ARTIFACT→RUNTIME,
vòng đời phát hiện `[SUSPECTED]/[CONFIRMED]/[DISPROVED]/[EXPECTED]`).
Bối cảnh: audit In native 2026-08-05 (§PRINT.01–08) đã sửa xong nhưng **loại trừ**
"xuất dữ liệu máy bế, mở CorelDRAW/Illustrator" — đúng vùng vừa phát sinh lỗi thật.

## 0. Bug gốc đã sửa trong phiên này (chưa commit)

Người dùng báo: mở "Chỉ trang khuôn" bằng Illustrator sau khi bình xong →
`Failed to parse PDF document (line:0 col:22 offset=11): No PDF header found`.

Nguyên nhân gốc (**RUNTIME**, đã tái hiện đúng offset=11): theo "đường native",
backend ghi PDF ra đĩa và frontend chỉ giữ **File sentinel 11 byte** `new Blob(['native-path'])`
(`desktop/src/lib/processHandlers.ts:255`) kèm `.path`. `OpenInDesignModal` đọc
`resultBlob.arrayBuffer()` → đưa 11 byte rác cho pdf-lib. 11 ký tự khớp đúng `offset=11`.

Đã sửa: `desktop/src/components/imposition-tools/OpenInDesignModal.tsx` — thêm
`readResultBytes()` đọc ĐĨA trước (`fetchLocalFileBuffer(path)`), chỉ fallback blob khi
không có path; đồng thời gỡ `catch {}` câm ở effect liệt kê trang (trước đây nuốt lỗi làm
lưới tờ trống trơn không báo gì). Verify: `npm run typecheck` sạch,
`vitest OpenInDesignModal.test.tsx` 3/3 PASS. **CHƯA commit.**

Bẫy cần nhớ: `commitWorkingFile` (`ImpositionTab.tsx:804-848`) vá lại `.size` bằng
`stat(path)`, nên **`file.size > 0` KHÔNG phát hiện được file sentinel** — idiom phòng thủ
cũ `if (pdfFile.size > 0)` (`ImposerDashboard.tsx:804`) là guard không hợp lệ cho ca này.

---

## 1. Đơn vị audit A — Đường IN native

Trace dọc:
`ImpositionTab.tsx:2290-2301` (`source = bakedBlob || curFile`, `openPrintDialog`)
→ `shared/usePrintDialog.tsx:57` (`resolvePrintableFilePath` TRƯỚC khi liệt kê máy in)
→ `lib/nativePrint.ts:92-110`
→ `print_pdf_direct` (Rust, worker process riêng, GDI `StartDocW/StartPage/EndPage/EndDoc`).

Trạng thái bằng chứng: **AUTO** (typecheck + test FE/Rust của đợt 2026-08-05).
Kết luận: **[EXPECTED] — KHÔNG dính bug sentinel.**
Lý do: `resolvePrintableFilePath` là **path-first** — nếu source có `.path` thì dùng thẳng
đường đĩa (`deleteAfter=false`), chỉ ghi temp khi thật sự là blob in-memory
(`nativePrint.ts:95-99`). Bytes sentinel không bao giờ tới PDFium.

Ghi chú phủ còn thiếu (không phải bug): chưa có bằng chứng **ARTIFACT/RUNTIME** với máy in
vật lý — máy audit 2026-08-05 không có máy in. Giữ nguyên khoảng trống này trong ma trận.

---

## 2. Đơn vị audit B — Lưu file in (tách In / Bế) — **[CONFIRMED] P0**

Trace dọc:
`ImpositionTab.tsx:3123-3131` truyền `resultBlob={file}` (File sentinel/rỗng, **không có
prop path nào tồn tại**)
→ `workspace/SavePrintFilesModal.tsx:51` `PDFDocument.load(await resultBlob.arrayBuffer())`
→ `SavePrintFilesModal.tsx:60` `catch { setDerivedTypes([{ label: …, sheetCount: 0 }]) }`
→ `SavePrintFilesModal.tsx:102-120` `doSave()` → `lib/savePrintFiles.ts:38`
`const srcBytes = new Uint8Array(await resultBlob.arrayBuffer())` — **không có fallback đĩa**.

Hậu quả: trên đường native (mọi lần bình xong mà không bật auto-save), thao tác **"Lưu file
in"** thủ công đọc đúng 11 byte sentinel → `PDFDocument.load` ném; UI **im lặng thoái hoá về
"1 loại, 0 tờ"** ở bước suy loại, và bước lưu chỉ hiện chuỗi lỗi. Người dùng mất hoàn toàn
đường xuất file In/Bế tách riêng — cùng root cause với bug đã sửa ở §0.

Đường auto-save KHÔNG dính: `processHandlers.ts:240-250` ép `downloadNupJob(jobId)` khi
`autoSavePrint` bật, nên `savePrintFilesToFolder` ở dòng 285 nhận bytes thật.

Mức: **P0** (chức năng xuất bản in/bế hỏng hoàn toàn trên đường mặc định).

### ĐÃ SỬA (2026-08-06, lô 1 — 3 file, chưa commit)

- `desktop/src/lib/savePrintFiles.ts` — thay `resultBlob.arrayBuffer()` bằng
  `getFileArrayBuffer(resultBlob)` (SSOT sẵn có ở `lib/utils.ts:13`: đọc đĩa qua `.path`
  trước, chỉ fallback blob khi không có path). KHÔNG cần thêm prop path mới.
- `desktop/src/components/workspace/SavePrintFilesModal.tsx` — effect suy loại dùng cùng
  helper; `catch {}` câm ở dòng 60 giờ hiện lỗi thật ra UI.
- `desktop/src/lib/savePrintFiles.nativePath.test.ts` (mới) — 2 test hồi quy: File sentinel
  11 byte + `.path` → đọc từ đĩa, ghi ra 4 PDF hợp lệ; blob không path → vẫn dùng bytes blob.

`ImpositionTab.tsx` KHÔNG cần sửa: `resultBlob={file}` đã là File mang `.path`.

Verify: `npm run typecheck` sạch · `npm run build` (tsc + vite) sạch ·
vitest 36/36 PASS (savePrintFiles.nativePath, printFileNaming, processHandlers, OpenInDesignModal) ·
`npx eslint` trên 4 file chạm: hết lỗi mới (còn nợ cũ `@ts-nocheck` + `any` của
SavePrintFilesModal, ngoài phạm vi lô này).

---

## 3. Đơn vị audit C — Gửi máy bế (CutExportModal) — **NGOÀI PHẠM VI**

Người dùng xác nhận (2026-08-06): "Gửi máy bế" là tính năng **tạm khoá có chủ đích**, không
can thiệp. Grep `setShowCutExport(true)` không có kết quả — khớp với comment trong code
(`ImpositionTab.tsx:2561-2573`: "ĐÃ ẨN khỏi UI, kênh TCP/serial chưa kiểm chứng").

Ghi nhận để tham chiếu, KHÔNG sửa: modal là path-only (`useFileSource = !!sourcePdfPath`) nên
vốn miễn nhiễm bug sentinel. Backend liên quan: `cut_export/api.py:276-296`,
`cut_export/pdf_source.py:133-199`.

---

## 4. Lỗi bị nuốt (nhóm SWALLOWED_ERROR) — [CONFIRMED] P2

| Vị trí | Hành vi |
|---|---|
| `SavePrintFilesModal.tsx:60` | nuốt lỗi parse → hiện "1 loại / 0 tờ" như thể bình thường |
| `backend/.../pdf_source.py` `list_cut_pages` | `except: continue` cho từng trang → trang lỗi biến mất khỏi danh sách (chỉ ảnh hưởng đường Gửi máy bế đang khoá → **hoãn**) |

Trùng nhóm 516 ứng viên `SWALLOWED_ERROR` của scanner baseline 2026-08-04. Chỗ ở
`SavePrintFilesModal.tsx:60` che trực tiếp P0 ở §2 nên sửa cùng lô 1.

---

## 5. Quét mẫu anh em của bug sentinel (bước 8)

Nguồn chân lý duy nhất để đọc bytes là `getFileArrayBuffer()` (`lib/utils.ts`) — đã đọc đĩa
qua `.path` rồi mới fallback blob (dùng đúng ở `ImpositionTab.tsx:1388` và `:1933`).
Mọi chỗ gọi thẳng `.arrayBuffer()` trên File có thể mang `.path` đều trở lại `[SUSPECTED]`:

- `savePrintFiles.ts:38` — **[CONFIRMED]**, xem §2.
- `SavePrintFilesModal.tsx:51` — **[CONFIRMED]**, xem §2.
- `OpenInDesignModal.tsx` — đã sửa §0.

### Kết quả quét đầy đủ (lô 2, 2026-08-06) — trace từng chỗ, KHÔNG mass-fix

Đã trace ngược **mọi** call-site `.arrayBuffer()` trong `desktop/src` (~49 hit) về đúng nguồn
File/Blob. Trong **phạm vi IN/BẾ: không còn chỗ nào [CONFIRMED]** — lô 2 vì vậy **không sửa file
nào**, chỉ chốt phán quyết.

| Call-site | Nguồn | Phán quyết |
|---|---|---|
| `ImposerDashboard.tsx:806` | `pdfFile` của tab | **[DISPROVED]** — nhánh Tauri+`.path` (735) đi backend Python `/pdf-meta` rồi fallback Rust `get_pdf_metadata`, và **`return` ở 800** trước khi tới pdf-lib. Nhưng guard `pdfFile.size > 0` (804) là **idiom sai** (xem §0: `.size` bị vá bằng `stat`) → ghi nợ, không phải bug sống |
| `ImposerDashboard.tsx:948-975` | `getWorkingFile()` | **[DISPROVED]** — path-first (`if (isTauri && wf?.path) srcPath = …`) |
| `ImpositionTab.tsx:844 / :1563 / :2121` | blob in-memory / callback `commitWorkingFile` / có nhánh `copy_file_atomic` khi có path | **[DISPROVED]** |
| `processHandlers.ts:416-433` | `r.blob` từ kết quả backend | **[DISPROVED]** — in-memory, có guard `size > 0` hợp lệ vì là Blob thật |
| `combineDelegation.ts:173-189` | có `localPath` | **[DISPROVED]** — đã là mẫu chuẩn: `fetchLocalFileBuffer` trước, `.slice().arrayBuffer()` chỉ khi không path |
| `WatermarkTool.tsx:500-522` | `<input type="file">` | **[DISPROVED]** — File thật từ dialog trình duyệt |
| `imageBatch/helpers.ts:124` | `item.resultBlob` in-memory | **[DISPROVED]** (dòng `:96` `new File([], …)` là *nơi sinh* File path-backed, không phải nơi đọc) |
| `saveBlob.ts:9-20`, `dieline/savePdfBlob.ts:4`, `dieline/productionPDF.ts:175`, `api.ts:1305`, `useSceneExport.ts:124`, `usePdfLoader.ts:470` | blob sinh tại chỗ hoặc `Response` của `fetch` | **[DISPROVED]** |

**Phát hiện thêm (NGOÀI phạm vi IN/BẾ — không sửa trong audit này):**

- `preprocess-tools/CoverNumberingTool.tsx:91` — `pdfFile.arrayBuffer()` để đếm số trang;
  `pdfFile` là file làm việc của tab nên **có thể là File path-backed rỗng** → hiện "0 trang",
  lại còn `catch { setTotalPages(0) }` nuốt lỗi. **[CONFIRMED] P2** (tính năng Đánh số bìa).
  → **ĐÃ SỬA lô 3**.
- `preprocess-tools/CoverNumberingTool.tsx:193` — `template.arrayBuffer()` khi `singleFileMode`
  để trích trang bìa → cùng root cause, hỏng thao tác trích bìa. **[CONFIRMED] P1** (Đánh số bìa).
  → **ĐÃ SỬA lô 3**.
- `lib/preprocessEngine/PdfMerger.ts:38` — `settings.filesToMerge[i].arrayBuffer()`.
  **[DISPROVED]** (sửa phán quyết 2026-08-06, sau khi người dùng chất vấn): mắt xích
  `createPathBackedFile → systemMergeFiles` mà tôi giả định **KHÔNG tồn tại**. Grep toàn
  `desktop/src`: `systemMergeFiles` chỉ có 3 chỗ ĐỌC (`App.tsx:1430` lấy từ
  `tab.payload?.systemMergeFiles`, `ImpositionTab.tsx:2933` chuyền tiếp,
  `ImposerDashboard.tsx:1130` tiêu thụ) — **không chỗ nào GHI** key này vào payload;
  `useIncomingFileDispatcher` chỉ phát `combine_pdf {files}` / `imposition {file}` /
  `office_convert`. Vậy `filesToMerge` hiện chỉ đến từ `<input type="file">` → File thật.
  Dòng `:57/:58/:94` (`oddFile`/`evenFile`/`insertFile`) cũng **[DISPROVED]** cùng lý do.
  Bài học: giữ nguyên `[SUSPECTED]` cho tới khi tìm được *người ghi*, không chỉ *người đọc*.

### Chứng minh khả năng chạm tới của `cover_numbering` (bước 3, bổ sung 2026-08-06)

Người dùng phản hồi "trích trang bìa tôi đã khoá rồi". Kiểm chứng: đây là **khoá theo gói
bản quyền**, KHÔNG phải gỡ khỏi UI như "Gửi máy bế".

- `toolRegistry.ts:383-400` — thẻ "Mẹc Bìa (Chạy số bìa)", `isEnabled: true`,
  `featureId: 'vdp.cover_numbering'`, `defaultPayload: { focusFeature: 'cover_numbering' }`.
  Không có cờ ẩn/disable nào.
- `license/features.ts:31` — `minPlan: 'pro'`; gói thấp hơn bị `FeatureAccessOverlay`
  (`App.tsx:1127`, `ImpositionTab.tsx:3211`) phủ lên, **gói Pro mở panel bình thường**.
- Mục "NGUỒN TRANG BÌA" (`CoverNumberingTool.tsx:304-321`) bật `singleFileMode` → `:193`
  `template.arrayBuffer()` chạy.

**Phân biệt hai tính năng dễ nhầm tên (người dùng chất vấn 2026-08-06):**

| | "Tách bìa riêng" (thứ người dùng đã khoá) | "Trích trang bìa" (thứ audit nói tới) |
|---|---|---|
| Vị trí | `sections/BookletSettingsSection.tsx:101-104` (`separateCover` + `coverPageCount`) | `preprocess-tools/CoverNumberingTool.tsx:193` (`template.arrayBuffer()`) |
| Thuộc | Bình Sách/Tạp chí | Tool riêng "Mẹc Bìa (Chạy số bìa)" — `toolRegistry.ts:383-400`, `featureId: 'vdp.cover_numbering'` |
| Cơ chế khoá | thuộc mảng offset đang **tạm ẩn bằng cờ** `HIDE_OFFSET_BOOKLET = true` (`lib/featureFocus.ts:12`); UI offset bị ẩn ở `AutoCatalogSection.tsx:44`, `PaperSettingsUI.tsx:170`, `BookletSettingsSection.tsx:147/:178`, và effect `AutoCatalogSection.tsx:33-36` **ép state persist `'offset'` về `'in_nhanh'`** | **không có cờ ẩn nào** — `isEnabled: true`, chỉ bị chặn theo gói (`features.ts:31`, `minPlan: 'pro'`) |

⇒ Đây là **hai đường code khác nhau**; cờ tạm khoá offset không phủ được `CoverNumberingTool`.
Hai phát hiện `CoverNumberingTool.tsx:91` / `:193` **giữ nguyên [CONFIRMED]**, thu hẹp phạm vi:
chỉ máy có license Pro, và **không** liên quan tới Bình Sách offset.

Ghi chú thêm: `separateCover` chỉ render khi `paperClassification === 'in_nhanh'`
(`BookletSettingsSection.tsx:86`), tức nó **vẫn hiện** ở đường in nhanh — cờ
`HIDE_OFFSET_BOOKLET` không ẩn ô này. Nếu ý người dùng là ô đó cũng phải ẩn, đó là việc riêng
ngoài phạm vi audit IN/BẾ.

Còn lại thuộc nhóm Tiền xử lý, không thuộc luồng IN/BẾ — theo `prynx-audit-workflow`
ghi vào "phát hiện thêm", chờ người dùng quyết định có mở lô sửa riêng hay không.

---

## 6. Đề xuất lô sửa (chờ duyệt)

**Lô 1 (P0, 3 file):**
1. `desktop/src/lib/savePrintFiles.ts` — nhận thêm `sourcePath?: string`, đọc bytes qua
   đường đĩa-trước (dùng chung helper với `OpenInDesignModal`, nên tách helper vào
   `lib/localFileTransport.ts` hoặc `lib/utils.ts` làm SSOT thay vì chép lần hai).
2. `desktop/src/components/workspace/SavePrintFilesModal.tsx` — thêm prop `resultFilePath`,
   dùng helper ở cả effect suy loại lẫn `doSave`; thay `catch{}` dòng 60 bằng thông báo lỗi thật.
3. `desktop/src/components/ImpositionTab.tsx:3123` — truyền `resultFilePath={(file as any)?.path}`.

**Lô 2 (rà quét): ĐÃ XONG 2026-08-06** — quét hết call-site `.arrayBuffer()`, mỗi chỗ trace
riêng, kết quả trong §5. **Không sửa file nào** (trong phạm vi IN/BẾ đã sạch sau lô 1); 3 chỗ
[CONFIRMED] còn lại thuộc Đánh số bìa / Ghép file → ghi "phát hiện thêm", chờ duyệt riêng.

(Lô "gỡ lỗi câm ở CutExportModal / list_cut_pages" đã **bỏ** — thuộc tính năng Gửi máy bế
đang tạm khoá.)

**Lô 3 (Mẹc Bìa / Đánh số bìa, 1 file): ĐÃ XONG 2026-08-06, chưa commit**

- `desktop/src/components/preprocess-tools/CoverNumberingTool.tsx` — thêm
  `import { getFileArrayBuffer } from '@/lib/utils'`; hai chỗ đọc bytes đổi sang SSOT đọc-đĩa-trước:
  - `:91` effect đếm số trang (`pdfFile.arrayBuffer()` → `getFileArrayBuffer(pdfFile)`) — trước đây
    File path-backed rỗng làm UI hiện "0 trang".
  - `:193` trích trang bìa khi `singleFileMode` (`template.arrayBuffer()` → `getFileArrayBuffer(template)`).
  Mỗi chỗ gắn tag truy vết `FILEIO (audit 2026-08-06 §5)`.
- KHÔNG cần sửa đường backend: `lib/api.ts:526-529` `startVdpJobBackend` đã gửi `file_path` khi
  File có `.path`, chỉ fallback multipart khi không có.

- `desktop/src/components/preprocess-tools/CoverNumberingTool.nativePath.test.tsx` (mới) — 3 test
  hồi quy render component thật: (1) File RỖNG + `.path` → đọc đĩa, UI hiện "File có 6 trang";
  (2) File blob không path → KHÔNG gọi `fetchLocalFileBuffer`, vẫn ra "File có 3 trang";
  (3) bấm Chạy ở `singleFileMode` → template đưa cho `startVdpJobBackend` là PDF THẬT 1 trang
  tên `cover_Ruot_va_bia.pdf` (chứ không ném "No PDF header found").

Verify lô 3: `npm run typecheck` sạch · `npm run build` (tsc + vite, 3537 module, 4.78s) sạch,
chỉ còn cảnh báo cũ (chunk-size, INEFFECTIVE_DYNAMIC_IMPORT) · vitest **5 file / 44 test PASS**
(`CoverNumberingTool.nativePath`, `savePrintFiles.nativePath`, `printFileNaming`,
`OpenInDesignModal`, `processHandlers`) · `npx eslint`: file test mới sạch; trên
`CoverNumberingTool.tsx` 8 lỗi `no-explicit-any` **đều là nợ cũ** (kể cả dòng `:204` không chạm),
không phát sinh lỗi mới.

**Kiểm chứng test có "răng" (mutation check):** lần lượt hoàn tác từng chỗ sửa rồi chạy lại —
`:94` → `pdfFile.arrayBuffer()` làm test 1 RED; `:198` → `template.arrayBuffer()` làm test 3 RED
đúng thông điệp `khong_chay_duoc_vdp: template.arrayBuffer is not a function`. Sau đó phục hồi
bản sửa, 3/3 xanh lại. Vậy test thực sự bắt được bug, không phải test rỗng.

Bẫy môi trường ghi lại: jsdom **không có** `Blob/File.prototype.arrayBuffer`. File template được
tạo BÊN TRONG component nên không vá per-instance như lô 1 được → test đọc bytes qua `FileReader`.

Khoảng trống còn lại của lô 3: chưa có bằng chứng RUNTIME (cần người dùng mở Mẹc Bìa trên máy
license Pro, kiểm số trang và thao tác trích bìa trên file thật).

Verify mỗi lô: `npm run typecheck` + `vitest` liên quan, theo quy tắc build gate trước khi commit.

## 7. Cập nhật ma trận

- `W2-U02-OC`: bổ sung mắt xích "đọc bytes kết quả theo đường native" — **nâng lại `AUTO`** sau
  lô 1 (2 test hồi quy `savePrintFiles.nativePath`); giữ khoảng trống ARTIFACT (Illustrator/Graphtec).
- `W5`: thêm ghi chú đường IN native là path-first (miễn nhiễm sentinel), còn thiếu bằng
  chứng RUNTIME với máy in vật lý.
