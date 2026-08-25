# Lô lint P2.14 — 2026-08-23

## Phạm vi

Dọn symbol dead/catch rỗng trong 5 utility và worker:

- desktop/src/stores/useWorkspaceStore.ts — bỏ import ProcessingSettings không dùng.
- desktop/src/lib/pdfImposer.ts — bỏ import InstructionSet không dùng.
- desktop/src/workers/plateInfoWorker.ts — làm rõ catch metadata lỗi mã hóa; tiếp tục quét các trang còn lại.
- desktop/src/lib/fileContext.tsx — bỏ tabId cục bộ không đọc và thêm chú thích cho ba catch URL cleanup.
- desktop/src/lib/recipe/recipeRunners.ts — thay destructuring ba biến ignored bằng bản sao params rồi loại các khóa file phụ trước khi gọi runner; giữ nguyên hợp đồng không tin file đã serialize.

## Verify

- ESLint cleanup rules (no-unused-vars/no-empty): sạch trong cả 5 file; explicit-any/Fast Refresh còn lại là backlog riêng.
- Regression: 12 test files, 116/116 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.369 → 1.358, warnings 105 → 105; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Không thay đổi payload nghiệp vụ; recipe vẫn loại đúng insert/odd/even file trước khi phát lại, worker vẫn bỏ qua metadata lỗi và tiếp tục.
