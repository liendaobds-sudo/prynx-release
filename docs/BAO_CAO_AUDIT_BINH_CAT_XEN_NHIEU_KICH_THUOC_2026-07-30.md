# BÁO CÁO AUDIT & ĐẶC TẢ — BÌNH CẮT XÉN NHIỀU KÍCH THƯỚC

**Ngày:** 30/07/2026  
**Trạng thái:** Chờ duyệt đặc tả trước khi sửa code  
**Phạm vi:** Bình cắt xén hình chữ nhật, nhiều mẫu khác kích thước, 1 mặt và 2 mặt lật cạnh dài/cạnh ngắn  
**Nguồn sự thật:** working tree hiện tại tại thời điểm audit; repo đang có nhiều thay đổi chưa commit nên mọi lô phải bảo toàn phần việc đang có.

---

## 1. Kết luận điều hành

Tính năng **làm được bằng code thuần**, không cần AI/API và không đòi thêm phần cứng đặc biệt.

Hướng triển khai được chốt như sau:

1. Thêm một chế độ nghiệp vụ riêng: `layoutType = "mixed_guillotine"`, hiển thị cho người dùng là **Dàn nhiều kích thước**.
2. Không bỏ hàng rào hiện tại rồi cho các chế độ `sequential`, `cut_stacks`, `ratio_stack` trộn kích thước tùy ý. Các chế độ cũ giữ nguyên để không làm thay đổi output đang dùng.
3. MVP dùng **chia vùng chữ nhật có cây cắt guillotine hợp lệ**. Mỗi vùng chỉ chứa một loại thành phẩm và dùng lưới tối ưu riêng của loại đó. Đây là hướng an toàn cho dao xén thẳng.
4. Preview và export phải gọi **cùng một hàm dựng kế hoạch**. Không cho frontend tự suy lại vị trí.
5. Bình hai mặt coi mỗi sản phẩm là một cặp trang `trước/sau`; hai trang trong cùng cặp phải có cùng kích thước thành phẩm trong sai số `0,5 pt` (~`0,176 mm`).
6. Mặt sau được sinh từ đúng kế hoạch mặt trước bằng phép lật toàn tờ:
   - **Cạnh dài:** phản chiếu vị trí theo trục ngang của tờ (`mirror X`).
   - **Cạnh ngắn:** phản chiếu vị trí theo trục dọc của tờ (`mirror Y`).
7. Solver phải trả cả placements và **kế hoạch/cây cắt**. Một layout có vị trí không chồng nhau nhưng không chứng minh được thứ tự dao xén thì không được dùng.
8. Giai đoạn sau mới tối ưu nâng cao bằng cây chia đệ quy nhiều kích thước vùng. MVP ưu tiên đúng đường dao, đúng hai mặt và dễ hiểu hơn vài phần trăm tiết kiệm giấy.

**Khuyến nghị:** GO, theo các lô nhỏ ở mục 11. Không triển khai bằng cách tái sử dụng trực tiếp `replicate_mixed` hoặc MaxRects tùy ý.

---

## 2. Phạm vi đã chốt

### 2.1 Trong phạm vi MVP

- Nhiều mẫu hình chữ nhật có kích thước thành phẩm khác nhau trên cùng một tờ.
- Tự xoay 90° khi có lợi và không bị khóa hướng.
- Khoảng hở X/Y, bleed, bốn lề, lề nhíp và dấu xén.
- Số lượng riêng cho từng sản phẩm.
- Một mặt.
- Hai mặt theo cặp trang trước/sau.
- Lật cạnh dài và cạnh ngắn.
- Nhiều tờ mẫu khi tất cả sản phẩm không thể nằm trên một tờ duy nhất.
- Preview nhiều tờ/mặt và report số tờ vật lý.
- Bảo toàn các chế độ cùng kích thước hiện tại.

### 2.2 Ngoài phạm vi MVP

- Nesting polygon/NFP cho tem bế không phải hình chữ nhật.
- Trộn đường bế tự do với dao xén thẳng.
- Ép `cut_stacks` hỗ trợ nhiều kích thước.
- Tối ưu toàn cục kiểu arbitrary bin packing nhưng không có cây cắt.
- Tự nhận diện cặp trước/sau bằng nội dung ảnh; thứ tự cặp vẫn theo trang PDF.
- Thay đổi màu, nội dung, TrimBox hoặc artwork nguồn.
- Thay đổi worker pool/cap phần cứng.

---

## 3. Kiến trúc/đường chạy đã trace

### 3.1 Export thật

```text
GridSettingsSection.tsx
  → ImposerDashboard.tsx:onStartNup (1107–1170)
  → ImpositionTab.tsx:config → process handler (1557–1620)
  → processHandlers.ts dựng backendSettings (81–170)
  → api.ts:startNupJobBackend (542–547)
  → POST /api/imposition/nup-start
  → routes/imposition.py:start_nup_job (1301–1304)
  → _launch_impose_job → _spawn_nup_process (1223–1281)
  → nup_engine.py:run_nup_engine
  → nup_process_chunk.py:process_chunk
  → PDF kết quả + report
```

### 3.2 Preview thật

```text
GridPreview.tsx dựng body (1271–1356)
  → POST /api/imposition/preview-layout
  → routes/imposition.py:PreviewLayoutRequest (1433–1500)
  → preview_layout
  → solver/layout branch
  → cells + sheets + cutLines
  → GridPreview.tsx đổi pt → mm và vẽ (1398–1455, 1749–1774)
```

### 3.3 Điểm hợp nhất bắt buộc sau nâng cấp

```text
PDF nguồn + cấu hình
          │
          ▼
build_mixed_guillotine_plan(...)
          │
          ├── Preview: chỉ chuyển plan sang JSON/SVG
          └── Export: chỉ render đúng plan sang PDF
```

Preview và export không được có hai thuật toán phân vùng khác nhau.

---

## 4. Phát hiện có bằng chứng

| Mã | Trạng thái | Mức / effort | Phát hiện và bằng chứng |
|---|---|---|---|
| §MG.1 | `[VERIFIED]` | P1 / M | Ba chế độ nhiều mẫu hiện tại chủ động từ chối kích thước khác nhau. Export chặn tại `backend/app/workers/nup_engine.py:2293–2334`; preview chặn tại `backend/app/api/routes/imposition.py:2984–3006`. Test đang khóa hành vi này tại `backend/tests/test_guillotine_audit_regressions.py:47–58` và `backend/tests/test_guillotine_preview_live_pages.py:105–127`. |
| §MG.2 | `[VERIFIED]` | P2 / S | `repeat` đã hỗ trợ nhiều kích thước nhưng mỗi trang được bình riêng theo sức chứa riêng, không ghép nhiều loại trên cùng tờ. Bằng chứng: `nup_engine.py:2674–2705`, test `test_guillotine_audit_regressions.py:61–114`. Đây không phải lời giải cho yêu cầu mới. |
| §MG.3 | `[VERIFIED]` | P1 / M | Repo đã có nền tảng zone chữ nhật: `run_zone_partition_sheets()` và `compute_cluster_sheets()` tại `backend/app/workers/cluster_tile_engine.py:487–603`; biên vùng full-span được sinh tại `:470–484`. Bộ test zone hiện có đạt và kiểm tra 17 loại/2×2, tỉ lệ số lượng, cut lines và contract placement tại `backend/tests/test_zone_partition.py`. Có thể tái sử dụng phần này cho MVP. |
| §MG.4 | `[VERIFIED]` | P0 / M | Luồng cluster hai mặt hiện chưa có hợp đồng cặp trang thống nhất. Export chỉ lấy trang chẵn làm mặt trước (`nup_engine.py:2359–2392`) rồi map `+1` làm mặt sau (`:2505–2539`) nhưng không kiểm tra kích thước mặt sau. Preview cluster lại lặp toàn bộ trang (`imposition.py:1900–1924`) và không có nhánh pair/duplex trong đoạn `:1865–2196`. Nếu tái dùng nguyên trạng, preview và output có thể hiểu số loại khác nhau, hoặc mặt sau bị đặt theo kích thước mặt trước dù khổ khác. |
| §MG.5 | `[VERIFIED]` | P1 / M | Bình cắt xén thường chỉ lật theo X. `nup_process_chunk.py:647–656` hard-code mirror X cho mọi trang PDF lẻ khi `duplex_flow == 'double'`. Chỉ CNC đang có `long/short` tại `cnc_render.py:129–148` và UI tại `AdvancedSettingsSection.tsx:220–232`. Cần field riêng `duplexFlipEdge`, không dùng tên CNC cho nghiệp vụ thường. |
| §MG.6 | `[VERIFIED]` | P1 / L | `replicate_mixed` dùng cascade/shelf pack liên tục (`cluster_tile_engine.py:197–332`). Hàm chỉ trả đường cắt ở biên các tile (`:171–194`), không trả cây cắt chứng minh mọi sản phẩm hỗn hợp bên trong cụm tách được bằng dao guillotine. Vì vậy không được chọn làm solver mặc định cho tính năng mới. |
| §MG.7 | `[VERIFIED]` | P1 / M | Zone hiện tại an toàn về biên vùng nhưng UX và lỗi biên chưa đủ: người dùng phải tự nhập số cột × hàng trong mục nâng cao (`AdvancedSettingsSection.tsx:777–970`), các nhãn còn “Cluster Tile”, `zone_ratio`; test hiện còn mô tả vùng quá nhỏ bằng cách trả tờ rỗng thay vì lỗi (`test_zone_partition.py:194–219`). Chế độ mới cần auto-plan và thông báo rõ loại nào không vừa. |
| §MG.8 | `[VERIFIED]` | P1 / M | Payload export và preview đang khai riêng, không có codegen chung: export gửi camelCase trong `processHandlers.ts:108–166`; preview gửi snake_case trong `GridPreview.tsx:1271–1350`; `PreviewLayoutRequest` dùng `extra='forbid'` tại `imposition.py:1433–1435`. Field mới phải được nối đủ hai đầu trong cùng đợt, nếu thiếu preview sẽ 422 hoặc export âm thầm dùng mặc định. |
| §MG.9 | `[VERIFIED]` | P1 / M | UI hiện chỉ có ba lựa chọn `sequential`, `cut_stacks`, `ratio_stack` tại `GridSettingsSection.tsx:315–338`. Chia nhiều kích thước đang bị giấu sau “Cách chia cụm” ở phần nâng cao, không phù hợp người dùng nhà in phổ thông. |
| §MG.10 | `[VERIFIED]` | P2 / S | Nền hình học hiện có đã chuẩn hóa không gian trang cho preview và export qua `canonical_page_space` (`imposition.py:1805–1818`, `nup_engine.py:219`). Chế độ mới phải đi qua cùng cửa này, không tự đọc lại MediaBox/Rotate theo đường riêng. |

### 4.1 Xác minh thực thi tại thời điểm audit

Đã chạy bằng đúng venv dự án:

```text
backend\venv\Scripts\python.exe -m pytest \
  backend/tests/test_guillotine_audit_regressions.py \
  backend/tests/test_guillotine_preview_live_pages.py \
  backend/tests/test_zone_partition.py -q
```

Kết quả: **39 passed, 2 warnings, 1,87 giây**.

Điều này xác nhận baseline hiện tại xanh, guard nhiều kích thước đang hoạt động có chủ đích và các primitive zone hiện hữu đang chạy. Nó chưa chứng minh tính năng mới, vì các test mới ở mục 12 chưa tồn tại.

---

## 5. Hợp đồng nghiệp vụ bắt buộc

### 5.1 Chế độ một mặt

- Mỗi trang PDF là một sản phẩm.
- Kích thước thành phẩm lấy từ resolver hiện hành: ưu tiên TrimBox hợp lệ; nếu không có thì dùng khổ trang trừ bleed theo quy tắc Bình cắt xén hiện tại.
- Mỗi sản phẩm có số lượng riêng; ô trống kế thừa số lượng chung.
- Solver ưu tiên đưa ít nhất một bản của mọi sản phẩm lên cùng tờ đầu nếu hình học cho phép.
- Nếu không thể, kết quả được chia thành nhiều **tờ mẫu** và UI nói rõ số tờ mẫu; không âm thầm bỏ sản phẩm.

### 5.2 Chế độ hai mặt

- Trang 1/2 là sản phẩm 1: mặt trước/mặt sau.
- Trang 3/4 là sản phẩm 2; tiếp tục tương tự.
- PDF có số trang lẻ phải bị từ chối trước khi solve.
- Hai trang trong cùng cặp phải cùng kích thước thành phẩm với tolerance `0,5 pt` cho từng chiều.
- Số lượng lưu ở key trang chẵn 0-based (mặt trước), khớp UI hiện tại.
- Chỉ solve hình chữ nhật vật lý của các trang mặt trước.
- Mặt sau dùng đúng zone, rotation và slot của mặt trước, sau đó phản chiếu toàn bộ vị trí theo cạnh lật.
- Không được pack mặt trước và mặt sau độc lập.

### 5.3 Số lượng và tờ mẫu

- Plan phải phân biệt:
  - `requestedQuantity`: số lượng yêu cầu;
  - `placedPerRun`: số bản của sản phẩm trên một tờ mẫu;
  - `runCount`: số lần in tờ mẫu;
  - `actualQuantity`: số lượng thực;
  - `excessQuantity`: số dư.
- Mặc định ưu tiên **đủ số lượng với dư ít nhất**.
- Khi tỷ lệ số lượng không thể biểu diễn bằng một tờ mẫu duy nhất, solver được phép tạo tờ mẫu phần dư riêng.
- Không được báo “đúng số lượng” nếu thực tế có dư; report phải hiện số dư theo từng sản phẩm.
- Chế độ `exportUniqueSheets` phải giữ đúng nghĩa: xuất một bộ tờ mẫu và report số lần in, không nhân hàng trăm trang PDF giống nhau.

### 5.4 Hình học

- Đơn vị lõi: point; UI tiếp tục dùng mm và chỉ đổi đơn vị ở biên.
- Placement phải nằm hoàn toàn trong vùng dùng được sau khi trừ lề, lề nhíp và vùng dành cho marks.
- Khoảng hở X/Y và bleed không được bị tính hai lần.
- Cho phép xoay 90°; cờ xoay là một phần của plan và backend là nguồn sự thật.
- Không overlap sau khi tính gap/tolerance.
- Trang không vừa ngay cả khi xoay phải báo lỗi kèm số trang, khổ thành phẩm và vùng giấy khả dụng.

### 5.5 Dao xén

- Mỗi tờ phải có một `cutTree` hợp lệ.
- Mỗi node cắt chia đúng hình chữ nhật hiện tại thành hai hình chữ nhật con.
- Nhát cắt không đi xuyên phần thành phẩm.
- Mỗi leaf là một zone một loại; lưới trong leaf có thứ tự cắt riêng.
- `cutLines` chỉ là hình chiếu để preview/vẽ marks; `cutTree` mới là nguồn chứng minh cắt được.
- Có validator độc lập kiểm tra cây cắt trước khi preview hoặc render PDF.

### 5.6 Tương thích

- `repeat`, `sequential`, `cut_stacks`, `ratio_stack` giữ nguyên output khi không chọn chế độ mới.
- Preset cũ không có field mới phải nạp như trước.
- Không cập nhật golden/snapshot cũ nếu hình học cũ không chủ đích thay đổi.
- Bình tem bế, CNC và Bình nguyên tấm decal không tự chảy vào chế độ mới.

---

## 6. Thiết kế UI/UX đề xuất

### 6.1 Luồng chính

Trong **Cách thức ráp**, thêm lựa chọn:

```text
Xếp lần lượt
Xếp chồng đúng thứ tự
Chia tỷ lệ + xếp chồng
Dàn nhiều kích thước   ← mới
```

Khi chọn **Dàn nhiều kích thước**, phần chính chỉ hiện các điều khiển cần thiết:

1. **Số mặt:** `1 mặt` / `2 mặt`.
2. Nếu 2 mặt: **Lật giấy theo:** `Cạnh dài` / `Cạnh ngắn`.
3. **Số lượng mỗi sản phẩm:** bảng sản phẩm như hiện tại.
4. **Cách dàn:** `Tự động — dễ cắt xén` (mặc định duy nhất trong MVP).
5. Preview có nút chuyển `Tờ 1 — Mặt trước`, `Tờ 1 — Mặt sau`, `Tờ 2...`.

Không đưa các từ `cluster_tile`, `zone_per_type`, `zone_ratio`, `replicate_mixed` ra luồng chính.

### 6.2 Bảng sản phẩm

Một mặt:

```text
Sản phẩm 1 · Trang 1 · 90 × 50 mm     Số lượng [ 1000 ]
Sản phẩm 2 · Trang 2 · 60 × 40 mm     Số lượng [  500 ]
```

Hai mặt:

```text
Sản phẩm 1 · Trang 1–2 · 90 × 50 mm   Số lượng [ 1000 ]
Sản phẩm 2 · Trang 3–4 · 60 × 40 mm   Số lượng [  500 ]
```

Nếu cặp sai kích thước:

```text
Sản phẩm 2 chưa thể bình 2 mặt:
Mặt trước 90 × 50 mm, mặt sau 91 × 50 mm.
Hãy sửa khổ hai trang cho giống nhau rồi thử lại.
```

### 6.3 Preview

- Mỗi loại dùng một màu nhận diện ổn định và có nhãn `SP 1`, `SP 2`.
- Mặt sau hiển thị `1b`, `2b`; mặt trước `1a`, `2a`.
- Có lớp **Đường cắt** bật/tắt được; số thứ tự dao chỉ hiện khi người dùng mở lớp này.
- Nếu cần nhiều tờ mẫu, hiển thị `Tờ mẫu 1/2`, không gọi là “sheet unique” hay “zone”.
- Preview lỗi phải giữ form và chỉ rõ sản phẩm gây lỗi.

### 6.4 Phần nâng cao

- Các control chia cụm hiện tại không đồng thời tác động lên `mixed_guillotine`.
- Giai đoạn MVP ẩn số cột/hàng vùng khỏi luồng chính.
- Sau khi solver ổn định có thể thêm “Tự chia vùng / Tự chọn hướng dải” trong phần nâng cao, nhưng vẫn dùng thuật ngữ tiếng Việt.

---

## 7. Hợp đồng dữ liệu đề xuất

### 7.1 Cấu hình export (camelCase)

```ts
layoutType: 'mixed_guillotine'
duplexFlow: 'normal' | 'double'
duplexFlipEdge: 'long' | 'short'
mixedGuillotineStrategy: 'auto_zone'
```

### 7.2 Cấu hình preview (snake_case)

```py
layout_type: Literal['mixed_guillotine']
duplex_flow: Literal['normal', 'double']
duplex_flip_edge: Literal['long', 'short']
mixed_guillotine_strategy: Literal['auto_zone']
```

`PreviewLayoutRequest` tiếp tục `extra='forbid'`; do đó frontend, model và route phải được đổi trong cùng lô giao tiếp.

### 7.3 Plan nội bộ dùng chung

```text
MixedGuillotinePlan
  version
  sheetWidth / sheetHeight / usableRect
  duplex / flipEdge
  products[]
    productId
    frontPageIdx / backPageIdx
    trimWidth / trimHeight
    requestedQuantity
  templates[]
    templateId
    runCount
    placements[]
      productId / sourcePageIdx / zoneId
      x / y / width / height / rotation
    cutTree
    cutLines                 # projection phục vụ UI/marks
    placedByProduct
  totalsByProduct
```

Plan phải là dữ liệu thuần, deterministic và JSON-serializable để test preview/export bằng cùng hash.

---

## 8. Thiết kế solver MVP

### 8.1 Bước 1 — Chuẩn hóa sản phẩm

1. Canonicalize page space bằng cửa hiện có.
2. Resolve kích thước thành phẩm của mọi trang một lần.
3. Ghép cặp nếu 2 mặt.
4. Validate số trang, kích thước cặp, số lượng và trang quá khổ.
5. Sinh `ProductSpec[]`, không mang PDF handle vào solver thuần.

### 8.2 Bước 2 — Sinh phương án vùng an toàn

MVP không pack tự do. Nó sinh các candidate có thể chứng minh cắt được:

- Chia thành các dải dọc full-height.
- Chia thành các dải ngang full-width.
- Chia lưới chữ nhật đều khi phù hợp.
- Mỗi zone được gán đúng một sản phẩm.
- Trong mỗi zone gọi `solve_optimal_layout()` hiện có cho riêng kích thước sản phẩm đó.
- Xét cả hướng gốc và xoay 90°.

Các primitive `_split_sizes`, zone geometry và zone placement hiện có được tái sử dụng hoặc tách thành helper chung; không copy logic sang route preview.

### 8.3 Bước 3 — Chấm điểm deterministic

Thứ tự ưu tiên so sánh candidate:

1. Không bỏ sản phẩm nào có số lượng >0.
2. Ít tờ mẫu hơn.
3. Ít thiếu/dư số lượng hơn.
4. Diện tích sử dụng cao hơn.
5. Ít nhát cắt/ít zone hơn.
6. Ít xoay hơn để kết quả ổn định.
7. Tie-break bằng thứ tự trang và tọa độ, để cùng input luôn ra cùng plan.

Không dùng random seed. Không dùng hard-cap worker hoặc giảm chất lượng trên máy mạnh.

### 8.4 Bước 4 — Lập tờ mẫu theo số lượng

- Từ lượng còn thiếu của từng sản phẩm, solver chọn template tốt nhất.
- Tính `runCount` lớn nhất không vượt quá nhu cầu của các sản phẩm trong template.
- Trừ lượng đã đáp ứng rồi lập template phần dư.
- Nếu người dùng không nhập số lượng, tạo một tờ mẫu phủ hợp lý với trọng số các sản phẩm bằng nhau.
- Dừng khi mọi sản phẩm đã đủ hoặc trả lỗi chứng minh sản phẩm nào không thể đặt.

### 8.5 Bước 5 — Sinh cây cắt

- Root biểu diễn vùng giấy khả dụng.
- Mỗi phép chia dải/lưới sinh node `split(axis, coordinate)`.
- Mỗi zone là leaf chứa grid một loại và cây cắt nội bộ.
- Validator duyệt đệ quy:
  - child rectangles phủ đúng parent trừ gap;
  - không overlap;
  - không placement nào bị đường cắt xuyên qua;
  - mọi placement thuộc đúng một leaf;
  - mọi sản phẩm đã khai có mặt trong plan khi khả thi.

### 8.6 Bước 6 — Sinh mặt sau

Không solve lại. Với mỗi placement mặt trước:

```text
long-edge:  backX = sheetWidth  - (frontX + width), backY = frontY
short-edge: backX = frontX, backY = sheetHeight - (frontY + height)
```

Sau đó map `frontPageIdx → backPageIdx` và giữ quy tắc orientation đã được test bằng artwork bất đối xứng. Công thức cuối cùng phải dùng đúng hệ tọa độ canonical của renderer; các công thức trên là hợp đồng hình học, không thay thế test raster artifact thật.

### 8.7 Giai đoạn nâng cao sau MVP

Sau khi MVP đạt parity, có thể thêm recursive slicing tree với vùng không đều để tăng hiệu suất giấy. Điều kiện bắt buộc vẫn là:

- Có cut tree hợp lệ.
- Cùng solver cho preview/export.
- So được với MVP và chỉ chọn phương án nâng cao khi thực sự tốt hơn.
- Không bật arbitrary MaxRects làm fallback âm thầm.

---

## 9. Thông báo lỗi bắt buộc

| Tình huống | Thông báo hướng người dùng |
|---|---|
| PDF 2 mặt có số trang lẻ | “Bình 2 mặt cần từng cặp trang trước/sau. File hiện có N trang; hãy thêm hoặc xóa 1 trang.” |
| Cặp trước/sau khác khổ | Nêu sản phẩm, số trang và hai kích thước thực tế. |
| Một sản phẩm lớn hơn vùng giấy | Nêu trang, khổ thành phẩm và vùng giấy còn dùng được. |
| Gap/lề làm không còn chỗ | “Lề và khoảng hở hiện tại không còn đủ chỗ cho sản phẩm X; hãy giảm lề/khoảng hở hoặc tăng khổ giấy.” |
| Không dựng được cây cắt | “Không tìm được cách dàn có thể cắt thẳng an toàn với cấu hình này.” Không fallback sang pack tự do. |
| Số lượng không hợp lệ | Nêu đúng dòng sản phẩm cần sửa. |
| Preview/export nhận mode không hỗ trợ | HTTP 422 với text tiếng Việt; không âm thầm đổi sang `sequential`. |

---

## 10. Bất biến kỹ thuật

1. **Plan là SSOT:** preview và export cùng gọi `build_mixed_guillotine_plan()`.
2. **Cut-safe:** mọi plan qua `validate_guillotine_plan()` trước khi dùng.
3. **Duplex bijection:** số placement mặt trước = mặt sau; mỗi placement chỉ map sang đúng trang sau của cùng sản phẩm.
4. **Không scale artwork:** kích thước output bằng trim gốc, chỉ cho phép xoay 90°.
5. **Không đọc PDF trong thread song song mới:** nếu sau này chạm PDFium trong thread phải dùng `pdfium_guard()`; MVP solver thuần không cần PDFium.
6. **Không thêm cap vô điều kiện:** không hạ worker/chất lượng trên máy ≥16 GB.
7. **Không NFP:** hình chữ nhật cắt xén dùng solver rectangle/grid, tránh lặp lại chi phí đã tối ưu ở chiến dịch tốc độ Bình trang.
8. **Report vật lý:** 2 trang PDF trước/sau = 1 tờ giấy vật lý; report chỉ đóng ở mặt trước.
9. **Comment/UI tiếng Việt:** tên type/hàm tiếng Anh; text UI và lỗi tiếng Việt, đi qua i18n.
10. **Tag truy vết:** chỗ sửa lớn dùng `MIXED-GUILLOTINE (audit 2026-07-30 §MG.x)`.

---

## 11. Kế hoạch triển khai theo lô (mỗi lô ≤5 file)

Mỗi lô cập nhật `docs/BINH_CAT_XEN_NHIEU_KICH_THUOC_FIXES_2026-07-30.md`, chạy verify hẹp, báo diff và dừng ở checkpoint trước khi sang lô tiếp theo.

### Lô 0 — Characterization và khóa hồi quy hiện tại

**Mục tiêu:** đóng băng hành vi cũ trước khi mở mode mới.

**Tối đa 3 file:**

1. `backend/tests/test_guillotine_audit_regressions.py`
2. `backend/tests/test_guillotine_preview_live_pages.py`
3. `docs/BINH_CAT_XEN_NHIEU_KICH_THUOC_FIXES_2026-07-30.md`

**Test thêm:** same-size output không đổi; cluster hiện hữu; odd duplex; mismatch; report tờ vật lý; payload characterization.

### Lô 1 — Solver thuần + cây cắt

**Mục tiêu:** có `ProductSpec → MixedGuillotinePlan`, chưa nối UI/PDF.

**Tối đa 4 file:**

1. `backend/app/workers/mixed_guillotine.py` — mới
2. `backend/app/workers/cluster_tile_engine.py` — chỉ tách/reuse primitive zone nếu cần
3. `backend/tests/test_mixed_guillotine_solver.py` — mới
4. Nhật ký fixes

**Verify:** unit/property tests cho overlap, bounds, rotation, quantity, cut-tree validity, deterministic hash.

### Lô 2 — Export PDF và hai mặt

**Mục tiêu:** `nup_engine` render đúng plan, hỗ trợ cạnh dài/ngắn và report vật lý.

**Tối đa 5 file:**

1. `backend/app/workers/nup_engine.py`
2. `backend/app/workers/nup_process_chunk.py`
3. `backend/app/workers/nup_report.py` — chỉ nếu report không thể dựng ở engine
4. `backend/tests/test_mixed_guillotine_export.py` — mới
5. Nhật ký fixes

**Verify:** xuất PDF thật, đếm Form XObject/placements, raster artwork bất đối xứng, front/back registration, report.

### Lô 3 — Preview gọi chung solver

**Mục tiêu:** preview trả đúng cùng plan/hash với export.

**Tối đa 3 file:**

1. `backend/app/api/routes/imposition.py`
2. `backend/tests/test_mixed_guillotine_preview.py` — mới
3. Nhật ký fixes

**Verify:** HTTP 422 cho input sai; JSON plan parity; nhiều tờ/mặt; không route vào MaxRects/NFP.

### Lô 4 — State và transport frontend

**Mục tiêu:** nối type/store/payload, chưa mở lựa chọn UI cho người dùng.

**Tối đa 5 file:**

1. `desktop/src/components/imposition-tools/store/slices/nupSlice.ts`
2. `desktop/src/components/imposition-tools/types.ts`
3. `desktop/src/lib/imposerEngine/SettingsTypes.ts`
4. `desktop/src/lib/processHandlers.ts`
5. Nhật ký fixes

**Verify:** typecheck; payload snapshot export; preset cũ vẫn nạp.

### Lô 5 — Controller và preview frontend

**Mục tiêu:** truyền mode/flip edge xuyên dashboard, tab và preview; vẫn có thể giữ UI ẩn cho tới lô 6.

**Tối đa 5 file:**

1. `desktop/src/components/imposition-tools/ImposerDashboard.tsx`
2. `desktop/src/components/ImpositionTab.tsx`
3. `desktop/src/components/imposition-tools/sections/GridPreview.tsx`
4. Một file test frontend liên quan
5. Nhật ký fixes

**Verify:** typecheck; abort/stale preview; chuyển tờ/mặt; cut lines; nhãn a/b; preview không tự sửa placements.

### Lô 6 — UI/UX và i18n

**Mục tiêu:** mở tính năng cho người dùng với luồng đơn giản.

**Tối đa 5 file:**

1. `desktop/src/components/imposition-tools/sections/GridSettingsSection.tsx`
2. `desktop/src/components/imposition-tools/sections/AdvancedSettingsSection.tsx`
3. `desktop/src/i18n/locales/vi.json`
4. `desktop/src/i18n/locales/en.json`
5. Nhật ký fixes

**Verify:** typecheck, i18n catalog, test tool panel, bàn phím/focus, thông báo lỗi tiếng Việt.

### Lô 7 — Hardening và nghiệm thu end-to-end

**Mục tiêu:** bổ sung regression còn thiếu sau khi chạy app thật; không mở rộng thuật toán.

**Tối đa 5 file:** các file test cần thiết + nhật ký fixes, không sửa sản phẩm nếu không có lỗi đã tái hiện.

**Verify:** toàn bộ ma trận mục 12, raster preview/output, cùng-kích-thước regression, benchmark và thao tác thật bằng `run_dev.bat`.

---

## 12. Ma trận test bắt buộc

| Nhóm | Ca kiểm thử | Điều kiện đạt |
|---|---|---|
| Một mặt | 2 kích thước khác nhau vừa một tờ | Cả hai loại có mặt, không overlap, cut tree hợp lệ |
| Một mặt | 3 kích thước + một loại phải xoay 90° | Đúng orientation, không scale |
| Số lượng | Tỉ lệ `100:50`, `100:33`, `1:10000` | Đủ số lượng, report đúng dư, không phình slot vô hạn |
| Biên | Vừa đúng trong tolerance | Preview/export cùng quyết định vừa/không vừa |
| Biên | Một loại lớn hơn tờ | Lỗi rõ, không trả tờ rỗng |
| Hình học | Gap X/Y khác nhau | Khoảng cách đúng, không tính hai lần |
| Hình học | Bleed + TrimBox khác MediaBox | Footprint đúng theo resolver chung |
| Hình học | Bốn lề + lề nhíp | Không placement nào lọt vùng cấm |
| Marks | Không dấu / dấu góc / guillotine | Marks đúng plan, không đè thành phẩm |
| Hai mặt | 2 sản phẩm, cạnh dài | Vị trí sau là mirror X của trước, artwork đúng hướng |
| Hai mặt | 2 sản phẩm, cạnh ngắn | Vị trí sau là mirror Y của trước, artwork đúng hướng |
| Hai mặt | Trang lẻ | 422/ValueError tiếng Việt trước khi solve |
| Hai mặt | Cặp lệch `>0,5 pt` | Bị từ chối và nêu đúng cặp |
| Hai mặt | Cặp lệch `≤0,5 pt` | Chấp nhận, dùng cùng footprint chuẩn hóa |
| Parity | Preview plan so export plan | Cùng hash/version/placements/cut tree |
| Artifact | Raster artwork bất đối xứng | Mặt trước/sau canh đúng khi chồng/lật |
| Report | 2 trang PDF cho 1 tờ duplex | Số tờ vật lý đúng, stamp chỉ mặt trước |
| Report | Nhiều tờ mẫu + runCount | Tổng requested/actual/excess đúng từng loại |
| Hồi quy | Same-size `repeat/sequential/ratio_stack/cut_stacks` | Output/golden hiện tại không đổi |
| Hồi quy | Bình tem bế/CNC/page-sheet | Không nhận nhầm `mixed_guillotine` |
| Không gian trang | `/Rotate=90`, MediaBox origin lệch | Preview/output vẫn parity sau canonicalize |
| Hiệu năng | 20 sản phẩm 1 mặt/10 cặp 2 mặt | Không NFP; planner không chiếm phần lớn thời gian export |

### 12.1 Property/invariant tests

Với nhiều bộ kích thước/số lượng sinh tự động:

- mọi placement nằm trong usable rect;
- không giao nhau;
- dimensions đúng với product hoặc hoán đổi khi xoay;
- mọi cut node hợp lệ trong parent rect;
- đường cắt không xuyên placement;
- plan cùng input có hash giống nhau;
- mirror hai mặt là song ánh;
- tổng thực tế không nhỏ hơn số lượng yêu cầu;
- mọi loại không vừa đều xuất hiện trong danh sách lỗi, không bị bỏ im lặng.

### 12.2 Verify chuẩn sau từng tầng

1. `py_compile` file Python vừa chạm.
2. Pytest hẹp theo lô.
3. Pytest nhóm guillotine/zone/report mở rộng.
4. `npm run typecheck` trên Windows thật khi chạm frontend.
5. Vitest phạm vi imposition/i18n.
6. `git diff --check`.
7. `run_dev.bat`: thao tác thật và raster output.
8. Không `-u` snapshot cũ trừ khi thay đổi hình học cũ là chủ đích và đã được duyệt riêng.

---

## 13. Tiêu chí nghiệm thu MVP

MVP chỉ được báo hoàn thành khi đồng thời đạt:

- Người dùng chọn được **Dàn nhiều kích thước** mà không phải mở “Chia cụm”.
- Hai đến ba mẫu khác kích thước ghép được trên cùng tờ khi hình học cho phép.
- 1 mặt và 2 mặt đều xuất PDF thật đúng.
- Cạnh dài/cạnh ngắn cho kết quả đúng trên artwork bất đối xứng.
- Cặp trước/sau sai khổ và PDF trang lẻ bị chặn rõ ràng.
- Preview và export dùng cùng plan, có test hash/parity.
- Cây cắt qua validator; không fallback sang pack không cắt được.
- Số tờ vật lý và số lượng từng loại trong report đúng.
- Các chế độ cùng kích thước hiện tại không đổi.
- Bộ test tự động xanh và người dùng xác nhận runtime trên app thật.

---

## 14. Rủi ro và cách cô lập

| Rủi ro | Cách cô lập |
|---|---|
| Working tree đang rất bẩn | Chỉ sửa đúng file trong từng lô; xem diff theo hunk; không reset/revert phần việc khác |
| `nup_engine.py` là file lớn, nhiều nhánh | Chế độ mới có guard riêng và gọi module solver mới; không nới điều kiện của nhánh cũ |
| Preview/export trôi nhau | Plan chung + hash/version; route không tự solve lại |
| Hai mặt sai trục | Test raster artwork bất đối xứng cho cả hai cạnh, không chỉ so tọa độ log |
| “Vừa/không vừa” do float | Snap/tolerance ở một helper chung và test just-fit |
| Zone quá nhỏ trả tờ rỗng | Validator biến thành lỗi có danh sách sản phẩm |
| Tối ưu giấy làm mất cut-safe | Cut-tree validity có ưu tiên cao hơn utilization; candidate không hợp lệ bị loại |
| Thay đổi làm chậm máy mạnh | Không thêm hard cap; solver hình chữ nhật thuần; benchmark trước/sau |
| UI lộ thuật ngữ kỹ thuật | Mode chính chỉ dùng “Dàn nhiều kích thước”, “Cạnh dài/ngắn”, “Tờ mẫu” |

Rollback có thể thực hiện theo từng lô nhờ `layoutType='mixed_guillotine'` là nhánh mới và tag `MIXED-GUILLOTINE`; không cần đụng output của mode cũ.

---

## 15. Chốt duyệt

Đề nghị duyệt toàn bộ hợp đồng sau như một gói:

- Mode mới: **Dàn nhiều kích thước**.
- MVP: auto chia vùng có cây cắt, không dùng pack tự do.
- Hai mặt: cặp trang liên tiếp, cùng khổ trong `0,5 pt`.
- Cạnh lật: dài/ngắn.
- Số lượng: đủ số lượng, report rõ số dư và số lần in từng tờ mẫu.
- Các mode hiện tại giữ nguyên.
- Triển khai theo 8 lô nhỏ, checkpoint sau mỗi lô.

Sau khi được duyệt, bắt đầu từ **Lô 0 — characterization**, chưa mở UI cho tới khi backend, preview và export đã đạt parity.
