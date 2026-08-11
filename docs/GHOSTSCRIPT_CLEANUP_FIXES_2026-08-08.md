# Nhật ký dọn sạch Ghostscript

**Ngày:** 2026-08-08

**Audit gốc:** `BAO_CAO_AUDIT_DON_SACH_GHOSTSCRIPT_2026-08-08.md`

Nguyên tắc: mỗi lô tối đa 5 file, giữ hành vi native/PPE, fail-closed khi chưa
hỗ trợ và verify xong trước khi sang lô kế tiếp. Không chạm thay đổi Sticker của
phiên khác khi file còn đang biến động.

## GS-A1 — Route lỗi người dùng và cleanup

**Trạng thái:** hoàn tất

**File:**

- `backend/app/api/routes/preflight.py`
- `backend/app/api/routes/pdf_tools.py`
- `backend/app/core/ink_manager.py`
- `backend/tests/test_no_ghostscript_survival.py`

**Thay đổi:**

- Convert Colors chỉ dùng engine object-level; unsupported dừng ngay, xóa output
  trung gian và không chạy pre-pass/command ngoài.
- Optimize chỉ dùng engine nội bộ; unsupported trả HTTP 422, exception nội bộ
  không rò tên lớp kỹ thuật và file upload/output dở luôn được dọn.
- Spot→CMYK không còn hướng người dùng cài Ghostscript; route trả 422 với hướng
  xử lý an toàn khi engine nội bộ chưa hỗ trợ.
- Xóa import/command/nhánh catch Ghostscript chết trong ba đường chạy.

**Verify:**

```text
py_compile 4 file: pass
test_no_ghostscript_survival.py: 27 pass
```

## GS-A2 — Action Engine và PDF/X

**Trạng thái:** hoàn tất

**File:**

- `backend/app/core/action_engine.py`
- `backend/app/core/pdfx_export.py`
- `backend/tests/test_action_engine_native.py`
- `backend/tests/test_pdfx_output_intent.py`
- `backend/tests/test_outline_fonts_hardening.py`

**Thay đổi:**

- Xóa toàn bộ command/subprocess/fallback ngoài khỏi Convert CMYK, Flatten,
  Embed Font, OUT FONT, Downscale và PDF/X.
- Registry khai đúng engine PPE/pikepdf; unsupported dùng chung
  `InternalEngineUnsupported`, xóa output dở và trả trạng thái `refused`.
- PDF/X chỉ giữ writer native; test PDF/X-4 và OUT FONT không còn skip theo máy.

**Verify:**

```text
py_compile: pass
targeted: 44 pass
regression mở rộng: 51 pass, 17 skip
git diff --check: pass
```

## GS-D2 — Cập nhật tài liệu hiện hành

**Trạng thái:** hoàn tất

**File:**

- `docs/PPE_CURRENT_STATE.md`
- `docs/HIENTHI_MAU_VIEWER_FIXES_2026-08-07.md`
- `docs/CAU_HINH_ENV.md`
- `docs/PDF_UTILITIES_GUIDE.md`

**Thay đổi:**

- Mô tả đúng PPE-only, PDFium hiển thị/xấp xỉ và Optimize bằng pikepdf/Pillow.
- Xóa cờ, marker, biến môi trường và fallback runtime lỗi thời; giữ số đo đối
  chứng lịch sử với nhãn rõ ràng.

**Verify:**

```text
legacy current-doc contract scan: 0 hit
36/36 đường dẫn tài liệu tồn tại
git diff --check: pass
```

## GS-F3 — Dọn fixture TAC legacy

**Trạng thái:** hoàn tất

**File:**

- `backend/tests/preflight_fixtures/README.md`
- `backend/tests/preflight_fixtures/QA_CHECKLIST.md`
- `backend/tests/preflight_fixtures/generate_fixtures.py`
- `backend/tests/preflight_fixtures/expected_rules.json`

**Thay đổi:**

- Fixture TAC là kiểm tra PPE bắt buộc, không còn optional/skip theo dependency
  đã bị loại bỏ.

**Verify:**

```text
py_compile + JSON parse: pass
preflight golden: 18 pass
```

## GS-A4 — Xóa renderer Ghostscript cuối cùng khỏi Sticker

**Trạng thái:** hoàn tất

**File:**

- `backend/app/workers/sticker_engine.py`
- `backend/tests/test_sticker_engine_e2e.py`

**Thay đổi:**

- Xóa helper dựng command/PNG tạm và caller rectangle smart-bleed.
- Nhánh này đi thẳng raster PDFium đã là fallback thực tế trước khi dọn; khóa
  `pdfium_guard()` và toàn bộ xử lý màu/bù xén phía sau được giữ nguyên.
- Thay test mock renderer chết bằng hồi quy artifact dùng raster PDFium thật.

**Verify:**

```text
py_compile: pass
Sticker rectangle inpaint/smooth-fill: 4 pass, 125 deselected
Sticker Ghostscript/runtime scan: 0 hit
git diff --check: pass
```

## GS-A3 — Flatten và Resize

**Trạng thái:** hoàn tất

**File:**

- `backend/app/core/layer_engine.py`
- `backend/app/workers/pdf_tools_engine.py`
- `backend/tests/test_flatten_raster_warning.py`
- `backend/tests/test_resize_smart.py`
- `backend/tests/test_resize_edge_background.py`

**Thay đổi:**

- Flatten layer đi thẳng qua PDFium raster 300 DPI, giữ nguyên cảnh báo mất
  vector/CMYK/Pantone/kênh bế và bỏ lần probe subprocess luôn thất bại.
- Smart Resize chỉ hạ ảnh an toàn ở cấp XObject; khi không hạ được thì giữ bản
  chỉ đổi hình học, không dựng lại toàn bộ PDF.
- Xóa helper downsample ngoài, skip theo dependency và mock không còn consumer.

**Verify:**

```text
py_compile: pass
targeted flatten/resize: 73 pass
git diff --check: pass
```

## GS-B1 — Hợp đồng render theo chất lượng

**Trạng thái:** hoàn tất

**File:**

- `backend/app/core/separations.py`
- `backend/app/schemas/preflight.py`
- `backend/app/api/routes/preflight.py`
- `desktop/src/components/OutputPreviewTab.tsx`
- `backend/tests/test_print_engine_routing.py`

**Thay đổi:**

- Thêm `render_mode=accurate|approximate` xuyên UI → route/schema → engine.
- Output Preview không còn gửi `use_gs` hoặc hiển thị nhãn engine legacy.
- Giữ alias cũ đúng một lô để chuyển test/caller mà không tạo khoảng gãy.
- Test khóa accurate gọi PPE, approximate bỏ qua PPE và PPE unavailable hạ nhãn.

**Verify:**

```text
py_compile: pass
print-engine routing + no-GS: 30 pass
```

## GS-B2 — Xóa alias và runner separation chết

**Trạng thái:** hoàn tất

**Các lô con (mỗi lô ≤5 file):**

- `GS-B2A`: route/schema, caller Imposition và rule TAC chuyển sang
  `render_mode`.
- `GS-B2B`: test ICC/channel bỏ skip và tham số legacy.
- `GS-B2C`: `separations.py` xóa alias cùng toàn bộ TIFFSEP runner không có
  production caller.

**Thay đổi:**

- Không còn `use_gs`, `use_ghostscript` hoặc `_run_ghostscript_tiffsep` trong
  backend/desktop.
- TAC chỉ tin PPE khi facade xác nhận lượng mực chắc chắn; PDFium xấp xỉ tiếp tục
  fail-loud thay vì kết luận đạt sai.

**Verify:**

```text
py_compile: pass
separation/ICC/no-GS/routing: 48 pass
rg legacy contract: 0 hit
git diff --check: pass
```

## GS-C1 — Payload và verifier bắt buộc

**Trạng thái:** hoàn tất

**File/target:**

- `build_production.ps1`
- `desktop/src-tauri/tauri.conf.json`
- `scripts/verify_installed_artifact.ps1`
- `backend/tests/test_release_no_gs_policy.py`
- `desktop/src-tauri/binaries/gs/NO_GHOSTSCRIPT.txt` (marker ignored đã xóa)

**Thay đổi:**

- Build không còn dò/copy Ghostscript hoặc tạo thư mục marker.
- Tauri không bundle resource glob `binaries/gs/**/*`.
- Build staging và verifier cài đặt luôn từ chối binary/NOTICE GS, không cần cờ
  tùy chọn và không tin marker tự khai.

**Verify:**

```text
PowerShell parser: pass
Tauri JSON: pass
release policy: 30 pass
staging scan: STAGING_NO_GS_OK
git diff --check: pass
```

## GS-C2 — Môi trường phát triển và README

**Trạng thái:** hoàn tất

**File:**

- `setup_dev_env.ps1`
- `README.md`
- `.env.example`
- `.gitignore`
- `backend/tests/test_release_no_gs_policy.py`

**Thay đổi:**

- Setup dev không còn kiểm tra/cài engine ngoài; quy trình được đánh lại thành 6
  bước.
- README và mẫu biến môi trường chỉ mô tả PPE, PDFium và ICC hiện hành.
- Xóa ignore installer cũ và thêm policy regression ngăn cấu hình setup quay lại.

**Verify:**

```text
PowerShell parser: pass
release policy: 36 pass
setup/docs scan: 0 hit
git diff --check: pass
```

## GS-C3 — Xóa cờ release legacy

**Trạng thái:** hoàn tất

**File:**

- `build_production.ps1`
- `release_update.ps1`
- `scripts/verify_artifact_clean_user.ps1`
- `scripts/gen_third_party_notices.py`
- `backend/tests/test_release_no_gs_policy.py`

**Thay đổi:**

- Xóa `-NoGhostscript`, `-ExpectNoGhostscript` và `--no-ghostscript`; PPE-only
  là bất biến chứ không còn là lựa chọn của caller.
- NOTICE luôn lấy dữ liệu `bundled` làm nguồn sự thật; component
  `bundled=false` tự bị loại.

**Verify:**

```text
py_compile generator/test: pass
release policy + PowerShell parser: 40 pass
```

## GS-E3A — Tách hợp đồng engine nội bộ khỏi module Ghostscript

**Trạng thái:** hoàn tất

**File:**

- `backend/app/core/engine_support.py`
- `backend/app/core/action_engine.py`
- `backend/app/core/ink_manager.py`
- `backend/app/core/pdfx_export.py`
- `backend/app/api/routes/pdf_tools.py`

**Thay đổi:**

- Đưa `InternalEngineUnsupported` và thông điệp fail-closed sang module trung lập,
  không còn buộc các đường native/PPE phải import module khám phá Ghostscript cũ.
- Giữ nguyên hợp đồng từ chối an toàn và nội dung hướng dẫn người dùng.

**Verify:**

```text
py_compile: pass
action/PDF-X/ICC regression: 49 pass
```

## GS-F1 — Dọn helper chết và mô tả fallback sai trong backend

**Trạng thái:** hoàn tất

**File:**

- `backend/app/core/icc_profiles.py`
- `backend/app/core/outline_text.py`
- `backend/app/core/pdf_actions_native.py`
- `backend/app/core/print_engine/facade.py`
- `backend/app/workers/die_detection.py`

**Thay đổi:**

- Xóa `ghostscript_color_args()` không còn caller.
- Thay các mô tả “fallback sang Ghostscript” còn mang nghĩa runtime bằng hợp đồng
  hiện hành: từ chối an toàn hoặc hạ nhãn sang chế độ xấp xỉ có công khai.
- Giữ các phép đo đối chứng lịch sử có giá trị kỹ thuật.

**Verify:**

```text
py_compile: pass
ICC/outline/PPE/die-detection: 73 pass; 1 Hypothesis health-check nhiễu
rerun đúng seed của ca nhiễu: 1 pass
```

## GS-F2 — Dọn mô tả renderer cũ ở frontend

**Trạng thái:** hoàn tất

**File:**

- `desktop/src/components/acrobat/ThumbSidebar.tsx`
- `desktop/src/components/workspace/LivePageFrame.tsx`
- `desktop/src/lib/processHandlers.ts`

**Thay đổi:**

- Thumbnail chỉ mô tả đúng nguồn PDFium dùng chung với trang chính; không còn chú
  thích về fallback renderer đã bị vô hiệu hóa.
- Cập nhật mô tả viewer và resize sang backend/PDFium hiện hành.

**Verify:**

```text
frontend Ghostscript/legacy-contract scan: 0 hit
```

## GS-E2 — Xóa telemetry, giữ tripwire tối thiểu

**Trạng thái:** hoàn tất

**Các lô con:**

- `GS-E2A`: xóa `backend/app/core/gs_usage.py`, rút gọn `run_hidden()` và viết
  lại test telemetry thành test tripwire; dọn counter khỏi survival suite.
- `GS-E2B`: dọn counter/cấu hình cũ khỏi golden preflight và outline native.

**Thay đổi:**

- Không còn ghi `gs_usage.jsonl`, counter trong RAM hoặc endpoint phụ thuộc số đo
  không thể tăng.
- Tripwire nhận đúng stem executable trên đường dẫn Windows/POSIX và chặn trước
  `subprocess.run`; công cụ ngoài khác giữ nguyên hợp đồng.

**Verify:**

```text
tripwire + survival: 39 pass
golden preflight + outline native: 40 pass
```

## GS-E3B/C — Xóa discovery/config và nối lại release gate

**Trạng thái:** hoàn tất

**File chính:**

- `backend/app/config.py`
- `backend/app/core/gs_availability.py` (đã xóa)
- `backend/tests/test_gs_availability.py` (đã xóa)
- `scripts/gs_dependency_audit.py`
- `backend/tests/test_release_no_gs_policy.py`

**Thay đổi:**

- Xóa `_find_ghostscript`, marker payload, field `GHOSTSCRIPT_PATH` và mọi cấu
  hình fallback cũ.
- Cổng corpus bắt trực tiếp `GhostscriptBlocked`; vẫn giữ schema `gs_calls` để
  artifact lịch sử/resume tương thích nhưng không còn telemetry runtime.
- Biến môi trường legacy không thể dựng lại field cấu hình hay thay engine.

**Verify:**

```text
py_compile: pass
tripwire + release policy + corpus audit tests: 62 pass
git diff --check: pass
```

## GS-E1 — Xóa API telemetry orphan

**Trạng thái:** hoàn tất

- Xóa endpoint `/system/gs-usage` và schema không có frontend consumer.
- API contract regression: **59 pass**.

## GS-E3A2 — Nối route Preflight sang hợp đồng engine trung lập

**Trạng thái:** hoàn tất

- `backend/app/api/routes/preflight.py` không còn import module availability cũ;
  các nhánh unsupported dùng `app.core.engine_support`.
- `py_compile`: **pass**.

## GS-F4 — Dọn metadata, i18n và công cụ đối chứng

**Trạng thái:** hoàn tất

- Cập nhật `bundled_components.json` theo kiến trúc hiện tại nhưng giữ record
  `bundled=false` làm bằng chứng pháp lý.
- Xóa key i18n PDF/X lỗi thời; đổi biến đường dẫn của công cụ golden thành
  `PPE_GOLDEN_GHOSTSCRIPT_PATH` để không giả là cấu hình runtime.
- Dọn mô tả parser/action còn mang nghĩa fallback.

**Verify:** JSON parse, Node syntax, py_compile và golden helper **2 pass**.

## GS-F5 — Dọn hợp đồng fallback sai trong Rust PPE

**Trạng thái:** hoàn tất

- Comment/test hiện hành dùng đúng hợp đồng `unsupported`/fail-closed; các phép
  đo so renderer tham chiếu vẫn giữ nguyên.
- `cargo check`: **pass**.
- CCITT + shading + tiling + transparency: **74 pass**.

## GS-F6 — Xóa code cách ly và nguồn ICC ngoại lai

**Trạng thái:** hoàn tất

- Xóa 5 file trong `attic/gs-sunset-2026-07-28`; code đã chết này có thể phục
  hồi từ lịch sử Git nhưng không còn nằm trong cây dự án hiện hành.
- Xóa `/usr/share/ghostscript` khỏi nguồn tìm ICC; bundle FOGRA39/sRGB tiếp tục là
  nguồn xác định cho sản phẩm.
- ICC/color preview: **14 pass**.

## Nghiệm thu source cuối chiến dịch

**Quét bất biến:**

- Production contract/discovery/caller: **0 hit**.
- Caller `run_hidden()` ngoài chính tripwire: **0 hit**.
- Tauri staging: **0 binary**, **0 NOTICE hit**, không có thư mục `binaries/gs`.
- Smoke corpus thật: **1 OK, 0 REFUSED, 0 GS, 0 ERROR, 0 TIMEOUT**.

**Kiểm thử:**

- Backend full suite: **2.533 pass**, 2 test Overprint stale còn monkeypatch
  `run_hidden` đã xóa; sau khi dọn, toàn tệp Overprint **3 pass**.
- Release policy + corpus + tripwire: **62 pass**.
- Frontend: `typecheck` **pass**, Viewer/Output Preview **37 pass**.
- Rust PPE: `cargo check` **pass**, integration **74 pass**.
- PowerShell parser, JSON, Node syntax và `git diff --check`: **pass**.

**Bằng chứng còn thiếu:** chưa build installer mới từ worktree hiện tại, nên chưa
nâng trạng thái `ARTIFACT`/installed smoke. Không dùng rc.4 cũ để thay cho bước này.
