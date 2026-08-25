# Lô lint P2.15 — 2026-08-23

## Phạm vi

Làm rõ các tham số policy giữ lại vì tương thích caller/test trong:

- desktop/src/components/workspace/livePageFramePolicy.ts
  - đánh dấu sử dụng tường minh cho _isActiveFrame và _accurateCommitted;
  - giữ nguyên chữ ký hàm và kết quả policy, không bỏ tham số khỏi API nội bộ.

Đây là cleanup contract, không phải thay đổi quyết định render.

## Verify

- ESLint hẹp: sạch.
- Regression: LivePageFrame.renderPolicy.test.ts và LivePageFrame.liveTile.test.tsx, 45/45 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.358 → 1.356, warnings 105 → 105; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Giữ tương thích với các caller hiện hữu nhưng loại cảnh báo biến tham số không được đọc; hành vi render không đổi.
