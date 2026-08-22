# BÁO CÁO RE-AUDIT CHUYỂN HỆ MÀU RGB → CMYK GIỮ SÁNG — 2026-08-21

> Audit unit: **W3-U05-R2 — mở PDF RGB → Chuyển hệ màu → CMYK → tải/mở lại artifact**
>
> Trọng tâm: giữ độ sáng và độ nổi bật tối đa trong gamut in, đúng ICC/OutputIntent, không công bố artifact sai.
>
> Baseline: `HEAD f64bb6018415baa552da32eadffdcbb58c3d90eb`; engine màu chính ở commit `363af007064d99d35dfbf821900c12aa5182617c`.
>
> File thật: `C:\Users\Khanh Pham\Desktop\rgb.pdf`, SHA-256 `DFFFC19FC447F6E6E66F1438D51A3838F2559DBE58FCB26436AA278980DE1358`.
>
> Trạng thái sau triển khai: **artifact chuẩn của `rgb.pdf` đạt; Lô A–D3 đã sửa các finding correctness và thêm gate preview/ownership. Claim “giữ sáng/nổi bật nhất” vẫn HOLD cho toàn họ** vì preview mới đo một trang, chưa có Tauri exact-file với chính rgb.pdf, installer, màn hình hiệu chuẩn hoặc press proof.

## 1. Kết luận điều hành

Engine hiện tại đã tốt hơn rất nhiều so với baseline audit ngày 2026-08-20: route thật trả file, ICC nguồn nhúng được dùng, Relative+BPC đi tới LittleCMS, OutputIntent FOGRA39 được gắn và hậu kiểm, residual RGB/Lab bị chặn, page boxes được bảo toàn.

Trên chính `rgb.pdf`, **Relative Colorimetric + BPC, không tinh chỉnh** là intent trung thực nhất trong bốn intent đã đo:

- mean ΔL* `-0,999`: hơi tối trung bình khoảng 1 L*;
- mean ΔE00 `2,451`, thấp nhất bốn intent;
- chroma trung bình giảm `5,180` C* vì gamut FOGRA39 nhỏ hơn sRGB;
- TAC mean/P95/max `126,21 / 229,41 / 306,67%`;
- artifact mở lại sạch, đúng hai ảnh DeviceCMYK và một OutputIntent FOGRA39 `/N=4`.

Tăng sáng toàn cục `+2 L*` đưa mean ΔL* lên `+0,931`, nhưng mean ΔE00 tăng lên `3,526`, chroma giảm thêm và số pixel highlight bị clip tăng. Vì vậy **không nên đặt +2 làm mặc định**. Nếu buộc ưu tiên sáng trên riêng file này, `+1 L*` là mức thử thận trọng hơn, nhưng vẫn phải xem soft-proof.

Mục tiêu “nổi bật” hiện chưa đạt vì thanh **Độ rực màu** bị lỗi representation Lab: trên `rgb.pdf`, `vibrance -20`, `0`, `+5` và `+20` có thể cho pixel CMYK giống hệt nhau khi giữ cùng brightness. Ngoài ra còn hai lỗi profile có thể làm PDF khách khác sai màu âm thầm: relabel CMYK nguồn khi tài liệu mixed RGB+CMYK, và bỏ qua `/DefaultRGB` hợp lệ của PDF.

## 2. Phạm vi, trace và mức bằng chứng

### 2.1 Đường chạy live

1. Registry: `desktop/src/lib/toolRegistry.ts:293-304`.
2. Router UI: `desktop/src/components/imposition-tools/sections/PreprocessingRouter.tsx:252-253`.
3. Defaults + request: `desktop/src/components/preprocess-tools/ConvertColorsTool.tsx:145-260`.
4. Route được đăng ký: `backend/app/main.py:274-278`.
5. Schema: `backend/app/schemas/preflight.py:406-450`.
6. Handler: `backend/app/api/routes/preflight.py:1398-1592`; việc nặng chạy qua `asyncio.to_thread()` tại `:1477-1488`.
7. Engine/writer: `backend/app/core/pdf_actions_native.py:3421-3750`.
8. OutputIntent + hậu kiểm: `pdf_actions_native.py:3377-3418,3699-3748`.
9. Download: `backend/app/api/routes/preflight.py:432-453`.
10. Commit Working File: `desktop/src/components/ImpositionTab.tsx:1014-1180`.

Recipe dùng cùng endpoint tại `desktop/src/lib/recipe/recipeRunners.ts:153-190`; ActionEngine sibling tại `backend/app/core/action_engine.py:438-494`.

### 2.2 Cấu trúc file thật

- PDF 1.3, hai trang.
- Mỗi trang có một JPEG 1200×1200; hai ảnh trùng pixel.
- Hai ảnh là `/ICCBased`, ICC `sRGB IEC61966-2.1`, hash `2b3aa164…b949af7e`.
- Không OutputIntent, transparency, text, vector màu hoặc Spot.
- Do đó file này kiểm rất tốt lane ảnh ICCBased sRGB, nhưng không đại diện cho black K-only, Spot, transparency, mixed CMYK hoặc `/DefaultRGB`.

### 2.3 Mức bằng chứng

- Trace code: `TRACED`.
- Regression hiện hành: `AUTO`.
- Parse/decode/CMM/render file thật: `ARTIFACT`.
- HTTP route + download thật trên file: `RUNTIME-PARTIAL`.
- Chưa chạy thao tác Tauri exact-file, installer production, màn hình hiệu chuẩn hoặc bản in đo quang phổ.

## 3. Findings đã xác nhận

| ID | Mức | Finding | Bằng chứng | Effort |
|---|---:|---|---|---:|
| §COLOR.28 | **P1** | Thanh Độ rực sai/no-op trên production NumPy lane | code + artifact `rgb.pdf` | S |
| §COLOR.29 | **P1** | Mixed RGB+CMYK giữ số CMYK cũ nhưng thay OutputIntent sang profile mới | code + artifact SWOP→FOGRA39 | M–L |
| §COLOR.30 | **P1** | Bỏ qua `/DefaultRGB`, ép DeviceRGB hợp lệ qua sRGB | code + artifact AdobeRGB→FOGRA39 | M |
| §COLOR.31 | **P2** | Fallback không NumPy có encoding Lab khác production và làm sai màu nặng | code + probe 7 patch | S |
| §COLOR.32 | **P2** | Chưa có preview/gate theo file cho ba thanh; preset +2 làm clip highlight | UI + artifact `rgb.pdf` | M–L |

### §COLOR.28 — P1 — Độ rực dùng sai representation Lab

Production đóng gói NumPy tại `build_production.ps1:1040-1048`. Nhánh chạy thật lấy `np.asarray(lab_image)` tại `pdf_actions_native.py:1148`. Với Pillow mode `LAB`:

- `getpixel()`/`getdata()` biểu diễn neutral a/b là `128/128`;
- raw bytes/NumPy biểu diễn cùng neutral là `0/0` theo signed two’s-complement.

Probe cùng pixel xám cho `getpixel=(137,128,128)` nhưng `tobytes/np.asarray=[137,0,0]`. Code NumPy lại trừ `128` tại `:1155`, tính magnitude sai rồi clip weight vibrance về 0 tại `:1159-1162`.

Artifact trên `rgb.pdf`:

- cùng brightness `+2`, các mức vibrance `-20`, `0`, `+5`, `+20` cho hai decoded image stream cùng SHA-256 `69aa63092207bb1ef2011db514e13ff0e0e902d0afa670e2368153701e2ccd3b`;
- đối soát `+2/v0` với `+2/v4` và `+2/v8`: `0 / 2.880.000` pixel khác;
- engine vẫn trả `supported=true`, postflight sạch và echo đúng tham số, nên UI không biết adjustment đã vô tác dụng.

Test hiện chỉ khóa brightness, metadata, K-only và forwarding ở `backend/tests/test_action_engine_native.py:553-704`, `test_convert_colors_http_contract.py:166-174` và `PreprocessSuccessPersistence.test.tsx:181-190`; không assertion hướng/biên độ chroma.

### §COLOR.29 — P1 — Relabel CMYK nguồn trong PDF mixed

`k/K` được giữ nguyên tại `pdf_actions_native.py:2878-2885`, trong khi `_attach_cmyk_output_intent()` luôn thay OutputIntent toàn file bằng profile đích tại `:3377-3400`, được gọi vô điều kiện tại `:3699`.

Fixture có OutputIntent SWOP, một mảng `0.2 0.4 0.6 0.1 k` và một mảng RGB, yêu cầu FOGRA39:

- engine trả `supported=true`, postflight pass;
- toán tử CMYK cũ giữ nguyên byte;
- OutputIntent đổi từ SWOP hash `35f401…a0bf6` sang FOGRA39 `da2b9b…ce77`;
- cùng số CMYK bị diễn giải lại, lệch `ΔL*=+2,745`, `ΔE00=3,016`.

Đây là phần policy còn mở của §COLOR.06 trong báo cáo cũ. Test `test_action_engine_native.py:707-733` chỉ có tài liệu RGB + OutputIntent giả cũ, không có existing CMYK.

Bất biến cần chốt:

- nếu không có CMYK nguồn: attach profile đích như hiện tại;
- nếu CMYK nguồn có profile trùng đích: preserve numbers hợp lệ;
- nếu profile nguồn khác đích: phải transform CMYK nguồn→CMYK đích, hoặc fail-closed rõ ràng; không được chỉ đổi nhãn;
- nếu CMYK nguồn không có profile: cần policy explicit, không tự nhận đó là FOGRA39.

### §COLOR.30 — P1 — Bỏ qua `/DefaultRGB`

Chuẩn PDF cho phép `DefaultRGB` trong resource ColorSpace thay thế ý nghĩa DeviceRGB. Adobe PDF Reference mô tả substitution này; PDF 1.4 còn minh họa `DefaultRGB` là một không gian ba thành phần khác.

Engine hiện trả ngay default transform sRGB cho `/DeviceRGB` tại `pdf_actions_native.py:1422-1423`; toán tử `rg/RG` dùng transform đó tại `:2896-2900`. Vòng ảnh tại `:3547-3567` cũng không có context `/DefaultRGB`. Toàn repo hiện không có implementation/test `DefaultRGB`.

Fixture `/Resources/ColorSpace/DefaultRGB = ICCBased Adobe RGB 1998`, sample `(60,200,100)`:

- engine trả success + postflight pass;
- output là FOGRA39 `(172,0,195,0)`, đúng đường ép sRGB;
- reference dùng Adobe RGB đúng là `(222,0,217,0)`.

`rgb.pdf` của người dùng không kích hoạt ca này, nhưng PDF khách hợp lệ có thể sai màu âm thầm. Khi sửa phải truyền resource scope đúng qua page/Form/Pattern/AP và image; pattern anh em `DefaultGray`/`DefaultCMYK` cần quay lại trạng thái `[SUSPECTED]` rồi verify riêng.

### §COLOR.31 — P2 — Fallback không NumPy không tương đương

Nhánh fallback tại `pdf_actions_native.py:1169-1195` đọc `getdata()` theo representation offset-128 nhưng ghi lại bằng `Image.frombytes('LAB', ...)`, nơi a/b là raw signed. Probe ép không có NumPy trên bảy patch cho ΔE00 `26,17–73,78` so với lane production.

Release chuẩn có NumPy nên đây không phải P1 production, nhưng comment khẳng định sidecar tối giản vẫn chạy được hiện không đúng. Nên dùng một helper encode/decode Lab duy nhất cho cả hai lane, hoặc bỏ fallback và fail-loud nếu dependency bắt buộc thiếu.

### §COLOR.32 — P2 — Chưa có tối ưu file-specific/preview trước commit

UI mặc định ba thanh bằng 0 và có nút thử `+2`, nhưng adjustment chỉ được thấy sau khi chạy và commit artifact. Profile/intent được đồng bộ với Output Preview; riêng L*/contrast/vibrance chưa có preview/gamut/TAC/clipping live.

Trên `rgb.pdf`, `+2` sáng hơn nhưng tạo thêm highlight `L*=100` và paper-white; vì vậy một preset toàn cục không thể gọi là “tốt nhất” cho mọi file. Cần preview hoặc một policy adaptive có gate trước khi đổi Working File.

## 4. Đo định lượng trên `rgb.pdf`

### 4.1 Bốn rendering intent, adjustment = 0

Đo 2.685.220 pixel nội dung, source ICC→Lab D50 so với FOGRA39 CMYK→Lab D50, LittleCMS + BPC.

| Intent | Mean ΔL* | Mean / P95 ΔE00 | Mean ΔC* | Pixel mới L*≥99 | TAC mean / P95 / max |
|---|---:|---:|---:|---:|---:|
| **Relative+BPC** | **-0,999** | **2,451 / 7,468** | -5,180 | 25.508 (0,950%) | 126,21 / 229,41 / 306,67% |
| Perceptual+BPC | -1,715 | 2,613 / 8,254 | -5,058 | 86 (0,003%) | 128,19 / 229,80 / 305,49% |
| Saturation+BPC | -2,314 | 2,945 / 9,433 | **-4,393** | 86 (0,003%) | 129,51 / 229,80 / 304,31% |
| Absolute+BPC | +0,365 | 3,643 / 6,880 | -5,173 | 81.226 (3,025%) | 123,50 / 234,12 / 329,80% |

Relative+BPC thắng mean ΔE00 và ít tối hơn Perceptual/Saturation. Saturation giữ thêm khoảng `0,787 C*` nhưng tối hơn `1,315 L*` và P95 ΔE00 xấu hơn `1,965`. Absolute gần mean L* nguồn nhưng không phù hợp làm default conversion: mean ΔE cao, clip highlight 3,025% và có 1.612 pixel TAC >320%.

### 4.2 Thanh bù sáng post-CMYK

Số clip bên dưới tính trên một ảnh unique 1.342.610 pixel nội dung; file lặp ảnh đó hai lần. Source mean chroma `20,673 C*`.

| Bù L* | Mean ΔL* | Mean / P95 ΔE00 | Output chroma | Pixel mới L*≥99 / L*=100 | Paper-white mới | TAC max | Size PDF |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | -0,999 | **2,451 / 7,468** | **15,492** | 12.754 / 0 | 0 | 306,67% | 2.577.097 B |
| +1 | **+0,244** | 3,228 / 6,951 | 15,436 | 32.615 / 13.171 | 583 | 301,18% | 2.302.849 B |
| +2 | +0,931 | 3,526 / 6,575 | 15,246 | 45.274 / 13.915 | 626 | 298,82% | 2.294.387 B |
| +3 | +1,950 | 4,114 / 6,086 | 14,906 | 58.672 / 13.929 | 649 | 294,51% | 2.277.919 B |

Diễn giải:

- `0` giữ appearance trung bình tốt nhất, nhưng hơi tối khoảng 1 L*.
- `+1` cân mean brightness tốt nhất trên riêng fixture, đổi lại ΔE và clipping tăng.
- `+2/+3` không nên tự áp mặc định; chúng sáng hơn bằng cách đẩy vùng sáng tới trần và làm chroma giảm thêm.
- Độ rực không thể đánh giá sản phẩm cho tới khi §COLOR.28 được sửa.

### 4.3 Artifact integrity

Mọi output được test đều:

- `supported=true`, postflight pass, không residual RGB/CalRGB/Lab;
- hai ảnh `/DeviceCMYK /FlateDecode`, decode và PDFium render được;
- đúng một OutputIntent FOGRA39 `/N=4`, ICC SHA-256 `da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77`;
- giữ nguyên Media/Crop/Trim/Bleed/ArtBox của cả hai trang;
- HTTP POST trả 200, download `application/pdf` trả 200; ca +2 mất khoảng 1,329 s và artifact 2.294.387 byte.

Dung lượng baseline tăng từ `1.090.655` lên `2.577.097` byte (+136,3%) vì JPEG RGB được decode rồi ghi CMYK Flate lossless. Đây là trade-off dung lượng, không phải corruption.

## 5. Policy đề xuất cho mục tiêu “sáng, nổi bật nhưng in được”

1. **Profile đúng giấy/máy là điều kiện số 1.** FOGRA39 phù hợp offset giấy couché; không dùng nó như lựa chọn phổ quát cho giấy không tráng, báo hoặc máy kỹ thuật số có profile riêng.
2. **Default tiếp tục là Relative+BPC, adjustment 0.** Đây là cấu hình chính xác nhất trên file thật và corpus hiện hành.
3. **Không nâng sáng bằng offset L* toàn cục mặc định.** Sau §COLOR.28, thêm preset adaptive: bù vùng bị tối, giảm tác động gần paper white, giữ neutral/skin, rồi project về gamut đích.
4. **Vibrance phải gamut-aware.** Tăng chroma ưu tiên vùng chưa bão hòa, nhưng phải có gate ΔE00, chroma, TAC và clipping; slider sign phải monotonic trên corpus.
5. **Preview trước commit.** Hiển thị source ↔ soft-proof, gamut warning, highlight/shadow clipping và TAC cho đúng profile/intent/adjustment sẽ dùng.
6. **Không relabel CMYK.** Mọi OutputIntent phải mô tả đúng numerics của toàn artifact.

Adobe khuyến nghị chọn profile đúng destination, intent phù hợp, BPC thường bật và dùng preview; ICC cũng nhấn mạnh perceptual mapping phụ thuộc profile/nội dung, không có một thuật toán “rực nhất” phổ quát. Tham khảo:

- [Adobe — Change color profile for documents](https://helpx.adobe.com/uk/photoshop/desktop/adjust-color/color-profiles/change-color-profile-for-documents.html)
- [Adobe — Proofing colors](https://helpx.adobe.com/photoshop/using/proofing-colors.html)
- [Adobe PDF Reference 1.4 — Default color spaces](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.4.pdf)
- [ICC.1:2022 profile specification](https://www.color.org/specifications/ICC.1-2022-05.pdf)
- [ECI — Offset profiles and paper conditions](https://eci.org/doku.php_id%3Den_colorstandards_offset.html)

## 6. Test/verify baseline trước triển khai

```text
backend\venv\Scripts\python -m pytest
  tests\test_color_conversion_acceptance.py
  tests\test_convert_colors_http_contract.py -q
25 passed, 2 warnings

backend\venv\Scripts\python -m pytest
  tests\test_action_engine_native.py -k "adjustment or brightness" -q
4 passed, 77 deselected, 1 warning

desktop: npx vitest run
  src\components\preprocess-tools\PreprocessSuccessPersistence.test.tsx
10 passed

desktop: npm run typecheck
pass
```

Ngoài ra đã chạy parser/CMM/artifact/HTTP probes trên file thật và ba fixture xác minh §COLOR.28–.30. Tất cả artifact probe nằm trong thư mục tạm và đã được dọn.

Chưa chạy:

- click-smoke Tauri với chính `rgb.pdf`;
- packaged-installer production;
- màn hình hiệu chuẩn + soft-proof có paper/black simulation;
- bản in thật và đo spectrophotometer.

## 7. Kế hoạch sửa theo lô sau khi duyệt

Mỗi lô tối đa năm file source/test.

### Lô A — Sửa Lab/vibrance và khóa chất lượng adjustment

- Sửa encode/decode a/b cho NumPy và fallback bằng một helper canonical.
- Test sign/monotonic của vibrance, neutral invariance, NumPy/fallback parity.
- Thêm gate exact-direction trên lưới sRGB + patch ảnh; không dùng Desktop file làm dependency test.
- Verify artifact `rgb.pdf`, TAC, clipping và OutputIntent.

Dự kiến: `pdf_actions_native.py`, `test_action_engine_native.py`, `test_color_conversion_acceptance.py`.

### Lô B — Chốt policy existing CMYK/OutputIntent

- Pre-scan existing DeviceCMYK/ICCBased CMYK và source OutputIntent.
- Trước mắt fail-closed khi source CMYK khác/không rõ profile đích; không relabel.
- Sau đó chỉ mở CMYK→CMYK transform khi có oracle profile và test vector/image.
- Thêm fixture mixed SWOP→FOGRA39 và no-OI.

### Lô C — Honor DefaultRGB theo resource scope

- Resolve `DefaultRGB` cho page/Form/Pattern/AP và image.
- Reuse ICCBased/CalRGB transform hiện có.
- Fail-closed khi default space không xác minh được.
- Quét và verify sibling `DefaultGray`/`DefaultCMYK` riêng.

### Lô D — Preview/adaptive “giữ sáng”

- Backend trả metric ΔL*/chroma/TAC/clipping theo profile đã chọn.
- UI preview trước commit; preset “Cân bằng sáng” bảo vệ highlight thay cho offset +2 toàn cục.
- Corpus thêm ảnh khách, neutral/skin/saturated patches và nhiều profile giấy.

### Lô E — Nghiệm thu production/press

- Tauri exact-file + installer smoke.
- So soft-proof trên màn hình hiệu chuẩn.
- In proof FOGRA39 đúng điều kiện giấy/mực; đo patch bằng spectrophotometer.

Phần kế hoạch ở trên là baseline trước chốt duyệt. Bằng chứng và trạng thái sau khi người dùng duyệt, triển khai theo lô và verify nằm ở §8; các giới hạn nghiệm thu vẫn giữ nguyên.


## 8. Addendum sau khi người dùng duyệt và triển khai — 2026-08-21

Người dùng đã duyệt triển khai toàn bộ các lô. Code hiện tại đã hoàn tất:

| Lô | Phạm vi | Kết quả đã khóa |
|---|---|---|
| A | Lab/vibrance | Chuẩn hóa a*/b* signed two’s-complement cho NumPy và fallback; vibrance có hướng/đơn điệu; giữ byte CMYK ở pixel adjustment không đổi để tránh drift neutral/highlight. |
| B | Existing DeviceCMYK/OutputIntent | Scanner chỉ xét object reachable qua page/Form/Pattern/AP/scn/Do/inline/SMask; giữ OI matching, fail-closed khi thiếu/xung đột/ambiguous; không recurse alternate Spot/DeviceN để kết luận sai. |
| C | DefaultRGB | Honor /DefaultRGB theo resource scope page/Form/Pattern/AP/image; ICCBased/CalRGB explicit không bị override; invalid/shared-scope conflict fail-closed; AdobeRGB discriminator (60,200,100) ra FOGRA39 [222,0,217,0]. |
| D1 | Backend preview | Endpoint POST /api/preflight/convert-colors/preview; candidate chỉ ở TemporaryDirectory; dùng converter production + PPE soft-proof + TAC PPE; ΔL*/ΔC*/ΔE00/P95/clipping/gamut/TAC; DPI chỉ hạ dưới 8/16 GB. |
| D2 | Frontend preview | Preview theo trang đang xem, AbortController/request-id/fingerprint; execute chỉ mở khi preview còn fresh; recommendation không tự commit; profile/intent/adjustment được hiển thị và gửi đúng. |
| D3 | Profile/ownership contract | Spot alternate Lab dùng cùng profile CMYK đã chọn; fingerprint bao revision Working PDF (reorder/xóa/xoay), re-upload khi revision đổi; execute có generation fence + abort trước download/commit; schema/UI fail-closed khi proof/TAC không tin cậy hoặc recommendation stale. |

### Bằng chứng artifact và HTTP

Probe độc lập trên C:UsersKhanh PhamDesktop
gb.pdf (SHA-256 DFFFC19FC447F6E6E66F1438D51A3838F2559DBE58FCB26436AA278980DE1358) với FOGRA39, Relative+BPC, preserve black, post_cmyk, adjustments 0/0/0:

- Converter trả supported=true, postflight.passed=true, residuals=[]; PDF tạm 2.577.097 byte mở lại bằng pikepdf, pdf.check()=[].
- Hai ảnh 1.200×1.200 là /DeviceCMYK + /FlateDecode, dữ liệu giải mã đủ 4 kênh; OutputIntent duy nhất /N=4, ICC SHA-256 da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77, khớp bytes FOGRA39.
- TAC raw theo byte ảnh (2.880.000 pixel): mean 126,209359%, P95 229,411765%, max 306,666667%; 474 pixel >300%, 0 pixel >320%.
- Hash nguồn trước/sau không đổi. Các thư mục temp của probe được dọn khi kết thúc.
- HTTP execute route thật (TestClient, RESULTS_DIR cô lập) trả 200/success=true; download trả 200 application/pdf, chỉ có một final PDF, reopen/postflight/OI/no-RGB đều đạt. Đây là mức ARTIFACT + RUNTIME-PARTIAL, chưa phải Tauri exact-file.

### Verify sau triển khai

- Backend color gate: 134 passed, 2 warnings (test_action_engine_native.py, test_color_conversion_acceptance.py, test_convert_colors_http_contract.py, test_convert_colors_preview.py).
- Frontend PreprocessSuccessPersistence.test.tsx: 18 passed.
- npm run typecheck: xanh.
- ESLint hai file Convert Colors + regression: xanh.
- git diff --check: xanh.
- Regression mới khóa: profile Spot đã chọn; revision Working PDF; execute stale-response không commit; recommendation stale/untrusted không được áp.

### Findings còn mở / không được suy diễn

- Recommendation hiện đo một trang rồi áp adjustment cho toàn tài liệu; UI đã cảnh báo phạm vi trang, nhưng chưa có aggregate gate đa trang. Vì vậy status toàn họ vẫn HOLD.
- Chưa chạy Tauri exact-file với chính rgb.pdf, packaged installer, màn hình hiệu chuẩn/paper simulation, press proof hoặc spectrophotometer.
- TAC preview PPE (raster theo DPI) là measurement basis khác TAC raw byte-level artifact; không dùng hai con số như cùng một đại lượng.
- Không có một preset “rực/sáng nhất” đúng cho mọi profile giấy, máy in và artwork; Relative+BPC + adjustment 0 là baseline tốt nhất đã đo trên file này, không phải chứng nhận in cuối.
## Addendum - re-audit after user feedback (2026-08-22)

The earlier Saturation-based vivid preset is confirmed as a regression for the supplied case: it darkens the proof by about 2.36 L* versus Relative while recovering only about 1.68 C*. The screenshot was reproduced from Desktop\rgb.pdf (SSIM above 0.997).

Implemented next wave:
- explicit gamut_mapping=adaptive_vivid, independent from rendering intent;
- per-pixel L*/hue/chroma candidate selection with neutral/skin/highlight/shadow/TAC guards;
- source-RGB gamut warning using the LittleCMS 127 alarm;
- preview/execute parity and realtime UI refresh.

Artifact result on the same file: adaptive dL* -2.1551, dC* -11.4598, dE00 4.1559, highlight clip 2.9901%, TAC max 160.7843%; ICC baseline dL* -2.2344, dC* -12.8308, dE00 3.9418. Adaptive is an appearance trade-off, not a promise of 100% neon reproduction. Runtime Tauri exact-file and press proof remain open evidence levels.
