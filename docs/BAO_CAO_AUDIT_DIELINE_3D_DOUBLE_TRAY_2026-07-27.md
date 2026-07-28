# BÁO CÁO AUDIT 3D — HỘP ÂM DƯƠNG (KHAY / NẮP)

**Ngày audit:** 2026-07-27
**Phạm vi:** luồng dựng khuôn `double_tray` từ generator 2D đến hoạt ảnh gấp và trạng thái khay–nắp đóng trong scene 3D.
**Ngoài phạm vi:** thay đổi hình học khuôn 2D, cập nhật golden master, tối ưu toàn bộ mockup 3D, và lỗi API 422 ở sidecar.

> Trạng thái: **CHỜ DUYỆT TRƯỚC KHI SỬA CODE** theo quy trình audit của PrynX.

## 1. Kết luận điều hành

Ba triệu chứng người dùng mô tả đều có dấu vết trong luồng hiện tại:

1. **Nắp không thể úp vào khay:** đã xác minh. Contract `nesting` chỉ chứa phép tịnh tiến `(x, y, z)`; scene 3D không có phép xoay cứng 180° cho toàn bộ nắp.
2. **Hướng gấp nắp sai:** đã xác minh ở cấp contract. Đáy và nắp được dựng bằng cùng một hàm, cùng bảng `foldDirection`; nắp không có pose đảo riêng trước khi chụp lên khay.
3. **Hoạt ảnh chớp/giật:** đã xác minh có tải tính toán cao hơn rõ rệt: 50 panel, mỗi panel có một callback theo khung hình và tự lần chuỗi cha để dựng lại ma trận. Chưa có phép đo GPU/CPU runtime để khẳng định đây là nguyên nhân duy nhất của hiện tượng “chớp”.

Ưu tiên đề xuất:

| Ưu tiên | Hạng mục | Trạng thái |
|---|---|---|
| P1 | Bổ sung pose xoay 180° cho nắp và trạng thái đóng đúng vật lý | `[VERIFIED]` |
| P1 | Tách đúng động học đáy/nắp, kiểm tra mặt in sau khi đảo nắp | `[VERIFIED]` |
| P1 | Bổ sung test 3D cho hướng gấp và pose đóng của `double_tray` | `[VERIFIED]` |
| P1 | Profile và giảm chi phí cập nhật 50 panel trong animation | `[VERIFIED workload]` / `[SUSPECTED cause]` |
| P2 | Sửa ánh xạ artwork `tray/sleeve` đang đảo với quy ước split | `[VERIFIED]` |

## 2. Luồng thực thi đã truy

1. Tab 3D tải `DielineScene3D` bằng lazy import và render component khi tab 3D/split đang hoạt động:
   - `desktop/src/components/dieline-tool/DielineTool.tsx:24-25`
   - `desktop/src/components/dieline-tool/DielineTool.tsx:388-425`
2. `BoxScene` nhận model từ `useBoxStore`, tách panel thành mảnh đứng yên và mảnh chuyển động:
   - `desktop/src/components/dieline-tool/DielineScene3D.tsx:49-52`
   - `desktop/src/components/dieline-tool/DielineScene3D.tsx:295-308`
3. Mỗi panel được render qua `SolidPanelMesh`; hoạt ảnh đọc `foldLive` và gọi `applyFoldCompensation`:
   - `desktop/src/components/dieline-tool/DielineScene3D.tsx:310-355`
   - `desktop/src/components/dieline-tool/SolidPanelMesh.tsx:824-885`
4. `applyFoldCompensation` đi ngược cây `parent`, dựng ma trận gấp từng cấp rồi nhân dồn:
   - `desktop/src/lib/mockup3d/foldCompensation.ts:283-340`

## 3. Phát hiện chi tiết

### DT3D-001 — Nắp chỉ được tịnh tiến, không được lật úp 180°

**Mức độ:** P1
**Trạng thái:** `[VERIFIED]`

**Bằng chứng**

- Generator ghi rõ cả hai mảnh đang gập “miệng ngửa lên”; nắp chỉ dừng lơ lửng trên khay và contract nesting hiện chưa hỗ trợ phép quay:
  - `desktop/src/lib/dieline/DoubleTray.ts:439-449`
- Dữ liệu `nesting` chỉ có ba thành phần `x`, `y`, `z`:
  - `desktop/src/lib/dieline/DoubleTray.ts:445-449`
- Scene 3D chuyển động mảnh nắp bằng `position={trayShift}`. Không có `rotation`, quaternion hoặc ma trận pose cấp mảnh:
  - `desktop/src/components/dieline-tool/DielineScene3D.tsx:297-305`
  - `desktop/src/components/dieline-tool/DielineScene3D.tsx:359-370`

**Kết luận**

Tại `foldProgress = 1`, hệ thống có thể đưa tâm nắp đến đúng tâm khay nhưng không thể đổi hướng miệng nắp. Vì vậy trạng thái cuối “nắp úp vào khay” là bất khả thi với contract hiện tại.

**Hướng xử lý đề xuất**

Bổ sung một pose cấp mảnh cho nesting, tối thiểu gồm tịnh tiến và xoay. Tâm/pivot xoay phải lấy theo root `lid_bottom`, không lấy theo bounding box toàn khuôn. Sau khi xoay phải kiểm lại:

- cao độ chụp nắp theo `lidD`, `T`, `lidGap`;
- mặt ngoài/mặt trong của nắp;
- hướng artwork;
- va chạm giữa thành nắp và thành khay.

---

### DT3D-002 — Đáy và nắp dùng cùng động học gấp, không có quy tắc đảo riêng cho nắp

**Mức độ:** P1
**Trạng thái:** `[VERIFIED]`

**Bằng chứng**

- `buildTrayPiece` nhận `prefix` để đặt tên nhưng bảng bốn phía và dấu `foldDirection` không phụ thuộc `base` hay `lid`:
  - `desktop/src/lib/dieline/DoubleTray.ts:138-145`
  - `desktop/src/lib/dieline/DoubleTray.ts:186-194`
- Cùng một hàm được gọi cho cả đáy và nắp:
  - `desktop/src/lib/dieline/DoubleTray.ts:433-434`
- Hai root `base_bottom` và `lid_bottom` đều không có pivot; test hiện tại chỉ xác minh chúng là hai root rời:
  - `desktop/src/lib/dieline/generators.test.ts:670-674`

**Kết luận**

Hai mảnh cùng gập thành khay hướng lên. Điều này đúng để xem hai mảnh đứng cạnh nhau, nhưng không đủ để tạo trạng thái nắp chụp. Cần chọn một trong hai contract rõ ràng:

1. Giữ động học gấp nội bộ giống nhau, sau đó đảo pose cứng toàn bộ nắp 180°; hoặc
2. Dựng động học nắp trong hệ tọa độ đảo ngay từ đầu.

Phương án 1 ít ảnh hưởng generator 2D và golden master hơn, nên là ứng viên ưu tiên.

---

### DT3D-003 — Ánh xạ artwork đáy/nắp đang ngược với contract tách hai mảnh

**Mức độ:** P2
**Trạng thái:** `[VERIFIED]`

**Bằng chứng**

- Contract split quy định `tray = base_*`, `sleeve = lid_*`:
  - `desktop/src/lib/dieline/DoubleTray.ts:463-487`
- Trong scene, `base_*` được xếp vào nhóm tĩnh và gắn nhãn/artwork `sleeve`; `lid_*` được xếp vào nhóm động và gắn artwork `tray`:
  - `desktop/src/components/dieline-tool/DielineScene3D.tsx:49-52`
  - `desktop/src/components/dieline-tool/DielineScene3D.tsx:239-246`
  - `desktop/src/components/dieline-tool/DielineScene3D.tsx:306-320`

**Tác động**

Khi người dùng cấp artwork riêng cho khay và nắp, ảnh có thể bị gán chéo. Sau khi lật nắp 180°, sai khác này còn có thể biểu hiện thành ảnh ngược mặt hoặc ngược hướng.

**Hướng xử lý đề xuất**

Không dùng tên vai trò `tray/sleeve` để suy ra mảnh vật lý cho mọi loại hộp. Nên có metadata mảnh rõ ràng, ví dụ `pieceRole: base | lid | tray | sleeve`, rồi ánh xạ artwork theo role.

---

### DT3D-004 — 50 panel cùng cập nhật ma trận trong mỗi nhịp animation

**Mức độ:** P1 đối với triệu chứng người dùng; cần profile trước khi tối ưu
**Trạng thái:** `[VERIFIED workload]`, `[SUSPECTED primary cause]`

**Bằng chứng**

- Test generator xác nhận `double_tray` có 50 panel:
  - `desktop/src/lib/dieline/generators.test.ts:653-668`
- Mỗi `SolidPanelMesh` đăng ký một `useFrame`; khi `foldLive.version` đổi, panel tự gọi lại `applyFoldCompensation`:
  - `desktop/src/components/dieline-tool/SolidPanelMesh.tsx:824-885`
- Mỗi lần gọi tạo một `Matrix4`, tạo `Set`, đi ngược cây cha, và ở từng cấp tìm cha bằng `allPanels.find(...)`:
  - `desktop/src/lib/mockup3d/foldCompensation.ts:291-339`

**Đánh giá**

Trong animation, một nhịp `foldLive` làm toàn bộ 50 callback panel hoạt động. Panel sâu còn lặp tìm cha trên mảng 50 phần tử. Đây là tải CPU xác định và cao hơn các mẫu hộp ít panel.

Chưa có trace runtime nên chưa được phép kết luận tải này là nguyên nhân duy nhất của “chớp”. Các nguồn GPU khác như shadow, material vật lý và số draw call cũng cần được đo.

**Điểm đã loại trừ**

- Canvas đã dùng `frameloop="demand"` và DPR `[1, 1.5]`, không chạy render liên tục vô điều kiện:
  - `desktop/src/components/dieline-tool/MockupCanvas.tsx:107-124`
- Geometry thường không được dựng lại theo `foldProgress`; nhánh thay đổi hình học theo progress chủ yếu dành cho cup sleeve/cone.
- Một panel dùng một mesh solid với material groups, không có bằng chứng tạo hai mặt đồng phẳng trùng nhau ở nhánh `double_tray`.

**Hướng xử lý đề xuất**

Trước tiên đo CPU frame, GPU frame và draw calls trên mẫu chuẩn 50 panel. Nếu xác nhận nghẽn CPU:

- cache `name → panel` và chuỗi tổ tiên;
- tránh cấp phát `Matrix4`/`Set` mới cho từng panel ở từng frame;
- cân nhắc tính ma trận một lần theo cây rồi phân phối cho panel;
- không thêm hard-cap worker/chất lượng vô điều kiện; giữ nguyên nguyên tắc máy mạnh chạy đủ công suất.

---

### DT3D-005 — Thiếu test khóa hướng gấp và trạng thái đóng của Double Tray

**Mức độ:** P1
**Trạng thái:** `[VERIFIED]`

**Bằng chứng**

- Bộ property test mockup 3D liệt kê đến `tray` nhưng chưa có `double_tray`:
  - `desktop/src/lib/mockup3d/__tests__/generatorDeterminism.pbt.test.ts:39-50`
- Test “print side outward after full fold” không import hoặc kiểm tra `generateDoubleTray`:
  - `desktop/src/lib/mockup3d/__tests__/foldPrintOutward.test.ts:1-18`
- Test Double Tray hiện khóa số panel, cây cha, kích thước, crease và bounding box; chưa khóa:
  - hướng pháp tuyến cuối của bốn thành;
  - pose cứng của nắp;
  - tâm khay/nắp tại `foldProgress = 1`;
  - độ chồng/lọt theo `lidGap`;
  - mặt in sau khi nắp bị đảo.
  - `desktop/src/lib/dieline/generators.test.ts:639-750`

**Tác động**

Generator có thể vượt toàn bộ test cấu trúc 2D nhưng vẫn sai trực quan 3D. Đây là lý do lỗi hiện tại không bị cổng test chặn.

**Hướng xử lý đề xuất**

Thêm test mockup 3D riêng cho `double_tray`:

1. bốn vách đáy cùng hướng vào lòng khay;
2. bốn vách nắp cùng tạo lòng nắp trước khi đảo pose;
3. nắp xoay đủ 180° quanh tâm root;
4. tại trạng thái đóng, tâm XY trùng trong dung sai và cao độ Z đúng công thức;
5. pháp tuyến mặt in hướng ra ngoài ở cả đáy và nắp;
6. không thay đổi snapshot 2D nếu việc sửa chỉ thuộc pose 3D.

---

### DT3D-006 — `BoxScene` subscribe toàn bộ store

**Mức độ:** P2
**Trạng thái:** `[SUSPECTED secondary contributor]`

**Bằng chứng**

- `BoxScene` gọi `useBoxStore()` không có selector:
  - `desktop/src/components/dieline-tool/DielineScene3D.tsx:90`
- Các phần khác của scene dùng selector theo từng trường.

**Đánh giá**

Bất kỳ thay đổi nào trong `useBoxStore` đều có thể làm `BoxScene` render lại, dù thay đổi đó không liên quan đến geometry. Driver animation chính đã dùng `foldLive` ngoài React nên điểm này không phải nguyên nhân trực tiếp cho mọi frame, nhưng có thể tạo giật khi kéo slider, commit state hoặc cập nhật tham số.

## 4. Kế hoạch sửa đề xuất sau khi được duyệt

### Lô 1 — Sửa tính đúng 3D, tối đa 5 file

Mục tiêu:

- mở rộng contract pose của mảnh nesting;
- lật nắp quanh đúng tâm root;
- đưa nắp về trạng thái chụp đúng `lidD`, `T`, `lidGap`;
- sửa ánh xạ artwork base/lid;
- thêm test pose đóng tối thiểu.

Verify bắt buộc:

- typecheck;
- test `desktop/src/lib/dieline` liên quan Double Tray;
- test `desktop/src/lib/mockup3d`;
- kiểm tay 3D các mốc 0%, 20%, 40%, 80%, 100%;
- không cập nhật golden master 2D nếu tọa độ khuôn không đổi.

### Lô 2 — Profile và làm mượt animation, tối đa 5 file

Mục tiêu:

- đo trước/sau trên cùng model 50 panel;
- cache cây parent và tái sử dụng scratch matrices;
- giảm số lần tìm kiếm/cấp phát trong frame;
- giữ `frameloop="demand"` và DPR hiện tại;
- không giảm chất lượng vô điều kiện trên máy RAM ≥16 GB.

Verify bắt buộc:

- frame time CPU/GPU trước và sau;
- không đổi pose 3D tại các mốc kiểm;
- không rò geometry/material/texture;
- test regression các hộp cũ: RTE, pizza, tray.

### Lô 3 — Củng cố test và contract artwork

Mục tiêu:

- thêm `double_tray` vào các property test phù hợp;
- test print-side outward;
- khóa contract base/lid thay vì dựa vào tên `tray/sleeve`;
- kiểm ảnh riêng cho đáy và nắp.

## 5. Điều kiện duyệt

Đề nghị duyệt theo thứ tự:

1. **Duyệt Lô 1 trước** để khôi phục tính đúng của nắp/khay.
2. Sau khi pose đúng và kiểm tay đạt, thực hiện **Lô 2** với số đo profiler.
3. Cuối cùng thực hiện **Lô 3** để khóa hồi quy.

Chưa có file code nào được sửa trong đợt audit này.
