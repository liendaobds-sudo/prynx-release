# BÁO CÁO LÔ A3 — WRITER PDF PRODUCTION VÀ BẰNG CHỨNG ARTIFACT

**Ngày:** 2026-08-28
**Chặng:** A — lô thứ tư
**Baseline:** HEAD `8bc0a21`
**Trạng thái:** **PASS** — lần đầu đường production đạt mức bằng chứng `ARTIFACT`

---

## 1. Mã lô và mục tiêu

Đóng **C0-2**: `backend/app/workers/nesting_imposition_render.py` từ stub 87 byte thành writer thật. Writer phải render source pin + placement manifest, **không được solve**, và kết quả phải được kiểm bằng parse/raster **PDF thật**.

Chốt phạm vi đã hỏi ở cuối báo cáo A2 và không có ý khác: trang CUT theo `marks.cut.separatePage` thông qua `outputSides` — writer đi theo `outputSides` như bundle đã suy.

---

## 2. File đã đổi — chính xác 2 file

| File | Loại | Trước | Sau |
|---|---|---:|---:|
| `backend/app/workers/nesting_imposition_render.py` | WIP untracked | **87 B** (một dòng docstring) | **20.285 B** |
| `backend/tests/test_nesting_imposition_render.py` | **mới** | — | 20 test artifact |

Không chạm adapter, bundle, store, orchestrator, route, UI, Rust. Không cập nhật golden. Không stage, không commit.

Writer tái dùng toàn bộ primitive đã có thay vì dựng đường song song: `resolve_manifest_artwork_placement`, `render_manifest_artwork`, `paint_manifest_page_form`, `transform_manifest_polygon_rings`, `Affine2D`. Không thêm phép biến đổi hình học mới nào.

---

## 3. Bất biến đã đóng

### 3.1. Ba bất biến gốc của writer

1. **Không solve lại.** Không có đường nào trong module gọi kernel hay tính lại pose. Sai số duy nhất được phép là phép đổi mm → PDF unit. Có test chứng minh render hai lần cho **content stream byte-identical**, và manifest của caller **không bị mutate**.
2. **Fail-closed trước khi ghi byte đầu tiên.** 11 ca từ chối, mỗi ca đều assert `not output.exists()`.
3. **Thứ tự trang xác định.** Sheet tăng dần, trong mỗi sheet đi theo đúng `outputSides`. Cùng manifest ⇒ cùng thứ tự trang.

### 3.2. Phân vai artwork và CUT — hai tập ring khác nhau

Đây là chỗ hai quyết định của cổng Chặng 0 gặp nhau trên cùng một tờ:

| Lớp | Tập ring | Toán tử | Vùng lỗ / cửa sổ |
|---|---|---|---|
| `front` / `back` — artwork | **chỉ vòng ngoài** | `W n` clip + `Do` | **có mực** |
| `cut` — vector dao | **outer + holes** | `m`/`l`/`h` + `S` | **có nét dao** |

Nói gọn: mực vẫn in dưới cửa sổ, và dao vẫn cắt cửa sổ. Đúng thói quen xưởng, và giờ đã được đo trên file thật (§4.3).

Writer dùng **chính** seam `resolve_manifest_artwork_placement` cho cả trang CUT, để không có đường thứ hai đọc pose: mọi kiểm identity (`sourceRevision`, `partId`, page binding) áp cho CUT y như artwork.

### 3.3. Trang CUT là stroke, không phải fill

Nét bế được vẽ thành subpath kín rồi **một** lệnh `S` cho cả cụm. Có test chặn `f`/`f*` xuất hiện trên trang CUT — fill sẽ bít mất hình. Trang CUT cũng không được nhúng Form artwork nào: test kiểm `/XObject` **không** có trong `/Resources` của trang CUT và `Do` không xuất hiện trong stream.

### 3.4. Overprint đi qua ExtGState thật

`cutStyle.stroke.overprint = true` sinh `/ExtGState` với `/OP true`, `/op true`, `/OPM 1` rồi phát `gs`. Test đọc thẳng object trong PDF đã ghi, không chỉ tìm chuỗi.

### 3.5. Cổng fail-closed đầy đủ

| Ca | Hành vi |
|---|---|
| `status` khác `completed` | từ chối, nêu trạng thái thật |
| `validation.valid` khác `true` | từ chối |
| còn `unplaced` | từ chối — manifest hợp lệ mà thiếu hàng thì artifact "trông như đủ" là nguy hiểm hơn cả lỗi |
| `placements` rỗng | từ chối |
| `sourceRevision` lệch `renderBundleHash` | từ chối, nói rõ bản mẫu đã đổi sau khi tính |
| `sheetIndex` không liên tục từ 0 | từ chối |
| `stats.sheetCount` / `stats.placedCount` lệch placements | từ chối |
| thiếu snapshot nguồn cho một locator | từ chối, liệt kê locator thiếu |
| `cutStyle.stroke.colorSpace = separation` | từ chối có lý do — xem finding A3-1 |

---

## 4. Lệnh test và kết quả

### 4.1. Test của lô

```powershell
backend\venv\Scripts\python.exe -m pytest backend/tests/test_nesting_imposition_render.py -q
```

```
20 passed, 1 warning in 1.87s
```

### 4.2. Bộ verify bắt buộc (10 file)

```
427 passed, 1 warning in 13.53s
```

A2 để lại 407; chênh **+20** đúng bằng số test mới.

### 4.3. Số đo raster trên PDF thật — bằng chứng ARTIFACT

Đây là phần đáng giá nhất của lô. Dựng trang nguồn **phủ kín mực** 40×40mm, khuôn 30×30mm có cửa sổ 10×10mm, pose `(20, 20)` với `referencePoint` = centroid `(15,15)` ⇒ khuôn phủ `[5..35]²`, cửa sổ phủ `[15..25]²`, trang nguồn phủ `[5..45]²`.

**Trang artwork (front):**

| Điểm mm | gray | Ý nghĩa |
|---|---:|---|
| (8, 8) | **0** | trong khuôn, ngoài cửa sổ → có mực |
| (34, 34) | **0** | sát biên khuôn phía trong → có mực |
| (20, 20) | **0** | **trong cửa sổ → CÓ MỰC** (quyết định §7.2) |
| (36, 36) | **255** | **ngoài khuôn nhưng VẪN TRONG phạm vi trang nguồn kín mực** |
| (38, 38) | 255 | ngoài khuôn |
| (2, 2) | 255 | ngoài khuôn |

Điểm `(36, 36)` là phép đo quyết định: nó nằm ngoài khuôn nhưng trong vùng nguồn còn mực, nên trắng ở đây chứng minh **clip thật sự chặn**, không phải nhờ nguồn hết mực. Không có điểm này thì test vẫn xanh dù clip bị vô hiệu.

**Trang CUT:**

| Điểm mm | gray | Ý nghĩa |
|---|---:|---|
| (5, 20) | **88** | biên ngoài trái → có nét dao |
| (35, 20) | **88** | biên ngoài phải → có nét dao |
| (15, 20) | **88** | **biên cửa sổ trái → dao CẮT cửa sổ** |
| (25, 20) | **88** | **biên cửa sổ phải → dao CẮT cửa sổ** |
| (20, 20) | 255 | giữa cửa sổ → không nét, tức chỉ stroke không fill |
| (10, 20) | 255 | giữa vật liệu → không nét lạ |

### 4.4. Mutation test — ba lượt

Test artifact rất dễ xanh vô nghĩa (chỉ cần probe sai chỗ), nên tôi chứng minh chúng bắt lỗi thật.

| Mutation | Kết quả |
|---|---|
| CUT chỉ vẽ vòng ngoài (`rings[:1]`) — dao không cắt cửa sổ | **2 failed** (`test_trang_cut_co_du_vong_ngoai_va_vong_lo`, `test_cut_theo_dung_pose_cua_tung_instance`) |
| Đảo thứ tự side (`reversed(sides)`) | **7 failed** — cấu trúc, hình học và resource đều bắt được |
| Thêm vòng lặp no-op (mutation không hiệu lực) | 20 passed — ghi lại để nói rõ lượt này **không** chứng minh gì |

Đã hoàn nguyên sau từng lượt, chạy lại: 20 passed.

### 4.5. Toàn bộ backend

```
4218 passed, 19 skipped, 3 warnings in 423.59s (0:07:03)
```

A2 để lại 4195, nên tôi dự kiến 4215. Thực đo **4218**, lệch +3. Đã truy nguyên thay vì bỏ qua:

- `backend/tests/test_office_convert_engine.py` được **phiên khác** sửa lúc 20:17 trong lúc tôi đang làm A3.
- Đếm hàm test: bản `HEAD` có **16**, bản worktree có **19** → đúng **+3** không thuộc lô này.

Vậy 4195 + 20 (của lô A3) + 3 (của phiên khác) = **4218**. Khớp hết, không có test nào biến mất.

Ghi lại một việc đã làm với git để minh bạch: để đếm tách bạch, tôi thử `git stash push` riêng file đó. Lệnh **thất bại** vì trong index có entry intent-to-add (`imposition_pdf_form.py`), nên không có gì được stash. Đã kiểm ngay sau đó: `git stash list` rỗng, thay đổi `W n` còn nguyên, writer vẫn 20.285 B, file kia vẫn ở trạng thái ` M`. Cách đếm cuối cùng dùng `git show HEAD:<file>` — chỉ đọc, không chạm worktree.

### 4.6. Tĩnh

`py_compile` 2 file: exit 0. `git diff --check`: exit 0.

### 4.7. Mức bằng chứng — lần đầu đạt ARTIFACT

| Hạng mục | Trước A3 | Sau A3 |
|---|---|---|
| Writer production tạo PDF | `UNKNOWN` (stub 87 B) | **`ARTIFACT`** — parse content stream + raster, đo pixel |
| Hình học artwork theo pose | `UNKNOWN` | **`ARTIFACT`** |
| CUT giữ cửa sổ | `AUTO` | **`ARTIFACT`** |
| Thứ tự trang, khổ trang, số trang | `UNKNOWN` | **`ARTIFACT`** |
| Preview ↔ export cùng manifest | `UNKNOWN` | **vẫn `UNKNOWN`** — chưa có preview trên đường này |
| Tauri end-to-end | `UNKNOWN` | **vẫn `UNKNOWN`** — chưa nối UI |

Nói đúng phạm vi: `ARTIFACT` đạt cho **writer**, chưa đạt cho **luồng người dùng**. Vẫn chưa được báo `RUNTIME`.

---

## 5. So sánh baseline solver

Không đổi solver. `placedCount`, `sheetCount`, compactness, runtime, RAM không đổi. Writer chỉ tiêu thụ manifest.

---

## 6. Finding

### 6.1. Mới: A3-1 — hợp đồng `cutStyle` thiếu alternate colorspace cho separation

`RenderCutStrokeV2` cho phép `colorSpace = "separation"` với `components = [tint]` và `separationName`, nhưng **không mang alternate colorspace/color**. PDF yêu cầu `/Separation` phải khai `[/Separation /Name <alternate space> <tint transform>]`, nên writer **không dựng nổi** colorspace hợp lệ từ dữ liệu hiện có.

Xử lý: writer **fail-closed** với thông điệp nói rõ lý do và cách đi tiếp, thay vì bịa một alternate rồi in sai màu. Có test khoá hành vi này.

Đây là khoảng trống **hợp đồng**, do chính lô A1 tạo ra khi thêm `cutStyle`. Ghi nhận thẳng: tôi thiết kế thiếu một trường. Cách sửa đề xuất cho lô sau: thêm `alternate: {space: "cmyk"|"rgb"|"gray", components: [...]}` vào `RenderCutStrokeV2` khi `colorSpace = separation`, rồi writer dựng function type 2 từ tint 0 → 0 và tint 1 → alternate. Mức P2: mặc định `cmyk` đang chạy tốt và chưa có callsite nào dùng separation.

| Mã | Phát hiện | Mức | Thuộc lô |
|---|---|---:|---|
| A3-1 | `cutStyle.stroke` thiếu alternate cho separation; writer fail-closed | P2 | lô contract sau |

### 6.2. Đã đóng trong lô

| Mã | Trạng thái |
|---|---|
| C0-2 | **ĐÓNG** — writer từ stub 87 B thành 20.285 B, có 20 test artifact |

### 6.3. Còn mở

| Mã | Phát hiện | Mức | Thuộc lô |
|---|---|---:|---|
| C0-3 | `GridStrategy` chưa có `true_shape_nesting` ở cả ba nơi | P1 | A4a |
| A2-1 | Nhánh CNC legacy còn nén `gap = max(gap_x, gap_y)` (`cnc_render.py:360`) | P2 | lô nối route |
| A3-1 | Separation thiếu alternate | P2 | lô contract sau |
| C0-6 | Kernel chưa nhận worker/RAM grant | P2 | Chặng B |
| C0-7 | Ngân sách work dùng chung cả run | `[SUSPECTED]` | Chặng B, đo trước |
| A1-1 | `imposition_pdf_form.py.rej` — an toàn để xoá | P3 | dọn scratch |
| A1-2 | Toàn suite có thể crash native trong PDFium | P2, `[SUSPECTED]` | đợt `pdfium_guard()` |

Lượt toàn suite của A3 **không** gặp lại crash A1-2 (lượt sạch thứ năm trên sáu).

---

## 7. Kết luận

**PASS.**

- Writer production đã có thật, tái dùng primitive sẵn có, không thêm phép biến đổi hình học nào.
- Lần đầu trong đợt nesting có bằng chứng **`ARTIFACT`** cho đường production: parse content stream và đo pixel trên PDF thật.
- Hai quyết định của cổng Chặng 0 giờ đều được chứng minh trên cùng một tờ: mực in trong cửa sổ, dao cắt cửa sổ.
- Ba lượt mutation test chứng minh test bắt lỗi, kèm ghi rõ một lượt mutation **không** hiệu lực để không nhận công sai.
- Tự phát hiện và ghi lại một lỗ hợp đồng do chính lô A1 của mình tạo ra (A3-1), xử lý fail-closed chứ không bịa dữ liệu.
- Không hồi quy: bộ bắt buộc 427 passed; toàn backend 4218 passed / 0 failed, và +3 test ngoài dự kiến đã được truy nguyên về phiên khác chứ không đoán.

---

## 8. Lô tiếp theo

Còn hai việc trước Cổng Chặng A, và một điểm cần bạn quyết.

**Lô A4a — types/enum/store/UI visibility (≤5 file).** Thêm `true_shape_nesting` vào `GridStrategy`: enum Rust `imposition_core/src/model.rs`, bản `ts-rs` sinh ra, union chuỗi thủ công trong `imposition-tools/types.ts`, và `GridSettingsSection` chỉ hiện option khi `taskMode=nup` của Tem/CNC dưới internal flag. Kèm quyết định C0-3: đồng bộ enum Rust hay giữ tách và ghi lý do.

**Lô A4b — processHandlers/GridPreview/ImposerDashboard/route + test API (≤5 file).**

**Điểm cần bạn quyết trước A4a:** `GridStrategy` hiện có **hai hợp đồng song song** — enum Rust qua `ts-rs` (6 biến thể, dạng tagged `{kind}`) và union chuỗi thủ công trong `types.ts` (6 giá trị, chuỗi thuần), trong khi UI chỉ hiện 3 option. Đường sản xuất tem/CNC đọc `settings.get('gridStrategy')` dạng chuỗi thuần. Hai lựa chọn:

- **(a) Đồng bộ về enum Rust**, để `ts-rs` là nguồn duy nhất. Sạch về lâu dài, nhưng phải sửa mọi callsite đang đọc chuỗi thuần và đổi payload của cả ba callsite submit/preview/preview-batch.
- **(b) Giữ tách, chỉ thêm giá trị vào union chuỗi**, và ghi rõ trong code vì sao hai hợp đồng cùng tồn tại. Rủi ro thấp cho Chặng A, nhưng nợ kỹ thuật vẫn đó.

Tôi nghiêng về **(b) cho Chặng A** vì canary không nên gánh một đợt refactor payload xuyên ba callsite, rồi đưa (a) thành lô riêng sau Cổng A. Nhưng đây là đánh đổi nợ kỹ thuật nên cần bạn chốt.
