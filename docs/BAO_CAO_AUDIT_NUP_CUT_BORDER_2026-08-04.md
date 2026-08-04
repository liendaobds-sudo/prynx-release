# Báo cáo rà soát — Đường viền cắt thủ công cho Bình bài cắt xén

## Phạm vi và tiêu chí

Tính năng cần in một đường vector liên tục quanh từng bài trong N-Up guillotine để người dùng cắt bằng kéo/dao. Đường viền độc lập với dấu xén, có vị trí theo thành phẩm (Trim) hoặc theo mép tràn lề (Bleed), màu và độ dày do người dùng chọn. Phạm vi gồm cả **Dàn nhiều mẫu** (`nup`) và **Bình trang** (`step_repeat`/`repeat`). Không thay đổi Booklet, tem bế, CNC, Bình nguyên tấm decal hoặc hình học artwork.

## Bằng chứng luồng hiện tại

| Mã | Phát hiện | Bằng chứng |
|---|---|---|
| §CB.1 | State N-Up được ghép từ các slice, persist theo profile công cụ | `desktop/src/components/imposition-tools/store/slices/nupSlice.ts`, `store/profiles.ts`, `store/persist.ts` |
| §CB.2 | Payload xuất N-Up đi qua `processHandlers.ts` rồi `/nup-start` | `desktop/src/lib/processHandlers.ts:96-179`, `desktop/src/components/ImpositionTab.tsx:1639-1721` |
| §CB.3 | `place_one_artwork()` tạo `trim_rect` và `bleed_rect` từ placement thật | `backend/app/workers/nup_artwork.py:697-701` |
| §CB.4 | PDF được vẽ sau vòng đặt artwork; dấu xén bắt đầu ở `nup_process_chunk.py:904` | `backend/app/workers/nup_process_chunk.py:814-921` |
| §CB.5 | Preview chuyển đúng cell tuyệt đối sang SVG và có cache key riêng | `desktop/src/components/imposition-tools/sections/GridPreview.tsx:1837-1898`, `:1155-1276` |
| §CB.6 | Bản đầu đã khóa sai Bình trang ở cả UI, preview, payload và backend | `AdvancedSettingsSection.tsx:160`, `GridPreview.tsx:2020`, `ImposerDashboard.tsx:1296`, `nup_cut_border.py:118-126` |

## Quyết định triển khai

- Mặc định: tắt, vị trí Trim, đen K100 (`#000000` quy đổi về CMYK `(0,0,0,1)`), độ dày `0,3 mm`.
- Giới hạn độ dày: `0,1–2,0 mm`; API trả `422` rõ ràng khi cấu hình bật nhưng sai kiểu/ngoài khoảng. Renderer vẫn có lớp chuẩn hóa phòng thủ cho lời gọi nội bộ cũ.
- Trim: nét nằm đúng trên biên thành phẩm.
- Bleed: mở rộng đều bốn phía theo bleed đang dùng; nếu bleed bằng 0 thì trùng Trim.
- Cảnh báo UI khi đường theo Bleed có nguy cơ chồng do khe nhỏ.
- Vẽ nét vector sau artwork, hỗ trợ placement xoay và layout nhiều kích thước.
- Preview dùng chính cell tuyệt đối đã nhận từ backend; cấu hình viền cố ý không nằm trong khóa cache bố cục vì chỉ render lại overlay, không chạy lại solver/API.
- Không tạo FeatureId mới; dùng entitlement hiện có của N-Up (`impo.nup`).
- Bình trang dùng nguyên cấu hình, hình học Trim/Bleed và renderer của Dàn nhiều mẫu; `repeat` chỉ thay cách chọn trang nguồn, không thay ý nghĩa đường viền.

## Thứ tự sửa và verify

1. Backend helper + truyền cấu hình + test hình học.
2. Store/profile/type/payload.
3. UI, preview, i18n, preset và test giao diện.
4. Typecheck, Vitest liên quan, pytest backend; không build release và không push.

Phạm vi ban đầu đã được người dùng chốt triển khai trong cuộc trao đổi ngày 2026-08-04. Sau khi phát hiện Bình trang bị loại khỏi cả bốn tầng, người dùng đã duyệt mở rộng đầy đủ cho `step_repeat`/`repeat` trong cùng ngày.
