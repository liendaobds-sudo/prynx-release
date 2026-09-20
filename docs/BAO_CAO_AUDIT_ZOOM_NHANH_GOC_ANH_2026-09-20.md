# Audit zoom nhanh chỉ hiện góc ảnh lớn - 2026-09-20

Trạng thái: **CHỜ DUYỆT SỬA**, chỉ audit. ZOOMRACE20.01 [CONFIRMED] P1, effort S-M, mức AUTO/DOM. Không gọi là RUNTIME Tauri.

## 1. Kết luận

Đã tái hiện một lỗi đồng bộ kích thước đúng kiểu người dùng mô tả: **khung đã đổi theo zoom mới nhưng canvas trả muộn lại bị đặt kích thước CSS của zoom cũ**. Khung cắt phần tràn nên người dùng chỉ nhìn thấy góc trên-trái.

Đây là lỗi trình bày độc lập với dung lượng PDF. Render chậm làm cửa sổ xảy ra lỗi rộng và dễ thấy hơn, nhưng test chỉ dùng ImageBitmap giả và promise trả chậm vẫn tái hiện.

Ví dụ đo trên component thật:
- Request khởi chạy khi khung 960x600.
- Khung đổi về 320x200 trong khi raster request giữ nguyên do debounce/bucket/tile cũ đang được giữ.
- Bitmap cũ trả về; canvas bị đặt 960x600 bên trong khung320x200, overflow=hidden.
- Chỉ khoảng1/3 chiều ngang và1/3 chiều dọc của ảnh lọt khung, tức góc trên-trái khoảng1/9 diện tích.
- Chiều ngược lại: khung960x600 nhưng canvas vẫn320x200, gây ảnh nhỏ nằm góc và phần trống.

Hai screenshot do người dùng cung cấp phù hợp cơ chế này. Chưa quay lại chuỗi wheel trên cửa sổ desktop để chứng minh từng frame native trùng test.

## 2. Đường chạy live và root cause

Working tree D:/pdfcompare, HEAD0c8a347e11dfb9857b2a31433cfebce3cedccbd0. SHA256 bốn source trong docs/audit/ZOOM_RACE_2026-09-20.json. Có các WIP sẵn có của người dùng; không sửa chúng.

1. LivePageFrame thay displayWidth/Height theo zoom hiện tại; renderZoom đổi sau250ms tại LivePageFrame.tsx:3071.
2. TileLayer cũng giữ snapshot settled gồm zoom/displayWidth/Height sau48ms tại :1420-1427; tile cũ đang giữ được đổi CSS theo scaleX/scaleY tại :1739 và :1799-1826.
3. useTileRenderer.ts:263-285 giải mã PNG bằng createImageBitmap nếu khả dụng; vì vậy nhánh canvas không phải code chết.
4. LiveTile useLayoutEffect tại :433-444 reset width/height thành100% khi cssW/H đổi. Bước này chạy đúng nhưng **chưa đủ**.
5. applyExactFit tại :446-468 là callback bắt cssW/H của render lúc nó được tạo. Nếu bitmap gần kích thước đó trong ±2 device pixel, nó ghi kích thước px tuyệt đối.
6. currentParams tại :483 chỉ mang file/page/raster zoom/rotation/clip, không mang CSS presentation size. Effect render tại :643-1141 không restart khi chỉ cssW/H đổi.
7. Promise đang bay giữ renderBitmapToCanvas cũ. Sau khi CSS đã đổi, response vẫn qua requestIsCurrent vì raster request đúng; nhánh :843-873 gọi callback cũ.
8. renderBitmapToCanvas tại :535-549 -> applyExactFit cũ -> canvas bị ghi lại kích thước cũ. Parent tại :1261 vẫn đúng kích thước mới nhưng overflow:hidden.
9. canKeepSharperSurface tại :684-704 có thể giữ bitmap cũ khi zoom xuống và return mà không tính lại geometry presentation. Test cho thấy khi rasterZoom settle từ2 xuống0,66, canvas vẫn960px trong khung320px, getTileUrl chỉ gọi1 lần.

Điểm mấu chốt: ảnh cũ có thể còn đúng nguồn và đủ nét để tái dùng, nhưng **kích thước CSS đi kèm callback cũ không còn đúng**. Validity của dữ liệu render không chứng minh validity của cách đặt ảnh lên khung hiện tại.

Không cần làm mất chính sách giữ ảnh nét cũ. Cần đặt lại nó theo khung mới ở thời điểm commit.

## 3. Ma trận tái hiện

Dùng component React LiveTile thật, canvas/context được mock để quan sát size và lời gọi drawImage. Trả promise đúng sau rerender CSS; không sửa production để tạo lỗi.

| Hướng | Surface | DPR | Khung sau zoom | Canvas sau response muộn | Kết quả |
|---|---|---:|---:|---:|---|
| Thu nhỏ | Full page | 1 | 320x200 | 960x600 | FAIL |
| Phóng lớn | Full page | 1 | 960x600 | 320x200 | FAIL |
| Thu nhỏ | Viewport tile | 1 | 320x200 | 960x600 | FAIL |
| Phóng lớn | Viewport tile | 1 | 960x600 | 320x200 | FAIL |
| Thu nhỏ | Full page | 2 | 320x200 | 960x600 | FAIL |
| Phóng lớn | Full page | 2 | 960x600 | 320x200 | FAIL |
| Thu nhỏ | Viewport tile | 2 | 320x200 | 960x600 | FAIL |
| Phóng lớn | Viewport tile | 2 | 960x600 | 320x200 | FAIL |
| Ảnh ready trước rồi mới thu nhỏ | Full page | 1 | 320x200 | 100% x100% | PASS |

Ở DPR2 bitmap test là1920x1200 hoặc640x400; px CSS sai vẫn như DPR1 vì applyExactFit chia lại choDPR. Không phải chỉ lỗi HiDPI.

Bốn ca thu nhỏ kiểm thêm bước rasterZoom settle: canvas vẫn960px và không tạo request mới. Đây là trạng thái xác nhận ở LiveTile; không khẳng định toàn app luôn kẹt vĩnh viễn, vì layer/geometry/frame khác về sau có thể che hoặc sửa biểu hiện.

Kết quả cuối probe: **8 fail,1 pass**. Lượt đầu2fail là tập con, không cộng thêm.

## 4. Phân biệt với các vấn đề trước

- POSTVIEW20 audit trước xác nhận PPE chậm/ảnh ICC cache/sampling; chúng giải thích chờ nét lâu, nhưng **không phải nguyên nhân toán học của ảnh bị cắt còn một góc**.
- Debounce250/48ms tạo khoảng thời gian hai hệ kích thước khác nhau; không phải lý do để xóa debounce rồi render mọi wheel event.
- Generation/source guards vẫn cần và không bị kết luận hỏng toàn bộ. Ca lỗi giữ nguyên raster request, chỉ thay presentation geometry nên request không thực sự stale về dữ liệu.
- Nhánh img có onLoad ở :1187 gọi handler hiện tại, khác nhánh canvas đã decode. Probe này xác nhận canvas; chưa dùng nó để kết luận mọi fallback img có cùng lỗi.
- Trạng thái “ảnh đã ready rồi mới resize” hiện chạy đúng; chỉ test trường hợp đó sẽ bỏ sót race.
- Vấn đề xuất PDF/scale tem oval mà người dùng tự sửa không bị đụng tới trong audit này.

## 5. Test hiện có và khoảng trống

Chạy6file:
- LivePageFrame.liveTile.test.tsx
- LivePageFrame.renderPolicy.test.ts
- viewportTilePolicy.test.ts
- renderZoomPolicy.test.ts
- computeRenderZoom.test.ts
- useTileRenderer.test.ts

**144/144 pass.** Bộ hiện hữu kiểm cache/source/generation/quality retention nhưng chưa bắt chuỗi CSS resize trước rồi ImageBitmap cũ mới commit.

Probe tạm auditZoomRace20260920.test.tsx được thêm để chẩn đoán, sau audit đã gỡ. Giữ mã tái hiện ở hai patch trong workspace, không sửa assertion để biến lỗi thành pass.

Không thay CSS/renderer/coordinator/timer/quality budget trong lượt này. Không build, restart hoặc kill app.

## 6. Hướng sửa đề xuất

Một lô hẹp, dự kiến2-3file, chờ người dùng duyệt:

1. Tách geometry trình bày hiện tại khỏi callback render bất đồng bộ. Khi commit bitmap, applyExactFit phải đọc cssW/H/clip/DPR hiện tại (ref ổn định hoặc state trình bày khai báo), không đọc closure của request cũ.
2. Khi tái dùng sharper surface, đảm bảo geometry hiện tại vẫn được áp lại; ảnh có thể giữ nguyên pixel nhưng kích thước/vị trí phải theo zoom mới.
3. Giữ snap1:1 khi thật sự gần khung mới; không bỏ toàn bộ snap làm mờ chữ ở trạng thái ổn định.
4. Không thêm cssW/H vào identity render một cách máy móc rồi hủy/render lại mọi wheel; request bitmap còn hợp lệ cần được tái dùng an toàn.
5. Regression giữ cả8ca trên và ca đối chứng; thêm đổi source/generation thật, đổiDPR/màn hình, resize cửa sổ, reset/fit zoom, cache-hit, late decode, bitmap/img fallback và cảPPE/PDFium.
6. Sau code/test: thao tác nhanh bằng wheel trên đúng file oval và mộtPDF nhẹ. Trong lúc chờ, có thể chưa đủ nét nhưng hình phải giữ đúng tỷ lệ/vị trí; không có góc ảnh phóng sai hay nhảy vị trí.

Không hứa giảm thời gian raster từ bản sửa này. Đây là bản sửa giữ hình đúng trong khi render đang chạy; tối ưuPPE/file trùng ảnh là các finding riêng ở báo cáo trước.

## 7. Evidence, audit unit và giới hạn

Audit unit W2-ZOOMRACE20-PRESENT:
- Entry: zoom/geometry LivePageFrame/TileLayer.
- Handler/engine: getTileUrl -> coordinator -> ImageBitmap -> LiveTile.
- Consumer: canvas CSS + parent clipping.
- Contract: source/raster/clip đúng chưa đủ; presentation width/height phải đúng tại commit.
- Edge đã kiểm: down/up, full/viewport, DPR1/2, before/after async commit, sharper reuse.
- Mức: TRACED + AUTO/DOM, ngày2026-09-20.
- Còn thiếu: wheel/touchpad/native desktop/frame-by-frame trêndev vàbảncài; GPU compositor/image pixels thực. Không nâng thànhRUNTIME.

Artifact audit:
- docs/audit/ZOOM_RACE_2026-09-20.json.
- D:/printsolutions-main/product/xep quan ao/tmp/zoom-race-audit-probe.patch.
- D:/printsolutions-main/product/xep quan ao/tmp/zoom-race-audit-matrix.patch.
- D:/printsolutions-main/product/xep quan ao/tmp/zoom-race-audit-matrix.log.
- Áp probe.patch rồi matrix.patch để tái lập file test tạm, chạy vitest đúng file. Không cần PDF nặng hay sửa worker để tái hiện.
