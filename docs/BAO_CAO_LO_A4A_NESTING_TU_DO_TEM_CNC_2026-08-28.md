# BÁO CÁO LÔ A4a — MỘT NGUỒN CHÂN LÝ CHO NHÃN CHIẾN LƯỢC XẾP

**Ngày:** 2026-08-28
**Chặng:** A — lô thứ năm
**Quyết định của chủ dự án:** phương án **(a)** — đồng bộ về enum Rust, `ts-rs` là nguồn duy nhất
**Trạng thái:** **PASS** — chờ duyệt

---

## 1. Mã lô và mục tiêu

Đóng phần đầu của **C0-3**: thêm `true_shape_nesting` vào `GridStrategy` và loại bỏ việc **viết tay song song** tập nhãn ở phía TypeScript.

Trước lô này, tập nhãn chiến lược tồn tại ở **hai hợp đồng song song**:

- enum Rust `imposition_core/src/model.rs` → `ts-rs` sinh `generated/GridStrategy.ts`;
- **6 union chuỗi viết tay** trong **5 file** TS, không liên quan gì tới bản sinh.

Thêm một giá trị phải sửa đủ 7 chỗ. Quên một chỗ thì lệch hợp đồng **im lặng**.

---

## 2. Phạm vi thật đã đo, và vì sao tách lô

Trước khi sửa, tôi đếm chính xác thay vì ước lượng:

| Nhóm | Số lượng | Nơi |
|---|---:|---|
| Union chuỗi viết tay | 6 chỗ / 5 file | `types.ts`, `presetManager.ts`, `SettingsTypes.ts` (×2), `NupRenderer.ts`, `NupGridSolver.ts` |
| Backend đọc `gridStrategy` dạng chuỗi | 7 chỗ / 2 file | `cnc_render.py:357`, `nup_engine.py` (6 chỗ) |
| Callsite dựng payload | 3 | submit, preview, preview-batch |
| Nơi persist dữ liệu người dùng | 2 | preset đã lưu, store persist (đã có migration v11) |

Phương án (a) như phát biểu có **hai nửa tách rời được**, và tôi phải nói rõ để không nhận công quá phần đã làm:

- **Nửa 1 — một nguồn cho tập NHÃN.** Suy union TS từ bản `ts-rs` sinh ra. Không đổi wire format, không chạm dữ liệu đã lưu. **Đây là nội dung lô A4a.**
- **Nửa 2 — đổi wire format sang tagged `{kind}`.** Chạm preset đã lưu của người dùng, store persist, 7 chỗ đọc ở backend và cả 3 callsite payload. **Chưa làm**, là lô riêng — xem §8.

Nửa 1 mang lại đúng cái (a) nhắm tới (ts-rs authoritative, hết danh sách viết tay) với rủi ro gần bằng không. Nửa 2 là phần đắt và **không cần** cho Chặng A.

---

## 3. File đã đổi — chính xác 7 file, tách làm hai bước

### Bước A4a-1 (2 file) — nguồn chân lý nhận giá trị mới

| File | Thay đổi |
|---|---|
| `imposition_core/src/model.rs` | thêm variant `TrueShapeNesting` (+10 dòng gồm doc) |
| `desktop/src/components/imposition-tools/generated/GridStrategy.ts` | **sinh lại** bằng `ts-rs`, diff đúng **1 dòng** |

Bản sinh không được sửa tay. Lệnh dùng đúng như `generated/README.md`:

```powershell
cd imposition_core
$env:TS_RS_EXPORT_DIR = "../desktop/src/components/imposition-tools"
cargo test --features ts-export
```

Đã kiểm: **chỉ** `GridStrategy.ts` thay đổi trong `generated/`, không có file nào khác bị regenerate lệch.

### Bước A4a-2 (5 file) — xoá 6 union viết tay

| File | Thay đổi |
|---|---|
| `desktop/src/components/imposition-tools/types.ts` | thêm `export type GridStrategyKind = CoreGridStrategy['kind']`; dùng nó cho `gridStrategy` |
| `desktop/src/lib/presetManager.ts` | dùng `GridStrategyKind` |
| `desktop/src/lib/imposerEngine/SettingsTypes.ts` | dùng `GridStrategyKind` (2 chỗ) |
| `desktop/src/lib/imposerEngine/NupRenderer.ts` | dùng `GridStrategyKind` |
| `desktop/src/lib/imposerEngine/NupGridSolver.ts` | dùng `GridStrategyKind` + **guard chặn** `true_shape_nesting` |

Sau lô này, `rg "'manual' \| 'simple_auto'"` trong `desktop/src` cho **0 kết quả**.

---

## 4. Một chi tiết dễ mắc bẫy

`types.ts` dùng `export type { ... } from './generated'` — đó là **re-export**, nên các tên đó **không nằm trong scope cục bộ**. Lần đầu tôi viết `GridStrategy['kind']` và `tsc` báo `TS2304: Cannot find name 'GridStrategy'`. Phải thêm một `import type` riêng. Ghi lại vì đây là lỗi dễ lặp khi suy kiểu từ một file toàn re-export.

## 5. Guard chặn ở solver lưới — chỗ quan trọng nhất của lô

`true_shape_nesting` **không phải** chiến lược lưới: nó đi kernel `mixed_nesting` và nhận hình học từ Placement Manifest. Nếu để nó rơi vào `solveOptimalNupLayout`, người dùng chọn option mới nhưng **nhận lưới cũ mà không có dấu hiệu nào** — đúng loại lỗi mà báo cáo Lô 0 đã cảnh báo khi phân tích phạm vi hiển thị option.

`solveOptimalNupLayout` so sánh bằng `===` chứ không `switch` với `never`, nên nới union **không** làm TS báo lỗi thiếu nhánh. Vì vậy phải chặn tường minh:

```ts
if (strategy === 'true_shape_nesting') {
    throw new Error(
        'true_shape_nesting không đi qua solver lưới; phải gọi đường nesting theo đường bế.',
    );
}
```

Chặn ồn ào thay vì fallback im lặng. Hiện chưa đường nào sinh ra giá trị này (UI chưa hiện option — đó là lô A4a-3), nên guard là lưới an toàn cho lô nối UI.

---

## 6. Lệnh test và kết quả

| Phạm vi | Kết quả |
|---|---|
| `cargo test --features ts-export` (regenerate) | toàn bộ pass, sinh lại đúng 1 file |
| `cargo test --manifest-path imposition_core/Cargo.toml -q` | **292 passed, 0 failed** |
| `npm.cmd run typecheck` | **exit 0** |
| `npx.cmd vitest run` phạm vi imposition-tools + imposerEngine + mixed-nesting + stores | **45 file, 591 passed** |
| backend pytest (writer + lifecycle, không chạm nhưng xác nhận) | **187 passed** |

### 6.1. Mutation test — chứng minh wiring là thật

Bỏ variant khỏi **bản sinh** rồi typecheck:

```
src/lib/imposerEngine/NupGridSolver.ts(1031,9): error TS2367: This comparison appears to be
unintentional because the types '"manual" | "simple_auto" | "optimal_auto" | "staggered" |
"row_alt" | "head_to_tail"' and '"true_shape_nesting"' have no overlap.
```

Chứng minh hai điều: TS **thật sự suy** từ bản sinh (không phải bản sao viết tay), và nếu ai xoá variant khỏi Rust rồi regenerate thì build **vỡ ồn ào** chứ không âm thầm.

Phục hồi bằng chính đường đúng — regenerate từ Rust — rồi kiểm `git diff --numstat`: bản sinh trở lại đúng `1 1`, `model.rs` là `10 0`. Typecheck xanh lại.

Ghi thêm một lượt mutation **thất bại**: tôi thử regex xoá variant khỏi `model.rs`, regex không khớp (ký tự `§` + line ending) nên file **không đổi**. Đã kiểm `TrueShapeNesting` vẫn ở dòng 97 trước khi đi tiếp. Lượt đó không chứng minh gì.

---

## 7. Một test đỏ KHÔNG thuộc lô này, đã điều tra

`npx vitest run` **toàn bộ** cho:

```
Test Files  1 failed | 295 passed (296)
     Tests  1 failed | 3128 passed | 2 skipped (3131)
FAIL src/components/OutputPreviewLayout.test.tsx > khóa thứ tự section, trạng thái mở và
     nhóm Process/Spot độc lập
```

Điều tra bằng số đo, không suy diễn:

1. File test đó có **0** tham chiếu tới `gridStrategy`, `GridStrategy`, `presetManager`, `SettingsTypes`, `NupGridSolver`, `NupRenderer`.
2. File **không** bị sửa: `git status` sạch, mtime 22/08/2026 — 6 ngày trước.
3. Chạy **riêng** file đó: **2 passed**. Chỉ đỏ trong lượt full, và đỏ **tất định** ở cả hai lượt full.

> **ĐÍNH CHÍNH (thêm sau, lô F1):** tôi đã đoán sai nguyên nhân ở đây. Không phải "nhiễu thứ tự/ô nhiễm state". Lỗi thật là **`Test timed out in 5000ms`** — test render cả Output Preview rồi thao tác ~40 bước, chạy riêng mất ~2,7s nhưng trong lượt full 297 file song song thì tranh CPU đẩy nó vượt trần 5s mặc định. Đã đóng ở lô F1 bằng cách nới trần cho đúng test đó. Bài học: tôi kết luận "ô nhiễm state" mà **chưa đọc thông điệp lỗi** — đúng loại suy diễn mà `prynx-task-loop` cấm.
4. Toàn bộ thay đổi của tôi ở 4/5 file là **type-only**. Thay đổi runtime duy nhất là guard chỉ chạy khi `strategy === 'true_shape_nesting'`, và **đếm được 0 test** trong `desktop/src` dùng giá trị đó ⇒ guard **không thể** chạy trong vitest.

Kết luận: **không do lô A4a.**

Điều tôi **chưa chứng minh được**: liệu lỗi này đã có trước hôm nay hay không. Trong phiên này tôi chỉ chạy vitest phạm vi hẹp (mixed-nesting), chưa từng chạy full trước lô A4a, nên **không có baseline** để so. Không dùng `git stash`/`checkout` để dựng baseline vì quy tắc dự án cấm hoàn tác bằng lệnh đó và index đang có entry intent-to-add.

Đề nghị: coi đây là finding A4a-1, cần một lượt `npx vitest run` trên bản `HEAD` sạch để xác định có phải hồi quy của phiên khác hôm nay hay không.

---

## 8. Finding

| Mã | Phát hiện | Mức | Thuộc lô |
|---|---|---:|---|
| A4a-1 | ~~`OutputPreviewLayout.test.tsx` đỏ do ô nhiễm state~~ → **CHẨN ĐOÁN SAI**. Lỗi thật là timeout 5000ms dưới tranh CPU. **ĐÃ ĐÓNG ở lô F1** | P2 → đóng | F1 |
| A4a-2 | Nửa 2 của phương án (a) chưa làm: wire format vẫn là chuỗi thuần, chưa phải tagged `{kind}`. Chạm preset đã lưu + store persist + 7 chỗ backend + 3 callsite payload | P3 (nợ kỹ thuật) | lô riêng sau Cổng A |
| A3-1 | `cutStyle.stroke` thiếu alternate cho separation | P2 | lô contract sau |
| A2-1 | `cnc_render.py:360` còn nén `gap = max(gap_x, gap_y)` | P2 | lô nối route |
| C0-6 | Kernel chưa nhận worker/RAM grant | P2 | Chặng B |
| C0-7 | Ngân sách work dùng chung cả run | `[SUSPECTED]` | Chặng B, đo trước |
| A1-1 | `imposition_pdf_form.py.rej` an toàn để xoá | P3 | dọn scratch |
| A1-2 | Toàn suite pytest có thể crash native trong PDFium | P2, `[SUSPECTED]` | đợt `pdfium_guard()` |

**C0-3 đóng một nửa:** giá trị đã có ở nguồn chân lý và mọi union viết tay đã bị xoá. Nửa còn lại là hiển thị option trên UI — lô A4a-3.

---

## 9. Kết luận

**PASS.**

- `true_shape_nesting` đã nằm ở nguồn chân lý duy nhất; bản TS sinh lại bằng đúng lệnh tài liệu, diff 1 dòng.
- 6 union chuỗi viết tay ở 5 file đã bị xoá, thay bằng type suy từ bản sinh. `rg` cho 0 kết quả.
- Guard chặn `true_shape_nesting` khỏi solver lưới — không có đường nào "chọn option mới, nhận lưới cũ".
- Mutation test chứng minh wiring là thật, không phải bản sao trùng khớp tình cờ.
- Nói rõ đã làm nửa nào của phương án (a) và nửa nào chưa, kèm đủ số đo phạm vi cho lô sau.
- Một test đỏ ngoài phạm vi đã được điều tra và loại trừ bằng số đo, kèm ghi rõ điều chưa chứng minh được.

---

## 10. Lô tiếp theo — A4a-3

Hiện option chưa xuất hiện trên UI nên chưa có gì thay đổi với người dùng.

**Lô A4a-3 (≤5 file):** thêm option vào dropdown "Cách xếp" trong `GridSettingsSection`, chỉ hiện khi `taskMode = nup` của `sticker_imposer`/`cnc_imposer` và dưới **internal flag**; cập nhật store slice nếu cần; thêm test visibility gồm cả ca âm (không hiện ở S&R, không hiện ở công cụ khác, không hiện khi flag tắt). Không đổi default, không thêm ô nhập góc.

Sau đó **A4b** nối `processHandlers`/`GridPreview`/`ImposerDashboard`/route, rồi mới tới Cổng Chặng A.

Trước khi vào A4a-3, xin xác nhận: dùng cơ chế flag nào cho internal? Hiện `mixed-nesting` dùng `import.meta.env.DEV || VITE_MIXED_NESTING_ENABLED` (`lib/mixed-nesting/rollout.ts`). Tôi đề xuất thêm một cờ **riêng** `VITE_TRUE_SHAPE_NESTING_ENABLED` theo cùng khuôn, để bật/tắt độc lập với công cụ Mixed Nesting standalone — nếu dùng chung cờ thì không tách được hai đường khi cần kill switch.
