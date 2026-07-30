# Nhật ký triển khai Phục hồi & Vector hóa Logo — 2026-07-29

## Quyết định phạm vi

Kết quả spike VTracer giữ tính năng ở trạng thái **HOLD/NO-GO đối với auto-color**.
MVP chỉ tiếp tục với hai luồng đã có bằng chứng đủ rõ:

- `monochrome`: logo một màu/đen trắng;
- `fixed_palette`: người dùng xác nhận từ 2 đến 12 màu trước khi vector hóa.

Không quảng bá khả năng tự dựng lại phần logo bị che, mất nét hoặc suy đoán chính xác
màu in từ một ảnh không có profile màu.

## Lô A — Hợp đồng và API tiền kiểm

Phạm vi lô: 5 file.

| Hạng mục | Trạng thái | Ghi chú |
|---|---|---|
| Schema cấu hình | Hoàn thành | Crop/phối cảnh dùng tọa độ chuẩn hóa; palette được kiểm tra và loại màu trùng |
| API capabilities | Hoàn thành | Chỉ công bố `monochrome` và `fixed_palette`; auto-color và preview engine đều tắt |
| API preflight | Hoàn thành | Nhận PNG/JPEG/WebP, kiểm giới hạn dung lượng, metadata, EXIF, alpha, ICC và DPI |
| Đăng ký route | Hoàn thành | Route nằm dưới `/api/logo-rebuild` và dùng license guard hiện có |
| Kiểm thử hồi quy | Hoàn thành | Bao phủ hợp đồng mode, palette, ảnh lỗi, EXIF và phối cảnh suy biến |

### Biên an toàn

- API tiền kiểm không ghi ảnh khách hàng ra đĩa.
- Ảnh giải nén vượt ngưỡng an toàn của Pillow bị từ chối.
- Giới hạn dung lượng dùng `MAX_FILE_SIZE_MB` hiện có, không thêm hard-cap hiệu năng mới.
- File ảnh động và định dạng ngoài PNG/JPEG/WebP không thuộc MVP.
- Lô này chỉ đọc metadata và xác thực đầu vào; chưa tạo preview hoặc SVG.

### Hợp đồng API

- `GET /api/logo-rebuild/capabilities`
- `POST /api/logo-rebuild/preflight`
  - multipart `file`;
  - multipart `settings_json` theo `LogoRebuildSettings`.

## Cổng xác minh lô A

Lô chỉ được đóng sau khi đạt cả hai kiểm tra:

1. biên dịch cú pháp các file Python đã chạm;
2. toàn bộ `backend/tests/test_logo_rebuild.py` chạy xanh.

Kết quả ngày 2026-07-29:

- `py_compile`: đạt;
- `pytest backend/tests/test_logo_rebuild.py -q`: **6 passed**;
- ba cảnh báo đều là deprecation từ dependency hiện có, không phát sinh từ lô A.

## Lô B — Adapter VTracer native

Phạm vi lô: 4 file sản phẩm (`Cargo.toml`, `Cargo.lock`, đăng ký module và adapter mới).

- Ghim chính xác `vtracer =1.0.0-alpha.2`; không thêm `[profile.release]`.
- Adapter chỉ nhận RGBA thô, chỉ mở `monochrome` và `fixed_palette`.
- Fixed palette được ánh xạ trực tiếp sang `Config.palette`; không đi qua auto-color.
- Có `LogoVectorizerCancel` để backend hủy engine thật khi request preview bị hủy.
- Phần tính toán nhả Python GIL để endpoint hủy có thể chạy đồng thời.
- Kiểm tra Rust: **5 passed**; gồm độ dài buffer, hợp đồng palette, SVG giữ màu và hủy sớm.
- `rustfmt` riêng file mới và `git diff --check`: đạt. Toàn crate chưa đạt `cargo fmt --check`
  vì nhiều file có sẵn chưa theo rustfmt; lô này không format hàng loạt để tránh chạm thay đổi khác.

## Lô C — Tiền xử lý và API preview có thể hủy

Phạm vi lô: 4 file code/test và nhật ký này.

- Thêm tiền xử lý EXIF, ICC→sRGB, crop, hiệu chỉnh phối cảnh và trường sáng.
- `despeckle_size_px` phản ánh đúng ngữ nghĩa VTracer; vẫn nhận alias cũ
  `despeckle_area_px` ở đầu vào để không làm gãy project/request đã tạo.
- Fixed palette mặc định smoothing `1.0`; monochrome giữ `0.5` theo preset spike.
- Preview chạy qua heavy-job scheduler hiện có; không tạo threadpool hoặc hard-cap mới.
- Máy dưới 16 GB có thể giảm preview theo RAM khả dụng; máy từ 16 GB giữ nguyên kích thước,
  chỉ từ chối khi RAM hiện còn trống không đủ cho chính job đó.
- Frontend cung cấp UUID `job_id`; registry chỉ giữ cờ hủy của job đang chạy, không giữ ảnh/SVG
  và luôn dọn trong `finally`. Cờ được đăng ký trước hàng đợi scheduler nên Hủy không có khe race
  khi job chưa bắt đầu chạy.
- API mới: `POST /api/logo-rebuild/preview` và
  `DELETE /api/logo-rebuild/jobs/{job_id}`.

Kết quả xác minh:

- `py_compile`: đạt;
- `pytest backend/tests/test_logo_rebuild.py -q`: **11 passed**;
- `maturin develop --release --offline`: đạt, module trong `backend/venv` báo
  VTracer `1.0.0-alpha.2`, auto-color tắt và cancellation bật;
- smoke ảnh PNG 256×128 → API → SVG thật: HTTP 200, đủ ba màu palette, SVG 564 byte;
- smoke hủy job đang hoạt động: endpoint hủy trả `cancelled`, preview trả HTTP 409 và registry sạch.

## Lô D — Workspace frontend và quyền tính năng

- Công cụ xuất hiện ở Home/menu với feature id `util.logo_rebuild` và mở thành tab độc lập.
- Workspace có ảnh nguồn/kết quả song song, hai mode được duyệt, crop chữ nhật, phối cảnh bốn
  điểm, smoothing, despeckle, cân bằng sáng, hủy job và tải SVG.
- Mã palette cho phép nhập/paste chính xác `#RRGGBB`; auto-color không xuất hiện trong UI.
- Frontend và backend cùng khóa quyền Pro; test route chứng minh Free nhận 403 trước khi chạm engine.
- `THIRD_PARTY_NOTICES.md` được sinh lại từ dependency thật và đã có VTracer Rust
  `1.0.0-alpha.2` cùng VisionCortex/FloCurves trong phạm vi phát hành.

Xác minh hẹp:

- typecheck toàn desktop: đạt;
- 4 suite routing/workspace/quyền: **27 passed**;
- test component sau bổ sung ô mã màu: **2 passed**;
- test backend logo + feature gate + entitlement: **18 passed**;
- kiểm trình duyệt cục bộ: Home hiện công cụ Pro, workspace hiển thị đúng, ảnh 1400×1400 đi
  xuyên UI→API→VTracer và nút tải SVG được bật.

## Lô E — Loại nền đã xác nhận

Kiểm thử trình duyệt phát hiện SVG ban đầu còn hình chữ nhật màu áo. Để đúng mục tiêu lấy logo đi in:

- `fixed_palette` nhận 1–12 màu logo, hỗ trợ cả logo màu đơn;
- thêm `background_color` tùy chọn, bắt buộc khác màu logo;
- màu nền được đưa vào fixed palette để phân vùng ổn định;
- path nền đầu tiên được xem là nền ngoài và bị loại khỏi SVG;
- các path nền còn lại được giữ như vùng âm trong mask `prynx-background-cutout`, nhờ đó lỗ
  bên trong chữ, vòng tròn và logo rỗng không bị lấp thành mảng đặc;
- không suy đoán nền tự động: người dùng phải xác nhận màu cần bỏ.

Cổng hẹp sau thay đổi: Rust **6 passed**, backend logo **12 passed**. Test cấu trúc xác nhận
SVG không còn màu nền, có mask khoét lỗ và vẫn giữ màu logo. Smoke xuyên API trả HTTP 200,
`background_removed=true`, có mask khoét lỗ và SVG 66.706 byte.

## Xác minh cuối MVP thu gọn

Kết quả ngày 2026-07-29 sau thay đổi mask:

- `cargo test ... logo_vectorizer --lib --offline`: **6 passed**;
- `rustfmt --check native/src/logo_vectorizer.rs`: đạt;
- `py_compile` schema/worker/route/test logo: đạt;
- backend logo + feature gate + entitlement: **19 passed**;
- desktop typecheck: đạt;
- 4 suite workspace/routing/quyền: **27 passed**;
- kiểm tra `THIRD_PARTY_NOTICES.md`: đạt;
- `git diff --check`: đạt.

MVP thu gọn đạt khoảng **95%**: chức năng lõi đã dùng được từ giao diện tới SVG và các cổng
tự động đều xanh. 5% còn lại là kiểm thử nghiệm thu với bộ ảnh thật của nhà in (logo trên áo
nhăn, phản sáng, phối cảnh lệch, logo có vùng rỗng), đánh giá SVG ở kích thước in thực tế và
chỉnh preset theo kết quả. Auto-color vẫn ở HOLD/NO-GO và không nằm trong phần trăm MVP này.
## Hồi quy ảnh alpha — mảng đặc biến thành viền

Ảnh kiểm thử thực tế của người dùng đã bác bỏ kết luận MVP 95% trước đó: logo PNG nền trong
suốt có mảng đen/xám đặc nhưng preview chỉ còn các nét viền rời và bị méo.

Nguyên nhân đã được tái hiện độc lập:

- cân bằng ánh sáng là phép high-pass `L - GaussianBlur(L) + median`; khi bật trên artwork alpha,
  phần ruột mảng đặc bị nâng gần trắng và chỉ cạnh còn tối;
- tùy chọn này trước đây bật mặc định ở cả schema lẫn workspace;
- binary frontend của VTracer ngưỡng hóa RGB nhưng không xét alpha, nên pixel trong suốt có RGB
  ẩn màu đen có thể bị nhận thành foreground.

Bản sửa:

- cân bằng ánh sáng mặc định tắt và chỉ dùng khi người dùng chủ động bật cho ảnh chụp;
- backend luôn bỏ qua cân bằng ánh sáng nếu ảnh có pixel trong suốt;
- trước monochrome trace, ảnh alpha được ghép lên nền trắng để giữ anti-alias và không đọc nhầm
  RGB ẩn của pixel trong suốt;
- test hồi quy kiểm tra tâm mảng vẫn đen, nền ngoài thành trắng đục trước khi vào binary tracer.

Smoke native với hai PNG alpha có RGB ẩn lần lượt là đen và trắng đều trả một path, một contour,
không phủ toàn canvas và contour bắt đầu đúng tại biên mảng logo. Trạng thái hiện tại quay lại
**beta cần người dùng kiểm tra lại đúng ảnh gốc**; chưa khôi phục tuyên bố 95% cho đến khi ca runtime
trong ứng dụng thật đạt.
## Đợt audit chất lượng — Lô 1/5: Lưu SVG, Undo/Redo và khóa preview cũ

Phạm vi code giữ đúng 5 file đã duyệt:

- desktop/src/lib/saveBlob.ts: thêm đường lưu Blob dùng Save dialog và write_file_atomic
  trong Tauri; browser/dev dùng anchor fallback có gắn vào DOM và thu hồi URL.
- desktop/src/lib/saveBlob.test.ts: khóa tên command, byte UTF-8, trường hợp hủy dialog
  và browser fallback.
- desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx: gom cấu hình editor thành
  snapshot history 60 bước, Undo/Redo, gộp thao tác liên tục 500 ms và đóng phiên gộp tại mốc tạo preview.
- Cùng workspace: mọi thay đổi file/cấu hình tăng revision, hủy job hiện hành, xóa SVG cũ và khóa nút tải;
  response sai revision, response của job đã hủy và response sau khi đóng tab đều bị bỏ.
- Cùng workspace: thao tác Hủy abort đúng controller ngay lập tức, không thể abort nhầm job kế tiếp;
  trạng thái “Preview đã sẵn sàng” bị xóa khi cấu hình đổi.
- desktop/src/components/ImpositionTab.tsx: truyền isActive; Ctrl/Cmd+Z/Y chỉ thuộc tab Logo đang active,
  không rơi xuống Undo của PDF. Ô nhập chữ giữ Undo native; range/checkbox/color dùng history Logo.
- desktop/src/components/preprocess-tools/LogoRebuildWorkspace.test.tsx: bao phủ lưu thành công/thất bại,
  Undo/Redo, preview mất hiệu lực, response trễ, hủy A rồi chạy B, unmount, mốc coalesce và hotkey active/inactive.

Kết quả xác minh tự động:

- npm run typecheck: đạt.
- 5 suite Logo/save/routing/tool panel/license: **36 passed**.
- ESLint riêng 4 file mới/chuyên biệt: đạt.
- npm run lint:budget: đạt; nợ lint có sẵn của toàn repo không bị mở rộng trong lô này.
- git diff --check cho file tracked và kiểm tra trailing whitespace cho 4 file mới: đạt.

Mức bằng chứng hiện tại: **Mức 2 — tự động**. Còn phải thử đúng runtime Tauri thật:
Save dialog phải xuất hiện, file SVG phải ghi/mở lại được, Undo/Redo phải đúng và đổi cấu hình
phải khóa nút tải cho tới khi tạo preview mới. Chưa mở Lô 2 trước khi ca runtime này được xác nhận.
## Tạm khóa tính năng theo quyết định sản phẩm

Sau phản hồi runtime về chất lượng màu và khả năng hiểu giao diện, Logo Rebuild được chuyển về trạng thái
HOLD và không còn công bố cho người dùng:

- xóa entry khỏi registry nên Home, menu Cửa sổ, danh sách công cụ và mini-toolbar không còn hiển thị;
- cờ LOGO_REBUILD_ENABLED=false chặn cả payload focusFeature cũ và không cho mount workspace;
- giữ nguyên component, API, backend và native adapter để tiếp tục nghiên cứu sau, không xóa mã nguồn;
- không tiếp tục các lô nhận diện màu/hình học trong đợt tối ưu tính năng hiện hữu này.

Xác minh tự động sau khi khóa:

- desktop typecheck: đạt;
- 3 suite routing/tool panel/license: **26 passed**;
- ESLint cho helper và test bị tác động: đạt;
- git diff --check phạm vi file tracked: đạt.

Chỉ bật lại khi pipeline màu quan sát được và chế độ giữ góc sắc có bộ ảnh nghiệm thu đạt yêu cầu.
