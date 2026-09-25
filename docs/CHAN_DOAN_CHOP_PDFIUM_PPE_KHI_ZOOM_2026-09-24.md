# Chẩn đoán chớp PDFium/PPE khi zoom — 2026-09-24

## Cập nhật sau yêu cầu sửa

**R24.07 đã áp dụng SOURCE + AUTO; GUI pending.** Viewport dùng cùng policy với base, không bật lại PDFium theo target zoom; trang cần PPE không chèn display lên khung PPE mồi. Typecheck và **6 file / 163 test đạt**, gồm 10 ca mới kiểm lớp ảnh đang hiển thị, cold cache, Output Preview, zoom-out và pan/stale. Xem [nhật ký bản sửa và giới hạn runtime](RENDER_ZOOM_ENGINE_FLASH_FIXES_2026-09-24.md). Nội dung chẩn đoán dưới đây thuộc source trước sửa, giữ để truy vết.

## Kết luận trước sửa

**R24.07 — P1 / M, OPEN: policy viewport đưa PDFium trở lại trên mỗi target zoom, phủ lên PPE đang hiện, rồi lại thay bằng PPE mới.** Đây là đường render chủ đích trong source hiện tại, không cần lỗi worker hoặc fallback để xảy ra. Bản G1 sửa R24.04 giữ surface tồn tại nhưng chưa bảo đảm engine của surface trên cùng không đổi.

Đã xác minh bằng component thật trong DOM và đối chiếu native/coordinator log của phiên ứng dụng đang chạy. Chưa quay compositor để định lượng khoảng chớp hoặc chênh lệch màu trên màn hình người dùng. Không sửa production, không build/restart app trong lượt chẩn đoán.

## Đường gây chớp

1. PPE A đã hiển thị. `accurateCommitted` vẫn true khi zoom vì key chỉ theo file/profile/trang (`LivePageFrame.tsx:3150`).
2. Target B có DPI/clip mới. `hasIncomingTarget` ép `useDisplayLayer=true`, bỏ qua kết quả policy vốn đã từ chối display sau accurate commit (`LivePageFrame.tsx:1913–1926`; `livePageFramePolicy.ts:189–200`).
3. Buffer trả `[visible A, target B]` (`viewportTilePolicy.ts:679–684`). Fragment target B đứng sau A; mỗi fragment có display rồi accurate (`LivePageFrame.tsx:1977–2035`).
4. Display B ready trước PPE B. Container của display B trở thành opacity 1, không có z-index riêng và nằm sau PPE A, nên phủ lên PPE A trong vùng chồng lấp (`:1437`). Toàn viewport nằm ở z12, cũng cao hơn PPE full-page z11 (`:6495,6556`).
5. PPE B về, callback accurate retire A; display bị tháo khi không còn incoming target (`:1954–1963`). `crossfadeMs=0` tại `:1941` đổi ảnh tức thì.

```text
PPE A đang hiện
    → zoom tạo B
    → PDFium B phủ PPE A
    → PPE B phủ PDFium B
    → zoom tiếp theo lặp lại
```

Tile display không có `accurateOnly`; hook chọn `render_pdf_page` (`useTileRenderer.ts:195,593–605,657`). Tile accurate dùng PPE. Guard chất lượng nằm trong từng `LiveTile`, không so màu/engine xuyên hai instance mới khác nhau.

## Bằng chứng mới

### Component thật

[Probe](audit/RENDER_LOAD_2026-09-24/ZoomEngineFlash.audit.probe.tsx) dựng PPE A ở zoom 3 → zoom 4 → chỉ trả display B → trả PPE B. Probe lọc canvas đã vẽ, opacity/display và ancestor ẩn, kiểm các tile cùng phủ điểm giữa viewport. Kết quả pipeline trên cùng theo thứ tự DOM là **accurate → display → accurate**. PPE A vẫn mounted trong bước giữa nhưng bị display B phủ.

Cả hai ca `stableUnderlayReady=false/true` đều tái hiện. Probe là assertion chẩn đoán hành vi lỗi hiện tại, không phải test nghiệm thu bản sửa. DOM/jsdom không phải compositor thực.

Chạy lúc 22:01:45 trên Windows: **4 file / 125 test pass**, gồm **123 test hiện hữu + 2 probe**. [Log chạy](audit/RENDER_LOAD_2026-09-24/zoom_engine_flash_tests.log). Suite hook có diagnostic jsdom thiếu Canvas API ở nhánh fallback; tất cả assertion đạt, không dùng nó làm bằng chứng pixel fallback trên WebView. Test tạm đã xóa khỏi `desktop/src`, bản probe lưu trong docs.

### Phiên ứng dụng đang chạy

[Runtime đã ẩn danh](audit/RENDER_LOAD_2026-09-24/zoom_engine_flash_runtime.json) ghép `request_id` từ native result với coordinator, rồi đối chiếu group/zoom/commit. Cùng trang/vùng zoom có cả PDFium và PPE thật, không chỉ suy từ nhãn `accurate`.

| Target zoom | FE commit display → accurate | Bằng chứng bổ sung |
|---|---|---|
| 15,958 | seq 8084 → 8093 | Cùng 1344×832; native PDFium 188 ms, PPE 708 ms, generation 20 ở hai group riêng |
| 21,583 | 9760 → 9777 | Hai surface cùng target |
| 6,583 | 11135 → 11160 | Hai surface cùng target |
| 3,958 | 11751 → 11759 | Hai surface cùng target |
| 17,708 | 21139 → 21164 | Hai surface cùng target |

Không lấy `708−188 ms` hoặc hiệu timestamp log làm thời gian chớp: request có thể chạy chồng nhau và log FE ghi qua hàng đợi. Số này chứng minh đường PPE chưa phải render hoàn tất trong 16 ms; nó không phải benchmark P50/P95 hay thời gian input→sharp.

App debug khởi động 21:57:18; EXE trên đĩa `85b3526d…72f1b`, khác binary G1 `de04cafe…7679c`. Ba module frontend được Vite phục vụ có source map khớp byte file trên đĩa. Chưa có manifest build chứng minh toàn bộ source native ứng với EXE đang chạy; không gọi đây là xác minh toàn bộ bản build.

## Vì sao nâng cấp xong vẫn chưa thấy khác nhiều?

- R24.01/02/04/05 chủ yếu sửa tính đúng và các đường lỗi. Chúng chưa phải phép tối ưu raster PPE hoặc nghiệm thu độ nét Acrobat.
- PXRG cải thiện đường truyền display nhưng người dùng vẫn chờ PPE để có surface cuối. Làm display đến sớm hơn không tự làm PPE xong sớm hơn; khoảng khác biệt màu/nét giữa hai engine vẫn lộ ra.
- Target cập nhật theo chu kỳ 16 ms không bảo đảm một lần raster/đổi ảnh hoàn tất ở 60 FPS. Nó có thể tạo thêm target trung gian; cần profile mới trước khi kết luận lượng công việc thừa.
- Test F2 hiện tại (`LivePageFrame.liveTile.test.tsx:1156,1199,1202`) chủ động đợi display và chỉ cần PPE cũ **hoặc** display mới còn mounted. Vì vậy test xanh vẫn cho phép cross-engine flash. Cần kiểm surface nhìn thấy trên cùng.

Ngoài đường chính, frontend có fallback PDFium khi PPE báo unsupported; `TileUrlSource` chưa mang actual-engine metadata. Đây là nhánh cần kiểm riêng, không dùng nó làm lời giải thay thế cho policy gây chớp đã tái hiện. Prime của một tài liệu trong trace có `color_approximation`, nhưng tài liệu/đường prime đó không tự chứng minh fallback ở viewport đang chớp.

## Bản sửa hẹp cần làm tiếp

**Mục tiêu: trang đã dùng PPE tiếp tục hiện PPE trong lúc zoom, tới khi PPE mới đủ điều kiện thay.**

1. Bỏ việc dùng `hasIncomingTarget` để bật PDFium trở lại sau accurate commit; đi qua policy thống nhất. Giữ PPE cũ được scale đúng hình học, hoặc PPE underlay khi coverage không đủ. Giữ nguyên guard retire của R24.04.
2. Test dương: PPE A → zoom/pan → PPE B pending vẫn có surface PPE; stale B không phủ C; cold-open và thiếu coverage không trắng. Test âm: trang compatibility chỉ dùng display vẫn render/zoom bình thường.
3. Assertion phải kiểm canvas có pixel **đang phủ trên cùng**, không chỉ còn node trong DOM. Sau unit test phải lặp lại wheel/zoom thật trên đúng file người dùng, kiểm hai hướng zoom và điểm chuyển full-page/viewport.
4. Lô đầu dự kiến 4 file: `LivePageFrame.tsx`, test component hiện có, nhật ký sửa và master matrix. Tách việc actual-engine metadata/fallback và profile PPE sang lô riêng.

Không tăng crossfade để che khác biệt màu, không rollback guard giữ surface, không đặt cap chất lượng/worker để giảm số lần chớp. Lượt hiện tại chỉ chẩn đoán và lưu bằng chứng theo câu hỏi của người dùng; chưa áp bản sửa này.
