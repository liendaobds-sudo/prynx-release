# Lô lint P2.42 — 2026-08-23

## Phạm vi

Dọn 3 binding `no-unused-vars` trong `desktop/src/App.tsx`:

- Bỏ binding `isLicenseLocked`; `LicenseLockOverlay` là owner đang dùng trạng thái này.
- Bỏ hai handler HTML5 drag cũ không còn được bind sau khi tab chuyển sang pointer/custom event.
- Giữ `tabHoverTimeoutRef` vì tuyến `prynx-tab-hover` vẫn dùng nó.

Không đổi authentication, license overlay, pointer reorder hoặc custom hover-to-switch.

## Verify

- Rule `no-unused-vars` trong App: sạch; finding Hook lịch sử giữ nguyên.
- Test App shell: 3 file, 4/4 đạt.
- `npm run typecheck`: đạt.
- `npm run lint:budget`: 1.212 → 1.202 errors; warnings giữ 103. Delta gồm LO45 chạy đồng thời; riêng LO46 giảm 3 lỗi.

## Kết luận

Chỉ bỏ đường drag HTML5 đã bị thay thế và binding license trùng owner; tuyến tab hiện tại không đổi.
