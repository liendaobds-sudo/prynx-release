# Nhật ký sửa theo lô — audit kiến trúc 2026-07-29

Báo cáo gốc: `docs/BAO_CAO_AUDIT_KIEN_TRUC_2026-07-29.md` (duyệt cả danh sách 2026-07-29).
Quy trình: `prynx-audit-workflow` — lô ≤5 file, verify xong mới sang lô kế, mỗi chỗ sửa gắn tag
`KIENTRUC (audit 2026-07-29 §x.y)`.

| Lô | Nhóm | Trạng thái |
|---|---|---|
| 1 | §C.1 khóa PDFium + §C.2 router chết | ✅ xong |
| 2 | §C.1b tách khóa ra module nhẹ `pdfium_lock.py` | ✅ xong |
| 3 | §C.1c áp `pdfium_guard()` cho 5 module chạy trong thread | ✅ xong |
| 4 | §C.3a RAM-gate worker pool bình bản / preflight | ✅ xong |
| 5 | §C.3b trần job (đính chính: chỉ gate slot việc nặng) | ✅ xong |
| 6 | §D.2 registry biến môi trường | ✅ xong |
| 7 | §A.3 gộp store + §F vệ sinh `.gitignore` | ✅ xong |
| 8 | §A.2 hợp đồng API — đợt 1: job N-Up + job VDP | ✅ xong |
| 8b | §A.2 đợt 2: `system` (4/4), `pdf_tools` (5/5 JSON), `preflight` (4→22/38) | ✅ xong (24→43 endpoint có model) |
| 9 | §A.1 `routes/imposition.py` | ✅ **đổi hướng**: ratchet chặn phình + đính chính; refactor cần spec riêng |
| 10 | §D.1 Cargo workspace | ✅ **đổi hướng**: chốt lệch lockfile trong CI + sửa mojibake; gộp workspace phá đường phát hành |
| 11 | §B.1 parity booklet TS ↔ Rust | ✅ xong — 12/12 case `simple_auto` khớp |
| 12 | Dọn nợ: §C.1 phần cuối, §A.2b ratchet, §C.3b nới trần + cách ly loại việc, §F xoá rác | ✅ xong |
| 13 | Hết nợ trừ `routes/imposition.py`: §A.2 (response model + gom 47 request model), §B.3 (bỏ engine PDF thứ hai + 2 phantom dep) | ✅ xong |

**Verify tổng sau lô 7:** `backend` → `pytest tests` = **1590 passed, 5 skipped**;
`desktop` → `npm run typecheck` sạch, `npx vitest run` = **144 file, 1262 passed, 2 skipped**.

---

## Lô 1 — §C.1 (khóa PDFium) + §C.2 (router chết)

**Vì sao mức nghiêm trọng tăng so với báo cáo:** khảo sát sâu hơn cho thấy truy cập PDFium song song
trong cùng process là chuyện đang xảy ra, không phải giả định. Hàng chục đường đi dùng
`asyncio.to_thread` trên executor mặc định (không admission control): `core/softproof.py:91,121,153`,
`core/separations.py:226`, `core/layer_engine.py`, `core/page_boxes.py`, `core/geometry_reader.py`.
Upstream pypdfium2 khẳng định gọi hàm pdfium đồng thời từ nhiều thread là không được phép, hậu quả
tuỳ ý ([pypdfium2 #309](https://github.com/pypdfium2-team/pypdfium2/issues/309) — nội dung đã diễn
giải lại cho phù hợp giấy phép). Vì vậy chọn **tạo khóa thật** thay vì chỉ sửa tài liệu cho khớp.

| File | Thay đổi | Lý do |
|---|---|---|
| `backend/app/core/rust_bridge.py` | Thêm `PDFIUM_PY_LOCK` (`threading.RLock`) + context manager `pdfium_guard()`; bọc 4 lời gọi `_native.*` (`enumerate_page_objects`, `render_page_svg`, `delete_page_objects`, `render_page_image`) và 2 fallback `pypdfium2` (`_fallback_render_svg`, `_fallback_render_image`) | Hiện thực đúng bất biến rule #3. RLock để nested call cùng thread (`render_with_hidden_layers` → `render_page_image`) không tự deadlock. Vùng khóa chỉ bao lời gọi PDFium; encode PNG/JPEG để ngoài khóa |
| `backend/app/api/routes/report.py` | **Xoá** | Router chưa từng được `include_router` ở `main.py`, không nơi nào import, frontend không gọi `api/report` |
| `AGENTS.md` | Viết lại rule #3: nêu đúng tên khóa + `pdfium_guard()`, phạm vi một process, yêu cầu bọc khi chạm PDFium trong thread, và nhắc việc nặng phải đi process | Rule cũ dẫn một symbol chưa từng tồn tại (`git log -S` rỗng) — mọi agent đọc rule này đầu tiên |
| `.agents/skills/prynx-architecture/SKILL.md` (+ sync `.claude/`) | Bỏ `report.py` khỏi bản đồ route, ghi chú `dieline_validation.py` là helper không phải router, ghi chú "không có `include_router` ở `main.py` = không chạy", nhắc `max_active_heavy_jobs()` dùng chia ngân sách RAM | Bản đồ route lệch thực tế |

**Đính chính trong lô này:** đã lỡ bỏ `reportlab==4.2.0` khỏi `requirements.txt` rồi **hoàn lại**.
Grep ban đầu dùng brace-glob `backend/**/*.{py,txt,toml}` mà ripgrep không mở rộng nên gần như không
match gì, dẫn tới kết luận sai "chỉ report.py dùng reportlab". Người dùng thật:
`workers/vdp_engine.py`, `workers/nup_report.py`, `workers/cut_export/emitters/pdf_spot.py`,
`core/layer_engine.py`, `core/stream_editor.py` + ~18 file test. Báo cáo audit đã ghi đính chính.

**Ghi chú hiệu năng (rule #1):** khóa serialize hoá PDFium **trong một process**. Việc nặng (bình
bản, VDP, tem, preflight file lớn) vẫn chạy `ProcessPoolExecutor`/`multiprocessing.Process` nên song
song thật không đổi. Cái bị serialize là các lời gọi PDFium ngắn từ endpoint (render preview, đọc
box, đọc object) — trước đây chạy đua nhau và có thể sinh lỗi tuỳ ý.

**Verify**
```
backend> venv\Scripts\python.exe -c "import app.main; ..."   → OK, routers=20, lock=RLock
backend> pytest tests -k "rust_bridge or report or bridge"    → 47 passed
backend> pytest tests -k "rust_bridge or bridge or nup_report or cut_export" → 27 passed
```

**Còn nợ:** `pdfium_guard()` chưa được áp cho các module cũ chạm PDFium trực tiếp (19 file
`import pypdfium2`). Đó là nội dung lô 2.

---

## Lô 2 — §C.1b: tách khóa ra module nhẹ

Lý do tách: một primitive khóa không nên buộc phải nạp extension Rust. `rust_bridge`
import `pdfcompare_native` và đặt biến môi trường `PDFIUM_DLL_PATH` khi load; module nào chỉ cần
khóa mà phải `import rust_bridge` sẽ kéo theo toàn bộ tác dụng lề đó (và một vòng phụ thuộc tiềm
tàng, vì `rust_bridge` là tầng dưới của nhiều engine).

| File | Thay đổi |
|---|---|
| `backend/app/core/pdfium_lock.py` | **Mới.** Nơi định nghĩa duy nhất `PDFIUM_PY_LOCK` (RLock) + `pdfium_guard()`. Không import gì nặng |
| `backend/app/core/rust_bridge.py` | Bỏ định nghĩa inline, đổi thành `from app.core.pdfium_lock import PDFIUM_PY_LOCK, pdfium_guard` (re-export) |
| `AGENTS.md` rule #3 | Ghi đúng: định nghĩa ở `pdfium_lock.py`, re-export qua `rust_bridge.py` |
| `.agents/skills/prynx-architecture/SKILL.md` (+ sync) | Bản đồ `core/` trỏ `pdfium_lock.py` |

**Verify:** `assert rust_bridge.PDFIUM_PY_LOCK is pdfium_lock.PDFIUM_PY_LOCK` → OK; `import app.main`
→ routers=20; guard tái nhập cùng thread → OK.

---

## Lô 3 — §C.1c: áp `pdfium_guard()` cho các đường chạy trong thread

Nguyên tắc áp dụng: khóa bao **mọi** lời gọi PDFium kể cả `close()` và `len(doc)`/`doc[i]`; những
bước copy pixel ra khỏi bộ đệm bitmap (`np.array(img)`, `img.save(...)` khi ảnh còn tham chiếu
bitmap) cũng phải nằm trong khóa để không đổi thứ tự "dùng xong mới đóng" của bản gốc; phần tính
toán thuần Python/numpy/cv2 để ngoài khóa.

| File | Chỗ sửa | Ghi chú |
|---|---|---|
| `core/softproof.py` | `_render_pdfium_rgb` | Gọi qua `asyncio.to_thread` ở nhánh không ICC; toàn thân là PDFium nên bao cả |
| `core/separations.py` | `_run_pikepdf_fallback` (mở/render/to_pil) + `pdf_doc.close()` | Toán numpy RGB→CMYK để ngoài khóa; `close()` có guard riêng, giữ đúng thứ tự đóng sau khi dùng `img` |
| `core/layer_engine.py` | render preview OCG; `_flatten_raster_fallback` | Preview: encode JPEG **trong** khóa (cố ý — `to_pil()` có thể tham chiếu bitmap). Flatten: khóa **theo từng trang** thay vì cả vòng để không chặn preview khác |
| `core/page_boxes.py` | `_pdfium_object_candidates`, `ensure_render` (dò biên xén), `auto_trim` | `auto_trim`: khóa theo từng trang; cv2/numpy dò lề ngoài khóa; `pdf_render[i]` và `close()` đều trong khóa |
| `core/geometry_reader.py` | `list_objects`, `get_text_object_props`, `list_image_placements` | Dùng **wrapper mỏng** (`*_locked`) thay vì thụt lề lại thân hàm dài — diff dễ soi, thân hàm không đổi một dòng |

Thêm test chặn hồi quy: `backend/tests/test_pdfium_lock.py` — re-export cùng một khóa, tái nhập cùng
thread không deadlock (đổi sang `Lock` là fail), loại trừ lẫn nhau giữa 4 thread, nhả khóa khi có
ngoại lệ, và `pdfium_lock` không import extension nặng.

**Verify**
```
backend> pytest tests -k "geometry or page_crop or page_box or auto_trim or layer or softproof or separation or object_mapper or edit"
         → 146 passed, 1 skipped
backend> pytest tests/test_pdfium_lock.py → 5 passed
```

**Còn nợ (ghi để không quên):** vẫn còn các file `import pypdfium2` chưa bọc guard —
`routes/edit.py`, `routes/export.py`, `routes/imposition.py`, `routes/preflight.py`,
`core/channel_remover.py`, `core/outline_fonts.py`, `core/pdf_processor.py`,
`workers/{nup_engine,pdf_ops,pdf_tools_engine,sticker_engine,vdp_engine,vdp_preview}.py`. Phần lớn
chạy trong **process** riêng (an toàn sẵn) hoặc trong endpoint tuần tự; sẽ bọc khi chạm tới theo
đúng rule #3 mới. Ưu tiên soát tiếp: 4 file route (chạy trong process server).

---

## Lô 4 — §C.3a: RAM-gate worker pool bình bản & preflight

| File | Thay đổi |
|---|---|
| `core/system_memory.py` | **Mới** `plan_worker_count(kind, per_worker_mb, cpu_count, hard_ceiling, env_override)` → `(workers, reason)`. Nền `cpu_count-1`; trần theo TỔNG RAM (`<8GB`→1, `<16GB`→2, `>=16GB`→giữ full); trần theo RAM KHẢ DỤNG **chỉ áp cho máy <16GB**; không đọc được RAM → giữ hành vi cũ; env ép được cả chiều tăng |
| `workers/nup_engine.py` | Thay `available_cores = cpu_count-1` (+ env chỉ ghi đè chiều giảm) bằng `plan_worker_count(kind="nup", per_worker_mb=1024)`, log lý do |
| `core/preflight_engine.py` | Thay `min(cpu_count-1, len(chunks), 8)` bằng `plan_worker_count(kind="preflight", per_worker_mb=512, hard_ceiling=min(len(chunks), 8))`; bỏ `import multiprocessing` không còn dùng |

**Đã bắt được một hồi quy trong lúc làm.** Bản nháp đầu áp trần theo RAM khả dụng ở **mọi** tier.
Đo trên máy dev (32 GB, 16 lõi, 14 GB khả dụng): worker bình bản tụt **15 → 8**. Đó đúng là loại hồi
quy máy mạnh mà rule #1 cấm. Đã sửa: trần theo RAM khả dụng chỉ áp cho máy `<16 GB`.

Kết quả đo sau khi sửa (`cpu=16`):

| Máy | Trước | Sau |
|---|---|---|
| 32 GB / 14 GB khả dụng (máy dev) | 15 | **15** (không đổi) |
| 32 GB / 3 GB khả dụng | 15 | **15** (cố ý — rule #1) |
| 12 GB / 4 GB khả dụng | 15 | **2** |
| 6 GB / 2 GB khả dụng | 15 | **1** |
| Không đọc được RAM | 15 | **15** (giữ hành vi cũ) |

Test chặn hồi quy: `backend/tests/test_worker_ram_gating.py` — trong đó
`test_may_manh_khong_bi_ha_tran` là chốt để lần sau không ai áp lại trần theo RAM khả dụng cho máy
≥16 GB.

**Verify:** `pytest tests/test_worker_ram_gating.py tests/test_pdfium_lock.py` → 12 passed;
`pytest tests -k "nup or preflight"` → 158 passed, 1 skipped.

---

## Lô 5 — §C.3b: trần job — **đính chính phát hiện**

Kiểm chứng khi thực thi cho thấy §C.3b trong báo cáo chỉ **đúng một nửa**.

**Phần SAI:** báo cáo xếp `PRYNX_MAX_NUP_JOBS=1`, `PRYNX_MAX_VDP_JOBS=1`,
`PRYNX_MAX_STICKER_JOBS=1`, `PRYNX_MAX_COMPARE_JOBS=1` là "hard-cap vô điều kiện kìm máy mạnh".
Thực tế mỗi job loại này **đã tự trải hết máy bên trong**: `nup_engine` và `vdp_engine` mở
`ProcessPoolExecutor` theo số lõi, `sticker_engine` chọn tới 6 process theo `_auto_sticker_hw_profile`.
Trần 2 job nghĩa là ~2×(cpu−1) process cùng giữ PDF trong RAM → oversubscribe cả CPU lẫn RAM và
TỔNG thông lượng giảm. Nên **không nới**; thay vào đó ghi rõ lý do tại chỗ để lần sau không ai
"tối ưu" ngược.

**Phần ĐÚNG:** `PRYNX_MAX_HEAVY_JOBS=2` là hằng số vô điều kiện, và thiếu bảo vệ cho máy yếu.

| File | Thay đổi |
|---|---|
| `core/heavy_job_scheduler.py` | `_default_heavy_slots()` gate theo RAM: `<8GB`→1 slot; `<16GB`→2; `>=16GB`→2 (**giữ nguyên có chủ ý**); env `PRYNX_MAX_HEAVY_JOBS` ghi đè cả hai chiều; log slot + lý do khi khởi tạo |
| `routes/imposition.py`, `routes/compare.py`, `routes/vdp.py`, `routes/pdf_tools.py` | Ghi chú `PERF (audit 2026-07-29 §C.3)` giải thích vì sao trần = 1 là cố ý, và "muốn máy mạnh nhanh hơn thì tăng worker TRONG job, không tăng số job" |

**Vì sao KHÔNG nới slot việc nặng cho máy ≥16 GB:** slot này phục vụ chuyển đổi Office (COM/
LibreOffice), resize, tách nền, upscale — đúng những feature đã có lịch sử treo
(`docs/BAO_CAO_AUDIT_UPSCALE_TREO_2026-07-28.md`). Nới là thay đổi hành vi runtime, phải đo và duyệt
riêng. **Đây là điểm cần bạn quyết** (xem mục "Cần quyết định" ở cuối file).

**Verify:** `heavy slots = 2` trên máy dev (không đổi); `_auto_memory_budget_mb(32GB, 14GB, 2)` = 5376 MiB
(không đổi); `pytest tests -k "heavy or scheduler or compare or sticker or vdp_routes or pdf_tools"`
→ 245 passed, 1 skipped.

---

## Lô 6 — §D.2: registry biến môi trường

| File | Thay đổi |
|---|---|
| `docs/CAU_HINH_ENV.md` | **Mới.** Danh mục đầy đủ, chia 6 nhóm (giấy phép/bảo mật, trần đồng thời, bộ nhớ & chất lượng render, Ghostscript/PDFium/đường dẫn, parity & fallback, log & chẩn đoán). Mỗi biến có mặc định + "đụng tới khi nào" viết cho người vận hành |
| `.env.example` | Thêm khối trỏ tới registry + liệt kê nhóm hay cần nhất khi hỗ trợ khách (`PRYNX_NUP_WORKERS`, `STICKER_MAX_WORKERS`, `PRYNX_MAX_HEAVY_JOBS`, `PRYNX_MAX_COMPARE_PAGE_PIXELS`, ép CPU khi GPU treo, cờ chẩn đoán, cờ parity) |
| `backend/app/config.py` | Docstring đầu file: nói rõ vì sao phần lớn núm KHÔNG nằm ở đây (trần đặt cạnh code áp trần) + trỏ sang registry + yêu cầu thêm biến mới phải thêm dòng tài liệu trong cùng PR |

Cách lập danh mục (để lần sau kiểm lại được): quét `os.environ.get(...)`/`os.environ[...]`,
`os.getenv(...)` và các hằng tên biến trong `backend/app`, rồi loại bỏ những chuỗi `prynx_*` chữ
thường vì đó là **tiền tố tên file tạm** (`prynx_nup_`, `prynx_cnc_`, `prynx_lo_`,
`prynx_watermark`…) chứ không phải biến môi trường — bảng đếm thô 44 "biến" ban đầu có lẫn nhóm này.

**Verify:** `from app.config import settings` → OK; không đổi hành vi (chỉ tài liệu + docstring).

---

## Lô 7 — §A.3 gộp store + §F vệ sinh repo

**§A.3** — Chuyển 4 file từ `desktop/src/store/` sang `desktop/src/stores/` và xoá thư mục cũ:
`useBoxStore.ts`, `useBoxStore.test.ts`, `useMockupStore.ts`, `useMockupStore.resources.test.ts`.
Cập nhật 35 tham chiếu trong `src/components/dieline-tool/**` (đường dẫn tương đối cùng độ sâu vì hai
thư mục là sibling nên chỉ đổi đoạn `/store/use` → `/stores/use`). Lưu ý một chỗ không phải import mà
là chuỗi trong `vi.mock('../../../store/useBoxStore')` — phải sửa tay, tool đổi import không thấy.
Đã soát: `(?<!s)/store/use` còn **0** kết quả; không có alias nào trong `vite.config.ts`,
`tsconfig*.json` trỏ tới `src/store`.

**§F** — Chỉ bổ sung `.gitignore`, **không xoá dữ liệu trên đĩa**. Kiểm `git check-ignore` +
`git ls-files` cho từng mục: đã ignore sẵn `_to_delete/`, `backend/{debug,temp,tmp,node_modules}/`,
`results/`, `test/`, `private_test_corpus/`, `Ban_Phat_Hanh/`, `terminals/`, `tmp/`. Còn thiếu → nay
thêm: `backend/_atm2/`, `backend/_atm4/`, `backend/_audit_tmp2/`, `backend/logs/`, `logs/`,
`uploads/`. Xoá đĩa là việc không hoàn tác được (trong đó có `uploads`, `results`, log) nên để bạn
tự quyết — danh sách ở phần "Cần quyết định".

**Verify:** `npm run typecheck` → sạch; `npx vitest run src/stores src/components/dieline-tool` →
15 file, 88 test passed; chạy tiếp toàn bộ `npx vitest run` để chắc không sót tham chiếu.

---

## Cần bạn quyết định

1. **Nới slot việc nặng cho máy mạnh** (§C.3b): hiện `>=16 GB` vẫn là 2 slot như cũ. Nới lên 3–4 sẽ
   cho nhiều tác vụ Office/resize/tách nền/upscale chạy song song hơn, nhưng đó đúng nhóm feature đã
   có lịch sử treo. Cần một phiên đo trên máy thật trước khi đổi. Cũng cần cân nhắc: nới slot làm
   ngân sách RAM mỗi slot giảm tương ứng (đúng thiết kế, nhưng có thể hạ chất lượng render nếu bí RAM).
2. **Xoá rác trên đĩa** (§F): `backend/{_atm2,_atm4,_audit_tmp2,debug,temp}`, `_to_delete/`,
   `terminals/`, `backend/{t.txt,ocr_raw.txt,ocr_pre.txt}`. Đều untracked. Tôi không tự xoá vì
   không hoàn tác được và một số thư mục lân cận (`uploads/`, `results/`) có thể chứa file khách.
3. **Lô 8/9/10** (§A.2 hợp đồng API, §A.1 rút logic khỏi `routes/imposition.py`, §D.1 Cargo
   workspace, §B.1 parity booklet): chạm đường xuất file và quy trình build phát hành. Đề xuất làm
   từng lô một, mỗi lô xác nhận trước khi vào.

---

## Lô 8 — §A.2: hợp đồng API (đợt 1)

§A.2 là việc nhiều đợt (126 endpoint). Đợt này làm **hai nhóm nóng nhất**: vòng đời job N-Up và
vòng đời job VDP — đúng hai chỗ mà lệch field không báo lỗi mà chỉ khiến người dùng thấy "bình xong
nhưng không mở được file".

**Nguyên tắc đã chốt khi thêm `response_model` cho endpoint ĐANG CHẠY** (ghi trong docstring
`schemas/imposition.py` để đợt sau theo cùng chuẩn):

1. Model **mô tả**, không siết. Mọi field frontend đang đọc phải có mặt; field kiểu lỏng để
   `Optional`. Lý do: `response_model` của FastAPI vừa **lọc** field lạ vừa **validate** — bắt kiểu
   chặt trên endpoint đã chạy sẽ biến một dữ liệu lệch nhẹ thành 500 ngay trên máy khách.
2. Mỗi field ghi rõ **ai đọc nó** phía desktop. Đó là thứ duy nhất giúp lần sau biết field nào được
   phép bỏ.
3. Endpoint trả nhiều hình dạng (vd `/nup-cancel` có 3 nhánh) → model là **hợp** của các nhánh, field
   riêng của từng nhánh để `Optional`.

| File | Thay đổi |
|---|---|
| `schemas/imposition.py` | Viết lại: thêm `ImposeJobStartResponse`, `NupJobStatusResponse`, `NupJobCancelResponse`. **Xoá** `ImpositionConfig`/`ImpositionRequest`/`ImpositionResponse` — di sản thời pdfcpu, `core/imposition_engine.py` đã deprecated, `ImpositionRequest` là class rỗng chỉ có `pass`, và `ImpositionResponse` chỉ còn được *import* ở route mà không dùng |
| `routes/imposition.py` | Gắn `response_model` cho `/impose-start`, `/nup-start`, `/sticker-start`, `/nup-status/{job_id}`, `/nup-cancel/{job_id}`; sửa import theo model mới |
| `schemas/vdp.py` | Thêm `VdpJobStartResponse`, `VdpJobStatusResponse`, `VdpJobCancelResponse`, `VdpUploadResponse` |
| `routes/vdp.py` | Gắn `response_model` cho `/generate`, `/status/{job_id}`, `/vdp-cancel/{job_id}` (+ alias `/cancel/{job_id}`), `/upload` |
| `schemas/job.py` | `class Config: from_attributes` → `model_config = ConfigDict(from_attributes=True)` (API Pydantic v1 sẽ bị bỏ ở v3; mỗi lần chạy test đều in DeprecationWarning) |

Nhóm `compare`/`results`/`upload` **đã** có `response_model` đầy đủ từ trước — không cần sửa.

Test mới `backend/tests/test_api_contract.py` (25 test): khoá tập field desktop đang đọc, kiểm từng
endpoint có khai đúng model, và chốt "model không được siết" (`NupJobStatusResponse(status="running")`
phải hợp lệ). Có một test canh `ImpositionConfig`/`ImpositionRequest`/`ImpositionResponse` không quay
lại — nếu có nghĩa là ai đó khôi phục engine pdfcpu.

Hai chi tiết đáng ghi: router `imposition` có prefix riêng nên `route.path` là
`/imposition/nup-status/{job_id}` — test tra theo **hậu tố** để không gõ cứng prefix. Và
`smart_relocate` **không** tự cập nhật import/chuỗi trong repo này (đã gặp ở cả lô 7 và lô 8), phải
tự soát lại sau khi đổi tên file.

**Tiến độ §A.2:** endpoint có `response_model` **24 → 34** trên tổng **126**. Còn lại nhiều nhất:
`preflight.py` (38 endpoint / 4 có model), `pdf_tools.py` (22 / 0), `imposition.py` (18 / 5),
`edit.py` (19 / 12), `system.py` (4 / 0).

**Verify:** `pytest tests` toàn bộ → **1615 passed, 5 skipped** (trước lô 8: 1590 passed — tăng đúng
25 test mới); cảnh báo giảm 6 → 4 do bỏ `class Config`. `pytest tests -k "imposition or nup or impose
or sticker or api"` → 337 passed; `-k "vdp"` → 129 passed.

---

## Lô 8 đợt 2 — §A.2: `system`, `pdf_tools`, `preflight`

| File | Thay đổi |
|---|---|
| `schemas/system.py` | **Mới** — `GpuStatusResponse`, `InstallGpuPluginResponse`, `RecoverJobsResponse`, `GsUsageResponse` |
| `routes/system.py` | Gắn model cho **cả 4/4** endpoint |
| `schemas/pdf_tools.py` | **Mới** — `EncryptionStatusResponse`, `MetadataReadResponse`, `OfficeConvertStatusResponse`, `WarmupResponse` |
| `routes/pdf_tools.py` | Gắn model cho 5 endpoint trả JSON |
| `schemas/preflight.py` | **Mới** — `FixFileResponse` (dùng chung 11 endpoint), `FlattenLayersResponse`, `CropRegionsResponse`, `PreviewImageResponse`, `PageObjectsResponse`, `InksResponse`, `IccProfilesResponse`, `OverprintPreviewResponse` |
| `routes/preflight.py` | Gắn model cho 18 endpoint (4 → 22 trên 38) |
| `desktop/src/lib/api.ts` | **Xoá** 4 hàm client chết (xem dưới) |
| `schemas/job.py` | `class Config` → `ConfigDict` (đã làm ở đợt 1) |

**Phát hiện mới trong lúc làm — endpoint client gọi vào hư không.** `lib/api.ts` có 4 hàm
(`getAiStatus`, `installLocalAi`, `pullAiModel`, `getPullProgress`) gọi `/api/system/ai/status`,
`/ai/install`, `/ai/pull`, `/ai/pull-progress`. Grep `system/ai` trong `backend/app` → **0 kết quả**:
backend không có endpoint nào khớp, nên mọi lời gọi là 404 và `!res.ok` ném lỗi. Không component nào
import 4 hàm này → code client chết còn lại sau khi endpoint bị bỏ. Đã xoá kèm comment giải thích.
Đây là minh chứng cụ thể nhất cho lý do §A.2 tồn tại: hai đầu không có codegen chung nên endpoint
biến mất mà client không hề biết.

**Đính chính con số trong báo cáo.** Báo cáo ghi `pdf_tools.py` là "22 endpoint / 0 có model" như một
thiếu sót. Thực tế **25 endpoint trong `routes/` trả `FileResponse`** (tải PDF/PNG/ZIP về) — chỗ đó
`response_model` không áp dụng được, gắn vào là sai kiểu response. `pdf_tools.py` chỉ có 5 endpoint
trả JSON và nay cả 5 đều có model. Mẫu số đúng để theo dõi §A.2 là ~101 endpoint JSON, không phải 126.

**Cố tình chưa gắn** (ghi lại để không bị hiểu là bỏ sót): `/preflight/preview-layers` có nhánh
`return engine.render_with_visibility(...)` trả **chuỗi** base64 chứ không phải dict;
`/preflight/softproof` nhánh thành công `return result` với hình dạng do engine dựng;
`/pdf-tools/merge-manifest` trả dict khi `return_path=true` và `FileResponse` khi không. Cả ba cần
chuẩn hoá nhánh return trước — có test `test_preflight_bo_qua_co_y_van_khong_co_model` canh, để lần
sau ai gắn model thì buộc phải sửa nhánh return trước.

Cách xác định hình dạng response: quét **AST** từng hàm để liệt kê MỌI nhánh `return`, thay vì đọc
mắt. Nhờ vậy phát hiện được ba endpoint có nhánh trả kiểu khác — nếu chỉ nhìn `return {` đầu tiên thì
đã gắn model sai và làm hỏng chúng.

**Tiến độ §A.2:** endpoint có `response_model` **24 → 43** (trên ~101 endpoint JSON).
Còn lại: `preflight` 16, `imposition` 13, `edit` 7, `dieline`/`export`/`ws` 3.

**Verify:** `pytest tests/test_api_contract.py` → 56 passed; `pytest -k "preflight or system or
pdf_tools or layer or crop or bleed or spot or overprint"` → 234 passed, 1 skipped; `tsc --noEmit`
sạch sau khi xoá 4 hàm.

---

## Lô 9 — §A.1: **đổi hướng** sau khi khảo sát (ratchet thay vì refactor)

Hai điều khảo sát cho thấy §A.1 không thể làm theo cách báo cáo đề xuất:

**1. "79 import trong hàm" KHÔNG hoàn toàn là mùi code — đính chính.** Báo cáo coi đó là dấu hiệu
lách vòng phụ thuộc. Kiểm thật: không module nào trong 26 module đó import ngược lại
`routes.imposition` (chỉ `core/edit_session.py` import ngược vào `routes/edit.py`), nên chuyển lên
mức module sẽ **không** gây vòng. Nhưng nhiều module trong đó rất nặng — `pont_collision` (shapely),
`die_detection`, `sticker_imposer_pkg`, `nup_engine` — nạp ở mức module nghĩa là **mọi lần khởi động
sidecar đều trả giá** dù người dùng không bình tem. Đó là lazy-load có chủ đích, và chuyển hàng loạt
là đánh vào đúng thứ người dùng cảm nhận được (thời gian mở app). Giữ nguyên.

**2. Cụm nhỏ nhất tách được vẫn có bẫy.** Ứng viên an toàn nhất là quản lý job N-Up (`nup_jobs`,
`_purge_old_nup_jobs`, `_spawn_nup_process`, `_terminate_nup_process`, `_read_nup_state`,
`_nup_process_worker`) — hạ tầng, không có toán hình học. Nhưng `tests/test_nup_job_lifecycle.py`
monkeypatch `imposition._NUP_SUBMISSION_SLOTS` ở 4 chỗ; nếu `_spawn_nup_process` sang module khác thì
nó đọc global của module MỚI, bản patch trỏ sai chỗ → **test vẫn xanh mà không còn kiểm hành vi hàng
đợi đầy**. Refactor xanh nhưng mất lưới an toàn còn tệ hơn không refactor.

Kết luận: rút `routes/imposition.py` cần một kế hoạch riêng (spec) với việc rewire test đồng thời một
cách có ý thức, không nhét vào lô audit — nhất là khi file nằm trên đường xuất file.

**Việc đã làm thay thế:** `backend/tests/test_god_file_ratchet.py` — khoá trần số dòng hiện tại cho 9
file dài nhất (`imposition.py` 4136, `nup_engine.py` 3716, `stream_editor.py` 3713…), trần chỉ được
HẠ không được nâng, kèm test canh `routes/imposition.py` không thêm endpoint mới (trần 18). Cùng tinh
thần với `npm run lint:budget` của desktop: chặn bệnh nặng thêm trong khi chờ chữa.

**Verify:** 19 passed.

---

## Lô 10 — §D.1: **đổi hướng** — chốt lệch lockfile thay vì gộp workspace

Gộp Cargo workspace không phải thay đổi cơ học như báo cáo giả định. Ràng buộc thật:

- `run_dev.bat:52` gõ cứng `desktop\src-tauri\target\debug\pdf-inspector.exe`;
  `build_production.ps1` và `release_update.ps1` gõ cứng `desktop\src-tauri\target\release\...`
  (installer NSIS, exe để hash, bundle). Workspace dồn `target/` về gốc → **vỡ cả đường phát hành**.
- `release_update.ps1:117` regex-sửa `desktop\src-tauri\Cargo.lock` để bump version; workspace xoá
  các lockfile con.
- CI **cố tình** quét đúng bốn lockfile (`cargo audit -f "$lock/Cargo.lock"` cho 4 crate) và chạy
  `cargo test --manifest-path ... --locked` từng crate.

Nghĩa là chi phí là viết lại đường phát hành + phải kiểm bằng một lượt build và cài installer thật,
trong khi lợi ích (một lockfile, target dùng chung) không cấp bách.

**Việc đã làm thay thế** — chặn đúng rủi ro mà workspace định chặn:

| File | Thay đổi |
|---|---|
| `scripts/check_cargo_lock_skew.py` | **Mới.** Đọc 4 lockfile, so phiên bản 12 crate dùng chung (`imposition_core`, `print_engine`, `geo`, `pdfium-render`, `serde`, `image`, `rayon`, `lopdf`, `tiny-skia`, `lcms2`, `ttf-parser`, `serde_json`). Lệch **minor/major** → exit 1 (nguy hiểm thật: crate hình học lệch minor = preview và tờ in tính khác nhau). Lệch **patch** → cảnh báo, `--strict` mới chặn |
| `.github/workflows/ci.yml` | Thêm bước "Lệch phiên bản crate dùng chung giữa 4 lockfile" trong job `rust-audit` |

Kết quả chạy thật: `geo`, `imposition_core`, `pdfium-render`, `image` **đồng bộ** (phần quan trọng);
lệch patch ở `serde` (1.0.228 vs 1.0.229) và `serde_json` (1.0.150 vs 1.0.151) → cảnh báo, không chặn.

**Kèm §E — sửa comment mojibake.** `desktop/src-tauri/Cargo.toml` có 4 dòng comment tiếng Việt bị mã
hoá lặp nhiều lần thành chuỗi rác (`kÃƒÆ’Ã†â€™...`), vi phạm rule #4. Đã viết lại đúng nội dung gốc
(gate license Ed25519 lớp 2; lý do pin `webview2-com` đúng version tauri/wry resolve).

**Verify:** `cargo metadata --no-deps` OK cho cả 4 manifest; script chạy đúng ở cả hai chế độ.

---

## Lô 11 — §B.1: parity booklet TS ↔ Rust

**Đính chính phạm vi.** Báo cáo nói "đường booklet vẫn tính layout bằng TS trong khi export đi Rust".
Khảo sát cho thấy chính xác hơn: booklet có **engine TS riêng** (`GeometricSolver` + `VirtualMap` +
`SpreadPlacer` → `InstructionSerializer` sinh instruction set JSON → backend `plan_executor` thực
thi). Đó là kiến trúc hợp lệ "client lập kế hoạch, server dựng", **không** phải bản trùng của solver
Rust — solver Rust không tham gia đường booklet.

Rủi ro thật hẹp hơn nhưng vẫn có: `NupGridSolver.solveOptimalNupLayout` được `ProductAdvisor` gọi để
trả lời **"1 tờ mấy con"** cho người dùng, trong khi tờ in thật do Rust tính. Chính docstring của hàm
đó thừa nhận bản TS **đã drift** (thiếu nhánh `'ARROW'` mà orchestrator Rust có). Tư vấn lệch với tờ
in là loại lỗi thợ chỉ phát hiện sau khi đã tin con số.

| File | Thay đổi |
|---|---|
| `imposition_core/tests/grid_parity.rs` | **Mới.** 12 case phủ tình huống nhà in (tem 50×30 trên tờ 320×450, card trên A3, khổ vừa khít, phải xoay 90° mới ăn nhiều hơn, gap lớn hơn con, tờ dài hẹp kiểu băng decal, con lớn hơn tờ…). Có chế độ `PRYNX_BLESS_PARITY=1` để sinh lại fixture khi đổi thuật toán có chủ đích |
| `imposition_core/tests/fixtures/grid_parity_simple_auto.json` | **Mới.** Fixture do **Rust** sinh (nguồn chân lý) |
| `desktop/src/lib/imposerEngine/NupGridSolver.parity.test.ts` | **Mới.** Đọc CÙNG fixture đó, so `totalItems` + `overallWidth/Height` của bản TS |

Cơ chế parity bắc cầu: hai bên cùng đối chiếu một fixture nên không cần gọi Rust từ vitest (vitest
không có toolchain Rust). CI đã chạy `cargo test --manifest-path imposition_core/Cargo.toml --locked`
nên test Rust mới tự vào CI, không cần sửa workflow.

Phạm vi cố tình hẹp: chỉ `strategy='simple_auto'` — strategy duy nhất `ProductAdvisor` dùng. Nhánh
shape (`optimal_auto`) chỉ còn trên đường legacy TS; mở rộng parity sang đó là việc riêng.

**Kết quả:** 12/12 case **khớp**. Tin tốt — drift mà docstring cảnh báo không ảnh hưởng nhánh
`simple_auto`, tức con số "1 tờ mấy con" hiện đang đúng. Từ nay nếu lệch thì CI bắt được ngay.

**Verify:** `cargo test --test grid_parity` → 1 passed; `npx vitest run NupGridSolver.parity.test.ts`
→ 14 passed.

---

## Verify tổng cuối đợt (2026-07-29)

| Kiểm | Kết quả |
|---|---|
| `backend` `pytest tests` | **1667 passed, 5 skipped** (đầu đợt: 1590) |
| `desktop` `npm run typecheck` | sạch |
| `desktop` `npx vitest run` | **147 file, 1367 passed, 2 skipped** |
| `cargo test imposition_core --test grid_parity` | 1 passed |
| `cargo metadata --no-deps` × 4 manifest | OK |
| `scripts/check_cargo_lock_skew.py` | OK (chỉ cảnh báo lệch patch serde) |

**Lưu ý khi đọc lại nhật ký này:** trong lúc đợt sửa chạy, một phiên khác đang sửa
`desktop/src/stores/useBoxStore.ts` (tính năng biến thể hộp, tag `[VARIANT 2026-07-29]`) và thêm
`docs/BAO_CAO_AUDIT_UPSCALE_DO_NET_2026-07-29.md`. Một lượt `typecheck` của tôi từng đỏ ở
`useBoxStore.ts:208` vì bắt đúng trạng thái nửa vời của phiên đó; chạy lại thì sạch. Không phải hồi
quy của đợt này.

## Còn nợ sau đợt này

1. **§A.1** — rút logic layout khỏi `routes/imposition.py`: cần spec riêng, kèm kế hoạch rewire
   `test_nup_job_lifecycle.py`. Ratchet đang chặn phình thêm.
2. **§A.2** — còn ~58 endpoint JSON chưa có model (`preflight` 16, `imposition` 13, `edit` 7, còn lại
   3), và **request** model vẫn khai rải rác trong file route (chưa gom về `schemas/`).
3. **§A.2b** — 26/239 file component vẫn tự `fetch` bỏ qua `lib/api.ts`.
4. **§D.1** — gộp Cargo workspace: chỉ nên làm cùng lượt viết lại `build_production.ps1` /
   `release_update.ps1` / `run_dev.bat` và kiểm bằng một bản cài thật.
5. **§B.3** — 6 thư viện PDF ở webview + đường ghi PDF phía frontend (`pdfImposer.ts`) đang được rào
   bằng `FE_SIZE_LIMIT = 50MB` thay vì ranh giới kiến trúc.
6. **§C.1** — còn các file `import pypdfium2` chưa bọc `pdfium_guard` (4 file route + workers chạy
   trong process riêng). Bọc khi chạm tới, theo rule #3 mới.
7. Nới slot việc nặng cho máy ≥16 GB và xoá rác trên đĩa — hai quyết định chờ bạn (mục "Cần quyết định").

---

## Lô 12 — dọn nợ còn lại (§C.1 phần cuối, §A.2b, §C.3b, §F)

### §C.1 — phủ hết các đường chạm PDFium trong process server

| File | Chỗ bọc `pdfium_guard` |
|---|---|
| `routes/preflight.py` | `/page-svg`, `/svg-by-path`, và render của `/preview-hide` (encode JPEG **trong** khóa vì `to_pil()` có thể tham chiếu bitmap) |
| `routes/edit.py` | `_render_clip_blocking` → wrapper mỏng quanh `_render_clip_blocking_locked`. **Giữ nguyên tên hàm** vì `core/edit_session.py` import đúng tên đó |
| `routes/export.py` | Khóa theo TỪNG TRANG + mở/đóng riêng. Xuất 200 trang ở 600 DPI mà giữ khóa cả lượt sẽ chặn mọi preview; `.convert()` trả ảnh mới nên ghi file làm ngoài khóa |
| `routes/imposition.py` | `/unlock-pdf` — **trường hợp duy nhất trong repo dùng PDFium để GHI** (`FPDF_REMOVE_SECURITY`), càng không được chạy song song |
| `core/pdf_processor.py` | 2 hàm convert + `PDFDocumentReader` (`__enter__`/`__exit__`/`render_page`/`render_page_cmyk`), khóa theo từng trang |
| `core/outline_fonts.py` | `flatten_annotations_and_forms` + `count_live_text` — wrapper mỏng (thân hàm không đổi một dòng) |
| `core/channel_remover.py` | Render preview ΔE; resize LANCZOS để ngoài khóa |

Còn lại `workers/{nup_engine,pdf_ops,pdf_tools_engine,sticker_engine,vdp_engine,vdp_preview}.py` —
chạy trong **process con** riêng nên mỗi process có PDFium riêng, không cần guard. Sẽ bọc nếu có
đường nào được gọi in-process.

### §A.2b — ratchet ranh giới tầng API

`desktop/scripts/lint/check-api-layer.mjs` (**mới**): đếm file trong `src/components/` tự dựng URL
bằng `getApiUrl()`. Trần **26** = hiện trạng, kèm danh sách tên file. Thêm file mới → fail và in
đúng tên file mới. Dọn xong một file mà không hạ trần → cũng fail (nếu không ratchet mất tác dụng).

Vì sao ratchet chứ không sửa 26 file ngay: chuyển hết nghĩa là thêm ~40 hàm vào `api.ts` và chạm 26
component trong một lô — churn lớn, rủi ro không tương xứng. Cùng khuôn `check-budget.mjs` đã có.

### §C.3b — nới trần việc nặng cho máy mạnh, kèm cách ly loại việc

Đây là quyết định còn treo từ lô 5. Khảo sát lại cho thấy nới trần toàn cục **một cách ngây thơ là
sai**: `heavy_job_slot` gate CẢ `nup`/`vdp`/`compare` — mỗi job loại này đã mở tới `cpu-1` process,
nên trần toàn cục 2 hôm nay đã cho phép 1 nup + 1 VDP song song (~2×(cpu-1) process). Nới lên 3–4 mà
không cách ly là nhân tiếp con số đó.

Nên làm ba việc cùng lúc trong `core/heavy_job_scheduler.py`:

1. **Trần toàn cục gate theo RAM**: `<8GB`→1, `<16GB`→2, `>=16GB`→**3**, `>=64GB`→**4**
   (trước: hằng số 2). Env `PRYNX_MAX_HEAVY_JOBS` vẫn thắng.
2. **Nhóm "dùng hết máy"** (`nup`, `vdp`, `compare`) chia nhau **đúng 1 suất** — chặt hơn hiện trạng,
   nên đây vừa là điều kiện để nới, vừa là một **sửa lỗi**.
3. **`office` được cách ly 1 suất riêng**: `routes/pdf_tools.py` đổi 2 endpoint chuyển đổi Office
   sang `run_scheduled_in_threadpool("office", ...)` thay vì kind `pdf-tools`. Nhiều instance
   COM/LibreOffice là nguồn treo đã có lịch sử → việc nới trần toàn cục KHÔNG chạm đường này.

Thứ tự lấy khóa cố định: **trần phụ trước, suất toàn cục sau**. Đảo lại sẽ khiến một job
dùng-hết-máy đang chờ vẫn chiếm suất toàn cục, chặn cả việc nhẹ. Cả hai lớp đều nhả trên mọi nhánh
thoát, kể cả ngoại lệ khi đang chờ.

Kết quả trên máy dev (32 GB): việc nhẹ được 3 suất song song thay vì 2; nup/VDP/compare siết từ
"2 job cùng lúc" xuống 1; chuyển đổi Office vẫn tuần tự như trước.

Test mới `tests/test_heavy_scheduler_kind_gate.py` (8 test): nhóm dùng-hết-máy đúng 1 job, `office`
đúng 1, việc nhẹ KHÔNG bị kẹp về 1, trộn 8 job nhiều loại không deadlock, nhả đủ hai lớp khóa khi có
ngoại lệ, và trần toàn cục gate đúng theo 4 mốc RAM.

**Lưu ý cần kiểm thực địa:** đây là thay đổi hành vi đồng thời mà test đơn vị không thay được máy
thật. Nên chạy thử trên máy khách một lượt: 2–3 tác vụ resize/tách nền/upscale cùng lúc + 1 job bình
bản, xem có chậm bất thường hay treo không. Muốn quay về hành vi cũ ngay: đặt `PRYNX_MAX_HEAVY_JOBS=2`.

### §F — dọn rác trên đĩa (đã xoá thật)

Đã xoá (đều **untracked**, tổng ~0,6 MB): `backend/_atm2`, `backend/_atm4`, `backend/_audit_tmp2`,
`backend/debug`, `backend/temp`, `_to_delete/`, `terminals/`, `backend/ocr_raw.txt`,
`backend/ocr_pre.txt`.

**KHÔNG xoá** (có lý do): `uploads/`, `results/`, `logs/`, `data/` — có thể chứa file khách hoặc dữ
liệu runtime của bản đang chạy. `backend/t.txt` **được git theo dõi** nên xoá là thay đổi repo, để
bạn quyết.

### Ratchet đã bắt chính đợt sửa này — hai lần

Ratchet god-file (lô 9) fail 3 lần trong đợt: các guard §C.1 làm `imposition.py` +5,
`preflight.py` +19, `edit.py` +19, `channel_remover.py` +5, và cách ly kind `office` làm
`pdf_tools.py` +11 dòng. Đã nâng trần đúng các file đó **kèm lý do ghi trong file test**: thêm lưới
an toàn cho một bất biến ≠ nhồi tính năng mới. Ghi lại để lần sau không ai lấy tiền lệ này.

Lần thứ ba đáng chú ý hơn: `sticker_engine.py` tăng **130 dòng** (`git diff`: +298/−94) mà đợt này
không hề chạm — đó là **phiên khác đang làm song song**. Mốc ratchet vì vậy được lấy trong lúc cây
làm việc đang động; **nếu nhánh đó còn dở thì lấy lại mốc một lần nữa sau khi nó land** (đã ghi chú
ngay trong `CEILINGS`).

**Verify lô 12:** `pytest tests/test_god_file_ratchet.py tests/test_heavy_scheduler_kind_gate.py
tests/test_pdfium_lock.py tests/test_api_contract.py tests/test_worker_ram_gating.py` → 95 passed;
`tsc --noEmit` sạch; `check-api-layer.mjs` pass (26/26); `npx vitest run` → 147 file, 1367 passed.

---

## Lô 13 — dọn hết nợ còn lại (trừ `routes/imposition.py`)

### §A.2 — phủ nốt response model

| Nhóm | Trước | Sau |
|---|---|---|
| `edit.py` | 12/19 | **19/19** |
| `preflight.py` | 22/38 | **29/38** |
| `export.py` | 0/1 | **1/1** |
| `results.py` | 3/5 | **4/5** (còn 1 là `FileResponse`) |

Model mới: `schemas/edit.py` (+`PageObjectsPayload`, `TextObjectPropsResponse`,
`OcgVisibilityResponse`, `OcgActionResponse`, `DiscardWorkingFileResponse`,
`SessionCloseResponse`), `schemas/export.py` (`ExportImagesResponse`), `schemas/job.py`
(`DeleteJobResponse`), `schemas/preflight.py` (+`FixFileWithLogResponse`, `ExportPdfxResponse`,
`PageBoxesResponse`, `OcgLayerTreeResponse`, `PdfxComplianceResponse`).

Vẫn **cố tình** không gắn: `/preflight/{download,page-svg,svg-by-path}` (trả `Response`/`FileResponse`),
`/preflight/preview-layers` + `/softproof` + `/separations*` + `/detect-crop-regions` (có nhánh trả
kiểu khác hoặc dict do engine dựng — `/detect-crop-regions` còn có nhánh `return None`),
`/dieline/generate` (trả nguyên `DielineModel` do engine JS sinh; đã khai `-> dict[str, Any]`, gắn
model chặt sẽ cắt mất field), `/ws/...` (WebSocket).

### §A.2 — gom request model về `schemas/`

Đã chuyển **47 pydantic model** từ file route sang `schemas/`: `preflight` 30, `edit` 13, `qc` 3,
`export` 1. File route import lại tường minh nên **mọi đường import cũ (kể cả test) vẫn dùng được**.
`schemas/qc.py` là file mới.

Làm bằng script AST một lần, có **kiểm chứng trước/sau**: ghi lại tập field của từng model, cắt đúng
đoạn source theo `lineno/end_lineno` (không regex), rồi import lại và so tập field — lệch một field
là abort. Đã bắt được 2 lỗi thiếu import (`List`/`Dict` ở `schemas/preflight.py`, `Optional` ở
`schemas/export.py`) đúng nhờ bước kiểm chứng đó. Xác minh cuối: `route.FixRequest is
schemas.FixRequest` cho 7 model đại diện.

### §B.3 — bỏ engine PDF thứ hai + hai phantom dependency

Kiểm thật từng thư viện: `@pdfme/generator`, `@pdfme/common`, `@turf/polygonize` được dùng ở **0 file
source** — chỉ còn tên trong `package.json` và `vite.config.ts` (`optimizeDeps.include`).
`@turf/polygonize` còn bị chính comment trong `lib/dieline/tracePerimeter.ts` nói đã bị thay bằng
thuật toán nối chuỗi tự viết. `npm uninstall` ba package → **loại 35 package**, `npm audit` 0 lỗ.

`npm run build` sau đó **đỏ**, và đó là phần giá trị nhất của đợt này:

1. `src/engine/barcode/barcodeEngine.ts` import `bwip-js` — package **chưa từng được khai** làm
   dependency trực tiếp, nó vào repo theo đường transitive qua `@pdfme/schemas` (peer của
   `@pdfme/generator`). Bỏ pdfme là mất luôn bwip-js. Đã khai `bwip-js@4.10.1` (pin exact) làm
   dependency trực tiếp — đúng ra phải như vậy từ đầu, bất kể pdfme.
2. `src/engine/barcode/barcodeWorker.ts` import `jszip` — package **chưa từng có trong lockfile**
   (`git show HEAD:desktop/package-lock.json` không có `node_modules/jszip`), và **không file nào
   import `barcodeWorker`**. Tức đây là code chết với import vỡ: ai nối nó vào là build đứt ngay.
   Có `@ts-nocheck` nên typecheck chưa bao giờ kêu. **Đã xoá** (file có trong git, hoàn lại được nếu
   là việc đang dở).

Còn lại 5 thư viện PDF ở webview (`pdf-lib` 37 file, `diff` 28, `react-pdf` 10, `pdfjs-dist` 7,
`jspdf` 7, `svg2pdf.js` 6) — tất cả đều có người dùng thật. Hợp nhất chúng là thay đổi thiết kế
(react-pdf bọc pdfjs; jspdf+svg2pdf phục vụ SVG→PDF của khuôn bế), không phải dọn rác, nên để nguyên.

### Ratchet: gỡ `sticker_engine.py` khỏi trần

File này bị nhánh khác sửa liên tục trong buổi (đo 3252 → 3382 → **3390** dòng). Khoá trần trên file
đang thay đổi chỉ tạo test đỏ nhiễu chứ không tạo áp lực. Đã chuyển sang danh sách `_HOAN_LAI` kèm
test nhắc **đưa lại vào `CEILINGS` sau khi nhánh đó land**. Các trần khác nâng theo phần import model
mới (`preflight` 1660, `edit` 1432).

### Verify lô 13

| Kiểm | Kết quả |
|---|---|
| `backend` `pytest tests` | **1674 passed, 5 skipped** |
| `desktop` `npm run typecheck` | sạch |
| `desktop` `npm run build` (tsc + vite build) | **thành công** — đây là chốt bắt được 2 phantom dependency |
| `desktop` `npx vitest run` | **147 file, 1368 passed, 2 skipped** |
| `desktop` `check-api-layer.mjs` | pass (26/26) |
| `desktop` `npm run lint:budget` | pass |

**Nhiễu do phiên song song (lần thứ ba):** một lượt `vitest` giữa đợt đỏ 4 test property-based của
khuôn bế; chạy lại ngay sau đó xanh hết. Cùng nguyên nhân với lần typecheck đỏ ở `useBoxStore.ts`:
nhánh khác đang sửa `ParamPanel.tsx`/`DielineScene3D.tsx`/`useBoxStore.ts`. Không phải hồi quy của
đợt này.

## Còn nợ sau lô 13

1. **`routes/imposition.py`** — theo yêu cầu, để riêng. Cần spec: rút logic layout ra `core/`, kèm kế
   hoạch rewire `test_nup_job_lifecycle.py` (monkeypatch `_NUP_SUBMISSION_SLOTS`). Ratchet đang chặn
   phình thêm (trần 4141 dòng / 18 endpoint). 13 endpoint của nó cũng chưa có `response_model`.
2. **§D.1 Cargo workspace** — chỉ nên làm cùng lượt viết lại `build_production.ps1` /
   `release_update.ps1` / `run_dev.bat` và kiểm bằng một bản cài thật. Chốt lệch lockfile đang canh
   rủi ro thay thế.
3. **§A.2b** — 26 component vẫn tự gọi backend; ratchet chặn thêm mới, dọn dần thì hạ trần.
4. **Đưa `sticker_engine.py` lại vào ratchet** sau khi nhánh song song land.
5. **Kiểm thực địa §C.3b** — trần việc nặng mới (3 slot trên máy ≥16GB) cần một lượt chạy thật.

---

## Lô 14 — bản production build để đóng chốt verify

Mục đích: trả lời dứt điểm "đã dùng được chưa". Test đơn vị không thay được hai thứ — bản đóng gói
(Nuitka + maturin + tauri + NSIS) và một lượt chạy thật.

Chạy: `build_production.ps1 -AllowPlaintextDieline -NoOpenExplorer` (KHÔNG `-Release`).

**Vì sao phải có `-AllowPlaintextDieline`:** máy này không có `PRYNX_SUPABASE_URL` /
`PRYNX_SUPABASE_SERVICE_KEY` nên script fail-closed từ chối build khi không khoá được engine dieline.
Cờ này là đường thoát dành cho dev. Hệ quả: **installer sinh ra CHỈ để kiểm chứng, KHÔNG được phát
hành** — engine dieline ở dạng plaintext.

### Sửa kèm: một cổng phát hành fail theo tải máy

Lượt build đầu **đứt ở cổng Preflight QA**, nhưng không phải vì kết quả sai:

```
FAILED tests/test_image_dpi_props.py::test_effective_dpi_formula_and_min
  hypothesis.errors.FailedHealthCheck: Input generation is slow:
  Hypothesis only generated 8 valid inputs after 2.57 seconds.
```

`too_slow` đo **thời gian thực** khi sinh dữ liệu, nên nó fail khi MÁY đang tải nặng chứ không phải
khi test chậm thật. Hai strategy trong file đó là `integers`/`floats` thuần, không `assume`, không
filter — chạy riêng cả file mất **1,6s**, và nó pass trong mọi lượt `pytest tests` trước đó (1674
passed). Nhưng `build_production.ps1` gọi bộ test này NGAY SAU các bước build ngốn CPU.

Một cổng phát hành có thể fail oan theo tải máy là cổng không dùng được: lần sau người build sẽ học
cách `-SkipPreflightQA`, và thế là mất luôn lớp bảo vệ thật. Đã tắt **chỉ** `HealthCheck.too_slow`
cho hai test đó, giữ nguyên `max_examples=100` (độ phủ không giảm) và mọi health check khác.

Đây là lỗi có sẵn, không do đợt audit sinh ra — nhưng nó chỉ lộ khi có người thật sự chạy pipeline
đóng gói, nên ghi lại ở đây.
