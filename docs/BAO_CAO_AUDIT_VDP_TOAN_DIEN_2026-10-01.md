# Báo cáo audit toàn diện VDP — 01/10/2026

## 1. Phạm vi và cách làm

Audit này rà toàn dọc VDP/Chạy số từ DataMerge và picker ở desktop, API FastAPI, worker PDF/ảnh/font, job lifecycle, output artifact, đến các điểm đo hiệu năng. Phạm vi lấy theo source hiện tại tại `HEAD 8d718b8` (30/09/2026), gồm commit tối ưu VDP single-pass/font/resource-cache và các thay đổi trước đó.

Worktree có nhiều thay đổi WIP của các luồng imposition/sticker/nesting. Audit không reset, checkout, sửa hay diễn giải các thay đổi đó như một phần của VDP; các file VDP không có thay đổi chưa commit tại thời điểm khảo sát.

Quy trình áp dụng: `prynx-architecture`, `prynx-audit-workflow`, `prynx-deep-audit`, `prynx-imposition`, `prynx-performance`, `prynx-testing`. Phần đầu tài liệu là **baseline audit read-only** đối với production code; nhật ký xử lý và bằng chứng verify sau đó nằm ở §10.

### Quy ước trạng thái

- `TRACED`: đã lần theo source, chưa có runtime/artifact độc lập.
- `AUTO`: test/harness tự động đã chạy.
- `ARTIFACT`: đã mở lại/đọc artifact kết quả và kiểm hậu điều kiện.
- `RUNTIME-PARTIAL`: tái hiện ở worker/API trực tiếp, chưa phải packaged Tauri.
- `[CONFIRMED]`: có consumer, bất biến bị vi phạm và bằng chứng tái hiện được.
- `[SUSPECTED]`: giả thuyết có đường đi hợp lý, cần harness/fixture thêm.

## 2. Kết luận điều hành

**Chưa đủ điều kiện nâng VDP lên trạng thái đã xác minh toàn diện.** Các tối ưu 30/09 có test hồi quy nền xanh, nhưng audit mới phát hiện ba nhóm rủi ro P1:

1. **Sai artifact nhiều trang:** `pageNum` có ở desktop nhưng bị loại khỏi schema backend; output có thể đặt nhiều field vào cùng một trang. Preview nhiều trang có thể crash từ record 2.
2. **Preview không cùng hợp đồng với output:** UI đang dùng live overlay nội bộ; không gọi `previewVdpRecord` production. Điều kiện/rule/inline và ảnh `imagePath` có thể hiển thị khác PDF cuối.
3. **Race/lifecycle và đường nóng:** status có thể báo `completed` trước khi `artifact_lease` được thấy; preview gọi PDFium đồng bộ trong async route, không bọc `pdfium_guard`; upload preview còn đọc toàn bộ payload không giới hạn.

Các tối ưu datasource đã chứng minh **parity API** và giảm một số khoảng chờ event loop trong probe cô lập, nhưng chưa chứng minh throughput/p95 của VDP output, peak RSS 5k–10k trang, hay packaged Tauri.

## 3. Ma trận phủ audit

| Audit unit | Entry → consumer | Bằng chứng hiện tại | Trạng thái |
|---|---|---|---|
| W4-U01 | DataMerge/picker → `VdpField` → `process_chunk` → PDF | Test API/worker; tái tạo PDF 2 trang với field có `pageNum` | `ARTIFACT · P1 mở` |
| W4-U02 | `/vdp/preview` → `render_record_preview` → PDFium PNG | Tái tạo trực tiếp: index 1 chạy, index 2/3 `PdfiumError` | `RUNTIME-PARTIAL · P1 mở` |
| W4-U03 | CSV/XLSX/GSheet → preview/validate/generate | 136 backend VDP test; 12 file/107 frontend test; probe datasource parity | `AUTO · còn gap` |
| W4-U04 | Live overlay → output rules/fonts/images | Trace frontend/backend; không có parity test/caller production preview | `TRACED · P1 mở` |
| W6-U01 | global event → nhiều DataMerge/tab | Trace event không có `tabId` | `TRACED · P2 mở` |
| W7-U02 | chunk/resource cache → final pikepdf save | Source trace; chưa có benchmark output lớn/RSS | `TRACED · P2 mở` |
| W8/entitlement | route/job/download/lease | Test route nền; chưa clean-install/Tauri packaged | `AUTO-PARTIAL` |

## 4. Finding đã xác nhận

Chỉ các finding dưới đây được xếp severity. `P1` ảnh hưởng đúng/sai artifact hoặc có thể làm job không dùng được; `P2` ảnh hưởng dữ liệu, UX, tài nguyên hoặc vòng đời trong điều kiện cụ thể.

| ID | Mức/effort | Trạng thái | Bằng chứng và tác động |
|---|---|---|---|
| **§VDP.01** | **P1 / M** | `[CONFIRMED] · ARTIFACT` | Desktop tạo và lọc `pageNum` (`desktop/src/components/workspace/LivePageFrame.tsx:4909,4958,8173`), nhưng `backend/app/schemas/vdp.py:24-81` không có field này; Pydantic bỏ extra key. `process_chunk` (`backend/app/workers/vdp_engine.py:1586-1600,1635-1754`) render mọi field cho mọi record/template page. Probe template 2 trang + field `PAGE1/PAGE2` cho output: trang 1 chứa cả hai, trang 2 cũng chứa cả hai. Field theo trang bị sai artifact. |
| **§VDP.02** | **P1 / S** | `[CONFIRMED] · RUNTIME-PARTIAL` | `render_record_preview` tính `t_idx=(index-1)%template_page_count` rồi gọi writer chỉ với một row (`backend/app/workers/vdp_preview.py:189-245`). Probe template 3 trang: index 1 trả PNG `298×420`; index 2 và 3 ném `PdfiumError: Failed to load page` vì PDF một trang nhưng truy cập trang 2/3. |
| **§VDP.03** | **P1 / M** | `[CONFIRMED] · TRACED` | `previewVdpRecord` chỉ được định nghĩa (`desktop/src/lib/api.ts:1574-1622`), không có caller. UI dùng live overlay trong `LivePageFrame`; output dùng `resolve_field_content`/rules/inline (`backend/app/workers/vdp_conditions.py:315-365`, `vdp_engine.py:1136-1163`). Không có một pipeline preview production chung cho thao tác người dùng, nên parity chưa được bảo vệ. |
| **§VDP.04** | **P1 / S** | `[CONFIRMED] · TRACED` | Live resolver (`desktop/src/components/workspace/LivePageFrame.tsx:3177-3235`) chỉ thay placeholder/giá trị đơn giản; backend áp conditions → rules → inline. Với cùng row, field có `hide_if`, first-match rule hoặc inline token có thể bị ẩn/đổi nội dung ở PDF nhưng vẫn hiện trên LIVE. |
| **§VDP.05** | **P1 / S** | `[CONFIRMED] · TRACED` | `DataMergeTool` chỉ lưu `preview_rows` (tối đa 20) nhưng đặt `previewTotal=sourceRecordCount` (`desktop/src/components/preprocess-tools/DataMergeTool.tsx:790-805,1214-1229`). Navigator cho phép record 21+ (`VdpRecordNavigatorBar.tsx:177-183`), trong khi `csvData` không có row tương ứng; LIVE hiển thị rỗng/placeholder dù export đọc lại đủ nguồn. |
| **§VDP.06** | **P1 / S** | `[CONFIRMED] · TRACED` | `_publish_vdp_output` ghi `job["status"]="completed"` trước `result` và `artifact_lease` (`backend/app/api/routes/vdp.py:189-221`); GET status đọc dict không lock (`:720-750`). `pollVdpJob` kết thúc ngay khi thấy `completed` (`desktop/src/lib/api.ts:960-974`) và có thể trả blob/path rỗng khi lease chưa xuất hiện. Đây là cửa sổ race giữa trạng thái terminal và artifact publish. |
| **§VDP.07** | **P1 / M** | `[CONFIRMED] · TRACED` | `/vdp/preview` là `async` nhưng gọi `render_record_preview` trực tiếp (`backend/app/api/routes/vdp.py:1107-1175`). Worker mở/raster PDFium (`vdp_preview.py:243-253`) không qua `pdfium_guard()` và chạy trên event loop. Một preview lớn có thể chặn request khác và vi phạm bất biến PDFium không thread-safe. |
| **§VDP.08** | **P2 / S** | `[CONFIRMED] · TRACED` | Navigator phát event toàn cục chỉ có `{index}` (`desktop/src/components/workspace/VdpRecordNavigatorBar.tsx:163,182,198`); mọi `DataMergeTool` lắng nghe (`DataMergeTool.tsx:1246-1253`) không kiểm tab đang active. Đổi record ở tab A có thể đổi LIVE preview tab B. |
| **§VDP.09** | **P2 / S** | `[CONFIRMED] · TRACED` | PapaParse ở desktop đổi duplicate header thành `Name`, `Name_1`; backend `_parse_csv_upload` dùng dict comprehension (`backend/app/api/routes/vdp.py:265-276`) nên cột trùng bị ghi đè. Probe `Name,Name\nA,B` cho UI `{Name:A,Name_1:B}` nhưng backend `{Name:B}`. |
| **§VDP.10** | **P2 / S** | `[CONFIRMED] · TRACED` | `/vdp/upload` dùng `await file.read()` rồi ghi một lần (`backend/app/api/routes/vdp.py:772-784`), không áp `MAX_VDP_PAYLOAD_BYTES=256MB` như `/generate`. Payload lớn vừa tạo peak RSS không giới hạn vừa chặn event loop. `/preview` cũng đọc/ghi đồng bộ trong async route (`:1145-1165`). |
| **§VDP.11** | **P2 / M** | `[CONFIRMED] · TRACED` | Tối ưu single-pass đã bỏ một lần pypdfium2/pikepdf, nhưng final vẫn tạo `pikepdf.Pdf.new()` rồi `final_pdf.pages.extend(src_pdf.pages)` cho tất cả chunk trước khi save (`backend/app/workers/vdp_engine.py:2233-2237`). Rủi ro object graph/RSS lịch sử §HEAVY.03 (5k–10k trang, 3–5GB) chưa có benchmark sau commit 8d718b8; không được coi claim “10–20×” ở `vdp_engine.py:554-556` là bằng chứng.
| **§VDP.12** | **P2 / S** | `[CONFIRMED] · TRACED` | `scale: float = Form(2.0)` (`backend/app/api/routes/vdp.py:1122`) truyền thẳng tới `page_r.render(scale=scale)` (`vdp_preview.py:246`) mà không kiểm finite/range/pixel budget. Giá trị cực lớn có thể gây OOM/thời gian raster không giới hạn. |
| **§VDP.13** | **P2 / S** | `[CONFIRMED] · TRACED` | `_purge_old_jobs()` chỉ được gọi ở đầu `/generate` (`backend/app/api/routes/vdp.py:98,523`). Cleanup artifact lease không xóa `vdp_jobs` terminal; job/result/lease reference có thể tồn tại đến lần generate sau, còn status/download có thể trỏ file đã hết lease. |
| **§VDP.14** | **P2 / S** | `[CONFIRMED] · TRACED` | UI resolver ảnh mặc định chỉ lấy text/name (`desktop/src/components/workspace/LivePageFrame.tsx:3177-3185`), còn nhánh image dùng `liveVal` làm src (`:8387-8405`). Backend có fallback `imagePath` (`backend/app/workers/vdp_engine.py:751,1159-1163`), vì vậy ảnh tĩnh/field mismatch có thể hiện placeholder trên LIVE nhưng vẫn xuất được ở PDF. |
| **§VDP.15** | **P2 / S** | `[CONFIRMED] · TRACED` | Backend ghi `Issue.record_idx` zero-based (`backend/app/workers/vdp_validate.py:50-55,340-381`), UI in trực tiếp `dòng {record_idx}` (`DataMergeTool.tsx:2867-2879`). Lỗi record đầu tiên hiển thị “dòng 0”. |
| **§VDP.16** | **P2 / S** | `[CONFIRMED] · TRACED` | `validateIssues/validateGating` được ghi ở `runValidate` (`DataMergeTool.tsx:1300-1313`) nhưng không invalidation khi đổi nguồn, mode, sheet, header hoặc fields; `handleExportReport` vẫn dùng cache (`:1380-1388`). Báo cáo lỗi sau khi đổi nguồn có thể mô tả source cũ. |
| **§VDP.17** | **P2 / S** | `[CONFIRMED] · TRACED` | Đổi mode chỉ gọi `setDataMode` (`DataMergeTool.tsx:1811-1823`), không reset `csvData/sourceRecordCount/xlsxFile/gsheetUrl`. `buildSourceParams` còn fallback rows khi URL GSheet rỗng (`:1259-1273`). Có thể preview/generate dữ liệu cũ dưới mode mới. |
| **§VDP.18** | **P1 điều kiện / S** | `[CONFIRMED] · TRACED` | Mọi VDP tool gọi `pollVdpJob(..., skipDownload=true)` (`DataMergeTool.tsx:1181-1187,1429-1439`). API trả Blob giả 5 byte cùng native path (`desktop/src/lib/api.ts:960-974`); nhánh Tauri dùng path thật, nhưng nhánh web/dev không có native path có thể giữ Blob giả làm PDF rỗng. Nếu web deployment không được hỗ trợ thì cần chặn rõ; nếu có, đây là lỗi artifact P1. |
| **§VDP.19** | **P2 / S** | `[CONFIRMED] · RUNTIME-PARTIAL` | Giới hạn `MAX_VDP_ROWS=100000` chỉ được áp ở `/generate` (`backend/app/api/routes/vdp.py:277-288,358-359`). Probe `_table_from_rows` và `read_source('csv', …100001 rows)` nhận đủ 100001; `/datasource`, `/validate`, `/preview`, `/error-report` có thể bypass cap qua `rows_file`. Đây là đường OOM/latency và contract drift. |
| **§VDP.20** | **P1 / M** | `[CONFIRMED] · TRACED` | `_register_cleaned_template` tạo `fid=cleaned_<12 hex>` rồi truyền vào `create_artifact_lease` (`backend/app/api/routes/vdp.py:1368-1404`), nhưng `_valid_fid` chỉ nhận UUID canonical 36 ký tự (`backend/app/core/artifact_lease.py:93-99`); exception bị nuốt nên lease thực tế luôn `None` trước khi DB đổi fid. Các event emitters cũng bỏ `artifact_lease` (`LivePageFrame.tsx:4021-4030,4123-4132`; `DataMergeTool.tsx:646-655`). Cleaned PDF vì vậy không có lease bảo vệ và có thể biến mất trong khi tab còn giữ path/FID. |
| **§VDP.21** | **P2 / S** | `[CONFIRMED] · TRACED` | `run_vdp_engine` gọi `process_pool_admission(...)` nhưng không truyền `queue_cancelled=cancellation_requested` (khoảng `backend/app/workers/vdp_engine.py:2170-2190`); wrapper `@scheduled_job("vdp")` còn chờ `heavy_job_slot` đồng bộ. Khi đang chờ RAM/slot, job đã hủy vẫn có thể đứng trong admission đến khi tài nguyên rảnh. |

## 5. Nghi vấn cần fixture/runtime để nâng hoặc bác bỏ

| ID | Mức dự kiến | Dấu vết hiện tại | Bằng chứng cần thêm |
|---|---|---|---|
| §VDP.S01 | P1–P2 | Font cache mới dùng key `(font resource key, BaseFont)` (`vdp_engine.py:572-586`); probe CJK nhiều record với `msjh.ttc` giữ đúng chuỗi, nên chưa có bug cache đơn giản. Proof gap còn lại là subset/Unicode/embedded font khác nhau bị dùng chung. | Corpus font subset, CJK/emoji/RTL, nhiều chunk; mở PDF bằng pypdfium2/Illustrator và kiểm glyph/font resource identity. |
| §VDP.S02 | P2 | Cache `image_cache/qr_cache` theo chunk chưa có giới hạn decoded-pixel/RAM; estimator thiên về kích thước file nén. | N=1k/10k ảnh lớn + QR, đo peak RSS và eviction dưới RAM `<8`, 8–16, `≥16GB`. |
| §VDP.S03 | P2 | XLSX/GSheet đọc lại ở preview, validate và generate (`DataMergeTool.tsx:813-885,1279-1295,1338-1345`), tạo nhiều fetch/copy JSON. | Probe N=10k/100k, GSheet latency/rate-limit, browser heap và p95 generate. |
| §VDP.S04 | P2 | Async picker/text auto-detect còn gọi pikepdf trực tiếp (`backend/app/api/routes/vdp.py:1420-1426,1547-1552`). | ASGI heartbeat probe với PDF lớn và nhiều request đồng thời. |
| §VDP.S05 | P2 | `VdpField` chưa validator finite/range cho x/y/w/h/font/lineHeight/rotation (`backend/app/schemas/vdp.py:24-81`). | Fuzz NaN/Inf/âm/giá trị cực lớn qua API → kiểm 4xx, không artifact, không worker crash. |
| §VDP.S06 | P2 | Response source bất đồng bộ chưa có revision/latest-only guard; kết quả cũ có thể ghi đè kết quả mới. | Harness trả lời out-of-order cho XLSX/GSheet/CSV và đổi sheet nhanh. |
| §VDP.S07 | P2 | `vdp-template-cleaned` listener kiểm tab trước `await` nhưng không recheck revision sau fetch (`DataMergeTool.tsx:647-655`; `ImpositionTab.tsx:2117-2185`). | E2E hai sự kiện dọn template ngược thứ tự, xác nhận artifact/selection cuối. |
| §VDP.S08 | P2 | Warning normalize font ghi cả object pikepdf khi exception (`vdp_engine.py:527-528`), có khả năng lộ metadata/path. | Log redaction test với font lỗi/khách và scan log release. |
| §VDP.S09 | P2 | `onSpawnTab` ghép Blob giả với native path nhưng không đặt kích thước thật (`ImpositionTab.tsx:4866-4874`); tab mới có thể hiển thị 0.00 MB dù PDF native lớn. | Click-smoke spawn tab → đọc metadata/kích thước → mở lại artifact. |
| §VDP.S10 | P2 | Background task parse toàn bộ spooled JSON/CSV trước lần kiểm tra cancel đầu tiên (`backend/app/api/routes/vdp.py:464-489`). Hủy payload gần 256MB có thể không phản hồi trong thời gian parse. | Harness payload lớn + cancel ở các mốc parse, đo thời gian tới terminal và peak RSS. |
| §VDP.S11 | P3 | `/api/vdp/font-file` kiểm prefix bằng `startswith` sau lower-case; prefix path có thể khớp thư mục anh em như `FontsEvil`. | Windows path-boundary test với sibling directory, junction và case/UNC. |
| §VDP.S12 | P2 | `VdpField.id` chưa unique; `process_chunk` dùng set `handled_by_pdfium` theo id để quyết định field còn lại (`vdp_engine.py:1635,1743-1750`). Hai field trùng id có thể làm rơi fallback của field thứ hai. | Artifact hai field cùng id, một nhánh PDFium thành công/một nhánh lỗi; kiểm text/ảnh cuối và fail-closed schema. |

Các điểm trên chưa được xếp `[CONFIRMED]` để tránh biến code smell thành bug; không dùng chúng làm lý do duy nhất để chặn release trước khi có fixture.

## 6. Bằng chứng kiểm thử và đo hiệu năng

### Đã chạy và đạt

- `backend\venv\Scripts\python -m pytest backend/tests/vdp -q`: **90 passed, 3 warnings**.
- Bộ mở rộng từ thư mục backend (`test_vdp_engine`, lifecycle, curved text, object/text picker, `tests/vdp`): **136 passed, 1 skipped, 3 warnings**.
- Frontend VDP/preprocess/numbering/lease/entitlement: **12 files, 107 tests passed**.
- `desktop\npm run typecheck`: **exit 0**.
- `scripts/audit_contracts.ps1 -SelfTest`: **17/17 ca**.
- `py_compile` cho route/schema/engine/preview/datasource/validate: đạt.
- `docs/audit/PERF_2026-09-28/vdp_datasource_probe.py --runs 1 --variants control,after`: parity/hash/bytes đạt. XLSX preview `714.35→632.10ms`, CSV preview `220.24→285.49ms`; đây là ASGI probe một lượt, không phải p95 hay output benchmark.
- `git diff --check`: không có lỗi whitespace mới trong phạm vi VDP; cảnh báo blank-line cũ nằm ở file sticker WIP ngoài phạm vi.

### Chưa có, nên chưa được gọi là đạt

- Multi-page VDP với field scope/pageNum qua preview → generate → reopen PDF.
- Preview production được gọi thật từ desktop và parity với LIVE overlay.
- 5k–10k rows/pages: peak RSS, thời gian save cuối, cancel/retry, artifact lease.
- Corpus font Illustrator/CJK/Unicode/embedded subset sau resource-cache.
- XLSX/GSheet >20 record trong UI thật, duplicate header, mode switch và hai tab.
- Máy yếu `<8GB`, 8–16GB và máy mạnh `≥16GB` theo chính sách RAM; packaged Tauri/restart.

## 7. Ma trận edge case còn thiếu

| Nhóm | Ca cần khóa bằng test/artifact |
|---|---|
| Dữ liệu | rỗng/0; 1; 20; 21; 100k; duplicate header; UTF-8/CJK/RTL; dấu phẩy/quote/newline; decimal/NaN |
| Template | 0/1/n trang; mixed rotation; CropBox; field page 1/2; field ngoài trang; font subset/không nhúng |
| Output | reopen pypdfium2 + Illustrator; số trang; text/image/QR/barcode; deterministic hash; artifact lease |
| State/UI | CSV↔XLSX↔GSheet↔manual; header toggle; đổi sheet; validate rồi đổi nguồn; hai tab; tab nền |
| Runtime | cancel/retry; disconnect; status polling trước lease; preview scale nhỏ/lớn; GSheet chậm; upload lớn |
| Hardware | `<8GB`, 8–16GB, `≥16GB`; event-loop heartbeat; peak RSS; worker slot; restart sidecar |

## 8. Đề xuất lô sửa sau khi người dùng duyệt

Giữ đúng quy trình audit PrynX: mỗi lô tối đa 5 file, verify xong mới chuyển lô kế.

1. **Lô A — correctness preview/output:** schema + engine lọc `pageNum`; sửa preview multi-page; chuyển preview ra worker và bọc PDFium; thêm regression artifact.
2. **Lô B — publish/lifecycle:** publish status/result/lease nguyên tử; poller không kết thúc khi thiếu lease; idle purge và test cancel/retry/expiry.
3. **Lô C — data/state contract:** giới hạn upload/scale, duplicate-header canonical, invalidation source/validate, tab-scoped event, 21+ preview.
4. **Lô D — parity/performance:** nối caller production preview hoặc định nghĩa rõ live-only; conditions/rules/imagePath; benchmark 5k–10k và font/cache corpus.

Tại thời điểm lập baseline, các lô trên chưa được thực hiện; sau khi user yêu cầu “xử lý”, nhật ký áp dụng và verify được ghi tại §10.

## 9. Verdict

**VDP hiện ở mức `SOURCE + AUTO-PARTIAL + ARTIFACT-PARTIAL · HOLD`.** Test nền và datasource probe xanh không bác bỏ các lỗi P1 về multi-page/parity/publish. Không nên dùng claim speedup 10–20× hoặc trạng thái matrix W4 cũ để đóng audit mới.

## 10. Nhật ký xử lý sau khi user yêu cầu “xử lý” — 01/10/2026

Các lô A–C và phần parity của lô D đã được triển khai theo từng nhóm nhỏ, giữ nguyên các thay đổi WIP ngoài phạm vi VDP:

- **Correctness multi-page:** `pageNum` được giữ trong schema, kiểm tra 1-based, reject field ID trùng, lọc field theo trang trong worker và preview; offset chunk dùng chỉ số toàn cục.
- **Preview/runtime:** preview chọn đúng trang template, chạy ngoài event loop, khóa PDFium trong đoạn raster, có ngân sách pixel theo RAM khả dụng và dọn file tạm.
- **Publish/lifecycle:** trạng thái `completed` chỉ được công bố sau result + artifact lease; poller chờ đủ hai giá trị; cleanup gọi purge job VDP; admission quan sát hủy và không giữ slot khi job đã bị hủy.
- **Data/state:** upload và các đường `rows_file`/datasource có giới hạn payload/record; duplicate header giữ hậu tố `_1`, `_2`; preview record >20 tải lazy có abort/latest-only; validate và nguồn được invalidation khi đổi cấu hình.
- **UI parity/isolation:** live resolver dùng thứ tự conditions → first-match rules → inline token → placeholder/format như backend, hỗ trợ fallback `imagePath`; event điều hướng được scope bằng `tabId` cho DataMerge, Numbering, Cover Numbering và navigator; cleaned template truyền lease token.

### Verify sau xử lý

- Backend VDP mở rộng: **153 passed, 1 skipped**; focused admission/cleanup/page-scope/routes: **27 passed**.
- Frontend focused: **83 passed** (gồm proof preview caller và 37 ca parity); `npm run typecheck`: **pass**.
- `py_compile` route/scheduler/cleanup/schema/engine/preview: **pass**.
- Benchmark profile production trên Windows 10, i5-13400, 32 GiB, không override worker: 100 record đạt (7,9 s engine; 327 MiB peak tree); 5.000 record đạt artifact 5.000 trang (45,5 s engine; 13,37 GiB peak tree; 9 mẫu text/QR mở lại đúng); 10.000 record bị chặn ở monitor `WinError 1455` khi 15 worker tăng working set. Evidence: [`docs/audit/VDP_2026-10-01/`](audit/VDP_2026-10-01/).
- `git diff --check`: không có lỗi mới trong phạm vi VDP; cảnh báo blank-line cũ thuộc WIP sticker.

### Phần còn mở trước khi đóng audit/release

Benchmark 5.000 record đã có một run trên máy mạnh: artifact đúng nhưng peak khoảng 13,37 GiB với profile 15 worker; chưa có p95, baseline control, ảnh biến đổi lớn, hay các hạng RAM khác. Ca 10.000 bị chặn nên chưa có số đo production 10k. Vẫn chưa có corpus font subset/Unicode đầy đủ, kiểm packaged Tauri/restart, hoặc artifact reopen bằng RIP/Illustrator. UI đã có caller và unit test cho `previewVdpRecord`; E2E WebView → sidecar vẫn chưa chạy, còn live overlay dùng resolver chung để giữ cùng hợp đồng. Vì vậy verdict là **`AUTO + ARTIFACT-PARTIAL · còn gate hiệu năng/runtime`**, chưa gọi là nghiệm thu toàn diện.

