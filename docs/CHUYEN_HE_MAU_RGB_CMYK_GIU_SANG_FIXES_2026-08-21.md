# Nhật ký sửa chuyển hệ màu RGB → CMYK giữ sáng — 2026-08-21

## Phạm vi

Audit unit W3-U05-R2: mở PDF RGB, xem trước, chuyển sang CMYK, tải và mở lại artifact. File kiểm chính là C:\Users\Khanh Pham\Desktop\rgb.pdf, SHA-256 DFFFC19FC447F6E6E66F1438D51A3838F2559DBE58FCB26436AA278980DE1358.

Mục tiêu là giữ appearance sáng/rực trong gamut của profile đích nhưng không đổi nhãn OutputIntent, không phát hành PDF residual RGB và không tự áp một preset có thể làm mất highlight. Đây không phải chứng nhận bản in hoặc “tối ưu tuyệt đối” cho mọi máy in.

## Lô A — Lab/vibrance

Files chính: backend/app/core/pdf_actions_native.py, backend/tests/test_action_engine_native.py, backend/tests/test_color_conversion_acceptance.py.

- Chuẩn hóa a*/b* Pillow LAB theo signed two’s-complement cho cả NumPy và fallback.
- Vibrance ưu tiên vùng ít bão hòa, có hướng đơn điệu; neutral không bị đẩy sai.
- Nếu adjustment không đổi pixel Lab, giữ byte CMYK nền để tránh drift lượng tử hóa ở neutral/highlight.
- Thêm regression lưới sRGB, ΔE00, TAC, clipping, OutputIntent và parity fallback.

## Lô B — Existing DeviceCMYK và OutputIntent

Files chính: backend/app/core/pdf_actions_native.py, backend/tests/test_action_engine_native.py.

- Quét usage reachable qua page/Form/Pattern/AP, XObject Do, scn/SCN, shading, inline image và SMask.
- Existing DeviceCMYK có OI matching được giữ; thiếu OI, OI xung đột hoặc nhiều OI ambiguous thì fail-closed trước khi ghi.
- Separation/DeviceN không recurse alternate để tránh biến spot thành process CMYK giả.
- Indexed/base CMYK, ảnh DeviceCMYK và Form reachable được hậu kiểm; unused resource không tự chặn.

## Lô C — DefaultRGB theo resource scope

Files chính: backend/app/core/pdf_actions_native.py, backend/tests/test_color_conversion_acceptance.py.

- DeviceRGB vector/image/Indexed-base lấy DefaultRGB của đúng page/Form/Pattern/AP scope.
- ICCBased hoặc CalRGB explicit không bị DefaultRGB ghi đè.
- DefaultRGB invalid, unsupported hoặc shared image dùng dưới hai fingerprint khác nhau đều fail-closed.
- Oracle AdobeRGB với mẫu (60,200,100) cho FOGRA39 [222,0,217,0], không còn bị ép qua sRGB [172,0,195,0].

## Lô D1 — Backend preview

Files chính: backend/app/core/color_conversion_preview.py, backend/app/schemas/preflight.py, backend/app/api/routes/preflight.py, backend/tests/test_convert_colors_preview.py.

- Thêm POST /api/preflight/convert-colors/preview; request extra=forbid và chỉ nhận rgb_to_cmyk, có thể kèm spot_to_cmyk.
- Mọi candidate PDF nằm trong TemporaryDirectory và được dọn ở success/error/cancel; không trả output_filename.
- Dùng converter production, SoftProofEngine PPE và SeparationEngine PPE; TAC chỉ cộng C/M/Y/K, spot báo riêng.
- Trả source/output/gamut preview, ΔL*, ΔC*, ΔE00 mean/P95, clipping, gamut và TAC.
- DPI gate theo RAM: dưới 8 GB tối đa 72, 8–16 GB tối đa 100, từ 16 GB giữ DPI yêu cầu.
- Balanced-v1 chỉ chọn candidate khi proof RIP và TAC PPE đáng tin; nếu không thì identity/unavailable.

## Lô D2 — Frontend preview

Files chính: desktop/src/components/preprocess-tools/ConvertColorsTool.tsx, desktop/src/components/preprocess-tools/PreprocessSuccessPersistence.test.tsx, desktop/src/i18n/locales/vi.json, desktop/src/i18n/locales/en.json.

- Bỏ preset tăng sáng toàn cục +2; thêm xem trước thông số hiện tại và gợi ý cân bằng trang.
- Preview lấy viewerActivePage, có AbortController, request id và fingerprint; response cũ không được ghi đè.
- Execute CMYK bị khóa tới khi preview còn fresh và gửi đúng effective_adjustments đã xem.
- Recommendation chỉ điền slider, không tự download/commit; UI hiển thị engine, accuracy, ΔL*/ΔC*/ΔE00, clipping, gamut và TAC.
- Cảnh báo rõ số đo là của trang đang xem, không suy ra toàn bộ tài liệu.

## Lô D3 — profile parity và ownership

Files chính: backend/app/api/routes/preflight.py, backend/app/core/ink_manager.py, backend/app/schemas/preflight.py, backend/tests/test_convert_colors_http_contract.py, desktop/src/components/preprocess-tools/ConvertColorsTool.tsx, desktop/src/components/preprocess-tools/PreprocessSuccessPersistence.test.tsx, backend/tests/test_convert_colors_preview.py.

- Bước Spot alternate Lab nhận cùng profile CMYK đã chọn ở bước RGB; caller độc lập vẫn giữ fallback FOGRA39.
- Fingerprint preview/upload dùng workspaceDocumentIdentity, bao file + page order + rotation; reorder/xóa/xoay buộc upload lại Working PDF.
- Execute có generation fence, AbortController và kiểm source ngay trước POST, trước download và trước onFileFixed; response cũ không được commit vào PDF mới.
- Recommendation context phải còn fresh, policy balanced-v1, proof RIP soft-proof và TAC PPE; schema validator chặn tổ hợp gates_passed mâu thuẫn.
- Regression khóa profile Spot, revision Working PDF, stale execute, stale recommendation và proof/TAC không tin cậy.

## Bằng chứng artifact

Probe độc lập conversion thật của rgb.pdf với FOGRA39, Relative+BPC, preserve black, post_cmyk, adjustments 0/0/0:

- supported=true, postflight passed, residuals rỗng; pikepdf.check() rỗng.
- PDF 2.577.097 byte; hai ảnh 1200×1200 DeviceCMYK/FlateDecode.
- OutputIntent duy nhất /N=4; ICC SHA-256 da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77.
- TAC raw trên 2.880.000 pixel: mean 126,209359%, P95 229,411765%, max 306,666667%; 474 pixel >300%, 0 pixel >320%.
- Hash nguồn trước/sau giống nhau; temp probe đã dọn.
- HTTP execute thật trả 200/success=true; download 200 application/pdf; chỉ có final PDF; reopen/postflight/OI/no-RGB đạt.

Lưu ý: TAC raw byte-level artifact và TAC PPE raster preview là hai measurement basis khác nhau.

## Verify

- Backend color gate: 134 passed, 2 warnings (Pydantic/Starlette deprecation).
- Frontend PreprocessSuccessPersistence.test.tsx: 18 passed.
- npm run typecheck: xanh.
- ESLint hai file frontend liên quan: xanh.
- git diff --check: xanh.

## Khoảng trống còn lại

- Preview hiện đo một trang rồi áp adjustment cho toàn file; chưa có aggregate gate đa trang.
- Chưa chạy Tauri exact-file với chính rgb.pdf, packaged installer, màn hình hiệu chuẩn, press proof hoặc spectrophotometer.
- Complex transparency, CalRGB BlackPoint/alpha/shading, profile giấy/file khách và điều kiện in thực tế vẫn HOLD.
- Relative+BPC + adjustment 0 là baseline tốt nhất đã đo trên fixture này; không gọi là preset sáng/rực nhất cho mọi artwork.
## Lô E — Preset ưu tiên rực màu (2026-08-22)

Files chính: desktop/src/components/preprocess-tools/ConvertColorsTool.tsx, desktop/src/components/preprocess-tools/PreprocessSuccessPersistence.test.tsx, desktop/src/i18n/locales/vi.json, desktop/src/i18n/locales/en.json.

- Thêm preset opt-in “Ưu tiên rực màu”, dùng Saturation + BPC của ICC để ưu tiên giữ chroma; Relative + BPC vẫn là mặc định.
- Preset tự mở tùy chọn nâng cao, đổi intent, dựng preview và giữ cảnh báo ΔE/TAC/gamut trước khi thực thi.
- Regression khóa intent saturation, state preview và auto-preview: 21 test frontend liên quan đạt.
- Smoke rgb.pdf trang 1, FOGRA39, 150 DPI: RIP soft-proof, ΔE00 TB 4,848, mất chroma 11,146 C*, highlight clipping mới 0,163%, TAC max 164,314%.
- Đây là trade-off có chủ ý; gamut-mapping thích nghi theo từng vùng và aggregate gate đa trang vẫn là hạng mục tiếp theo, không được gọi là “giống RGB 100%”.
## Lot F - Adaptive gamut mapping and source gamut warning (2026-08-22)

- Tach `gamut_mapping` khoi ICC rendering intent: `icc` giu duong cu; `adaptive_vivid` dung Relative + BPC + post-CMYK va fail-closed voi pre-ICC/Saturation. Preview va execute dung cung contract.
- Adaptive chon candidate theo L*/chroma/hue tung pixel, bao ve neutral, skin, paper white, shadow/highlight va TAC <= 320%; khong keo toan anh bang brightness offset.
- Gamut warning do tren raster RGB nguon; LittleCMS alarm la xam 127 (khong phai 0), nen metric khong con bao 0% gia.
- Artifact that `Desktop\\rgb.pdf`, trang 1, FOGRA39, 150 DPI: ICC baseline dL* -2.2344 / dC* -12.8308 / dE00 3.9418; adaptive dL* -2.1551 / dC* -11.4598 / dE00 4.1559. Highlight clip giu 2.9901%, TAC max khong tang (160.7843%), proof RIP va postflight deu dat.
- Day la muc tieu giu appearance tot hon trong gamut, khong phai cam ket tai tao neon RGB 100%; van can kiem nhieu trang va proof/in that.
