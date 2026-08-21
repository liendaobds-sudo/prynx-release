# BÁO CÁO AUDIT ENGINE MÀU RGB → CMYK — 2026-08-20

> Audit unit: **W3-U05 — người dùng chọn Chuyển hệ màu → RGB sang CMYK → tải/mở lại PDF đầu ra**
> Trọng tâm: giữ độ sáng, quản lý ICC, rendering intent, BPC, đen K-only, OutputIntent và tính toàn vẹn artifact
> Baseline: worktree ngày 2026-08-20, HEAD 8dd6006a91d89fbe0fb4df5c392530b0cb7d9335
> Trạng thái: **HOLD cho production RGB→CMYK**; đây là báo cáo ở chốt duyệt thứ nhất, chưa sửa source

## 1. Kết luận điều hành

PrynX không yếu về nền tảng quản lý màu. Phần **PrynX Print Engine (PPE)** đã có LittleCMS, đủ bốn rendering intent, Black Point Compensation, soft-proof, separations, ICCBased RGB nhúng và cơ chế báo độ tin cậy. Thiết kế writer object-level dùng pikepdf cũng có hướng đúng: giữ vector, DeviceGray và Spot/DeviceN thay vì raster hóa cả tài liệu.

Điểm gãy nằm ở đường **ghi PDF sau chuyển màu** và hợp đồng xuyên tầng:

- XObject ảnh RGB được đổi sang byte CMYK nhưng ghi sai encoding, làm stream không giải mã được và PDFium dựng ảnh trắng.
- Endpoint chuyên dụng tạo xong file nhưng trả HTTP 500 do response schema sai.
- Một số cấu trúc RGB/CalRGB/Lab/inline/JPX bị bỏ qua mà engine vẫn trả <code>supported=true</code>.
- ICC nguồn nhúng bị bỏ qua; OutputIntent đích có thể thiếu hoặc mâu thuẫn với chính số CMYK trong file.
- Hai tùy chọn UI quan trọng là rendering intent và giữ đen K-only hiện không đi tới engine.

Vì vậy, đánh giá theo từng lớp là:

| Lớp năng lực | Đánh giá | Bằng chứng chính |
|---|---|---|
| CMM / soft-proof / separations PPE | **Mạnh** | 4 intent, BPC, ICC nhúng, Lab, cảnh báo approximation |
| Giữ cấu trúc PDF object-level | **Khá ở vector/Spot/Gray** | giữ Separation/DeviceN và DeviceGray; xử lý Form/AP/Indexed |
| Writer bitmap RGB→CMYK | **Hỏng** | stream CMYK thô khai FlateDecode; artifact render trắng |
| Bao phủ colorspace/object | **Chưa đạt** | JPX, inline, named CalRGB/Lab còn lại sau success |
| Profile đích / OutputIntent | **Chưa đạt** | thiếu OI hoặc giữ OI cũ; PDF/X/TIFF có ca relabel numerics |
| Hợp đồng UI/API | **Chưa đạt** | HTTP 500; intent/preserve-black bị drop |
| Mục tiêu “giữ sáng tốt nhất” | **Có nền đo, chưa thành sản phẩm** | Relative+BPC tốt nhất trên sweep FOGRA39, nhưng chưa có policy/profile/postflight đồng nhất |

**Kết luận thực dụng:** Relative Colorimetric + BPC là default hợp lý nhất trên FOGRA39 trong phép đo hiện tại, nhưng PrynX chưa thể cam kết đầu ra RGB→CMYK an toàn hoặc giữ sáng tốt nhất cho đến khi các P0/P1 dưới đây được đóng.

## 2. Phạm vi và mức bằng chứng

### 2.1 Luồng chính đã trace

1. Registry mở công cụ: <code>desktop/src/lib/toolRegistry.ts:293-304</code>.
2. Router mount UI: <code>desktop/src/components/imposition-tools/sections/PreprocessingRouter.tsx:252-254</code>.
3. UI khóa <code>auto + relative + preserve_black=true</code> và POST: <code>ConvertColorsTool.tsx:21-23,104-143</code>.
4. Schema nhận request: <code>backend/app/schemas/preflight.py:370-375</code>.
5. FastAPI route: <code>backend/app/api/routes/preflight.py:1397-1512</code>; router thật được đăng ký tại <code>backend/app/main.py:274-278</code>.
6. Writer: <code>backend/app/core/pdf_actions_native.py:671-957,1232-1392</code>.
7. UI tải file và commit working document: <code>ConvertColorsTool.tsx:136-143</code> → <code>ImpositionTab.tsx:1009-1183</code>.

### 2.2 Luồng anh em dùng cùng sink

- Preflight action <code>CONVERT_TO_CMYK</code>: <code>backend/app/core/action_engine.py:417-468</code>.
- PDF/X-4 native: <code>backend/app/core/pdfx_export.py:537-567</code>.
- Output Preview/soft-proof dùng PPE riêng: <code>backend/app/api/routes/preflight.py:964-999,1534-1545</code>.
- Native Combine ảnh→PDF: UI/job/worker → <code>native/src/combine_image_pdf.rs</code>.
- Export TIFF CMYK production: <code>backend/app/api/routes/export.py</code> → PPE <code>ppe_export_cmyk</code>.

### 2.3 Bằng chứng đã dùng

- Đọc code xuyên UI → schema → route → CMM/writer → artifact → consumer.
- FastAPI TestClient qua router thật.
- PDF thật được mở lại bằng pikepdf; ảnh được dựng bằng PDFium có khóa <code>pdfium_guard()</code>.
- ICC identity đọc bằng LittleCMS/Pillow.
- PPE native được gọi trực tiếp để kiểm CMYK/RGB pixel và cờ <code>degraded/ink_unsound</code>.
- Sweep 4.913 màu sRGB qua FOGRA39 và proof trở lại sRGB để đo CIELAB L*.

Chưa chạy Tauri installed/release, chưa proof trên máy in vật lý và chưa dùng máy đo màu. Vì vậy mức cao nhất trong báo cáo là ARTIFACT hoặc RUNTIME-PARTIAL, không phải nghiệm thu press.

## 3. Bảng finding đã xác nhận

| ID | Mức | Bằng chứng | Tóm tắt | Effort |
|---|---:|---|---|---:|
| §COLOR.01 | **P0** | ARTIFACT + RUNTIME | Writer ảnh ghi CMYK thô nhưng khai FlateDecode; ảnh render trắng | S |
| §COLOR.02 | **P0** | RUNTIME-PARTIAL | Endpoint Convert Colors tạo file rồi trả HTTP 500 do schema <code>log</code> sai | S |
| §COLOR.03 | **P0** | ARTIFACT + RUNTIME | Native Combine gắn Adobe RGB cho PNG được khai sRGB | S–M |
| §COLOR.04 | **P1** | ARTIFACT | JPX, inline, named CalRGB/Lab còn nguyên nhưng converter báo success | M–L |
| §COLOR.05 | **P1** | ARTIFACT | ICCBased RGB nhúng bị bỏ qua, mọi nguồn bị diễn giải như sRGB | M–L |
| §COLOR.06 | **P1** | ARTIFACT | OutputIntent thiếu/cũ hoặc profile khai báo không khớp numerics CMYK | M |
| §COLOR.07 | **P1** | ARTIFACT | <code>preserve_black=true</code> bị bỏ qua; RGB black thành rich black ~327% TAC | M |
| §COLOR.08 | **P1** | TRACED + ARTIFACT | Profile “auto” chỉ là FOGRA39; UI không cho chọn điều kiện giấy/máy in | M |
| §COLOR.09 | **P2** | ARTIFACT | Request intent được nhận nhưng sink luôn Relative+BPC | S–M |
| §COLOR.10 | **P1** | ARTIFACT + RUNTIME | PPE coi CalRGB như sRGB nhưng vẫn báo kết quả clean | M–L |
| §COLOR.11 | **P1** | ARTIFACT + RUNTIME | PPE bỏ semantics <code>/SMask /Matte</code>, gây viền alpha sai màu | M |
| §COLOR.12 | **P2** | TRACED | Copy Grayscale, validation request, download và Ink Manager có lệch hợp đồng | S–M |
| §COLOR.13 | **P2** | AUTO-PARTIAL | Test khóa nhiều invariant tốt nhưng bỏ trống postcondition/artifact màu quan trọng | M |

## 4. Chi tiết finding

### §COLOR.01 — P0 — Stream ảnh CMYK/Gray bị ghi hỏng

**Reachability**

- Route gọi <code>pdf_actions_native.convert_to_cmyk()</code>: <code>preflight.py:1443-1453</code>.
- Writer ảnh: <code>pdf_actions_native.py:929-957</code>.
- PDF/X-4 dùng cùng converter: <code>pdfx_export.py:549-567</code>.

**Nguyên nhân**

Tại <code>pdf_actions_native.py:946-950</code>, code lấy <code>cmyk.tobytes()</code> rồi gọi:

    obj.write(raw, filter=/FlateDecode)

<code>pikepdf.Stream.write(..., filter=/FlateDecode)</code> coi dữ liệu đầu vào là dữ liệu đã encode. Byte CMYK thô chưa qua zlib vì vậy không thể decode. Pattern giống hệt tồn tại ở nhánh grayscale tại <code>pdf_actions_native.py:1218-1222</code>.

Repo đã từng sửa đúng lỗi cùng loại ở downscale: <code>pdf_actions_native.py:459,488</code> dùng <code>zlib.compress(raw)</code>; test <code>test_action_engine_native.py:168-172</code> còn ghi rõ lịch sử “ảnh trắng”. Fix cũ không được áp vào hai writer màu.

**Artifact**

- <code>%TEMP%\prynx_color_audit_corrupt_image_oqlod9uz\converted_corrupt_cmyk.pdf</code>.
- Engine trả <code>supported=true, images=1</code>.
- XObject khai <code>/DeviceCMYK /FlateDecode</code>, raw length 16.
- pikepdf: <code>read_bytes called on unfilterable stream</code>.
- PDFium render 20×20 cho extrema cả ba kênh đều <code>(255,255)</code>: trang trắng.
- Nhánh grayscale được repro riêng: <code>supported=true, images=1</code>, <code>/DeviceGray /FlateDecode</code>, cùng lỗi unfilterable.

**Vi phạm bất biến**

Một artifact chỉ được công bố success khi mọi stream mới ghi mở lại/giải mã được. Đây là sai file đầu ra, không phải sai preview.

### §COLOR.02 — P0 — API chuyên dụng luôn có thể trả 500 sau khi engine thành công

<code>FixFileWithLogResponse.log</code> là <code>Optional[str]</code> tại <code>backend/app/schemas/preflight.py:125-134</code>, trong khi route dựng và trả <code>list[dict]</code> tại <code>preflight.py:1402,1426,1478-1481,1504,1507-1512</code>. UI cũng xác nhận contract đúng phải là array khi gọi <code>result.log?.map()</code> tại <code>ConvertColorsTool.tsx:191-196</code>.

Probe FastAPI qua router thật:

    POST /preflight/convert-colors
    status = 500
    body = Internal Server Error

Trong cùng lần gọi, PDF đầu ra đã được tạo. Test hiện tại gọi coroutine <code>convert_colors()</code> trực tiếp tại <code>test_no_ghostscript_survival.py:510-540</code>, nên bỏ qua response serialization và không thấy lỗi production.

### §COLOR.03 — P0 — Native Combine gắn sai Adobe RGB cho ảnh sRGB

<code>native/src/combine_image_pdf.rs:36</code> nhúng trực tiếp:

    include_bytes!("../../backend/app/assets/icc/sRGB.icc")

LittleCMS nhận dạng file đó là **Adobe RGB (1998)**, SHA-256:

    304f569a83c1e5eddaddac54e99ed03339333db013738bb499ab64f049887e28

Registry Python đã có guard chặn asset sai tại <code>backend/app/core/icc_profiles.py:155-170</code>, nhưng native <code>include_bytes!</code> đi vòng qua guard. Hai module khác đã ghi chú rõ debt này và tự tạo sRGB chuẩn: <code>backend/app/api/routes/export.py:50-65</code> và <code>backend/app/workers/sticker_engine.py:7356-7372</code>.

**Reachability**

<code>CombineTab.tsx:1041-1078</code> → <code>combineDelegation.ts:296-310</code> → <code>api.ts:802-879</code> → <code>combine_jobs.py:285-430</code> → <code>pdf_manifest_engine.py:627-806</code> → <code>combine_image_pdf.rs:255-321,896-911,1749-1825</code>.

**Artifact**

- <code>%TEMP%\prynx_color_audit_combine_srgb_fcgvxjg6\native_combined.pdf</code>.
- PNG có chunk sRGB; PDF đầu ra là ICCBased nhưng profile nhúng được đọc lại là Adobe RGB (1998).
- Mẫu RGB (60,200,100):
  - sRGB đúng → FOGRA39: (172,0,195,0);
  - bị hiểu Adobe RGB → FOGRA39: (222,0,217,0);
  - proof sai tối hơn khoảng ΔL* = -7,84 và ΔE76 ≈ 11,90.

Test Rust tại <code>combine_image_pdf.rs:2225-2245,2315-2348,2450-2463</code> chỉ so output với chính constant sai, không xác minh identity profile bằng CMM.

### §COLOR.04 — P1 — False-success: còn RGB/CalRGB/Lab sau chuyển đổi

Có bốn lớp artifact:

1. **JPX/JPEG2000:** <code>%TEMP%\prynx-convert-jpx-audit-6sgaqx8i\rgb-jpx-converted.pdf</code> vẫn có <code>/DeviceRGB /JPXDecode</code>, nhưng result là <code>supported=true, blockers=[], warnings=[]</code>.
2. **Inline image:** <code>%TEMP%\prynx_color_audit_inline_8e69v5l5\converted_claimed_cmyk.pdf</code> vẫn chứa <code>BI ... /CS /RGB ... EI</code>. <code>has_rgb_content()</code> còn trả false.
3. **Named CalRGB:** Preflight báo hai lỗi auto-fixable, converter trả success với <code>ops=0</code>; resource <code>/CalRGB</code> và content byte-identical.
4. **Named Lab:** Preflight không báo gì; converter vẫn success/no-op; resource <code>/Lab</code> nguyên vẹn.

Nguyên nhân:

- JPX không thuộc allow-list: <code>pdf_actions_native.py:36-46</code>; thất bại tại <code>:929-944</code> không được biến thành blocker.
- Converter không xử lý inline image.
- <code>_scan_convertibility()</code> tại <code>:755-784</code> tìm <code>/Lab</code>/<code>/CalRGB</code> trên Dictionary/Stream nhưng bỏ lọt array trong named resources.
- Named vector converter chỉ hiểu DeviceRGB và ICCBased N=3 tại <code>:734-750,830-860</code>.
- Sau save không có hậu kiểm reachable object; hàm dò nhanh có sẵn tại <code>:2058-2077</code> nhưng vừa không được gọi, vừa không đủ bao phủ.

**Artifact CalRGB/Lab cố định**

<code>%TEMP%\PrynX_color_audit_20260820\probe-report.json</code>, SHA-256:

    0d33bb93c2c133c86db7eecb18ff3b7239b1eb1175ab6b6fb767c5e27df9ee80

### §COLOR.05 — P1 — ICC nguồn nhúng bị bỏ qua

Route luôn truyền một source profile sRGB chung tại <code>preflight.py:1443-1453</code>. <code>_cs_is_device_rgb()</code> chỉ đọc <code>/N=3</code> tại <code>pdf_actions_native.py:734-752</code>; <code>_CmykTransform</code> tại <code>:699-731</code> chỉ giữ một transform nguồn toàn cục. Bytes ICC của object không bao giờ được mở.

Artifact AdobeRGB ICCBased với sample (60,200,100):

- số writer hiện tại: CMYK (172,0,195,0), khớp chính xác đường sRGB sai;
- dùng đúng Adobe RGB nhúng: (222,0,217,0).

Test <code>test_action_engine_native.py:535-560</code> dùng ICC stream giả chỉ 8 byte và vẫn mong conversion thành công. Test đó khóa hình dạng operator, không khóa semantics màu.

PPE đã có cách làm đúng ở <code>print_engine/src/color/icc.rs:363-375</code> và <code>print_engine/src/color/space.rs:286-310</code>; đây là năng lực nên tái dùng thay vì tạo CMM thứ ba.

### §COLOR.06 — P1 — OutputIntent/profile không đồng nhất với numerics

**Standalone Convert Colors**

- File không có OI → output vẫn không có OI.
- File có SWOP OI → conversion tạo số theo FOGRA39 nhưng giữ nguyên SWOP OI.
- Artifact: <code>%TEMP%\prynx-convert-outputintent-audit-14dxiaee\converted-default-fogra.pdf</code>.
- Content CMYK khớp FOGRA39; ICC còn lại có SHA-256 SWOP <code>35f401...</code>, khác FOGRA39 <code>da2b9b...</code>.

**PDF/X-4**

<code>pdfx_export.py:537-567</code> giữ nguyên DeviceCMYK hiện hữu qua converter rồi thay OutputIntent bằng FOGRA39. Artifact:

- source: <code>0.2 0.4 0.6 0.1 k</code> + SWOP;
- output: cùng byte <code>0.2 0.4 0.6 0.1 k</code> + FOGRA39.

**TIFF CMYK production**

PPE giữ raw DeviceCMYK đúng theo invariant tại <code>print_engine/src/color/space.rs:234-244</code>, nhưng export gắn FOGRA39 mặc định dù source khai SWOP. Artifact TIFF center pixel vẫn (51,102,153,26) và ICC nhúng là FOGRA39.

Giữ DeviceCMYK numbers có thể là policy hợp lệ; **đổi profile mô tả mà không đổi numbers thì không hợp lệ**. Cần một lựa chọn rõ:

- Preserve CMYK numbers → giữ đúng source OutputIntent;
- Convert to destination → transform CMYK nguồn→PCS→CMYK đích rồi thay OI.

### §COLOR.07 + §COLOR.09 — Preserve black và intent không đi tới engine

UI cố định và quảng cáo:

- <code>ConvertColorsTool.tsx:21-23</code>: <code>relative + preserve_black=true</code>;
- <code>:44-47</code>: tự giữ chữ/nét đen K-only.

Schema nhận hai field tại <code>schemas/preflight.py:370-375</code>, nhưng route chỉ đọc profile tại <code>preflight.py:1428-1453</code>. Sink hard-code Relative Colorimetric + BPC tại <code>pdf_actions_native.py:671-711</code>. Module <code>preserve_black.py</code> không còn caller live.

Hai request Relative/preserve=true và Perceptual/preserve=false sinh content stream byte-identical.

RGB black hiện ra:

    C 89,41% · M 78,43% · Y 61,96% · K 97,25%
    TAC ≈ 327,06%

Đây là rich black hợp lệ theo ICC cho ảnh/shadow, nhưng trái với contract “chữ & nét đen K-only”. Policy đúng phải phân biệt:

- text/stroke/vector pure RGB black theo tùy chọn → K-only;
- DeviceGray → giữ K-only như hiện tại;
- pixel đen trong ảnh → để ICC/GCR xử lý, không ép toàn ảnh thành K-only.

### §COLOR.08 — “Auto” không phải engine chọn profile

<code>ConvertColorsTool.tsx:21-23</code> ẩn toàn bộ profile/intent. <code>resolve_profile_path()</code> tại <code>icc_profiles.py:227-250</code> ánh xạ <code>auto</code> trực tiếp sang <code>fogra39</code>.

FOGRA39 là lựa chọn hợp lý cho giấy couché offset theo ISO 12647-2, nhưng không đại diện cho:

- giấy không tráng phủ;
- in báo;
- SWOP/GRACoL/Japan Color;
- máy in kỹ thuật số có device profile riêng.

Output Preview đã có UI chọn profile/intent tại <code>OutputPreviewTab.tsx:1197-1239</code>; Convert Colors không dùng state đó. Với mục tiêu giữ sáng, “profile đúng cho giấy/máy” quan trọng hơn thay đổi intent nhỏ.

### §COLOR.10 — PPE bỏ calibration của CalRGB

PPE hạ <code>CalRGB</code> thành <code>DeviceRGB</code> tại <code>print_engine/src/color/space.rs:579-586,730-733</code>, bỏ WhitePoint/Gamma/Matrix rồi dùng sRGB LUT tại <code>icc.rs:287-295</code>.

Artifact end-to-end Combine → PPE:

- PDF có CalRGB Adobe-like đầy đủ.
- PPE center CMYK: (172,0,195,0), khớp sRGB sai.
- Kết quả đúng theo calibration: (222,0,217,0).
- PPE vẫn trả <code>degraded=false, ink_unsound=false</code>.

Vấn đề không chỉ là sai màu; cờ độ tin cậy cũng sai, khiến consumer không có cơ hội fallback/cảnh báo.

### §COLOR.11 — PPE bỏ /SMask /Matte

<code>print_engine/src/image/sampler.rs:481-527</code> lấy alpha từ SMask nhưng toàn <code>print_engine/src</code> không xử lý <code>/Matte</code>.

Hai PDF metamorphic biểu diễn cùng ảnh đỏ alpha 50%:

| Artifact | PDFium center | PPE center | PPE flags |
|---|---:|---:|---|
| Matte encoding | (145,16,16) | (152,122,120) | clean |
| Unassociated reference | (145,15,15) | (149,99,82) | clean |

PDFium cho hai kết quả gần byte-identical; PPE lệch mạnh nhưng vẫn <code>degraded=false, ink_unsound=false</code>. Object writer Python cũng chưa cập nhật <code>/Matte</code> hay color-key <code>/Mask</code> khi đổi parent image sang CMYK.

### §COLOR.12 — Các lệch hợp đồng P2 lân cận

1. **Grayscale copy:** UI nói “bỏ toàn bộ màu, in một màu đen” tại <code>ConvertColorsTool.tsx:30-34,164-166</code>; engine chủ ý giữ Spot/DeviceN tại <code>pdf_actions_native.py:1054-1065</code>. Engine bảo toàn đường bế là đúng; copy UI cần nói rõ.
2. **Request validation:** <code>ConvertColorsRequest</code> dùng chuỗi/list tự do. Conversion lạ bị bỏ qua, <code>all([])</code> trả true; profile/intent rác có thể silent fallback.
3. **Download:** UI không kiểm status/MIME trước khi commit blob tại <code>ConvertColorsTool.tsx:136-143</code>.
4. **Ink Manager:** backend có <code>cmyk_known=false</code> cho alternate không biết, nhưng frontend bỏ field và vẫn hiển thị fallback K50 như giá trị thật.

### §COLOR.13 — Coverage test xanh nhưng chưa bảo vệ artifact

**Điểm tốt đang được khóa**

- RGB operator → CMYK operator.
- DeviceGray giữ nguyên.
- Spot/Separation giữ nguyên.
- Indexed palette đổi đúng.
- RGB shading fail-closed.
- PPE ICC/BPC/DeviceCMYK/DeviceGray/rich-black có test.

**Khoảng trống gây ra các finding trên**

- Không decode/render XObject sau khi writer ghi.
- Không có HTTP response-model test dương tính.
- Không có postcondition “success ⇒ không còn RGB/CalRGB/Lab”.
- Không có JPX/inline/pattern/Type3/SMask-Matte corpus.
- Không có ICCBased AdobeRGB/P3 với reference CMM.
- Không có test OutputIntent hash = profile thật dùng để tạo numerics.
- Không có test request intent/preserve-black tác động artifact.
- Test Combine so bytes với cùng constant sai thay vì xác minh ICC identity.
- Chưa có quality gate ΔL*/ΔE00/TAC theo profile giấy.

## 5. Đo mục tiêu “giữ độ sáng tốt nhất”

### 5.1 Phương pháp

- Source: lưới sRGB 17×17×17 = 4.913 màu.
- Destination: bundled Coated FOGRA39.
- CMM: LittleCMS qua Pillow 12.3.
- So sánh: RGB nguồn → CMYK → proof sRGB; đo CIELAB L*.
- BPC/NOOPTIMIZE khớp policy writer hiện tại.
- Đây là profile round-trip, không thay thế press proof hoặc đo quang phổ trên giấy thật.

### 5.2 Kết quả intent

| Intent | BPC | Mean abs ΔL* | Mean signed ΔL* | P95 abs ΔL* | Nhận xét |
|---|---:|---:|---:|---:|---|
| Relative | **On** | **3,3697** | -2,8382 | 14,1608 | thấp nhất theo mean absolute |
| Relative | Off | 3,5023 | **-2,5107** | **13,9510** | ít darkening trung bình hơn đôi chút |
| Perceptual | On/Off | 4,3478 | -4,1004 | 14,5415 | dịch cả màu vốn trong gamut |
| Absolute | On/Off | 4,3003 | -3,5163 | 16,6463 | dùng mô phỏng paper white, không phải default convert |
| Saturation | On/Off | 5,2768 | -4,8200 | 17,4673 | tệ nhất về L*, có clipping |

Relative+BPC thắng theo mean |ΔL*|, nhưng Relative không BPC có signed/p95 hơi tốt hơn. BPC vẫn nên mặc định cho prepress vì giữ chi tiết vùng tối; UI có thể cho expert tắt khi có lý do và preview rõ.

### 5.3 Patch đại diện với Relative+BPC

| Patch sRGB | ΔL* proof - source |
|---|---:|
| White (255,255,255) | 0,000 |
| Light gray (224,224,224) | -0,228 |
| Skin (214,154,123) | +0,091 |
| Orange (255,128,0) | -2,818 |
| Cyan (0,200,255) | -2,277 |
| Blue (0,80,255) | -4,452 |
| Green (0,200,80) | -7,274 |

Màu xanh lá/xanh dương bão hòa tối đi vì gamut CMYK nhỏ hơn sRGB. Không thể “giữ sáng tuyệt đối” chỉ bằng một intent; cần profile đích đúng và cho người dùng xem gamut/soft-proof trước khi commit.

### 5.4 Khuyến nghị thực dụng

Preset mặc định nên là:

> **Giữ độ sáng — Relative Colorimetric + BPC**, honor ICC nguồn; source không tag mới giả định sRGB; chọn profile đích theo giấy/máy; giữ text/stroke black K-only; ảnh đi ICC; gắn đúng OutputIntent; hậu kiểm file.

Với ảnh có nhiều màu ngoài gamut, cho phép **Perceptual** như lựa chọn có preview, nhưng không quảng cáo nó sáng hơn: trên FOGRA39 corpus hiện tại nó tối hơn Relative+BPC.

## 6. Kiến trúc đích đề xuất

### 6.1 Một ColorConversionPolicy xuyên tầng

Nên có một contract duy nhất:

| Field | Ý nghĩa |
|---|---|
| source_policy | honor embedded ICC; untagged RGB defaults to sRGB |
| destination_profile | id/path/hash/identity thật |
| rendering_intent | perceptual/relative/saturation/absolute |
| black_point_compensation | boolean thật đi tới CMM |
| black_policy | preserve text/stroke pure black; image shadows use ICC |
| spot_policy | preserve hoặc convert có chủ đích |
| cmyk_policy | preserve numbers + source OI, hoặc convert sang OI đích |

Response phải trả lại profile name/hash, intent/BPC thực dùng, số object đã đổi/bỏ qua, remaining colorspaces và warnings.

### 6.2 Tái dùng CMM mạnh, không raster hóa tài liệu

Giữ pikepdf làm writer để bảo toàn vector/Spot/OCG/annotation. Không dùng <code>ppe_export_cmyk</code> làm fallback im lặng vì đó là raster production và sẽ làm mất cấu trúc.

Thay vào đó, expose/batch phần transform LittleCMS đã trưởng thành trong PPE cho writer:

- sRGB/ICC embedded/Lab/CalRGB → CMYK;
- cache transform theo hash profile;
- cùng mapping intent/BPC với Output Preview;
- cùng metadata accuracy.

### 6.3 Writer phải fail-closed và verify sau save

Sau khi ghi:

1. Mở lại PDF.
2. Decode mọi stream mới ghi.
3. Walk reachable page/Form/AP/Pattern/Type3/inline/image/shading/soft-mask resources.
4. Nếu còn RGB/CalRGB/Lab hoặc object không xử lý, trả 422/unsupported và không công bố artifact.
5. Nếu policy cho phép residual Spot/DeviceGray, báo rõ thay vì gọi file “CMYK-only”.
6. Hash OutputIntent phải đúng profile tạo numerics.

### 6.4 Preview trước khi commit

Convert Colors nên dùng đúng state profile/intent của Output Preview, hoặc buộc người dùng xác nhận preset. Hiển thị:

- before/after soft-proof;
- gamut warning;
- ΔL* neutral/saturated patch summary;
- TAC và black policy;
- profile giấy/máy và OutputIntent sẽ được nhúng.

## 7. Acceptance gate đề xuất

Không mở gate production RGB→CMYK cho tới khi đạt đồng thời:

1. POST Convert Colors trả HTTP 200, download là PDF hợp lệ.
2. Mọi XObject được đổi đều decode/render được; ca ảnh Flate không trắng.
3. Success đồng nghĩa không còn RGB/CalRGB/Lab theo policy; JPX chưa hỗ trợ phải fail-closed.
4. ICCBased AdobeRGB/P3 khớp reference LittleCMS sau lượng tử hóa; ICC hỏng fail-loud.
5. OutputIntent profile hash = profile tạo số CMYK.
6. RGB black text/stroke với preserve=true → C=M=Y=0, K=100%; ảnh đen vẫn dùng ICC.
7. Relative/Perceptual requests tạo output khác đúng reference.
8. DeviceGray và Spot/DeviceN giữ đúng invariant khi policy preserve.
9. CalRGB PPE dùng WhitePoint/Gamma/Matrix hoặc hạ accuracy/fallback.
10. SMask Matte metamorphic parity trong ngưỡng định trước.
11. Brightness gate FOGRA39 tối thiểu không xấu hơn baseline Relative+BPC hiện tại: mean |ΔL*| ≤ 3,37 trên cùng corpus; neutral ramp có ngưỡng riêng.
12. Targeted tests + full backend/frontend/Rust + artifact reopen/render + Tauri dev smoke; installed smoke khi chuẩn bị release.

## 8. Kế hoạch sửa theo lô sau chốt duyệt

Mỗi lô tối đa 5 file source/test, verify xong mới sang lô kế.

### Lô A — Mở lại feature và chặn artifact ảnh hỏng

- Sửa response schema <code>log</code>.
- Sửa Flate encoding CMYK + grayscale.
- Thêm test HTTP dương tính, decode XObject và PDFium render.
- Không đổi policy màu.

### Lô B — Postcondition và fail-closed

- Hậu kiểm remaining RGB/CalRGB/Lab.
- JPX/inline/named colorspace chưa hỗ trợ phải blocker rõ.
- Route/ActionEngine không công bố output partial.

### Lô C — Profile source/destination đúng

- Honor embedded ICC và CalRGB/Lab.
- Chốt preserve-numbers hay convert-CMYK policy.
- Gắn/thay OutputIntent theo đúng destination.
- Thêm golden AdobeRGB/P3/OI none-SWOP-FOGRA.

### Lô D — Intent, BPC, black và UI “giữ sáng”

- Truyền intent/BPC thật.
- Thực thi black policy theo text/stroke/vector, không ép ảnh.
- Cho chọn preset giấy/máy hoặc dùng state Output Preview.
- Hiển thị actual profile/intent/hash và warning.

### Lô E — Dọn asset sRGB và native consumers

- Thay asset bằng sRGB chuẩn hoặc sinh sRGB từ LittleCMS tại build/runtime.
- Cấm direct include không kiểm identity.
- Sửa Combine test xác minh profile name/description.
- Rebuild native và chạy artifact Combine.

### Lô F — PPE color fidelity lân cận

- Parse CalRGB thật và hạ accuracy khi chưa hỗ trợ.
- Xử lý SMask Matte/color-key Mask.
- Re-run soft-proof/separations/export corpus.

## 9. Test và probe đã chạy

### Python/backend

- <code>test_action_engine_native.py -k convert</code>: **7 passed**.
- <code>test_no_ghostscript_survival.py -k convert_colors</code>: **2 passed**.
- <code>test_icc_and_color_preview.py</code> subset profile: **5 passed**.
- Nhóm route/PDF-X/TIFF/PPE hẹp khác: **6 passed**.

Các test xanh này chứng minh invariant cục bộ, đồng thời cho thấy coverage chưa chạm các artifact hỏng.

### Frontend

5 file / **30 tests passed** cho registry, recipe ticket, persistence và Output Preview. Chưa có test response serialization thật.

### Rust PPE

<code>cargo test --locked --test render_icc</code>: **12 passed** với target tạm độc lập.

### Probe runtime nổi bật

- FastAPI Convert Colors: **500 Internal Server Error**.
- CMYK image PDF: pikepdf unfilterable; PDFium render trắng.
- JPX/inline/CalRGB/Lab: success nhưng residual colorspace còn nguyên.
- Combine sRGB: output ICC identity Adobe RGB (1998).
- PPE CalRGB: sai numerics nhưng <code>degraded=false, ink_unsound=false</code>.
- SMask Matte: PDFium parity, PPE diverges với clean flags.

## 10. Điều chưa chứng minh

Các mục sau giữ trạng thái **[SUSPECTED]**, không xếp severity:

- Tiling Pattern, Type3 CharProc và soft-mask Form có thể còn RGB vì walker hiện chưa bao phủ toàn bộ.
- Đổi image colorspace có thể cần cập nhật thêm <code>/Matte</code>, color-key <code>/Mask</code> và Decode arrays.
- Dung lượng file có thể tăng mạnh khi ảnh DCT/JPX bị chuyển sang Flate CMYK; chưa benchmark corpus.
- Brightness/ΔE trên máy in thật còn phụ thuộc giấy, mực, tuyến tính hóa RIP, GCR/UCR và calibration; chưa có dữ liệu spectrophotometer.
- Custom ICC và profile máy kỹ thuật số chưa có corpus portability/installer.

## 11. Quyết định cần người dùng duyệt

Đề nghị duyệt thứ tự:

1. **Lô A + B trước** để ngừng HTTP 500, ảnh trắng và false-success.
2. **Lô C + D tiếp theo** để đạt mục tiêu RGB→CMYK giữ sáng có profile/intent/black policy thật.
3. **Lô E song song ngay sau P0** vì asset sRGB sai ảnh hưởng Native Combine.
4. **Lô F** là hardening PPE lân cận, không chặn việc sửa writer P0 nhưng chặn claim “engine màu đồng nhất toàn dự án”.

Theo quy trình audit 2 chốt, báo cáo dừng ở đây để chờ duyệt. Không có source production nào được sửa trong đợt audit này.
