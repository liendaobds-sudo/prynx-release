# PPE knockout và Viewer: bằng chứng, phạm vi đã duyệt, lộ trình

## Phê duyệt và giới hạn

Người dùng đã duyệt “làm đi” sau đề xuất sửa cả mô hình knockout PPE và
phân biệt xem tương thích với duyệt màu. Đây là bản ghi phạm vi/bằng chứng
trước triển khai, không phải tuyên bố đã hỗ trợ knockout.

Theo `prynx-audit-workflow`: mỗi lô tối đa5file ứng dụng/test, verify xong
mới chuyển tiếp; không sửa PDF nguồn, không tắt guard để cho ca qua. Không
commit/push hoặc build installer khi chưa có yêu cầu riêng. Build dev để
kiểm Rust thuộc bước triển khai đã duyệt; nghiệm thu bộ cài là chốt riêng.

## Baseline xác nhận

- HEAD bắt đầu: `bc3d6d5`, worktree sạch.
- PDF ATB người dùng,45trang,92.260.509byte; SHA256
  `a9f7d569521ef01955e87b72251c1c12164513640e4265cad65a977c83263565`.
- Trang1 gọi group `/K=true`, object3557/0, qua `/Fm97/ /Fm0`; group có
  202lệnh `Do`. PPE thật trả `unsupported_transparency=true`,
  `Group /K true (knockout):1`; không thiếu font/object. Poppler dựng được
  trang. Các trang6,21,22,35 cũng có group knockout trong đồ thị `Do`.
- Code CPU ghi cảnh báo từ26/07; classifier native có từ11/08. Commit
  `3fd0e587` ngày27/09 xóa hai nhánh fallback từng có trong bản25/09.
- Bằng chứng đọc PDF ở `tmp/pdfs/knockout-20260928/structure.json`,
  `ppe-page1.json`, cùng script read-only. Hash PDF nguồn không đổi.

## Phát hiện

| Mã | Mức | Bằng chứng | Hậu quả |
|---|---|---|---|
| KNOCK.01 | P1/L | `print_engine/src/ink.rs`: chỉ có alpha; `content/interp.rs`: `/AIS` chỉ ở retained, mọi `/K=true` bị đánh unsupported | PPE CPU chưa đủ mô hình shape/opacity để chứng nhận nhóm knockout |
| KNOCK.02 | P1/M | `useTileRenderer.ts`: unsupported luôn throw; `ThumbSidebar.tsx` vẫn lùi display | Trang chính không xem được trong khi thumbnail có ảnh |
| KNOCK.03 | P1/M | Metadata `TilePixelProof` đã có, nhưng nhánh accurate gán proof theo producer đã chọn; compatibility cần yêu cầu display riêng | Không được khôi phục việc trả byte PDFium dưới yêu cầu/nhãn accurate |

KNOCK.01 là thiếu tính năng render, không kết luận mọi group knockout đều
tạo pixel khác nhau. Không whitelist chỉ theo `/I=false`, alpha1 hoặc nhìn
gần giống. GPU có mô hình ink/alpha/shape/group-alpha để tham khảo, nhưng
không là oracle và không được bật production thay cho việc nghiệm thu CPU.

## Hợp đồng đích

1. Viewer thông thường có thể chuyển **cả trang** sang display khi gặp một
   capability unsupported có cấu trúc; phải có cảnh báo rõ không phải proof.
2. Output Preview, bật CMYK bằng tay và `ppe-only` không nhận ảnh display làm
   kết quả màu. Lỗi hủy, I/O, OOM không được ghi nhớ thành thiếu capability.
3. Không trả fallback bên trong handler accurate. Hủy/thay generation để
   yêu cầu display mới, tách cache/metadata theo engine thực, revision/page
   và thiết lập proof; không ghép tile PDFium vào nền PPE.
4. PPE thực hiện đúng shape/opacity, initial backdrop, K/I/AIS, group lồng,
   soft mask và không gian mực trước ICC; trường hợp chưa kiểm vẫn giữ guard.
5. Không đổi PDF gốc, không flatten âm thầm, không coi preview tương thích
   là đủ cho đo mực/tách kẽm/raster production.

## Các lô dự kiến và chốt

- **V1 — trạng thái tương thích theo trang:** nối trạng thái unsupported của
  hook vào Viewer, yêu cầu pipeline display riêng và cảnh báo; kiểm strict
  proof, profile/revision, tab/trang, late response và retry. Tối đa5file.
- **C1 — nền compositing CPU:** shape/opacity + backdrop và test số độc lập.
  Giữ guard, chưa tuyên bố hỗ trợ toàn bộ kiểu transparency. Tối đa5file/lô.
- **C2 — nối primitive/group và nghiệm thu knockout:** path/text/image/shading,
  clip/AA/SMask, nesting/spot/overprint; bật capability chỉ đúng phạm vi đã kiểm.
- **Q1 — corpus/runtime:** toàn45trang ATB và fixture tổng hợp; tham chiếu
  Ghent PDF Output Suite, Acrobat/RIP cùng profile khi có artifact tham chiếu.
  Không coi test tự so engine với chính nó là bằng chứng đúng chuẩn.

Nguồn chuẩn: PDF32000-1:2008 §11.4.6 và §11.6.4, Adobe:
https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf
Corpus độc lập: https://gwg.org/gos5/

## Trạng thái

### V1 — đã triển khai, người dùng đã thấy cảnh báo

Người dùng xác nhận “đã có cảnh báo”, đủ để tiếp tục lô nền CPU đã duyệt.
Không suy rộng câu này thành nghiệm thu riêng zoom/pan, mọi trang hoặc
Output Preview; những nhánh đó mới có bằng chứng test tự động.

Đúng5file của lô: báo cáo này; `desktop/src/hooks/viewer/useTileRenderer.ts`
và test của nó; `desktop/src/components/AcrobatViewer.tsx` và test mới
`AcrobatViewer.compatibility.test.ts`.

- Hook ghi nhớ **capability theo từng trang**, token nội dung, pipeline và
  profile/thiết lập proof. Tile-refined không làm mất quyết định; đổi
  revision/proof tạo epoch mới, kể cả A→B→A. Không chia state sang tab khác.
- Chỉ7mã unsupported có cấu trúc được ghi nhớ; không đổi hủy/I/O/OOM/lỗi
  worker khác thành compatibility. Lần đầu vẫn ghi cảnh báo PPE; các lần
  accurate sau từ chối ngay, không tạo chuỗi thử lại khi zoom.
- Handler accurate vẫn throw. Viewer thông thường nhận thông tin rồi đổi
  **cả LivePageFrame** sang yêu cầu display mới; byte/cache/proof PDFium vẫn
  là `display-preview`. Hủy các request PPE khác cùng trang, bỏ response
  muộn; regression riêng ngăn hủy ngược chính group đang báo unsupported.
- Cảnh báo hiện theo trang: “Xem tương thích — chưa xác nhận đúng màu.
  Không dùng để duyệt màu in.” Cảnh báo nằm ngoài vùng tọa độ PDF, không
  chèn một dải làm lệch gốc đo/crop. CMYK không hiện dấu✓ cho trang đã biết
  unsupported. Row ảo hóa cập nhật ngay khi capability đổi, không chờ zoom.
- Output Preview, CMYK chủ động và `ppe-only` giữ strict. Khi đang yêu cầu
  proof, trang có thể tiếp tục báo không dựng được; V1 không chữa knockout
  trong engine và không cho compatibility đi vào kết quả proof.
- Giữ hai đường native/display tách biệt; không thay renderer GPU hay các
  API xuất/tách kẽm. Thumbnail vẫn dùng đường cũ; hợp nhất toàn bộ producer
  và metadata native/HTTP thuộc các lô sau, chưa được gọi là đã hoàn tất.

#### Verify

- Baseline hook39test đạt; test mới đỏ trước khi sửa do chưa có metadata
  capability. Ba ca wiring Viewer cũng đỏ: thiếu policy/trạng thái/frame-key.
- Sau sửa:14file/296test frontend đạt, gồm renderer, coordinator, scheduler,
  cache, LivePageFrame, thumbnail lifecycle và Viewer. Sau cleanup lint chạy
  lại78test nhạy nhất đạt; không cộng trùng thành374test.
- Typecheck đạt. ESLint phạm vi4file code/test:0error,3warning có sẵn đã
  đối chứng với HEAD (dependency hook). Đã sửa cách gọi hook setting GPU
  vô điều kiện trong component được chạm, không đổi giá trị gate; bỏ hai
  biến giả unused của test. Không tắt lint rule.
- Cảnh báo jsdom Canvas.getContext có cả ở baseline; test fallback canvas
  vẫn đạt. Test mock IPC/AST không thay cho nghiệm thu ứng dụng thật.
- PDF ATB nguồn giữ SHA256 như baseline. Không build installer, không
  rebuild native vì chưa sửa Rust, không commit/push.

Theo chốt `prynx-audit-workflow`, cần xác nhận trên Viewer dev trước khi
sang lô lõi: mở lại ATB ở xem thường, xem trang1/cảnh báo, zoom/đổi trang,
sau đó kiểm Output Preview vẫn không chứng nhận màu khi chưa hỗ trợ.

### C1 — nền số học CPU đã triển khai, chưa mở capability

Đúng5file của lô C1: `print_engine/src/ink.rs`,
`print_engine/src/content/interp.rs`, `print_engine/src/content/gstate.rs`,
`print_engine/tests/render_knockout_cpu.rs` và báo cáo này. Giữ nguyên lô V1.

- Thêm context tùy chọn lưu **shape, alpha riêng group và backdrop ban đầu**.
  Không đổi `InkPaint` đang dùng chung/serialize cho GPU. Không cấp thêm
  plane ở đường không thuộc context knockout.
- API composite/merge mới chỉ nhận bốn kênh CMYK, Normal, không overprint,
  RGB sidecar hoặc SMask. Tách AIS=true/false; ca=0 vẫn giữ shape khi AIS=false.
- Child non-isolated trong K-parent lấy backdrop **ban đầu** của cha; child
  K=false vẫn phải giữ shape và là một object khi merge. Form thường không
  có `/Group` vẫn trải các primitive như trước, không tự biến thành group.
- CPU đọc AIS vào graphics state, q/Q lưu-phục hồi; ca/CA/BM/SMask reset
  trong group, AIS giữ kế thừa. Vùng đã vẽ trong context theo shape, không
  loại nhầm thao tác knockout chỉ vì alpha bằng0.
- `B/B*/b/b*`, image, text/TK, shading/mesh/pattern, RGB/spot/overprint và
  SMask chưa chuyển đủ được hạ completeness **trước** các early-return.
  Không merge shape mới từ group đã có thao tác legacy không theo hợp đồng.
- Plane/snapshot đi qua MemoryBudget và được trả khi lỗi/drop; crop giữ
  đúng shape/backdrop. Nếu không đủ buffer C1 trước khi vẽ, quay về đường
  legacy vốn đã có warning K, không biến trường hợp unsupported cũ thành
  lỗi cứng mới. Không thêm cap worker, DPI hay chất lượng.
- **Giữ nguyên guard mọi `/K=true` và capability=false.** C1 chưa đủ
  image/SMask/shading/text/spot để chứng nhận file ATB đúng màu.

#### Bằng chứng C1

- Baseline49test transparency cũ đạt. Sáu ca mới đỏ đúng sai số số học trước
  wiring (ví dụ opacity0 phải trả về backdrop C=1 nhưng code cũ cho C=0).
- 18test mới đạt: K/I/AIS, alpha0/0,5/1, fill/stroke, q/Q, ca reset/AIS
  kế thừa, group lồng, Form thường, fractional shape, viewport và budget.
  Oracle là phương trình ISO, không lấy chính output PPE cũ làm chuẩn.
- `cargo test --offline --tests -q`: **813đạt,8ignored**;8ca bỏ qua là các
  benchmark/probe thủ công có sẵn. `cargo check --offline --all-targets -q`
  đạt. Không cập nhật golden, không sửa Cargo profile/dependency.
- Đã build extension release-dev riêng và kiểm7trang ATB ở36DPI bằng bản
  installed baseline và staged mới:1,2,3,6,21,22,35. Không có lỗi mới hoặc
  object bị bỏ thêm;2/3 không knockout giữ byte kẽm giống hệt. Năm trang
  knockout vẫn unsupported/ink_unsound như yêu cầu C1, không bị gắn proof.
  Timer này chỉ là diagnostic, không phải benchmark hiệu năng hay chứng
  nhận màu đầy đủ của tài liệu.
- Script/JSON ở `.tmp/knockout-c1-20260928/`; binary staged SHA256
  `eeb3f7a1e8b9ac0beea4c5288d682afccbfbe9f2c9ebe063e826e6c45c17909f`.
  Chưa chép đè extension đang dùng, chưa build bộ cài/Tauri mới. PDF nguồn
  giữ SHA256 ban đầu.

Phát hiện thêm từ đối chứng baseline: trang21 còn có shading mesh vượt
ngưỡng400.000tam giác và bỏ1object ở **cả trước lẫn sau C1**. Đây là chốt
khác cần xử lý/đánh giá trước nghiệm thu toàn45trang, không phải hồi quy C1.

### C2/Q1 — còn lại, chưa hoàn tất sửa tận gốc

Các miền còn thiếu gồm fill+stroke kết hợp, glyph/text, image alpha,
shading/mesh/pattern, SMask, RGB/spot/overprint và blend khác Normal. Chúng
cần giữ provenance shape/opacity trước composite và đi qua đúng ranh giới
object/group. Image `/Mask` so với `/SMask`, text `/TK`, RGB sidecar và fast
replay cần chốt riêng.

Review độc lập sau code không thấy blocker cho **C1 còn guard**. Tuy nhiên,
group trộn primitive C1 với legacy có thể dùng lại legacy merge trên buffer
đã có backdrop C1: không được hứa pixel giống baseline hoặc đúng toàn bộ
knockout. C2 phải xử lý đầy đủ/replay có kiểm soát trước khi chứng nhận các
tổ hợp đó; guard hiện tại chính là ranh giới bảo vệ bắt buộc.

Phần C1 chỉ mở nền số học trong miền đã kiểm; nhánh chưa chuyển đổi tiếp tục
unsupported. Chưa mở capability
`transparency_knockout_groups`, chưa tuyên bố ATB được PPE dựng đúng màu,
chưa nghiệm thu45trang hay bộ cài. Đây vẫn là phần bắt buộc để hoàn thành
toàn bộ yêu cầu sửa tận gốc.

### Phê duyệt tiếp tục C2/Q1

Người dùng yêu cầu “làm hết đi”: tiếp tục tất cả hạng mục còn lại theo các
lô kiểm chứng, không dừng sau mỗi lô để xin lại cùng phạm vi. Giữ chốt chất
lượng, không bỏ guard cho miền chưa có bằng chứng và không tự phát hành.

#### C2a — đã verify lõi, vẫn giữ guard

- Đã đọc đồ thị gọi thật: K ở trang1/6 chỉ gồm các Form nét CMYK Normal;
  trang22 gồm path; trang35 thêm shading; trang21 thêm ảnh Indexed CMYK,
  SMask, AIS và Multiply/Screen. Trang1 có202Form con; không cần dựa vào
  giả định toàn bộ khả năng text/image đã hoàn chỉnh để kiểm miền path.
- Mở nền Normal sang số kênh mực thực của trang (ATB có cả spot), giữ
  shape/opacity của soft mask và group, xử lý fill+stroke như implicit
  non-isolated knockout group theo ISO11.7.4.4. Blend tách kênh cần thêm
  alpha vật lý của backdrop, khác alpha riêng group.
- Group có thao tác chưa hỗ trợ phải bỏ surface thử nghiệm và phát lại từ
  backdrop sạch; không legacy-merge buffer đã pha một phần theo C1.
- Chưa mở capability hoặc tuyên bố pixel ATB đúng màu ở thời điểm ghi này.
- Verify: toàn bộ `cargo test --offline --tests -q` đạt827test,8ignored;
  thêm ca thu outline sau review đạt riêng, file knockout tổng27/27đạt.
  `cargo check --offline --all-targets -q` đạt sau thay đổi cuối.
  Có6test số học mới ở ink và9test tích hợp mới, không cập nhật golden.
- Review bắt và đã sửa ba rủi ro: thiếu RAM khi cấp implicit group, mất
  warning giải mã do cache còn sống sau replay, nhân đôi glyph khi thu
  outline. Replay hợp warning bằng max/union, không cộng đôi hoặc xóa lỗi.
- Không có numeric RED cho9ca mới vì API và wiring được làm song song;
  oracle vẫn là công thức ISO, không dùng output PPE làm expected.

#### Mesh trang21 — bằng chứng bổ sung

Object34783/0 là tensor mesh vẽ dưới graphics-state soft mask (không nằm
trong stream `/G` của mask), stream387.295byte gồm2.671
patch hợp lệ. Bộ đọc hiện bung mỗi patch thành200tam giác trước viewport:
534.200tam giác vượt guard400.000, bỏ cả shading. Đây là lỗi triển khai
cấp phát/bung dữ liệu, không phải tài liệu hỏng hoặc subdivision đệ quy.
Hướng đã duyệt: lưu patch gọn, dựng từng patch với nguyên lưới/công thức,
không giảm chất lượng hoặc đơn thuần nâng hard cap.

Baseline mới toàn45trang ở36DPI đã xong: không exception, K unsupported ở
1/6/21/22/35; trang40 còn bỏ14shading vì cùng guard mesh. Trang40 gồm7mesh
×4.095patch và7mesh×3.390patch. Các trang còn lại sạch diagnostic; hash
nguồn và7trang plate baseline đã đo trước giữ nguyên. JSON/script ở
`.tmp/knockout-c2-20260928/`. Đây là baseline độ phủ, không phải nghiệm thu
màu hoặc benchmark tốc độ.

#### C2b — ảnh/mask và blend nhiều kênh

- Giữ nguồn alpha trong metadata ảnh: `/Mask` và stencil là shape,
  `/SMask` là soft alpha chịu AIS. Mask của image thay mask graphics state;
  `/SMask` ưu tiên `/Mask`, `/SMask /None` không tạo override giả.
- Đường ảnh tracked hỗ trợ CMYK/Gray/Indexed của hai miền đó, opacity0,
  clip, footprint premultiplied giữ shape riêng; miền RGB/OP/pattern còn
  guard. Sửa LUT Gray có Matte không được bỏ bước khử preblend.
- Blend separable dùng N kênh; riêng Difference/Exclusion đổi về Normal
  trên spot theo ISO11.7.4.2. Có3test mới,2ca đã đỏ trước bản sửa.
- Verify toàn bộ841test Rust đạt,8ignored;32test knockout tích hợp đạt;
  check all-targets đạt. Có5test sampler mới và5test ảnh tích hợp mới.
- Chưa coi heuristic lấy mẫu bảo thủ đo TAC là oracle RIP. Guard K vẫn
  giữ; chưa chạy native mới hoặc nghiệm thu Viewer của C2.
- Ca thứ6cho footprint ảnh thu nhỏ đạt sau full suite; toàn file knockout
  hiện33ca. Tách shape trung bình khỏi soft alpha đã có oracle độc lập.

Mini-lô kiểm chéo C2b (ink/interp/test, không đổi sampler): đã tái hiện RED
thật khi chọn TAC nguồn khiến lỗ explicit Mask giữ400% bị thay bởi K100%.
Đổi sang dự phóng bằng **cùng phép composite** trên surface hiện hành, so
cả soft-mask tâm và peak; không mặc định mask lớn hơn là bảo thủ hơn.
51test ink đạt (thêm3ca, có2.304tổ hợp so bit-exact/no mutation),35test
knockout đạt, check all-targets đạt. Ca SMask có probe riêng xác nhận mask
tâm0/lân cận1; fixture1px ban đầu bị đường nới vector legacy làm mask tâm1,
đã đổi hình học fixture rộng và giữ expected400%, không hạ assertion.
Giới hạn: dự phóng chỉ đúng trên surface hiện hành, không dự đoán mọi
blend/SMask khi merge lên các group cha sau đó; chưa chứng nhận rộng nhánh
lấy mẫu bảo thủ của group cô lập. Guard K vẫn giữ.

#### C2c — mesh/shading đã verify,5file ứng dụng/test

Ngoài cấp phát mesh, review chéo theo Table86 phát hiện thứ tự hai control
point trong tensor bị đảo: row-major cần `[5,6,10,9]`, code cũ
`[5,9,10,6]`. Test độc lập trên lưới đều tại(.75,.25) bắt lỗi mà điểm giữa
không bắt được. Khi chuyển representation phải giữ tham số màu để áp
`/Function` sau nội suy, và composite toàn shading như một object, không
nhân alpha ở cạnh chung của hai triangle. Patch tự gập ưu tiên v chuẩn PDF
rồi u; trục nội bộ của code cũ đang đảo so với ký hiệu chuẩn.

- Giữ patch gọn và bung từng lưới10×10 khi vẽ; bỏ trần tam giác bung sẵn
  cho type6/7, không giảm DPI hoặc chia lưới. Type4/5 giữ guard cũ.
- Nội suy raw rồi mới áp Function; giữ UV song tuyến cho patch. Một shading
  resolve ownership trước rồi composite mỗi pixel một lần. RED thực tế ở
  cạnh chung ca=.5 trước sửa cho K=.75, sau sửa đúng K=.5.
- RED thật của patch gập `x=40u,y=120v(1-v)` ở pixel(5,15): K=.71167 thay
  vì khoảng.28591. Barycentric f64 và tie số học8ulp f32 trên UV[0,1] sửa
  ca này; sweep1.000pixel và ca ưu tiên hai trục đạt. Đây vẫn là lưới xấp
  xỉ, chưa chứng nhận nghiệm Bézier liên tục hoặc mọi RIP.
- Parser nhận ngân sách còn lại/token hủy, kiểm trước tăng Vec và mỗi
  record/row/triangle. Tính capacity thật của stream, outerVec, màu và
  phần tạm; painter giữ lease cho resource+scratch viewport rồi trả lại.
  Hủy/thiếu RAM được truyền ra, không đổi thành shading bị bỏ.
- Verify cuối C2c: `cargo test --offline --tests -q` đạt **874test,8ignored**;
  `cargo check --offline --all-targets -q` đạt. Mesh integration27/27, gồm
  72tổ hợp knockout/SMask/AIS/alpha, viewport có gốc khác0, budget và
  giải phóng scratch. Không cập nhật golden.
- Giới hạn còn lại: decoder chung vẫn cấp buffer giải nén trước chốt mới;
  retained-pattern còn wrapper mặc định, sẽ nối ngân sách trong lô sau.
  Chưa mở guard K/capability; chưa nghiệm thu native mới hoặc ứng dụng thật.

#### R1 — phiên bản dữ liệu và nhánh retained

- Session lên`/session-2`, wire lên`PPEIR004`: dữ liệu mesh raw và nguồn alpha
  của image khác hợp đồng cũ. Từ chối003 trước decode, không đoán schema cũ.
- Retained pattern nhận budget request/token hủy. Direct sh cũng lấy min
  giữa ngân sách request và buffer (recorder1×1 trước đó dùng budget mặc định).
- Có RED cho wire003 được nhận, version cũ và retained bỏ qua budget1KiB.
  Sau sửa wire4/4, prepared-session2/2, retained13đạt/1ignored, check mọi
  target đạt. Chưa bao gồm cộng dồn toàn resource của retained recorder.

#### Prerequisite AA/BBox trước nghiệm thu vector knockout

Review cây trang1 cho thấy Form ngoài và Kgroup cùngBBox phân số.
`tiny-skia::Mask::intersect_path` nhân coverage; lặp cùng clip có thể thành
c² thay vì c. Lô kế giữ provenance BBox chính xác theo đường đã biến đổi,
extent và AA, chỉ tái dùng clip khi chính hình đó đã được áp; không đổi phép
giao clip bất kỳ thành min và không nới dung sai hình học.

- Đã tái hiện5/8ca RED: một pixel K=.5647059 bị thành.31764707 khi lặpBBox;
  group opacity.5 cũng bị nhạt thêm. Sửa lịch sử BBox bất biến trong graphics
  state, khóa bằng4đỉnh sauCTM+extent+AA. q/Q giữ đúng scope, A→B→A không
  bỏ B; clip khác/AABB bằng nhau/CTM đổi không bị gộp. Khi thay mask của
  stencil/tiling thì xóa chứng cứ cũ. Sau sửa10regression+1unitkey đạt.
- Rà consumer phát hiện GPU resource replay dùng budget chỉ tính raster,
  không đủ scratch mesh mới (RED2×2 `MemoryBudgetExceeded`). Đã cộng nhu cầu
  owner/UV+grid+capacity nguồn, không hạ DPI hoặc thêm cap. Regression GPU
  thực đạt, gồm patch raw+Function phi tuyến; CPU kiểm capacity/overflow đạt.
- Toàn Rust sau hai prerequisite: **893test đạt,8ignored**, check mọi
  target `print_engine` và `viewer_gpu` đạt. Mọi guard K vẫn giữ trước bước
  đối chứng native. Không nâng snapshot hoặc gọi đây là nghiệm thu app.

#### Q1 — đối chứng native và chốt màu Pantone bổ sung

- Bản staged R2 dựng45/45trang @36DPI, không exception, không còn dropped
  mesh ở21/40. Năm trang K vẫn guarded. Hash PDF nguồn không đổi.
- Đã xem ảnh PPE/GS trang1 @144DPI cùng profile: logo ATB và ILT của PPE
  trắng, GS cam/đỏ. Ảnh installed baseline cũng sai như vậy, không phải hồi
  quy mới. Không được mở chứng nhận trang1 trước khi giải quyết chốt này.
- **KNOCK.04 P1**: `color/space.rs` ép mọi ICC `/N=3` thành DeviceRGB, bỏ
  Alternate Lab; `color/icc.rs` cố dựng mọi profile3kênh với RGB_FLT. File
  ATB có Pantone185/1955/165 dùng ICC Lab. Probe LUT thật cho ba màu cùng
  giá trị cuối gần trắng `[0,.001236,0,0]`, dù lượng phủ plate spot vẫn255.
  Warning nháp khi tạo alternate bị bỏ nên chốt proof không biết sai màu.
- Lô sửa tối đa4file: bộ đổi ICC, phân giải colorspace, sampler ảnh và test
  ICC tích hợp; giữ nguyên giá trị kẽm spot và process CMYK. Chuẩn đối chứng:
  Adobe PDF32000-1 §8.6.5.5 và LCMS format Lab_FLT. Phải test Lab path,
  spot alternate, Indexed/ảnh và profile hỏng; không chỉ test logo cụ thể.
- Script/ảnh/binary ở `.tmp/knockout-c2-20260928/`. Thời gian render được
  đo trong lúc có tác vụ đồng thời; không dùng làm benchmark tốc độ.

### V2 — thumbnail và nguồn gốc pixel đã tách đúng hợp đồng

- Thumbnail không còn trả byte display trong chính yêu cầu accurate. Yêu
  cầu accurate phải lỗi trước; chỉ mã unsupported có cấu trúc mới tạo một
  yêu cầu display khác, với ID/generation/pipeline/soundness riêng.
- Lỗi hủy, OOM, I/O và lỗi không xác định không được biến thành thiếu
  capability. Strict proof không nhận fallback; khi đổi strict/proof/page
  thì bỏ URL cũ và từ chối kết quả muộn, kể cả đổi A→B→A.
- Native thumbnail hiện chỉ nhận FOGRA39/Relative đã chuẩn hóa. Cấu hình
  khác không được gắn nhãn profile/intent mà worker thực tế không dựng.
- First-frame chỉ tái dùng khi đầy đủ producer/proof/page/token/pipeline
  khớp nhau; không revoke URL mượn. Cache PDF.js không có provenance không
  được nhận làm native accurate.
- Regression đã RED khi display bytes lọt qua accurate coordinator.
  Chạy lại frontend cuối: **146 test/7 suite đạt**, typecheck đạt. Lint
  nhóm identity không lỗi/cảnh báo; nhóm thumbnail có 3 warning hook đã
  đối chứng tồn tại ở HEAD, không tắt quy tắc để cho xanh.

### R2 — vô hiệu hóa cache theo đúng ngữ nghĩa dựng ảnh mới

- Native identity: `ppe-fogra39-relative-view-knockout-png-v6-native-worker`.
  HTTP identity: `ppe-${profile}-${intent}-view-knockout-png-v6-backend`.
  Tile cache: `v11_view_semantics_knockout_shape_mesh_png`.
- Đồng bộ producer, coordinator, first-frame, Tauri worker và script đo.
  Worker từ chối v5 cũ; chuỗi v5 còn lại là ca kiểm âm có chủ đích.
- Classifier vẫn từ chối marker `Group /K true`, kể cả khi boolean cảnh
  báo bị sai; không gỡ chốt chung hoặc đổi số phiên bản ứng dụng.
- Wire `PPEIR004` và prepared session `/session-2` của R1 được giữ nguyên.

### KNOCK.04 — đã sửa ICC Lab của màu Pantone

- LUT LCMS dùng đúng họ profile RGB/Lab; Lab đầu vào vật lý được chuẩn hóa
  đúng khi tra LUT. `/N=3` không còn mặc định là RGB. Profile stream không
  nén cũng được đọc đúng.
- Phân giải profile hợp lệ trước Alternate: Alternate không dùng đến
  không được gây cảnh báo giả. Giữ nguyên hành vi `/N=1`, `/N=4` và các
  kẽm CMYK/spot; không biến process CMYK thành kẽm mới vì Alternate DeviceN.
- Chuyển cảnh báo của spot alternate vào preview, không làm sai diagnostic
  đo lượng mực spot. ATB và ILT đã có lại màu cam/đỏ trong ảnh PPE.
- Không tuyên bố hỗ trợ hết ICC Lab: Range tùy chỉnh, ảnh/Indexed Lab còn
  thiếu provenance Range trong IR nên giữ cảnh báo. Lab `/Matte` không
  được đi qua phép khử preblend vốn giả định miền 0..1.
- **22 test ICC đạt**, gồm 9 test mới; 3 test bắt được lỗi RED ban đầu.
  Review chéo cuối xác nhận bốn điểm N1/N4, Alternate, Range và Matte được
  xử lý. Rủi ro cache LUT `(ptr,len)` có trước nằm ngoài lô này.

### KNOCK.PREVIEW — mở có điều kiện, không mở capability tổng

- `RenderOptions::softproof()` và `viewer()` bật chứng nhận riêng cho
  **group không cách ly, DeviceCMYK, Normal, chỉ path màu đặc, không SMask,
  AIS hoặc overprint**, sau khi toàn subtree tracking và merge thành công.
- Counter không được hoàn tác bởi q/Q, group hoặc replay. Image, shading,
  text, pattern, nguồn spot/RGB, toán tử lạ, resource hỏng, giải mã phục hồi,
  vượt độ sâu/state hoặc fallback thiếu RAM đều giữ guard.
- `default()`, `ink_accurate()`, `cmyk_export()` và thu outline không mở
  chứng nhận này. `transparency_knockout_groups=false` vẫn nguyên; binding
  công bố thêm `transparency_knockout_vector_preview=true` với scope hẹp.
- `/SMask/G` khai K trực tiếp và luminosity G cách ly được đánh dấu rõ là
  chưa hỗ trợ. Không xóa warning có trước hoặc cộng đôi warning khi replay.
- Trước kiểm context sinh nội dung cuối: 15 test certificate đạt, tổng
  **917 test Rust đạt/8 ignored**, check all-targets đạt.
- Review cuối bắt thêm lỗ hổng certificate lồng trong producer: counter
  của SMask/pattern/Type3 tăng trước snapshot K con, nên riêng counter không
  đủ loại miền này. Năm fixture RED thật từng có warnings rỗng và
  `unsupported=false`. Thêm chốt `smask_depth`, `pattern_cell_depth` và
  `type3_depth` ngay boundary; không chỉ kiểm graphics state của K con.
- Context Type3 d0/d1 được khôi phục trước xử lý lỗi, kể cả thiếu RAM khi
  dựng group lồng. **21 test certificate + 147 integration liên quan đạt**;
  check all-targets đạt. Sáu test mới gồm 5 guard và 1 cleanup, không mở
  rộng toán SMask/pattern/Type3 hoặc scope capability.

### Q1 — bằng chứng trên tài liệu thật, chưa thay ứng dụng đang chạy

Native R4 staged, không ghi đè extension đã cài:
`.tmp/knockout-c2-20260928/after-r4/pdfcompare_native.pyd`, SHA256
`619d7cce8e940f37e1f2e21d2111cf3c25f0e85f4e239f4f63c7d53da7421bc8`.

- Preview toàn **45/45 trang @36DPI** không exception, không object bị bỏ.
  Trang 1/6/22 sạch diagnostic; trang 21/35 còn unsupported như giới hạn
  certificate. Trang 40 không còn bỏ 14 mesh như baseline.
- Lần đo mực riêng, truyền tường minh `ink_accurate=true`, trên
  1/6/21/22/35/40: cả 5 trang K vẫn guarded; trang 40 sạch, không bỏ object.
  Script baseline cũ dùng mặc định `ink_accurate=false`: không so plate hoặc
  tốc độ baseline đó với cấu hình đo mực mới như thể cùng một phép đo.
- Trang 1 ở **72/144/300DPI** dựng qua session với
  `degraded=false`, `ink_unsound=false`. Full-frame PNG R3/R4 có SHA giống
  nhau ở cả ba DPI: mở certificate không tự sửa pixel hay che lỗi màu.
- Đã xem ảnh PPE trang 1 @144DPI và vùng K @300DPI. Đối chứng Ghostscript
  cùng FOGRA39/sRGB, Relative, thiết lập overprint tương ứng; MAE vùng K
  lần lượt 2,156 / 1,975 / 1,584 mức 8-bit. Đây không phải so bit-exact,
  chứng nhận mọi RIP hoặc nghiệm thu màu in.
- Full-frame và viewport chứa đúng vùng K còn khác AA ít: max 12/11/12,
  42/72/348 pixel khác, MAE 0,001122/0,000604/0,001696. Không gọi crop parity
  là tuyệt đối. Các khác biệt lớn hơn ở crop giữa trang đã có ở baseline.
- Worker Tauri thật gọi `render_response`, phân loại và đọc lại PNG:
  trang 1 @36DPI `Ready`, identity v6, PNG 354×425 có 94.210 pixel không
  trắng và 672 pixel cam vùng logo; trang 21 `UnsupportedKnockoutTransparency`
  và không phát PNG. Test khóa SHA nguồn trước/sau, không dùng PDF khác để
  làm xanh. Đây là test worker trực tiếp, **không phải GUI/IPC end-to-end**.
- Backend staged: **123 test đạt**, 1 deprecation Pydantic đã có. Worker
  focused: **54 đạt/10 ignored**, test corpus mới trong số ignored đã chạy
  riêng và đạt. Check Tauri all-targets đạt với warning dead-code có trước.
  GPU retained-fallback regression thực đạt; script Python/Node kiểm cú
  pháp đạt. Không cập nhật golden.
- Mọi probe giữ nguyên SHA256 PDF nguồn
  `a9f7d569521ef01955e87b72251c1c12164513640e4265cad65a977c83263565`.
  Không giảm DPI mặc định/chất lượng, không thêm cap worker, không chỉnh
  Cargo LTO, không commit/push/build installer hoặc dừng app đang chạy.

### Chốt cuối R5 — sau bản vá context producer

- Native release-dev staged cuối:
  `.tmp/knockout-c2-20260928/after-r5/pdfcompare_native.pyd`, SHA256
  `369d4d0098e40373fa1e3d126a5b76a266ed6c44e970d1f836ed52bf23bc5e92`.
  Đây là bản thay R4 cho kiểm thử, không phải bản đã cài vào ứng dụng.
- Chạy lại toàn `print_engine`: **923 đạt, 8 ignored**. Backend import
  tường minh chính R5: **123 đạt**, không dùng nhầm extension trong venv.
  Frontend chạy lại **146 đạt/7 suite**, typecheck đạt.
- Worker build từ source cuối: **54 đạt/10 ignored**; corpus ATB chạy
  tường minh thêm **1 đạt**. PNG trang 1 không đổi SHA256
  `1c43b5afefa95064fdc23f1472ca06d829aa34b7d248a8f8dee37f65151258c7`.
  Test executable SHA256
  `0c7abe34feb1d22a3f362cf451ee21b82a21d1ac955162cae83d2710691c0e26`.
- R5 preview chạy lại **45/45 trang**, không lỗi/bỏ object; chỉ 21/35
  còn unsupported. R5 đo mực 6 trang cũng đạt đúng chốt như R4: cả 5 trang
  K vẫn không được chứng nhận. Mọi lượt giữ SHA nguồn như ban đầu.
- R5 trang 1 ở **72/144/300DPI** sạch diagnostic. Cả 6 PNG full/viewport
  có SHA giống hệt R4; số đo AA/đối chứng GS nêu trên không đổi. Đã xem lại
  ảnh full trang 1 @144DPI của chính R5, logo không còn bị trắng.
- `git diff --check` phạm vi thay đổi đạt; warning LF/CRLF của Git và
  Canvas.getContext của jsdom không được coi là lỗi mới. Không hoàn tác
  hoặc gom những thay đổi đồng thời ngoài chiến dịch vào lô này.

### Các chốt còn lại, không được hiểu là đã hỗ trợ toàn bộ knockout

1. Trang 21/35 và các tổ hợp ngoài scope preview vẫn cần nghiệm thu toán
   image/SMask/AIS/shading/text/pattern/spot/overprint trước khi mở thêm.
   Viewer thường dùng xem tương thích có cảnh báo; proof/đo mực không được
   dùng kết quả đó làm bằng chứng đúng màu.
2. Chưa có artifact Acrobat/RIP/Ghent tham chiếu đủ cấu hình để chứng nhận
   rộng. Ghostscript và fixture công thức chỉ cung cấp bằng chứng cục bộ.
3. ICC Lab image/Indexed Range, decoder giải nén trước budget, cumulative
   retained budget/JSON amplification là các giới hạn đã ghi nhận, chưa
   được giải quyết toàn bộ trong chiến dịch knockout.
4. Cần dựng lại bản dev từ source mới và chạy chuỗi thao tác gốc: mở ATB,
   trang 1, zoom/pan, thumbnail/đổi trang và strict Output Preview. Ứng dụng
   đang mở chưa được thay binary; câu “đã có cảnh báo” trước đó không phải
   nghiệm thu runtime của engine mới. Chưa có benchmark tốc độ có kiểm soát.

## Tiếp tục theo yêu cầu “làm hết đi” sau R5

Người dùng đã xác nhận làm tiếp cả ba phần: nhóm phức tạp trang 21/35,
đường đo mực/xuất CMYK và ứng dụng thật. Không xin lại phê duyệt cùng phạm vi;
vẫn chia lô tối đa 5 file ứng dụng/test và không nới guard khi chưa kiểm.

### Bằng chứng R5 mới trước mở rộng

- Đồ thị thật trang 21: 6 invocation K, 5 guard. Bốn group 2171/2173/2174/
  2175 chỉ có 22 fill CMYK, nhưng boundary Screen nên chưa được chứng nhận.
  Group 5566 còn Image Indexed CMYK, intrinsic Gray DCT SMask, AIS, các
  boundary Multiply/SoftLight và shading radial DeviceN.
- Trang 35: 452 invocation K, chỉ 4 guard. Hai group Multiply 17572/17710
  chỉ có 42 fill CMYK; hai group 17569/17707 có 52 axial shading, trong đó
  một shading DeviceN và 51 DeviceCMYK, opacity khoảng 0,2.
- Hai shading DeviceN 5526/30108 đều chỉ có ba tên process Cyan/Magenta/
  Yellow; không phải mực pha. Không được mở toàn bộ DeviceN từ bằng chứng này.
- Ảnh R5/GS trang 21 và 35 @72DPI đã tạo tại
  `.tmp/knockout-c2-20260928/visual-r5-page21` và `visual-r5-page35`.
  Trang 21 còn khác các vòng tròn/vân bên trong, cần xử lý trước chứng nhận;
  không dùng MAE toàn trang nhỏ làm lý do tắt guard.
- Đo mực có hai proof gap riêng: nét dưới pixel trong tracked group chưa
  dùng coverage bảo thủ; việc chọn mẫu ảnh theo TAC trên surface con có thể
  đảo thứ tự khi merge vào cha K. Không chuyển cờ preview sang đo mực.

### Các lô tiếp theo đã duyệt

- A: DeviceN process-only cho path/shading + boundary blend separable đã
  có toán; kiểm tương đương CMYK độc lập và giữ ca âm spot/mixed/RGB.
- B: image/mask/AIS và các group Multiply/SoftLight của trang 21; kiểm
  provenance mask, số học và ảnh tham chiếu trước mở scope.
- C: tách chứng nhận raster CMYK production khỏi chốt TAC bảo thủ; sửa
  ca nét mảnh và mẫu ảnh lồng trước khi nâng khả năng đo mực.
- D: đồng bộ capability/cache, dựng staged native/Tauri cuối, chạy đủ
  corpus và kiểm ứng dụng thật. Không dùng run_dev.bat hiện tại để tự kill
  các process ngoài lượt kiểm thử; việc khởi động bridge cần xét riêng.

### A — DeviceN process và blend tách kênh đã qua kiểm số học

- RED thực: shading CMY DeviceN, opacity0/AISfalse giữ C=0,7 của sibling,
  thay vì C=0,2 của backdrop ban đầu. Whitelist cũ làm bỏ tracked compositor.
- Helper chỉ nhận CMYK/Gray và DeviceN toàn tên process duy nhất; spot,
  mixed, /None, tên process trùng và RGB vẫn loại. Dùng chung cho fill,
  stroke, direct shading. Boundary mở 12 blend separable đã có toán.
- Chứng nhận preview vẫn chưa mở AIS/SMask/image; shading hỏng hoặc thiếu
  resource vẫn tăng nonce, không trở thành subtree sạch.
- **935 test đạt, 8 ignored**, gồm 10 test process mới (1.152 render shading,
  192 ca boundary, 576 fill và 576 stroke), 22 test certificate. Test độc lập
  tự tính công thức, không lấy output PPE làm oracle. Không cập nhật golden.
- Full cargo test lần đầu lỗi quyền ghi fingerprint example; chạy lại với
  quyền được cấp đạt. Chưa dùng kết quả này thay cho kiểm ảnh ATB/runtime.
