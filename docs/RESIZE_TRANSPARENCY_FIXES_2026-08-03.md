# TIẾN ĐỘ SỬA RESIZE TRANG CÓ VÙNG TRONG SUỐT

**Ngày:** 2026-08-03
**Báo cáo gốc:** `docs/BAO_CAO_AUDIT_RESIZE_TRANSPARENCY_2026-08-03.md`

## Trạng thái

- [x] Chốt hành vi và bằng chứng nguyên nhân.
- [x] Lô 1 — inspection backend theo từng trang.
- [x] Lô 2 — engine giữ page box mặc định và bảo toàn alpha.
- [x] Lô 3 — UI/API/i18n.
- [x] Verify cuối và smoke backend trên file Combine thực tế.

## Nhật ký

### 2026-08-03 — Chốt audit

- Xác nhận Combine giữ `100 × 100 mm` và `/SMask`; lỗi tỷ lệ phát sinh ở Resize content-aware.
- Chốt cờ `resize_by_content=false` mặc định và nhận diện dựa trên object graph PDF, không dựa vào đuôi file.
- Cô lập phạm vi khỏi nhóm thay đổi khuôn bế/logo đang có trong working tree.

### Lô 1 — Inspection backend (§TR.5)

- `backend/app/core/pdf_actions_native.py`: tách detector theo từng trang; duyệt image `/SMask`, `/Mask`, ExtGState, transparency group, Form XObject lồng và annotation appearance từ cây nội dung đang dùng.
- `backend/app/api/routes/pdf_tools.py`: thêm endpoint inspection nhận path local hoặc upload; dùng threadpool nhẹ, không chiếm heavy-job slot.
- `backend/tests/test_resize_edge_background.py`: khóa PDF hỗn hợp opaque + alpha trực tiếp + alpha nằm trong Form XObject và hợp đồng JSON 1-based.
- Verify: `py_compile` đạt; `pytest backend/tests/test_resize_edge_background.py -q` đạt **44/44**.

### Lô 2 — Engine resize (§TR.1–§TR.3)

- `backend/app/workers/resize_background_engine.py`: trang alpha mặc định dùng toàn `CropBox/MediaBox`; chỉ dò/crop nội dung khi `resize_by_content=true`. Trang opaque giữ hành vi content-aware cũ.
- `backend/app/workers/pdf_tools_engine.py`: nhận cờ mới, phát hiện alpha một lần, cưỡng chế Form/XObject và chỉ cho downsample object-level giữ SMask; không raster RGB/fallback Ghostscript.
- `backend/app/api/routes/pdf_tools.py`: route Resize nhận và chuyển tiếp `resize_by_content=false`.
- `backend/tests/test_resize_edge_background.py`: khóa tỷ lệ page box/content box, PDF hỗn hợp, bảo toàn `/SMask`, chặn raster/GS và forwarding route.
- Verify: `py_compile` đạt; resize alpha **47/47**; nhóm `test_resize_smart.py`, `test_pdf_tools.py`, `test_no_ghostscript_survival.py` đạt **63 pass, 1 skip**.

### Lô 3A — Transport, handler và state (§TR.4)

- `desktop/src/lib/api.ts`: thêm inspection API và gửi `resize_by_content` tường minh.
- `desktop/src/lib/processHandlers.ts`: bật cờ thì luôn dùng backend; mọi nhánh fallback đều chuyển tiếp cùng giá trị.
- `desktop/src/components/imposition-tools/store/slices/preprocSlice.ts`: mặc định `resizeByContent=false`.
- Test API/handler đạt **19/19** trong lượt verify của sub-lô.

### Lô 3B — UI và i18n (§TR.4)

- `PageResizerTool.tsx` nhận file hiện tại, inspection có AbortController và chỉ hiện checkbox khi có trang transparency.
- `PreprocessingRouter.tsx` chuyển đúng `pdfFile`; tiếng Việt/Anh mô tả rõ giữ khổ trang khi tắt và bám con tem khi bật.
- Typecheck đạt; bộ API/handler/UI cuối đạt **31/31**.
- Characterization toàn store còn hai snapshot fail do drift có sẵn ngoài phạm vi (`mixedExcessPercent`, `autoTrimBefore/bgFill*`); không cập nhật vàng hàng loạt. Mặc định mới có assertion riêng đạt.

### Smoke file Combine thực tế

- Nguồn: 72/72 trang có transparency, 301.879.277 byte.
- Khóa chiều rộng 50 mm, áp dụng trang 1: tắt cờ → `50 × 50 mm`; bật cờ → `50 × 59,413 mm`.
- Cả hai output vẫn nhận diện transparency ở trang 1; thời gian lần lượt 0,617 s và 0,619 s.
- Đã xóa hai output smoke khoảng 300 MB/file sau kiểm tra.
