# PrynX Master Audit Matrix

> Cập nhật: 2026-08-06 · branch `codex/pre-release-audit-2026-08-04` · W7 đã sửa và verify 9/9 finding hiệu năng theo Lô 1–11; còn benchmark vật lý 8/16/32 GB và đóng gói sidecar PPE mới.

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
| **W2 — Preview ↔ PDF xuất của bình bản** | `AUTO` | PA1 truyền đủ `marginBottom`; PA2 working PDF và Mixed Guillotine fail-closed; preview/working-PDF regression đạt. Nhánh bù xén Alpha đạt `ARTIFACT`. Nhánh `W2-U02-OC` đã sửa §OC.1–§OC.3: validation xuyên tầng, CNC OCG/name và hợp đồng Front + Cut; full backend/frontend xanh. | Chưa chạy app thật và chưa phủ toàn bộ marks/bleed/report/duplex bằng artifact chung. `W2-U02-OC` còn thiếu app/Illustrator/Graphtec/multi-unit smoke; Alpha còn chờ smoke/cắt thử và quyết định UI §ALPHA.4. | Runtime/downstream smoke `W2-U02-OC`; sau đó Alpha và ma trận Booklet/Mixed/Sticker/CNC còn lại. |
| **W3 — Resize/Crop/Combine/Split/Convert** | `TRACED` | Resize transparency, resize giữ tỷ lệ, Export Image, Combine và Office từng có test/artifact/runtime riêng. | Chưa có bản đồ dọc cho toàn họ công cụ; Crop/Split và nhiều nhánh convert thiếu ma trận hiện hành; thiếu corpus box/rotate/encrypted/cancel/error/large-file. Một số file resize/combine hiện đang đổi. | `W3-U01`: lập registry entry → writer → reopen cho từng PDF utility, bắt đầu Resize/Crop. |
| **W4 — VDP và dữ liệu biến đổi** | `STALE` | Audit 2026-06 từng xác minh page-count/toạ độ/nội dung Numbering; repo có suite VDP và test gate Free/Pro mới. | `vdp.py`, DataMerge/Numbering/CoverNumbering và entitlement đã đổi sau bằng chứng artifact cũ. Chưa chạy lại CSV/XLSX/Google, rotate, multipage, barcode, preview↔output và key thật. | `W4-U01`: Data Merge CSV UTF-8/Unicode + multipage + reopen artifact; sau đó Numbering/Cover Numbering. |
| **W5 — Dieline, nesting, export, 3D** | `AUTO` | 582 test dieline, 30/30 nesting và sidecar/WebView đã đạt trong đợt gần nhất; Flip Top Tuck có golden/property/parity; Double Tray có test pose/wiring. | Chưa nghiệm thu trực quan 2D/3D toàn catalog trên cây mã hiện tại; thiếu pixel golden WebGL, installed-sidecar và in/cắt vật lý. | `W5-U01`: catalog sweep 2D CUT/CREASE/BLEED → export PDF → fold 0–100% → installed sidecar. |
| **W6 — Multi-tab, routing, event, state ownership** | `STALE` | Audit NAV.1–NAV.12 từng đạt full Vitest; audit mở file từng có smoke Tauri thật. | `App`, Home, Imposition, tool registry, recovery và entitlement đã tiếp tục đổi. Chưa lặp multi-tab/current-tool, background listeners, native drop, recovery, USB/UNC/NAS và đủ định dạng. | `W6-U01`: hai tab cùng loại + tab nền + native drop + đóng/reopen/recovery. |
| **W7 — PDFium, worker/process, RAM gate, hiệu năng** | `AUTO` | §PERF.1–9 đã sửa theo Lô 1–11: scheduler/RAM, worker UI, preview worker, cache/disk, native splash, warm-up RAM, pause nền và PPE Rayon. Frontend 200 file/1.926 test; print_engine 348 unit + 218 integration/golden; native/Python PPE 117 test. Runtime §PERF.9: minimize 5 giây dùng 0 ms CPU, restore responsive; startup Release đã có splash/proof/Home trace. | Chưa benchmark vật lý đủ `<8 / <16 / ≥16 GB`, peak RSS/P95/cancel; W7-U01 PDFium cross-file chưa hoàn tất. Production sidecar chứa PPE mới chưa được đóng gói lại do kho khóa ngoài sandbox. | Benchmark 8/16/32 GB; hoàn tất inventory PDFium; sau đó rebuild/smoke artifact bằng pipeline có quyền kho khóa. |
| **W8 — Security, license, build, release artifact** | `STALE` | Pipeline từng build installer nội bộ và chạy clean-user smoke; release gate fail-closed; audit bảo mật 2026-07-30 có phần migration/Edge được xác minh. | Worktree hiện khác HEAD ở nhiều đường build và nghiệp vụ; artifact cũ không đại diện. Free/Pro mới chưa deploy/smoke bằng key thật; chưa có artifact hiện tại clean, ký số và cài mới. | `W8-U01`: chỉ sau khi code ổn định — audit entitlement dọc, internal build, installed/clean-user smoke; không publish GitHub trong bước audit. |

## 3. Nguồn bằng chứng baseline

| Wave | Tài liệu chính |
|---|---|
| W1 | `docs/BAO_CAO_AUDIT_PAGE_BOX_W1_2026-08-04.md`; `docs/PAGE_BOX_FIXES_2026-08-04.md`; `docs/BAO_CAO_AUDIT_DO_CHINH_XAC_KICH_THUOC_UI_2026-08-04.md`; `docs/DO_CHINH_XAC_KICH_THUOC_FIXES_2026-08-04.md` |
| W2 | `docs/BAO_CAO_AUDIT_PREVIEW_ARTIFACT_W2_2026-08-04.md`; `docs/PREVIEW_ARTIFACT_FIXES_2026-08-04.md`; `docs/BAO_CAO_AUDIT_DUONG_CAT_ALPHA_2026-08-04.md`; `docs/BAO_CAO_AUDIT_OC_VA_DAT_TEN_OC_2026-08-05.md`; `docs/OC_VA_DAT_TEN_OC_FIXES_2026-08-05.md`; `audit-rules.md` §6; `docs/NUP_CUT_BORDER_FIXES_2026-08-04.md`; `docs/BINH_CAT_XEN_NHIEU_KICH_THUOC_FIXES_2026-07-30.md`; `docs/DAU_XEN_MIXED_GUILLOTINE_FIXES_2026-08-01.md` |
| W3 | `docs/RESIZE_TRANSPARENCY_FIXES_2026-08-03.md`; `docs/RESIZE_GIU_TY_LE_TUNG_TRANG_FIXES_2026-08-01.md`; `docs/XUAT_ANH_FIXES_2026-07-31.md`; `docs/COMBINE_PNG_LOADING_FIXES_2026-08-01.md`; `docs/LUONG_MO_FILE_FIXES_2026-08-02.md` |
| W4 | `docs/audit/AUDIT_REPORT.md`; `docs/audit/PERFORMANCE_REAUDIT_2026-07-23.md`; `docs/BAO_CAO_AUDIT_UIUX_2026-07-27.md`; `docs/FREE_PRO_FIXES_2026-08-04.md` |
| W5 | `audit-rules.md`; `docs/audit/PACKAGING_DIELINE_AUDIT_2026-07-19.md`; `docs/FLIP_TOP_TUCK_FIXES_2026-08-02.md`; `docs/DOUBLE_TRAY_FIXES_2026-07-27.md`; `docs/DO_CHINH_XAC_KICH_THUOC_FIXES_2026-08-04.md` |
| W6 | `docs/DIEU_HUONG_TAB_CONG_CU_FIXES_2026-07-28.md`; `docs/WORKSPACE_CONTEXT_FIXES_2026-07-27.md`; `docs/LUONG_MO_FILE_FIXES_2026-08-02.md` |
| W7 | `docs/BAO_CAO_AUDIT_HIEU_NANG_VA_THAN_THIEN_PHAN_CUNG_2026-08-05.md`; `docs/PERF_FIXES_2026-08-05.md`; `docs/PERF_FIXES_2026-07-26.md`; `docs/KIEN_TRUC_FIXES_2026-07-29.md`; `docs/BAO_CAO_AUDIT_TOC_DO_BINH_TRANG_2026-07-29.md`; `docs/BINH_TRANG_PERF_FIXES_2026-07-29.md` |
| W8 | `audit-rules.md` §12/§14.7/§15; `docs/BUILD_RELEASE_FIXES_2026-08-03.md`; `docs/BAO_CAO_AUDIT_SAN_SANG_BUILD_RELEASE_2026-08-03.md`; `docs/FREE_PRO_FIXES_2026-08-04.md`; `docs/BAO_MAT_FIXES_2026-07-30.md` |

`docs/audit/AUDIT_REPORT.md` là bằng chứng lịch sử từ 2026-06-19. Chỉ dùng để tìm corpus/luồng cũ; không dùng riêng nó để nâng trạng thái hiện tại.

## 4. Hàng đợi audit unit

| Thứ tự | Mã | Luồng cần chốt | Bất biến/artifact phải kiểm | Hiện trạng |
|---:|---|---|---|---|
| 1 | `W1-U01` | Mọi reader/writer đọc PDF page boxes | mm ↔ pt không mất số lẻ; rotate; Media/Crop/Trim/Bleed; reopen cùng kích thước | `AUTO`; các nhánh Crop/N-Up đạt `ARTIFACT`, PB1–PB6 đã sửa, chờ runtime Viewer/app |
| 2 | `W2-U01` | N-Up từ form đến PDF mở lại | preview plan = placement thật; marks/bleed/cut-border đúng page box | `AUTO`; PA1/PA2 đã sửa, chờ corpus artifact/runtime chung |
| 3 | `W2-U02` | Booklet/Step Repeat/Sticker/CNC | page order, duplex, creep, rotation, marks và report khớp artifact | `TRACED` một phần; nhánh `W2-U02-OC` đạt `ARTIFACT`, §OC.1–§OC.3 đã sửa/verify, chờ runtime; Booklet/Step Repeat chưa phủ |
| 3a | `W2-U03` | Bù xén → đường cắt theo biên trong suốt/ảnh nền trắng | bám Alpha; lùi 0,15 mm; topology/lỗ; node/mm; Hausdorff; path CutContour | `ARTIFACT` cho topology/noodle; §NOODLE.12–15 đã sửa: 111/111 artifact, 154 test liên quan, backend full 2.420 pass/21 skip. Chất lượng chuyển động máy bế được tách sang `W2-U05`, không suy từ tổng node. |
| 3b | `W2-U04` | Ảnh AI nhiều tem → sửa mask → PDF từng tem | preview không đổi màu; pan/edit tách biệt; scale mm; góc lõm; CutContour; tái dùng ảnh đang mở | `ARTIFACT`; follow-up 72 DPI đạt 9/9 CutContour, 0 line fallback/short-segment; export không tự chuyển công cụ; native DirectML→CPU đã verify, chờ smoke UI trên app |
| 3c | `W2-U05` | Bù xén → đường chạy CutContour freeform an toàn cho máy bế | reference bất biến; tangent/curvature continuity; minimum command length; normal error; không polyline fallback; fail-safe khi nguồn không đủ | `TRACED`; §MOTION.1–6 đã xác nhận. Lô A hoàn tất metric/oracle thuần stdlib: 23 test pass, benchmark 12.000 đoạn/12.000 join trong 0,0827 s, chưa nối production nên chưa nâng `AUTO`; chờ xác nhận để sang Lô B. |
| 4 | `W3-U01` | Resize + Crop | transparency, content transform, box policy, số lẻ mm, mixed pages | `STALE` |
| 5 | `W3-U02` | Combine + Split + Convert | order, page boxes, metadata, encrypted/error/cancel và reopen | `TRACED` một phần |
| 6 | `W4-U01` | Data Merge | schema CSV/XLSX/Google, Unicode, multipage, barcode, preview/output | `STALE` |
| 7 | `W4-U02` | Numbering + Cover Numbering | coordinate/rotate/page selection/font và output text/vector | `STALE` |
| 8 | `W6-U01` | Multi-tab native event | event có tab/session owner; tab nền/đã đóng không nhận file | `STALE` |
| 9 | `W7-U01` | PDFium trong thread | mọi callable reachable có guard đúng chỗ hoặc đi ProcessPool | `TRACED` một phần; scanner 0 hit cùng-file nhưng inventory wrapper/cross-file chưa khép |
| 10 | `W7-U02` | RAM/worker benchmark | máy mạnh không bị hard-cap; máy yếu giảm an toàn; RSS/P95/cancel | `AUTO`; N-Up/Sticker/VDP/scheduler/warm-up đạt test policy, startup/disk/background/PPE có số máy 32GB; còn thiếu benchmark vật lý ba tier |
| 10a | `W7-U03` | PDF Viewer CMYK/gradient fidelity | raw renderer = transport; DeviceCMYK/DeviceN/transparency/OutputIntent; parity full-page/tile | `ARTIFACT`; detector + runtime identity + PNG pixel-equal + accurate route/định tuyến đã có test; đúng PDF khách đạt PPE→Acrobat MAE 4,6632; chờ runtime UI Tauri |
| 11 | `W5-U01` | Dieline catalog end-to-end | CUT kín, CREASE đúng, BLEED, export, fold 0–100%, parity sidecar | `AUTO` |
| 12 | `W8-U01` | Entitlement + installed artifact | catalog/gate/backend cùng nguồn; Free/Pro key thật; clean-user fail-closed | `STALE` |

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
