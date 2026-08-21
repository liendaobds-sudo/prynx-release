# Nhật ký sửa Engine màu RGB → CMYK — 2026-08-20

## Phạm vi lượt này

Đã triển khai Lô A–T sau khi người dùng duyệt báo cáo audit:

- **Lô A — mở lại feature và chặn artifact ảnh hỏng**: sửa hợp đồng HTTP `log` và mã hóa Flate cho ảnh CMYK/Gray.
- **Lô B — hậu kiểm và fail-closed**: không công bố file nếu còn RGB/ICC RGB/CalRGB/Lab, JPX chưa chứng minh được colorspace hoặc inline image RGB.
- **Lô C — danh tính sRGB của Native Combine**: thay asset Adobe RGB bị đặt sai tên bằng profile sRGB LittleCMS hợp lệ và giữ fixture Adobe RGB riêng cho test cách ly.
- **Lô D/E — fidelity ICC và policy chuyển đổi**: dùng ICC RGB nhúng theo từng object, truyền rendering intent/preserve-black tới sink, bật BPC mặc định, giữ đen thuần K cho text/stroke/vector và thay OutputIntent cũ bằng đúng ICC CMYK đích.
- **Lô F1/F2 — PPE fidelity lân cận**: CalRGB/CalGray chưa đủ calibration nay bị đánh dấu approximate/ink-unsound; SMask `/Matte` được khử preblend trước ICC, còn color-key mask và ảnh RGB có Matte ở writer bị fail-closed. F1 (PPE) và F2 (writer) verify riêng, không vượt quá năm file source/test mỗi lô.
- **Lô G — profile/intent minh bạch và request fail-closed**: Convert Colors chọn profile output thật, dùng chung profile/intent theo tab với Output Preview, công bố Relative+BPC là mặc định giữ sáng; backend từ chối conversion/intent/profile sai hoặc profile tường minh chưa cài thay vì báo thành công hay rơi ngầm về FOGRA39.
- **Lô H — corpus gate “giữ sáng”**: nhúng lưới sRGB 17³ thành Image XObject thật rồi khóa đường artifact FOGRA39 Relative+BPC cùng một PDF vector patch bằng ngưỡng ΔL*, TAC, K-only, OutputIntent hash và postflight.
- **Lô I — wide-gamut + graphics state + transparency an toàn**: Adobe RGB/Display P3 nhúng được đo xuyên writer bằng ΔE00/ΔL*/TAC; graphics state sống đúng qua mảng `/Contents` và `q/Q`; ICC `/N` phải khớp chữ ký profile thật; alpha/transparency RGB sống bị fail-closed cho tới khi có flatten-before-ICC.
- **Lô J — flatten alpha có điều kiện trước ICC**: ảnh **DeviceRGB** có `/SMask` chỉ được composite trên nền giấy trắng khi là paint duy nhất của một trang cô lập, không Form/nền/vector/annotation, không dùng lại; `/Matte` được khử preblend trước composite. Các transparency phụ thuộc backdrop vẫn fail-closed và cảnh báo được đưa lên HTTP/ActionEngine.
- **Lô K — source ICCBased RGB → blend DeviceRGB trước alpha**: ảnh ICCBased RGB hợp lệ (Adobe RGB/Display P3, `/N=3`) trong cùng lane cô lập được đổi sang profile DeviceRGB blend trước khi composite alpha, rồi mới chạy FOGRA39 Relative+BPC. Artifact wide-gamut khóa byte CMM, OutputIntent và TAC; ICC hỏng/mismatch và backdrop phức tạp vẫn fail-closed.
- **Lô L — chặn `/Decode` tùy biến bị mất semantics**: vì `pikepdf.PdfImage` giải filter nhưng không áp mapping `/Decode`, writer chỉ nhận mapping mặc định `[0 1]` cho từng kênh RGB/alpha. Mapping đảo/thay thang bị từ chối trước convert/flatten, trả blocker công khai và không tạo artifact; `/Decode` mặc định tường minh vẫn được phép.
- **Lô M — chặn ICCBased RGB `/Range` bị bỏ qua**: chỉ nhận `/Range` mặc định/canonical `[0 1]` cho ba kênh. Range tùy biến hợp lệ trả `[UNSUPPORTED_ICC_RANGE]`; khai báo sai chiều, sai độ dài hoặc không phải số trả `[INVALID_ICC_RANGE]`. Cửa chặn chạy trước writer và trước alpha flatten để metadata không thể biến mất rồi tạo artifact sai màu.
- **Lô N — mở CalRGB có calibration chứng minh được**: dựng profile ICC matrix-shaper tạm từ `WhitePoint/Gamma/Matrix`, chromatic-adapt về PCS D50 rồi dùng cùng CMM FOGRA39 Relative+BPC. Chỉ mở matrix khả nghịch, WhitePoint tự nhất quán và BlackPoint bằng 0; CalRGB alpha/shading, DCT/JPX hoặc dictionary thiếu/không nhất quán vẫn fail-closed.
- **Lô O — flatten vector alpha có oracle hẹp**: mở đúng một fill DeviceRGB có alpha thường trên nền giấy trắng khi ExtGState, resource và content stream đều chứng minh được là cô lập; composite RGB trước ICC, surface cảnh báo qua API. Nhiều paint, blend mode, soft-mask, group và backdrop không chứng minh được tiếp tục fail-closed.
- **Lô P — hardening transparency raster**: detector nay đi vào inline image và Type3 CharProc; artifact flatten được mở lại quét hậu điều kiện, plate PPE sai kích thước bị từ chối thay vì lặp/cắt byte, và ActionEngine đưa mã blocker an toàn tới UI. Không mở fallback raster tự động trong Convert Colors vì baseline còn lệch màu và thiếu OutputIntent.
- **Lô Q — PDF/X request/compliance fail-closed**: chuẩn PDF/X chỉ nhận `x1a|x4` ở cả API và engine trước khi dựng tên output; compliance X-1a dùng parser thật để bắt `rg`/RGB ở mọi trang và detector transparency sâu; X-4 surface blocker gốc thay vì lỗi chung/double-X.
- **Lô R — UI warning/download contract**: Save PDF/X hiển thị cảnh báo mất vector/gộp Spot, kiểm `response.ok` ở compliance + download và chỉ báo xanh sau khi commit Working File; Convert Colors cũng không còn nhận blob lỗi 404/500 làm PDF. Copy X-4 phản ánh đúng engine CMYK hiện hành.
- **Lô S — Recipe warning channel**: outcome của prepress runner giữ `warnings`/`engine` từ cả `warnings[]`, `log[]` và response PDF/X; PlaybackRunner truyền metadata tới kết quả + callback UI, ImpositionTab hiện cảnh báo sau khi artifact đã commit thay vì nuốt cảnh báo thành công.
- **Lô T — provenance OutputIntent cho compatibility flatten**: facade truyền cờ `color_managed` từ native PPE; lane flatten chỉ tiếp tục khi cờ là `True`, profile FOGRA39 hợp lệ và plate đúng đủ bốn process. Chỉ gắn OutputIntent khi mọi trang đã raster hoặc OutputIntent nguồn có `/N=4` và ICC bytes trùng FOGRA39, sau đó mở lại artifact kiểm `/N=4`/bytes. Mixed-page không có OI giữ nguyên provenance nguồn, đặt cờ `profile_mixed_unmanaged` và cảnh báo không print-ready; Spot/Separation + transparency fail-closed `[SPOT_FLATTEN_UNSUPPORTED]` thay vì dùng RGB preview làm trọng số CMYK.

Mỗi lô giữ thay đổi ở tối đa năm file source/test và được verify trước khi sang lô kế.

## Thay đổi đã ghi

### Lô A — §COLOR.01 và §COLOR.02

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/schemas/preflight.py` | Thêm `FixFileLogEntryResponse`; `FixFileWithLogResponse.log` là danh sách có kiểu, tương thích `ConvertColorsTool.tsx`. | FastAPI response-model không còn ValidationError. |
| `backend/app/core/pdf_actions_native.py` | Nén `zlib` trước khi khai `/FlateDecode` cho ảnh CMYK và Gray. | `read_bytes()` giải nén được; PDFium không render ảnh trắng. |
| `backend/tests/test_action_engine_native.py` | Regression reopen/decode và render ảnh đầu ra. | Hai ca writer đạt. |
| `backend/tests/test_convert_colors_http_contract.py` | Test đi qua router/response-model thật và download artifact. | HTTP 200, `log` là list, PDF tải được. |

### Lô B — §COLOR.04

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/core/pdf_actions_native.py` | Parser hậu kiểm theo page/Form/Pattern/annotation AP; bắt XObject RGB/JPX, inline image, named CalRGB/Lab, toán tử RGB và colorspace không xác minh được. Không đệ quy alternate của `Separation`/`DeviceN`; DeviceGray/CMYK được phép. Hậu kiểm trước và sau serialize. | Residual trả `supported=False`, không tạo artifact. |
| `backend/app/api/routes/preflight.py` | Dọn output trung gian khi blocker; log/error hiển thị tối đa ba blocker đã ẩn path. | HTTP business failure, `output_filename=null`, download 404. |
| `backend/app/core/action_engine.py` | Surface blocker đã lọc ở log `refused`, vẫn giữ staging/atomic publish. | ActionEngine không trả `output_path` khi hậu kiểm fail. |
| `backend/tests/test_action_engine_native.py` | Artifact JPX/inline/CalRGB/Lab và invariant Spot alternate Lab/Gray; test ActionEngine cleanup. | Ma trận fail-closed/negative đạt. |
| `backend/tests/test_convert_colors_http_contract.py` | Test route residual, giới hạn blocker và che đường dẫn. | Không còn file partial trong thư mục kết quả. |

### Lô C — §COLOR.03

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/assets/icc/sRGB.icc` | Thay profile Adobe RGB (1998) 560 byte bị đặt sai tên bằng profile `sRGB built-in` 588 byte do LittleCMS sinh. | Native Combine artifact gắn `/ICCBased`, `/N=3`, description `sRGB built-in`. |
| `backend/tests/test_icc_and_color_preview.py` | Giữ Adobe RGB cũ thành fixture độc lập để regression vẫn kiểm tra cơ chế cách ly asset đặt sai tên. | 31 test ICC/preview đạt. |
| `backend/app/api/routes/export.py`, `backend/app/workers/sticker_engine.py` | Cập nhật comment theo invariant profile đã xác minh; fallback LittleCMS vẫn giữ. | Không còn tài liệu source khẳng định bundle sRGB thực chất là Adobe RGB. |

### Lô D/E — §COLOR.05–.07 và §COLOR.09

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/core/pdf_actions_native.py` | Cache transform theo bytes ICCBased RGB nhúng; map đủ bốn intent; BPC bật mặc định; `preserve_black` giữ RGB `0/0/0` thành `0/0/0/1 K` cho operator/named vector (pixel ảnh vẫn đi ICC/GCR); gắn + hậu kiểm OutputIntent đúng ICC đích. | Fixture ICCBased dùng bytes profile nhúng; vector black K-only; profile hash nhúng khớp; OutputIntent SWOP cũ bị thay. |
| `backend/app/api/routes/preflight.py` | Truyền `rendering_intent` và `preserve_black` từ request xuống converter thật. | HTTP contract dùng `perceptual/false` và bắt được đúng kwargs. |
| `backend/app/core/action_engine.py` | Recipe/ActionEngine truyền cùng policy, giữ staging/fail-closed. | Nhánh action không còn hard-code policy khác route chuyên dụng. |
| `backend/tests/test_action_engine_native.py` | Thêm regression ICC nguồn, black vector/ảnh, OutputIntent thiếu/cũ. | Artifact mở lại + hash/stream assertions đạt. |
| `backend/tests/test_convert_colors_http_contract.py` | Khóa hợp đồng option UI/API → sink. | Không còn ca request được nhận nhưng bị bỏ qua. |

### Lô F1 — §COLOR.10–.11 (PPE)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `print_engine/src/color/space.rs` | CalRGB/CalGray không còn bị hạ âm thầm thành DeviceRGB/Gray sạch; ghi approximate colorspace để consumer chuyển compatibility lane. | CalRGB artifact có `ink_unsound=true`; 13 test render ICC đạt. |
| `print_engine/src/image/sampler.rs`, `print_engine/src/content/interp.rs` | Đọc `/SMask /Matte`, khử preblend theo alpha trước ICC; tắt fast path CMYK raw khi có Matte; color-key `/Mask` bật cờ unsupported. | Unit unblend + full Rust suite 371 pass/2 ignored. |
| `print_engine/tests/render_icc.rs`, `print_engine/tests/render_transparency.rs` | Regression CalRGB warning và metamorphic Matte vs unassociated reference. | CalRGB + Matte parity pass; full Rust tests xanh. |

### Lô F2 — §COLOR.11 (writer fail-closed)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/core/pdf_actions_native.py`, `backend/tests/test_action_engine_native.py` | RGB image có `/SMask /Matte` hoặc color-key `/Mask` không được đổi nửa vời; postflight từ chối artifact còn RGB. | Test trả `supported=false`, không có output partial; backend suite 147 pass. |

### Lô G — §COLOR.08/.09/.12 (profile, giữ sáng và validation)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `desktop/src/components/preprocess-tools/ConvertColorsTool.tsx` | Bỏ `auto/relative` ẩn; lấy profile + intent từ workspace theo tab, tải registry thật, khóa profile thiếu, cho chọn preserve-black; hiển thị Relative+BPC là policy khuyến nghị và gửi cùng request/recipe. | Test store → UI → request và UI → store đạt; Output Preview dùng cùng state. |
| `desktop/src/components/preprocess-tools/PreprocessSuccessPersistence.test.tsx`, `RecipeToolTicket.integration.test.tsx` | Bọc đúng WorkspaceContext và khóa request `fogra39/relative/preserve-black/BPC`. | Hai file, 8 test đạt. |
| `desktop/src/i18n/locales/vi.json`, `en.json` | Copy profile/intent/BPC và lỗi profile thiếu bằng VI/EN. | JSON parse + typecheck đạt. |
| `backend/app/schemas/preflight.py` | Enum conversion/profile/intent, danh sách tối thiểu một phần tử/không trùng, BPC typed; item profile response có kiểu. | OpenAPI/Pydantic trả 422 trước handler cho input sai. |
| `backend/app/api/routes/preflight.py` | Resolve profile tường minh trước pipeline; thiếu profile trả 422, thiếu FOGRA39 mặc định trả 503; không fallback ngầm; truyền BPC tới sink. | HTTP contract bắt đúng profile bytes/options. |
| `backend/tests/test_convert_colors_http_contract.py` | Ma trận rỗng/lạ/trùng, profile/intent lạ, profile đã biết nhưng chưa cài và BPC forwarding. | 9 test endpoint đạt. |

### Lô H — §COLOR.13 (corpus acceptance định lượng)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/tests/test_color_conversion_acceptance.py` | Image XObject 4.913 pixel đi qua writer thật, khớp reference BPC trong 1 byte; khóa mean/P95/signed ΔL*, Relative sáng hơn Perceptual, TAC mean/P95/max `≤147/250,5/330,5%`. PDF tám vector patch khóa TAC nonblack ≤200%, black K-only, không residual và OutputIntent đúng hash/pin bundle. | 2/2 test đạt; chạy cùng backend màu thành 106 pass. |

### Lô I — §COLOR.14–.16 (wide-gamut, color state và transparency)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/core/pdf_actions_native.py` | Mang source transform + số component xuyên các stream trong `/Contents`, push/pop đúng theo `q/Q`; hậu kiểm `sc/scn` theo color state. Phân biệt `/Resources <<>>` với thiếu `/Resources` để không tự kế thừa thành vòng lặp. Parse ICC thật và đối chiếu `GRAY/RGB/CMYK` với `/N=1/3/4`. Từ chối RGB image có SMask/Mask, RGB transparency group và alpha/soft-mask/blend mode sống bằng `[LIVE_TRANSPARENCY_RGB]`. | Split stream và `q/Q` đều đổi `scn` 3→4 đúng; ICC RGB khai `/N=4` trả `[INVALID_ICC_PROFILE]`; alpha không tạo output. |
| `backend/tests/test_action_engine_native.py` | Regression state xuyên stream/stack, mismatch ICC, Form kế thừa/resources rỗng, SMask thường/Matte và ExtGState alpha. | 49/49 test đạt. |
| `backend/tests/test_color_conversion_acceptance.py` | Thêm Adobe RGB 1998 và Display P3 deterministic nhúng: lưới 9³ + màu discriminator đi qua Image XObject thật, byte CMYK khớp LittleCMS trong 1, OutputIntent FOGRA39 đúng hash; khóa ΔE00, ΔL* và TAC. | 4/4 test đạt; màu `(60,200,100)` chứng minh output Adobe/P3 khác đường ép sRGB lần lượt `50/23` mức kênh. |

### Lô J — §COLOR.17 (flatten alpha trước ICC, lane cô lập)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/core/pdf_actions_native.py` | Trước scanner, nhận diện ảnh **DeviceRGB**+SMask được vẽ đúng một lần trên trang trắng chỉ có `q/Q/cm/Do`; composite trong RGB, khử `/Matte` theo công thức PDF, xóa SMask rồi mới chạy ICC. Theo dõi reference qua Form/annotation/pattern để không flatten object dùng lại; backdrop không chứng minh được vẫn `[LIVE_TRANSPARENCY_RGB]`. Fast path không parse trang nếu không có RGB+SMask. | Ảnh thường/Matte đạt CMYK byte theo CMM, không SMask; nền vector và ảnh dùng lại trong Form bị từ chối, không output. |
| `backend/app/api/routes/preflight.py` | Cảnh báo flatten được sanitize và nối vào log success; blocker phức tạp vẫn business failure, output null. | HTTP TestClient + socket thật: isolated alpha `200/success=true`, log nêu nền trắng; alpha có nền vector `200/success=false`, không artifact. |
| `backend/app/core/action_engine.py` | Báo cáo thêm `images_flattened`, truyền `black_point_compensation` cùng policy intent/preserve-black. | ActionEngine giữ staging/fail-closed; report phản ánh số ảnh đã flatten. |
| `backend/tests/test_action_engine_native.py`, `backend/tests/test_convert_colors_http_contract.py` | Regression Matte/ordinary, non-isolated backdrop, Form reuse; HTTP route thật kiểm warning + PDF CMYK/không SMask. | Lô J thêm 3 test; tổng ma trận màu liên quan trước Lô K là `191 passed, 2 warnings`. |

### Lô K — §COLOR.17 mở rộng (ICCBased alpha và oracle wide-gamut)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/core/pdf_actions_native.py` | Với ảnh ICCBased RGB hợp lệ, đổi mẫu **unassociated** từ profile nhúng sang profile DeviceRGB blend trước khi alpha lên giấy trắng; sau đó đổi `/ColorSpace` thành DeviceRGB để không diễn giải profile hai lần. Giữ nguyên lane cô lập, `/Matte` và fail-closed backdrop phức tạp. | Adobe RGB/P3 alpha artifact khớp oracle LittleCMS byte-for-byte; không còn SMask/RGB và hậu kiểm sạch. |
| `backend/tests/test_color_conversion_acceptance.py` | Thêm fixture ảnh ICCBased Adobe RGB/Display P3 + SMask, oracle `ICC nguồn → sRGB → alpha → FOGRA39`, kiểm OutputIntent `/N=4`/hash và TAC `≤330,5%`. | 6/6 test acceptance đạt; test bắt được lỗi blend raw ICC làm lệch độ sáng. |
| `backend/tests/test_action_engine_native.py` | Regression ICCBased sRGB alpha và profile mismatch, cùng invariants nền vector/Form reuse. | 52/52 test native đạt; blocker không xuất artifact. |

### Smoke HTTP/artifact sau Lô K

- Sidecar thật chạy cô lập ở cổng `18326`, sau đó đã dừng và kiểm tra cổng được giải phóng. `GET /health`, `POST /api/upload/local`, hai lần `POST /api/preflight/convert-colors` và download isolated đều đi qua HTTP socket.
- PDF Adobe RGB ICCBased + SMask cô lập trả `200/success=true`; log công khai cảnh báo flatten. Artifact tải xuống `485.920` byte mở lại được, image `/DeviceCMYK`, không `/SMask`, `has_rgb_content=false`, OutputIntent `/N=4`, SHA-256 FOGRA39 `da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77`.
- Cùng ảnh có nền vector trả `200/success=false`, `output_filename=null`, log chứa `[LIVE_TRANSPARENCY_RGB]`; không có artifact tải xuống.
- Bằng chứng lưu tại `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-color-real-http-lot-K` (`http-report.json`, `artifact-report.json`, PDF nguồn và PDF tải xuống).

### Lô L — §COLOR.18 (`/Decode` image/SMask fail-closed)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/core/pdf_actions_native.py` | Kiểm `/Decode`/`/D` của RGB image và DeviceGray SMask trước lane flatten và trước writer; chỉ nhận mapping mặc định `[0 1]` mỗi kênh. Mapping tùy biến sinh `[UNSUPPORTED_IMAGE_DECODE]`, không bị xóa âm thầm sau khi Pillow trả mẫu raw. | Probe 1×1 chứng minh `PdfImage.as_pil_image()` giữ `(255,0,0)` dù `/Decode [1 0 0 1 0 1]`; sau vá conversion trả unsupported/no-output. |
| `backend/tests/test_action_engine_native.py` | Regression ảnh RGB đảo kênh, SMask đảo alpha và negative invariant `/Decode` mặc định tường minh. | Native `54/54`; hai mapping tùy biến fail-closed, ordinary/Matte/default vẫn khớp CMM. |
| `backend/tests/test_convert_colors_http_contract.py` | Đi qua router thật với ảnh `/Decode` tùy biến; kiểm business failure, blocker và thư mục output rỗng. | HTTP contract `11/11`; `output_filename=null`, không download artifact. |

### Smoke HTTP sau Lô L

- Sidecar socket cô lập cổng `18327` nhận PDF Adobe RGB + SMask có `/Decode [1 0 0 1 0 1]` qua `POST /api/upload/local` rồi Convert Colors thật.
- API trả `200/success=false`, `output_filename=null`, log chứa `[UNSUPPORTED_IMAGE_DECODE]`; ba assertion business-failure/no-output/blocker đều đạt. Process đã dừng và cổng `18327` đã giải phóng.
- Báo cáo và PDF nguồn: `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-color-real-http-lot-L\http-report.json`.

### Lô M — §COLOR.19 (ICCBased RGB `/Range` fail-closed)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/core/pdf_actions_native.py` | Parse `/Range` của ICCBased `/N=3`; cho phép thiếu key hoặc canonical `[0 1]×3`, phân biệt range tùy biến với range hỏng. Scanner đưa blocker lên trước mọi writer; alpha candidate và flatten có thêm guard phòng thủ để không xóa ICC metadata trước khi kiểm. | Probe image/vector trước vá diễn giải mẫu raw thay vì domain `/Range`; sau vá image/vector/Indexed/alpha đều dừng no-output khi range không canonical. |
| `backend/tests/test_action_engine_native.py` | Ma trận bốn carrier cho canonical/custom; thêm range sai độ dài, không phải số và đảo cận ở lane alpha. | 11 test Lô M đạt; canonical vẫn ra CMYK sạch, custom/invalid có đúng mã blocker, `flattened_images=0`, không artifact. |
| `backend/tests/test_convert_colors_http_contract.py` | Gửi ICCBased RGB + SMask có range tùy biến qua router thật. | HTTP contract `12/12`; `success=false`, `output_filename=null`, log chứa `[UNSUPPORTED_ICC_RANGE]`, output không tăng. |

### Smoke HTTP/artifact sau Lô M

- Sidecar socket cô lập cổng `18328` nhận hai PDF ICCBased RGB + SMask qua `POST /api/upload/local`; process đã dừng và cổng đã giải phóng.
- Range canonical trả `200/success=true`, download `485.920` byte; mở lại thấy image `/DeviceCMYK`, không `/SMask`, `has_rgb_content=false`, postflight sạch và OutputIntent `/N=4` khớp SHA-256 FOGRA39 `da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77`.
- Range tùy biến trả `200/success=false`, `output_filename=null`, log chứa `[UNSUPPORTED_ICC_RANGE]`; số PDF kết quả trước/sau vẫn `1→1`, nên không có artifact lỗi mới.
- Bằng chứng: `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-color-real-http-lot-M` (`http-report.json`, `artifact-report.json`, hai PDF nguồn và PDF tải xuống).

### Lô N — §COLOR.20 (CalRGB calibration lane)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/core/pdf_actions_native.py` | Chuyển CalRGB phẳng qua ICC matrix-shaper dựng từ đúng `WhitePoint/Gamma/Matrix`; không hạ thành sRGB. Hỗ trợ image Flate/LZW/RunLength 8-bit, vector `cs/scn` và Indexed base; kiểm determinant, gamut/whitepoint, BlackPoint trước khi dựng profile. Alpha, shading, codec không chứng minh được vẫn dừng an toàn. | Artifact CalRGB Adobe-like khớp oracle Adobe RGB 1998 tối đa 1 byte; sample `(60,200,100)` ra `(222,0,217,0)`. |
| `backend/tests/test_action_engine_native.py` | Regression vector + image + Indexed, invalid/mismatch calibration, Lab invariant và alpha/shading fail-closed. | Native CalRGB lane và negative matrix đạt trong ma trận màu tổng. |
| `backend/tests/test_color_conversion_acceptance.py` | Lưới 9³ + discriminator CalRGB đi qua writer thật, so với profile Adobe RGB độc lập; khóa ΔE00/ΔL*/TAC/OI/postflight. | Acceptance `7/7`; CMYK max error `≤1`, TAC `≤330,5%`, OI FOGRA39 hash pin. |

### Smoke HTTP/artifact sau Lô N

- Sidecar socket cô lập cổng `18329` nhận CalRGB Adobe-like qua `/api/upload/local`, process đã dừng và cổng đã giải phóng.
- API trả `200/success=true`; download `485.920` byte mở lại thấy image `/DeviceCMYK`, bytes `[222,0,217,0]`, `has_rgb_content=false`, postflight sạch, OutputIntent `/N=4` đúng FOGRA39 SHA-256 `da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77`.
- Bằng chứng: `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-color-real-http-lot-N` (`http-report.json`, `artifact-report.json`, PDF nguồn và PDF tải xuống).

### Lô O — §COLOR.21 (vector alpha isolate lane)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/core/pdf_actions_native.py` | Nhận diện predicate rất hẹp: một content stream, một ExtGState indirect dùng đúng một lần, chỉ `/ca` alpha thường, một `rg` và một fill trên nền trắng; composite `alpha * RGB + (1-alpha) * white`, gỡ `gs`/resource rồi chạy CMM CMYK. Không đoán `/BM`, `/SMask`, group, Form, Pattern, nhiều paint hay resource dùng chung. | Positive artifact ra CMYK đúng oracle `_CmykTransform` cho `(1,.5,.5)`, không còn `/ExtGState`, hậu kiểm sạch; ca phức tạp trả `[LIVE_TRANSPARENCY_RGB]`, không output. |
| `backend/tests/test_action_engine_native.py` | Regression positive vector alpha + oracle CMYK và ma trận negative nhiều paint/q-Q state/blend/soft-mask/group. | Native `77 passed`; complex transparency và alpha bị khôi phục qua `q/Q` vẫn fail-closed. |
| `backend/tests/test_convert_colors_http_contract.py` | Khóa route thật: warning flatten xuất hiện trong `log`, download là PDF CMYK; source hai paint trả business failure/no-artifact. | HTTP contract vector alpha xanh; response model vẫn HTTP 200, `success` phản ánh đúng. |

### Smoke HTTP/artifact sau Lô O

- Sidecar thật chạy cô lập cổng `18331`, sau đó đã dừng và kiểm tra cổng được giải phóng.
- PDF một fill alpha (`/GS0 gs 1 0 0 rg ... f`) qua `/api/upload/local` →
  `/api/preflight/convert-colors` trả `200/success=true`; log công khai
  `flatten 1 ... nền giấy trắng`; download `485.706` byte mở lại được, content
  là `/DeviceCMYK` (`k`), không còn `/ExtGState`, đúng một OutputIntent `/N=4`
  với FOGRA39 hash `da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77`,
  postflight sạch. Render center source/output là `(255,128,128) → (242,126,128)`;
  chênh lệch là gamut/paper simulation của CMM Relative+BPC, không phải artifact
  trắng/đen.
- PDF hai fill alpha và PDF `q /GS0 gs Q ...` (alpha bị khôi phục trước paint)
  đều trả `200/success=false`, `output_filename=null`, log chứa
  `[LIVE_TRANSPARENCY_RGB]`; không có artifact mới. Transparency group RGB cũng
  bị từ chối cùng policy.
- Báo cáo và PDF nguồn/download: `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-color-real-http-lot-O-final-77qajni7` (`http-report.json`).

### Lô P — §COLOR.22 (hardening transparency raster)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/core/pdf_actions_native.py` | Detector quét inline image `/Mask`/`/SMask`, resources + CharProc của Type3 và content/AP/Form reachable. `flatten_transparency` kiểm đúng số byte từng plate, mở lại artifact để xác nhận không còn transparency; lỗi trả blocker có mã và xoá output. | Inline mask không còn `flattened=0/supported=true`; annotation AP còn alpha trả `[TRANSPARENCY_REMAINS]`; plate sai lưới trả `[PPE_PLATE_INVALID]`. |
| `backend/app/core/action_engine.py` | Surface tối đa ba blocker nghiệp vụ đã sanitize cho action Flatten Transparency, giữ staging/no-artifact. | HTTP thật trả mã `[PPE_RENDER_FAILED]` hoặc `[TRANSPARENCY_REMAINS]` trong log/error, `output_filename=null`. |
| `backend/tests/test_no_ghostscript_survival.py` | Regression inline mask, Type3 alpha, annotation AP sau raster, plate sai byte và ActionEngine blocker/cleanup. | File test `34 passed`; toàn ma trận màu liên quan `261 passed, 2 warnings`. |

### Baseline và smoke runtime sau Lô P

- Baseline bảy artifact complex transparency (`multi-alpha`, Multiply, page/Form group, soft-mask, Form alpha, image SMask) xác nhận Convert Colors vẫn dừng an toàn với `[LIVE_TRANSPARENCY_RGB]` ngoài lane; generic flatten xoá alpha cấu trúc nhưng raster DeviceCMYK **không có OutputIntent** và render drift tổng RGB `28–147` trên các điểm đo. Vì vậy không nối generic flatten thành fallback mặc định của RGB→CMYK. Bằng chứng: `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-color-transparency-lot-P-baseline\report.json`.
- Sidecar socket cô lập cổng `18332` đã chạy rồi dừng, cổng xác nhận đóng. Ca multi-alpha explicit Flatten thành công, cảnh báo `MẤT VECTOR`, artifact PDF 1.3 chỉ có image `/DeviceCMYK` và detector sạch. Inline mask trả business failure `[PPE_RENDER_FAILED]`; annotation AP còn alpha trả `[TRANSPARENCY_REMAINS]`; hai ca lỗi không có output filename.
- Báo cáo HTTP và PDF nguồn/download: `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-color-real-http-lot-P-mv_2mk5v\http-report.json`.

### Lô Q — §COLOR.23 (PDF/X request + compliance)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/schemas/preflight.py`, `backend/app/api/routes/preflight.py` | `standard` là `Literal['x1a','x4']` cho body và path; input lạ bị chặn trước lookup/engine. | `x3`, `../evil`, chuỗi rỗng và `X4` đều HTTP 422; số artifact không đổi. |
| `backend/app/core/pdfx_export.py` | Defense-in-depth validate chuẩn trước khi ghép output path. X-1a dùng `_scan_cmyk_postcondition` + detector transparency thay heuristic page string/10 trang. Giữ tối đa ba blocker đã che path từ convert/flatten và sửa nhãn `PDF/X-X4` thành `PDF/X-4`. | `rg` + alpha/Multiply trả `CMYK_ONLY=false`, `NO_TRANSPARENCY=false`; RGB ở trang 11 vẫn bị bắt; X-4 complex alpha trả 422 chứa `[LIVE_TRANSPARENCY_RGB]`, không output. |
| `backend/tests/test_pdfx_output_intent.py` | Regression schema/path, engine direct, compliance operator/alpha/trang 11, blocker/no-artifact qua engine và route. | File test `14 passed`; ma trận màu/PDF-X tổng `271 passed, 2 warnings`. |

### Baseline và smoke runtime sau Lô Q

- Baseline trước vá nhận nguyên `x3`, `../evil`, chuỗi rỗng; PDF `rg` + ExtGState `ca=.5/BM Multiply` bị báo sai `CMYK_ONLY=true`, `NO_TRANSPARENCY=true`. Artifact: `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-pdfx-lot-Q-baseline-5eh3dc7v`.
- Sidecar socket cô lập cổng `18333` đã chạy rồi dừng, cổng xác nhận đóng. CMYK đục xuất X-4 thành công, download `486.353` byte, PDF 1.6 có một OutputIntent và postflight sạch. Complex alpha được check X-1a đúng hai cờ fail, export X-4 trả 422 `[LIVE_TRANSPARENCY_RGB]`, số PDF kết quả không đổi. `../evil` trả 422 trước handler, không artifact.
- Báo cáo/PDF nguồn/download: `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-color-real-http-lot-Q-nwej2mw8\http-report.json`.

### Lô R — §COLOR.24 (UI warning + download/commit invariant)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `desktop/src/components/preprocess-tools/SavePdfxTool.tsx` | Kiểm HTTP compliance/export/download; yêu cầu output filename; chỉ đặt trạng thái xanh sau download + `onFileFixed`; render mọi warning backend trong khối amber. Unknown compliance check mặc định cần xử lý tay; thêm help định danh PDF/X. Sửa copy X-4 thành CMYK + Spot + ICC, transparency chỉ giữ khi an toàn. | Warning `MẤT VECTOR` hiện nguyên văn; download 404 không gọi `onFileFixed`, không panel xanh; compliance 422 hiện detail. |
| `desktop/src/components/preprocess-tools/ConvertColorsTool.tsx` | Kiểm `res.ok` và `download.ok`; chỉ `setResult` sau artifact download + Working File commit; catch xoá success state/expected output. | Blob JSON của 404 không còn được commit như PDF; UI hiển thị detail lỗi. |
| `desktop/src/components/preprocess-tools/PreprocessSuccessPersistence.test.tsx` | Thêm regression warning, Save PDF/X download lỗi, Convert Colors download lỗi và compliance lỗi. | Baseline `3 failed/7 passed`; sau vá `10 passed`; chạy cùng recipe ticket `12 passed`. |

### Verify UI sau Lô R

```text
npm run test -- --run
  src/components/preprocess-tools/PreprocessSuccessPersistence.test.tsx
  src/components/preprocess-tools/RecipeToolTicket.integration.test.tsx
12 passed

npm run typecheck
tsc --noEmit -p tsconfig.app.json · pass
```

Lô này là contract test Windows + typecheck; không tuyên bố đã click-smoke trong Tauri production build.

### Lô S — §COLOR.25 (Recipe warning channel)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `desktop/src/lib/recipe/recipeRunners.ts` | Chuẩn hóa cảnh báo từ `warnings[]`, `log[].message` (kể cả marker `Cảnh báo:`) và giữ `engine`; sanitize path trước khi đưa qua boundary UI. | Runner prepress trả metadata sau khi download + commit, không làm thay đổi outcome thành công sạch khi không có warning. |
| `desktop/src/lib/recipe/PlaybackRunner.ts` | Mở rộng outcome metadata additive; gom warning theo step, giữ cả nhánh lỗi/hủy và gọi `onStepWarning`. | `PlaybackResult.warnings` vẫn có mặt khi recipe thoát sớm sau một bước đã commit; warning không bị rơi giữa runner và orchestrator. |
| `desktop/src/components/ImpositionTab.tsx` | Nối callback thành toast thông tin tiếng Việt, hiển thị nội dung cảnh báo hoặc engine sau khi phát lại. | Người dùng thấy cảnh báo mất vector/engine trong Recipe thay vì chỉ thấy “Phát lại xong”. |
| `desktop/src/lib/recipe/recipeRunners.test.ts`, `desktop/src/lib/recipe/PlaybackRunner.test.ts` | Regression response PDF/X + Convert Colors warning/log và propagation callback/result. | `52 passed` cho 3 file recipe mục tiêu; toàn thư mục recipe `116 passed`; typecheck pass. |

### Verify Recipe sau Lô S

```text
npm run test -- --run src/lib/recipe
12 files, 116 passed

npm run typecheck
tsc --noEmit -p tsconfig.app.json · pass
```

## Kiểm chứng đã chạy

Từ `D:\pdfcompare\backend`:

```text
python -m pytest tests/test_action_engine_native.py tests/test_convert_colors_http_contract.py -q
42 passed, 2 warnings

python -m pytest tests/test_action_engine_native.py -q
39 passed, 1 warning

python -m pytest tests/test_convert_colors_http_contract.py -q
3 passed, 2 warnings

python -m pytest tests/test_no_ghostscript_survival.py -q
29 passed, 1 warning

python -m pytest tests/test_icc_and_color_preview.py -q
31 passed, 1 warning

python -m pytest tests/test_no_ghostscript_survival.py -k "pdfx or export_x4" tests/test_pdfx_output_intent.py -q
9 passed, 1 warning

python -m pytest tests/test_free_token_e2e.py -q
24 passed, 2 warnings

python -m pytest tests/test_preflight_download_containment.py tests/test_preflight_engine.py -q
33 passed, 2 warnings

python -m py_compile app/core/pdf_actions_native.py app/core/action_engine.py
  app/api/routes/preflight.py app/schemas/preflight.py

desktop: npm run typecheck
pass

desktop: npx vitest run src/components/preprocess-tools/PreflightTool.outputPreview.test.tsx
1 passed

python -m pytest tests/test_action_engine_native.py tests/test_convert_colors_http_contract.py
  tests/test_no_ghostscript_survival.py tests/test_icc_and_color_preview.py
  tests/test_pdf_manifest_engine.py tests/test_pdfx_output_intent.py -q
147 passed, 2 warnings

cargo test --manifest-path print_engine/Cargo.toml --lib --tests
371 passed; 2 ignored (lib) + integration suites xanh

desktop: npm run typecheck
pass

desktop: npx vitest run PreprocessSuccessPersistence RecipeToolTicket
  OutputPreviewLayout outputPreviewSimulation
4 files, 13 tests passed

backend: python -m pytest test_action_engine_native test_convert_colors_http_contract
  test_no_ghostscript_survival test_free_token_e2e -q
104 passed, 2 warnings

backend: python -m pytest test_color_conversion_acceptance và bốn suite trên -q
106 passed, 2 warnings

backend: python -m pytest test_color_conversion_acceptance test_action_engine_native
  test_convert_colors_http_contract test_no_ghostscript_survival
  test_icc_and_color_preview test_pdf_manifest_engine test_pdfx_output_intent
  test_free_token_e2e -q
188 passed, 2 warnings

Lô J chạy lại cùng ma trận sau khi mở lane flatten alpha:

```text
python -m pytest tests/test_color_conversion_acceptance.py
  tests/test_action_engine_native.py tests/test_convert_colors_http_contract.py
  tests/test_no_ghostscript_survival.py tests/test_icc_and_color_preview.py
  tests/test_pdf_manifest_engine.py tests/test_pdfx_output_intent.py
  tests/test_free_token_e2e.py -q
191 passed, 2 warnings
```

Lô K chạy lại sau khi mở source-ICC → blend-DeviceRGB và thêm oracle alpha wide-gamut:

```text
python -m pytest tests/test_color_conversion_acceptance.py
  tests/test_action_engine_native.py tests/test_convert_colors_http_contract.py
  tests/test_no_ghostscript_survival.py tests/test_icc_and_color_preview.py
  tests/test_pdf_manifest_engine.py tests/test_pdfx_output_intent.py
  tests/test_free_token_e2e.py -q
194 passed, 2 warnings
```

Lô L chạy lại sau chốt `/Decode` image/SMask:

```text
python -m pytest tests/test_color_conversion_acceptance.py
  tests/test_action_engine_native.py tests/test_convert_colors_http_contract.py
  tests/test_no_ghostscript_survival.py tests/test_icc_and_color_preview.py
  tests/test_pdf_manifest_engine.py tests/test_pdfx_output_intent.py
  tests/test_free_token_e2e.py -q
197 passed, 2 warnings
```

Lô M chạy lại sau chốt ICCBased RGB `/Range`:

```text
python -m pytest tests/test_color_conversion_acceptance.py
  tests/test_action_engine_native.py tests/test_convert_colors_http_contract.py
  tests/test_no_ghostscript_survival.py tests/test_icc_and_color_preview.py
  tests/test_pdf_manifest_engine.py tests/test_pdfx_output_intent.py
  tests/test_free_token_e2e.py -q
209 passed, 2 warnings

python -m pytest tests/test_preflight_download_containment.py
  tests/test_preflight_engine.py -q
33 passed, 2 warnings
```

Lô N chạy lại sau mở CalRGB calibration lane:

```text
python -m pytest tests/test_color_conversion_acceptance.py
  tests/test_action_engine_native.py tests/test_convert_colors_http_contract.py
  tests/test_no_ghostscript_survival.py tests/test_icc_and_color_preview.py
  tests/test_pdf_manifest_engine.py tests/test_pdfx_output_intent.py
  tests/test_free_token_e2e.py tests/test_preflight_download_containment.py
  tests/test_preflight_engine.py -q
249 passed, 2 warnings
```

Lô O chạy lại sau mở vector-alpha isolate lane:

```text
python -m pytest tests/test_color_conversion_acceptance.py
  tests/test_action_engine_native.py tests/test_convert_colors_http_contract.py
  tests/test_no_ghostscript_survival.py tests/test_icc_and_color_preview.py
  tests/test_pdf_manifest_engine.py tests/test_pdfx_output_intent.py
  tests/test_free_token_e2e.py tests/test_preflight_download_containment.py
  tests/test_preflight_engine.py -q
256 passed, 2 warnings
```

Lô P chạy lại sau hardening transparency raster:

```text
python -m pytest tests/test_color_conversion_acceptance.py
  tests/test_action_engine_native.py tests/test_convert_colors_http_contract.py
  tests/test_no_ghostscript_survival.py tests/test_icc_and_color_preview.py
  tests/test_pdf_manifest_engine.py tests/test_pdfx_output_intent.py
  tests/test_free_token_e2e.py tests/test_preflight_download_containment.py
  tests/test_preflight_engine.py -q
261 passed, 2 warnings

python -m pytest tests/test_no_ghostscript_survival.py -q
34 passed, 1 warning
```

Lô Q chạy lại sau chốt request/compliance PDF/X:

```text
python -m pytest tests/test_pdfx_output_intent.py -q
14 passed, 2 warnings

python -m pytest tests/test_color_conversion_acceptance.py
  tests/test_action_engine_native.py tests/test_convert_colors_http_contract.py
  tests/test_no_ghostscript_survival.py tests/test_icc_and_color_preview.py
  tests/test_pdf_manifest_engine.py tests/test_pdfx_output_intent.py
  tests/test_free_token_e2e.py tests/test_preflight_download_containment.py
  tests/test_preflight_engine.py -q
271 passed, 2 warnings
```

Lô R chạy UI consumer trên Windows:

```text
npm run test -- --run
  src/components/preprocess-tools/PreprocessSuccessPersistence.test.tsx
  src/components/preprocess-tools/RecipeToolTicket.integration.test.tsx
12 passed

npm run typecheck
pass
```

Probe lại artifact JPX thật trong thư mục audit: engine trả
`supported=False`, blocker `[RESIDUAL_JPX_RGB]`, và không tồn tại output.

### Smoke runtime cô lập

Agent đã tự chạy smoke kỹ thuật trên sidecar riêng ở cổng `18321`; không dùng
`run_dev.bat` vì script này dừng toàn bộ tiến trình Python/Node/Cargo đang chạy.

- `GET /health` trả `200` và `status=ok`.
- `POST /api/upload/local` nhận PDF RGB thật, nhận diện một trang và colorspace RGB.
- `POST /api/preflight/convert-colors` trả `200`, `success=true`, `log` là danh sách;
  `GET /api/preflight/download/{filename}` tải lại được PDF 1.148 byte.
- Artifact tải qua HTTP mở lại được bằng pikepdf, render được bằng PDFium ở
  `360 × 240 px`; hậu kiểm trả `passed=true`, không còn residual RGB/Lab/JPX.
- Trên bốn mảng màu của fixture: trắng giữ `ΔL*=0`, đen `+0,02`, mảng ICC
  `-1,23`, xám trung tính `-2,98`. Đây là smoke chống artifact trắng/hỏng, chưa
  thay cho đánh giá profile/intent ở các lô fidelity tiếp theo.
- Ca JPX RGB thật trả `success=false`, `output_filename=null`, blocker
  `[RESIDUAL_JPX_RGB]`; số PDF trong thư mục output không tăng.
- Ba test component liên quan `ConvertColorsTool`/output preview/recipe đạt
  `3 files, 8 tests passed`.

Trình duyệt trong Codex bị cô lập khỏi `localhost` của máy và máy không có kết
nối Chrome điều khiển, nên không thể tự động bấm trực tiếp cửa sổ Tauri trong
lượt này. Đây không phải phần smoke kỹ thuật chuyển cho người dùng: hợp đồng UI,
HTTP, tải artifact, reopen, hậu kiểm và render đều đã được agent thực hiện.

### Smoke runtime sau Lô C–F

Agent chạy sidecar cô lập mới ở cổng `18322`, upload một PDF có DeviceRGB,
ICCBased sRGB, RGB black và OutputIntent SWOP cũ, sau đó gọi API thật:

- Health/upload/convert/download đều HTTP 200; conversion hoàn tất trong 74 ms.
- Artifact tải xuống mở lại + render PDFium `400 × 400`; hậu kiểm đạt và
  `has_rgb=false`.
- RGB black thành `0 0 0 1 k`; OutputIntent SWOP cũ không còn; ICC nhúng đúng
  FOGRA39 654.352 byte và SHA-256 khớp profile engine đã dùng.
- Relative+BPC giữ paper-white `ΔL*=0`; gray `-3,14`, mảng ICC xanh `-5,10`
  trên fixture bốn ô. Ma trận bốn intent xác nhận Relative+BPC giữ white tốt
  nhất; Absolute có mean |ΔL*| thấp hơn nhẹ nhưng cố ý mô phỏng màu giấy
  (`white -0,78`), nên không đổi default in thực dụng.
- Sidecar thử nghiệm và port `18322` đã được dừng; artifact bằng chứng nằm tại
  `C:\Users\Khanh Pham\AppData\Local\Temp\PrynX-color-smoke-20260820-final`.

### Smoke runtime sau Lô G

Agent chạy sidecar cô lập mới ở cổng `18323` với đúng contract profile UI vừa
thêm, rồi tự dừng process sau smoke:

- Health, danh sách ICC, upload local, Convert Colors và download đều HTTP 200;
  phép đổi `fogra39 + relative + preserve-black + BPC` hoàn tất trong 84 ms.
- `conversions=[]`, profile không thuộc registry và profile `gracol` có trong
  registry nhưng chưa cài đều trả HTTP 422; converter không được chạy ở nhánh
  profile thiếu.
- PDF tải xuống 486.308 byte mở lại được, hậu kiểm `passed=true`, không còn RGB,
  RGB black là K-only; đúng một OutputIntent FOGRA39 654.352 byte có SHA-256
  `da2b9b…ce77`, khớp tuyệt đối profile đã chọn.
- PDFium render lại ở `400×400`; paper-white giữ `ΔL*=0`, xám trung tính
  `-2,98`, mảng xanh `-4,89` trên fixture. Đây là smoke số chống sai contract,
  không thay acceptance cảm quan/bản in.
- Báo cáo HTTP và artifact nằm tại
  `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-color-smoke-20260820-profile-contract`.

### Smoke HTTP/artifact sau Lô I

- Sidecar thật chạy cô lập ở cổng `18324`; `GET /health`, `POST /upload/local`,
  `POST /preflight/convert-colors` và `GET /download` đều đi qua HTTP socket.
  PDF Display P3 ICCBased trả `200/success=true`; download 486.389 byte mở lại
  được, Image XObject là `/DeviceCMYK`, `has_rgb=false`, hậu kiểm sạch và
  OutputIntent SHA-256 khớp FOGRA39 `da2b9b…ce77`.
- Cùng endpoint nhận PDF RGB có SMask trả `200/success=false`,
  `output_filename=null`, log chứa `[LIVE_TRANSPARENCY_RGB]` và không có file
  alpha nào được công bố. Process/port đã được dừng sau smoke.
- Artifact và báo cáo ở
  `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-color-real-http-lot-I`.

### Smoke HTTP/artifact sau Lô J

- Sidecar socket cô lập chạy ở cổng `18325`, sau đó đã dừng và kiểm tra cổng
  được giải phóng. `GET /health`, hai lần `POST /upload/local` và hai lần
  `POST /preflight/convert-colors` đều đi qua HTTP thật.
- PDF chỉ có một ảnh RGB+SMask: `200/success=true`; log công khai cảnh báo
  flatten trên nền giấy trắng. Download 485.920 byte mở lại được; image là
  `/DeviceCMYK`, không còn `/SMask`, `has_rgb=false`, hậu kiểm sạch, OutputIntent
  `/N=4` và SHA-256 FOGRA39 là
  `da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77`.
- PDF cùng ảnh nhưng có thêm nền vector: `200/success=false`, log chứa
  `[LIVE_TRANSPARENCY_RGB]`, `output_filename=null`; không có file mới theo
  prefix của upload lỗi.
- Báo cáo/artefact: `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-color-real-http-lot-J`
  (`http-report.json`, `artifact-report.json`, PDF nguồn và PDF tải xuống).

### Lô T — §COLOR.26 (flatten provenance và PPE contract)

| File | Thay đổi | Bằng chứng |
|---|---|---|
| `backend/app/core/print_engine/facade.py` | Giữ `color_managed` trong contract `separations()` để caller biết native đã dựng CMM; không suy diễn từ tên profile. | `test_ppe_facade.py` kiểm `color_managed is True` trên PPE thật. |
| `backend/app/core/pdf_actions_native.py` | Validate FOGRA39 CMYK trước render; truyền rõ `fogra39` + Relative; yêu cầu `color_managed is True`; kiểm plate đúng duy nhất C/M/Y/K và kích thước byte; Spot/Separation fail-closed `[SPOT_FLATTEN_UNSUPPORTED]`. Chỉ attach OI khi all-page raster hoặc source OI `/N=4` + ICC bytes khớp; mở lại artifact kiểm `/N=4`/bytes. Mixed-page không OI không gắn profile, trả `profile_mixed_unmanaged` và warning; OI hỏng/khác profile bị chặn. | All-page fixture có đúng 1 OI FOGRA39, `/N=4`, bytes khớp SHA-256 `da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77`, detector transparency sạch; mixed fixture giữ trang vector đục, không OI và warning explicit; Spot không tạo artifact. |
| `backend/tests/test_ppe_facade.py`, `backend/tests/test_no_ghostscript_survival.py` | Regression cho cờ CMM, all-page OI, mixed/no-OI, Spot, PPE unmanaged/missing/encoding/byte-count và hậu kiểm annotation. | `test_ppe_facade.py`: `50 passed`; `test_no_ghostscript_survival.py`: `39 passed`; cả hai chỉ có cảnh báo dependency đã biết. |

### Smoke và giới hạn fidelity sau Lô T

- Ma trận backend màu hiện tại (acceptance + ActionEngine + Convert Colors HTTP + Flatten/PDF-X + ICC preview + PPE facade) đạt `326 passed, 2 warnings`; riêng Flatten `39` và PPE facade `50` sau khi khóa provenance CMM/plate.
- Artifact all-page raster đã chứng minh provenance FOGRA39: `/OutputIntents` đúng một phần tử, `/N=4`, stream ICC khớp hash trên; mixed-page không OI được đánh dấu không quản lý profile để UI/recipe không coi là print-ready. Spot + transparency trả `[SPOT_FLATTEN_UNSUPPORTED]`, không có output partial.
- Smoke artifact thật ở `C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-color-lot-T-smoke-3duxzh6k\smoke-report.json`: all-page `supported=true`, hai ảnh `/DeviceCMYK`, detector rỗng và OI hash đúng; mixed-page giữ trang vector/không gắn OI + `profile_mixed_unmanaged=true`; Spot trả blocker và `output_exists=false`.
- Fidelity complex transparency vẫn **HOLD**: baseline bảy ca cho `render_delta_mean` khoảng `9,688–76,562` và `render_center_delta` `28–147` (PDFium RGB, 72 DPI); OI chỉ sửa provenance, không chứng minh appearance/độ sáng. Generic flatten tiếp tục là compatibility lane mất vector, không được làm fallback tự động RGB→CMYK cho đến khi có source-RGB raster oracle + gate `ΔL*`/`ΔE00` và proof màn hình/bản in.

### Click-smoke Tauri trên source hiện tại — 2026-08-20

- Agent tự khởi động backend và Tauri dev cô lập, thao tác thật trong cửa sổ app qua
  WebView2/CDP: tìm công cụ **Chuyển hệ màu**, chọn FOGRA39 + Relative, kiểm
  **Giữ chữ và nét đen thành K thuần** cùng BPC, rồi bấm **Thực thi**. Không dùng
  `run_dev.bat` vì script đó dừng toàn bộ Python/Node/Cargo trên máy.
- Harness đạt `23/23`, `0` console error, `0` page error và `0` network failure.
  Báo cáo đầy đủ ở
  `D:\pdfcompare\.tmp\runtime-smoke\color-click-20260820\color-click-report.json`;
  ảnh chụp positive/negative nằm cùng thư mục. Manifest bền vững có hash và
  giới hạn phạm vi nằm tại
  `docs/audit/evidence/W3_U05_TAURI_CLICK_SMOKE_2026-08-20.json`.
- Ca positive dùng PDF RGB có OutputIntent SWOP cũ: API trả `success=true`, tải
  `486.308` byte, Viewer mở được một trang và Working File đổi đúng một lần
  (`historyLength=1`). Artifact tải lại không còn RGB, hậu kiểm `passed=true`,
  có đúng một OutputIntent `/N=4` với ICC FOGRA39 SHA-256
  `da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77`;
  SWOP cũ bị thay, black là `0 0 0 1 k`, white là `0 0 0 0 k`.
- Ca negative có hai fill RGB alpha + Multiply: API trả business failure,
  `output_filename=null`, UI hiện `[LIVE_TRANSPARENCY_RGB]`; tên, kích thước,
  URL và lịch sử Working File giữ nguyên (`historyLength=0`), không có banner
  thành công hoặc artifact partial.
- Các process/cổng dev `8321`, `8322`, `5173`, `5174`, `9223` đã được dừng và
  kiểm tra không còn listener. Đây là runtime click-smoke của **source hiện tại**;
  chưa phải smoke installer production đóng gói. Worktree đang chứa nhiều thay
  đổi ngoài audit màu nên không build installer chỉ để nâng mức bằng chứng.

## Trạng thái sau Lô T

Ba P0 §COLOR.01–.03 và các hợp đồng chuyển đổi trực tiếp/PDF-X/UI consumer §COLOR.04–.09/.12–.26 đã được chặn ở mức test + artifact + HTTP runtime. Luồng phẳng sRGB/AdobeRGB/Display P3/CalRGB, lane ảnh alpha cô lập (kể cả source ICCBased đổi qua blend DeviceRGB) và lane vector alpha đơn giản nay có hậu điều kiện, profile/intent công khai, corpus ΔL*/ΔE00/TAC tự động; `/Decode`, ICCBased `/Range`, transparency carrier ẩn, chuẩn PDF/X lạ, blob download lỗi, recipe warning channel và provenance OI của compatibility flatten không còn tạo một artifact/Working File “sạch” giả. Toàn bộ họ engine màu vẫn chưa được gọi production-ready vì:

- `auto` vẫn là alias FOGRA39 cho API/recipe cũ, chưa tự suy điều kiện giấy/máy in; UI mới không còn gửi `auto` mà buộc chọn profile thật đang có trên máy (§COLOR.08).
- Corpus đã khóa sRGB/AdobeRGB/Display P3 phẳng; vẫn cần profile giấy khác, file khách có reference và các lớp transparency sau khi có flatten đúng (§COLOR.13/.16).
- `ΔE00` và `ΔL*` đã là gate số tự động, nhưng màn hình hiệu chuẩn và bản in đo quang phổ vẫn là acceptance vật lý còn mở.
- CalRGB matrix lane đã mở cho calibration tự nhất quán, nhưng BlackPoint khác 0, alpha/shading và codec ảnh ngoài lane vẫn fail-closed; PPE Rust vẫn giữ compatibility/unsound cho CalRGB chưa áp calibration (§COLOR.10/.20).
- ICCBased RGB `/Range` không canonical hiện được fail-closed có mã lỗi rõ; hỗ trợ đầy đủ domain tùy biến vẫn cần oracle riêng cho vector clip, image decode và `/Matte` trước khi mở lại (§COLOR.19).
- Ảnh RGB+SMask cô lập trên trang trắng nay được flatten trong blending space DeviceRGB đúng theo source ICC rồi mới CMYK (§COLOR.17); một fill vector RGB alpha đơn giản cũng được composite trên nền trắng (§COLOR.21). Ảnh có nền/vector/Form/annotation/pattern, nhiều fill, color-key `/Mask`, soft-mask, blend mode và transparency group vẫn fail-closed vì chưa chứng minh được backdrop.
- Generic Flatten Transparency đã có hậu kiểm artifact và detector sâu hơn (§COLOR.22), provenance PPE/FOGRA39 và guard mixed-page/Spot (§COLOR.26), nhưng vẫn là compatibility lane raster mất vector. OI không làm mất drift appearance của transparency phức tạp; không được dùng làm fallback tự động của Convert Colors cho tới khi có source-RGB raster oracle, profile đích và gate ΔL*/ΔE00.
- Compliance X-1a nay bắt RGB/transparency bằng parser thật và PDF/X export giữ blocker cụ thể (§COLOR.23). UI Save PDF/X/Convert Colors và Recipe playback đều hiển thị warning, chặn download lỗi trước Working File, và giữ engine provenance sau commit (§COLOR.24–.25). Tauri dev trên source hiện tại đã click-smoke positive/negative; installer production đóng gói vẫn là audit unit riêng chưa chạy.
- PDF shading/gradient vector RGB vẫn fail-closed; muốn hỗ trợ phải rasterize/flatten có oracle hoặc viết lại hàm nội suy mà giữ appearance.

Smoke kỹ thuật sau Lô A–F đã đạt. Đánh giá cảm quan trên màn hình hiệu chuẩn hoặc
bản in vật lý vẫn là acceptance cuối của nhà in, không thay thế được bằng test số.

### Lô U — §COLOR.27 (tinh chỉnh theo quy trình Photoshop/in nhanh)

- UI Convert Colors mặc định dùng `adjustment_stage=post_cmyk`: engine thực hiện
  `RGB → CMYK (profile đích) → Lab của CMYK đích → bù L*/tương phản/độ rực → CMYK`.
  Vì vậy các thanh kéo được áp dụng trên bản CMYK/proof, đúng thứ tự thao tác
  thường dùng trong Photoshop/Acrobat; giá trị mặc định `0` vẫn giữ chuyển đổi
  ICC byte-parity.
- Tùy chọn nâng cao `pre_icc` vẫn được giữ cho recipe cần điều chỉnh gamut nguồn.
  Không kéo trực tiếp C/M/Y/K để tránh phá TAC và chính sách chữ/nét đen K thuần;
  DeviceGray, Spot/DeviceN và transparency phức tạp vẫn giữ invariant/fail-closed.
- Hợp đồng schema/route/recipe gửi rõ `adjustment_stage`; backend kiểm tra miền
  `brightness_lstar -10..10`, `contrast_percent/vibrance_percent -20..20`, không
  âm thầm clamp. Cảnh báo UI nêu rõ đây là Lab/proof adjustment, không phải
  Curves từng kênh mực; cần xem lại TAC trong Preflight sau khi kéo mạnh.
- Verify: backend màu + acceptance + HTTP contract `106 passed, 2 warnings`; UI
  persistence `10 passed`; `tsc --noEmit` xanh; probe `Desktop\rgb.pdf` với
  `post_cmyk/+2` trả `supported=true`, postflight sạch và OutputIntent FOGRA39
  đúng hash `da2b9b…ce77`.
