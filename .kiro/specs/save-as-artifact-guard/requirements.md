# Requirements Document

## Introduction

Trong self-review Save As của audit vòng đời file (`docs/BAO_CAO_AUDIT_VONG_DOI_FILE_VA_HOP_DONG_ANH_2026-08-26.md`, §FILE.A4), một ca nguy hiểm được phát hiện: nếu người dùng chọn đúng đường dẫn file artifact tạm làm đích lưu, lệnh copy đĩa→đĩa tự thay chính file đó rồi trả về thành công, và luồng lưu gắn identity "nguồn sạch" lên chính artifact — provenance kết quả bị rửa trắng, artifact tạm trở thành nguồn thật của khách.

Lô sửa trước đã đóng phần logic: `isSameWorkspacePath` chuẩn hoá path trong `desktop/src/lib/workspaceFileSave.ts`, và `validate_disk_copy_request` fail-closed khi nguồn trùng đích trong `desktop/src-tauri/src/lib.rs`. Bằng chứng hiện có là 12 test predicate TS và 3 test Rust, tất cả đã chứng minh đỏ trước bản vá và xanh sau.

Spec này xử lý phần bằng chứng còn thiếu để khép hạng mục F2b của lô F (provenance). Ba khoảng trống: chưa có test nào chứng minh call site Save As thật sự từ chối, chưa có artifact test chứng minh file temp và provenance còn nguyên sau khi từ chối, và chưa xác định hành vi cho ổ mạng map cùng ca không resolve được path. Spec không mở lại phần logic đã đạt, cũng không mở rộng sang các finding khác của lô F.

## Glossary

| Thuật ngữ | Nghĩa trong spec này |
|---|---|
| artifact tạm | File do PrynX sinh ra để phục vụ render/xử lý (`uploads\<uuid>.pdf` từ sidecar, hoặc file trong TEMP). Không phải nơi lưu thật của người dùng. |
| working file | `File` đang là nguồn của tab làm việc; có thể là source của khách hoặc artifact tạm. |
| provenance | Metadata `isGenerated` / `isTempUploadPath` trên `File`, quyết định file là kết quả do app sinh hay nguồn thật của khách. Không suy từ tên file. |
| rebase identity | Việc tạo `File` mới sạch provenance sau khi lưu thành công, để artifact cũ không còn được coi là kết quả app-owned. |
| vé thuê artifact | Artifact lease — token giữ cho vòng dọn artifact không xoá file đang được tab sử dụng. |
| bake | Ghi các chỉnh sửa xoay trang và thứ tự trang vào bytes PDF trước khi lưu. |
| cùng-một-file | Hai đường dẫn khác chuỗi nhưng mở ra cùng một file trên đĩa theo quy ước Windows. |
| lỗi phạm vi ghi | Lỗi bị chặn vì đích nằm ngoài vùng cho phép ghi; frontend nhận diện để mở lại hộp thoại chọn vị trí. |
| F2b | Hạng mục con của Lô F (provenance) trong kế hoạch sửa của báo cáo audit 2026-08-26. |

## Requirements

### Requirement 1: Từ chối tại call site Save As với lỗi nghiệp vụ nổi đúng chỗ

**User Story:** Là thợ chế bản, tôi muốn khi chọn nhầm đường dẫn file làm việc tạm làm đích lưu thì PrynX báo lỗi rõ ràng và giữ nguyên file của tôi, để tôi không mất bản gốc và không tưởng file tạm là bản lưu thật.

#### Acceptance Criteria

1. WHEN người dùng chạy Save As trên một working file có provenance generated hoặc `isTempUploadPath` AND đích được chọn trỏ cùng file với `path` hiện tại THEN hệ thống SHALL từ chối trước khi gọi bất kỳ lệnh ghi hoặc copy nào.
2. WHEN lệnh bị từ chối THEN hệ thống SHALL hiển thị thông báo tiếng Việt nói rõ không thể lưu đè lên file làm việc tạm và hướng người dùng chọn vị trí khác.
3. WHEN lệnh bị từ chối THEN hệ thống SHALL KHÔNG mở lại hộp thoại chọn vị trí như nhánh fallback dành cho lỗi phạm vi ghi, vì lỗi này không phải lỗi quyền.
4. WHEN lệnh bị từ chối THEN hệ thống SHALL giữ nguyên `isSaved`, tiêu đề tab và identity của working file, KHÔNG công bố revision đã lưu.
5. IF người dùng chọn tiếp một đích hợp lệ khác sau lần bị từ chối THEN hệ thống SHALL lưu bình thường và công bố revision nguồn sạch tại đích mới.
6. WHEN working file là source sạch của khách AND người dùng chọn lại đúng file đó AND không có gì để bake THEN hệ thống SHALL bỏ qua việc ghi và coi là đã lưu, KHÔNG báo lỗi.

### Requirement 2: Artifact và provenance nguyên vẹn sau khi từ chối

**User Story:** Là thợ chế bản, tôi muốn sau một lần chọn nhầm thì trạng thái phiên làm việc không bị hỏng ngầm, để lần lưu tiếp theo vẫn ra đúng file và không có rác trên đĩa.

#### Acceptance Criteria

1. WHEN yêu cầu copy bị từ chối vì nguồn trùng đích THEN hệ thống SHALL giữ file artifact tạm nguyên bytes so với trước khi gọi.
2. WHEN yêu cầu copy bị từ chối THEN hệ thống SHALL KHÔNG để lại file tạm trung gian nào trong thư mục đích.
3. WHEN Save As bị từ chối THEN working file SHALL vẫn giữ provenance generated hoặc `isTempUploadPath` như trước, KHÔNG bị rebase thành identity nguồn sạch.
4. WHEN Save As bị từ chối THEN vé thuê artifact (artifact lease) trên working file SHALL vẫn còn hiệu lực để vòng dọn artifact không xoá file đang dùng.
5. WHEN Save As thành công tới một đích hợp lệ THEN revision công bố SHALL không còn mang provenance generated, `isTempUploadPath`, cờ chờ path native và vé thuê artifact.

### Requirement 3: Nhận diện cùng-một-file qua các mặt path khác nhau của Windows

**User Story:** Là người dùng in ấn làm việc trên ổ mạng và ổ map, tôi muốn chốt chặn vẫn nổ dù đường dẫn hiện ra dưới dạng khác, để an toàn không phụ thuộc vào việc hộp thoại trả về chuỗi nào.

#### Acceptance Criteria

1. WHEN hai path chỉ khác nhau về hoa/thường, dấu phân cách `/` và `\`, dấu phân cách trùng lặp, đoạn `.` hoặc đoạn `..` THEN hệ thống SHALL coi là cùng một file.
2. WHEN hai path khác nhau về tên file, thư mục hoặc ổ đĩa THEN hệ thống SHALL coi là hai file khác nhau và KHÔNG chặn.
3. WHEN đích trỏ cùng file với nguồn qua tên ngắn 8.3, junction hoặc symlink THEN tầng native SHALL nhận ra là cùng một file và từ chối.
4. WHEN đích trỏ cùng file với nguồn qua ổ mạng đã map so với đường UNC của cùng share THEN hệ thống SHALL xác định hành vi bằng test có bằng chứng, và nếu không nhận ra được thì SHALL ghi rõ đây là giới hạn còn lại thay vì im lặng.
5. IF không resolve được path trên đĩa cho cả nguồn và đích THEN hệ thống SHALL rơi về so sánh chuỗi đã chuẩn hoá, KHÔNG được coi là hai file khác nhau chỉ vì resolve thất bại.
6. WHEN path là đường UNC THEN việc chuẩn hoá SHALL giữ tiền tố `\\`, không biến share mạng thành path tương đối.

### Requirement 4: Bất biến được cưỡng chế ở biên tin cậy, không chỉ ở giao diện

**User Story:** Là người bảo trì PrynX, tôi muốn bất biến này nằm ở lệnh native chứ không chỉ trong một component, để luồng Save As thứ hai trong tương lai không âm thầm mất chốt chặn.

#### Acceptance Criteria

1. WHEN lệnh copy đĩa→đĩa được gọi từ WebView với nguồn trùng đích THEN tầng native SHALL từ chối bất kể component gọi có kiểm trước hay không.
2. WHEN thông báo lỗi của tầng native được sinh ra cho ca nguồn trùng đích THEN nội dung SHALL KHÔNG chứa chuỗi mà frontend dùng để nhận diện lỗi phạm vi ghi.
3. WHEN các điều kiện tiên quyết cũ của lệnh copy được kiểm THEN hợp đồng SHALL không bị nới: đuôi ngoài danh sách cho phép, đuôi nguồn lệch đuôi đích, nguồn không tồn tại và path nhạy cảm vẫn bị chặn.
4. WHEN một call site hợp lệ copy sang đích khác file THEN hệ thống SHALL không chặn oan, kể cả khi file đích chưa tồn tại.
5. WHEN luồng ghi đè có bake nội dung THEN hệ thống SHALL đi đường ghi bytes chứ không đi đường copy, nên chốt nguồn-trùng-đích SHALL không can thiệp vào luồng đó.

### Requirement 5: Mức bằng chứng để khép F2b

**User Story:** Là người chốt phát hành, tôi muốn biết chính xác hạng mục này đang ở mức bằng chứng nào và còn thiếu gì, để không ghi vào ma trận audit một tuyên bố mạnh hơn thực tế.

#### Acceptance Criteria

1. WHEN test call site và artifact test đã xanh THEN hạng mục SHALL được ghi nhận ở mức `ARTIFACT` trong `docs/PRYNX_MASTER_AUDIT_MATRIX.md`.
2. WHEN chuỗi thao tác runtime chưa được chạy trên ứng dụng thật THEN tài liệu SHALL KHÔNG ghi mức `RUNTIME` và SHALL nêu rõ bước kiểm tay còn thiếu.
3. WHEN báo cáo kết quả THEN hệ thống SHALL liệt kê test đã chạy kèm kết quả, test chưa chạy được kèm lý do, và giới hạn còn lại như ổ mạng map.
4. WHEN mọi tiêu chí của Requirement 1 đến 4 đã đạt AND chuỗi thao tác runtime đã chạy đạt trên `run_dev.bat` THEN hạng mục F2b SHALL được coi là khép ở mức `RUNTIME`.
5. WHEN cập nhật ma trận audit THEN nội dung SHALL dẫn baseline revision và đường dẫn báo cáo gốc để tra lại được.