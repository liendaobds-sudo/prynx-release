# BÁO CÁO AUDIT BÌNH SÁCH / TẠP CHÍ — 2026-07-31

> **ĐÍNH CHÍNH PHẠM VI SAU KHI CHỦ DỰ ÁN DUYỆT:** chỉ sửa và nghiệm thu đường
> **Bình sách In nhanh đang mở cho người dùng**. Offset/Auto Catalog đang khóa và
> “Tách bìa riêng” nằm ngoài phạm vi; không sửa các nhánh đó.
>
> “Tay sách/tép” chỉ liên quan lựa chọn Khâu chỉ chia tép, không liên quan Offset.
> Theo chốt phạm vi, các mục §A.3 và §C.1 được giữ làm thông tin tham khảo, không
> nằm trong lô sửa hiện tại.
>
> Đính chính này thay thế phần mô tả phạm vi và các câu hỏi quyết định ở bản audit
> ban đầu bên dưới.

> Phạm vi: UI Bình sách, năm kiểu đóng cuốn, bốn cách bố trí trên tờ, xem thành phẩm,
> xem bài in, preset, Auto Catalog Offset, planner TypeScript và `PlanExecutor` backend.
>
> Trạng thái cây làm việc: audit trên **worktree hiện tại có thay đổi chưa commit**. Đặc biệt,
> `VirtualMap.ts`, `VirtualMap.test.ts` và `pdfImposer.ts` đang có thay đổi liên quan trực tiếp
> đến gáy keo `continuous`. Báo cáo không sửa hoặc hoàn tác các thay đổi đó.
>
> Quy ước: P0 = có thể xuất sai bài in; P1 = sai hành vi quan trọng/rủi ro sản xuất;
> P2 = UX, nhánh tạm ẩn hoặc nợ test; effort S/M/L.

## 1. Kết luận điều hành

**Chưa nên chốt GO cho toàn bộ ma trận bình sách/tạp chí.** Đường lõi saddle và bộ dựng PDF
backend có nền tảng tốt, nhưng audit tìm thấy **1 tổ hợp P0**, **6 vấn đề P1** và các khoảng
trống kiểm chứng đáng kể:

1. `flush_mount + cut_stack` được UI cho chọn nhưng serializer biến bài **in một mặt** thành
   các plate A/B hai mặt.
2. Thay đổi mới của `continuous` đã chuyển padding thường sang bội 2, trong khi hộp xác nhận
   và Flipbook vẫn tính bội 4.
3. Lựa chọn “Giữa sách” đặt trang trắng theo giữa toàn tài liệu, không theo giữa từng tay
   sách của `thread`.
4. Bài 1-up `continuous/cut_stacks/flush_mount` vẫn nhận dấu **gấp màu đỏ** ở giữa, trong khi
   phase-2 cùng codebase coi đó là đường **xẻ/cắt màu đen**.
5. Preset không lưu đủ ngữ cảnh Digital/Offset và nhiều tham số làm thay đổi output.
6. Các test page-order của saddle/thread/cut_stacks đang bị xóa khỏi worktree; test hiện tại
   xanh nhưng không còn chứng minh các bất biến này.
7. Số trang/tay sách do người dùng nhập có thể bị engine tự vượt quá mà chỉ báo sau khi đã lập
   kế hoạch.

Offset/Auto Catalog hiện bị khóa bằng `HIDE_OFFSET_BOOKLET = true`, nên trạng thái sản phẩm hiện
tại là **chỉ hỗ trợ UI In nhanh**. Nhánh Offset vẫn được audit vì chỉ cần bật cờ là quay lại đường
chạy thật.

## 2. Ma trận kiểu đóng cuốn × trường hợp bình

| Kiểu đóng | 1 cuốn/tờ 100% | 1 cuốn/tờ Fit | Nhiều cuốn/tờ S&R | Ghép nửa cuốn Cut & Stack | Offset/sơ đồ gấp | Kết luận |
|---|---|---|---|---|---|---|
| `saddle` — bấm kim giữa | Có | Có | Có | Có | Có pattern 4/8/16p | Cơ sở tốt; cần golden E2E đầy đủ |
| `thread` — khâu chỉ chia tép | Có | Có | Có | Có | Có pattern 4/8/16p | Có rủi ro trang trắng giữa tay và vượt `foliosize` |
| `cut_stacks` — cắt đôi ráp xấp | Có | Có | Có | UI chặn tổ hợp kép | Không có fold pattern hợp lệ | Dấu giữa 1-up sai loại/màu; test page-order bị mất |
| `continuous` — gáy keo/lò xo | Có, nhưng thực tế 2 bản sau xén | Có, nhưng thực tế 2 bản sau xén | Có | Có, đang được viết lại | Không được Auto Catalog mô hình hóa đúng | Padding/preview/xác nhận đang lệch |
| `flush_mount` — dán đối lưng | Có, một mặt | Có, một mặt | Có, một mặt | **FAIL-P0: bị ghép thành A/B hai mặt** | Không hỗ trợ | Phải chặn `cut_stack` hoặc viết planner riêng |

Ghi chú:

- UI đang cho `cut_stack` với mọi kiểu trừ `cut_stacks` (`BookletSettingsSection.tsx:133-137`).
- Offset hiện bị ẩn (`featureFocus.ts:4-13`), vì vậy các ô Offset trong bảng là đánh giá nhánh
  dormant, không phải lời khẳng định người dùng hiện nhìn thấy chúng.
- “Tách bìa riêng” chỉ hiện cho Digital `continuous/thread`. Đường hiện tại chép các trang bìa
  nguyên khổ vào cuối output (`pdfImposer.ts:600-621`, `plan_executor.py:156-188`), không bình
  thành wrap-cover. Cần chủ dự án xác nhận đây là hợp đồng mong muốn trước khi gọi tính năng này
  là hoàn tất.

## 3. Phát hiện có bằng chứng

### §A.1 — `flush_mount + cut_stack` phá bất biến in một mặt — P0 / M

**Bằng chứng:**

- UI chỉ loại `cut_stack` khi `signatureMode === 'cut_stacks'`, nên `flush_mount` vẫn chọn được:
  `BookletSettingsSection.tsx:133-137`.
- `handleStartBooklet` biến lựa chọn này thành `chainNup=true` và `cutStack=true`:
  `ImpositionTab.tsx:1467-1469`.
- `VirtualMap` tạo `flush_mount` với mặt sau toàn `null`: `VirtualMap.ts:75-89`.
- Serializer đúng ra nhận biết đây là single-sided (`InstructionSerializer.ts:203-210`), nhưng
  khi `cutStack=true` lại chọn phase-2 `cut_stack` (`:264-271`).
- `buildPhase2(cut_stack)` chia các surface liên tiếp thành plate “Mặt A/Mặt B”
  (`:589-615`). Với 8 trang flush-mount, bốn surface một mặt bị ghép thành hai cặp A/B.

**Tác động:** file dành cho dán đối lưng có thể được in hai mặt; thứ tự và quy trình gia công sai.

**Đề xuất:** chặn tổ hợp ở UI + validate tại engine boundary; chỉ mở lại khi có thuật toán
cut-stack single-sided và test raster riêng.

### §A.2 — Padding `continuous` lệch giữa engine, xác nhận và Flipbook — P1 / S

**Bằng chứng:**

- Worktree hiện tại quy định `continuous` thường pad bội 2, riêng `continuous + cut_stack` pad
  bội 4: `VirtualMap.ts:34-43`.
- Hộp xác nhận vẫn dùng bội 4 cho mọi kiểu trừ `flush_mount` và gọi `generateBindingMap` không
  truyền `scaleMode`: `ImpositionTab.tsx:1500-1509`.
- Flipbook cũng không nhận/truyền `scaleMode`, đồng thời tự tính mọi kiểu trừ flush-mount theo
  bội 4: `FlipbookDialog.tsx:90-95`; call-site không truyền scale mode tại
  `ImposerDashboard.tsx:1631`.
- Đường xuất thật đã truyền `scaleMode`: `pdfImposer.ts:624-626`.

**Ca tái hiện tĩnh:** `continuous`, 6 trang, scale `100/fit/chain_nup`:

- engine: pad 6, không thêm trang trắng;
- dialog: báo pad 8, cần thêm 2 trang trắng;
- Flipbook: hiển thị 8 trang với 2 trang trắng giả.

### §A.3 — “Giữa sách” không phải giữa tay sách khi khâu chỉ — P1 / M

**Bằng chứng:**

- `logicalToSrc` chèn blank tại midpoint của **toàn tài liệu** trước khi chia signature:
  `VirtualMap.ts:47-65`.
- Sau đó nhánh `thread` mới chia tay theo `foliosize`: `VirtualMap.ts:163-205`.
- UI hứa “Giữa sách / nhét vào ruột trong cùng”: `ImpositionTab.tsx:2306-2317`.

**Ca 34 trang, tay 16, blank=center:** tài liệu pad lên 36; hai blank rơi ở logical 18-19.
Nhánh thread tạo tay đầu 16p và tay sau 20p; blank nằm ở các tờ ngoài đầu tay sau, không phải
ruột trong cùng của tay đó. Với khâu chỉ, creep và thứ tự gấp đều theo từng tay nên midpoint toàn
sách không phải midpoint vật lý cần dùng.

### §A.4 — Dấu giữa 1-up sai cho các kiểu không gấp — P1 / S

**Bằng chứng:**

- Đường phase-2 phân biệt đúng: chỉ `saddle/thread` là foldable; các kiểu còn lại dùng
  `slit_mark` màu đen: `InstructionSerializer.ts:499-516`.
- Đường 1-up lại gọi `serializeBookletMarks` chung (`:299-322`), và hàm này luôn sinh
  `fold_mark` màu đỏ ở tâm (`:712-715`), không nhận `bindingMode`.

**Tác động:** `continuous`, `cut_stacks` và `flush_mount` ở chế độ `100/fit` có chỉ dẫn gia công
không nhất quán với chính chế độ S&R/Cut-stack của cùng kiểu đóng.

### §A.5 — Auto Catalog nhận 5 kiểu nhưng planner chỉ hiểu 2 — P2 latent / M

**Bằng chứng:**

- `CatalogPlanner.PlanConfig` chỉ nhận `saddle | perfect`: `CatalogPlanner.ts:42-50`.
- UI binding vẫn hiển thị continuous/saddle/thread/cut_stacks và flush-mount ở Digital:
  `BookletSettingsSection.tsx:52-61`.
- Khi Auto Catalog chạy, Dashboard map **chỉ** `thread -> perfect`; mọi giá trị còn lại thành
  `saddle`: `ImposerDashboard.tsx:733-739` và `:985-995`.
- Khi chuyển sang Offset, code bật Auto Catalog nhưng không chuẩn hóa binding:
  `AutoCatalogSection.tsx:59-63`.
- Hiện nhánh này bị ẩn/reset bởi `HIDE_OFFSET_BOOKLET=true`: `featureFocus.ts:12`,
  `AutoCatalogSection.tsx:30-36`.

**Tác động khi bật lại:** chọn `continuous`, `cut_stacks` hoặc state cũ `flush_mount` có thể xuất
planner saddle mà UI vẫn giữ tên kiểu đóng khác.

### §B.1 — Preset không tái lập đầy đủ một bài bình sách — P1 / M

**Bằng chứng:**

- Schema preset không lưu `paperClassification`; phần booklet cũng thiếu `gutterMargin`,
  `separateCover`, `coverPageCount`, `blankPlacement`, `autoCatalog` và cấu hình catalog:
  `presetManager.ts:19-53`.
- Snapshot hiện tại chỉ ghi một phần các field: `ImposerDashboard.tsx:1183-1188`.
- Load preset không đặt lại Digital/Offset và không clear `foldPattern` cũ nếu preset không có;
  đồng thời chỉ set `gripperMargin` khi truthy: `ImposerDashboard.tsx:1191-1205`.

**Tác động:** cùng một preset có thể chạy theo Digital hoặc Offset tùy state trước đó; preset
gutter=0/gripper=0 không xóa được giá trị cũ; tách bìa và vị trí blank không được tái lập.

### §B.2 — Mất regression test của ba kiểu đóng trong worktree hiện tại — P1 / S

**Bằng chứng:**

- `git diff` cho thấy các nhóm test `VirtualMap — Saddle`, `Thread`, `Cut Stacks` đã bị xóa khỏi
  `desktop/src/lib/imposerEngine/__tests__/VirtualMap.test.ts`.
- File hiện vẫn ghi “Tests ... all 4 binding modes” nhưng thực tế chỉ có test map cho
  `continuous`, `flush_mount` và vài ca blank của saddle (`VirtualMap.test.ts:2-8,36-159`).
- Không còn test trực tiếp cho quy tắc cặp saddle 8/28p, reset signature thread, merge dư 4p,
  hay page coverage của cut-stacks.

**Tác động:** 52 test liên quan vẫn xanh nhưng không chứng minh ba bất biến page-order quan trọng.
Đây là proof gap, đặc biệt nguy hiểm đúng lúc `VirtualMap` đang được sửa.

### §C.1 — Engine có thể vượt số trang/tay sách người dùng nhập — P1 / S

**Bằng chứng:**

- UI gọi trường này là “Số trang mỗi tép/tay sách”: `BookletSettingsSection.tsx:63-81`.
- Nhánh thread tự gộp phần dư 4p vào tay trước, làm `currentSigPageCount` lớn hơn `foliosize`:
  `VirtualMap.ts:171-180`; chỉ báo trong report sau đó ở `:208-215`.

**Ca:** 20 trang, `foliosize=16` cho ra một tay 20p; 8 trang, `foliosize=4` cho ra một tay 8p.
Nếu giá trị nhập là giới hạn máy gấp/khâu hoặc giới hạn theo độ dày giấy, đây là vi phạm trực tiếp.

**Quyết định cần chốt:** hoặc bỏ tự gộp, hoặc đổi nhãn thành “mục tiêu/tối đa mềm” và bắt người
dùng xác nhận trước khi xuất tay vượt giá trị.

### §C.2 — Nhãn “1 cuốn/tờ” không đúng với `continuous` hiện tại — P2 / S

- UI mô tả `100/fit` là “1 cuốn/tờ”: `BookletSettingsSection.tsx:128-136`.
- Worktree mới tạo `[N,N]` ở mặt trước và `[N+1,N+1]` ở mặt sau, tức sau xén có hai bản giống
  nhau: `VirtualMap.ts:111-129`.

Đây có thể là thay đổi nghiệp vụ có chủ đích, nhưng copy và báo cáo sản lượng phải đổi theo.

### §C.3 — Mojibake trong test đang chỉnh dở — P2 / S

`VirtualMap.test.ts` hiện chứa chuỗi/comment kiểu `gÃ¡y`, `KhÃ¢u chá»‰`, trái quy ước tiếng Việt
của dự án. Diff cho thấy lỗi mã hóa xuất hiện cùng thay đổi chưa commit. Không ảnh hưởng runtime,
nhưng nên sửa trước khi commit để tránh lan sang snapshot/report.

## 4. Kết quả kiểm chứng đã chạy

| Kiểm chứng | Kết quả |
|---|---|
| Vitest: `VirtualMap.test.ts`, `InstructionSerializer.phase2.test.ts`, `CatalogPlanner.test.ts` | **52 passed** |
| Pytest: `test_plan_executor.py`, `test_booklet_scheduler.py` | **11 passed**, 2 warning deprecation |
| Kiểm tra tĩnh call-site `generateBindingMap` | Xác nhận production call-site lệch tại Confirm/Flipbook |
| Đối chiếu test với `git diff` | Xác nhận mất nhóm test saddle/thread/cut_stacks trong worktree |

Không chạy cập nhật snapshot/golden. Không sửa code sản phẩm.

## 5. Khoảng trống kiểm chứng còn lại

1. Chưa có test ma trận `5 binding × 4 scale mode × page count biên` ở API planner.
2. Chưa có golden raster end-to-end từ PDF đánh số trang → plan TS → backend → đọc lại thứ tự
   thành phẩm cho từng tổ hợp.
3. Chưa có test parity giữa Confirm dialog, Flipbook, SheetViewer và output.
4. Chưa có test loại/màu dấu giữa theo binding ở cả đường 1-up và phase-2.
5. Fold pattern 16p đã có kiểm placement/xoay, nhưng comment trong code vẫn ghi chưa xác minh
   backup registration bằng gấp mẫu/xưởng (`FoldPatterns.ts:140-144`).
6. Offset hiện bị ẩn nên chưa có runtime click-through trên UI thật.
7. Chưa nghiệm thu vật lý tách bìa raw-page, work-and-turn/tumble và collation mark trên máy in.

## 6. Đề xuất lô sửa sau khi duyệt

Mỗi lô tối đa 5 file, verify xong mới sang lô kế.

### Lô 1 — Chặn sai output trực tiếp

- Chặn/validate `flush_mount + cut_stack`.
- Sửa loại/màu dấu giữa cho binding không gấp.
- Test serializer + PlanExecutor hẹp cho hai lỗi trên.

### Lô 2 — Đồng bộ padding và preview

- Tạo một helper duy nhất xác định modulus/padding theo `bindingMode + scaleMode`.
- Dùng chung tại `VirtualMap`, Confirm dialog, Flipbook và SheetViewer.
- Khôi phục/bổ sung test saddle/thread/cut-stacks và thêm continuous bội 2/bội 4.

### Lô 3 — Quy tắc tay sách

- Đặt blank theo từng signature của thread.
- Chốt nghiệp vụ merge dư 4p; thêm xác nhận nếu được phép vượt `foliosize`.
- Thêm matrix page-count 1/2/4/6/8/16/20/34/36/78/80.

### Lô 4 — Preset và compatibility

- Version schema preset; lưu/restore đủ Digital/Offset, cover, gutter, blank, catalog.
- Normalize/clear field không hợp lệ khi load preset cũ.
- Khai báo compatibility table cho Auto Catalog; chặn mode không hỗ trợ trước khi bật Offset.

### Lô 5 — Golden E2E và nghiệm thu xưởng

- PDF fixture đánh số/màu từng trang; raster/đọc text output cho các tổ hợp hỗ trợ.
- Đối chiếu preview ↔ output.
- In/gấp/xén mẫu 4p, 8p, 16p; ký xác nhận work style, backup registration, bìa và collation.

## 7. Chốt duyệt cần từ chủ dự án

Trước khi sửa, cần xác nhận ba quyết định nghiệp vụ:

1. `continuous` 100%/Fit là **1 bản** hay mặc định **2 bản sau xén**?
2. `foliosize` là giới hạn cứng hay engine được phép tự gộp tay 4p để vượt giới hạn?
3. “Tách bìa riêng” phải xuất bìa nguyên trang để xử lý tiếp, hay phải bình thành spread/wrap-cover
   sẵn sàng in?

---

**Trạng thái audit:** hoàn tất giai đoạn khảo sát và báo cáo. Theo quy trình hai chốt, dừng tại đây

## Trạng thái thực thi sau duyệt

- §A.1: đã chặn flush_mount + cut_stack ở UI, state và engine.
- §A.2/§C.2: đã đưa continuous một-cuốn/tờ về map tuần tự bội 4; giữ nhánh ghép
  nửa cuốn riêng cho Cut & Stack.
- §A.4: đã phân biệt nếp gấp đỏ và đường xẻ đen theo kiểu đóng.
- §B.1: preset In nhanh đã lưu/khôi phục lề gáy và vị trí trang trắng.
- §B.2: đã khôi phục regression test page-order cho saddle/thread/cut-stacks.

Nhật ký kiểm chứng chi tiết:
docs/BINH_SACH_TAP_CHI_FIXES_2026-07-31.md.
để chờ duyệt; chưa thực hiện lô sửa nào.
