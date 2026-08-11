# Nhật ký triển khai PrynX Logo Engine v2 — 2026-08-10

Tài liệu này ghi tiến độ sửa theo các lô đã được duyệt trong
`docs/KE_HOACH_PRYNX_LOGO_ENGINE_V2_2026-08-10.md`. Mỗi lô tối đa 5 file code và
phải được kiểm chứng độc lập trước khi chuyển sang lô kế tiếp.

## Lô A — Facade và VectorScene

Trạng thái: **hoàn tất ở Mức bằng chứng 2 (tự động), chưa xác nhận runtime**.

### Phạm vi code

1. `native/src/logo_engine/mod.rs`
   - Thêm facade `prepare → trace`, hợp đồng backend, phase/progress và output có provenance.
   - VTracer vẫn là backend production; chưa bật tracer riêng và chưa đổi hành vi sản phẩm.
2. `native/src/logo_engine/request.rs`
   - Chuẩn hóa mode cũ thành profile `Silhouette`/`FlatColor`.
   - Thêm request version và SHA-256 settings hash ổn định; không quét lại buffer RGBA trên đường preview.
3. `native/src/logo_engine/scene.rs`
   - Định nghĩa `VectorScene` version 1 trong hệ tọa độ pixel gốc trên-trái.
   - IR phân biệt line/cubic, outer/hole + winding, fill và open stroke có độ rộng.
   - Thêm validation cơ bản cho version, kích thước, đường rỗng/hở, tọa độ và độ rộng nét không hợp lệ.
4. `native/src/logo_vectorizer.rs`
   - Đưa VTracer qua facade mới nhưng giữ nguyên ABI Python trả chuỗi SVG.
   - Giữ validation trước khi nhả GIL để lỗi đầu vào vẫn là `PyValueError` như trước.
   - Chuyển progress nội bộ của VTracer sang phase chung; Lô A chưa công khai progress qua PyO3/frontend.
5. `native/src/lib.rs`
   - Đăng ký module `logo_engine` nội bộ.
   - Giữ nguyên thay đổi PPE `PpeRenderSession` đã có từ phiên khác.

Không thêm dependency, không thêm cap/limit và không thay đổi Cargo release profile. Thiết kế clean-room,
không sao chép mã từ Inkscape.

### Bằng chứng kiểm chứng

- Baseline trước sửa: **8/8** Rust Logo tests đạt.
- Sau sửa: **16/16** Rust Logo tests đạt, gồm test facade, contract `VectorScene`, settings hash,
  validation, cancel/panic boundary và palette.
- Regression quan trọng: SVG đi qua facade mới **byte-for-byte giống** đường VTracer cũ.
- `cargo check --locked --offline`: đạt.
- `rustfmt --check` cho bốn file Logo: đạt.
- `git diff --check` cho năm file code Lô A: đạt.
- Backend Logo regression qua extension mới trong process mới: **49 passed**, có 2 warning từ dependency đã có.
- `maturin develop --release --offline`: phần build và cài `.pyd` mới thành công; bước pip dọn bản cũ trả lỗi
  do backend đang chạy giữ file `.pyd` cũ. Không dừng process hoặc xóa file của phiên khác.

### Giới hạn runtime

Backend đang chạy tại `127.0.0.1:8321` được khởi động trước lần rebuild nên vẫn giữ binary cũ trong bộ nhớ.
Pytest chạy bằng process mới đã nạp đúng extension mới, nhưng luồng thao tác thật trong ứng dụng chưa được chạy lại.
Vì vậy Lô A chỉ được chốt ở **Mức 2 — tự động**, chưa phải **Mức 3 — runtime**.

### Chốt lô

Lô A chỉ dựng contract và adapter tương thích; chưa có preprocess, contour, topology, curve-fit hoặc writer riêng.
Theo quy trình audit hai chốt, dừng tại đây để chủ dự án xác nhận trước khi mở Lô B.

## Lô B — Preprocess và màu

Trạng thái: **hoàn tất ở Mức bằng chứng 2 (tự động), chưa nối vào đường production**.

### Phạm vi code

1. `native/src/logo_engine/color.rs`
   - Thêm chuyển đổi sRGB → CIE Lab D65 và khoảng cách màu CIEDE2000.
   - Palette chỉ nhận màu `#RRGGBB` do người dùng xác nhận; không thêm đường auto-color.
2. `native/src/logo_engine/preprocess.rs`
   - Sinh alpha mask giữ nguyên coverage 0–255 và bản đồ nhãn palette xác định.
   - Pixel `alpha=0` dùng sentinel riêng, không để RGB ẩn tham gia ánh xạ màu hoặc hash.
   - Sinh component 4-liên kết theo từng nhãn mà không lọc diện tích, nhờ đó không làm mất màu nhấn nhỏ.
   - Sinh SHA-256 artifact hash từ dữ liệu đã chuẩn hóa.
3. `native/src/logo_engine/scene.rs`
   - Thêm hợp đồng `PreprocessArtifact`, component màu, bảng đếm pixel và invariant kiểm tra chéo.
   - Giữ rõ mỗi pixel nhìn thấy có đúng một nhãn; pixel trong suốt không mang nhãn màu.
4. `native/src/logo_engine/mod.rs`
   - Đăng ký module color/preprocess và bộ test Lô B.
5. `native/src/logo_engine/preprocess_tests.rs`
   - Thêm 10 ca synthetic cho alpha, palette, DeltaE, hash, component và dữ liệu lỗi.

Không thêm dependency, không hard-cap độ phân giải/chất lượng và không đổi Cargo release profile. Lô B chưa gọi
preprocess mới từ adapter VTracer nên ABI Python và SVG production vẫn giữ nguyên.

### Bằng chứng kiểm chứng

- Baseline đầu Lô B: **16/16** Rust Logo tests đạt.
- Sau sửa: **26/26** Rust Logo tests đạt; toàn bộ 16 test Lô A/legacy vẫn xanh.
- CIEDE2000 khớp cặp tham chiếu `2.0425` với sai số dưới `0.0001`.
- Ca olive cách đều đỏ/xanh lá theo RGB Euclid được ánh xạ theo khoảng cách cảm nhận thay vì tie RGB.
- Pixel RGB ẩn dưới `alpha=0` không đổi bản đồ nhãn hoặc artifact hash.
- Coverage alpha 1–255 được giữ và tham gia artifact hash.
- Vùng nhấn 2×2 trên ảnh 32×32, chiếm **0,39%**, vẫn giữ đủ 4 pixel trong một component.
- `cargo check --locked --offline`: đạt.
- `rustfmt --check` và kiểm tra whitespace cho năm file Lô B: đạt.
- Backend Logo regression qua extension mới trong process mới: **49 passed**, 2 warning dependency đã có.
- `maturin develop --release --offline`: build release/wheel và đặt `.pyd` mới thành công; lệnh trả exit 1 khi pip
  không xóa được thư mục leftover chứa bản cũ vì một Python process còn giữ file. Fresh-process import trỏ đúng
  `backend/venv/Lib/site-packages/pdfcompare_native` và capabilities VTracer không đổi. Không dừng process hoặc
  xóa leftover của phiên khác.

### Giới hạn runtime

Preprocess mới hiện là primitive nội bộ phục vụ contour tracer Lô C; đường production vẫn chạy VTracer nên chưa có
thao tác UI mới để nghiệm thu Mức 3. Lô B được chốt ở **Mức 2 — tự động** và dừng trước contour/topology.

## Lô C — Contour và topology

Ngày triển khai: **2026-08-11**. Trạng thái: **hoàn tất ở Mức bằng chứng 2 (tự động), chưa nối production**.

### Phạm vi code

1. `native/src/logo_engine/contour.rs`
   - Trích cạnh biên cho mọi nhãn màu trong một lần quét raster, giữ phần tô ở bên phải để outer có chiều CW trong
     hệ tọa độ pixel gốc trên-trái.
   - Ghép cạnh xác định theo quy tắc rẽ phải, tương ứng foreground 4-liên kết tại điểm chạm góc.
   - Biểu diễn tọa độ nhân 2; tại saddle dùng chamfer cố định 0,5 px để mở kênh chéo và không tạo contour tự chạm.
   - Loại đỉnh thẳng hàng chính xác, không simplify theo sai số và chưa curve-fit.
2. `native/src/logo_engine/topology.rs`
   - Kiểm contour suy biến, tự cắt/tự chạm bằng broad-phase theo ô lưới rồi mới kiểm giao đoạn.
   - Dựng cây containment theo từng nhãn; phân loại outer/hole theo độ sâu và kiểm winding tương ứng.
   - Chuyển contour thành `VectorLayer`/`FillRing` và kiểm tổng diện tích có dấu sau bù phần chamfer saddle.
3. `native/src/logo_engine/scene.rs`
   - Siết contract vùng tô: phải có outer, đường kín đủ đỉnh và cặp role/winding hợp lệ.
4. `native/src/logo_engine/mod.rs`
   - Đăng ký module contour/topology và bộ test Lô C.
5. `native/src/logo_engine/topology_tests.rs`
   - Thêm 12 ca synthetic cho counter, nesting, saddle, self-intersection, diện tích và determinism.

Không thêm dependency, cap độ phân giải/chất lượng hoặc Cargo release profile. Đường VTracer production và ABI Python
không đổi.

### Bằng chứng kiểm chứng

- Baseline đầu Lô C: **26/26** Rust Logo tests đạt.
- Sau sửa: **38/38** Rust Logo tests đạt; riêng topology **12/12** đạt.
- Counter chữ khối O/P/R/B lần lượt giữ đúng **1/1/1/2** hole.
- Cây lỗ lồng nhau giữ đúng bốn mức `outer → hole → outer → hole` với depth `0/1/2/3`.
- Hai pixel cùng màu chỉ chạm góc vẫn là hai outer riêng; checkerboard hai màu sinh hai contour cho mỗi nhãn.
- Ca nền nối chéo ban đầu phát hiện contour tự chạm tại saddle; sau bản sửa chamfer 0,5 px, kênh nền mở đúng và không
  sinh false hole. Có thêm regression với cạnh dài để chốt offset không phụ thuộc chiều dài đoạn.
- Bow-tie tự cắt bị từ chối; output contour lặp lại ổn định.
- Tổng diện tích có dấu cộng phần tam giác chamfer khớp chính xác số pixel raster.
- Ảnh toàn trong suốt bị chặn trước contour.
- `cargo check --locked --offline`, `rustfmt --check` và kiểm tra whitespace: đạt.
- `maturin develop --release --offline`: build release, wheel và cài editable extension thành công, exit 0.
- Fresh-process import trỏ đúng extension mới; capabilities VTracer không đổi.
- Backend Logo regression: **49 passed**, 2 warning dependency đã có.

### Giới hạn runtime

Contour/topology Lô C là primitive nội bộ cho profile engine riêng ở Lô E. Production vẫn gọi VTracer, chưa có writer
riêng và chưa có artifact mới để nghiệm thu UI/Mức 3. Dừng trước Lô D — curve-fit và simplify.

## Lô D — Curve-fit và simplify

Ngày triển khai: **2026-08-11**. Trạng thái: **hoàn tất ở Mức bằng chứng 2 (tự động), chưa nối production**.

### Phạm vi code

1. `native/src/logo_engine/curve_fit.rs`
   - Fit line hoặc cubic Bézier theo tolerance; solve hai handle bằng least-squares theo chord-length parameter.
   - Khi một cubic vượt tolerance, chia tại mẫu lỗi lớn nhất; hai nhánh dùng chung hướng tiếp tuyến tại điểm chia.
   - Đo lại contour nguồn với chính `ScenePath` cuối bằng chia đôi Bézier thích nghi và fail-closed nếu vượt tolerance.
   - Handle âm/không hữu hạn/quá chiều dài cung nguồn bị thay bằng handle an toàn, tránh loop/overshoot.
2. `native/src/logo_engine/simplify.rs`
   - Thêm Ramer–Douglas–Peucker dạng iterative cho đường mở và simplify đường kín theo các điểm bắt buộc.
   - Phân loại góc theo cửa sổ chiều dài cung gắn với tolerance, tránh nhận nhiễu bậc thang là góc cứng.
   - Cung cấp primitive vector, khoảng cách điểm–đoạn, tangent trung tâm và anchor xác định.
3. `native/src/logo_engine/scene.rs`
   - Công khai validation nội bộ cho engine; thêm `end_point()` và cách đếm node không đếm lặp điểm đóng vòng.
4. `native/src/logo_engine/mod.rs`
   - Đăng ký module simplify/curve-fit và bộ test Lô D.
5. `native/src/logo_engine/curve_fit_tests.rs`
   - Thêm 6 ca synthetic cho line, cubic, circle, góc vuông, continuity và saddle half-pixel.

Không thêm dependency, cap độ phân giải/chất lượng hoặc Cargo release profile. Curve-fit vẫn là primitive nội bộ;
VTracer production và ABI Python không đổi.

### Bằng chứng kiểm chứng

- Baseline đầu Lô D: **38/38** Rust Logo tests đạt.
- Sau sửa: **44/44** Rust Logo tests đạt; riêng curve-fit **6/6** đạt.
- 21 mẫu thẳng thu về đúng một line với sai số 0.
- Cubic nguồn 81 mẫu giữ sai số cuối không quá **0,03 px** và giảm node xuống dưới 1/4 nguồn.
- Hình vuông giữ đúng 4 góc cứng, 4 line và 4 node; không bị bo góc.
- Circle lượng tử 160 mẫu dùng cubic, sai số không quá **1 px** và giảm node xuống dưới 1/3 nguồn.
- Đường sin buộc chia nhiều cubic vẫn giữ cùng hướng tiếp tuyến tại ít nhất một join và sai số không quá **0,025 px**.
- Các đỉnh chamfer half-pixel của saddle được bảo vệ, không bị simplify xóa.
- `cargo check --locked --offline`, `rustfmt --check` và kiểm tra whitespace: đạt.
- `maturin develop --release --offline`: lần đầu build/wheel thành công nhưng pip cleanup vướng file cũ đang được giữ;
  sau khi các process test kết thúc, chạy lại cài editable thành công, exit 0. Không dừng hoặc xóa process ngoài phạm vi.
- Fresh-process import trỏ đúng extension mới; capabilities VTracer không đổi.
- Backend Logo regression: **49 passed**, 2 warning dependency đã có.

### Giới hạn runtime

Lô D chưa thay path của profile production và chưa có SVG writer/QC render lại. Bằng chứng hiện tại là Mức 2 trên
primitive hình học; cần Lô E ghép profile rồi Lô F kiểm artifact trước khi đánh giá chất lượng runtime.

## Lô E — Hai profile core Silhouette và FlatColor

Ngày triển khai: **2026-08-11**. Trạng thái: **hoàn tất ở Mức bằng chứng 2 (tự động), chưa nối production**.

### Phạm vi code

1. `native/src/logo_engine/profiles/mod.rs`
   - Thêm router `Silhouette`/`FlatColor`, metrics chung và output gồm `VectorScene` + preprocess hash.
   - Router tự sinh provenance `prynx-logo-core/0.1.0-dev.1`; settings hash bao gồm cả background label.
2. `native/src/logo_engine/profiles/silhouette.rs`
   - Ghép pipeline alpha mask → contour → cây outer/hole → curve-fit.
   - Ánh xạ smoothing 0–1 sang tolerance/góc curve-fit; không gate chất lượng theo cấu hình máy.
3. `native/src/logo_engine/profiles/flat_color.rs`
   - Ghép preprocess CIEDE2000 → contour/topology theo từng nhãn màu.
   - Background là label tường minh và bị loại khỏi output; label sai hoặc loại hết logo sẽ fail-closed.
   - Giữ shared boundary dưới dạng line chính xác, chưa fit từng màu độc lập để tránh khe/hở do làm tròn.
4. `native/src/logo_engine/mod.rs`
   - Đăng ký module profiles và bộ test Lô E.
5. `native/src/logo_engine/profile_tests.rs`
   - Thêm 7 ca synthetic cho silhouette, dấu rời, 2/4/8/12 màu, background, shared boundary và determinism.

Không thêm dependency, cap độ phân giải/chất lượng hoặc Cargo release profile. ABI Python và đường VTracer production
không đổi.

### Bằng chứng kiểm chứng

- Baseline đầu Lô E: **44/44** Rust Logo tests đạt.
- Sau sửa: **51/51** Rust Logo tests đạt; riêng profile core **7/7** đạt.
- Silhouette giữ compound counter `outer + hole`, scene contract hợp lệ và curve-fit không vượt tolerance đã ánh xạ.
- Fixture chữ Việt có dấu rời giữ đủ 2 component/2 outer, không bị xem là speck và xóa.
- FlatColor chạy đủ **2/4/8/12** màu xác nhận; số layer/component khớp số màu hoạt động.
- Background label bị loại đúng; thay lựa chọn background làm đổi provenance settings hash.
- Hai mảng đỏ/xanh kề nhau giữ shared boundary `x=2` giống hệt ở cả hai layer và chỉ dùng line.
- Cùng request/options cho output scene, metrics và preprocess hash giống nhau.
- Hợp đồng background sai với silhouette hoặc loại hết output đều bị từ chối.
- `cargo check --locked --offline`, `rustfmt --check` và kiểm tra whitespace: đạt.
- `maturin develop --release --offline`: build release, wheel và cài editable extension thành công, exit 0.
- Fresh-process import trỏ đúng extension mới; capabilities VTracer không đổi.
- Backend Logo regression: **49 passed**, 2 warning dependency đã có.

### Giới hạn runtime

Core profile chưa được công khai qua PyO3 và chưa có SVG writer/QC render lại, nên production vẫn gọi VTracer. FlatColor
cố ý chưa curve-fit biên chung; `despeckle_size_px` cũng chưa được core mới áp để tránh xóa dấu/màu nhấn im lặng.
Hai điểm này phải được giải quyết hoặc khai báo rõ trước cổng production. Bước kế tiếp là Lô F — writer và QC artifact.

## Lô F — Writer và QC artifact

Ngày triển khai: **2026-08-11**. Trạng thái: **hoàn tất ở Mức bằng chứng 2 (tự động), chưa nối production**.

### Phạm vi code

1. `native/src/logo_engine/svg_writer.rs`
   - Ghi SVG xác định trực tiếp từ `VectorScene`, hỗ trợ line/cubic, fill `nonzero`, stroke và alpha.
   - Giữ `viewBox` pixel; chỉ ghi cặp width/height mm sau khi kiểm tỷ lệ với canvas.
   - Ghi provenance ổn định, SHA-256 và byte length của artifact cuối.
   - Ngân sách output là tham số của caller; không thêm hard-cap toàn cục.
2. `native/src/logo_engine/qc.rs`
   - Parse lại chính chuỗi SVG cuối theo tập lệnh writer dùng (`M/L/C/Z`), không lấy topology hoặc kích thước từ
     object trung gian để tự xác nhận.
   - Đối chiếu `viewBox`, cặp mm/pixel và số outer/hole; từ chối NaN/Infinity, path rỗng/suy biến, fill hở và
     winding topology sai.
   - Raster lại fill/stroke ở scale do caller chọn rồi đo IoU/MAE với RGBA nguồn; mỗi subpath giữ đúng trạng thái
     đóng/mở riêng khi raster stroke.
   - Mọi phép nhân kích thước raster dùng `checked_mul`; ngân sách input/raster do caller truyền, không hard-cap
     máy mạnh.
3. `native/src/logo_engine/mod.rs`
   - Đăng ký writer, QC và bộ artifact test Lô F.
4. `native/src/logo_engine/artifact_tests.rs`
   - Thêm 9 ca round-trip cho FlatColor, mm, counter/hole, cubic, determinism/hash, dữ liệu lỗi, ngân sách caller
     và artifact bị sửa viewBox/topology.

Không sửa `Cargo.toml`, không thêm dependency, cap độ phân giải/chất lượng hoặc Cargo release profile. ABI Python
và đường VTracer production không đổi.

### Bằng chứng kiểm chứng

- Baseline đầu Lô F: **51/51** Rust Logo tests đạt.
- Sau sửa: **60/60** Rust Logo tests đạt; riêng artifact writer/QC **9/9** đạt.
- FlatColor đỏ/xanh 4×2 round-trip từ core → SVG → parser/raster độc lập đạt **IoU 1,0** và **MAE 0,0**.
- Counter giữ đúng `1 outer + 1 hole` với `fill-rule="nonzero"`; cubic được ghi và parse lại bằng lệnh `C`.
- Cặp 40×20 mm trên canvas 4×2 round-trip đúng; tỷ lệ mm sai và xác nhận mm lệch đều bị từ chối.
- Cùng scene sinh SVG/hash giống hệt; SHA-256 writer khớp SHA-256 do QC tính lại trên artifact.
- Scene rỗng, NaN, artifact bị đảo winding, viewBox bị sửa và ngân sách output/input/raster quá mức đều fail-closed.
- `cargo check --locked --offline`: đạt.
- `maturin develop --release --offline`: build release/wheel thành công; pip đặt extension mới nhưng trả exit 1 vì
  không dọn được thư mục leftover cũ đang bị một Python process khác giữ. Không dừng process hoặc xóa leftover của
  phiên khác. SHA-256 của `.pyd` hiện hành khớp chính xác DLL release vừa build.
- Backend Logo regression chạy trong process mới trên extension đó: **49 passed**, 2 warning dependency đã có.

### Chốt M2 và giới hạn runtime

Mốc core G2 đã có đầy đủ primitive `preprocess → contour/topology → curve-fit/profile → writer/QC` và đạt **Mức 2
— tự động** trên synthetic artifact. Đây chưa phải GO production: core mới chưa qua PyO3, chưa chạy workflow Tauri,
chưa đo holdout logo khách có vector gốc và FlatColor vẫn chủ ý giữ shared boundary dạng line. Đường production tiếp
tục dùng VTracer. Dừng trước **Lô G1 — ABI structured result** để giữ đúng chốt theo lô.

## Lô G1 — ABI structured result

Ngày triển khai: **2026-08-11**. Trạng thái: **hoàn tất ở Mức bằng chứng 2 (tự động), backend production chưa chuyển core**.

### Phạm vi code

1. `native/src/logo_engine/result.rs`
   - Thêm schema kết quả version `1`, gồm SVG, artifact SHA-256/byte length/kích thước, provenance, preprocess hash,
     complexity/topology, sai số curve-fit và IoU/MAE raster artifact.
   - Ghép core profile → writer → parser/raster QC trong Rust; hash/byte length và outer/hole phải khớp giữa các
     tầng mới được trả qua ABI.
   - Reference QC dùng màu palette đã xác nhận; pixel thuộc background label được đưa về trong suốt trước khi đo,
     tránh phạt thao tác loại nền có chủ đích.
   - Kiểm token hủy tại ranh giới profile, writer và QC; ngân sách output/raster tiếp tục do caller truyền.
   - Trả warning tường minh khi `despeckle_size_px > 0` vì core chưa áp dụng khử hạt, không im lặng coi là đã xử lý.
2. `native/src/logo_vectorizer.rs`
   - Giữ nguyên `logo_vectorize_rgba` trả chuỗi SVG VTracer.
   - Thêm `logo_vectorize_structured_rgba` chạy core PrynX ngoài GIL và trả dict schema versioned.
   - Giữ phân loại lỗi: mode/buffer/palette/mm/QC options sai là `ValueError`; lỗi engine/artifact là `RuntimeError`;
     panic trong VTracer hoặc core được đổi thành lỗi thường tại cùng panic boundary.
   - Capabilities công bố riêng legacy engine, core engine/version, structured schema và mapping mode/profile.
3. `native/src/lib.rs`
   - Đăng ký hàm PyO3 structured mới; không đổi class cancel hoặc tên hàm legacy.
4. `native/src/logo_engine/mod.rs`
   - Đăng ký/re-export result contract và hằng version. Test API được đặt trong `logo_vectorizer.rs` để không vượt
     trần bốn file của lô; không tạo `api_tests.rs` bằng module path vòng.

Không sửa backend, `Cargo.toml`, dependency hoặc release profile. Đường production hiện tại vẫn gọi API legacy
VTracer; structured core chỉ được công khai để Lô G2 tích hợp có kiểm soát.

### Bằng chứng kiểm chứng

- Baseline đầu Lô G1: **60/60** Rust Logo tests đạt.
- Sau sửa: **65/65** Rust Logo tests đạt; 5 ca mới khóa determinism/schema, background trước QC, mm/warning,
  pre-cancel và validation cặp mm.
- API legacy qua facade vẫn byte-identical với đường VTracer trực tiếp.
- Structured FlatColor đỏ/xanh 4×2 lặp lại giống hệt, trả engine `prynx-logo-core`, **IoU 1,0**, **MAE 0,0** và
  artifact hash 64 ký tự.
- Loại nhãn xanh làm background trước QC còn một layer đỏ và vẫn đạt **IoU 1,0 / MAE 0,0**.
- Smoke trong Python process mới xác nhận dict schema `1`, cặp 40×20 mm, API legacy vẫn là `str`, token đã hủy trả
  `RuntimeError` và cặp mm thiếu trả `ValueError`.
- `cargo check --locked --offline`: đạt.
- `maturin develop --release --offline`: build release/wheel thành công; pip trả exit 1 vì không dọn được leftover
  `.pyd` cũ đang bị process khác giữ. Không dừng process hoặc xóa leftover của phiên khác. SHA-256 extension hiện
  hành khớp chính xác DLL release vừa build.
- Backend Logo regression trên extension mới: **49 passed**, 2 warning dependency đã có.

### Giới hạn runtime

Core mới đã đi qua ABI thật nhưng backend chưa gọi hàm structured, vì vậy đây vẫn là **Mức 2**, chưa phải runtime
Tauri hay GO production. Cancel hiện được quan sát ở checkpoint giữa các phase; một phase core đang chạy chưa có
callback hủy nội bộ. Progress callback, policy/fallback và việc backend tiêu thụ metrics thuộc Lô G2/H. Khử hạt core
vẫn chưa triển khai và đã được mang ra warning có cấu trúc. Dừng trước **Lô G2 — backend dùng structured result**.

## Lô G2 — Backend dùng structured result

Ngày triển khai: **2026-08-11**. Trạng thái: **hoàn tất ở Mức bằng chứng 2 (tự động), release vẫn HOLD**.

### Phạm vi code

1. `backend/app/workers/logo_rebuild.py`
   - Backend mặc định gọi `logo_vectorize_structured_rgba`; VTracer là nhánh được chọn tường minh, không phải fallback
     khi core lỗi.
   - Parse schema native fail-closed: version/hệ tọa độ, SVG/hash/byte length, pixel/mm, provenance/profile, preprocess
     hash, metrics hữu hạn và warning đều phải đúng hợp đồng trước khi đi vào response.
   - Giữ artifact core nguyên byte; không chạy cleanup hoặc mask Python làm sai hash/metrics. Validator Python vẫn đọc
     lại chuỗi cuối và đối chiếu SHA-256 độc lập.
   - Background màu được truyền thành `background_label`; silhouette trắng/đen được chuyển thành alpha mask đen/trong
     suốt trước core, tránh nền opaque thành outer phủ toàn canvas.
   - Đồng bộ tolerance tỷ lệ mm với writer Rust ở 0,01%, chặn input lệch tại backend thay vì để thành lỗi ABI 500.
   - Request khử hạt lớn hơn 0 vẫn được gửi để giữ provenance nhưng kết quả bị đưa về `review`, vì core chưa thực thi
     tùy chọn này.
2. `backend/app/workers/logo_svg_cleanup.py`
   - Đổi vai trò thành cleanup riêng cho legacy và validator độc lập cho mọi engine.
   - Thêm đối chiếu hash artifact cuối; hash lệch là `rejected`, không chỉ warning.
3. `backend/app/schemas/logo_rebuild.py`
   - Thêm lựa chọn engine với mặc định `prynx_core`.
   - Mở rộng capabilities/preview bằng structured schema version, artifact/preprocess hash và native metrics có ràng
     buộc kiểu/range.
4. `backend/app/api/routes/logo_rebuild.py`
   - VTracer chỉ được chọn khi dev thông dịch và bật tường minh `PRYNX_LOGO_LEGACY_VTRACER_ENABLED=true`; bản compiled
     không mở nhánh này.
   - Response chuyển đầy đủ structured metadata/metrics; runtime release flag chính vẫn giữ nguyên.
5. `backend/tests/test_logo_rebuild.py`
   - Nâng fake native sang schema structured, giữ một ca legacy riêng và thêm regression cho capabilities, dev gate,
     hash/no-fallback, background label/không cleanup, response metrics và tolerance mm.

Không thêm dependency, hard-cap chất lượng, worker pool hoặc release profile. RAM gate hiện có vẫn giữ quy tắc máy
dưới 16 GB mới giảm; máy mạnh giữ nguyên kích thước hoặc báo thiếu RAM nếu bộ nhớ thực tế không đủ.

### Bằng chứng kiểm chứng

- Baseline đầu Lô G2: **49/49** backend Logo tests đạt.
- Sau sửa: **54/54** backend Logo + feature-gate tests đạt, 2 warning dependency đã có.
- Core contract sai hash bị từ chối và hàm VTracer fake không được gọi, chứng minh không fallback im lặng.
- Background core truyền palette `[logo, background]` cùng `background_label=1`; artifact giữ hash, không chạy cleanup
  hoặc sinh mask legacy. Ca VTracer tường minh vẫn giữ cleanup/mask counter cũ.
- Silhouette backend giữ mực `(0,0,0,255)` và nền `(0,0,0,0)` qua cả ca nền sáng lẫn nền tối.
- Cặp mm thiếu/sai tỷ lệ bị chặn; artifact hash drift bị validator Python đánh `rejected`.
- Smoke backend → PyO3 extension thật trên logo 32×16 đạt: engine `prynx-logo-core`, schema `1`, status `ready`,
  `outer=1`, **IoU 1,0**, **MAE 0,0**, cặp 40×20 mm đúng.
- Capabilities đọc từ extension thật trả core `0.1.0-dev.1`, schema `1`, cancel bật và metadata legacy VTracer
  `1.0.0-alpha.2`.
- `py_compile` cho bốn module backend và file test: đạt.

### Giới hạn runtime

Backend dev đã chạy core thật nhưng chưa có nghiệm thu Tauri và frontend chưa hiển thị progress/native metrics, nên
vẫn chốt ở **Mức 2**. Release route tiếp tục HOLD theo `PRYNX_LOGO_REBUILD_ENABLED`; bật release không mở VTracer
legacy. Khử hạt core chưa triển khai nên mặc định hiện trả `review`; cancel chỉ được quan sát tại checkpoint giữa các
phase. Dừng trước **Lô H — progress và frontend contract**.

## Lô H — Frontend contract và QC có cấu trúc

Ngày triển khai: **2026-08-11**. Trạng thái: **hoàn tất ở Mức bằng chứng 2 (tự động), chưa nghiệm thu runtime Tauri**.

### Phạm vi code

1. `desktop/src/lib/logoRebuildApi.ts`
   - Đồng bộ contract TypeScript với backend G2: lựa chọn engine, capabilities structured/legacy, schema version,
     artifact/preprocess hash và toàn bộ native metrics.
2. `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx`
   - UI thường luôn gửi `engine="prynx_core"`; không mở lựa chọn VTracer legacy cho người dùng.
   - Header hiển thị core/version/schema thật từ capabilities, không còn fallback nhãn VTracer.
   - Kết quả hiển thị IoU/MAE, layer/component, outer/hole, node nguồn/đầu ra, sai số lớn nhất, raster scale và hash
     rút gọn có full hash trong tooltip.
   - Trạng thái chạy chỉ mô tả request hiện tại và nói rõ backend chưa phát progress theo phase; không dựng phần trăm
     hoặc progress bar giả.
   - Khi `despeckle_size_px > 0`, cảnh báo trước request rằng core chưa áp dụng và kết quả sẽ cần kiểm tra.
3. `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.test.tsx`
   - Chuyển fixture mặc định sang structured core; khóa engine gửi đi, schema/QC/topology/hash, cảnh báo despeckle,
     trạng thái không có progress giả và giữ nguyên regression review/export/cancel/stale response/dirty session.
4. `desktop/src/i18n/locales/vi.json` và `desktop/src/i18n/locales/en.json`
   - Bổ sung đầy đủ text trạng thái, giới hạn despeckle và nhãn QC cho tiếng Việt/Anh.

Không thêm dependency, progress giả, lựa chọn VTracer production, cap chất lượng hoặc thay đổi release profile.

### Bằng chứng kiểm chứng

- `npm.cmd run typecheck`: đạt.
- `npx.cmd vitest run src/components/preprocess-tools/LogoRebuildWorkspace.test.tsx`: **29/29 passed**.
- `npx.cmd vitest run src/i18n/i18nCatalog.test.ts`: **5/5 passed**.
- ESLint riêng ba file TypeScript của Lô H: đạt, không có finding.
- `git diff --check` cho năm file code/i18n của lô: đạt.
- Lint toàn desktop chưa xanh do backlog ngoài phạm vi: **1.464 errors, 103 warnings**; `lint:budget` chỉ ra
  `react-refresh/only-export-components` đang **49 > budget 32**. Lô H không phát sinh finding trong các file đã sửa.

### Giới hạn runtime

Backend chưa có event/callback phát tiến độ theo phase nên frontend chỉ hiển thị trạng thái định tính của request.
Cancel vẫn dừng tại checkpoint giữa phase, không ngắt tức thời bên trong phase. Khử hạt core chưa triển khai nên mặc
định `4 px` vẫn dẫn tới `review` theo policy G2. Chưa chạy ứng dụng Tauri hoặc corpus logo khách trong lô này; release
tiếp tục HOLD theo feature gate hiện có. Dừng sau Lô H để chốt lô trước khi sang Centerline/Pixel-art/release.

## Hotfix H1 — Preview chạy mãi trong QC raster

Ngày triển khai: **2026-08-11**. Trạng thái: **đã kiểm chứng backend runtime với extension release mới**.

### Nguyên nhân gốc

`native/src/logo_engine/qc.rs` rasterize artifact scale 4× bằng cách thử winding của **mọi pixel với mọi cạnh SVG**.
Độ phức tạp gần `số pixel × số cạnh`; ảnh nhỏ còn được nâng cạnh ngắn lên 1.200 px nên logo nhiều chi tiết có thể
đẩy phase QC lên hàng tỷ phép thử. Ca runtime user báo đã giữ một lõi Python gần 100% hơn **10,5 phút** trong khi
`/health` vẫn trả 200, chứng minh UI/backend không chết nhưng native QC chưa hoàn tất. Cancel cũ chỉ được kiểm trước
và sau toàn phase nên nút hủy cũng phải chờ.

### Bản sửa

1. `native/src/logo_engine/qc.rs`
   - Thay fill rasterizer `pixel × cạnh` bằng active-edge scanline giữ nguyên `fill-rule="nonzero"`, raster scale và
     phép blend; không hạ độ phân giải hoặc hard-cap máy mạnh.
   - Bucket cạnh theo hàng hoạt động, gom event cùng cột và blend span nằm trong winding khác 0.
   - Kiểm cancel tại từng hàng raster fill/stroke và từng hàng so sánh IoU/MAE.
2. `native/src/logo_engine/result.rs`
   - Truyền callback cancel hiện có vào QC artifact thay vì chỉ kiểm ở ranh giới phase.
3. `native/src/logo_engine/artifact_tests.rs`
   - Thêm regression 128 dải/512 cạnh kiểm IoU 1,0, MAE 0,0 và topology.
   - Thêm ca chứng minh cancel được quan sát bên trong scanline phase.

### Bằng chứng kiểm chứng

- Rust Logo: **67/67 passed**; riêng 11 artifact tests hoàn tất trong **0,03 giây**.
- `cargo check --release --locked --offline`: đạt.
- `maturin develop --release --offline`: build và cài extension thành công sau khi dừng backend giữ DLL cũ; 16 thư
  mục leftover do các lần pip không ghi đè được DLL đã được kiểm path và dọn.
- Backend Logo + feature gate: **54/54 passed**, 2 warning dependency đã có.
- Smoke backend thật với ảnh 128×64 gồm 64 dải, được planner nâng lên **2.400×1.200 px**: HTTP 200 trong
  **1,795 giây**, status `ready`, core/schema 1, outer 64, IoU 1,0, MAE 0,0.
- Smoke hủy backend thật với ảnh 256×64: DELETE trả `cancelled=true`; request preview trả HTTP 409
  `Đã hủy preview logo.` sau **0,61 giây**.

Backend dev đã được khởi động lại và đang nghe `127.0.0.1:8321` bằng extension mới. Chưa có lại chính file logo
nguồn của user nên mức runtime trên là ca stress tương đương về đặc tính, không được coi là nghiệm thu chính file đó.
