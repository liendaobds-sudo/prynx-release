# Bù xén — nối chọn đối tượng PDF vào workspace chung

## Phạm vi đã duyệt

Người dùng yêu cầu triển khai một giao diện đầy đủ, dễ hiểu: tự nhận diện và chọn/sửa thủ công
ngay trên canvas, không chuyển về form PDF cũ; bỏ bộ đổi file riêng và hạn chế dòng giải thích.
Yêu cầu “tiến hành đi” duyệt phần nối xuyên tầng này; tiếp tục theo lô có kiểm thử.

## Bằng chứng trước sửa

| Mã | Bằng chứng | Phần cần nối |
|---|---|---|
| CUSTOM.1 | `StickerCutlineTool.tsx`: `classicAdvanced` chuyển cả component sang `StickerTool` | Một panel, không cửa chuyển form |
| CUSTOM.2 | `StickerTool.tsx`: `selection_json` chứa `object_ids`; `sticker_sheet.py` schema detect chưa có | Lựa chọn PDF vào session nhận diện chung |
| CUSTOM.3 | `StickerTool.tsx`: `!activeObjectSelection` tắt preview canonical | Custom phải có preview và fingerprint như tự động |
| CUSTOM.4 | `sticker_sheet_export.py`: export thường qua PNG; chỉ existing-cut có nhánh copy PDF | Giữ trang/artwork PDF gốc khi xuất giữ tấm từ lựa chọn đối tượng |
| CUSTOM.5 | `EditObjectSelectionContext` chỉ có fileId/pageIndex/objectIds | Khóa lựa chọn theo file/revision/trang đang xem, không dùng selection cũ sau sửa/đổi trang |

Đây là khoảng thiếu chức năng đã xác nhận bằng code, không phải bằng chứng lỗi runtime mọi nguồn.

## Hợp đồng triển khai

- File đang mở là nguồn. Nhận diện tự động không chạy chỉ vì mở công cụ.
- “Chọn tem” dùng chọn đối tượng ngay trên PDF; kết thúc chọn tạo mask/CUT trong cùng session.
- Mask thủ công tiếp tục có xóa/giữ/gộp và undo/redo; cùng bộ bù xén, offset, màu, kiểu góc.
- Detect nhận `object_ids` tùy chọn. Kết quả dùng `vector_geometry_ref.kind = pdf-object-selection`
  để writer biết nguồn gốc, không nhầm instance id với PDF object id.
- Preview và export dùng cùng revision/fingerprint. Kết quả đã đổi nguồn/trang không được áp dụng.
- Xuất giữ tấm từ custom PDF phải giữ artwork không chọn, không đưa lại detector legacy sau preview.
- Recipe chưa có selector tái lập thì tiếp tục từ chối ghi lựa chọn gắn với file cụ thể.
- Giữ route legacy phục vụ recipe/compatibility bên trong; không giữ dòng “quay lại workspace” trên UI.

## Lô và kiểm thử

1. Backend detect/schema/route và regression lựa chọn, malformed/stale/không tồn tại.
2. Backend writer giữ PDF gốc, canonical CUT, bleed và artifact parse/render.
3. API/store/session selection, tests revision/page và recipe guard.
4. UI chung/canvas selection, bỏ form cũ và text thừa; test thao tác cùng settings.

Mỗi lô tối đa 5 file trước khi verify. Không đổi thuật toán bóng A/B, solver, pool/RAM hay đóng gói.
Kiểm cuối: typecheck, Vitest phạm vi, pytest và lint; runtime Tauri chỉ ghi đạt khi đã thao tác thật.

## Tiến độ triển khai

- Detect chung đã nhận lựa chọn PDF, giữ Alpha và gắn metadata nguồn; `base_revision` thay đúng
  trang, tăng revision, giữ các trang khác và rollback artifact khi publish lỗi.
- Đã nối “Chọn tem” → chọn trên canvas → “Dùng phần đã chọn” → preview/thiết lập/xuất chung.
  Bỏ thẻ tóm tắt, bộ đổi file và nhóm chuyển form PDF cũ theo phản hồi của người dùng.
- Tắt ảnh overlay đã tách nền khi chọn đối tượng để người dùng thao tác trên PDF gốc. Unmount
  overlay chỉ dọn worker/listener, không đóng session nhận diện.
- Snapshot lựa chọn kiểm file, generation, thứ tự/xoay và instance trang; đã khóa rõ nguồn raw
  cho Edit PDF, không dùng nhầm file working dành cho Output Preview/Crop.
- Giữ tấm PDF dùng artwork gốc + bleed/CUT từ canonical cache; split/ZIP vẫn dùng pipeline mask.
- Retry lỗi tải asset dùng revision đã publish, không nhận diện lại với revision cũ. Recipe tiếp
  tục chặn lựa chọn object ID gắn với file cụ thể.

Verify cuối trên code ổn định: frontend **516 tests / 50 file**, backend **448 tests / 7 suite**
đạt; typecheck đạt; ESLint file thay đổi 0 lỗi, 1 warning có sẵn trong ImpositionTab. Backend có
2 cảnh báo Starlette/Pydantic cũ. Không thay golden/evidence nguồn người dùng.

Lượt combined backend đầu chạy trong lúc helper/exporter đang được đổi tên khi ghép code, tạo
late-import giữa hai revision. Đã ngừng sửa trong lúc chạy tổng và verify lại toàn bộ xanh. Test
artifact shadow được cập nhật đúng hợp đồng giữ PDF gốc, vẫn kiểm Alpha ROI và CUT canonical,
đồng thời giữ nhánh split/SMask cũ; không bỏ oracle chống AI làm mất mảng tem.

## Giới hạn có chủ đích cần thông báo khi gặp

- Chọn thủ công trên PDF đã có CUT: chưa có ánh xạ chắc chắn CUT nào thuộc từng tem được chọn.
  Writer dừng trước khi xóa CUT, không âm thầm làm mất dao của tem còn lại.
- Nhận diện tự động thay được CUT spot đã xác định; CUT chỉ dựa vào OCG chưa tách an toàn thì
  dừng và hướng dẫn giữ đường cắt gốc hoặc xử lý lớp CUT trong nguồn.
- Chưa xác minh thao tác Tauri/native drop trong lượt này; test component không thay bằng chứng
  trên app desktop đã kích hoạt. Không build installer/push/release.
