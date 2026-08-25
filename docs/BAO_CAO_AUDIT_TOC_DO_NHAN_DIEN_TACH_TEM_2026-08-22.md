# Báo cáo audit tốc độ nhận diện tách nhiều tem

Ngày audit: 2026-08-22  
Phạm vi: `Bù xén – Tạo đường cắt → Tách nhiều tem` (`ai-sheet`)

## 1. Kết luận điều hành

[VERIFIED] Nút nghẽn lớn nhất ở lượt nhận diện đầu tiên là suy luận AI (BiRefNet lite) khi chạy CPU, không phải route HTTP hay thuật toán tách component. Với fixture đo được, lượt lạnh mất khoảng 10–11 giây; khi session/cache đã nóng, cùng đường đi còn khoảng 34 ms.

[VERIFIED] Đường đi xác định (CutContour, alpha/vector, nền đơn giản) nhanh hơn nhiều: fixture tổng hợp đo khoảng 80 ms cho inspect + detect. Vì vậy không nên đổi mặc định model hoặc giảm chất lượng đầu ra chỉ để che độ trễ của nhánh AI.

[SUSPECTED] Cảm giác “đứng” trên UI bị khuếch đại bởi việc frontend chờ inspect và tải preview blob trước khi bắt đầu detect. Đây là độ trễ có thể giảm ở perceived latency mà không đổi hình học/mask.

[SUSPECTED] PDF nhiều trang có thể chậm do inspect quét toàn bộ trang và tìm CutContour từng trang trước khi render preview. Cần fixture PDF nhiều trang thực tế để định lượng trước khi thay đổi chiến lược.

## 2. Luồng đã truy vết

### Frontend

1. `desktop/src/components/preprocess-tools/StickerCutlineTool.tsx` chọn mode `ai-sheet` và render `StickerSheetPanel`.
2. `desktop/src/components/preprocess-tools/StickerSheetPanel.tsx:153-169` gọi `actions.detectStickers(tabId, 'auto', pageNumber)` từ `prepareCutline()`.
3. `desktop/src/components/preprocess-tools/StickerSheetPanel.tsx:220-228` hiển thị hai trạng thái “Đang chuẩn bị ảnh để nhận diện…” và “Đang nhận diện từng tem và loại bóng…”.
4. `desktop/src/components/preprocess-tools/stickerSheetStore.ts` đặt trạng thái `inspecting`; nếu chưa có inspect thì `detectStickers()` đợi inspect hoàn tất rồi mới POST detect. Model mặc định là `birefnet-lite`.
5. `desktop/src/lib/stickerSheetApi.ts:214-229` POST manifest inspect, sau đó GET preview blob; `detectStickerSource()` POST detect rồi tải preview/labels/uncertainty.

### Backend

1. `backend/app/api/routes/sticker_sheet.py` đưa inspect/detect vào threadpool hoặc heavy scheduler tùy strategy.
2. `backend/app/workers/sticker_source_inspector.py` xử lý EXIF/ICC/alpha, resize preview (tối đa 2000 px), đo nền; với PDF parse toàn bộ trang, tìm CutContour, rồi render preview PDFium.
3. `backend/app/workers/sticker_source_pipeline.py` thử theo thứ tự CutContour → alpha/vector đã render → nền đơn giản → AI.
4. `backend/app/workers/sticker_sheet_engine.py` hash RGB nguồn và lưu alpha cache persistent; cache hit bỏ qua suy luận.
5. `backend/app/workers/birefnet_engine.py` nạp session ONNX lười, input cố định 1024×1024, có DirectML/CPU fallback và RAM-gating.

## 3. Số đo tái lập được

Các phép đo chạy bằng `backend\\venv\\Scripts\\python.exe`; không dùng Python global.

| Kịch bản | Kết quả quan sát |
| --- | ---: |
| Inspect PDF fixture | 0,30 s lượt đầu; 0,07 s các lượt sau |
| Inspect JPEG 6000×4000 (24 MP) | khoảng 0,43 s tổng; resize preview khoảng 0,32 s |
| `predict_alpha` BiRefNet lite, CPU, 1024×1024 | 10,24 s lượt đầu; 6,46 s lượt kế |
| `analyze_sticker_sheet` AI, ảnh hai tem | 10,94 s lạnh (model 10,02 s; hậu xử lý 0,62 s) |
| Cùng ảnh sau cache alpha | khoảng 0,034 s |
| `isnet` cùng ảnh (tham khảo) | khoảng 2,25 s lạnh; chưa đủ quality gate để thay mặc định |
| Auto deterministic, ảnh tổng hợp hai tem | inspect 0,025 s + detect 0,079 s; không gọi model |

Benchmark `pytest tests/test_sticker_source_pipeline.py` chọn 3 case: `3 passed, 57 deselected`. Thời gian setup fixture lớn (~9,74 s) không thuộc thân pipeline; không dùng nó làm kết luận runtime người dùng.

## 4. Findings và mức độ tin cậy

### Đã xác minh

- Nhánh `auto` hiện đã được gọi từ UI; không còn lỗi cũ là ép AI ở entry point.
- Cache alpha persistent hoạt động và chênh lệch cold/warm rất lớn.
- RAM-gating tuân thủ bất biến dự án: máy RAM cao không bị hard-cap; chỉ máy yếu mới hạ giới hạn.
- Không thấy log theo pixel/component trong hot loop; logging không phải nguyên nhân chính.

### Cần xác minh thêm bằng fixture thực tế

- Tỉ lệ file thực tế rơi vào AI (so với CutContour/alpha/vector/nền đơn giản).
- PDF nhiều trang: thời gian scan toàn bộ trang, số lần render và lợi ích của lazy scan.
- Chất lượng và thời gian nếu dùng model nhanh hơn/resolution preview thấp; benchmark synthetic không đủ để tự đổi model mặc định.

## 5. Kế hoạch tối ưu đề xuất

Tuân thủ quy trình audit: mỗi lô tối đa 5 file, verify xong mới sang lô kế; chưa sửa production code trong báo cáo này.

### Lô A — giảm độ trễ cảm nhận (rủi ro thấp)

- `desktop/src/lib/stickerSheetApi.ts`
- `desktop/src/components/preprocess-tools/stickerSheetStore.ts`
- `desktop/src/components/preprocess-tools/StickerSheetPanel.tsx`
- test API/store liên quan (nếu có)

Mục tiêu: không bắt buộc tải lại preview blob khi đã có local preview/Viewer source; tách hoặc hoãn asset chỉ dùng cho hiển thị; hiển thị stage/progress và thời gian rõ ràng. Không đổi mask, geometry hoặc tiêu chí nhận diện.

### Lô B — giảm cold-start AI (cần duyệt riêng)

- `backend/app/workers/sticker_sheet_engine.py`
- `backend/app/workers/birefnet_engine.py`
- test inference/cache

Các lựa chọn cần đo quality gate: warm session sau hành động có chủ ý; preview nhanh ở độ phân giải thấp rồi full-quality khi xác nhận; hoặc model nhanh hơn cho preview. Không tự thay `birefnet-lite` mặc định chỉ dựa trên benchmark đơn lẻ.

### Lô C — PDF nhiều trang (sau khi có fixture)

- `backend/app/workers/sticker_source_inspector.py`
- session/route/test liên quan

Mục tiêu: cache kết quả inspect, lazy scan CutContour theo trang cần dùng, tránh raster/render lặp nếu chứng minh giữ parity.

## 6. Tiêu chí nghiệm thu

- Deterministic path không tăng thời gian hoặc thay đổi số instance/biên mask.
- Cache hit vẫn trả kết quả đúng và không dùng cache sai nguồn (hash/metadata giữ nguyên hợp đồng).
- AI cold path có stage progress hữu ích; không làm UI báo hoàn tất trước khi artifact sẵn sàng.
- PDF nhiều trang giữ đúng kích thước vật lý, thứ tự trang và CutContour.
- Chạy typecheck/test hẹp theo `prynx-testing` trên Windows thật trước khi báo hoàn thành.

## 7. Quyết định cần người dùng xác nhận

Đề nghị duyệt **Lô A** trước. Đây là lô ít rủi ro, tập trung vào luồng chờ và hiển thị; sau khi verify mới quyết định có đầu tư Lô B/C. Việc đổi model hoặc thay chiến lược PDF chưa được coi là đã được phê duyệt.
