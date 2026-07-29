---
name: prynx-dieline
description: "Bất biến hình học + hệ gấp 3D + xếp khuôn (nesting) + quy trình test của engine khuôn bế bao bì PrynX. BẮT BUỘC đọc trước khi sửa bất kỳ file nào trong desktop/src/lib/dieline hoặc desktop/src/lib/mockup3d — kể cả sửa nhỏ. Use when working on dielines, packaging templates, box generators, fold 3D, CUT/CREASE/BLEED paths, nesting/interlock layout, golden master snapshots, khuôn bế, hộp đáy dán, nếp gấp, tam giác dán, xếp khuôn, lồng khuôn, số khuôn trên tờ."
---

# Engine khuôn bế PrynX (2D + 3D)

Nguồn sự thật hình học là TS: `desktop/src/lib/dieline/`. Mỗi loại hộp một generator (`AutoBottomBox.ts`, `PizzaBox.ts`…), đăng ký trong `engine.ts` → `dispatchGenerator`. Chuẩn đánh giá nội bộ: **đọc `audit-rules.md` ở gốc repo** trước khi kết luận hình nào "sai".

## Hợp đồng dữ liệu

- `DielineModel { panels, allPaths, boundingBox, params, warnings }`
- `Panel { name, paths, outline, parent, pivotEdge, foldAngle, foldDirection, foldPhase, renderZShift, gusset, annotations }`
- `PathSegment { points, tag: CUT|CREASE|BLEED, type: line|arc|bezier, controlPoints }`
- Đơn vị mm; tọa độ snap qua `snap()` — không tự làm tròn kiểu khác.
- Cảnh báo sản xuất đưa vào `model.warnings`, không `console.log`.
- **`boundingBox` phải bao đúng `allPaths`.** Model vi phạm điều này không tồn tại trong thực tế, nhưng fixture test tự dựng thì vi phạm rất dễ — và khi đó nó KHOÁ LUÔN hành vi sai (đã xảy ra: fixture đặt bbox 200×150 trong khi nét CUT chỉ 40×30, khoá đúng cái bug chọn sai biên khuôn). Muốn phân biệt hai nguồn dữ liệu trong test thì dùng đặc trưng hình (số đỉnh, hình chữ L) chứ đừng dùng kích thước phi thực tế.

## Bất biến 2D — vi phạm là lỗi khuôn thật, dao bế cắt sai

1. **Chuỗi CUT ngoài của mỗi panel phải KÍN**: endpoint đoạn sau trùng đoạn trước (sai số <0.01mm). Khe hở = dao bế đứt quãng.
2. **CREASE không được "lơ lửng"**: hai đầu mọi nếp gấp phải trùng đỉnh CUT hoặc đầu CREASE khác. Kiểm bằng khoảng cách <0.01mm.
3. **Bezier phải tự nhất quán**: `points[0]`/`points[cuối]` trùng `controlPoints[0]`/`[3]` (<1e-6). Khi retarget endpoint phải ghi CẢ HAI — chỉ ghi `points` là hình canvas và export lệch nhau (đã từng gây free-edge "quăn" ở hộp đáy dán).
4. **Không fillet góc nằm trên đường gấp** (fold): góc trên fold là góc sắc theo mẫu khuôn thật; chỉ bo nhẹ các góc ở dải đáy sâu, qua guard kiểu `canFillet` (đủ dài, không quá nhọn/tù).
5. **Tách panel phải có guard suy biến**: chỉ tách khi mảnh mới có diện tích thật (>1mm², kiểm bằng ringArea) — tránh panel rỗng khi tham số biên (ví dụ ABD = W/2).
6. Tham chiếu template SVG thật khi dựng hình (đặt tên mã mẫu, ví dụ auto-bottom = `100010-01`); đặt tên điểm chuẩn theo mẫu (A, I, H, G, F, E, EarL, EarR, M, C, B) và giữ chú thích DEV qua `annotations`.

## Xếp khuôn (nesting) — `nestingEngine.ts`, `nestingProfile.ts`, `nestingCollision.ts`

1. **Biên ngoài khuôn KHÔNG lấy được bằng vòng CUT khép kín.** Khuôn thật luôn có rãnh xả / nét cụt / lỗ khoét nên `extractOuterSilhouette` không khép được chuỗi ⇒ `computeDieOutline` rơi về bbox-rect cho **mọi** loại hộp. Đừng viết logic nào dựa trên giả định nó trả biên thật.
2. **Silhouette phải PHỦ bao khuôn mới được dùng** (`silhouetteCoversDie`, dung sai 1mm). "Khép kín + ≥3 đỉnh + diện tích > 0,001mm²" là chưa đủ: một khe nội bộ 2,5×45mm từng được nhận làm biên của khuôn pizza 468×736 ⇒ bước lưới ~11mm ⇒ engine báo 784 khuôn/tờ trên tờ 790×1090 (vật lý tối đa 2) kèm vị trí toạ độ âm.
3. **Nguồn biên dạng thật là profile theo CỘT** (`computeCutProfile`): mỗi cột x lưu [yMin, yMax] vật liệu lấy từ min/max giao điểm với mọi nét CUT — nét nội bộ nằm trong vật liệu nên không ảnh hưởng cực trị. Không cần vòng kín. Giới hạn đã biết: đo hở theo trục dọc, hai mép cùng nghiêng gắt ở góc chéo có thể sát hơn `gap` một ít; đổi lại không bao giờ báo chồng oan.
4. **Profile `synthetic` = không mang thông tin hình học** (khuôn đặc hình chữ nhật khi không có model). Phía dùng PHẢI bỏ qua mọi kết luận va chạm từ nó, nếu không sẽ loại oan mọi vị trí lồng — đúng cái bug từng làm mọi chiến lược lồng (RTE/SLB/pizza/envelope) chết âm thầm trong app dù code vẫn chạy.
5. **Hệ quy chiếu: y của khuôn hướng LÊN, y của tờ giấy hướng XUỐNG.** Mọi hàm tính bước hàng/khoảng hở phải ghi rõ nó làm việc trong hệ nào (`minRowPitch` tính trong hệ tờ giấy). Tính lẫn hệ sẽ đảo hai bước xen kẽ của layout 0°/180° — đã mắc đúng lỗi này một lần.
6. Chiến lược lồng chọn theo `params.boxType` trong `calculateNesting` (rte / slb + auto_bottom / cup_sleeve / pizza / envelope / hanging_window dùng `calcProfileInterlock`). Hộp 2 mảnh (`tray`, `double_tray`) đi đường riêng: `layoutTraySleeveCombined` trong `engine.ts`, xếp cả hai mảnh trên cùng tờ. Mọi chiến lược mới phải đi qua guard chồng khuôn trong `chooseBest` và không được kém `grid`.

## Hệ gấp 3D (`mockup3d/`)

- Mỗi panel quay MỘT lần quanh `pivotEdge` của nó, cộng dồn theo chuỗi `parent` (`foldCompensation.ts`). `pivotEdge` phải là biên chung hình học thật của panel với parent — pivot "tự chế" sẽ làm panel bay khỏi hộp.
- `foldPhase [start, end]` chia giai đoạn gấp: phần tử con gập trước, thân gập sau (ví dụ đáy dán: tab 0.5–0.62, tai 0.62–0.78, mảnh chính 0.78–0.95).
- `foldAngle` + `foldDirection` (±1) cho chiều gập; gập 180° quanh nếp chéo 45° dùng cho tam giác dán (`bottom_tab_*`, con của `bottom_main_*`, pivot [B,E]).
- `renderZShift`: tịnh tiến theo trục z LOCAL của panel CHA, áp ngoài cùng, scale theo tiến độ gấp của chính panel — dùng tách lớp giấy chồng nhau (ví dụ −(T+0.1) cho tab nằm trên mặt tai). Màng chéo góc (gusset) dùng `gussetFold.ts`/GussetMesh, không mô phỏng bằng panel thường.

## Quy trình khi sửa dieline

0. **Chẩn đoán bằng số đo, không bằng đọc code.** Khi một tính năng "có code mà không thấy tác dụng", việc đầu tiên là in giá trị trả về THỰC TẾ của hàm trung gian trên dữ liệu thật (harness vitest tạm, tiền tố `__probe`, xoá sau khi xong). Cả hai bug nặng nhất của engine tới nay — biên khuôn là một cái khe 2,5×45mm, và mảnh đáy dán sập về sàn 1mm — chỉ hiện ra khi in số, đọc code thì logic trông hợp lý. Với nesting, số cần in là: khuôn/tờ ở cả `grid` và `smart`, số vị trí có toạ độ âm, kích thước outline so với bbox khuôn.
1. Sửa generator/helpers → chạy `cd desktop && npx vitest run src/lib/dieline`.
2. Bộ test nhiều tầng, đừng tắt tầng nào: `generators.test.ts` (cấu trúc panel), `contourValidator`, `geometry*`, `bleedContours`, property test `arbitraries.ts`, `goldenMaster.test.ts` (snapshot), `nativeFixtureParity.test.ts` (khớp bản Rust `native/src/dieline_engine.rs`). Chạm nesting thì thêm: `nestingProfile.test.ts`, `nestingCollision.test.ts`, `polygonOffset.test.ts`, `engine.integration.test.ts`.
3. **Golden master chỉ được `-u` khi thay đổi hình học là CHỦ ĐÍCH và đã soi diff snapshot** — snapshot là chốt chống trôi hình. `npx vitest -u src/lib/dieline/goldenMaster.test.ts`.
4. Đổi xong build lại bundle sidecar: `npm run build:dieline-sidecar` (run_dev.bat tự làm) + `npm run check:dieline-webview`.
5. Kiểm tay: canvas 2D (chuỗi CUT kín, crease chạm đỉnh) và 3D (kéo foldProgress 0→1, xem đúng thứ tự giai đoạn, không panel nào xuyên/bay).
6. Nếu đổi hình học mà `nativeFixtureParity` đỏ: cân nhắc cập nhật fixture/bản Rust cùng lúc — hai engine phải cho cùng kết quả.

Test chạy trên Windows thật (node_modules chứa binary Windows — xem `prynx-testing`).
