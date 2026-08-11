# BÁO CÁO AUDIT DỌN SẠCH GHOSTSCRIPT

**Ngày audit:** 2026-08-08

**Branch / baseline:** `codex/pre-release-audit-2026-08-04` / `89a9048` + worktree hiện tại

**Phạm vi:** runtime backend, hợp đồng API/UI, test, môi trường dev, build/release và payload cài đặt

**Không thuộc phạm vi:** gỡ Ghostscript đã cài trên Windows, xóa installer lịch sử, sửa nhóm Sticker đang được một phiên khác triển khai

---

## 1. Kết luận điều hành

### Kết luận ngắn

1. **PrynX hiện không thể chạy Ghostscript.** `Settings` luôn ép
   `GHOSTSCRIPT_PATH=""`; chốt subprocess từ chối lệnh GS trước khi tạo process.
2. **Bản phát hành rc.4 không chứa binary Ghostscript.** Không có
   `gswin*.exe`, `gsdll*.dll` hay `gs.exe` trong payload hiện hành.
3. **Thư mục `binaries/gs` vẫn xuất hiện vì pipeline tự tạo file
   `NO_GHOSTSCRIPT.txt` 548 byte rồi Tauri đóng gói glob `binaries/gs/**/*`.**
   Đây là marker “không có GS”, không phải engine GS.
4. Mã nguồn **chưa sạch về kiến trúc**: còn nhánh fallback không thể chạy, cờ
   `use_gs` mang nghĩa PPE/xấp xỉ, test tự skip, tài liệu sai và script setup dev
   vẫn có thể cài Ghostscript thật.

### Quyết định audit

**GO cho chiến dịch dọn có kiểm soát; NO-GO cho việc xóa hàng loạt theo từ khóa.**

Không có P0 về việc GS đang chạy hoặc bị bundle. Có ba nhóm P1 cần xử lý trước
khi build bản tiếp theo: lỗi/fallback runtime, build + setup dev, và hợp đồng
chức năng còn nói sai engine.

---

## 2. Bằng chứng nền

### 2.1. Ba chốt chứng minh Ghostscript không chạy

- `backend/app/config.py:103,113-115`: mọi nguồn cấu hình cuối cùng đều bị ép về
  `GHOSTSCRIPT_PATH=""`.
- `backend/app/utils/subprocess_utils.py:52-77`: lệnh giống GS bị ném
  `GhostscriptUnavailable` trước `subprocess.run`.
- `backend/tests/test_no_ghostscript_survival.py`: **24 pass** trên worktree hiện
  tại; các luồng chính vẫn có kết quả hoặc từ chối an toàn mà không gọi GS.
- `test_gs_usage_telemetry.py` + `test_print_engine_routing.py` +
  `test_release_no_gs_policy.py`: **38 pass**.

Harness độc lập của audit cũng xác nhận dù gán đường dẫn tới một file tồn tại:

```text
settings.GHOSTSCRIPT_PATH = ""
guard = GhostscriptUnavailable
subprocess.run call count = 0
```

### 2.2. Bằng chứng payload

- `build_production.ps1:1062`: `$BUNDLE_GS = $false` cố định.
- `desktop/src-tauri/binaries/gs/` hiện chỉ có `NO_GHOSTSCRIPT.txt`, 548 byte.
- `desktop/src-tauri/tauri.conf.json:118` vẫn bundle `binaries/gs/**/*`.
- `Ban_Phat_Hanh/release-manifest.txt:3,11,20`: rc.4 từ commit `5dd08dd`,
  `RUNTIME_VERIFIED=yes`.
- Không tìm thấy binary GS trong payload hiện hành; `THIRD_PARTY_NOTICES.md`
  không khai Ghostscript, Artifex hoặc AGPL.

### 2.3. Giới hạn của bằng chứng

- Artifact rc.4 đại diện cho commit `5dd08dd`, **không đại diện** cho worktree
  `89a9048` đang có nhiều thay đổi chưa commit.
- Có các installer beta cũ được tạo trước chính sách no-GS. Chưa giải nén từng
  installer nên chỉ đánh dấu `[SUSPECTED]`, không dùng để kết luận release hiện tại.
- Không chạy full backend suite trong audit này vì nhóm Sticker đang thay đổi đồng
  thời. Chỉ dùng các suite mục tiêu độc lập nêu trên.

---

## 3. Audit unit và mức bằng chứng

| Mã | Luồng | Trace chính | Trạng thái |
|---|---|---|---|
| `GS-U01` | Người dùng chạy action/convert/optimize/PDF-X/flatten → file hoặc lỗi | route FastAPI → core engine → native/PPE → nhánh GS bị chặn → response/artifact | `AUTO` cho bất biến “0 lần gọi GS”; `TRACED` cho cleanup và lỗi người dùng |
| `GS-U02` | Mở Output Preview → chọn PPE chính xác/xấp xỉ → xem kẽm | `OutputPreviewTab.tsx:309` → `preflight.py:949-973` → `separations.py:183-212` | `AUTO`; tên hợp đồng sai nhưng định tuyến hiện tại đã có test |
| `GS-U03` | Build → Tauri resource → installer → cài → verifier | `build_production.ps1:1039-1107` → `tauri.conf.json:118` → verifier `:882-894` → manifest | `ARTIFACT` cho rc.4; `STALE` đối với source hiện tại |

---

## 4. Phát hiện đã xác nhận

### [P1][CONFIRMED] §GS.1 — Convert Colors và Optimize vẫn đi vào nhánh GS không thể chạy

**Effort:** M

- `preflight.py:1367-1418` thử object-level; khi không hỗ trợ vẫn tạo output,
  có thể chạy pre-pass giữ đen tại `:1420-1433`, rồi gọi GS tại `:1475`.
- Guard ném trước khi cleanup `prepass_tmp` tại `:1476-1480`; lỗi bị đổi thành
  log chung tại `:1491-1500`.
- `pdf_tools.py:890-930` thử native rồi dựng command GS; lỗi bị bắt chung tại
  `:1047-1050` và trả HTTP 500 mang tên lớp lỗi nội bộ.

**Tác động:** thao tác unsupported chậm hơn cần thiết, có thể để file tạm, ghi log
nhiễu và báo lỗi kỹ thuật thay vì từ chối rõ ràng.

**Hướng sửa:** fail-closed ngay sau kết quả native/PPE; cleanup trong `finally`;
trả 422/lý do nghiệp vụ, không dựng command GS.

### [P1][CONFIRMED] §GS.2 — Action Engine và Ink Manager còn hợp đồng “fallback GS” giả

**Effort:** M

- `action_engine.py` còn dựng command cho Convert, Flatten, Embed, Outline và
  Downscale tại `:470-504`, `:576-588`, `:694-706`, `:804-897`, `:1014-1030`.
- `_run_gs()` tại `:1222-1230` luôn ném `InternalEngineUnsupported`, nên toàn bộ
  command phía trên không thể chạy.
- Registry và một số nhánh vẫn tự mô tả/gán engine `gs` trước khi từ chối; chốt
  `execute()` hiện sửa log kết quả về `engine="none"`, nhưng hợp đồng nội bộ vẫn sai
  kiến trúc và rất dễ bị tái sử dụng nhầm.
- `ink_manager.py:138-186` thử native rồi báo “không tìm thấy Ghostscript” mặc dù
  chính sách sản phẩm không cho phép GS.
- `pdfx_export.py:421-439` đã fail-closed trước sink, nên `_export_x1a()` và
  `_export_x4()` tại `:562-645` là code chết.

**Tác động:** người dùng bị hướng sai sang việc cài công cụ ngoài; registry/help
và code bảo trì vẫn mô tả một engine không tồn tại.

**Hướng sửa:** action native/PPE thành công thì trả engine thật; unsupported thì
từ chối bằng tên tính năng và lý do file, không còn thuật ngữ GS.

### [P2][CONFIRMED] §GS.3 — Layer/Resize/Sticker còn probe GS thừa trước fallback thật

**Effort:** M

- `layer_engine.py:1483-1511` luôn thử `run_hidden()` rồi mới raster 300 DPI.
- `pdf_tools_engine.py:429-479` còn helper downsample GS; do path luôn rỗng nên
  thực tế giữ đường object-level/geometry fallback.
- `sticker_engine.py:3742-3820,5742` còn renderer GS nhưng thực tế luôn rơi sang
  PDFium.

**Tác động:** exception/log thừa, code khó hiểu và dễ bị người sửa sau bật lại
nhầm. Với layer, output hiện tại không đổi nếu đi thẳng raster fallback và vẫn
giữ cảnh báo mất vector/Pantone/kênh bế.

**Hướng sửa:** bỏ probe, đi thẳng fallback đang hoạt động. Riêng Sticker để lô
độc lập sau khi phiên đang sửa Sticker kết thúc.

### [P2][CONFIRMED] §GS.4 — `use_gs` là hợp đồng sống nhưng tên đã sai hoàn toàn

**Effort:** M

Trace hiện tại:

```text
OutputPreviewTab use_gs=true  → PPE
OutputPreviewTab use_gs=false → PDFium xấp xỉ
```

- `OutputPreviewTab.tsx:309` vẫn gửi `use_gs`.
- `preflight.py:954-973,993` vẫn nhận/truyền field legacy.
- `schemas/preflight.py:306` vẫn công khai `use_gs`.
- `separations.py:198-212` xác nhận `True/None` nghĩa PPE, `False` nghĩa xấp xỉ.
- `_run_ghostscript_tiffsep()` tại `separations.py:390` không có production caller.
- Nhãn `engineUsed === "ghostscript"` tại `OutputPreviewTab.tsx:99-101` không
  reachable từ engine hiện tại.
- `/api/system/gs-usage` tại `system.py:98-112` vẫn reachable nhưng không có
  frontend consumer; guard chặn trước điểm ghi nên endpoint không thể nhận lượt
  gọi GS mới.

**Tác động:** contract gây hiểu nhầm xuyên frontend/backend, làm tăng nguy cơ tái
đưa GS vào khi bảo trì.

**Hướng sửa:** chuyển hai pha sang `render_mode=accurate|approximate`; cập nhật
caller/test rồi xóa alias và runner TIFFSEP chết.

### [P1][CONFIRMED] §GS.5 — Build vẫn tự tạo thư mục GS; setup dev vẫn có thể cài GS thật

**Effort:** M

- `build_production.ps1:1039-1055` vẫn dò GS hệ thống.
- `:1064-1088` xóa payload cũ rồi tạo `binaries/gs/NO_GHOSTSCRIPT.txt`.
- `:1094-1107` giữ nhánh copy GS chết dù `$BUNDLE_GS` luôn `false`.
- Tham số `-NoGhostscript` tại `:38` là no-op.
- Tauri bundle glob `binaries/gs/**/*`, nên người dùng vẫn thấy thư mục `gs`.
- `setup_dev_env.ps1:228-268` vẫn kiểm tra và cài
  `ArtifexSoftware.GhostScript` bằng winget.
- `README.md:40,70` vẫn mô tả GS là engine và dependency bắt buộc.

**Tác động:** đúng nguyên nhân thư mục người dùng phản ánh; setup mới còn có thể
cài một dependency mà PrynX không dùng.

**Hướng sửa:** xóa toàn bộ nhánh copy/marker/resource; bỏ bước cài dev và yêu cầu
README. Không tự động gỡ bản GS đã có trên Windows.

### [P2][CONFIRMED] §GS.6 — Verifier no-GS còn phụ thuộc cờ tùy chọn và marker

**Effort:** S

- `verify_installed_artifact.ps1:882-894` chỉ quét GS khi truyền
  `-ExpectNoGhostscript`, đồng thời bắt buộc marker trong thư mục GS.
- `release_update.ps1:398` hiện có truyền cờ, nhưng lời gọi verifier khác có thể
  bỏ qua kiểm tra.

**Tác động:** sau khi xóa marker, verifier hiện tại sẽ fail dù payload sạch; một
entry khác quên cờ có thể không quét binary.

**Hướng sửa:** biến “không có binary GS” thành bất biến bắt buộc, quét trực tiếp
payload/NOTICE và bỏ yêu cầu marker/cờ tùy chọn.

### [P2][CONFIRMED] §GS.7 — Bốn test đang skip vĩnh viễn theo một dependency bị khóa rỗng

**Effort:** M

Audit chạy bốn ca chọn lọc và nhận **4 skipped**:

- `test_icc_and_color_preview.py:123-144`: đường GS luôn skip.
- `test_pdfx_output_intent.py:85-100`: PDF/X-4 native bị skip vì kiểm GS.
- `test_resize_smart.py:68-71,332`: vector downsample bị skip vì kiểm GS.
- `test_outline_fonts_hardening.py:160-172`: mọi lỗi pipeline bị đổi thành skip
  “Ghostscript không khả dụng”.

**Tác động:** nhánh native/PPE quan trọng có thể hồi quy mà CI vẫn xanh.

**Hướng sửa:** xóa test engine chết; các test chức năng native phải pass/fail thật,
không được skip theo `GHOSTSCRIPT_PATH`.

### [P2][CONFIRMED] §GS.8 — SSOT hiện hành còn mâu thuẫn chính sách PPE-only

**Effort:** S

- `docs/PPE_CURRENT_STATE.md:23,59,65` vẫn mô tả legacy opt-in/marker/cờ verifier.
- `docs/HIENTHI_MAU_VIEWER_FIXES_2026-08-07.md:70,78` còn nói giữ fallback/test
  GS tùy máy.
- `docs/CAU_HINH_ENV.md:69-75` còn hướng dẫn `GHOSTSCRIPT_PATH` và
  `PRYNX_NO_GS_BUILD`.
- `docs/PDF_UTILITIES_GUIDE.md:8` ghi Optimize dùng Ghostscript.
- `.env.example:37-45` vẫn công khai cấu hình GS không còn tác dụng.

**Tác động:** tài liệu là nguồn trực tiếp khiến agent/người bảo trì tái tạo nhánh GS.

**Hướng sửa:** cập nhật tài liệu hiện hành; giữ nguyên báo cáo lịch sử và số đo
đối chứng có nhãn rõ.

---

## 5. Những phần không được xóa nhầm

### [EXPECTED] Giữ hàng rào chống tái đóng gói

- Verifier vẫn phải quét và từ chối `gswin*.exe`, `gsdll*.dll`, `gs.exe` trong
  installer; chỉ bỏ marker và cờ tùy chọn.
- Có thể giữ một test/tripwire tĩnh chứng minh product source không có GS caller.
- `scripts/bundled_components.json` có thể giữ record `bundled:false` như bằng
  chứng pháp lý; generator không được đưa nó vào NOTICE.

### [EXPECTED] Giữ công cụ đối chứng dành cho nhà phát triển

- `scripts/ppe_golden_compare.py` dùng GS cài riêng trên máy dev làm renderer
  tham chiếu; không được bundle và không nằm trong runtime sản phẩm.
- Các golden fixture/số đo lịch sử so PPE với GS là bằng chứng kỹ thuật.
- Đường dò `/usr/share/ghostscript` trong `icc_profiles.py` chỉ lấy profile ICC
  nếu máy có sẵn; nó không khởi chạy executable. Có thể bỏ sau khi chốt nguồn ICC,
  nhưng không được tính là caller runtime.
- Comment Rust nói về kết quả đối chứng được giữ nếu mô tả phép đo; comment còn
  nói “fallback sang Ghostscript” phải đổi thành “báo unsupported/fail-closed”.

### [DISPROVED] Không phải mọi token `gs` đều là Ghostscript

Trong `overprint_black.py`, `outline_text.py` và một số parser, `gs` là toán tử
graphics-state của PDF. Không đổi tên/xóa theo regex.

---

## 6. Kế hoạch sửa theo lô, mỗi lô tối đa 5 file

| Thứ tự | Lô | Phạm vi chính | Verify bắt buộc |
|---:|---|---|---|
| 1 | `GS-A1` | `preflight.py`, `pdf_tools.py`, `ink_manager.py`, no-GS regression | py_compile + targeted pytest; fault-injection cleanup |
| 2 | `GS-A2` | `action_engine.py`, `pdfx_export.py` và ba test action/PDF-X/outline | targeted action/PDF-X; không còn engine=`gs` giả |
| 3 | `GS-A3` | `layer_engine.py`, `pdf_tools_engine.py` và ba test flatten/resize | artifact page/box/transparency + warning parity |
| 4 | `GS-A4` | `sticker_engine.py` + test riêng, chỉ sau khi nhóm Sticker ổn định | Sticker E2E + artifact màu/alpha |
| 5 | `GS-B1` | thêm `render_mode`, cập nhật UI/route/schema/core + một test | frontend target + backend routing |
| 6 | `GS-B2` | xóa alias `use_gs/use_ghostscript`, TIFFSEP chết và test stale | `rg` contract = 0; separations PPE/xấp xỉ xanh |
| 7 | `GS-C1` | build, Tauri resource, verifier, policy test; xóa marker sinh ra | syntax PowerShell + policy test + payload staging scan |
| 8 | `GS-C2` | setup dev, README, `.env.example`, `.gitignore`, policy test | setup dry inspection; dependency scan |
| 9 | `GS-C3` | bỏ các cờ release legacy, giữ kiểm GS bắt buộc ở verifier | release-policy test + verifier fixture sạch/bẩn |
| 10 | `GS-D1` | bỏ bốn skip sai và mock GS chết | bốn test phải pass/fail thật, không skip |
| 11 | `GS-D2` | cập nhật tối đa 5 tài liệu hiện hành | link/path scan + review nội dung |
| 12 | `GS-E1/E2` | gỡ telemetry/config legacy sau khi caller = 0; giữ tripwire tối thiểu | targeted API/config tests + scan production caller |

Nguyên tắc thứ tự: **xóa caller trước, giữ guard đến cuối**. Nếu bỏ guard/config
trước, một caller bị sót có thể quay lại chạy GS hệ thống trên máy dev.

---

## 7. Điều kiện nghiệm thu cuối chiến dịch

1. Không còn code production dựng hoặc gọi command Ghostscript.
2. Không còn field/query/engine label `use_gs`, `use_ghostscript`, `ghostscript` ở
   hợp đồng runtime.
3. `setup_dev_env` không kiểm/cài GS; README và `.env.example` không yêu cầu GS.
4. Build không tạo `binaries/gs`, Tauri không bundle glob GS.
5. Verifier luôn từ chối binary/NOTICE AGPL mà không cần marker hoặc cờ tùy chọn.
6. Bốn test stale không còn skip; no-GS/action/PDF-X/resize/separations đều xanh.
7. Build staging mới không có `gswin*.exe`, `gsdll*.dll`, `gs.exe`, thư mục `gs`
   hoặc NOTICE Ghostscript.
8. Chạy installed smoke trên bản build từ source đã dọn; artifact cũ không được
   dùng để nâng trạng thái.

---

## 8. Chốt duyệt

Báo cáo này chỉ lập bằng chứng và kế hoạch. Theo quy trình audit PrynX, chưa xóa
diện rộng trước chốt duyệt. Nếu được duyệt, bắt đầu từ `GS-A1`, verify xong từng
lô rồi mới chuyển lô tiếp theo; nhóm Sticker tiếp tục được cách ly.

---

## 9. Phụ lục sau chốt duyệt

User đã duyệt triển khai và chiến dịch đã hoàn tất theo các lô trong
`docs/GHOSTSCRIPT_CLEANUP_FIXES_2026-08-08.md`.

- Production caller dựng/chạy Ghostscript: **0**.
- Hợp đồng `use_gs` / `use_ghostscript`, discovery/config và telemetry: **đã xóa**.
- Sticker đã đi thẳng PDFium; build/Tauri không tạo hoặc bundle cây `binaries/gs`.
- Verifier, tripwire subprocess, record pháp lý `bundled=false` và công cụ golden
  dành riêng cho nhà phát triển được giữ có chủ đích.
- Source đã đạt kiểm tra tự động; bằng chứng `ARTIFACT` cuối vẫn cần build installer
  mới từ chính worktree này và chạy installed/clean-user smoke.
