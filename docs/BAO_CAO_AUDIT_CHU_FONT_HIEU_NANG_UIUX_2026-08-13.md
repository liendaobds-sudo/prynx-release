# BÁO CÁO AUDIT CHỮ & FONT — HIỆU NĂNG VÀ UI/UX

**Ngày:** 2026-08-13  
**Audit unit:** `W7-U08` — mở PDF → **Chữ & Font** → quét font/chữ → khóa chữ → Viewer nhận kết quả  
**Phạm vi:** UI `font_tools`, upload/inspect/fix/download, engine Preflight hai rule font và đường `OUTLINE_FONTS`.  
**Ngoài phạm vi:** thay đổi hình in, nới chốt an toàn, cập nhật golden, build/installer.  
**Trạng thái:** audit + benchmark tĩnh/tự động; **Lô A và Lô B đã được triển khai sau khi người dùng duyệt**. Lô C–D chưa triển khai.

**Cập nhật sau triển khai:** các finding về route/event-loop, planner font-only,
stale result, occurrence/font duy nhất, UI lặp và hủy request đã có bản sửa và
regression tương ứng. Các số đo ở phần baseline bên dưới được giữ nguyên như
bằng chứng trước sửa; không dùng chúng để mô tả trạng thái code hiện tại.

## 1. Tóm tắt điều hành

Phản ánh “rườm rà và thực thi quá lâu” là có cơ sở. Đường hiện tại có hai lớp chi phí khác nhau:

1. **Chi phí thừa có thể bỏ:** quét bằng Preflight tổng quát, dựng `ProcessPoolExecutor` mới cho file trên 10 trang dù chỉ chạy hai rule font, chặn event loop, không tái dùng file ID/báo cáo theo tài liệu, không hủy request cũ, và truyền file kết quả vòng `backend → WebView → backend` trước khi Viewer mở.
2. **Chi phí an toàn phải giữ:** kiểm tra không còn chữ sống và so kẽm từng trang trước/sau outline. Đây là chốt từng bắt lỗi sai mặt chữ, sai `Tr`, bỏ sót Form XObject và sai trang sau; không được “tối ưu” bằng cách bỏ hoặc chỉ kiểm trang đầu.

Benchmark trên máy Windows hiện tại bằng `backend\venv\Scripts\python.exe`, commit `5629eaf`, branch `codex/pre-release-audit-2026-08-04`:

| Mẫu tổng hợp | Quét full hiện tại, median | Chỉ chạy trực tiếp hai check font + chữ, median | Phần overhead quan sát được |
|---|---:|---:|---:|
| 5 trang | 7,58 ms | 6,47 ms | 1,11 ms |
| 15 trang | 357,19 ms | 14,21 ms | 342,98 ms |
| 50 trang | 503,73 ms | 100,03 ms | 403,70 ms |
| 100 trang | 770,32 ms | 213,68 ms | 556,64 ms |

Mốc gãy đúng tại `>10` trang, trùng nhánh tạo process ở `preflight_engine.py:173-225`. Endpoint route 50 trang đo **506,73 ms**, trong đó event-loop heartbeat bị hở tối đa **506,80 ms** — tức sidecar không phục vụ coroutine khác trong toàn lượt quét.

Benchmark outline tổng hợp có font TrueType nhúng:

| Trang | Tổng thời gian | Hậu kiểm so kẽm | Tỷ trọng hậu kiểm |
|---:|---:|---:|---:|
| 1 | 254,30 ms | 152,98 ms | 60,2% |
| 5 | 362,66 ms | 165,89 ms | 45,7% |
| 15 | 1.007,23 ms | 433,03 ms | 43,0% |

Con số này là microbenchmark tổng hợp, chưa phải runtime Tauri trên PDF khách. Tuy nhiên nó xác định đúng nơi cần tối ưu: **orchestration, parse/open lặp và transport**, không bỏ hậu kiểm.

## 2. Đường chạy đã trace

### 2.1 Mở công cụ và quét

`toolRegistry.ts:254-266`  
→ `ImpositionTab.tsx:2608-2696` chọn PDF và vào workspace  
→ `PreprocessingRouter.tsx:228-232` mount `FontToolsTool`  
→ `FontToolsTool.tsx:74-96` bấm **Quét chữ & font**  
→ `FontToolsTool.tsx:66-72` gọi `uploadPDF()` nếu state cục bộ chưa có ID  
→ `api.ts:276-335` đăng ký/copy/upload PDF  
→ `POST /preflight/inspect` tại `preflight.py:322-340`  
→ `PreflightEngine.run()` tại `preflight_engine.py:107-264`  
→ `_check_fonts()` tại `preflight_rules/fonts.py:37-83`  
→ `_check_live_text()` tại `preflight_rules/structure.py:9-40`  
→ response về `FontToolsTool.tsx:90`  
→ render toàn bộ `report.issues` tại `FontToolsTool.tsx:175-186`.

### 2.2 Khóa chữ và giao file

`FontToolsTool.tsx:98-128`  
→ `POST /preflight/fix` action `OUTLINE_FONTS`  
→ `preflight.py:366-385`  
→ `ActionEngine.execute()` tại `action_engine.py:212-347`  
→ `_action_outline_fonts()` tại `action_engine.py:620-654`  
→ `outline_text.outline_fonts()` tại `outline_text.py:1422-1468`  
→ mỗi trang lấy glyph PPE tại `outline_text.py:1634-1640`  
→ kiểm không còn chữ sống tại `outline_text.py:1696-1712`  
→ `verify_outline()` so kẽm từng trang tại `outline_text.py:1334-1419`  
→ publish atomic tại `action_engine.py:248-264`  
→ response chỉ trả `output_filename` tại `preflight.py:257-263`  
→ frontend tải toàn bộ file tại `FontToolsTool.tsx:116-121`  
→ `commitWorkingFile()` lại ghi/upload file để có path Viewer tại `ImpositionTab.tsx:955-989`.

## 3. Phát hiện đã xác minh

### §FONT.PERF.1 — [CONFIRMED] P1 / S — Quét font chặn event loop backend

**Bằng chứng code:** route là `async def` nhưng gọi đồng bộ `engine.run(...)` trực tiếp tại `backend/app/api/routes/preflight.py:323-337`. `PreflightEngine.run()` mở PDF, duyệt mọi trang và có thể chờ process tại `backend/app/core/preflight_engine.py:124-248`.

**Bằng chứng chạy:** probe route trên PDF tổng hợp 50 trang: `route_ms=506,73`, `max_event_loop_gap_ms=506,80`. Khoảng hở bằng gần toàn thời gian route, chứng minh event loop bị giữ.

**Consumer live:** `FontToolsTool.tsx:81-90` gọi đúng endpoint này; Preflight tổng quát cũng dùng cùng endpoint.

**Tác động:** trong lúc quét, health/request UI khác cùng sidecar có thể bị trễ; UI chỉ có spinner nên người dùng cảm giác ứng dụng đứng. Đây là hồi quy so với tuyên bố trong `docs/PERF_FIXES_2026-07-26.md:9`, vốn ghi route Preflight đã được đưa ra threadpool, nhưng checkout hiện tại không có bản sửa đó.

**Đề xuất:** đưa `PreflightEngine.run()` ra threadpool thường; thêm regression heartbeat tương tự `test_upload_fail_fast.py:191-228`. Không chiếm heavy slot vì quét font/chữ là việc trung bình.

### §FONT.PERF.2 — [CONFIRMED] P1 / M — Hai rule font vẫn kích hoạt ProcessPool mới cho mọi file trên 10 trang

**Bằng chứng code:** mọi `total_pages > 10` đều vào nhánh `ProcessPoolExecutor` tại `preflight_engine.py:173-225`, không xét tập rule có thực sự cần fan-out hay không. Mỗi lần `run()` dựng và hủy pool trong `with`, không có pool dùng chung.

**Bằng chứng chạy:** với cùng PDF font nhúng lặp:

- 15 trang: full `357,19 ms`, hai check trực tiếp `14,21 ms` — overhead khoảng **25,1×** so với phần việc cần làm.
- 100 trang: full `770,32 ms`, trực tiếp `213,68 ms` — thừa khoảng **556,64 ms**.

Mốc 5→15 trang nhảy `7,58→357,19 ms` dù dữ liệu chỉ tăng 3×, đúng tại ngưỡng process.

**Consumer live:** `FontToolsTool.tsx:41,84` luôn gửi đúng `['FONT_NOT_EMBEDDED', 'TEXT_DETECTED']`.

**Đề xuất:** lập `CONTENT_STREAM_RULES` thật sự cần worker; với đúng hai rule font, chạy một pass in-process trong thread route. Với Preflight tổng hợp mới cân nhắc process; nếu giữ pool thì dùng chiến lược tái sử dụng/fallback có benchmark trên cả máy yếu và mạnh, không hard-cap mới.

### §FONT.PERF.3 — [CONFIRMED] P1 / M — Kết quả cũ có thể ghi đè file mới sau khi người dùng đổi tài liệu

**Bằng chứng code:** `FontToolsTool` reset state khi `pdfFile` đổi (`:54-64`) nhưng request đang chạy không có `AbortController`, generation hay identity guard (`:74-128`). Callback `onFileFixed()` luôn chạy khi response cũ về (`:116-121`). Backend action có cooperative cancel (`action_engine.py:229-279`) nhưng frontend không truyền hủy kết nối có chủ đích.

**Bằng chứng đối kháng:** test tạm đã bắt đầu outline `old.pdf`, rerender component sang `new.pdf`, rồi thả response cũ. `onFileFixed(blob, 'old_OUTLINE_FONTS.pdf')` vẫn được gọi. Test đạt đúng hành vi lỗi và đã được xóa sau audit.

**Tác động:** không chỉ chậm; output của tài liệu cũ có thể thay tài liệu người dùng đang xem.

**Đề xuất:** identity `workspaceDocumentIdentity` + generation ref + `AbortController`; chỉ commit khi identity request còn là identity hiện tại. Hủy upload/inspect/fix/download khi đổi file, đổi tool hoặc unmount; backend đã có nền cancel cooperative để hoàn thiện đường này.

### §FONT.PERF.4 — [CONFIRMED] P1 / M — File ID và báo cáo không dùng chung theo tài liệu; đổi tool gây upload/quét lại

**Bằng chứng code:** `fileId` và `report` chỉ là state local trong `FontToolsTool.tsx:46-48`, bị xóa tại `:54-64`; component chỉ tồn tại khi `activeTool === 'font_tools'` (`PreprocessingRouter.tsx:228-233`). Trong khi workspace đã có `selectionFileId + selectionDocumentIdentity` và pattern tái dùng đúng tại `InkManagerTool.tsx:29-67`/`OutputPreviewHost.tsx:27-74`.

**Consumer live:** đổi sang Preflight/Ink Manager rồi quay lại làm `FontToolsTool` mount mới; state quét không còn. Preflight riêng cũng giữ `fileId/report` local (`PreflightTool.tsx:62-89`) nên chuyển từ kết quả Preflight sang Chữ & Font không chuyển giao báo cáo đã có.

**Tác động:** người dùng phải bấm Quét lại; file lớn có thể bị đăng ký/copy/upload lại và backend parse lại, đúng cảm giác “nhiều bước”.

**Đề xuất:** dùng file ID chung đã bind với `workspaceDocumentIdentity`; cache báo cáo font theo identity trong workspace store hoặc cache hẹp tại backend theo `(path,size,mtime,rules-version)`. Nếu Preflight vừa chạy hai rule font trên cùng identity, mở Chữ & Font phải hiện ngay kết quả đó.

### §FONT.PERF.5 — [CONFIRMED] P1 / M — File kết quả đi vòng backend → WebView → backend

**Bằng chứng code:** backend đã có `result.output_path` nhưng `FixResponse` chỉ trả basename (`preflight.py:257-263`). Frontend tải toàn blob (`FontToolsTool.tsx:116-121`), rồi `commitWorkingFile()` trong Tauri gọi `uploadFileForNup(newFile)` để ghi lại một bản backend khác (`ImpositionTab.tsx:955-989`; `api.ts:649-662`).

**Consumer live:** đường thành công `OUTLINE_FONTS` luôn gọi `onFileFixed(blob, name)` mà không truyền path.

**Tác động:** với PDF lớn, thêm hai lần truyền toàn file, thêm bản sao đĩa và thêm thời gian trước khi Viewer mở. Đây là overhead tỷ lệ trực tiếp dung lượng, không liên quan độ an toàn outline.

**Đề xuất:** response desktop trả một capability/path được backend xác nhận hoặc đăng ký trực tiếp output thành `file_id`; `onFileFixed` truyền `existingPath` như các job đã hỗ trợ. Web vẫn dùng download blob. Không đưa path tùy ý từ client và không nới containment.

### §FONT.UI.1 — [CONFIRMED] P2 / S — “Tổng font” thực tế là số lần font xuất hiện theo trang; danh sách phình tới 2× số trang

**Bằng chứng code:** `_check_fonts()` tạo khóa `base_font + page_num` (`fonts.py:58-65`), nên một font duy nhất dùng trên 100 trang được tính là 100. `_check_live_text()` tạo một issue mỗi trang (`structure.py:18-37`). UI lại render từng issue không gộp (`FontToolsTool.tsx:168-186`).

**Bằng chứng chạy:** PDF 100 trang chỉ có một `/FakeFontQA` tạo:

- `font_summary = {total: 100, embedded: 0, not_embedded: 100}`;
- 100 issue font + 100 issue chữ = **200 thẻ UI**;
- tập `object_ref` font duy nhất chỉ có **1** giá trị.

PDF 100 trang dùng một font nhúng cũng báo `Tổng font = 100`, dù người dùng hiểu nhãn này là một font.

**Tác động:** số liệu gây hiểu sai và bảng bên hông trở nên dài/rối. Việc lưu page occurrence vẫn hữu ích để highlight, nhưng không nên dùng làm “Tổng font”.

**Đề xuất:** backend trả hai khái niệm riêng: `unique_fonts` và `occurrences/pages`; UI gộp theo font/rule, hiển thị “1 font trên 100 trang” và danh sách trang thu gọn. Chỉ mở chi tiết khi cần.

### §FONT.UI.2 — [CONFIRMED] P2 / S — Luồng hai nút, mô tả lặp và spinner vô hạn làm tăng cảm giác rườm rà

**Bằng chứng UI:** màn đầu có header chung từ `PreprocessingRouter.tsx:127-134`, thêm card mục tiêu `FontToolsTool.tsx:137-149`, rồi nút Quét riêng `:151-158`. Sau quét mới xuất hiện thêm tiêu đề/mô tả và nút Khóa `:200-214`. Trạng thái chạy chỉ đổi chữ/spinner; không có thời gian dự kiến, số trang, stage hay nút Hủy.

**Đề xuất sản phẩm:** khi mở công cụ với PDF, tự quét một lần theo identity; giữ nút nhỏ “Quét lại”. Sau quét chỉ hiển thị một khối quyết định:

- **Đã an toàn — không cần khóa**;
- **Có chữ sống, font đủ — Khóa chữ**;
- **Thiếu font gốc — Không thể khóa an toàn**.

Khi outline, hiển thị stage “Chuẩn bị → Chuyển chữ trang x/y → Hậu kiểm trang x/y → Mở kết quả”, thời gian đã chạy và **Hủy**. Card giải thích dài chuyển thành trợ giúp mở rộng, không lặp ngay trên màn chính.

### §FONT.PERF.6 — [CONFIRMED] P2 / L — Engine outline mở/parse tài liệu lặp theo trang và hậu kiểm mở cả hai PDF cho mỗi trang

**Bằng chứng code:** vòng trang Python gọi `_ppe_source_for_page()` (`outline_text.py:1634-1640`), dẫn tới native `ppe_text_outlines`; binding native gọi `ppe_open(pdf_path)` cho mỗi trang (`native/src/print_engine_py.rs:1454-1458`). Hậu kiểm mỗi trang gọi `_plate_stats()` cho bản trước và sau (`outline_text.py:1372-1378`); `facade.separations()` cuối cùng đi binding có `ppe_open(pdf_path)` mỗi call (`native/src/print_engine_py.rs:789-801`).

Với `N` trang, riêng hai vùng này có ít nhất khoảng `N + 2N = 3N` lần parse/open PPE, chưa kể pikepdf/PDFium và ghi file.

**Bằng chứng chạy:** outline 15 trang tổng hợp 1.007,23 ms; verify 433,03 ms (43,0%).

**Ràng buộc:** không bỏ verify từng trang, không hạ DPI mù, không thay bằng sample trang đầu.

**Đề xuất:** bổ sung API batch/session native cho text outlines và separations để mở mỗi PDF một lần rồi lặp trang; ưu tiên session riêng cho original và output trong verify. Thay đổi này chạm native + backend, cần benchmark/parity và lô riêng.

### §FONT.DOC.1 — [CONFIRMED] P2 / S — Tài liệu hiệu năng và mã hiện hành lệch nhau

`docs/PERF_FIXES_2026-07-26.md:9-11` ghi hai endpoint Preflight đã offload và dùng ProcessPool chia sẻ. Mã hiện tại vẫn gọi inline (`preflight.py:323-337`) và dựng pool cục bộ (`preflight_engine.py:204-225`). `git blame` cho route cho thấy dòng gọi trực tiếp có từ lịch sử đầu, không phải thay đổi chưa commit hiện tại.

**Tác động:** master audit có thể đánh giá sai vùng này là đã đóng; regression không có test heartbeat cho `/preflight/inspect`.

**Đề xuất:** sau khi sửa, thêm test bảo vệ và cập nhật log/matrix theo chính code đã verify; không dùng trạng thái “đã sửa” cũ làm bằng chứng hiện hành.

## 4. Những gì không được coi là lỗi / không được tối ưu bỏ

1. **[EXPECTED] Quét trước khi outline:** chặn thiếu font gốc là đúng; tự thay font có thể rơi dấu/chạy dòng.
2. **[EXPECTED] Hậu kiểm mọi trang:** các audit 2026-07-27 đã tái hiện lỗi ở trang sau và sai khác chữ nhỏ lọt ngưỡng toàn trang. Không quay lại kiểm trang 1 hoặc sampling ngẫu nhiên.
3. **[EXPECTED] Fail-closed:** output còn text sống, đổi số kẽm hoặc đổi mực phải bị từ chối.
4. **[SUSPECTED, chưa xếp finding] hard ceiling 8 của Preflight:** tài liệu cũ đã đánh dấu nghi vấn; audit này không có benchmark full 16-rule chứng minh >8 process tốt hơn. Không tự nới cap.

## 5. Khoảng phủ test hiện tại

### Đã chạy

- Backend trọng điểm Preflight + OUT FONT trước Lô A: **67 passed**, 1 warning.
- Frontend `FontToolsTool.test.tsx` trước Lô A: **2 passed**.
- Test đối kháng stale result trước Lô A: **1 passed**, chứng minh hành vi lỗi; file test tạm đã xóa.
- Sau Lô A: backend nhóm liên quan **71 passed, 17 skipped**, frontend `FontToolsTool` **5 passed**, typecheck và lint file liên quan đạt.
- `git diff --check`: đạt.

### Khoảng trống

- Đã có regression route heartbeat cho `/preflight/inspect` và planner font-only.
- Đã có test stale/cancel/đổi file và tái dùng `selectionFileId` theo document identity.
- Đã có regression unique font vs occurrence, report cũ, cache theo identity và
  multi-page UI collapse (một font/100 trang).
- Chưa có runtime Tauri với PDF khách lớn; benchmark hiện là synthetic.
- Một lượt full frontend đạt `2302 passed, 2 skipped` nhưng có 1 timeout ở test nền khác trong lần chạy đầu và 1 lỗi timing ở `OfficeConvertTool` trong lần chạy lại; chạy riêng các test bị ảnh hưởng đều đạt (`OutputPreviewLayout` 1/1, `OfficeConvertTool` 12/12). Test Lô A vẫn đạt riêng 5/5 và không có lỗi production liên quan.

## 6. Thiết kế đích đề xuất

```text
Mở Chữ & Font
  └─ identity tài liệu hiện tại
      ├─ có report còn mới → hiển thị ngay
      └─ chưa có → tự quét, có Hủy
          ├─ thiếu font → gộp theo font + danh sách trang
          ├─ không có chữ sống → “Không cần khóa”
          └─ có chữ sống + font đủ → một nút “Khóa chữ”
               ├─ batch/session outline
               ├─ hậu kiểm mọi trang (giữ nguyên)
               └─ backend handoff path/file-id trực tiếp cho Viewer
```

Không thêm cap vô điều kiện. Máy `<8 GB`/`8–15 GB` vẫn theo planner hiện hữu; máy `≥16 GB` không bị giảm công suất mới.

## 7. Thứ tự sửa đề xuất / trạng thái

### Lô A — correctness + độ phản hồi, tối đa 5 file — ĐÃ TRIỂN KHAI

1. Guard identity/generation + AbortController trong `FontToolsTool`.
2. Tái dùng `selectionFileId` đúng `workspaceDocumentIdentity`.
3. Offload `/preflight/inspect` khỏi event loop.
4. Planner bỏ ProcessPool cho tập rule font-only.
5. Test heartbeat, font-only planner và stale result.

Kết quả verify Lô A: backend `71 passed, 17 skipped` ở nhóm Preflight/OUTLINE;
frontend `FontToolsTool` `5 passed`; typecheck và lint các file frontend liên quan
đạt. Chi tiết ở `docs/CHU_FONT_FIXES_2026-08-13.md`.

**Kỳ vọng:** hết sidecar đứng, hết output cũ ghi đè, file nhiều trang không trả giá spawn process vô ích.

### Lô B — đơn giản hóa UI/report — ĐÃ TRIỂN KHAI THEO B1/B2

1. Tách `unique_fonts` khỏi occurrence/trang.
2. Gộp issue theo font/rule; trang thu gọn.
3. Tự quét một lần theo identity; “Quét lại” là hành động phụ.
4. Một khối quyết định ba trạng thái; thêm stage/thời gian/Hủy.
5. i18n VI/EN + test UI multi-page.

Lô B được tách thành B1 backend (3 file) và B2 frontend/store/i18n (5 file) để
giữ mỗi lô không quá 5 file. Kết quả verify: backend liên quan
`74 passed, 17 skipped` (nhóm font/preflight recursion + route cancel `32 passed`);
frontend `FontToolsTool` `10 passed`; typecheck và lint hẹp đạt. Chi tiết ở
`docs/CHU_FONT_FIXES_2026-08-13.md`.

### Lô C — bỏ vòng truyền file, tối đa 5 file

1. Hợp đồng response desktop trả capability/file-id/path đã xác thực.
2. `FontToolsTool` dùng path/file-id trực tiếp khi có Tauri; web giữ download.
3. `commitWorkingFile` nhận `existingPath`, không upload lại.
4. Test containment, web fallback và Tauri handoff.

### Lô D — tối ưu engine batch/session, tách backend/native thành lô nhỏ

1. Benchmark corpus trước sửa và thêm timing stage.
2. Native API batch/session lấy text outline nhiều trang, mở PDF một lần.
3. Verify original/output bằng hai session, vẫn so mọi trang/kẽm.
4. Chạy parity/golden OUT FONT, corpus thật và benchmark cả máy mạnh + policy máy yếu.

Lô D có rủi ro cao nhất nên chỉ làm sau A–C và sau khi số đo cho thấy transport/orchestration chưa đủ.

## 8. Trạng thái bằng chứng

`W7-U08 = AUTO + BENCH (synthetic), RUNTIME còn mở`.

- `TRACED`: đủ entry → handler → engine → output → consumer.
- `AUTO`: suite hiện hữu và test đối kháng stale result đã chạy.
- `BENCH`: có số đo synthetic 1/5/15/50/100 trang.
- Chưa `ARTIFACT/RUNTIME`: chưa chạy PDF khách lớn qua app Tauri và chưa đo file kết quả tại Viewer.
