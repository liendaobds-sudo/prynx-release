# PrynX Master Audit Matrix

> Cập nhật baseline: 2026-08-04 · HEAD `1bf8621` · audit W1/W2 đã được duyệt sửa theo lô.

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
| **W1 — Kích thước, đơn vị, PDF page boxes** | `AUTO` | Đợt 2026-08-04 đã xử lý 11/11 lỗi độ chính xác; formatter giữ `0,1 mm`, nhận diện `0,01 mm`; audit W1 mới xác nhận Crop rotate và Viewer fallback đang lệch. | `§W1.PB1/PB2` đã duyệt sửa; `/UserUnit` còn `[SUSPECTED]`; chưa có corpus chung Media/Crop/Trim/Bleed × rotate × mọi consumer. | Sửa lô PB1/PB2; tạo artifact N-Up `/UserUnit=2`. |
| **W2 — Preview ↔ PDF xuất của bình bản** | `AUTO` | Mixed Guillotine dùng chung plan/`planHash`; N-Up cut-border có test artifact; audit W2 mới xác nhận Booklet preview bỏ `marginBottom`. | `§W2.PA1` đã duyệt sửa; fallback Mixed sau lỗi materialize còn `[SUSPECTED]`; thiếu corpus parity toàn bộ marks/bleed/report/duplex. | Sửa lô PA1; fault-inject materialize rồi chạy corpus preview → artifact. |
| **W3 — Resize/Crop/Combine/Split/Convert** | `TRACED` | Resize transparency, resize giữ tỷ lệ, Export Image, Combine và Office từng có test/artifact/runtime riêng. | Chưa có bản đồ dọc cho toàn họ công cụ; Crop/Split và nhiều nhánh convert thiếu ma trận hiện hành; thiếu corpus box/rotate/encrypted/cancel/error/large-file. Một số file resize/combine hiện đang đổi. | `W3-U01`: lập registry entry → writer → reopen cho từng PDF utility, bắt đầu Resize/Crop. |
| **W4 — VDP và dữ liệu biến đổi** | `STALE` | Audit 2026-06 từng xác minh page-count/toạ độ/nội dung Numbering; repo có suite VDP và test gate Free/Pro mới. | `vdp.py`, DataMerge/Numbering/CoverNumbering và entitlement đã đổi sau bằng chứng artifact cũ. Chưa chạy lại CSV/XLSX/Google, rotate, multipage, barcode, preview↔output và key thật. | `W4-U01`: Data Merge CSV UTF-8/Unicode + multipage + reopen artifact; sau đó Numbering/Cover Numbering. |
| **W5 — Dieline, nesting, export, 3D** | `AUTO` | 582 test dieline, 30/30 nesting và sidecar/WebView đã đạt trong đợt gần nhất; Flip Top Tuck có golden/property/parity; Double Tray có test pose/wiring. | Chưa nghiệm thu trực quan 2D/3D toàn catalog trên cây mã hiện tại; thiếu pixel golden WebGL, installed-sidecar và in/cắt vật lý. | `W5-U01`: catalog sweep 2D CUT/CREASE/BLEED → export PDF → fold 0–100% → installed sidecar. |
| **W6 — Multi-tab, routing, event, state ownership** | `STALE` | Audit NAV.1–NAV.12 từng đạt full Vitest; audit mở file từng có smoke Tauri thật. | `App`, Home, Imposition, tool registry, recovery và entitlement đã tiếp tục đổi. Chưa lặp multi-tab/current-tool, background listeners, native drop, recovery, USB/UNC/NAS và đủ định dạng. | `W6-U01`: hai tab cùng loại + tab nền + native drop + đóng/reopen/recovery. |
| **W7 — PDFium, worker/process, RAM gate, hiệu năng** | `STALE` | Có `pdfium_guard`, scheduler việc nặng, RAM-gating và nhiều microbenchmark/fix lịch sử. | Chưa trace lại mọi PDFium call được dispatch sang thread; chưa benchmark hiện tại theo `<8 / <16 / ≥16 GB`, peak RSS, P95, cancel latency và cold launch. N-Up/preview vẫn đổi. | `W7-U01`: inventory dispatch thread → callable → PDFium guard, rồi benchmark ba tier RAM. |
| **W8 — Security, license, build, release artifact** | `STALE` | Pipeline từng build installer nội bộ và chạy clean-user smoke; release gate fail-closed; audit bảo mật 2026-07-30 có phần migration/Edge được xác minh. | Worktree hiện khác HEAD ở nhiều đường build và nghiệp vụ; artifact cũ không đại diện. Free/Pro mới chưa deploy/smoke bằng key thật; chưa có artifact hiện tại clean, ký số và cài mới. | `W8-U01`: chỉ sau khi code ổn định — audit entitlement dọc, internal build, installed/clean-user smoke; không publish GitHub trong bước audit. |

## 3. Nguồn bằng chứng baseline

| Wave | Tài liệu chính |
|---|---|
| W1 | `docs/BAO_CAO_AUDIT_PAGE_BOX_W1_2026-08-04.md`; `docs/BAO_CAO_AUDIT_DO_CHINH_XAC_KICH_THUOC_UI_2026-08-04.md`; `docs/DO_CHINH_XAC_KICH_THUOC_FIXES_2026-08-04.md` |
| W2 | `docs/BAO_CAO_AUDIT_PREVIEW_ARTIFACT_W2_2026-08-04.md`; `audit-rules.md` §6; `docs/NUP_CUT_BORDER_FIXES_2026-08-04.md`; `docs/BINH_CAT_XEN_NHIEU_KICH_THUOC_FIXES_2026-07-30.md`; `docs/DAU_XEN_MIXED_GUILLOTINE_FIXES_2026-08-01.md`; `docs/audit/AUDIT_REPORT.md` |
| W3 | `docs/RESIZE_TRANSPARENCY_FIXES_2026-08-03.md`; `docs/RESIZE_GIU_TY_LE_TUNG_TRANG_FIXES_2026-08-01.md`; `docs/XUAT_ANH_FIXES_2026-07-31.md`; `docs/COMBINE_PNG_LOADING_FIXES_2026-08-01.md`; `docs/LUONG_MO_FILE_FIXES_2026-08-02.md` |
| W4 | `docs/audit/AUDIT_REPORT.md`; `docs/audit/PERFORMANCE_REAUDIT_2026-07-23.md`; `docs/BAO_CAO_AUDIT_UIUX_2026-07-27.md`; `docs/FREE_PRO_FIXES_2026-08-04.md` |
| W5 | `audit-rules.md`; `docs/audit/PACKAGING_DIELINE_AUDIT_2026-07-19.md`; `docs/FLIP_TOP_TUCK_FIXES_2026-08-02.md`; `docs/DOUBLE_TRAY_FIXES_2026-07-27.md`; `docs/DO_CHINH_XAC_KICH_THUOC_FIXES_2026-08-04.md` |
| W6 | `docs/DIEU_HUONG_TAB_CONG_CU_FIXES_2026-07-28.md`; `docs/WORKSPACE_CONTEXT_FIXES_2026-07-27.md`; `docs/LUONG_MO_FILE_FIXES_2026-08-02.md` |
| W7 | `docs/PERF_FIXES_2026-07-26.md`; `docs/KIEN_TRUC_FIXES_2026-07-29.md`; `docs/BAO_CAO_AUDIT_TOC_DO_BINH_TRANG_2026-07-29.md`; `docs/BINH_TRANG_PERF_FIXES_2026-07-29.md` |
| W8 | `audit-rules.md` §12/§14.7/§15; `docs/BUILD_RELEASE_FIXES_2026-08-03.md`; `docs/BAO_CAO_AUDIT_SAN_SANG_BUILD_RELEASE_2026-08-03.md`; `docs/FREE_PRO_FIXES_2026-08-04.md`; `docs/BAO_MAT_FIXES_2026-07-30.md` |

`docs/audit/AUDIT_REPORT.md` là bằng chứng lịch sử từ 2026-06-19. Chỉ dùng để tìm corpus/luồng cũ; không dùng riêng nó để nâng trạng thái hiện tại.

## 4. Hàng đợi audit unit

| Thứ tự | Mã | Luồng cần chốt | Bất biến/artifact phải kiểm | Hiện trạng |
|---:|---|---|---|---|
| 1 | `W1-U01` | Mọi reader/writer đọc PDF page boxes | mm ↔ pt không mất số lẻ; rotate; Media/Crop/Trim/Bleed; reopen cùng kích thước | `AUTO` — PB1/PB2 mở |
| 2 | `W2-U01` | N-Up từ form đến PDF mở lại | preview plan = placement thật; marks/bleed/cut-border đúng page box | `AUTO` — PA1 mở |
| 3 | `W2-U02` | Booklet/Step Repeat/Sticker/CNC | page order, duplex, creep, rotation, marks và report khớp artifact | `UNKNOWN` |
| 4 | `W3-U01` | Resize + Crop | transparency, content transform, box policy, số lẻ mm, mixed pages | `STALE` |
| 5 | `W3-U02` | Combine + Split + Convert | order, page boxes, metadata, encrypted/error/cancel và reopen | `TRACED` một phần |
| 6 | `W4-U01` | Data Merge | schema CSV/XLSX/Google, Unicode, multipage, barcode, preview/output | `STALE` |
| 7 | `W4-U02` | Numbering + Cover Numbering | coordinate/rotate/page selection/font và output text/vector | `STALE` |
| 8 | `W6-U01` | Multi-tab native event | event có tab/session owner; tab nền/đã đóng không nhận file | `STALE` |
| 9 | `W7-U01` | PDFium trong thread | mọi callable reachable có guard đúng chỗ hoặc đi ProcessPool | `STALE` |
| 10 | `W7-U02` | RAM/worker benchmark | máy mạnh không bị hard-cap; máy yếu giảm an toàn; RSS/P95/cancel | `STALE` |
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
