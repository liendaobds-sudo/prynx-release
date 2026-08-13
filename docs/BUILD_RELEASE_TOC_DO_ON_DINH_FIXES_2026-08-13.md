# Nhật ký sửa tốc độ và độ ổn định build/release — 2026-08-13

**Nguồn:** `docs/BAO_CAO_AUDIT_BUILD_RELEASE_TOC_DO_ON_DINH_2026-08-13.md`  
**Phê duyệt:** chủ dự án duyệt triển khai ngày 2026-08-13.  
**Nguyên tắc:** mỗi lô tối đa 5 file; verify xong và chờ nghiệm thu trước khi sang lô kế; không build,
ký, gọi API production hoặc upload trong lượt sửa script.

## Trạng thái tổng

| Lô | Finding | Trạng thái | Verify |
|---|---|---|---|
| A | §BR.02, §BR.11 | AUTO đạt; chờ nghiệm thu UI/runtime | 73 test release đạt; 2 script parse; mô phỏng GitHub 5 trạng thái đạt |
| B | §BR.03, §BR.10, §BR.12 | AUTO đạt; chờ nghiệm thu UI/runtime | 76 test release đạt; 4 script parse; controller + mutex smoke đạt |
| C | §BR.01 | Chưa triển khai | Chờ Lô B |
| D–F | §BR.04–09 | Chưa triển khai | Chờ telemetry/resume |

## Lô A — fail-fast GitHub và hợp đồng phiên bản UI

**Trạng thái:** `AUTO đạt; RUNTIME UI chờ xác nhận`  
**File thay đổi trong lô:** 5

1. `release_update.ps1`
2. `quanly_phathanh.ps1`
3. `backend/tests/test_release_no_gs_policy.py`
4. `backend/tests/test_artifact_runtime_self_test.py`
5. `docs/BUILD_RELEASE_TOC_DO_ON_DINH_FIXES_2026-08-13.md`

### Baseline đã xác minh

- Publisher chỉ kiểm đăng nhập GitHub trước build; source commit, release target và tag chỉ được kiểm
  sau build + runtime verifier, tức có thể lộ lỗi sau khoảng 65–106 phút.
- GUI cho sửa “Phiên bản mới”, ghi `publisher.config.json` rồi phát hành, trong khi publisher bắt
  buộc toàn bộ version đã đồng bộ/commit và worktree sạch.
- GUI hứa 10–20 phút, trái log thật 71 phút và lượt RC5 65–106 phút.
- Bộ test release chuyên biệt trước sửa: **71 passed, 1 warning**.

### Thay đổi

- `release_update.ps1` kiểm trước khi gọi `build_production.ps1`:
  - HEAD hiện tại có trên `SourceRepo`;
  - commit neo có trên repo release public;
  - release/tag chưa tồn tại, hoặc nếu đã tồn tại thì tag phải trỏ đúng commit neo;
  - tag tồn tại nhưng không có release bị từ chối vì trạng thái mơ hồ;
  - chỉ HTTP 404 được hiểu là “chưa có release”; lỗi mạng/quyền/API fail-closed.
- Giữ toàn bộ remote check ngay trước upload; thêm chốt trạng thái release không được đổi giữa
  preflight và publish. Nhánh clobber vẫn kiểm tag target thêm lần cuối sát lệnh upload.
- GUI đọc SemVer trực tiếp từ `desktop/src-tauri/tauri.conf.json`, hiển thị read-only và đọc lại lúc
  bấm nút để tránh dùng giá trị cũ.
- GUI không còn `Save-Config`, không ghi file tracked khi bấm build/publish và build nội bộ không còn
  truyền `-Version` để mutate source.
- Public publish vẫn truyền version nguồn hiện tại cho `release_update.ps1`, nơi kiểm đầy đủ npm,
  Cargo, lockfile, publisher config và worktree sạch.
- Sửa nội dung xác nhận thành thời gian quan sát thực tế khoảng 60–110 phút.
- Gắn tag truy vết `BUILD (audit 2026-08-13 BR.02)` và
  `UIUX (audit 2026-08-13 §BR.11)`.

### Verify

- Pytest release chuyên biệt bốn file: **73 passed, 1 warning**.
- Pytest hai module trực tiếp: **67 passed, 1 warning**.
- PowerShell parser trên Windows: `release_update.ps1` và `quanly_phathanh.ps1` đều đạt.
- Mô phỏng GitHub hoàn toàn cục bộ bằng mock `gh`: release mới, release đã có đúng target, tag mồ
  côi, HTTP 500 và tag sai target đều cho kết quả mong đợi.
- `git diff --check` các file code/test: đạt.
- Encoding GUI vẫn là UTF-8 BOM; publisher vẫn parse được bằng PowerShell Windows.
- Không chạy full build, không ký, không gọi GitHub/Supabase production và không upload.

### Nghiệm thu còn chờ

- Mở `quanly_phathanh.ps1`, xác nhận ô phiên bản là read-only và hiện đúng version nguồn.
- Có thể thử bấm tới hộp xác nhận rồi chọn **Không** để kiểm nội dung mới; không cần chạy build.
- Khi source sạch/đã push và chuẩn bị phát hành thật, preflight GitHub cần được quan sát một lượt trước
  khi duyệt Lô B. Không thể chạy publisher thật trong worktree đang có thay đổi của các tác vụ khác.

## Lô B — controller nền, khóa build trùng và trạng thái bền

**Trạng thái:** `AUTO đạt; RUNTIME UI chờ xác nhận`  
**File thay đổi trong lô:** 4

1. `scripts/release_controller.ps1` (mới)
2. `quanly_phathanh.ps1`
3. `backend/tests/test_release_no_gs_policy.py`
4. `docs/BUILD_RELEASE_TOC_DO_ON_DINH_FIXES_2026-08-13.md`

### Thay đổi

- Thêm controller process ẩn, độc lập với vòng đời cửa sổ quản lý; script build/publisher luôn chạy
  ở process con nên mọi `exit` cũ chỉ kết thúc child và controller vẫn thu được mã thoát.
- Mutex toàn repo chặn hai lượt build/phát hành cùng ghi `binaries/`, target và manifest.
- Mỗi lượt có run ID, `status.json`, `latest.json`, `build.log`, PID controller/child, stage, thời gian,
  trạng thái terminal và exit code dưới `%LOCALAPPDATA%\PrynX\release-runs`.
- GUI đọc trạng thái mỗi 2 giây, khóa hai nút khi controller đang sống, khôi phục trạng thái khi mở
  lại, hiển thị stage/thời gian và có nút **Mở log**.
- Mật khẩu khóa ký không đi qua command line hoặc status/log: GUI bảo vệ bằng DPAPI CurrentUser vào
  file Temp một lần, controller giải mã rồi xóa ngay trước khi spawn publisher.
- Controller đọc đồng thời stdout/stderr theo dòng, ghi `build.log` auto-flush trong khi child còn
  chạy và suy stage từ marker `[0/5]`…`[5/5]`/runtime/publish có sẵn; không cần sửa lõi build.
- Gắn tag `BUILD/UIUX (audit 2026-08-13 §BR.03/10/12)`.

### Verify

- Pytest release chuyên biệt bốn file: **77 passed, 3 warning có sẵn**.
- Pytest policy trực tiếp: **49 passed** (warning phụ thuộc có thể thay đổi theo module đã import).
- PowerShell parser: controller, GUI, build và publisher đều đạt.
- Smoke controller cục bộ: child `exit 7` được ghi `failed/exitCode=7`; child `exit 0` được ghi
  `succeeded`; stdout/stderr được gom vào log; không chạy build thật hoặc gọi mạng.
- Smoke mutex cục bộ: lượt một chạy; lượt hai trả `blocked/exitCode=1`; lượt một kết thúc `0`.
- Smoke live-log cục bộ: khi child còn ngủ/chưa kết thúc, `latest.json` đã là `running`, stage đã
  nhận `[1/5]` và `build.log` đã đọc được dòng đầu; sau đó log nhận tiếp dòng cuối và state `succeeded`.
- Ca môi trường có đồng thời `Path/PATH` đã được tái hiện và controller dùng `ProcessStartInfo`, không
  còn phụ thuộc lỗi dictionary của `Start-Process` cho child build.
- Smoke UTF-8: stage/log giữ nguyên tiếng Việt (`Tiến độ đóng gói`), kể cả đường dẫn probe/state có
  khoảng trắng; controller truyền command bằng Base64, không nội suy path/note vào command line.
- Probe publish xác nhận hashtable splatting giữ đúng `Version=1.2.3-rc.4`, ghi chú tiếng Việt có
  khoảng trắng và switch `ReusePassedNoGs=True`; không dùng array splatting sai semantics.
- `git diff --check`: đạt; GUI và controller đều giữ UTF-8 BOM cho Windows PowerShell 5.
- Không chạy full build, không ký, không gọi GitHub/Supabase production và không upload.

### Nghiệm thu còn chờ

- Mở lại màn hình Quản lý phát hành, xác nhận có dòng **Trạng thái** và nút **Mở log**.
- Chưa bấm Build NỘI BỘ/PHÁT HÀNH vì đó là lượt build thật 60–110 phút và có thể chạm secret/UAC.
- Khi chạy thật, cần xác nhận: nút build khóa trong lúc chạy; đóng/mở lại GUI vẫn thấy đúng stage;
  **Mở log** xem được kết quả; trạng thái cuối báo hoàn tất hoặc lỗi kèm exit code.
