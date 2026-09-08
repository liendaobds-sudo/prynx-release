# Nhật ký sửa Xuất ảnh — chất lượng chữ và artifact — 2026-09-08

Phạm vi: các finding `EXIMG-01…EXIMG-10` trong
`docs/BAO_CAO_AUDIT_XUAT_ANH_CHAT_2026-09-08.md`. Mỗi lô không quá 5 file và
được verify trước khi chuyển lô kế tiếp.

## Lô A — anti-alias CMYK (đã áp)

- `print_engine/src/content/interp.rs`: thêm cấu hình `RenderOptions::cmyk_export()`;
  giữ anti-alias cho bitmap nhưng vẫn gộp spot ở bước xuất.
- `native/src/print_engine_py.rs`: `ppe_export_cmyk` dùng cấu hình export riêng,
  không dùng `ink_accurate()` của TAC/separations.
- `print_engine/tests/render_page.rs`: regression phân biệt ink mode nhị phân và
  CMYK export có pixel biên trung gian.
- `backend/tests/test_export_images.py`: fixture chữ Việt nhúng DejaVuSans kiểm
  output native có anti-alias.

Verify Lô A:

- Rust regression: đạt.
- Native wheel build với `CARGO_TARGET_DIR=tmp/target-lota-native`: đạt; cài vào
  `backend/venv` sau khi cấp quyền ghi.
- `pytest backend/tests/test_export_images.py`: **35 passed** sau native build.
- Probe native thật: CMYK `partial=[0,4281,4281,0]` (trước sửa mọi kênh `0`).

## Lô B — UserUnit và RAM admission (đã áp)

- `backend/app/api/routes/export.py`: đọc `/UserUnit` theo trang; nhân vào scale
  PDFium và DPI hiệu dụng PPE; lưu metadata DPI vẫn là DPI vật lý người dùng chọn.
- Thêm ước lượng peak theo pixel/kênh, truyền `memory_required_mb` và
  `memory_budget_provider` vào `heavy_job_scheduler`; hủy khi đang chờ admission.
- Bổ sung bắt lỗi `HeavyJobMemoryUnavailable` thành HTTP 422.
- Sửa regression test TrimBox bị đặt nhầm sau `pytest.raises`; thêm test UserUnit
  và test estimate trang lớn.

Verify Lô B:

- `pytest backend/tests/test_export_images.py`: **39 passed** ở verify cuối.
- `py_compile` route/test: đạt.
- Probe `/UserUnit=2` RGB @72 DPI: output `200×100` từ trang raw `100×50`.
- Scheduler/PPE regression: **37 passed** (`test_heavy_job_scheduler.py`,
  `test_heavy_scheduler_kind_gate.py`, `test_ppe_memory_budget.py`).

## Lô C — Fidelity font và CMap (đã áp)

- `print_engine/src/text/font.rs`: chỉ nhận named CMap `Identity-H`; CMap Type0
  dựng sẵn không có bảng và stream nhúng malformed được đánh dấu unsupported,
  không rơi về identity để vẽ nhầm glyph.
- `print_engine/src/content/interp.rs`: khi glyph thực sự được dùng, chặn CMap
  unsupported và tăng `dropped_objects`/`missing_glyphs` để fail-closed; không hạ
  trust cho font chỉ được khai nhưng không dùng. Cảnh báo fallback cũng được dời
  từ `Tf` sang glyph thật, tránh từ chối oan PDF khai Helvetica không dùng.
- `print_engine/tests/render_text.rs`: thêm regression Identity-H giữ nguyên và
  UniJIS/unsupported không vẽ dù có fallback font.

Verify Lô C:

- `cargo test ... text::font --lib`: **15 passed**.
- `cargo test ... --test render_text`: **18 passed**.
- Native wheel đã rebuild/cài lại sau thay đổi CMap.

## Lô D — Frontend lifecycle/estimate (đã áp)

- `desktop/src/components/workspace/ExportImageModal.tsx`: giữ `busy` và
  `abortRef` tới khi promise cũ settle; Hủy→Xuất lại không khởi động worker chồng.
  Estimate có dependency `includeBleed`, ưu tiên Media/Trim dimensions khi caller
  cung cấp và hiển thị ghi chú khi chỉ có khổ active; key đã thêm đủ ở locale vi/en.
- `desktop/src/components/workspace/ExportImageModal.test.ts`: deferred cancel,
  recompute Include Bleed và ưu tiên box dimensions.

Verify Lô D:

- `npx vitest run src/components/workspace/ExportImageModal.test.ts`: **10 passed**.
- `npm run typecheck`: đạt.

## Lô E — Policy output/parity (đã áp ở mức hiển thị + regression)

- `ExportImageModal` và locale vi/en công khai rằng vùng trong suốt được ghép
  trên nền trắng, không giữ alpha; annotation/widget phải dẹt vào nội dung PDF
  trước khi xuất.
- PDFium RGB/Gray tắt annotation/widget để thống nhất policy với CMYK PPE;
  LCD giữ là policy display-only của Viewer, export dùng anti-alias tiêu chuẩn.
- `backend/tests/test_export_images.py` khóa output transparent RGB là opaque
  và cờ `draw_annots=False` của đường export.

Verify Lô E:

- Test transparent/annotation export nằm trong nhóm `test_export_images.py`;
  toàn nhóm hiện **39 passed**; nhóm export/scheduler/PPE cuối **154 passed**.
- Probe route thật JPEG CMYK với chữ Việt nhúng: `1250×833`, mode CMYK, ICC có mặt;
  không còn từ chối oan vì `Tf` Helvetica chưa vẽ glyph.
- Sau bổ sung locale estimate: toàn bộ frontend Vitest **310 files / 3448 passed /
  2 skipped**.
- `npm run lint` không có lỗi trong các file Lô D/E; còn 2 lỗi baseline ngoài phạm
  vi tại `LayerPanel.tsx` và `api.mergeManifest.test.ts`.
- `npm run build`: đạt (Vite build production); chỉ còn warning chunk/dynamic-import baseline.
- `npm run lint:budget`: chưa đạt vì ESLint toàn repo không trả JSON do lỗi baseline.

## Trạng thái tiếp theo

- Cần chạy `run_dev.bat`/bản đóng gói và thao tác lại đúng PDF thật để xác nhận
  runtime UI, JPEG CMYK và các PDF có UserUnit/Type0/transparency.
- EXIMG-05 của đường RGB PDFium còn là proof gap chưa tái hiện trên PDF gốc;
  không thêm chốt từ chối font thiếu theo suy đoán.
