# Nhật ký xử lý Bù xén/Cutline — 2026-10-01

## Phạm vi

Đã xử lý theo báo cáo audit toàn diện: fan-out PDF, preview và export Bế 2 dao, stroke contract, page-box, cache/RAM, đường canonical cho ThruCut và khử bóng pixel viền PNG.

## Thay đổi chính

1. `sticker_engine.py`: truyền đủ tham số ThruCut qua ProcessPool; ghi cap/join PDF; dựng stream ThruCut riêng khi tách tem; nới crop theo vùng dao.
2. `sticker_cutline_preview.py` và `StickerSheetWorkspace.tsx`: dùng path canonical cho ThruCut, hỗ trợ rounded rectangle/ellipse/contour offset; giữ fallback tương thích.
3. `sticker_sheet.py`, route, `sticker_sheet_export.py`, API và store/panel: thêm cấu hình Bế 2 dao xuyên suốt Sticker Sheet, gồm lề bất đối xứng, bán kính, spot và màu CMYK.
4. `sticker_shadow_boundary.py` và `sticker_source_pipeline.py`: lọc bóng tối bán trong suốt ở vùng ngoài, giữ AA/viền thật/RGB; truyền `shadow_cleanup` từ detect và refine.
5. `sticker_cutline_preview.py` cache: ownership theo page/source revision và RAM tier; bỏ alpha fast path không dùng ở hook Classic.

### Bổ sung xử lý PNG không bù xén — 2026-10-01

- Phát hiện luồng cũ chỉ làm sạch mask dùng để nhận biên; khi `bleed_mm=0`,
  writer vẫn chép `/SMask` gốc của ảnh PNG vào PDF nên các pixel Alpha mờ có
  RGB trắng/đen/cyan/cam vẫn quay lại quanh mép.
- Thêm `sticker_alpha_cleanup.py`: xóa pixel Alpha bán trong suốt nối với
  nền ngoài, xử lý cả RGB ẩn tại Alpha=0, không đọc màu để quyết định biên,
  giữ nguyên RGB của pixel còn nhìn thấy và đệm **chỉ byte dưới Alpha=0** để
  nội suy PDF không kéo màu cũ trở lại. Không tạo lớp bù xén và không nới khổ
  trang.
- Preview PDF, nhận diện Alpha và `StickerEngine` dùng cùng bản trang đã thay
  `/SMask`; kích hoạt cho `cut_mode=alpha`, `alpha_source_mode` và canonical
  preview có `boundary_source=alpha`, kể cả `bleed_mm=0`.
- Bản làm sạch là PDF độc lập theo từng trang nên resource dùng chung với
  trang khác không bị sửa; vòng đời PDFium/PikePDF được đóng sau mỗi trang.

## Verify

- `backend\venv\Scripts\python.exe -m pytest -q backend/tests/test_sticker_cutline_preview.py backend/tests/test_sticker_split_thrucut_contract.py backend/tests/test_sticker_thru_cut_parallel_contract.py`: **75 passed**.
- `backend\venv\Scripts\python.exe -m pytest -q backend/tests/test_sticker_alpha_dark_shadow.py backend/tests/test_sticker_source_pipeline.py backend/tests/test_sticker_sheet_engine.py`: **100 passed**.
- Vitest nhóm preview/export/settings/API: **131 passed**; nhóm API/store: **49 passed**.
- `npm run typecheck`: **pass**; `py_compile`: **pass**.
- Regression PNG biên trong suốt: **7 passed**; kiểm trực tiếp PDF RGBA có
  `/SMask` nhiều vòng màu, preview render cùng mask và không có bù xén.
- Regression source/alpha/artwork: **114 passed** (gồm 7 test mới); alpha
  engine: **11 passed**;
  `py_compile` helper/source/engine/test: **pass**.

## Bằng chứng chưa có

Chưa chạy smoke test Tauri/Acrobat/Illustrator/WebView và chưa có ma trận artifact đủ mọi mode màu ở zoom 700–1600%. Không kết luận WYSIWYG/halo tuyệt đối cho các renderer đó cho đến khi có bước kiểm này.

Chưa có PNG người dùng cụ thể và chưa chạy smoke renderer Illustrator/Acrobat/WebView;
bằng chứng mới dùng fixture PNG RGBA tổng hợp với sáu màu Alpha fringe.
