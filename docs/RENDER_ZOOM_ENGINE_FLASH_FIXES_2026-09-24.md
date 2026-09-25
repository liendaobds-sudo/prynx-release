# Sửa chớp PDFium/PPE khi zoom — R24.07 — 2026-09-24

**Đã áp dụng theo yêu cầu “sửa đi”: SOURCE + AUTO đạt; GUI/compositor trên file người dùng chưa xác minh lại.** Tham chiếu [chẩn đoán và bằng chứng trước sửa](CHAN_DOAN_CHOP_PDFIUM_PPE_KHI_ZOOM_2026-09-24.md).

## Thay đổi

- `LivePageFrame.tsx:1913`: bỏ các nhánh `hasIncomingTarget` và `!accurateCommitted` tự bật display, đưa viewport về cùng `shouldUseViewerDisplayLayer` với base. Khi PPE đã commit, target zoom/pan mới chỉ yêu cầu PPE; giữ PPE cũ/underlay theo coverage tới khi thay bằng target hợp lệ.
- `LivePageFrame.tsx:3146`: bỏ display-first vô điều kiện cho trang cần PPE. Chỉ giữ preview display khi trang thông thường chuyển sang Output Preview; sau accurate commit không bật lại display trên mỗi zoom. Điều này cũng ngăn PDFium phủ lên PPE prime trong lúc target đầu đang tải.
- Giữ guard retire R24.04; không thay z-index, DPI, scheduler, worker, kernel màu hoặc native transport. Không thêm cap tài nguyên.
- `LivePageFrame.liveTile.test.tsx`: thay assertion cũ “PPE hoặc display còn mounted” bằng kiểm canvas có pixel trên cùng ở vùng giao nhau. Giữ ca chuyển sang Output Preview hợp lệ, bổ sung các ca phủ phía dưới.

Lô gồm 5 file: component, test component, nhật ký này, master matrix và cập nhật đầu báo cáo chẩn đoán. Không commit/build/restart ứng dụng; các sửa khác đang có trong working tree được giữ nguyên.

## Kiểm chứng trước/sau

Trước patch production, 8 regression cases chạy: **7 fail / 1 pass**, trong đó bốn tổ hợp zoom cho canvas display B phủ PPE A. Đã kiểm riêng lại cold-open với **đúng cache key**: display cache hiện ra trước PPE và assertion thất bại. Sau patch tất cả đạt; không thay expectation theo hành vi lỗi để làm xanh.

10 ca R24.07 cuối cùng:

1. Zoom-in, 4 tổ hợp có/không cờ underlay và có/không yêu cầu giữ display: PPE cũ còn trên cùng khi target pending; không có display request; PPE mới thay và retire PPE cũ.
2. Cold-open trang PPE có bitmap display trong cache đúng key: không mount/khôi phục display.
3. Trang display-only: zoom vẫn render và thay viewport, không yêu cầu PPE.
4. Trang thường chuyển sang Output Preview: preview tồn tại trước PPE commit; zoom sau commit không bật lại display.
5. Target zoom PPE về trễ không phủ target mới hơn.
6. Zoom-out làm thiếu coverage: giữ PPE cũ ở phần giao nhau khi chưa có underlay; PPE mới phủ mép mới sau decode.
7. Pan trong scroller cố định: không gọi display, clip cũ về trễ không phủ clip mới.

Các item có tham số được tính thành 10 test, không phải 7. Helper DOM chỉ kiểm điểm được chọn và thứ tự lớp/opacity; cờ `stableUnderlayReady` trong fixture không thay bằng chứng underlay thật hoặc toàn viewport. Ca zoom-out chủ động phân biệt vùng giao nhau với mép chưa có pixel.

Kiểm cuối trên Windows:

```powershell
cd desktop
npm run typecheck
.\node_modules\.bin\vitest.cmd run src/components/workspace/LivePageFrame.liveTile.test.tsx src/components/workspace/LivePageFrame.renderPolicy.test.ts src/components/workspace/viewportTilePolicy.test.ts src/components/workspace/renderZoomPolicy.test.ts src/hooks/viewer/useTileRenderer.test.ts src/lib/viewerFirstFrame.test.ts
```

- Typecheck: **exit 0**.
- Vitest: **6 file / 163 test đạt**, gồm 50 test trong file component, 10 ca R24.07. Không cộng các lần chạy hẹp/lặp vào tổng.
- Suite hook vẫn in diagnostic jsdom thiếu Canvas API trong ca fallback; không có assertion thất bại. Không dùng unit test đó để tuyên bố pixel fallback WebView đã được nghiệm thu.
- Không cập nhật snapshot/golden. Rust/backend không đổi nên không build/test lại các tầng đó trong lô này.

## Runtime và giới hạn

Vite đang phục vụ `LivePageFrame.tsx` mới: source-map khớp byte source trên đĩa, SHA-256 `30bcd2bdc9ff79e1f40bf9ced0fc99b24bb1eb53c5ee16c6e09e4bceb0d602d4`. App PID 19276, WebView 36352 và Vite 28624 còn chạy; WebView có kết nối tới Vite tại lần kiểm.

Chưa có thao tác zoom mới trong log tại checkpoint sau patch (trace cuối `Vmufnodgm-dg2qwj`, seq 21553). Kiểm được source đã phục vụ, chưa chứng minh HMR đã áp vào compositor. Công cụ UI trả Transport closed, native UI bị disabled và không có CDP listener 9222–9224; không restart phiên đang làm việc chỉ để mở automation. Đã hỏi người dùng thử đúng trang đang lỗi, chưa có kết quả GUI tại lúc lập nhật ký.

## Đánh đổi và phần còn mở

- Trang cần PPE mà chưa có prime phải chờ pixel PPE đầu tiên. Đây là thay đổi có chủ đích để tránh đổi engine/màu trước target đầu; không tuyên bố first-visible nhanh hơn. Trang display-only vẫn giữ đường PDFium.
- Không đủ cơ sở tuyên bố tăng FPS, giảm input→sharp hoặc ngang Acrobat từ lô này. Chốt đạt hiện tại là bỏ display trung gian trong các ca đã kiểm.
- Fallback vì PPE unsupported và thiếu actual-engine metadata là nhánh riêng trong hook, chưa thay đổi. Không dùng nhãn `accurate` đơn thuần để chứng minh engine thực tế.
- Cần lặp wheel zoom lên/xuống, pan, chuyển full-page↔viewport trên đúng file người dùng để đóng gate GUI. Giữ R24.07 ở trạng thái **SOURCE + AUTO / GUI pending**, không coi toàn bộ vấn đề chất lượng render đã đóng.

Rollback chỉ hai hunk có tag R24.07 và test tương ứng nếu phát sinh hồi quy; giữ R24.04 và các sửa độc lập khác. Không reset repository.
