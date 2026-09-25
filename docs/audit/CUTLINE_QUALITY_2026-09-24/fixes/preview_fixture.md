# Fixture preview classic — 2026-09-24

Full suite root phát hiện hai ca `original-true`/`alpha-false` của
`test_execute_classic_tai_dung_artifact_preview_khong_detect_hoac_fit_lan_hai` lỗi.
Đã chạy riêng trước sửa: **2 failed, 61 deselected**, 2,79 s; lỗi
`pikepdf.PdfError: unable to find trailer dictionary` tại
`normalize_sticker_tight_crop_origin` do engine stub copy một file chỉ có header
`%PDF-1.4`, không có cấu trúc PDF/trailer.

Đối chiếu `git show HEAD:backend/tests/test_sticker_cutline_preview.py` xác nhận
fixture header giả đã có trong HEAD. `git diff --quiet HEAD` cho
`backend/app/api/routes/pdf_tools.py` và `backend/app/workers/sticker_page_canvas.py`
đạt: route/parser production vẫn khớp HEAD, không đổi để né lỗi.

Sửa riêng test fixture `_prime_classic_preview_artifact`: dùng pikepdf sinh
PDF một trang hợp lệ 129,6 × 100,8 pt, khớp mask 180 × 140 px ở 100 DPI.
Title giữ marker `fixture` để ca thay byte cùng size/mtime tiếp tục đổi nội
dung thật, không vô tình thành phép replace không có tác dụng.
Giữ engine stub copy source, detect/fit monkeypatch `pytest.fail`, kiểm path
preview chỉ được dịch crop origin, alpha shape và output tồn tại. Thêm mở
PDF output thật để kiểm một trang/MediaBox đúng. Không monkeypatch hoặc tắt
canonicalize/normalize parser.

Verify sau: tất cả consumer của helper (hai ca tái dùng, hai ca stale
revision/fingerprint, hai ca snapshot A→B→A theo RAM và một ca same-stat):
**7 passed, 56 deselected**, một warning Pydantic cũ, **4,00 s**.
Theo yêu cầu root chạy riêng đúng hai ca lỗi ban đầu và lưu
`preview_fixture_recheck.xml` để đối chiếu JUnit bộ lớn đang chạy.
XML đủ bảy consumer: `preview_fixture_consumers_recheck.xml`; các lượt này
có cùng test nên không cộng tổng test thành các ca độc lập.
`git diff --check` riêng file test đạt. Không sửa production hoặc golden.
