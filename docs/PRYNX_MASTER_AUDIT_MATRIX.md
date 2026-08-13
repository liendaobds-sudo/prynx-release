# PrynX Master Audit Matrix

> Cập nhật: 2026-08-11 · branch `codex/pre-release-audit-2026-08-04` · `W7-U04` hiện chỉ đạt `RUNTIME-PARTIAL` trên Tauri dev: cold/warm đã có pixel compositor thật, còn lăn/zoom/pan/xoay phải chạy lại bằng harness mới. `W7-U05` giữ `AUTO + ARTIFACT`; smoke `42/42` cũ đã bị hạ vì gate Background và semantic Show không hợp lệ. Lô 7 provenance/corpus gate đã đạt `AUTO`, nhưng chưa có log shadow thật nên default vẫn là `current`. Build/installed smoke, `§RENDER.11` và Lô 8 vẫn mở theo chỉ đạo hoãn build. `W8-U02` đã dọn xong source/runtime Ghostscript và còn chờ installer chứa source hiện tại để nâng bằng chứng artifact. `W2-U06 §MSHEET.1` đã sửa: CNC Dàn nhiều mẫu bảo toàn mọi tờ preview/artifact và fail-closed nếu thiếu mẫu. `W2-U07 §OPENAPP.1–2` đã sửa và đạt `AUTO`: path Corel/Illustrator thủ công thắng fallback tự dò; còn chờ runtime app thật. `W7-U07 §PRINTRANGE.1–4` đã sửa và đạt `AUTO`: nhận `27-28,30-33`, giữ current/selection đúng tab và truyền explicit list tới Rust/GDI; còn runtime artifact sau native rebuild.

Tài liệu này là bản đồ độ phủ audit sống của PrynX. Nó trả lời ba câu hỏi: luồng nào đã được truy vết, bằng chứng cao nhất hiện có là gì, và khoảng trống nào cần audit tiếp. Nó **không** chứng nhận “toàn dự án không còn bug”.

## 1. Quy tắc đọc ma trận

- Chấm theo **luồng dọc của người dùng**, không chấm theo số file đã đọc hoặc số test toàn repo.
- Trạng thái của một wave phản ánh mức bằng chứng đủ cho phạm vi wave trên cây mã hiện tại. Một nhánh nhỏ đạt `RUNTIME` không tự nâng cả wave.
- Test/scan cũ không đại diện cho code đã đổi. Khi entry, handler, engine, writer, dependency hoặc pipeline liên quan thay đổi, chuyển luồng sang `STALE` cho tới khi chạy lại.
- Preview, response API hoặc object trung gian không thay thế việc parse/render/đo artifact thật.
- Mọi hit của `scripts/audit_contracts.ps1` bắt đầu ở `[SUSPECTED]`; không tự xếp P0–P3 và không tự sửa.

### Thang bằng chứng

| Trạng thái | Điều kiện tối thiểu |
|---|---|
| `UNKNOWN` | Chưa truy vết đủ đường chạy sống. |
| `TRACED` | Đã chứng minh reachable và nối entry → handler → engine → artifact/consumer bằng `file:dòng`. |
| `AUTO` | `TRACED` + test tự động kiểm đúng bất biến nghiệp vụ/biên dữ liệu. |
| `ARTIFACT` | `AUTO` + đã parse/render/đo file thật do luồng tạo ra. |
| `RUNTIME` | `ARTIFACT` + đã thao tác lại trên app thật ở đúng chế độ dev/cài đặt/release cần kiểm. |
| `STALE` | Bằng chứng trước đó bị mất hiệu lực do code/dependency/pipeline/hợp đồng thay đổi. |

`STALE` là trạng thái phủ định, không phải mức cao hơn `RUNTIME`.

### Vòng đời finding

| Trạng thái | Ý nghĩa |
|---|---|
| `[SUSPECTED]` | Scanner/code smell/giả thuyết; chưa phải bug. |
| `[CONFIRMED]` | Đã chứng minh reachable, consumer, bất biến bị vi phạm và có tái hiện/test/artifact. |
| `[DISPROVED]` | Đã bác bỏ; lưu lý do để không điều tra lặp. |
| `[EXPECTED]` | Hành vi có chủ đích; có nguồn quyết định hoặc test bảo vệ. |

Chỉ `[CONFIRMED]` mới được xếp severity P0–P3 trong báo cáo audit.

## 2. Baseline độ phủ theo 8 wave

| Wave | Trạng thái | Bằng chứng đang có | Khoảng trống còn mở | Audit unit kế tiếp |
|---|---|---|---|---|
| **W1 — Kích thước, đơn vị, PDF page boxes** | `AUTO` | PB1–PB6 đã sửa; Crop 0/90/180/270 + mixed rotation đạt artifact; N-Up `/UserUnit=1/2` cùng 4 placement/raster; backend khóa `/UserUnit=1/100`; Viewer Rust khóa identity cache, parser mismatch, RAM gate và trang 2.001. | Chưa smoke app thật; chưa có một corpus duy nhất chạy qua mọi consumer/page box; Viewer native PB6 mới ở mức tự động. | Runtime smoke Crop + Viewer `/UserUnit=2`; sau đó mở rộng corpus sang W3 utilities. |
| **W2 — Preview ↔ PDF xuất của bình bản** | `AUTO` | PA1 truyền đủ `marginBottom`; PA2 working PDF và Mixed Guillotine fail-closed; preview/working-PDF regression đạt. Nhánh bù xén Alpha đạt `ARTIFACT`. `W2-U02-OC` đã sửa §OC.1–§OC.3. `W2-U06 §MSHEET.1` đã sửa và có artifact CNC một/hai mặt bảo toàn mọi tờ mẫu. `W2-U07 §OPENAPP.1–2` đã sửa, modal + OCG 29/29 test. | Chưa chạy app thật và chưa phủ toàn bộ marks/bleed/report/duplex bằng artifact chung. CNC multi-sheet còn thiếu thao tác runtime UI với file khách có đường bế/boong thật. `W2-U07` còn smoke đúng process/version CorelDRAW/Illustrator và quyết định riêng `§OPENAPP.S1`. | Runtime/downstream smoke CNC nhiều tờ + CorelDRAW/Illustrator trên app; sau đó ma trận W2 marks/bleed/report/duplex còn lại. |
| **W3 — Resize/Crop/Combine/Split/Convert** | `TRACED` | Resize transparency, resize giữ tỷ lệ, Export Image, Combine và Office từng có test/artifact/runtime riêng. | Chưa có bản đồ dọc cho toàn họ công cụ; Crop/Split và nhiều nhánh convert thiếu ma trận hiện hành; thiếu corpus box/rotate/encrypted/cancel/error/large-file. Một số file resize/combine hiện đang đổi. | `W3-U01`: lập registry entry → writer → reopen cho từng PDF utility, bắt đầu Resize/Crop. |
| **W4 — VDP và dữ liệu biến đổi** | `STALE` | Audit 2026-06 từng xác minh page-count/toạ độ/nội dung Numbering; repo có suite VDP và test gate Free/Pro mới. | `vdp.py`, DataMerge/Numbering/CoverNumbering và entitlement đã đổi sau bằng chứng artifact cũ. Chưa chạy lại CSV/XLSX/Google, rotate, multipage, barcode, preview↔output và key thật. | `W4-U01`: Data Merge CSV UTF-8/Unicode + multipage + reopen artifact; sau đó Numbering/Cover Numbering. |
| **W5 — Dieline, nesting, export, 3D** | `AUTO` | 582 test dieline, 30/30 nesting và sidecar/WebView đã đạt trong đợt gần nhất; Flip Top Tuck có golden/property/parity; Double Tray có test pose/wiring. | Chưa nghiệm thu trực quan 2D/3D toàn catalog trên cây mã hiện tại; thiếu pixel golden WebGL, installed-sidecar và in/cắt vật lý. | `W5-U01`: catalog sweep 2D CUT/CREASE/BLEED → export PDF → fold 0–100% → installed sidecar. |
| **W6 — Multi-tab, routing, event, state ownership** | `STALE` | Audit NAV.1–NAV.12 từng đạt full Vitest; audit mở file từng có smoke Tauri thật. | `App`, Home, Imposition, tool registry, recovery và entitlement đã tiếp tục đổi. Chưa lặp multi-tab/current-tool, background listeners, native drop, recovery, USB/UNC/NAS và đủ định dạng. | `W6-U01`: hai tab cùng loại + tab nền + native drop + đóng/reopen/recovery. |
| **W7 — PDFium, worker/process, RAM gate, hiệu năng** | `AUTO` | §PERF.1–9 đã sửa theo Lô 1–11. `W7-U04` có first-page fast path, Render Coordinator, process-isolated display worker, lane theo RAM, cancellation vật lý, cache ownership/atomic, viewport xoay và PPE latest-only. Hotfix `§RENDER.F1` chặn frame PDFium sai màu; `§ZOOM.F2` giữ tile nét theo DPI bucket. Pixel gate mới trên Tauri dev đo cold `4175/4670 ms` và warm `3971/4402 ms` cho first-visible/sharp + hai frame ổn định; đây là một lượt trên phiên dev nhiều process, không phải P50/P95. `W7-U05` giữ `AUTO + ARTIFACT`; smoke `42/42` cũ không còn là acceptance. `W7-U06` đã có cancel cooperative + output atomic cho file-action, benchmark high-tier và low-tier budget động `256–640 MiB`; máy mạnh không bị hard-cap mới. Native capability/pipeline nay khóa revision/dirty/build identity; corpus schema 2 giữ `current` và fail nếu thiếu cặp, MAE/P95/status/số mẫu không đạt. | Lăn/zoom/pan/xoay và Output Preview phải chạy lại bằng pixel gate mới sau khi rebuild native; chưa có log shadow thật đủ 5 cặp/trang; low/medium mới mô phỏng policy trên máy 32 GB, chưa benchmark vật lý `<8 / 8–15 GB` hoặc swap/page fault thật. W7-U01 PDFium cross-file chưa hoàn tất. Chưa build/smoke installer source hiện tại. | Chạy lại runtime current-source và thu corpus shadow sau native rebuild; nghiệm thu policy low-tier trên máy thật; khi người dùng duyệt build thì chạy installed smoke để đóng `§RENDER.11`. |
| **W8 — Security, license, build, release artifact** | `STALE` | Pipeline từng build installer nội bộ và chạy clean-user smoke; release gate fail-closed; audit bảo mật 2026-07-30 có phần migration/Edge được xác minh. `W8-U02` đã xóa production caller/config/telemetry/marker/setup legacy; build và verifier giữ tripwire bắt buộc. | Worktree hiện khác HEAD ở nhiều đường build và nghiệp vụ; artifact rc.4 không đại diện cho source đã dọn. Free/Pro mới chưa deploy/smoke bằng key thật. | Chạy `W8-U01`: internal build từ worktree hiện tại, kiểm payload không có thư mục/binary GS, rồi installed/clean-user smoke; không publish GitHub trong bước audit. |

## 3. Nguồn bằng chứng baseline

| Wave | Tài liệu chính |
|---|---|
| W1 | `docs/BAO_CAO_AUDIT_PAGE_BOX_W1_2026-08-04.md`; `docs/PAGE_BOX_FIXES_2026-08-04.md`; `docs/BAO_CAO_AUDIT_DO_CHINH_XAC_KICH_THUOC_UI_2026-08-04.md`; `docs/DO_CHINH_XAC_KICH_THUOC_FIXES_2026-08-04.md` |
| W2 | `docs/BAO_CAO_AUDIT_PREVIEW_ARTIFACT_W2_2026-08-04.md`; `docs/PREVIEW_ARTIFACT_FIXES_2026-08-04.md`; `docs/BAO_CAO_AUDIT_DUONG_CAT_ALPHA_2026-08-04.md`; `docs/BAO_CAO_AUDIT_OC_VA_DAT_TEN_OC_2026-08-05.md`; `docs/OC_VA_DAT_TEN_OC_FIXES_2026-08-05.md`; `docs/BAO_CAO_AUDIT_BAO_TOAN_NHIEU_TO_BINH_TRANG_2026-08-10.md`; `docs/BAO_CAO_AUDIT_DUONG_DAN_COREL_ILLUSTRATOR_2026-08-11.md`; `docs/DUONG_DAN_COREL_ILLUSTRATOR_FIXES_2026-08-11.md`; `audit-rules.md` §6; `docs/NUP_CUT_BORDER_FIXES_2026-08-04.md`; `docs/BINH_CAT_XEN_NHIEU_KICH_THUOC_FIXES_2026-07-30.md`; `docs/DAU_XEN_MIXED_GUILLOTINE_FIXES_2026-08-01.md` |
| W3 | `docs/RESIZE_TRANSPARENCY_FIXES_2026-08-03.md`; `docs/RESIZE_GIU_TY_LE_TUNG_TRANG_FIXES_2026-08-01.md`; `docs/XUAT_ANH_FIXES_2026-07-31.md`; `docs/COMBINE_PNG_LOADING_FIXES_2026-08-01.md`; `docs/LUONG_MO_FILE_FIXES_2026-08-02.md` |
| W4 | `docs/audit/AUDIT_REPORT.md`; `docs/audit/PERFORMANCE_REAUDIT_2026-07-23.md`; `docs/BAO_CAO_AUDIT_UIUX_2026-07-27.md`; `docs/FREE_PRO_FIXES_2026-08-04.md` |
| W5 | `audit-rules.md`; `docs/audit/PACKAGING_DIELINE_AUDIT_2026-07-19.md`; `docs/FLIP_TOP_TUCK_FIXES_2026-08-02.md`; `docs/DOUBLE_TRAY_FIXES_2026-07-27.md`; `docs/DO_CHINH_XAC_KICH_THUOC_FIXES_2026-08-04.md` |
| W6 | `docs/DIEU_HUONG_TAB_CONG_CU_FIXES_2026-07-28.md`; `docs/WORKSPACE_CONTEXT_FIXES_2026-07-27.md`; `docs/LUONG_MO_FILE_FIXES_2026-08-02.md` |
| W7 | `docs/BAO_CAO_AUDIT_HIEU_NANG_VA_THAN_THIEN_PHAN_CUNG_2026-08-05.md`; `docs/PERF_FIXES_2026-08-05.md`; `docs/PERF_FIXES_2026-07-26.md`; `docs/KIEN_TRUC_FIXES_2026-07-29.md`; `docs/BAO_CAO_AUDIT_TOC_DO_BINH_TRANG_2026-07-29.md`; `docs/BINH_TRANG_PERF_FIXES_2026-07-29.md`; `docs/BAO_CAO_AUDIT_XEM_TRUOC_BAN_IN_PREFLIGHT_2026-08-10.md`; `docs/BAO_CAO_AUDIT_PHAM_VI_ANH_HUONG_PPE_2026-08-10.md`; `docs/BAO_CAO_AUDIT_IN_THEO_PHAM_VI_TRANG_2026-08-11.md`; `docs/IN_THEO_PHAM_VI_TRANG_FIXES_2026-08-11.md` |
| W8 | `audit-rules.md` §12/§14.7/§15; `docs/BUILD_RELEASE_FIXES_2026-08-03.md`; `docs/BAO_CAO_AUDIT_SAN_SANG_BUILD_RELEASE_2026-08-03.md`; `docs/BAO_CAO_AUDIT_DON_SACH_GHOSTSCRIPT_2026-08-08.md`; `docs/FREE_PRO_FIXES_2026-08-04.md`; `docs/BAO_MAT_FIXES_2026-07-30.md` |

`docs/audit/AUDIT_REPORT.md` là bằng chứng lịch sử từ 2026-06-19. Chỉ dùng để tìm corpus/luồng cũ; không dùng riêng nó để nâng trạng thái hiện tại.

## 4. Hàng đợi audit unit

| Thứ tự | Mã | Luồng cần chốt | Bất biến/artifact phải kiểm | Hiện trạng |
|---:|---|---|---|---|
| 1 | `W1-U01` | Mọi reader/writer đọc PDF page boxes | mm ↔ pt không mất số lẻ; rotate; Media/Crop/Trim/Bleed; reopen cùng kích thước | `AUTO`; các nhánh Crop/N-Up đạt `ARTIFACT`, PB1–PB6 đã sửa, chờ runtime Viewer/app |
| 2 | `W2-U01` | N-Up từ form đến PDF mở lại | preview plan = placement thật; marks/bleed/cut-border đúng page box | `AUTO`; PA1/PA2 đã sửa, chờ corpus artifact/runtime chung |
| 3 | `W2-U02` | Booklet/Step Repeat/Sticker/CNC | page order, duplex, creep, rotation, marks và report khớp artifact | `TRACED` một phần; nhánh `W2-U02-OC` đạt `ARTIFACT`, §OC.1–§OC.3 đã sửa/verify, chờ runtime; Booklet/Step Repeat chưa phủ |
| 3a | `W2-U03` | Bù xén → đường cắt theo biên trong suốt/ảnh nền trắng | bám Alpha; lùi 0,15 mm; topology/lỗ; node/mm; Hausdorff; path CutContour | `ARTIFACT` cho topology/noodle; §NOODLE.12–15 đã sửa: 111/111 artifact, 154 test liên quan, backend full 2.420 pass/21 skip. Chất lượng chuyển động máy bế được tách sang `W2-U05`, không suy từ tổng node. |
| 3b | `W2-U04` | Ảnh AI nhiều tem → sửa mask → PDF từng tem | preview không đổi màu; pan/edit tách biệt; scale mm; góc lõm; CutContour; tái dùng ảnh đang mở | `ARTIFACT`; Lô A 2026-08-10 đã đóng §CUTSMOOTH.1, giảm rủi ro §CUTSMOOTH.2 và trả quality metadata thật: sharp-shape 300 DPI không còn short segment, `detail=0` lỗi sẽ fail-closed. Semantics slider/UI §CUTSMOOTH.3–7 vẫn chờ Lô B/C. |
| 3c | `W2-U05` | Bù xén → đường chạy CutContour freeform an toàn cho máy bế | reference bất biến; tangent/curvature continuity; minimum command length; normal error; không polyline fallback; fail-safe khi nguồn không đủ | `TRACED`; metric/oracle đã có nhưng follow-up artifact 2026-08-10 chứng minh live `safe-fallback` chưa đi qua final oracle: sao 300 DPI có 3 đoạn <0,25 mm/15 join >1°, khe lõm có 6/17; chưa được nâng `AUTO`. |
| 3d | `W2-U06` | Mọi mode bình trang khi số mẫu/trang vượt sức chứa một tờ | mọi tờ mẫu khác nhau có placements trong preview và artifact; `runCount` chỉ đại diện bản lặp; không mẫu nào rơi im lặng | `ARTIFACT + AUTO`: `§MSHEET.1` đã sửa; CNC helper/API/artifact một-hai mặt phủ đủ tờ, ca thiếu mẫu fail-closed. N-Up/Sticker/Mixed/cluster/Booklet không có lỗi cùng pattern trong ca đại diện; 116 backend + 8 frontend test và typecheck đạt. |
| 3e | `W2-U07` | Bế → chọn CorelDRAW/Illustrator → mở PDF khuôn | lựa chọn thủ công thắng fallback tự dò; UI = localStorage = payload native; app nhận đúng PDF; hai app độc lập | `AUTO`: `§OPENAPP.1–2` đã sửa; regression phủ Illustrator/CorelDRAW, persistence, fallback và cancel; modal 9/9, modal + OCG 29/29, typecheck pass. Còn runtime Tauri/app thiết kế thật và quyết định `§OPENAPP.S1`. |
| 3f | `W2-U08` | Bình trang S&R: preview số bài/tờ → job backend → PDF mở lại | working PDF/PageBox, khổ tờ, lề, bleed, gap, `splitGap`, solver version và capacity phải cùng fingerprint; artifact đếm placement khớp preview | `ARTIFACT + AUTO-DIAG`: `splitGap=0 → 17/17`, `2 mm → 16/16`; đã thêm `traceId/requestId/jobId` xuyên preview→job→solver→placement→render, log số placement thật và test chống chèn log. `§SRPARITY.1` còn mở phần fingerprint/fail-closed; cần tái hiện app thật để khóa nguyên nhân ảnh user. |
| 4 | `W3-U01` | Resize + Crop | transparency, content transform, box policy, số lẻ mm, mixed pages | `STALE` |
| 5 | `W3-U02` | Combine + Split + Convert | order, page boxes, metadata, encrypted/error/cancel và reopen | `TRACED` một phần |
| 5a | `W3-U03` | Ảnh logo raster → preview SVG → artifact lưu lại | mode/palette/alpha; compound counter; path/node QC; RAM/cancel; DPI→mm; active-tab/drop; dirty-session; dev/release; VI/EN; SVG thật render lại | `ARTIFACT` cho synthetic ring + `AUTO` backend/frontend/native. §LR3.01–§LR3.13 đã sửa và verify tự động qua Lô A–E; production vẫn HOLD. Còn `RUNTIME` Tauri/release, JPEG holdout có vector gốc và mở SVG 1:1 trong ít nhất hai phần mềm chế bản. Báo cáo `BAO_CAO_AUDIT_LOGO_REBUILD_2026-08-09.md`, log `LOGO_REBUILD_FIXES_2026-08-09.md`. |
| 5b | `W3-U04` | Ảnh → Upscale → companion PDF → Viewer/PPE → Bù xén/Tạo đường cắt | pixel ×2/×4; DPI và kích thước vật lý; ICC/alpha; owner theo tab/Undo; capability path; cancel; lease; native/fallback/release parity | `ARTIFACT + AUTO + RUNTIME-PARTIAL`: §UP.X.01/02/06/07/09 và §UP.R.01 đã sửa, test frontend/backend/Rust/build-contract đạt. File khách Balanced ×4 qua route thật đạt `8000×8000 @ 288,0106 DPI`, MediaBox `1999,9264 pt`; PPE 96 DPI `2667×2667`, không degraded/unsound/recovery; claim/release xóa artifact. Còn Tauri UI nhiều tab/picker/native drop/Undo, Poppler, corpus đầy đủ và installed release. Báo cáo `BAO_CAO_RE_AUDIT_UPSCALE_CROSS_TOOL_2026-08-11.md`, log `UPSCALE_CROSS_TOOL_FIXES_2026-08-11.md`. |
| 6 | `W4-U01` | Data Merge | schema CSV/XLSX/Google, Unicode, multipage, barcode, preview/output | `STALE` |
| 7 | `W4-U02` | Numbering + Cover Numbering | coordinate/rotate/page selection/font và output text/vector | `STALE` |
| 8 | `W6-U01` | Multi-tab native event | event có tab/session owner; tab nền/đã đóng không nhận file | `STALE` |
| 9 | `W7-U01` | PDFium trong thread | mọi callable reachable có guard đúng chỗ hoặc đi ProcessPool | `TRACED` một phần; scanner 0 hit cùng-file nhưng inventory wrapper/cross-file chưa khép |
| 10 | `W7-U02` | RAM/worker benchmark | máy mạnh không bị hard-cap; máy yếu giảm an toàn; RSS/P95/cancel | `AUTO + BENCH (32 GB)`: N-Up/Sticker/VDP/scheduler/warm-up đạt policy; PPE Lô B đo 5 mẫu cho ba policy, high-tier production peak RSS `851,961 MiB`, P95 slowdown tối đa `10,4%`, session cancel drain P95 `56,027 ms`. Lô B2 áp low budget động `256–640 MiB`; hai lượt production giữ artifact/cleanup, slowdown bảo thủ tối đa `17,1%`. Low/medium chưa có máy vật lý. |
| 10a | `W7-U03` | PDF Viewer CMYK/gradient fidelity | raw renderer = transport; DeviceCMYK/DeviceN/transparency/OutputIntent; parity full-page/tile | `ARTIFACT + RUNTIME-PARTIAL`; detector + runtime identity + PNG pixel-equal + accurate route/định tuyến đã có test; đúng PDF khách đạt PPE→Acrobat MAE 4,6632. Pixel compositor current-source đã hiện ổn định khi mở cold/warm, nhưng chưa lặp Acrobat parity theo timeline/runtime. |
| 10b | `W7-U04` | PrynX Render Engine: first-page, zoom/pan, cancel, process, cache và accurate viewport | first pixel không chờ metadata thừa; trang rủi ro không phát frame display sai màu; zoom-out không bỏ bitmap đã nét; interactive không bị stale/prefetch chặn; rotate/tile parity; soundness; RAM tier; installed artifact | `RUNTIME-PARTIAL (Tauri dev)`: pixel gate hai frame đo cold first-visible/sharp `4175/4670 ms`, warm `3971/4402 ms`, cùng signature `5aee9a8d`, `0` HTTP/console error. Các số lăn/zoom/pan/xoay cũ bị hạ `STALE` vì harness trước chưa kiểm compositor đúng; cần chạy lại sau native rebuild. Provenance + shadow gate đạt `AUTO`, nhưng không có log corpus thật và không promote `hybrid`. Frontend tập trung `148`, backend `182`; `§RENDER.1–10`, `§RENDER.F1`, `§ZOOM.F2` có bản sửa. Chưa P50/P95 sạch, installed smoke hoặc ba tier RAM; `§RENDER.11` còn mở. |
| 10c | `W7-U05` | Preflight “Xem trước bản in” → separations → composite/metadata/parity UI Acrobat | không reload/flash; spot lấy tint alternate; một state Simulation; overprint đúng nghĩa; inventory document/page; transparency/blend; workflow UI có thứ tự rõ | `AUTO + ARTIFACT`: contract profile/intent, 9 Show, 2 Preview, PageBox, ICC subset/solo, Overprint, sampling/TAC, inventory, Paper/Black/Background có regression tương ứng; Show filter hiện đã dùng cùng filtered planes cho sampling/TAC/subset. Smoke `42/42` cũ bị hạ `STALE` vì Background gate sai và chạy trước semantic fix. Full runtime current-source chưa chạy do binding native chưa rebuild; installed/clean-user và Acrobat parity rộng còn mở. |
| 10d | `W7-U06` | PPE core → mọi consumer ngoài Viewer/Output Preview | Export CMYK; flatten; PDF/X-1a có transparency; Outline Fonts + hậu kiểm kẽm; fallback nhận diện khuôn; default isolation; shared DLL; CPU/RAM đồng thời | `ARTIFACT + AUTO + BENCH (32 GB)`: detect-shape, Export, Outline, default isolation và release ABI/provenance gate đã khóa; manifest tương lai sẽ map source revision/build identity/SHA-256 `.pyd`. Flatten/PDF-X mixed-page chỉ raster trang có transparency. File-action nay cancel cooperative, worker dừng trước `CancelledError`, ghi `.pending` rồi hậu kiểm/atomic replace và dọn output/intermediate khi cancel/fail. Lô B/B2 giữ high-tier không hard-cap, low-tier tự co `256–640 MiB`; còn máy low/medium vật lý, runtime UI và installed smoke. |
| 10e | `W7-U07` | Workspace/ô danh sách trang → preview → native print → PDF/GDI | `27-28,30-33` chỉ in 6 trang đúng nội dung; current/selected theo đúng tab và PDF sau bake; preview = payload = artifact; fallback không nới range | `AUTO`: `§PRINTRANGE.1–4` đã sửa; targeted frontend 23/23, typecheck, Rust helper 7/7 và cargo check đạt. Full frontend chỉ có một timeout contention ngoài phạm vi, chạy riêng 1/1 đạt. Còn Tauri runtime, Microsoft Print to PDF artifact/fingerprint và máy in vật lý. |
| 11 | `W5-U01` | Dieline catalog end-to-end | CUT kín, CREASE đúng, BLEED, export, fold 0–100%, parity sidecar | `AUTO` |
| 12 | `W8-U01` | Entitlement + installed artifact | catalog/gate/backend cùng nguồn; Free/Pro key thật; clean-user fail-closed | `STALE` |
| 12a | `W8-U02` | Dọn Ghostscript khỏi runtime contract, setup và payload | 0 production caller; không còn `use_gs`; build không tạo thư mục/binary GS; verifier luôn fail nếu GS tái xuất hiện | `AUTO`: source/runtime/policy đã dọn; backend 2.533 ca đạt và 2 test stale được sửa rồi đạt; frontend typecheck + 37 test; Rust 74 integration test. `ARTIFACT` vẫn chờ build từ source hiện tại. |

Thứ tự trên là thứ tự điều tra, không phải severity. Có thể đổi khi xuất hiện lỗi người dùng mới hoặc finding P0/P1 đã xác nhận.

## 5. Baseline máy quét hợp đồng

Lệnh tái hiện trên cây mã hiện tại:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/audit_contracts.ps1 -SelfTest
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/audit_contracts.ps1 -IncludeUntracked -Format Json -OutputPath audit-contracts-baseline.tmp.json
```

Kết quả ngày 2026-08-04, HEAD `1fb8519`:

| Chỉ số | Giá trị |
|---|---:|
| File tracked/live được liệt kê trong scope | 1.265 |
| File đã quét | 1.157 |
| File loại theo vendor/generated/extension | 108 |
| Tracked file thiếu trên đĩa | 1 |
| Lỗi đọc file | 0 |
| Tổng ứng viên `[SUSPECTED]` | 879 |

| Rule | Số ứng viên |
|---|---:|
| `UNIT_INTEGER_ROUNDING` | 89 |
| `MAGIC_UNIT_CONVERSION` | 95 |
| `SWALLOWED_ERROR` | 516 |
| `STATIC_OR_TEST_SUPPRESSION` | 108 |
| `PDFIUM_THREAD_WITHOUT_GUARD` | 0 |
| `RESOURCE_CAP_WITHOUT_RAM_SIGNAL` | 3 |
| `SCATTERED_FEATURE_GATE` | 15 |
| `RELEASE_ONLY_BRANCH` | 53 |

Giới hạn diễn giải:

- 879 là **ứng viên**, không phải 879 bug. Đặc biệt `SWALLOWED_ERROR` gồm nhiều cleanup/fallback/cancel có thể là chủ đích.
- `PDFIUM_THREAD_WITHOUT_GUARD = 0` chỉ nói scanner không thấy callable **cùng file** vi phạm mẫu hiện hỗ trợ; nó chưa resolve wrapper xuyên file/decorator/handle truyền gián tiếp.
- Số lượng thay đổi khi source hoặc rule thay đổi. Không dùng baseline này làm ngưỡng release nếu chưa triage và duyệt riêng.
- Báo cáo JSON tạm không lưu vào repo; chạy lại cho từng wave và chỉ lưu Markdown khi phục vụ một báo cáo audit cụ thể.

## 6. Mẫu thẻ audit unit

Sao chép khối này vào báo cáo audit của wave:

```text
Mã / tên luồng:
Hành động người dùng → kết quả quan sát được:
Entry:
State/schema/transport:
Handler/route:
Engine TS/Python/Rust:
Writer:
Artifact thật:
Consumer/reopen:
Hợp đồng field/default/enum:
Đơn vị / hệ tọa độ / page box / rounding:
Gate entitlement:
Ma trận ca biên:
Test tự động:
Kiểm artifact:
Kiểm runtime:
Trạng thái + ngày + commit:
Khoảng trống / bước tiếp:
```

Nếu thiếu entry/reachability hoặc artifact/consumer thì không được nâng trạng thái bằng suy đoán.

## 7. Khi nào phải đánh dấu `STALE`

| Vùng thay đổi | Wave tối thiểu cần xem lại |
|---|---|
| `desktop/src/components`, store, `api.ts`, process handler | W1–W6 và wave nghiệp vụ tương ứng |
| `backend/app/api`, schemas, workers, writer | W1–W4, W7 và W8 nếu có gate |
| `native`, `imposition_core`, `print_engine` | W1, W2, W5, W7 |
| `desktop/src/lib/dieline`, `mockup3d`, sidecar bundle | W5 |
| feature catalog, entitlement, auth/license | W4, W6, W8 và mọi luồng bị gate |
| `build_production.ps1`, Tauri/Nuitka/maturin config, release script | W8 |
| Dependency PDF/PDFium/render | Mọi wave tạo/đọc artifact PDF |

Không đánh stale toàn bộ repo theo phản xạ. Chỉ đánh các audit unit có đường trace đi qua vùng đã đổi và ghi lý do.

## 8. Nhịp audit và chốt duyệt

1. Chọn 1–3 audit unit có cùng artifact/hợp đồng.
2. Lập baseline và trace dọc; scanner chỉ bổ sung `[SUSPECTED]`.
3. Xác minh finding, viết `docs/BAO_CAO_AUDIT_<CHUDE>_<YYYY-MM-DD>.md`.
4. **Dừng chờ user duyệt.**
5. Sửa theo lô tối đa 5 file, verify hẹp và artifact/runtime sau mỗi lô.
6. Cập nhật trạng thái, nguồn bằng chứng và ngày/commit trong ma trận này.

Không build/publish GitHub chỉ để nâng W8. Internal build/installed smoke là một audit unit riêng và chỉ chạy khi user duyệt đúng phạm vi.

## 9. Nhật ký cập nhật ma trận

| Ngày | Thay đổi | Bằng chứng |
|---|---|---|
| 2026-08-04 | Khởi tạo 8 wave, thang bằng chứng, hàng đợi audit unit và baseline scanner. | Tài liệu audit/fixes hiện có + scanner self-test 17 ca + baseline 1.157 file/0 lỗi đọc. |
| 2026-08-04 | Audit W1/W2 trên baseline `1bf8621`; xác nhận PB1, PB2 và PA1; giữ PB3/PA2 ở mức nghi vấn. | Hai báo cáo W1/W2 + harness PageBox/UserUnit + test production `computeSpreadGrid`. |
| 2026-08-04 | Sửa `§W1.PB1`; ánh xạ crop rotate-aware và giữ kích thước theo hướng hiển thị. | `docs/PAGE_BOX_FIXES_2026-08-04.md`; 32 test frontend + 28 test backend + artifact raster bốn góc. |
| 2026-08-04 | Review PB1 xác nhận thêm `§W1.PB4` range/all sai vùng với mixed rotation; giữ PB5 ở mức nghi vấn. | Artifact hai trang 0°/90° có marker bốn màu; phụ lục báo cáo W1. |
| 2026-08-04 | Xác nhận và sửa PB2–PB6, gồm working PDF strict, canonical page space và `/UserUnit` xuyên backend/Viewer native; khép cache cùng path, peak RAM/parser và metadata >2.000 trang. | `PAGE_BOX_FIXES_2026-08-04.md`; frontend full 1.857 test + typecheck + lint budget; backend full 2.238 test; Rust 56 test + cargo check locked. |
| 2026-08-04 | Sửa PA1/PA2; preview Booklet nhận đủ lề dưới và mọi page edit fail-closed nếu không materialize được. | `PREVIEW_ARTIFACT_FIXES_2026-08-04.md`; fault-injection + Mixed page-count guard. |
| 2026-08-04 | Audit artifact đường cắt theo Alpha; xác nhận polyline 146–1.408 node/trang, tolerance 0,02 mm thấp hơn pixel 300 DPI và test thiếu oracle độ mượt. | `BAO_CAO_AUDIT_DUONG_CAT_ALPHA_2026-08-04.md`; parse PDF 72 trang + probe tolerance/Hausdorff/min-gap + 2 test baseline xanh. |
| 2026-08-04 | Sửa §ALPHA.1–3: lọc raster theo mm, fitted Bézier hai chiến lược có guard và fallback fail-safe; giữ §ALPHA.4 chờ smoke/quyết định sản phẩm. | `DUONG_CAT_ALPHA_FIXES_2026-08-04.md`; 89 test; artifact vòng hai 62/72 trang fitted, 72/72 trang Bézier, median 308 → 144,5 segment, box delta 0 pt, 36,52 s tuần tự. |
| 2026-08-05 | Sửa hồi quy hiệu năng Alpha §ALPHA.P1: bỏ hard-cap theo MB/số trang trên máy mạnh, CPU-1 worker, reduced-pool retry và guard Hausdorff bằng buffer hai chiều. | `DUONG_CAT_ALPHA_FIXES_2026-08-04.md`; 112 test; app baseline 86,257 s/1 worker, production auto benchmark 12,005 s/15 worker; CutContour parity 72/72, box delta 0 pt. |
| 2026-08-05 | Audit `W2-U02-OC` từ UI → payload → Sticker/Page Sheet/CNC writer → PDF mở lại; xác nhận §OC.1–§OC.3 và chưa sửa trước khi duyệt. | `BAO_CAO_AUDIT_OC_VA_DAT_TEN_OC_2026-08-05.md`; 78 test hiện có xanh; artifact 3 shape Sticker, separate cut, Unicode, CNC 1/2 mặt và input biên. |
| 2026-08-05 | Sửa §OC.1–§OC.3: PontConfig validation xuyên tầng, CNC giữ Graphtec/layer/group/item, payload CNC bỏ toggle Sticker và khóa Front + Cut. | `OC_VA_DAT_TEN_OC_FIXES_2026-08-05.md`; backend full 2.302 pass/4 skip + target final 20 pass; frontend 1.893 pass/2 skip; typecheck + lint budget + artifact CNC ba shape đạt. |
| 2026-08-05 | Audit lại W7 về startup, worker/RAM, UI/cache, disk và release artifact; xác nhận 6 P1 + 3 P2, chưa sửa trước chốt duyệt. | `BAO_CAO_AUDIT_HIEU_NANG_VA_THAN_THIEN_PHAN_CUNG_2026-08-05.md`; startup log release, artifact rc.3, scanner 1.188 file, backend 37 test, frontend 40 test + production build. |
| 2026-08-06 | Hoàn tất sửa W7 Lô 1–11; đóng §PERF.8 bằng benchmark/parity PPE và §PERF.9 bằng runtime minimize/restore. | `PERF_FIXES_2026-08-05.md`; frontend 1.926 pass/2 skip; print_engine 348 + 218 test; native/Python PPE 117 test; runtime minimize 0 ms CPU/5 giây. |
| 2026-08-07 | Audit đường cắt từ JPEG nền trắng cỡ lớn trên đúng file khách; xác nhận nhiễu >1 mm² tạo MultiPolygon, cấu hình mặc định vô hiệu auto và một component rác làm bỏ qua dựng hình. | `BAO_CAO_AUDIT_DUONG_CAT_ANH_LON_2026-08-07.md`; artifact 805 mm trước/sau, parse 7–12 CutContour, 123 test hiện có xanh nhưng thiếu oracle E2E ảnh thật. |
| 2026-08-07 | Đóng §NOODLE.1–15 sau audit topology mở rộng; fallback theo pixel nguồn, profile mực đậm end-to-end và giữ interior ring khi tắt lấp lỗ. | `DUONG_CAT_ANH_LON_FIXES_2026-08-07.md`; 111/111 artifact, 154 test liên quan, backend full 2.420 pass/21 skip; Poppler toàn hình + zoom 150 DPI. |
| 2026-08-07 | Audit `W2-U05` từ UI → freeform fitter → content stream `/CutContour`; tách “ít node” khỏi continuity/short-command và xác nhận §MOTION.1–6. | `BAO_CAO_AUDIT_DUONG_BE_FREEFORM_MAY_CAT_2026-08-07.md`; file khách auto-circle smooth, force-contour gãy 5,45°; hoa trơn có 16 join >10°; hourglass có 16 đoạn <0,25 mm; 22 test baseline pass nhưng thiếu motion oracle. |
| 2026-08-07 | Hoàn tất `W2-U05` Lô A: thêm metric/oracle line/cubic theo mm, không hard-cap và chưa đổi output engine. | `DUONG_BE_FREEFORM_MAY_CAT_FIXES_2026-08-07.md`; 23 test pass; 12.000 segment đo trong 0,0827 s; trạng thái vẫn `TRACED` tới khi tích hợp production. |
| 2026-08-07 | Audit `W7-U03` trên PDF Illustrator CMYK/DeviceN + transparency không có OutputIntent; tách raw PDFium, JPEG q90 và render color-managed. | `BAO_CAO_AUDIT_HIEN_THI_GRADIENT_VA_MAU_VIEWER_2026-08-07.md`; SHA-256 `95F38C…8184`; PDFium→Acrobat MAE 20,342, FOGRA39→sRGB 4,547, PPE 4,663; chờ duyệt sửa theo lô. |
| 2026-08-07 | Sửa `W7-U03`: detector màu, runtime identity, PNG lossless, accurate PPE/FOGRA39 tự bật theo trang, cache tách mode và cách ly asset sRGB gắn nhãn sai. | `HIENTHI_MAU_VIEWER_FIXES_2026-08-07.md`; Rust 86 pass/1 ignored; backend 121 pass/1 skip; frontend target 30 pass + typecheck; artifact khách MAE 4,6632; chờ smoke Tauri. |
| 2026-08-08 | Thêm `W7-U04` audit Render Engine từ mở file qua PDFium/PPE/cache tới installer; xác nhận 11 finding và bác bỏ nghi vấn print giữ khóa Viewer vì print đã out-of-process. | `BAO_CAO_AUDIT_PRYNX_RENDER_ENGINE_2026-08-08.md`; scanner 1.225 file/0 lỗi đọc; 46 frontend + 17 backend + 86 Rust; hai harness soundness/cancel. |
| 2026-08-08 | Thêm `W8-U02`: phân loại Ghostscript thành caller legacy, hợp đồng/API, build/setup, tripwire và công cụ đối chứng; xác nhận runtime 0 lần gọi GS nhưng source/payload marker chưa sạch. | `BAO_CAO_AUDIT_DON_SACH_GHOSTSCRIPT_2026-08-08.md`; 24 no-GS + 38 routing/policy test pass; 4 test stale bị skip; rc.4 không có binary GS. |
| 2026-08-08 | Hoàn tất sửa `W8-U02`: xóa caller Sticker cuối, config/discovery/telemetry/attic, hợp đồng API legacy, marker/payload và setup; giữ verifier, tripwire, hồ sơ pháp lý và golden dev có chủ đích. | `GHOSTSCRIPT_CLEANUP_FIXES_2026-08-08.md`; production caller scan 0 hit; policy/corpus 62 pass; backend 2.533 pass + 2 stale test đã sửa và rerun 3 pass; frontend typecheck + 37 pass; Rust check + 74 pass. |
| 2026-08-09 | Hoàn tất các lô code `W7-U04` tới PPE viewport/latest-only và hardening ownership/cache/profile; chưa đóng cổng UI/installer. | `PRYNX_RENDER_ENGINE_FIXES_2026-08-08.md`; frontend `94`, backend `91`, `print_engine` `575`, native check + maturin đạt; API artifact PDF khách đúng clip; viewport engine median nhanh hơn `25,8%`. |
| 2026-08-09 | Hotfix `§RENDER.F1` sau feedback ảnh đầu sai gradient/màu: bootstrap nhận diện màu trước mount, risky page accurate-only, unmount ảnh display cũ và khóa regression cold-open/cache-hit. | `PRYNX_RENDER_ENGINE_FIXES_2026-08-08.md`; frontend `98/98`, Rust check đạt; probe display worker trên PDF khách trả `colorRisk` trong 45 ms, 4/4 trang high-risk. |
| 2026-08-09 | Hotfix `§ZOOM.F2` sau feedback chữ mất nét khi giảm zoom: giữ bitmap viewport đã decode, chuẩn hóa identity theo DPI bucket và loại chuyển accurate viewport→full-page tại ngưỡng tiling. | `PRYNX_RENDER_ENGINE_FIXES_2026-08-08.md`; baseline `6,33→6,32` từng tạo full-page gần 28 MP, `8,0→7,9` từng bỏ tile dù cùng 768 DPI; frontend typecheck + `106/106` test đạt. |
| 2026-08-10 | Audit dọc bốn điều khiển CutContour live; xác nhận wiring/parity đúng nhưng §CUTSMOOTH.1–8 còn mở, gồm fallback bỏ qua motion oracle, `detail=0` nguy hiểm, vùng chết fidelity, tension yếu và UI ẩn reference. | `BAO_CAO_AUDIT_DIEU_KHIEN_LAM_MUOT_DUONG_BE_2026-08-10.md`; đúng ảnh 9 tem + 8 shape tại 72/300 DPI; parse 4 PDF thật; 10 test baseline pass nhưng thiếu regression tương ứng. |
| 2026-08-10 | Triển khai Lô A CutContour: final oracle sau mọi path, phân loại góc thật, fail-closed, metadata quality và cấm export tự refit khi thiếu override. | Sao 300 DPI: 10 cubic, min 17,542 mm; notch: 11 cubic, min 4,951 mm; ảnh khách mặc định giữ 915 cubic. Verify 15 + 76 + 129 test pass. |
| 2026-08-10 | Audit `W7-U05` Preflight Output Preview trên đúng PDF khách và hai screenshot PrynX/Acrobat; xác nhận full-page overlay swap, CSS multiply, màu spot MD5, profile FOGRA hard-code, metadata/inventory rơi khỏi contract. | `BAO_CAO_AUDIT_XEM_TRUOC_BAN_IN_PREFLIGHT_2026-08-10.md`; probe PPE 150 DPI; MAE CSS→Acrobat `12,856`, PPE+SWOP→Acrobat `2,485`; 68 backend + 10 frontend test baseline pass. |
| 2026-08-10 | Tái audit `W7-U05` sau khi người dùng xác nhận cold-open không còn reload; đối chiếu từng điều khiển trong ảnh Acrobat/PrynX và probe lại contract hiện tại. | Báo cáo W7-U05 phụ lục parity: SWOP `available=true`; trang 1 có 6 plate, trang 3 mới có `khuon be`; 4/4 trang khai Transparency/DeviceCMYK; PPE response thiếu metadata/coverage; Ink Manager chỉ trả C/M/Y/K. Xác nhận §OP.8–§OP.11 và kế hoạch Lô A–E. |
| 2026-08-10 | Triển khai Lô B `W7-U05`: đồng bộ intent qua Separations/ICC; đưa profile/intent vào WorkspaceContext theo tab; nối Viewer native fast path và accurate backend động; tách cache/generation theo Simulation; giữ bitmap hiện tại khi mở Output Preview chờ PPE. | `XEM_TRUOC_BAN_IN_PREFLIGHT_FIXES_2026-08-10.md`; backend `161 passed`, frontend liên quan `63 passed`, probe PDF khách SWOP + Perceptual trả PPE/3 spot/Transparency/DeviceCMYK; full frontend còn 4 failure ngoài phạm vi. Runtime Tauri còn chờ. |
| 2026-08-10 | Triển khai Lô C `W7-U05`: dùng composite PPE Overprint lossless làm ảnh chính; tách diff thành chẩn đoán; đọc Overprint từ `gs` được dùng thật và Form XObject; đồng bộ Simulation, latest-only và cleanup overlay. | `XEM_TRUOC_BAN_IN_PREFLIGHT_FIXES_2026-08-10.md`; backend tập trung `45 passed`, frontend tập trung `39 passed`, typecheck và diff check đạt; PDF khách trang 1 không dùng Overprint, fixture dương tính spot/Form đạt. Runtime Tauri còn chờ. |
| 2026-08-10 | Triển khai Lô D `W7-U05`: sắp panel theo workflow Acrobat; group Process/Spot; tách hành động sửa file; đăng ký route Ink Manager và thêm shortcut có guard tới Ink Manager/Set Page Boxes. | `XEM_TRUOC_BAN_IN_PREFLIGHT_FIXES_2026-08-10.md`; typecheck đạt, regression rộng 15 file `99 passed`; toàn frontend `2.161 passed, 2 skipped`, 3 failure StickerCutline ngoài phạm vi; diff/whitespace check đạt. §OP.11 đạt `AUTO`; runtime Tauri và inventory Ink Manager trên PDF khách còn chờ. |
| 2026-08-10 | Triển khai Lô E1 `W7-U05`: thay listener hover không có producer bằng store đúng tab; thêm point/average theo mm, DPI artifact và sửa chuẩn hóa tọa độ trang xoay. | Backend ICC/Separations `25 passed`; frontend sampling/Viewer/DOM/i18n `36 passed`; typecheck đạt. Sample Size đạt `AUTO`; runtime Tauri còn chờ. |
| 2026-08-10 | Triển khai Lô E2 `W7-U05`: thêm Warning Opacity theo tab; Gamut/TAC và diff Overprint dùng cùng opacity, trong khi composite Overprint và Soft-Proof luôn giữ 100%. | Typecheck đạt; regression Output Preview/Viewer/store/i18n `12 file / 57 passed`. Warning Opacity đạt `AUTO`; runtime Tauri còn chờ. |
| 2026-08-10 | Triển khai Lô E3 `W7-U05`: đọc PageBox thật theo trang nguồn; vẽ Art/Trim/Bleed đúng CropBox, `/Rotate`, frame và cờ khai báo; giữ Set Page Boxes là hành động riêng. | Probe PDF khách 4 trang đạt; backend PageBox/API `84 passed`; frontend geometry/store/DOM/Viewer/i18n `14 file / 78 passed`; typecheck đạt. Show/Preview filter deferred vì chưa có contract thật; runtime Tauri còn chờ. |
| 2026-08-10 | Sửa `§OP.12` và audit E4 `W7-U05`: thêm page identity riêng cho bitmap mô phỏng; trace Paper Color/Black Ink/Background Color tới PPE/ICC và không dựng toggle khi contract chưa tồn tại. | Typecheck + frontend rộng `14 file / 79 passed`; probe PDF khách Relative↔Absolute MAE `7,4115`, `105.094` pixel đổi, max `25`. E4 `TRACED + ARTIFACT · DEFERRED`; runtime Tauri còn chờ. |
| 2026-08-10 | Triển khai Lô F `W7-U05`: ghép tập kẽm từ plane u8 + LUT spot qua ICC, endpoint PNG nhị phân và frontend latest-only; bỏ consumer CSS multiply ở subset/solo. | PDF khách SWOP 150 DPI: `92,7–103,8 ms`/composite, endpoint `114,4 ms`, nhanh hơn raster Soft-Proof `895,4 ms`; all-on parity MAE `0,214767`, max `5`. `31` lõi mực + `85` backend + `65` frontend đạt; typecheck/cargo check đạt. `§OP.1 = AUTO + ARTIFACT`, Tauri runtime còn chờ. |
| 2026-08-10 | Triển khai Lô G `W7-U05`: chín Show filter tại sink PPE; hai Preview mode; tách Paper Color/Black Ink khỏi intent nội dung; hòa Background Color theo phản xạ giấy/mực; truyền contract qua UI/cache/session/FastAPI/facade/PyO3. | Typecheck đạt; frontend tập trung `15 file / 148 passed`; backend tập trung `9 file / 182 passed`; PPE Rust `7` test Show + `2` test E4 đạt. Native cũ thiếu capability fail-loud. |
| 2026-08-10 | Nghiệm thu cũ `W7-U04/W7-U05` trên Tauri dev được tái phân loại sau re-audit harness. | **`STALE` cho acceptance:** `42/42` dùng Background signature sai thời điểm và nuốt timeout; số cold/warm `1.909/1.944 ms` vừa ghi sai cách đọc đơn vị vừa chụp trang trắng. Chỉ giữ các ảnh/log này làm lịch sử chẩn đoán, không dùng đóng cổng runtime. |
| 2026-08-10 | Sửa finding cleanup phát sinh từ smoke: file `/upload/local` giữ mtime nguồn cũ có thể bị sweep dù DB còn sở hữu. | `backend/app/core/cleanup.py`; `test_storage_pressure_cleanup.py` `8/8`; path đăng ký trong DB được loại trước sweep tuổi/áp lực đĩa. |
| 2026-08-10 | Audit `W7-U06` phạm vi ảnh hưởng PPE ngoài Viewer/Output Preview; xác nhận năm consumer trực tiếp (hai consumer nằm hẳn ngoài họ Preflight), bác bỏ rò default và tách ảnh hưởng thuật toán khỏi coupling DLL/tài nguyên. | `BAO_CAO_AUDIT_PHAM_VI_ANH_HUONG_PPE_2026-08-10.md`; Rust `641 pass/4 ignored`; backend mục tiêu `279 pass`; shared-native `85 pass`; artifact PDF khách Export CMYK/fallback shape; PDF/X-1a transparency `7/7`. Chưa build theo chỉ đạo. |
| 2026-08-10 | Triển khai Lô A `W7-U06`: khóa E2E detect-shape qua PPE, PDF/X-1a transparency thật, default isolation và ABI/capability của wheel staging. | Lô code/test 5 file + lô hồ sơ 2 file; verify hẹp `105 pass`, backend mục tiêu `297 pass`, shared-native `85 pass`; PowerShell parse đạt; native hiện hành được gate nhận, artifact cũ 09/08 bị từ chối. Không build theo chỉ đạo. |
| 2026-08-10 | Nghiệm thu Lô B `W7-U06`: benchmark chạy riêng/chồng Viewer+Export, Output Preview+flatten, Outline+detect và hai đường cancel; 1 warm-up + 5 mẫu trên ba policy RAM, thêm production DPI. | High-tier production P95 slowdown tối đa `10,4%`, peak RSS `851,961 MiB`; không thêm scheduler cap. Session cancel drain P95 `56,027 ms`. Xác nhận `§PPE.SCOPE.8` low budget 384 MiB chặn Export 300 DPI và `§PPE.SCOPE.9` file-action chưa cooperative cancel. Low/medium vẫn chờ máy vật lý; không build. |
| 2026-08-10 | Audit `W2-U06` bảo toàn nhiều tờ qua N-Up, Sticker, Mixed Guillotine, cluster, Page Sheet, Booklet và CNC; xác nhận chỉ CNC Dàn nhiều mẫu còn bỏ tờ/mẫu sau tờ đầu. | `BAO_CAO_AUDIT_BAO_TOAN_NHIEU_TO_BINH_TRANG_2026-08-10.md`; helper + API preview + artifact CNC 5 mẫu đều tái hiện `§MSHEET.1` P0; user đã duyệt lô sửa. |
| 2026-08-10 | Sửa `W2-U06 §MSHEET.1`: layout CNC trả mọi tờ mẫu, preview dùng `sheets[]`, renderer xuất từng Front/[Back]/Cut và fail-closed nếu còn mẫu bắt buộc chưa đặt. | Artifact 5 mẫu một mặt = 10 trang, 3 cặp hai mặt = 9 trang; 116 backend + 8 frontend test, typecheck và diff check đạt. Chưa runtime app với file khách có đường bế/boong thật. |
| 2026-08-10 | Triển khai Lô B2 `W7-U06 §PPE.SCOPE.8`: low-tier lấy 25% RAM khả dụng/heavy slot trong `256–640 MiB`, fallback 384 khi không biết RAM; medium/high không đổi. | Baseline đỏ đúng `4`, sau sửa test tập trung `24/24`, backend liên quan `268/268`; TIFF CMYK 300 DPI `3117×2338` có ICC. Hai benchmark production policy mới giữ checksum/source/cleanup, peak tối đa `849,691 MiB`, slowdown bảo thủ `17,1%`. Máy `<8 GB` vật lý và build vẫn chưa chạy. |
| 2026-08-10 | Re-audit runtime Lô 6 thay DOM-ready bằng pixel compositor gate hai frame và sửa mọi đơn vị về `ms`. | Cold first-visible/sharp `4175/4670 ms`, warm `3971/4402 ms`, cùng pixel signature `5aee9a8d`, `0` bad HTTP/console. Đây là `RUNTIME-PARTIAL` trên phiên dev đang có nhiều process; lăn/zoom/pan/xoay và Output Preview current-source vẫn chờ chạy lại sau native rebuild. |
| 2026-08-10 | Triển khai Lô 7 provenance + corpus rollout gate, giữ default Viewer `current`. | Capability nhúng revision/dirty/timestamp/profile/provenance/identity; build staging đối chiếu wheel và manifest map SHA-256 `.pyd`. Corpus schema 2 yêu cầu 5 cặp/trang @96 DPI, MAE `≤5`, PPE P95 `≤650 ms`, 0 unsupported/error và artifact ổn định. Reporter self-test, PowerShell gate probe, native cargo check đạt; log shadow thật/installed vẫn `OPEN`. |
| 2026-08-11 | Sửa re-audit `W3-U04` theo 5 lô: identity/close-tab, path capability, ICC fallback, cooperative cancel + lease và release behavior smoke. | `UPSCALE_CROSS_TOOL_FIXES_2026-08-11.md`; frontend 37 test, backend 59 test, typecheck/lint/cargo/build-contract đạt; file khách Balanced ×4 và PPE 96 DPI đạt artifact/runtime hẹp. Tauri UI và installed release còn mở. |
| 2026-08-11 | Audit `W2-U07` đường Bế → CorelDRAW/Illustrator; xác nhận lựa chọn `.exe` thủ công được lưu nhưng bị path tự dò lấn quyền ưu tiên ở UI và payload native. | `BAO_CAO_AUDIT_DUONG_DAN_COREL_ILLUSTRATOR_2026-08-11.md`; harness forward-regression đỏ đúng `appPath`, suite modal hiện hữu 4/4 pass; chưa sửa trước chốt duyệt. |
| 2026-08-11 | Sửa `W2-U07 §OPENAPP.1–2`: path thủ công ưu tiên trước fallback tự dò và suite khóa payload cuối cho cả hai app. | `DUONG_DAN_COREL_ILLUSTRATOR_FIXES_2026-08-11.md`; baseline 3 regression đỏ, sau sửa modal 9/9, modal + OCG 29/29, typecheck pass, ESLint 0 error. Runtime app thật còn chờ. |
| 2026-08-11 | Audit `W7-U07` từ trang đang xem/thumbnail chọn → hộp In → preview → TypeScript IPC → worker → Rust/GDI; xác nhận danh sách rời rạc và current/selection bị rơi khỏi contract. | `BAO_CAO_AUDIT_IN_THEO_PHAM_VI_TRANG_2026-08-11.md`; harness tạm 3/3 tái hiện, baseline frontend 10/10 pass; Rust bị khóa tài nguyên dev (`os error 32`); chưa sửa trước chốt duyệt. |
| 2026-08-11 | Sửa `W7-U07 §PRINTRANGE.1–4`: thêm parser danh sách trang, current/selection theo tab và explicit list xuyên TypeScript/Tauri/worker/Rust; validate trước StartDocW. | `IN_THEO_PHAM_VI_TRANG_FIXES_2026-08-11.md`; targeted frontend 23/23, typecheck, ESLint hẹp, Rust helper 7/7 và cargo check target độc lập đạt. Full frontend 1 timeout contention ngoài phạm vi, isolated 1/1 đạt; runtime artifact còn mở. |
| 2026-08-12 | Audit `W2-U08` ca S&R preview 16 nhưng PDF ảnh có 17; trace `splitGap` xuyên UI/API/engine/worker và tạo PDF artifact để đếm placement thật. | `BAO_CAO_AUDIT_PREVIEW_BINH_CAT_XEN_SR_2026-08-12.md`; engine hiện tại khớp `17/17` ở 0 mm và `16/16` ở 2/16 mm; backend 19 pass, frontend 4 pass. Xác nhận `§SRPARITY.1` thiếu fingerprint/fail-closed; chờ duyệt, chưa sửa production. |
| 2026-08-12 | Sửa chẩn đoán `W2-U08 §SRPARITY.1`: thêm mã đối chiếu theo tab/request/job và log hình học + capacity/placement thật xuyên preview→PDF, không đổi solver. | `PREVIEW_BINH_CAT_XEN_SR_FIXES_2026-08-12.md`; backend 22/22, frontend 35/35, typecheck/py_compile/diff-check đạt; runtime harness log `17` ở 0 mm và `16` ở 2 mm. |
