# Lô lint P2.28 — 2026-08-23

## Phạm vi

Dọn 6 binding `no-unused-vars` nội bộ trong 5 file UI, giữ nguyên public props và interfaces:

- `desktop/src/components/auth/LoginScreen.tsx`
- `desktop/src/components/preprocess-tools/VdpAlignPanel.tsx`
- `desktop/src/hooks/viewer/useViewerZoom.ts`
- `desktop/src/components/DiffSidebar.tsx`
- `desktop/src/components/acrobat/ThumbSidebar.tsx`

Không đổi listener đăng nhập, căn VDP, zoom, điều hướng diff hoặc thumbnail.

## Verify

- ESLint hẹp: 39 → 33 findings; giảm đúng 6 lỗi `no-unused-vars`, rule mục tiêu sạch.
- Test `ThumbSidebar.aiStatus` và `AcrobatViewer.pageOverlay`: 16/16 đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt; chỉ có cảnh báo chuyển dòng autocrlf.
- `npm run lint:budget`: số tổng sau LO32–33 là 1.294 errors / 103 warnings; riêng LO32 giảm 6 lỗi.

## Kết luận

Chỉ bỏ binding không được đọc; contract gọi component và hành vi UI được giữ nguyên.
