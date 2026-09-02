# Báo cáo Lô A4b-4 — Nối pipeline nesting vào đường chạy N-Up thật

Ngày: 2026-08-28. Nhánh `codex/pre-release-audit-2026-08-04`. Máy Windows thật, `D:\pdfcompare`.
Đóng một nửa finding **A4b-3c** (nhánh EXECUTE). Nửa còn lại (PREVIEW) thành finding mới **A4b-4a**,
cần chủ dự án quyết.

## 1. Trạng thái trước lô

`nesting_production_pipeline` **không có caller production nào** — chỉ test dùng. Nhưng UI thì đã
mở: `GridSettingsSection.tsx:527` render `<option value="true_shape_nesting">` khi cờ cho phép, và
`processHandlers.ts:288` truyền thẳng `settings.gridStrategy` xuống `/nup-start`.

Nghĩa là **trước lô này, chọn "Nesting tối ưu theo đường bế" cho ra lưới grid, không một dấu hiệu**.
Đã xác minh đường rơi: chuỗi dispatch strategy trong
`sticker_imposer_pkg/orchestrator.py` kết thúc bằng `else:  # grid` (dòng 460), nên strategy lạ
rơi vào nhánh grid thay vì báo lỗi.

## 2. Điểm nối và lý do chọn

Chèn vào `_run_nup_engine_impl`, **trước** nhánh CNC:

```
run_nup_engine → _run_nup_engine_impl
  ├─ gridStrategy == 'true_shape_nesting' → nup_true_shape_nesting   (MỚI)
  ├─ imposerMode == 'cnc'                → run_cnc_two_sided
  └─ còn lại                             → lưới grid như cũ
```

Ba lý do:

- **Cùng cấp trừu tượng.** `run_production_nesting_job` là writer artifact hoàn chỉnh, y như
  `run_cnc_two_sided`, chứ không phải bộ trả placement để nhồi vào `solve_optimal_sticker_layout`.
- **Có tiền lệ.** `nup_engine.py:272` là chỗ duy nhất trong repo đổi cả renderer theo `settings`.
  Đi theo tiền lệ đó thay vì tạo cơ chế thứ hai.
- **Phải đứng trước nhánh CNC**, vì cách xếp này phục vụ cả Bình tem bế lẫn Bình CNC. Để sau thì
  job CNC không bao giờ tới được đây. Đã khoá bằng test riêng.

Logic dịch hợp đồng nằm ở module mới `backend/app/workers/nup_true_shape_nesting.py`, không nhồi
thêm vào `nup_engine.py` (đã là god file). `nup_engine.py` chỉ +13 dòng.

## 3. Dịch hợp đồng settings → job

| `settings` (camelCase, mm) | `ProductionNestingJobInput` |
|---|---|
| `sheetWidth` / `sheetHeight` | `sheet_width_mm` / `sheet_height_mm` |
| `marginLeft/Right/Top/Bottom` | `margin_mm` dict |
| `gapX` / `gapY` | `part_gap = AxisGapMm(x, y)` — **hai trục, không nén** |
| `imposerMode == 'cnc'` → `cnc_imposer`, `isDieCutMode` → `sticker_imposer` | `tool` |
| `targetQuantitiesByPage` | một `JobPartInput` mỗi trang có SL > 0 |
| — | `manifest_id` = sha256(job_id, source, khổ tờ, SL)[:32], **tất định** |
| — | `layout_intent`: có SL ⇒ `quantity_fulfillment`, không ⇒ `autofill_single_sheet` |

Bốn quyết định đáng ghi:

- **`manifest_id` tất định** thay vì `uuid4`, để chạy lại cùng job cho cùng ID và `persist` nhận ra
  bản ghi đã công bố thay vì sinh rác.
- **`time_budget_ms=None`** giữ work-plan cố định. Deadline wall-clock sẽ làm tờ bình phụ thuộc tốc
  độ máy, mất tính tái lập.
- **`MAX_SHEETS_CEILING = 200`.** `settings` của UI không có field này; solver cần ngưỡng để dừng.
  Trần theo tổng SL (xấu nhất 1 con/tờ), chặn trên bằng hằng.
- **CNC dò khuôn server-side một lượt** rồi truyền object. Pipeline cấm *resolver* dò lại; ở đường
  chạy này chính engine là job setup nên dò ở đây đúng hợp đồng "dò một lần, truyền object đi".

## 4. Fail-closed — bất biến quan trọng nhất của lô

Người dùng chọn nesting là chọn một cách xếp cụ thể. Không chạy được thì phải **báo lỗi**, tuyệt đối
không lặng lẽ rơi về lưới grid — đó chính là lỗi đang tồn tại trước lô này.

| Nhánh | Xử lý |
|---|---|
| cờ rollout tắt | `ValueError` "chưa được mở trong bản này" |
| công cụ không phải tem bế/CNC | `ValueError` "chỉ dùng cho Bình tem bế và Bình Bế Rớt CNC" |
| `taskMode = step_repeat` | `ValueError` "chưa mở cho Bình trang (S&R)" |
| `page_sheet_mode` | `ValueError` "Bình nguyên tấm decal không dùng…" |
| `layoutType = mixed_guillotine` | `ValueError` "Dàn nhiều kích thước là chế độ cắt xén…" |
| khổ tờ ≤ 0 / không phải số | `ValueError` theo tên field |
| khoảng hở / SL âm | `ValueError` "không được âm" |
| CNC không dò được khuôn, hoặc khuôn không có đường bao | `ValueError` nêu rõ số trang |

Ba guard `taskMode`/`page_sheet_mode`/`mixed_guillotine` giữ đúng ba điều kiện của
`shouldShowTrueShapeNestingOption` phía UI, để preset cũ hoặc payload dựng tay không lách qua cổng
mà UI đang khoá.

## 5. Rác artifact phát hiện khi test — đã sửa

Lượt test đầu **commit 5 manifest vào artifact root DÙNG CHUNG**
(`D:\pdfcompare\mixed_nesting_data\manifests`, cạnh `RESULTS_DIR`), vì
`run_production_nesting_job` mặc định `store=None` → `resolve_artifact_root()`. Đã đo thấy 5 file
`.json` và thư mục hoàn toàn là rác test (mọi file cùng mốc 1:12 AM, không có gì cũ hơn).

Hai việc đã làm:

- `run_true_shape_nesting` nhận thêm `store=None` để caller inject được. Production vẫn dùng kho
  thật; đó là hành vi đúng.
- Fixture test đặt `PRYNX_MIXED_NESTING_DATA_DIR` sang `tmp_path`. Đã xoá rác và xác nhận chạy lại
  file test **không sinh lại** file manifest nào.

Ghi nhận thêm khi truy nguyên: thư mục `mixed_nesting_data/` **rỗng** vẫn được tạo lại, nhưng do
nhóm test **có sẵn** `test_mixed_nesting_*` chứ không phải lô này. Đã khoanh vùng bằng đo:

| Chạy | `mixed_nesting_data` |
|---|---|
| `test_nup_true_shape_nesting_entry.py` (38 test) | không tạo |
| `test_nesting_production_lifecycle` + `_imposition_bundle` (246 test) | không tạo |
| `test_mixed_nesting_export_artifacts` + `_lifecycle` + `_api` (135 test) | **tạo** (0 file bên trong) |

Thư mục rỗng nên không rò manifest; chỉ là nhiễu untracked trong worktree. Ghi thành finding
**A4b-4e** mức P3, không sửa trong lô này vì nằm ngoài phạm vi.

## 6. Phạm vi lô — 3 file

| File | Trạng thái | Thay đổi |
|---|---|---|
| `backend/app/workers/nup_true_shape_nesting.py` | mới | adapter settings→job + fail-closed + report |
| `backend/app/workers/nup_engine.py` | tracked, M | **+13 dòng**, chỉ thêm nhánh định tuyến |
| `backend/tests/test_nup_true_shape_nesting_entry.py` | mới | 38 test |

## 7. Verify

| Bộ | Kết quả |
|---|---|
| **Toàn bộ `backend/tests`** | **4335 passed, 19 skipped, 0 failed**, 487s |
| Số test thu thập | 4354 (= 4335 + 19) |
| Bộ 12 file bắt buộc + 3 file mới của Chặng A | **523 passed** |
| `test_nup_true_shape_nesting_entry.py` riêng | **38 passed** |

Trong 38 test có **5 ca chạy thật end-to-end** (không fake): ghi ra PDF trên đĩa, kiểm số trang,
kiểm chuỗi report, kiểm lane CNC, và kiểm cửa sổ khuôn tới được trang CUT — nối lại chuỗi
§A4b-2/§A4b-3 với đường chạy production. Một ca đi qua chính `_run_nup_engine_impl` chứ không gọi
module trực tiếp, vì đó là hàm `_spawn_nup_process` gọi thật.

Không chạy `cargo test` và `vitest`/`tsc`: lô chỉ chạm Python.

### 7.1 Ghi chú về số nền

Mốc nền khi loại file test mới: **4316**. Lượt cuối Lô A4b-3 đo **4311**. Chênh 5 test **không quy
được cho lô này**, đã loại trừ bằng đo:

- File test mới thu thập đúng **38**; 4354 − 38 = 4316, số học tự khớp.
- Tạm **dời module mới ra khỏi `backend/app/workers/`** rồi thu thập lại: vẫn **4316**. Vậy module
  mới không làm phồng số test của file khác (đã kiểm giả thuyết test quét `backend/app/**/*.py` —
  `test_pro_feature_enforcement_coverage.py` dùng `rglob` trong **fixture**, không trong
  `parametrize`, nên không đổi số thu thập).
- Không có test nào trong `backend/tests` parametrize theo nội dung thư mục.

Điều chốt lại là **0 failed** ở trạng thái sạch. Tôi không dựng lại được trạng thái của lượt đo
4311 nên không kết luận nguyên nhân.

## 8. Còn hở

| Mã | Nội dung | Mức |
|---|---|---|
| **A4b-4a** | **PREVIEW lệch EXPORT.** `/preview-layout` và `/preview-layouts-batch` khai `strategy: str` (`imposition.py:1226`, `:3718`) không ràng buộc, nhận `true_shape_nesting` rồi rơi vào nhánh grid. Sau lô này export chạy nesting còn preview vẫn báo số của lưới grid ⇒ số "Tem/tờ" trên UI **khác** tờ bình thật. Codebase coi "preview ≡ output" là bất biến hàng đầu | **P1** |
| A4b-4b | `profile="balanced"` và `MAX_SHEETS_CEILING=200` là hằng do tôi chọn, chưa phơi ra UI. Job lớn có thể cần `tight`, job nhỏ có thể muốn `fast` | P2 |
| A4b-4c | Chưa có test đi qua **route** `/nup-start` (chỉ tới `_run_nup_engine_impl`). Đoạn `_launch_impose_job` → `_spawn_nup_process` chưa được phủ cho nhánh mới | P2 |
| A4b-4d | Cờ backend `true_shape_nesting_enabled()` giờ đã có caller production, nhưng `build_production.ps1` vẫn nung cặp cờ thành `"false"` ⇒ bản release chặn tính năng. Đúng chủ đích canary, nhưng phải nhớ khi mở | P2 |
| A4b-4e | Nhóm test có sẵn `test_mixed_nesting_*` tạo thư mục `mixed_nesting_data/` rỗng trong repo mỗi lượt chạy. Không rò manifest, chỉ là nhiễu untracked | P3 |

## 9. Việc kế tiếp — cần quyết định

**A4b-4a** là chốt chặn: không nên giao tính năng khi số preview khác tờ bình thật. Ba hướng:

- **(a) Preview solve thật.** Đúng nhất, nhưng nesting tốn vài giây còn preview đang debounce 350ms
  và chạy lại theo mỗi lần đổi thiết lập. Cần trạng thái "đang tính" và cache theo
  `layoutFingerprint`.
- **(b) Preview giữ số grid, UI ghi rõ** "số thật tính khi bình". Rẻ và trung thực, nhưng cột
  "Tem/tờ" mất ý nghĩa đúng ở chế độ nesting.
- **(c) Solve một lần, dùng cho cả preview và export.** Chính là thiết kế mà pipeline đã dựng sẵn
  (`solve_production_nesting_job` + `render_production_nesting_session` hai lượt, đã có test khoá
  cùng `layoutFingerprint`). Đúng kiến trúc nhất, nhưng phải đổi luồng preview đang debounce.

Tôi nghiêng **(c)**, có **(b)** làm trạng thái trung gian cho tới khi (c) xong — như vậy không lúc
nào UI hiển thị một con số sai mà không có cảnh báo.

Finding còn chờ chủ dự án quyết từ các lô trước: **F3-1**, **A2-1**, **A4a-2**, **A4b-3a**
(MultiPolygon cho contour), **A4b-2a**. Chặng B: **C0-6**, **C0-7**.
