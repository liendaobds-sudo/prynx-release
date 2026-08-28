# BÁO CÁO AUDIT — Vòng đời tiến trình khi tắt app và khi cập nhật (2026-08-28)

Phạm vi: đường thoát của `pdf-inspector.exe` (app Tauri), sidecar `pdf-inspector-backend.exe`,
display/print worker, và luồng cập nhật (Tauri updater + NSIS). Không chạm nghiệp vụ bình bản/khuôn bế.

Triệu chứng do chủ dự án báo: **tắt PrynX rồi vẫn còn tiến trình chạy ngầm trong Task Manager;
khi cập nhật bản mới thì bị kẹt; sau đó app không mở lên được, phải gỡ cài đặt và cài lại.**

---

## 1. Tóm tắt điều hành

Ba lỗi độc lập xếp thành một chuỗi. Mỗi lỗi tự nó chỉ gây bất tiện; ghép lại thì thành brick phải reinstall.

1. **Cleanup không chạy trên mọi đường thoát.** Toàn bộ việc dọn tiến trình con chỉ móc vào một chốt duy nhất
   `RunEvent::Exit` (`lib.rs:6596`). Đường cập nhật của Tauri updater kết thúc bằng `std::process::exit(0)`
   nên chốt đó **không bao giờ chạy**; đường tắt bình thường thì có thể **treo vô hạn** trước khi tới nó.
   Kết quả: sidecar (và có lúc cả app chính) còn sống trong Task Manager.

2. **Hook installer diệt sai tên tiến trình và diệt sai thứ tự.** `installer-hooks.nsh:18` diệt `PrynX.exe`,
   nhưng binary thật tên `pdf-inspector.exe`. Đồng thời hook diệt **sidecar trước, app sau** — trong khi
   supervisor trong app còn sống sẽ **respawn sidecar sau ~250 ms**, tức là trước khi NSIS kịp ghi file.
   NSIS gặp file đang bị chiếm → hộp thoại Abort/Retry/Ignore trong chế độ passive → user thấy "kẹt".

3. **Update dở dang thì fail-closed vĩnh viễn.** Installer ghi `pdf-inspector.exe` **trước**
   `pdf-inspector-backend.exe`. Nếu ghi sidecar thất bại và user chọn Ignore, ta có exe mới + sidecar cũ.
   Lần mở sau, `verify_sidecar_integrity` so SHA-256 sidecar với hash nung lúc build, lệch → MessageBox +
   `exit(1)` (`lib.rs:6045-6056`). Không có đường tự phục hồi ⇒ **đúng hiện tượng "phải gỡ cài rồi cài lại"**.

---

## 2. Bằng chứng đã đo và bằng chứng còn thiếu

### 2.1 Đã đo trên máy này

| Bằng chứng | Nguồn |
|---|---|
| Binary chính tên `pdf-inspector.exe`, không phải `PrynX.exe` | `desktop/src-tauri/Cargo.toml:2`; `target/release/nsis/x64/installer.nsi:42` (`MAINBINARYNAME "pdf-inspector"`); file thật `target/release/pdf-inspector.exe` (36 MB, 26/08/2026) |
| Installer ghi main exe trước, sidecar sau | `installer.nsi:618` (`File "${MAINBINARYSRCPATH}"`) vs `installer.nsi:749` (`File /a "/oname=pdf-inspector-backend.exe"`) |
| `CheckIfAppIsRunning` chạy **sau** `NSIS_HOOK_PREINSTALL` | `installer.nsi:610-615` |
| Updater kết thúc bằng `std::process::exit(0)` | `tauri-plugin-updater-2.10.1/src/updater.rs:865`; hook trước đó là `cleanup_before_exit` (`plugin lib.rs:107-110`) |
| `cleanup_before_exit()` **không** phát `RunEvent::Exit` (chỉ clear resource table + hide window) | `tauri-2.11.2/src/app.rs:1099-1112` |
| Updater mặc định chế độ passive `/P /R` (repo không set `installMode`) | `tauri-plugin-updater-2.10.1/src/config.rs:41,72`; `tauri.conf.json:107-115` |
| Lỗ single-instance: mutex tồn tại nhưng không thấy HWND ⇒ instance mới **đi tiếp** mà không giữ mutex, không tạo event window | `tauri-plugin-single-instance-2.4.2/src/platform_impl/windows.rs:72-107` |
| `pdf-inspector.exe` đã từng **Application Hang** thật | Event Log Application, ID 1002: 01/08/2026 01:08:28 và 01/08/2026 05:50:23 |
| `pdf-inspector.exe` đã từng crash thật | Event Log ID 1000: 18/07/2026 05:37, 05:38, 05:54 (`0xc0000005`, `0xc000041d`) |
| `pdf-inspector-backend.exe` đã từng crash thật | Event Log ID 1000: 19/08/2026 08:46:40, module `onnxruntime_pybind11_state.pyd`, `0xc0000005` |
| Cleanup thực tế **không chạy** ở một lần tắt release | `%LOCALAPPDATA%\com.prynx.app\logs\PrynX.log`: chỉ **một** dòng `[SIDECAR] Đã dừng cây tiến trình PID=20916` (26/08 02:44:29 UTC) trong khi `startup_debug.log` ghi **hai** phiên release (26/08 09:00:20 và 11:31:19 giờ máy). Phiên 11:31 có sidecar sống tới 19:33 giờ máy (dòng `[SIDECAR-ERR] cleanup` mỗi 30 phút) rồi biến mất **không** kèm dòng kill |
| Sidecar không tự chết trước đó | Cùng file log: **0** dòng `[SIDECAR] Terminated` ⇒ tại thời điểm tắt app `SIDECAR_PID != 0`, nghĩa là `kill_sidecar()` đã không được gọi |

### 2.2 Chưa đo — nói rõ để không nhận công

- **Chưa có log/artifact của chính lần update bị kẹt.** `startup_debug.log` (22/07 → 27/08) **không** có dòng
  `sidecar integrity: FAIL`. Nhưng đây **không** phải bằng chứng phủ định: nhánh brick còn lại (port 8321 bị
  chiếm, `lib.rs:6129-6135`) **không ghi breadcrumb nào** (xem §UP.8), và log Rust ở release chỉ ghi từ mức
  `Warn` nên nhiều mốc bị mất. Vì vậy chuỗi nhân quả §4 là **giả thuyết được chứng minh ở tầng code + vendor
  source**, chưa phải một lần tái hiện đo được đầu-cuối.
- **Chưa chạy lại thật** một lượt `rc.8 → rc.9` trên profile sạch để bắt hộp thoại NSIS. Đây là bước xác minh
  bắt buộc trước khi tuyên bố bản vá xong (mức RUNTIME theo `prynx-deep-audit`).
- Hai lần Application Hang 01/08 chưa được truy vết tới đúng call stack (chưa phân tích dump WER), nên
  "treo ở `shutdown_render_worker`" là giả thuyết mạnh nhất, chưa phải kết luận đo được.

---

## 3. Bảng phát hiện

| Mã | Mức | Vị trí | Nội dung |
|---|---|---|---|
| §UP.1 | P0 | `installer-hooks.nsh:18` | `taskkill /IM "PrynX.exe" /T /F` luôn trả "not found". Tên thật là `pdf-inspector.exe`. Hệ quả: app chính **và** display/print worker (cùng tên exe) sống qua hook. Comment ở đầu file mô tả đúng ý định nhưng lệnh sai đối tượng. |
| §UP.2 | P0 | `installer-hooks.nsh:15-21` + `lib.rs:566-605` | Thứ tự diệt **ngược**: sidecar (dòng 15) trước app (dòng 18). App còn sống ⇒ supervisor thấy `Terminated`, đợi `sidecar_restart_delay(1)=250ms` (`lib.rs:587`) rồi **respawn sidecar**, xong trước khi `Sleep 800` (dòng 21) kết thúc. NSIS ghi `pdf-inspector-backend.exe` (`installer.nsi:749`) vào file vừa bị chiếm lại → "Error opening file for writing". `Sleep 800` cố định, không kiểm lại tiến trình đã chết. |
| §UP.3 | P0 | `lib.rs:5787`, `lib.rs:6596-6602` | Chốt cleanup duy nhất là `RunEvent::Exit`. Updater plugin được build trần (`Builder::new().build()`) nên `on_before_exit` mặc định chỉ là `cleanup_before_exit()`, rồi `exit(0)` ⇒ `SIDECAR_SHUTDOWN`, `shutdown_render_worker()`, `kill_sidecar()` **đều bị bỏ qua** đúng lúc installer sắp ghi file. |
| §UP.4 | P1 | `lib.rs:6599` + `render_worker.rs:3562-3610` | Đường thoát bình thường có thể **treo vô hạn**: `shutdown_render_worker()` gọi `client.request(Shutdown)` → `read_frame` blocking **không timeout** (`render_worker.rs:2232`), rồi `child.wait()` **không timeout** (`:3608`). Hàm này chạy **trước** `kill_sidecar()` (`lib.rs:6601`) ⇒ worker treo thì app treo trong Task Manager và sidecar không bị diệt. Khớp với Application Hang 01/08 và với log thiếu dòng kill ở §2.1. |
| §UP.5 | P1 | `lib.rs:6045-6056` (+ `4850-4895`) | `verify_sidecar_integrity` fail-closed không có nhánh phục hồi. Cặp exe/sidecar lệch phiên bản = app từ chối khởi động mãi mãi ⇒ chỉ reinstall mới thoát. Chốt bảo mật này đúng về ý định, cái thiếu là **đường sửa** (repair/chạy lại installer) chứ không phải nới chốt. |
| §UP.6 | P1 | `single-instance windows.rs:72-107` + `lib.rs:6110` | Mutex tồn tại mà không tìm thấy HWND (instance cũ đang treo, hoặc chưa/đã hủy cửa sổ) ⇒ instance mới chạy tiếp **không** giữ mutex, **không** tạo event window. Từ đó nhiều instance đầy đủ cùng tồn tại, và mỗi cold-start lại `taskkill /IM pdf-inspector-backend.exe /F` — instance mới **giết sidecar của instance đang dùng**; supervisor bên kia gặp listener lạ → `Stop` (`lib.rs:566-585`) → backend chết hẳn trong phiên đó. |
| §UP.7 | P1 | Toàn bộ điểm spawn | **Không có Job Object.** Không tìm thấy `CreateJobObject`/`AssignProcessToJobObject`/`KILL_ON_JOB_CLOSE` ở đâu trong `src-tauri`. Trên Windows đây là cơ chế duy nhất để OS tự dọn cây con khi cha chết bẩn (crash, End Task, `exit(0)` của updater). Mọi bản vá bằng `taskkill` chỉ là lưới phụ. |
| §UP.8 | P2 | `lib.rs:6129-6135` | Nhánh "port 8321 vẫn bị chiếm → exit(1)" chỉ `log::error!`, **không** `startup_breadcrumb`. Đúng nhánh brick dễ xảy ra nhất lại không để dấu trong `startup_debug.log` ⇒ chính lý do audit này không có log của lần sự cố thật. |
| §UP.9 | P2 | `tauri.conf.json:107-115` | Thiếu `plugins.updater.windows.installMode`. Mặc định passive (`/P /R`) vẫn bật hộp thoại lỗi file-in-use của NSIS nhưng đặt trong cửa sổ passive tối giản → user đọc là "kẹt". Cần chọn có chủ ý (passive + log, hay `basicUi` để lỗi hiện rõ). |
| §UP.10 | P2 | `UpdateChecker.tsx:51-52`, `AboutModal.tsx:117-118` | `relaunch()` sau `downloadAndInstall()` là **code không bao giờ tới** (tiến trình đã `exit(0)`). Không gây hại nhưng làm người đọc tin rằng có bước dọn/khởi động lại do ta kiểm soát. |
| §UP.11 | P2 | `core/office_job_runner.py:145-160,254`; `workers/office_convert_engine.py:437-450`; `api/routes/imposition.py:742-751` | Tiến trình ngoài cây sidecar (`WINWORD.EXE`, `EXCEL.EXE`, `soffice.exe`) được dọn bằng `taskkill /PID` **viết trong Python** ⇒ khi sidecar bị `taskkill /F` thì không ai chạy đoạn đó. Cộng `multiprocessing.Process(daemon=False)` ⇒ cháu mồ côi nếu cây bị cắt giữa. Đây là phần "còn process lạ trong Task Manager" không thuộc hai tên exe của PrynX. |

---

## 4. Chuỗi nhân quả khớp triệu chứng

```
(A) App chết bẩn HOẶC treo ở shutdown           (B) User bấm "Cập nhật & khởi động lại"
    - crash: Event Log 18/07, 19/08                 - updater: on_before_exit = cleanup_before_exit
    - hang:  Event Log 01/08 x2                       (KHÔNG phát RunEvent::Exit) → exit(0)
    - treo §UP.4: read_frame/wait vô hạn            - sidecar + render worker thành mồ côi
           │                                              │
           └──────────────┬───────────────────────────────┘
                          ▼
        pdf-inspector-backend.exe (và có thể pdf-inspector.exe) CÒN TRONG TASK MANAGER
                          │   ← đúng điều user thấy
                          ▼
        Installer NSIS chạy (passive /P /R)
          1. NSIS_HOOK_PREINSTALL: kill sidecar  ✔ (tên đúng)
                                   kill PrynX.exe ✘ (§UP.1 — sai tên, app còn sống)
          2. Nếu app còn sống: supervisor respawn sidecar sau ~250 ms (§UP.2)
          3. Sleep 800 (cố định, không kiểm lại)
          4. CheckIfAppIsRunning "pdf-inspector.exe" → kill app  (muộn: sidecar đã respawn)
          5. File pdf-inspector.exe        → GHI ĐƯỢC
          6. File pdf-inspector-backend.exe → BỊ CHIẾM → Abort/Retry/Ignore
                          │
                          ▼   user thấy "cập nhật bị kẹt"
        Ignore/Abort → cây cài LAI: exe MỚI + sidecar CŨ
                          │
                          ▼
        Mở app: verify_sidecar_integrity lệch hash → MessageBox → exit(1)   (§UP.5)
        Không có repair → "phải gỡ cài đặt và cài lại mới mở được"
```

Biến thể cùng triệu chứng (không loại trừ nhau):
- Zombie sidecar giữ port 8321 mà không qua startup proof → `exit(1)` tại `lib.rs:6135`, **không có breadcrumb** (§UP.8).
- Instance cũ treo còn giữ mutex + HWND → lần mở mới `exit(0)` im lặng trong plugin single-instance.
- Lỗ §UP.6 → hai instance thật cùng chạy, instance sau giết sidecar của instance trước.

---

## 5. Đề xuất sửa theo lô (chờ duyệt trước khi làm)

Thứ tự chọn theo nguyên tắc "chặn hư hại trước, dọn gốc sau". Mỗi lô ≤5 file, verify xong mới sang lô kế.

**Lô 1 — chặn brick khi update (3 file).** Đây là lô duy nhất cứu được người dùng đang gặp lỗi.
- `installer-hooks.nsh`: sửa tên thành `pdf-inspector.exe`; **đảo thứ tự** — diệt app trước, sidecar sau;
  thay `Sleep 800` bằng vòng kiểm lại tiến trình đã chết (retry có trần) trước khi trả về.
- `desktop/src-tauri/src/lib.rs`: `tauri_plugin_updater::Builder::new().on_before_exit(...)` — dọn
  render/print worker + `kill_sidecar()` **trước** khi plugin `ShellExecute` installer.
- `UpdateChecker.tsx` (+ `AboutModal.tsx` nếu gộp được trong 5 file): bỏ `relaunch()` chết, ghi rõ hành vi.
- Verify: `cargo check`, `npm run typecheck`, sau đó **bắt buộc** build installer và chạy update thật
  `rc.8 → rc.9` trên VM/profile sạch, quan sát Task Manager + `$INSTDIR`.

**Lô 2 — đường thoát không được treo (2 file).**
- `render_worker.rs`: `shutdown_render_worker()` phải có deadline — gửi `Shutdown`, chờ có trần, hết trần thì
  `kill()`; không `wait()` vô hạn.
- `lib.rs`: trong `RunEvent::Exit`, đảm bảo `kill_sidecar()` chạy **kể cả khi** dọn worker thất bại/hết trần
  (đổi thứ tự hoặc bọc watchdog có timeout).
- Verify: `cargo test` crate liên quan; chạy app thật, đóng app **trong lúc đang render trang nặng**, kiểm
  Task Manager sạch cả hai tên exe.

**Lô 3 — Job Object (1-2 file).** Gán sidecar + worker vào job có `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` để OS
tự dọn khi app chết bẩn. Đây là bản vá gốc cho toàn nhóm bug; sau lô này `taskkill` chỉ còn là lưới phụ.

**Lô 4 — phục hồi thay vì brick (2 file).** `lib.rs`: khi integrity lệch, thông điệp nói đúng việc user làm
được và mở đường repair (chạy lại installer đã cache / hướng dẫn 1 bước), thay vì chỉ `exit(1)`. Thêm
`startup_breadcrumb` cho nhánh port bị chiếm (§UP.8). **Không nới chốt bảo mật.**

**Lô 5 — single-instance (1-2 file).** Vá lỗ mutex-không-HWND: chờ/retry có trần rồi mới quyết định, và từ
chối chạy tiếp nếu không giành được quyền sở hữu. Kiểm cả ca mở bằng double-click PDF và verb chuột phải.

**Lô 6 — tiến trình ngoài cây (§UP.11).** Chỉ làm sau khi 1-5 xanh; phạm vi backend, cần thiết kế riêng.

Sau khi các lô đóng: cập nhật `docs/PRYNX_MASTER_AUDIT_MATRIX.md` (wave 8 — build/release artifact) và ghi
log fixes theo `docs/<CHUDE>_FIXES_2026-08-28.md`.

---

## 6. Việc chủ dự án làm được ngay (chưa cần bản vá)

Khi gặp lại tình trạng này, không cần gỡ cài đặt nếu **cặp exe/sidecar vẫn khớp**:

1. Kiểm tra và dọn tiến trình sót trước khi chạy installer:
   `taskkill /IM pdf-inspector.exe /T /F` rồi `taskkill /IM pdf-inspector-backend.exe /T /F`
   (đúng thứ tự này — app trước, sidecar sau, để supervisor không respawn).
2. Chạy installer bằng tay từ `Ban_Phat_Hanh\PrynX_<version>_x64-setup.exe` thay vì cập nhật trong app, và
   **không** bấm Ignore nếu hiện hộp thoại "Error opening file for writing" — chọn Retry sau khi đã kill.
3. Nếu app đã brick: reinstall là cách duy nhất hiện tại (§UP.5). Trước khi reinstall, gửi kèm
   `%APPDATA%\PrynX\logs\startup_debug.log` và `%LOCALAPPDATA%\com.prynx.app\logs\PrynX.log` — hai file này
   xác nhận nhánh brick nào đã xảy ra.

---

## 7. Trạng thái bằng chứng của đợt này

| Luồng | Trạng thái | Còn thiếu |
|---|---|---|
| Thoát app → dọn sidecar | `TRACED` + có log phủ định một lần tắt | Chưa tái hiện chủ động ca treo `shutdown_render_worker` |
| Updater → installer → ghi file | `TRACED` (code + vendor source + installer.nsi đã sinh) | Chưa chạy update thật để bắt hộp thoại NSIS ⇒ chưa đạt `RUNTIME` |
| Integrity gate sau update dở dang | `TRACED` | Chưa dựng ca cặp exe/sidecar lệch để đo thông điệp thật |
| Single-instance nhiều instance | `TRACED` (vendor source) | Chưa tái hiện ca mutex-không-HWND |

Không tuyên bố "đã hết bug vòng đời tiến trình". Đợt này xác định **nguyên nhân có bằng chứng ở tầng code**
cho cả ba triệu chứng, và chỉ ra đúng bước còn thiếu để nâng lên mức runtime.
