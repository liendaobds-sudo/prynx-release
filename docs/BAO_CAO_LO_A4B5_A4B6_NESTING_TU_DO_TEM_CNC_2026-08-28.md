# Báo cáo Lô A4b-5 + A4b-6 — Một lượt solve cho cả preview và export, qua ranh giới process

Ngày: 2026-08-28. Nhánh `codex/pre-release-audit-2026-08-04`. Máy Windows thật, `D:\pdfcompare`.

Đóng finding **A4b-4a** (preview lệch export) theo phương án **(c)** chủ dự án đã duyệt, và
finding **A4b-4c** (chưa có test qua route thật).

## 1. Vấn đề A4b-4a

Cột "Tem/tờ" và tờ bình thật phải bằng nhau — bất biến "preview ≡ output" của dự án. Với lưới
grid hai bên bằng nhau vì gọi **cùng** `compute_sticker_layout_for_page`. Nesting phá cấu trúc
đó: export đi solver Rust, preview còn ở nhánh lưới ⇒ hai số khác nhau.

Không thể cho preview gọi nesting mỗi lần gõ: tính lưới xong trong vài chục ms và preview
debounce 350ms, còn nesting là tìm kiếm với ngân sách 30k/100k/300k lượt thử pose — cỡ vài giây.

## 2. Phương án (c): giải một lần, dùng hai lần

```
đổi thiết lập → get_or_solve(job) ─┬→ session_capacity()   → cột Tem/tờ
                                   └→ render(session)      → file bình
```

Phần khó đã có sẵn: pipeline tách làm ba hàm (`solve_production_nesting_job`,
`render_production_nesting_session`, `commit_production_nesting_session`), và
`test_nesting_production_pipeline.py` đã khoá "một lượt solve, hai file, cùng
`layoutFingerprint`, cùng byte".

### 2.1 Kho phiên (§A4b-5)

`backend/app/core/nesting_preview_session.py`:

- **LRU, an toàn thread** (preview tới từ event loop, export chạy trong executor).
- **Trần theo RAM** đúng quy tắc dự án: `<8GB` giữ 1 phiên, `<16GB` giữ 3, `≥16GB` là
  `max(6, RAM_MB // 4096)` — không trần cố định cho máy mạnh. Policy là hàm thuần
  `preview_session_capacity_for_ram()` nên test phủ đủ bậc mà không phụ thuộc máy chạy.
- **Tự thu hồi snapshot khi loại phiên.** `solve_production_nesting_job` chỉ dọn pin ở nhánh
  **lỗi**; solve thành công thì phiên giữ pin sống (nhờ vậy render lại được), nên ai giữ phiên
  phải tự dọn.
- **Solve ngoài vùng khóa**, và xử lý đua: nếu lượt khác vừa solve xong cùng khoá thì giữ bản
  trong kho rồi thu hồi bản vừa giải — không thì hai artifact cùng job khác fingerprint.

Khoá nhận dạng `job_identity_key()` gồm **mọi** field ảnh hưởng layout cộng `SourceFingerprint`
của từng nguồn. Cố ý **không** đưa `manifest_id` và `request_revision` vào khoá: chúng không đổi
hình học, hai lượt cùng đầu vào phải hit. `inputHash` của contract là nhận dạng đúng nhất nhưng
chỉ có SAU khi đã pin nguồn và resolve hình học — dùng nó làm khoá thì mỗi lượt preview vẫn phải
pin, tức mất phần lớn cái muốn tiết kiệm. Độ tin cậy về tươi mới bằng đúng hàng rào revision mà
`_launch_impose_job` đang dùng cho toàn bộ job N-Up.

### 2.2 Ranh giới process (§A4b-6) — lỗ tự phát hiện

Sau khi §A4b-5 xanh, tôi phát hiện phạm vi chứng minh sai. `_spawn_nup_process` tạo
`multiprocessing.Process` **thật**, nên:

```
POST /nup-start → process API        ← preview solve, session ở RAM đây
    ↓ multiprocessing.Process
run_nup_engine  → process CON        ← export chạy ở đây, RAM rỗng
```

Process con khởi động với kho phiên **rỗng** và sẽ solve lại — mất đúng bất biến vừa dựng. Test
của §A4b-5 xanh vì chúng gọi `run_true_shape_nesting` trong **cùng** process.

Bản vá không truyền RAM mà truyền **identity**:

| Bước | Ở đâu | Làm gì |
|---|---|---|
| 1 | process API | preview solve → session trong kho |
| 2 | process API, trong `_launch_impose_job` | `attach_preview_session_reference`: commit manifest xuống kho đĩa, gắn `{manifestId, layoutFingerprint}` vào `settings` |
| 3 | pickle qua `Process(args=...)` | hai chuỗi, không dữ liệu thô |
| 4 | process CON | `load_referenced_manifest` → `render_stored_production_nesting` — **không solve** |

Khả thi vì kho manifest đã lưu đủ: `manifest`, `production_request` (engine request + render
bundle), và `resolved_sources` với `ResolvedPinnedSource.path` lấy qua lease đã promote sang
final — process nào cũng resolve được.

Kho cố tình đòi **cả hai** chuỗi để không bao giờ lookup bằng ID mơ hồ
(`NestingManifestStore.load`), nên tham chiếu mang đúng cặp đó.

## 3. Fail-soft ba tầng

Tham chiếu chỉ là đường tăng tốc. Mất nó thì process con solve lại — chậm hơn nhưng đúng. Vì vậy:

| Tầng | Hành vi |
|---|---|
| `load_referenced_manifest` | tham chiếu méo/manifest bị dọn/fingerprint lệch ⇒ trả `None`, log info |
| `attach_preview_session_reference` | mọi lỗi bên trong ⇒ trả `settings` không đổi |
| route `_launch_impose_job` | **bọc cả lời gọi trong try/except** |

Tầng thứ ba là kết quả của một test tôi viết ra rồi thấy hành vi không ổn: nếu import module
nesting lỗi thì **mọi** job N-Up, kể cả lưới grid, sẽ 500. Bán kính đó không chấp nhận được nên
đã chắn ở route và khoá bằng test mô phỏng `ImportError`.

## 4. Bằng chứng

### 4.1 Trong cùng process (§A4b-5)

- Preview lấy số → export bình: **solve đúng một lần**, và con số preview khớp con số trong
  report của tờ bình.
- Bình hai lần cùng thiết lập: một lượt solve, hai file **giống nhau tới byte**.
- Đổi khổ tờ: solve lại (không phục vụ layout cũ).

### 4.2 Qua ranh giới process (§A4b-6)

- Mô phỏng process con (`reset_preview_session_store()` cho RAM trống, manifest còn trên đĩa):
  render được, **0 lượt solve**.
- Artifact qua tham chiếu **giống tới byte** artifact render trực tiếp từ session.
- **Process con THẬT**: `multiprocessing.Process` (Windows dùng spawn nên là interpreter mới
  hoàn toàn) → render xong, **0 lượt solve**. Đây là phần mà mô phỏng không chứng minh được:
  tham chiếu đi qua pickle và lease resolve được từ process khác.

### 4.3 Test có thật sự bắt lỗi

Tạm bỏ nhánh nạp tham chiếu ⇒ **3 test đỏ**, gồm cả ca process con thật:

```
FAILED test_ram_rong_van_render_duoc_tu_tham_chieu
FAILED test_artifact_tu_tham_chieu_giong_artifact_tu_phien
FAILED test_process_con_that_render_khong_solve   ← AssertionError: process con KHÔNG được solve lại
```

Trước đó, ở §A4b-5, tạm trả export về `run_production_nesting_job` cũng cho 2 test đỏ, trong đó
lỗi thứ hai sắc hơn dự tính: **`ManifestConflictError`** — kho manifest tự phát hiện cùng một
`manifest_id` mà hai `layoutFingerprint`. Nghĩa là solve hai lần **vốn không tương thích** với
`manifest_id` tất định; (c) là điều kiện đúng đắn của hợp đồng manifest, không chỉ là tối ưu tốc độ.

## 5. Phạm vi — 7 file

| File | Trạng thái | Thay đổi |
|---|---|---|
| `backend/app/core/nesting_preview_session.py` | mới | kho phiên + `commit_and_reference` + `load_referenced_manifest` |
| `backend/app/core/nesting_production_pipeline.py` | untracked WIP | +`render_stored_production_nesting` |
| `backend/app/workers/nup_true_shape_nesting.py` | untracked WIP | nhánh nạp tham chiếu + `attach_preview_session_reference` |
| `backend/app/api/routes/imposition.py` | tracked, M | **~14 dòng**: hook + try/except |
| `backend/tests/test_nesting_preview_session.py` | mới | 45 test |
| `backend/tests/test_nesting_session_handover.py` | mới | 19 test |
| `backend/tests/test_nup_true_shape_nesting_entry.py` | untracked WIP | +3 test preview ≡ output |

Vượt trần ≤5 file một lô. Lý do: §A4b-6 là bản sửa **bắt buộc** cho lỗ mà chính §A4b-5 tạo ra,
tách ra sẽ để lại một lô sai phạm vi chứng minh trong repo. Phần chạm code production tracked chỉ
là ~14 dòng ở route.

## 6. Verify

| Bộ | Kết quả |
|---|---|
| **Toàn bộ `backend/tests`** | **EXITCODE=0**, **4444 passed, 19 skipped, 0 failed**, 486s |
| Số test thu thập | **4463** = 4444 + 19 |
| `test_nesting_session_handover.py` riêng | 19 passed |
| `test_nesting_preview_session.py` riêng | 45 passed |
| `test_nup_true_shape_nesting_entry.py` riêng | 41 passed |

Không chạy `cargo test`/`vitest`/`tsc`: lô chỉ chạm Python.

### 6.1 Đối chiếu số — giờ khớp tuyệt đối

| Mốc | passed | skipped | tổng | thu thập |
|---|---|---|---|---|
| Nền sạch trước lô | 4425 | 19 | 4444 | 4444 |
| Sau lô (+19 test mới) | 4444 | 19 | 4463 | 4463 |

### 6.2 Truy nguyên các lệch số ở báo cáo trước

Báo cáo §A4b-3 và §A4b-4 có ghi lệch không giải thích được (+5, rồi +42). Đã truy xong:

- Lượt full suite báo `4391 passed, 19 skipped` (tổng 4410) **thấp hơn số thu thập 34**. Lượt đó
  bị ngắt giữa đường (tool call abort, tiến trình con sống sót) nên **không đáng tin**.
- Một lượt khác thoát với `EXITCODE=1` ở 38% mà **không có dòng summary nào** — dấu hiệu bị kết
  thúc cứng, không phải test đỏ. Tôi đã verify thiếu cẩn thận: chỉ đọc 3 dòng cuối và không kiểm
  exit code.
- Nguyên nhân nền: **17 tiến trình test treo** từ các phiên trước (12 lượt `pytest backend/tests`,
  2 `cargo test`, 1 `vitest`) tranh CPU. Đã dừng hết ở lô A4b-3.
- Đã loại trừ hồi quy bằng đo: mọi file tôi chạm có **đúng** số test kỳ vọng; bộ 12 file bắt buộc
  **không đổi** (464); không có conftest hook deselect; không có parametrize theo thư mục hay
  corpus; thu thập ổn định qua 3 lượt liên tiếp.

**Bài học quy trình**: từ nay mỗi lượt full suite phải ghi `EXITCODE` và đối chiếu
`passed + skipped == --collect-only`. Cả hai đã làm trong lô này.

## 7. Còn hở

| Mã | Nội dung | Mức |
|---|---|---|
| **A4b-6a** | **Chưa có route preview cho nesting.** Kho phiên và đường chuyển tham chiếu đã xong và có test, nhưng chưa endpoint nào gọi `get_or_solve`, nên `peek` trong route luôn miss ⇒ thực tế process con vẫn solve. Cột "Tem/tờ" vẫn hiện số lưới grid | **P1** |
| A4b-6b | Chưa có trạng thái "đang tính" và nút hủy trên UI cho lượt solve nesting. Pipeline đã nhận `cancel_event`/`progress_callback` nên phần dưới sẵn | P1 |
| A4b-6c | Lượt solve ở process API chạy **ngoài** grant của `@scheduled_job("nup")`. Solver Rust nhả GIL (đã có test chứng minh) nên không chặn event loop, nhưng vẫn nên vào scheduler để không vượt suất máy | P2 |
| A4b-6d | `manifest_id` gồm `job_id` nên mỗi lượt submit công bố một manifest riêng. Đúng cho production (không xung đột), nhưng nghĩa là kho tích lũy manifest theo số lượt bình — chưa có dọn theo TTL | P2 |
| A4b-4b | `profile="balanced"` và `MAX_SHEETS_CEILING=200` là hằng tôi chọn, chưa phơi ra UI | P2 |
| A4b-4d | `build_production.ps1` nung cặp cờ thành `"false"` ⇒ release chặn tính năng. Đúng chủ đích canary | P2 |
| A4b-4e | Nhóm test có sẵn `test_mixed_nesting_*` tạo thư mục `mixed_nesting_data/` rỗng trong repo mỗi lượt chạy | P3 |

## 8. Việc kế tiếp

**A4b-7**: route preview cho nesting + wiring UI. Đây là mảnh cuối để người dùng thấy đúng số:

1. Endpoint nhận cùng payload nesting, gọi `get_or_solve` trong thread (solver nhả GIL), trả
   `placedCount`/`sheetCount` từ `session_capacity()`.
2. Frontend: khi `gridStrategy === 'true_shape_nesting'` thì gọi endpoint đó thay cho
   `/preview-layout`, kèm trạng thái "đang tính" và hủy được.
3. Chọn thời điểm giải: debounce dài hơn 350ms hoặc nút "tính thử", để không giải khi người dùng
   còn đang dò thiết lập.

Sau đó nesting mới thật sự dùng được đầu-cuối trong dev; release còn chờ mở cờ (A4b-4d).

Finding còn chờ chủ dự án quyết từ các lô trước: **F3-1**, **A2-1**, **A4a-2**, **A4b-3a**,
**A4b-2a**. Chặng B: **C0-6**, **C0-7**.
