# Bổ sung độ lẹm mép cho Xén vuông góc → Lật gương

Trạng thái: **đã khảo sát, chờ duyệt trước sửa** theo `prynx-audit-workflow`.
Người dùng yêu cầu có điều chỉnh độ lẹm mép ở mode lật gương để tránh đường
biên mảnh giữa nội dung và phần bù xén. Chưa có PDF/chuỗi thao tác mẫu của
lỗi đường biên; không kết luận mọi vệt mảnh đều do cùng một nguyên nhân.

## Hiện trạng có bằng chứng

| Mã | Mức/effort | Bằng chứng | Khoảng trống |
|---|---|---|---|
| §MIRROR.BITE.1 | P2/S | `desktop/src/components/preprocess-tools/StickerTool.tsx:1514` | Ô Độ lẹm mép chỉ hiện cho image/trajectory/inpaint, không có mirror. |
| §MIRROR.BITE.2 | P2/M | `StickerTool.tsx:621`, `desktop/src/lib/recipe/recipeRunners.ts:361` | Payload mirror chỉ có file_id, bleed_mm, pages, bleed_sides. Chạy tay/phát lại chưa gửi lẹm mép. |
| §MIRROR.BITE.3 | P2/M | `backend/app/schemas/preflight.py:391`, `backend/app/api/routes/preflight.py:1249`, `backend/app/core/page_boxes.py:1788` | Schema/route/engine mirror chưa có tham số lẹm. Chỉ mở ô trên UI không tạo tác dụng. |
| §MIRROR.BITE.4 | P1/S | `StickerTool.tsx:827` | Recipe cũ vẫn có thể đã lưu edgeBiteMm dù mode mirror lúc đó bỏ qua. Không được bắt đầu sử dụng giá trị ẩn này sau nâng cấp. |

Đã đối chiếu tài liệu cũ về bù xén/cạnh bù xén, đặc biệt §BX.F02 trong
`BU_XEN_TAO_DUONG_CAT_FIXES_2026-08-16.md`: giá trị của ô ẩn từng gây mất
nội dung sát mép. Nhánh mirror là `PageBoxesEngine`, không phải nhánh
`StickerEngine` đang tối ưu Simplify ở các lượt trước.

## Hành vi đề xuất

- Hiển thị **Độ lẹm mép**, đơn vị mm, bước 0,1, miền 0–5 mm cho mode mirror.
  Mặc định **0 mm** giữ hành vi cũ. Giá trị dương là lựa chọn thay dải nội
  dung sát mép, cần cảnh báo nếu có chữ/chi tiết quan trọng ở đó.
- Dùng lựa chọn riêng `mirrorEdgeBiteMm` cho state/persistence/recipe.
  Recipe cũ thiếu field mới tiếp tục dùng 0, kể cả có `edgeBiteMm` cũ khác 0.
  Các mode hiện có vẫn dùng field cũ, không đổi hành vi của chúng.
- API mirror nhận `edge_bite_mm` hữu hạn trong 0–5 mm. Tạo
  `MirrorBleedRequest(AddBleedRequest)` riêng để `/add-bleed` không quảng cáo
  một field không sử dụng; thiếu field mới vẫn mặc định 0.
- Chỉ các cạnh đang bù xén được lẹm. Giữ nguyên mép ngoài theo bleed đã
  chọn, MediaBox/CropBox/BleedBox/TrimBox và kích thước thành phẩm.
- Dời trục gương vào trong theo lượng lẹm, thay đúng dải sát mép bằng nội
  dung phản chiếu từ phía trong; phần trung tâm giữ nguyên. Chia lại các
  dải cạnh/góc quanh lõi, không kéo giãn toàn trang hoặc auto-trim.
- Giữ Form XObject, vector, CMYK/spot/transparency; không raster hóa hoặc
  chuyển màu. Độ lẹm quy đổi bằng `/UserUnit` và đúng hệ trang sau `/Rotate`.
- Bleed bằng 0, không chọn cạnh hoặc lẹm bằng 0 không được vô tình cắt
  nội dung. Trang nhỏ phải chặn lẹm làm đảo/triệt tiêu hình chữ nhật lõi.

Lưu ý: viền trắng thật trong nguồn và hairline do anti-alias của Viewer/RIP
là hai ca khác nhau. Kiểm render ở vùng nối; không tự thêm overlap hoặc màu
mới ngoài độ lẹm người dùng chọn chỉ để che một ảnh chụp. Nếu phần mềm render
vẫn tạo hairline trên PDF đã kín, cần ghi rõ và kiểm riêng trên file mẫu.

## Chia lô triển khai

### A — backend, tối đa 5 file gồm nhật ký

1. `backend/app/schemas/preflight.py`: model mirror riêng, validation/default.
2. `backend/app/api/routes/preflight.py`: dùng model mới, forward tham số.
3. `backend/app/core/page_boxes.py`: tham số mặc định cuối chữ ký, hình học
   dải gương/lẹm theo cạnh; không đổi block chuẩn hóa box đang có.
4. `backend/tests/test_mirror_bleed_origin.py`: mở rộng ca render, hợp đồng
   API/schema, page boxes, rotation/UserUnit, 0/không cạnh/trang hẹp.
5. Nhật ký sửa/verify của lô.

### B — desktop và recipe, tối đa 5 file

1. `desktop/src/components/preprocess-tools/StickerTool.tsx`: ô nhập, state
   riêng, payload và bản ghi recipe mới; tái dùng nhãn i18n có sẵn.
2. `desktop/src/lib/recipe/recipeRunners.ts`: đọc/thêm field mirror riêng;
   clamp 0–5, giữ recipe cũ ở 0.
3. `desktop/src/components/recipe/RecipePanel.tsx`: nhãn tham số mirror mới
   khi xem/chỉnh recipe, không lộ tên kỹ thuật khó hiểu.
4. `desktop/src/components/preprocess-tools/StickerTool.ui.test.tsx`:
   ô hiện/ẩn, giá trị, đổi mode và payload đúng khi Execute.
5. `desktop/src/lib/recipe/recipeRunners.test.ts`: mới/cũ, missing/0/NaN/
   ngoài khoảng và không thay mode khác.

Verify lô A trước khi sang B; xác nhận artifact/thao tác thực theo chốt của
dự án. Không tự mở rộng sang tốc độ Simplify, renderer hoặc build/release.

## Tiêu chí nghiệm thu

- PDF nguồn có viền trắng mảnh: so lẹm 0 với mức lớn hơn viền, kiểm pixel
  hai bên mép thành phẩm; nội dung trung tâm không đổi, dải gương có tác dụng.
- Chỉ bật một cạnh: cạnh tắt không bị ăn nội dung hoặc nở khổ; góc đúng.
- BBox/TrimBox và vị trí trang sau bù không đổi theo độ lẹm; 0 tương thích cũ.
- PDF vector/CMYK/spot không bị chuyển raster/RGB; kiểm transparency ở mép.
- Cùng tham số chạy tay và phát recipe cho cùng kết quả; recipe cũ không tự
  bật lẹm từ edgeBiteMm ẩn đã lưu.
- Pytest mirror/cạnh bù xén/API, typecheck và Vitest UI/recipe đạt.
- Kiểm Tauri: chọn Xén vuông góc → Lật gương, nhập độ lẹm → Thực thi,
  soi điểm nối, đổi cạnh, chạy lại recipe. Báo rõ nếu mới kiểm mức tự động.

Chưa sửa source, chưa tạo PDF thử hoặc chạy test cho tính năng mới trong
lượt khảo sát này. Cần duyệt hai lô trước khi triển khai vì phạm vi >5 file.
