# NHẬT KÝ SỬA HIỆU NĂNG COMPARE TRANG LỚN — 2026-08-19

Nguồn duyệt: `BAO_CAO_AUDIT_HIEU_NANG_COMPARE_TRANG_LON_2026-08-19.md`.

## Lô 0 — DPI + gộp render CMYK

- `CompareTab.tsx`: thêm 72/100/117 DPI để cảnh báo DPI an toàn có lựa chọn thực tế.
- `pdf_processor.py` + `comparison_engine.py`: RGB/CMYK dùng chung một bitmap PDFium.
- Đo 8 trang @150 DPI: `0,570 s → 0,358 s` (`1,59×`), hash RGB/CMYK trùng.
- Verify: 56 test Compare/API đạt; typecheck, ESLint hẹp và py_compile đạt.

## Lô 1 — Primitive render vùng (§CL.1)

- `PDFDocumentReader.page_pixel_size()` thống nhất kích thước raster theo DPI.
- `PDFDocumentReader.render_page_region()` nhận tọa độ pixel gốc trên-trái, chuyển
  sang crop point của PDFium và giữ toàn bộ vòng đời page/bitmap trong khóa.
- Test parity gồm tile góc trên-trái, giữa trang, mép phải-dưới, full-page và CMYK;
  vùng vượt biên phải fail-fast.
- Verify hẹp: `7 passed`; `py_compile` và `git diff --check` đạt.

## Lô 2 — Comparator tile parity (§CL.2)

- Registration được tách thành `estimate_translation()`: tính một lần trên preview,
  quy đổi về full-size rồi áp thống nhất cho mọi tile; STRICT tiếp tục không align.
- Overlap tự cộng bán kính morphology, nội suy và độ dịch. Chỉ core mask được tính
  vào kết quả nên không đếm pixel trùng.
- Core mask được ghi vào `memmap` disk-backed rồi chạy đúng contour toàn trang; nhờ
  vậy `area`, severity và clustering trùng full-frame mà RAM không giữ mask resident.
  `collect_diff_mask` chỉ bật trong test parity.
- Verify hẹp: `31 passed`; mask tile trùng từng pixel với full-frame trên STRICT,
  NORMAL, LOOSE, nét 1 px xuyên biên, vùng góc/mép và translation 2 px/1 px.

## Lô 3 — Tích hợp engine và artifact (§CL.3)

- Engine chọn tile khi cặp trang 1:1 có cùng kích thước raster và vượt ngưỡng
  40 MP; cặp bình bài/co giãn vẫn giữ comparator cũ để không đổi semantics.
- Preview được render ở DPI thấp riêng; ảnh A/B full DPI chỉ được đọc qua
  `render_page_region()`. Pipeline nhiều worker cũng truyền page index, không truyền
  bitmap lớn; các lời gọi PDFium tiếp tục nằm trong `pdfium_guard()` của reader.
- Highlight PNG được ghi theo stripe bằng file staging `.part` rồi atomic replace;
  GIF lấy preview tối đa 1.200 px. URL/schema PageResult không đổi.
- RAM-gating tile: mặc định 1.024 px trên máy <8 GB, 1.536 px trên máy <16 GB,
  2.048 px trên máy từ 16 GB; có env override để benchmark.
- Verify hẹp: `11 passed` cho comparator/artifact tile và `16 passed` cho route queue,
  trong đó ca metadata khoảng 66 MP được nhận job thay vì 413.
- Smoke engine thật 65.633.750 px @150 DPI: job `completed`, phát hiện đúng một
  vùng 84×84 px, PageResult `fail`, PNG 8.750×7.501 px được sinh thành công.
- Benchmark process sạch cùng trang 65,63 MP sau parity contour toàn trang: tile +
  PNG `2,90 s`, peak working set `273,6 MiB`; full-frame cũ `5,25 s`, peak
  `3.263 MiB` — giảm RAM khoảng `11,9×` và nhanh hơn khoảng `1,8×` trên corpus đo.
- Admission đĩa tính số mask uint8 theo đỉnh process đồng thời (một mask/worker) và
  kiểm volume TEMP riêng với volume artifact; staging tự xóa khi compare/hủy/lỗi.

## Lô 4 — Render/compare đa tiến trình 1:1 (§CL.4)

- Process worker là hàm top-level tương thích Windows `spawn`/Nuitka; mỗi process
  tự mở A/B và có PDFium riêng, chỉ nhận path + page index, không IPC bitmap.
- Worker render + compare + encode/ghi artifact; process chính nhận result nhẹ và
  commit PageResult đúng thứ tự. URL `/results` chỉ được ký ở process chính vì token
  sidecar không được phát tán sang worker.
- RAM-gating dùng planner chuẩn dự án: `<8 GB` 1 process, `<16 GB` tối đa 2, từ
  `16 GB` dùng CPU-1. Workload-gating mặc định chỉ bật process khi có ít nhất 16 trang
  và raster lớn nhất từ 8 MP; trang nhẹ giữ pipeline thread hiện hữu.
- Parity process đã test cả full-frame lẫn tile: verdict, region, summary và hash
  PNG/GIF trùng đường tuần tự.
- Benchmark 20 trang A4 @300 DPI (~8,7 MP/trang): CPU-1 `9,34 s` so với tuần tự
  `12,80 s` (`1,37×`), parity artifact `True`; peak tổng cây process `3.507 MiB`.
- Benchmark xác nhận gate trang nhẹ 20 trang @150 DPI giữ thread: 4 worker `2,17 s`
  so với tuần tự `4,46 s` (`2,06×`), peak `349,2 MiB`, parity `True`.

## Verify cuối

- Backend Compare/API/disk admission/cancel cleanup: `109 passed`.
- Frontend: `npm run typecheck` đạt; ESLint hẹp `CompareTab.tsx` đạt.
- Smoke engine 65,63 MP @150 DPI đạt; route nhận metadata ~66 MP ở nguyên 150 DPI.
- `py_compile` và `git diff --check` đạt; hai warning test còn lại là deprecation
  hiện hữu của Pydantic config và Starlette/httpx, không phát sinh từ lô này.

## Phụ lục mở rộng 2026-08-20 — CMYK, khác khổ và bình bài

### Lô A — CMYK ROI (§CMYK.TILE)

- RGB full-DPI theo tile tiếp tục là nguồn verdict; CMYK không còn bị loại khỏi
  chiến lược tile. Sau khi có `DiffRegion`, comparator chỉ render ROI C/M/Y/K của
  hai trang và giữ nguyên mean/channel threshold `>5`, mô tả và `type="cmyk"`.
- Cặp CMYK nhiều trang đủ nặng được phép dùng process pipeline; worker vẫn mở PDF
  riêng và chỉ ký URL ở process chính.
- Parity đã kiểm tra mask, bbox, mô tả Δ từng kênh và PNG highlight.

### Lô B — Hai trang khác kích thước (§DIFF-SIZE.TILE)

- Nhánh pad dùng reader trả trắng ngoài biên, giữ nguyên gốc trên-trái và không ép
  méo nội dung.
- Nhánh cùng aspect dùng source/destination RGB memmap trên TEMP và
  `cv2.resize(..., INTER_AREA)` vào khung đích; artifact đọc đúng ảnh B sau resize.
- Admission đĩa đã tính thêm staging RGB tối đa bên cạnh mask; process worker và
  thread pipeline dùng cùng kế hoạch kích thước.
- Parity E2E đã phủ resize và pad, gồm PNG, process-spawn và cancel staging.

### Lô C — Bình bài/N-up preview + ROI (§IMPOSITION.TILE)

- `matchTemplate` chạy trên preview giới hạn; box/scale được quy đổi về DPI thật.
- Mỗi bản trên tờ chỉ đọc ROI, giữ nguyên xoay, align, morphology, lọc contour AA,
  micro-rescue, clustering, `total_instances`, `failed_instances`, confidence và
  `match_scale`.
- Tờ imposed lớn không còn gọi render full DPI. Template lớn được dựng vào memmap;
  artifact PNG đọc theo stripe và vẫn vẽ khung xanh/đỏ từng bản cùng vùng lỗi.
- E2E tờ 6.000×8.000 pt đạt với preview + `render_page_region`; parity artifact nhỏ
  đạt giữa full-frame và tile.

### Verify phụ lục

- Nhóm Compare mở rộng: `89 passed`.
- Process-spawn CMYK và khác khổ: đạt parity verdict/region/summary/artifact.
- Bình bài preview/ROI: đạt parity instance/statistics và artifact tracking boxes.
- `py_compile` và `git diff --check` đạt; warning còn lại là deprecation Pydantic
  hiện hữu.
