# Lô lint P2.10 — 2026-08-23

## Phạm vi

Chuẩn hóa contract và UX lỗi của Web Worker so sánh văn bản trong 4 file:

- desktop/src/workers/textDiffProtocol.ts — contract chung cho request, diff part và response thành công/thất bại.
- desktop/src/workers/textDiffWorker.ts — dùng protocol chung, bắt unknown và lấy message an toàn.
- desktop/src/components/TextCompareTab.tsx
  - dùng DiffPart[] thay any[];
  - hiển thị lỗi worker inline với role="alert";
  - chỉ báo “hai văn bản giống nhau” sau khi đã có kết quả thành công;
  - xóa lỗi khi người dùng sửa text, đổi chế độ hoặc tùy chọn khoảng trắng.
- desktop/src/components/TextCompareTab.test.tsx — regression payload, kết quả thêm/xóa, lỗi worker và xóa cảnh báo khi sửa input.

Lô này chưa xử lý race worker cũ trả kết quả sau khi người dùng sửa trong lúc đang chạy; đó là lô hành vi riêng cần request revision/abort contract.

## Verify

- ESLint hẹp: 4 file sạch.
- Regression: TextCompareTab.test.tsx 4/4 đạt; bổ sung nhánh worker.onerror và xác nhận nhãn lỗi không bị lặp.
- Regression chung các file liên quan: 5 file, 34/34 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: số đo toàn kho mới nhất errors=1.319, warnings=103; budget gate đạt. Số này gồm các lô song song nên không dùng để quy riêng mức giảm cho TextCompare.
- git diff --check: đạt.
- Không build release, không commit, không push.

## Kết luận

Worker có contract rõ ràng và lỗi không còn bị nuốt hoặc hiển thị nhầm thành kết quả “giống nhau”.
