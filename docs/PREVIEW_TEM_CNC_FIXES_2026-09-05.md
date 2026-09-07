# Sửa preview Tem/CNC — lô cấu hình và tiến trình

## Phạm vi đã duyệt

Người dùng duyệt “ok sửa đi” cho §PV26.1 và §PV26.2 trong `BAO_CAO_AUDIT_PREVIEW_TEM_CNC_UI_TOC_DO_2026-09-05.md`: thống nhất cấu hình hiệu lực và trạng thái tính toán. Lô này gồm 4 file code/test và nhật ký này; không đổi backend, solver, cache/worker hoặc thuật toán vẽ contour.

Thao tác người dùng mô tả: so phần sức chứa/pager giữa Bình tem và CNC, CNC không thấy thanh tiến trình; ảnh cho thấy “32 tem/tờ”, “tờ 2/17”. File đã cung cấp là `D:/pdfcompare/test/cac loai hinh - Copy.pdf`. Chưa có đầy đủ profile/chuỗi mở file của phiên trong ảnh, nên kiểm thử tự động không được coi là xác nhận runtime của ảnh đó.

## §PV26.1 — Cùng cấu hình Bình trang tại mọi đầu ra

- `desktop/src/components/imposition-tools/ImposerDashboard.tsx`: một `effectiveGroupingStrategy` dùng chung ở props GridPreview, gate chọn nesting, payload bảng sức chứa và callback export.
- Bình trang dùng `none`, khớp hành vi export đã có; các tác vụ khác giữ quy tắc grouping hiện hành.
- Không ghi đè `s.groupingStrategy` hay profile lưu. Chuyển lại Dàn nhiều mẫu vẫn nhận grouping người dùng đã chọn.
- Dependency làm mới bảng sức chứa dùng cấu hình hiệu lực; thay grouping ẩn khi vẫn Bình trang không xóa capacity hoặc gửi request thừa.
- `ImposerDashboard.groupingParity.test.tsx`: mount Dashboard thật với mock biên UI/API, kiểm props, predicate nesting thật, JSON request batch và callback export.

Baseline: 7/11 test đỏ do preview/gate/batch giữ grouping cũ. Sau sửa và bổ sung ca dependency: 12/12 xanh. Phủ Tem, CNC, N-Up, mẫu CUSTOM, Dàn nhiều mẫu, lưu/khôi phục profile và không refetch khi grouping hiệu lực không đổi.

## §PV26.2 — Một vùng trạng thái cho cả nhánh lưới và nesting

- `desktop/src/components/imposition-tools/sections/GridPreview.tsx`: hiển thị vùng trạng thái chung khi preview đang tính và tab đang active.
- Nhánh lưới (kể cả fallback sau quality gate) có thanh chờ không xác định, không hiện phần trăm hay nút hủy solver nesting.
- Nhánh nesting giữ phase và % thực nhận từ backend. Trong thời gian chỉ có mã job/status chưa có tiến trình, không tự dựng 0% hoặc 100%.
- Trạng thái hủy vẫn giữ nút hủy bị khóa và nhãn đang hủy; không thay giao thức cancellation/publication.
- Không lặp lại thông báo chờ ở vùng preview trống. Khi có hình cũ, giữ hình trong lúc tính lại như trước.
- `GridPreview.mixedDuplex.test.tsx`: thêm ca Tem/CNC lưới, tiến trình nesting thật, chờ ACK/status chưa có %, tab nền/kết quả muộn; bổ sung kiểm tra fallback lỗi và hủy trước ACK.

Baseline: 3 test đỏ vì thiếu vùng trạng thái lưới; một ca bổ sung đỏ vì UI tự hiện 0% sau ACK. Các ca đó đã xanh sau sửa. Test cũ về contour, duplex, pager, handoff, cancel và stale vẫn được giữ.

## Verify cuối

Windows, cwd `D:/pdfcompare/desktop`:

| Lệnh / phạm vi | Kết quả |
|---|---|
| `npm run typecheck` | Pass |
| Vitest: `ImposerDashboard.groupingParity.test.tsx`, `GridPreview.mixedDuplex.test.tsx`, `trueShapeNestingRollout.test.ts` | 110/110 pass, 3 file |
| ESLint 4 file code/test của lô | Pass, không warning/error |
| `git diff --check` | Pass; chỉ cảnh báo chuyển dòng LF/CRLF của working tree |

Không cập nhật snapshot/golden. Không commit hoặc can thiệp các thay đổi cũ trong working tree.

## Giới hạn và kiểm tra tay còn lại

Đạt mức bằng chứng code/typecheck và regression tự động; chưa thao tác lại trong cửa sổ Tauri thật với PDF 17 trang. Cần reload bản dev rồi kiểm:

1. Cùng file, bật Bình trang trong Tem/CNC: cấu hình chia nhóm cũ không chặn nesting khi có mẫu CUSTOM tham gia.
2. Mẫu đi nhánh lưới vẫn có thanh chờ; nesting có phase/% khi backend trả; hoàn tất/lỗi/hủy thì trạng thái tắt đúng.
3. Đổi trang, đổi tab khi đang tính; kết quả cũ không ghi vào tab/trang không còn đúng đích.
4. Chuyển lại Dàn nhiều mẫu: grouping trước đó vẫn được giữ; preview/export cùng cấu hình thực.

Đây không phải lô tăng tốc solver. Không công bố % cải thiện latency từ các test UI này. Những đề xuất giảm công việc trùng/shared snapshot/hiển thị từng tờ còn cần benchmark và lô riêng sau khi xác nhận runtime.
