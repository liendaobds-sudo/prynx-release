# BÁO CÁO AUDIT ANIMATION VÀ HIỆU ỨNG UI PRYNX

**Ngày:** 07/08/2026  
**Trạng thái:** ĐÃ DUYỆT VÀ SỬA ĐỦ 3 LÔ — VERIFIED AUTO  
**Phạm vi:** vòng `requestAnimationFrame`, animation/transition CSS, blur nền, tab ẩn, cửa sổ chạy nền, reduced-motion và phân tầng hiệu ứng theo RAM.  
**Ngoài phạm vi:** tốc độ render PDF/PDFium, chất lượng màu/gradient của viewer, nghiệp vụ và định dạng file xuất.

> Mục tiêu của đợt này là giảm tải khi UI đứng yên hoặc không nhìn thấy, không đổi chất lượng hiển thị của nội dung PDF. Máy từ 16 GB RAM trở lên phải giữ đầy đủ hiệu ứng khi đang thao tác.

> **Cập nhật sau duyệt 07/08/2026:** §MOTION.1–§MOTION.5 đã được xử lý theo đúng ba lô. Typecheck, 1.961 test frontend và production build đều đạt. Chưa đo CPU runtime 60 giây trên ứng dụng Tauri thật nên mức bằng chứng hiện tại là **Mức 2 — tự động**.

---

## 1. Kết luận điều hành

Animation có thể làm PrynX nặng hơn, nhưng không phải mọi animation đều là vấn đề. Code hiện tại không dùng Framer Motion/Lottie; phần lớn transition hover và spinner chỉ chạy ngắn, chi phí thấp. Cảnh khuôn bế 3D cũng đã dùng `frameloop="demand"` và tự tháo khỏi tab nền nên không phải thủ phạm idle chính.

Phát hiện cần xử lý là:

1. **P1 — Viewer có các vòng RAF chạy liên tục khi đứng yên.** Khi bật thước, mỗi viewer tạo bốn nhịp RAF thường trực từ hai `Ruler`; ngoài ra `GuideLayer` và `DimensionLayer` mỗi lớp thêm một vòng RAF. Một số vòng đọc layout và vẽ lại canvas mỗi frame.
2. **P1 — Chi phí trên tăng theo số tab PDF đang giữ mounted.** App ẩn tab bằng opacity nhưng không unmount. `AcrobatViewer` đã có `isActive`, song ba lớp thước/guide/DIM chưa dùng tín hiệu này. Việc suspend bitmap sau 20 giây không tháo các lớp overlay nói trên.
3. **P2 — Animation CSS của cây tab ẩn/cửa sổ nền chưa có cổng dừng chung.** Spinner/pulse có thể tiếp tục chạy trong vùng không nhìn thấy. PrynX cố ý tắt throttling nền của WebView2 để tránh hồi quy trắng/đơ, vì vậy phải tự pause ở tầng ứng dụng.
4. **P2 — `perf-low` chưa bám đúng phân tầng RAM của dự án.** Bootstrap chỉ giảm khi CPU ≤4 hoặc `deviceMemory ≤4`; nếu WebView không trả API thì mặc định 8 GB. Như vậy máy 6 GB có thể không được bảo vệ, máy 8–15 GB không có mức giảm nhẹ, và tín hiệu CPU có thể giảm hiệu ứng trên máy ≥16 GB trái policy.

Không có P0. Không đề xuất tắt toàn bộ animation hoặc hạ chất lượng trên mọi máy.

---

## 2. Bằng chứng và phát hiện

### §MOTION.1 — [FIXED — VERIFIED AUTO] P1 / M — Thước, guide và DIM tự vẽ 60 lần/giây khi viewer đứng yên

**Bằng chứng**

- `desktop/src/components/acrobat/Ruler.tsx:47-73`: một vòng RAF chỉ để dò thay đổi `scrollLeft/scrollTop`.
- `Ruler.tsx:97-268`: vòng RAF thứ hai xóa và vẽ lại toàn bộ canvas; mỗi frame còn đọc `getBoundingClientRect`, duyệt vạch hai lượt và kiểm vị trí chuột.
- `desktop/src/components/acrobat/GuideLayer.tsx:24-65`: vòng RAF đọc scroll/layout rồi ghi transform cho toàn bộ guide. Vòng này vẫn chạy khi danh sách guide rỗng.
- `desktop/src/components/acrobat/DimensionLayer.tsx:12-26`: vòng RAF đọc hai rect và ghi bốn thuộc tính style mỗi frame, kể cả khi không có DIM.
- `desktop/src/components/AcrobatViewer.tsx:1802-1833`: hai `Ruler` chỉ phụ thuộc `showRulers`; `GuideLayer` và `DimensionLayer` luôn mount khi viewer có trang. Không lớp nào nhận `isActive`.

**Tác động**

- Với thước bật: một tab có ít nhất 6 callback RAF lặp vô hạn từ ba lớp này; trong đó hai callback vẽ canvas đầy đủ.
- Tải tồn tại cả khi chuột và trang đứng yên; có nguy cơ ép WebView giữ nhịp render/compositor, làm quạt quay và giảm độ phản hồi của tác vụ khác.
- Tải tăng theo số viewer đang giữ mounted.

**Cách sửa đúng**

- Chuyển sang mô hình theo sự kiện: scroll, resize, đổi zoom/đơn vị/trang, đổi theme và pointer move mới yêu cầu vẽ.
- RAF chỉ dùng để **gộp nhiều sự kiện vào một frame**, không tự gọi lại chính nó.
- Truyền `isActive` xuống ba lớp; tab nền không gắn listener toàn cục và không giữ RAF.
- Khi tab hoạt động lại, đồng bộ một frame ngay để thước/guide/DIM bám đúng trang.

**Tiêu chí đạt:** trạng thái idle không còn RAF tự lặp trong ba component; vị trí và độ mượt khi scroll/zoom/drag giữ nguyên bằng kiểm tay.

### §MOTION.2 — [FIXED — VERIFIED AUTO] P1 / S — Tab nền vẫn giữ toàn bộ lớp overlay hoạt động

**Bằng chứng**

- `desktop/src/App.tsx:1397-1404`: app render toàn bộ tab và ẩn tab nền bằng `opacity-0 pointer-events-none`; component không unmount.
- `desktop/src/components/AcrobatViewer.tsx:612-617`: tab nền chỉ suspend cây trang sau 20 giây.
- `AcrobatViewer.tsx:1802-1833`: thước/guide/DIM nằm ngoài điều kiện `suspendViewer`, nên vẫn sống sau mốc 20 giây.
- `AcrobatViewer` đã nhận `isActive` và dùng đúng cho hotkey, tile renderer, menu; thiếu sót chỉ nằm ở đường overlay.

**Tác động**

Một khách mở nhiều file rồi chuyển qua lại có thể trả chi phí idle cho nhiều viewer cùng lúc. Đây là dạng hồi quy cảm nhận rõ hơn trên máy văn phòng: app không làm việc nhưng CPU UI vẫn có tải.

**Cách sửa đúng**

Xử lý cùng §MOTION.1: `isActive=false` phải dừng listener/RAF của overlay ngay, không chờ 20 giây và không làm mất state guide/DIM.

### §MOTION.3 — [FIXED — VERIFIED AUTO] P2 / S — Animation CSS không được pause theo tab/cửa sổ nền

**Bằng chứng**

- App dùng opacity để ẩn tab, nên CSS animation trong subtree vẫn tồn tại.
- Có nhiều spinner/pulse theo trạng thái xử lý, ví dụ `AcrobatViewer.tsx:1775-1776`, `ThumbSidebar.tsx:233-234`, `ImpositionTab.tsx:2395`, `OutputPreviewTab.tsx:592` và các công cụ preprocess.
- `desktop/src/lib/appVisibility.ts` đã có nguồn trạng thái foreground chuẩn, kết hợp `document.visibilityState` và focus cửa sổ Tauri, nhưng hiện chỉ scheduler tile/process sử dụng.
- WebView2 đang cố ý giữ các cờ chống background throttling trong `desktop/src-tauri/src/lib.rs:3353-3362`; không được gỡ mù vì đây là workaround của lỗi occlusion trước đây.

**Cách sửa đúng**

- Gắn trạng thái active lên root của từng tab; CSS đặt `animation-play-state: paused` cho subtree tab ẩn.
- Đồng bộ một class trên `<html>` từ `appVisibility.ts`; pause animation CSS khi app minimize/mất focus, resume khi foreground.
- Chỉ pause phần **không nhìn thấy**. Tab active ở foreground vẫn giữ hiệu ứng đầy đủ trên máy ≥16 GB.
- Thanh tiến trình vô định vẫn chạy khi đang nhìn thấy; không xóa ngoại lệ essential motion hiện có.

**Tiêu chí đạt:** spinner/pulse trong tab ẩn và cửa sổ nền ở trạng thái paused; khi quay lại tab/app, hiệu ứng tiếp tục và trạng thái công việc vẫn chính xác.

### §MOTION.4 — [FIXED — VERIFIED AUTO] P2 / M — Nhận diện cấu hình UI chưa đúng ba tier RAM

**Bằng chứng**

- `desktop/src/lib/appearanceBootstrap.ts:31-40`: `perf-low` chỉ bật khi `hardwareConcurrency <= 4` hoặc `deviceMemory <= 4`; giá trị RAM mặc định là 8 GB.
- Policy dự án yêu cầu: `<8 GB` giảm mạnh, `8–15 GB` giảm nhẹ, `≥16 GB` giữ đầy đủ.
- Native đã có nguồn RAM thật và command sẵn: `desktop/src-tauri/src/lib.rs:974-1021` trả `installedBytes/totalBytes/usableBytes/availableBytes`; command đã đăng ký tại `lib.rs:3371`. Không cần thêm dependency hoặc command Rust mới.
- `desktop/src/index.css:576-600` có `prefers-reduced-motion` và `perf-low`, nhưng chưa có tier trung gian.

**Cách sửa đúng**

- Giữ bootstrap đồng bộ để theme không nháy; sau đó đọc `get_system_memory_status` bất đồng bộ và hiệu chỉnh class theo RAM lắp đặt thật.
- `<8 GB`: `perf-low`, giảm mạnh animation/transition/blur.
- `8–15 GB`: `perf-mid`, chỉ giảm hiệu ứng đắt như blur lớn và chuyển động trang trí dài; không làm UI đứng im như tier thấp.
- `≥16 GB`: xóa cả hai class giảm hiệu ứng, giữ full.
- Nếu native không đọc được RAM: fail-open, giữ heuristic hiện tại và không tự hạ máy chưa xác định.

**Tiêu chí đạt:** test biên 4/8/15/16/32 GB; máy ≥16 GB không còn bị giảm chỉ vì ít core hoặc API WebView báo thiếu.

### §MOTION.5 — [FIXED — VERIFIED AUTO] P3 / S — Một số blur CSS trực tiếp lọt ngoài `perf-low`

**Bằng chứng**

- `desktop/src/styles/dieline-tool.css:868`: `.dt-fold-controls` dùng `backdrop-filter: blur(12px)`.
- `dieline-tool.css:683`: overlay dùng blur trực tiếp 1 px.
- Rule `html.perf-low [class*="backdrop-blur"]` trong `index.css:591-594` chỉ bắt utility class; không bắt hai selector trên.
- Các class `.glass/.glass-card/.glass-panel` đã có rule riêng, nên không phải lỗi.

**Cách sửa đúng**

Gộp với §MOTION.4: tier thấp tắt blur trực tiếp; tier giữa giảm blur 12 px xuống mức nhẹ; tier ≥16 GB giữ nguyên.

---

## 3. Những phần không nên “tối ưu” trong đợt này

1. **Cảnh 3D khuôn bế:** `MockupCanvas.tsx:113-116` đã dùng `frameloop="demand"`; `DielineTool.tsx:415-435` thay cảnh 3D bằng placeholder khi tab nền. Fold/demo chỉ chạy hữu hạn khi người dùng bấm. Không hạ DPR/chất lượng ở máy mạnh.
2. **RAF gộp sự kiện:** zoom/pointer/crop/sticker dùng một RAF sau sự kiện để tránh render dồn. Đây là tối ưu đúng, không phải loop idle.
3. **Spinner tiến trình:** phản hồi đang xử lý là tín hiệu cần thiết. Chỉ pause khi không nhìn thấy; không xóa.
4. **`prefers-reduced-motion`:** lớp hiện tại đã đúng mục tiêu accessibility và phải giữ.
5. **Overlay spotlight GIF:** đây là false positive đã biết trong tài liệu hiệu năng; không xóa các bản overlay phục vụ spotlight.
6. **`transition-all` đại trà:** nhiều chỗ chỉ chạy ngắn khi hover/modal. Chỉ thay khi có profile chứng minh hot path; không mở chiến dịch sửa hàng chục file trong đợt này.

---

## 4. Kế hoạch sửa theo lô

### Lô 1 — Dừng RAF idle của viewer (tối đa 5 file)

1. `desktop/src/components/acrobat/Ruler.tsx`
2. `desktop/src/components/acrobat/GuideLayer.tsx`
3. `desktop/src/components/acrobat/DimensionLayer.tsx`
4. `desktop/src/components/AcrobatViewer.tsx`
5. Một test lifecycle RAF mới trong `desktop/src/components/acrobat/`

**Gate:** không còn callback tự reschedule ở idle; inactive không gắn listener; scroll/zoom/theme/đổi tab vẫn cập nhật đúng; test hẹp + typecheck.

### Lô 2 — Pause motion của tab ẩn và cửa sổ nền (tối đa 5 file)

1. `desktop/src/App.tsx`
2. `desktop/src/index.css`
3. `desktop/src/lib/appVisibility.ts`
4. `desktop/src/lib/appVisibility.test.ts`
5. Test policy tab active/inactive nếu cần

**Gate:** tab ẩn và app nền pause CSS animation; tab active foreground không đổi; chuyển tab/minimize/restore không mất state.

### Lô 3 — Chuẩn hóa tier hiệu ứng theo RAM thật (tối đa 5 file)

1. `desktop/src/lib/appearanceBootstrap.ts`
2. `desktop/src/lib/appearanceBootstrap.test.ts` mới
3. `desktop/src/main.tsx`
4. `desktop/src/index.css`
5. `desktop/src/styles/dieline-tool.css`

**Gate:** test biên `<8`, `8–15`, `≥16`; lỗi IPC fail-open; máy ≥16 GB full; blur trực tiếp tuân theo tier.

Mỗi lô phải verify xong mới sang lô tiếp theo. Không trộn thay đổi viewer màu/gradient hoặc các thay đổi Sticker/N-Up đang có trong worktree.

---

## 5. Ma trận verify sau sửa

| Kịch bản | Điều cần chứng minh |
|---|---|
| 1 tab PDF, thước tắt, đứng yên 60 giây | Không có RAF tự lặp từ Guide/DIM; CPU UI ổn định |
| 1 tab PDF, thước bật, đứng yên 60 giây | Không redraw canvas liên tục; vạch thước vẫn đúng |
| Scroll/zoom/đổi trang/đổi theme | Thước, guide, DIM cập nhật trong frame kế tiếp, không nhảy lệch |
| 5 tab PDF, chỉ 1 tab active | Chỉ tab active gắn lifecycle viewer; tab nền không phát sinh RAF overlay |
| Đang xử lý rồi chuyển tab | Công việc tiếp tục; chỉ spinner vô hình bị pause |
| Minimize/restore | UI animation pause/resume; backend job và trạng thái kết quả không mất |
| RAM giả lập 4/8/15/16/32 GB | Lần lượt low/mid/mid/full/full |
| Windows Reduced Motion | Vẫn tôn trọng cài đặt hệ điều hành |
| Khuôn bế 3D | Chất lượng foreground và hoạt ảnh gập không giảm trên máy ≥16 GB |

Đo runtime nên dùng cùng một file PDF và cùng trạng thái thước, ghi CPU/RAM sau 60 giây idle trước–sau. Build/test xanh không thay thế phép đo này.

---

## 6. Kết quả triển khai

### Lô 1 — Viewer event-driven

- `Ruler`, `GuideLayer`, `DimensionLayer` không còn tự reschedule RAF khi idle.
- RAF chỉ gộp scroll/resize/mouse/theme/content mutation vào tối đa một frame.
- `AcrobatViewer` truyền `isActive`; tab nền không giữ listener/RAF overlay.
- Test lifecycle chứng minh callback chạy xong không tự lên lịch lại, event dồn chỉ tạo một frame và tab nền tạo 0 RAF.

### Lô 2 — Pause vùng không nhìn thấy

- Root từng tab có `data-prynx-tab-active`.
- CSS pause animation và rút transition còn 0,01 ms trong tab ẩn/cửa sổ nền.
- `appVisibility` được khởi tạo ngay cùng `App`, đồng bộ class từ cả visibility document và focus native.
- Không dừng backend job hoặc xóa spinner; khi foreground/tab active, hiệu ứng hoạt động lại.

### Lô 3 — RAM tier thật

- Bootstrap vẫn đồng bộ frame đầu, sau đó command native `get_system_memory_status` hiệu chỉnh class bằng RAM lắp đặt.
- `<8 GB → perf-low`, `8–15 GB → perf-mid`, `≥16 GB → full`.
- Tier giữa chỉ giảm blur đắt; tier full xóa cả `perf-low` lẫn `perf-mid`.
- Blur trực tiếp của khuôn bế đã tuân tier; không đổi DPR, hình học hoặc chất lượng 3D trên máy mạnh.

### Verify

- `npm.cmd run typecheck`: đạt.
- `npx.cmd vitest run` phạm vi thay đổi: 13/13 test đạt.
- `npm.cmd run test`: 206 file test đạt, 1.961 test đạt, 2 skip có sẵn.
- ESLint phạm vi các component/helper/test mới: đạt.
- `npm.cmd run build`: đạt, 3.537 module transformed.
- `npm.cmd run lint:budget`: còn fail backlog toàn dự án `react-refresh/only-export-components 33 > budget 32`; scan các TSX của đợt này không có finding rule đó.
- Chưa chạy benchmark CPU/RAM 60 giây trên app Tauri thật; ma trận mục 5 là bước runtime còn lại trước khi gọi Mức 3.
