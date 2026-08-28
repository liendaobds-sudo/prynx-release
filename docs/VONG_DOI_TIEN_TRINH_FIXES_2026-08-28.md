# Nhật ký sửa — Vòng đời tiến trình khi tắt app và khi cập nhật (2026-08-28)

Báo cáo gốc: `BAO_CAO_AUDIT_VONG_DOI_TIEN_TRINH_UPDATE_2026-08-28.md` (đã được chủ dự án duyệt
toàn bộ 6 lô). Tag truy vết trong code: `[PROC-LIFECYCLE FIX 2026-08-28 §UP.x]`.

Triệu chứng gốc: tắt PrynX rồi vẫn còn tiến trình ngầm trong Task Manager; cập nhật bản mới
bị kẹt; sau đó app không mở lên được, phải gỡ cài đặt và cài lại.

---

## Lô 1 — Chặn brick khi cập nhật (§UP.1, §UP.2, §UP.3, §UP.9, §UP.10)

| File | Thay đổi | Vì sao |
|---|---|---|
| `desktop/src-tauri/installer-hooks.nsh` | Đổi `taskkill /IM "PrynX.exe"` → `pdf-inspector.exe`; **đảo thứ tự** app trước sidecar sau; thay `Sleep 800` bằng macro `PRYNX_KILL_UNTIL_GONE` (12 × 250 ms, kiểm lại bằng `tasklist \| find`); thêm `NSIS_HOOK_PREUNINSTALL` dọn cả hai tiến trình khi gỡ cài | Không có file `PrynX.exe` — `MAINBINARYNAME` là `pdf-inspector` (từ `[package].name`), `PrynX` chỉ là `productName`. Lệnh cũ luôn "not found" nên app + display/print worker sống sót qua hook. Và diệt sidecar trước là vô nghĩa: app còn sống thì supervisor respawn sidecar sau 250 ms, tức trước khi `Sleep 800` hết → NSIS ghi vào file vừa bị chiếm lại |
| `desktop/src-tauri/src/lib.rs` | Thêm command `prepare_for_update` (đặt `SIDECAR_SHUTDOWN` → `kill_sidecar()` → dọn display worker) và đăng ký trong `invoke_handler` | `install()` của tauri-plugin-updater kết thúc bằng `std::process::exit(0)`; hook duy nhất nó gọi trước đó là `cleanup_before_exit()` — hàm này chỉ clear resource table + ẩn cửa sổ, **không** phát `RunEvent::Exit`. Nghĩa là chốt dọn duy nhất của app không bao giờ chạy trên đường cập nhật |
| `desktop/src/components/UpdateChecker.tsx`, `AboutModal.tsx` | Tách `downloadAndInstall()` thành `download()` → `invoke('prepare_for_update')` → `install()`; bỏ `relaunch()` | Cần một điểm chèn để dọn tiến trình con sau khi tải xong, trước khi trình cài chạy. `relaunch()` là code chết vì tiến trình đã `exit(0)`; trình cài tự mở lại app bằng cờ `/R` |
| `desktop/src-tauri/tauri.conf.json` | Ghim `plugins.updater.windows.installMode = "passive"` | Trước đây dựa vào mặc định của plugin. Ghim tường minh để bản nâng plugin sau không âm thầm đổi chế độ (`basicUi` cho NSIS không truyền cờ nào, mất luôn `/R` tự mở lại app) |

Verify: `makensis /V2` compile sạch macro mới (script stub tạm, đã xóa); đã đo thật exit code
của `tasklist … | find` (1 khi không còn tiến trình, 0 khi còn) nên vòng chờ dừng đúng lúc;
`cargo check` không lỗi; `tsc --noEmit` sạch.

## Lô 2 — Đường thoát không được treo (§UP.4)

| File | Thay đổi | Vì sao |
|---|---|---|
| `desktop/src-tauri/src/pdf_engine/render_worker.rs` | `shutdown_render_worker()` dọn **song song** với deadline chung `RENDER_WORKER_SHUTDOWN_GRACE = 1500 ms`; thêm `kill_render_worker_pid` (taskkill theo PID) và `wait_child_bounded` (poll `try_wait`, nhả lock giữa các nhịp) | Cũ: mỗi slot dọn tuần tự bằng `request(Shutdown)` rồi `child.wait()`, **cả hai không có trần** — `request` chặn ở `read_frame` trên stdout worker, `wait` chặn tới khi worker chết. Một worker kẹt (PDFium đang render trang nặng, pipe đầy, driver treo) là đủ để hàm không bao giờ trả về |
| `desktop/src-tauri/src/lib.rs` | `RunEvent::Exit`: `kill_sidecar()` chạy **trước** `shutdown_render_worker()` | Thứ tự cũ khiến worker kẹt là mất luôn `kill_sidecar()`. Sidecar mới là tiến trình khóa file lúc NSIS ghi bản mới và là tiến trình ngốn RAM còn lại |

Đường diệt cứng cố tình đi qua PID (`taskkill`) chứ không qua `Mutex<Child>`: luồng dọn có thể
đang giữ lock đó, nếu đường diệt cũng phải lock thì deadline mất tác dụng.

Verify: `cargo check` 0 lỗi; `cargo test --lib` 164 pass / 0 fail.

## Lô 3 — Job Object cho sidecar và worker (§UP.7)

| File | Thay đổi |
|---|---|
| `desktop/src-tauri/src/process_guard.rs` (mới) | Job Object toàn tiến trình với `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, API `adopt_child_process(pid)`; fail-open (chỉ log) nếu không dựng/gán được |
| `desktop/src-tauri/Cargo.toml` | Thêm feature `Win32_System_JobObjects`, `Win32_System_Threading`, `Win32_Security` cho crate `windows` |
| `desktop/src-tauri/src/lib.rs` | Khai báo `mod process_guard`; gán sidecar vào job ở cả cold-start và mỗi lần supervisor respawn |
| `desktop/src-tauri/src/pdf_engine/render_worker.rs` | Gán display worker vào job ngay sau `spawn` |
| `desktop/src-tauri/src/pdf_engine/print_worker.rs` | Gán print worker vào job ngay sau `spawn` |

Đây là bản vá **gốc**: mọi cách dọn bằng `taskkill` chỉ chạy khi app còn kịp thực thi code, mà
ba đường thoát đã xảy ra thật trên máy khách không cho cơ hội đó — crash (Event Log 18/07 và
19/08/2026), treo rồi bị kết thúc (Application Hang 01/08/2026 hai lần), và `exit(0)` của plugin
updater. Job Object để chính kernel dọn: handle job không cho kế thừa và chỉ tiến trình app giữ,
nên app chết vì bất kỳ lý do gì là cả job bị kill. Con của tiến trình trong job tự vào job, nên
cây worker Python (`ProcessPoolExecutor`, `multiprocessing`) và `soffice.exe` do sidecar spawn
cũng được dọn theo. Từ đây `taskkill` chỉ là lưới phụ.

Gán ngay sau `spawn` là có chủ ý: tiến trình cháu sinh ra trước lúc gán sẽ không thuộc job.

Verify: test mới `tien_trinh_con_duoc_gan_vao_job` dùng `IsProcessInJob` xác nhận tiến trình con
thật sự nằm trong job (không chỉ "API trả Ok"); `cargo test --lib` 165 pass / 0 fail.
Ghi chú: bản thân `KILL_ON_JOB_CLOSE` không kiểm được bằng unit test (phải để tiến trình cha
chết mới thấy) — phần đó thuộc kiểm tay runtime ở mục cuối.

## Lô 4 — Phục hồi thay vì brick, và để lại dấu vết (§UP.5, §UP.8)

| File | Thay đổi | Vì sao |
|---|---|---|
| `desktop/src-tauri/src/lib.rs` | Thêm `build_startup_error_command` + `show_startup_error_dialog`; đổi thông điệp khi integrity lệch thành hướng dẫn "chạy lại trình cài đặt, KHÔNG cần gỡ cài"; nhánh port 8321 bị chiếm nâng trần chờ 1 s → 3 s, **thêm `startup_breadcrumb`** và hướng dẫn cụ thể | Chốt fail-closed giữ nguyên, chỉ đổi thông điệp: nguyên nhân thực tế phổ biến nhất của nhánh integrity không phải bị crack mà là bản cập nhật đứt giữa. Nhánh port trước đây **không ghi breadcrumb nào** — đó là lý do `startup_debug.log` của lần sự cố chỉ có "process entry" rồi im lặng |

Hai ràng buộc của hộp thoại được ghi thẳng vào docstring vì đã trả giá: chuỗi phải ASCII không
dấu (tham số qua dòng lệnh PowerShell làm hỏng ký tự có dấu) và chỉ dùng nháy đơn + ghép
`[char]10` (chuỗi nháy đơn PowerShell không nội suy nên `$([char]10)` sẽ hiện nguyên văn; dùng
nháy kép thì phải đấu với cách Windows quote tham số).

Verify: 2 test mới `startup_dialog_tests` khóa đúng cách escape và cấm nháy kép lọt vào lệnh.

## Lô 5 — Vá lỗ single-instance (§UP.6)

| File | Thay đổi |
|---|---|
| `desktop/src-tauri/src/lib.rs` | Thêm mutex canh riêng `claim_primary_instance_mutex()` (gọi trước `tauri::Builder`) + cờ `SECONDARY_INSTANCE`; bản release từ chối khởi động instance thứ hai khi instance đang chạy không phản hồi |

`tauri-plugin-single-instance` 2.4.2: khi mutex của nó đã tồn tại nhưng `FindWindowW` không thấy
cửa sổ ẩn của instance kia, plugin **đi tiếp** mà không giữ mutex và không tạo cửa sổ đích — từ
đó nhiều instance đầy đủ cùng chạy. Hậu quả trong PrynX: mỗi cold-start đều
`taskkill /IM pdf-inspector-backend.exe /F` để dọn zombie, nên instance mới **giết sidecar của
instance đang dùng**; supervisor bên kia gặp listener lạ rồi `Stop` — backend chết hẳn.

Không vá được crate vendor nên chặn phần phá hoại: mutex tên **riêng** (trùng tên với plugin sẽ
làm sập cơ chế của plugin ở instance đầu tiên) chỉ để biết "đã có tiến trình app PrynX khác đang
sống". Tới được `setup` với cờ đó bật ⇒ plugin đã không forward được và không exit ta ⇒ instance
kia đang treo ⇒ dừng lại và hướng dẫn, thay vì phá sidecar của nó.

Verify: `cargo check` sạch; `cargo test --lib` 167 pass / 0 fail.

## Lô 6 — Tiến trình Office/soffice mồ côi (§UP.11)

| File | Thay đổi |
|---|---|
| `backend/app/core/office_job_runner.py` | Thêm `sweep_orphan_office_pids()`, `_image_name_of_pid()` và whitelist `_ORPHAN_IMAGE_WHITELIST` |
| `backend/app/main.py` | Gọi sweep trong `lifespan` startup, không chặn khởi động nếu lỗi |
| `backend/tests/test_office_orphan_sweep.py` (mới) | 6 test |

Word/Excel do COM `DispatchEx` khởi tạo **không** phải con của sidecar (DCOM sinh chúng dưới
svchost) nên không cây process nào — kể cả Job Object của Lô 3 — dọn được. Đường dọn duy nhất
(`_terminate_process_tree`) viết bằng Python nên chỉ chạy khi sidecar còn sống; sidecar bị
`taskkill /F` giữa job Office thì chúng sống mãi.

File `*.owned-pids` là dấu vết duy nhất còn lại (khối `finally` của `_run_isolated` luôn xóa khi
job kết thúc bình thường). Sweep chỉ diệt PID có image name trong whitelist Office — chống giết
oan khi Windows đã cấp lại PID cho tiến trình khác. Test có ca `chrome.exe` giữ đúng bất biến đó,
và một test chạy `tasklist` **thật** để parser không âm thầm hỏng khi định dạng đổi.

Verify: `pytest tests/test_office_orphan_sweep.py tests/test_office_job_runner.py` 16 pass;
`py_compile` sạch cho cả hai file backend.

---

## Verify cuối — toàn bộ các tầng bị ảnh hưởng

| Tầng | Lệnh | Kết quả |
|---|---|---|
| Rust | `cargo check` trong `desktop/src-tauri` | 0 lỗi; danh sách warning không đổi so với trước đợt sửa (7 dead-code release-only ở `lib.rs`, 1 ở `render_worker.rs`) |
| Rust | `cargo test --lib` | **167 passed, 0 failed, 5 ignored** (trước đợt: 164) — thêm 1 test Job Object và 2 test escape hộp thoại |
| NSIS | `makensis /V2` trên script stub include `installer-hooks.nsh` | compile sạch (chỉ warning 6020 của chính stub, không phải của hook) |
| TS types | `npx tsc --noEmit -p tsconfig.app.json` | sạch, exit 0 |
| Frontend | `npx vitest run` | **296 file, 3132 passed, 2 skipped, 0 failed** |
| Backend | `venv\Scripts\python -m pytest tests -q` | **4138 passed, 2 skipped, 0 failed** (11 phút 24) |
| Backend | `py_compile app\main.py app\core\office_job_runner.py` | sạch |

Ghi chú trung thực về môi trường: trong lúc làm đợt này có phiên khác đang sửa
`desktop/src-tauri/src/external_app.rs` (§SEC.05). Một lượt `cargo check` giữa đợt từng đỏ vì
file đó, không phải vì các lô ở đây; lượt cuối đã xanh trở lại. Không file nào của phiên khác bị
chạm tới. Chưa commit — working tree còn thay đổi của phiên khác nên việc gom commit để chủ dự án
quyết định.

## Việc còn phải kiểm tay (chưa đạt mức RUNTIME)

Không lô nào trong đợt này được tuyên bố `RUNTIME`. Bốn ca dưới đây cần chạy trên máy thật, và
ca số 1 là ca quan trọng nhất vì nó chính là sự cố gốc:

1. **Cập nhật thật `rc.9 → rc.10`** trên profile/VM sạch: bấm Cập nhật trong app, quan sát
   Task Manager trong lúc trình cài chạy (không được còn `pdf-inspector.exe` /
   `pdf-inspector-backend.exe`), xác nhận không hiện hộp thoại "Error opening file for writing",
   và app tự mở lại sau khi cài xong.
2. **Đóng app trong lúc đang render trang nặng**: sau khi cửa sổ đóng, Task Manager phải sạch cả
   hai tên exe trong vòng vài giây.
3. **Job Object**: mở app, dùng `taskkill /PID <pid_app> /F` (mô phỏng crash) rồi kiểm
   `pdf-inspector-backend.exe` và display worker biến mất theo — đây là phần `KILL_ON_JOB_CLOSE`
   mà unit test không chứng minh được.
4. **Chuyển Office → PDF rồi kill sidecar giữa job**, mở lại app và xác nhận log ghi
   "Đã dọn N tiến trình Office mồ côi".

Ngoài ra: bản vá Lô 1 chỉ có tác dụng **từ bản kế tiếp trở đi** — installer đang nằm ở máy khách
vẫn là bản có hook cũ. Máy đang bị brick hiện tại vẫn phải chạy lại trình cài đặt một lần.
