# Đồng bộ nguồn Tách nhiều tem - log sửa2026-09-07

Yêu cầu: sửa riêng báo nhầm “Tài liệu đã thay đổi”, giữ hai chế độ sau rollback79f05a3.

| Nhóm | Thay đổi | Bằng chứng |
|---|---|---|
| SHEET.SOURCE1 | useWorkspaceStore so hiệu lực layer thay vì metadata thụ động; useWorkingPdf.test thêm hồi quy | 2đỏ trước sửa→18test đạt |
| SHEET.SYNC | ImpositionTab chỉ mở nguồn explicit; selector cung cấp origin/revision và hiện overlay đúng owner | Parent dùng File/materialize/store thật; rawViewer không đổi giữa detect; explicit/background và thay đổi thật có ca âm |
| SHEET.SOURCE3 | StickerCutlineTool giữ Working PDF còn current khi quay lại tab; không khóa vô điều kiện vào nguồn cũ | 2đỏ trước sửa→shell+WorkingPdf42test đạt |

Final:526test/50suite frontend +typecheck đạt; lint0error/1warning cũ; diff-check đạt.
Các tập verify hẹp có chồng lấp, không cộng vào tổng. Không backend, schema, nhận diện bóng hoặc hình học thay đổi.
Chưa kiểm native Tauri; chưa commit. Bốnfile UI của hai lượt trước và tài liệu nesting/master được giữ nguyên.
