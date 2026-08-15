# Báo cáo audit tách tem PDF “Xep Tem” — 2026-08-15

> Trạng thái: **CHỜ DUYỆT — chưa sửa mã production**
> Audit unit: `W2-U04-XEPTEM`
> Baseline: commit `248ac95`, worktree sạch trước audit
> Nguồn thật: `C:\Users\Khanh Pham\Desktop\Xep Tem.pdf`
> SHA-256: `317F2262F37244F905AAA1E94BA03EF0F09706A42F5517DA932546959EAB429A`

## 1. Kết luận điều hành

Nguyên nhân không nằm ở writer PDF/PNG và cũng không phải file không thể tách. Nút
**Ảnh AI nhiều tem** đang ép frontend gửi chiến lược `ai`, bỏ qua pipeline tự động đã có.
BiRefNet tạo một Alpha toàn trang; connected-components chỉ tách những vùng còn tồn tại trong
Alpha đó. Trên file này model chỉ giữ logo `Lớp 1A2`, nên bốn tem còn lại không thể được phục
hồi ở bước connected-components.

Kết quả chạy cùng engine production trên cùng file:

| Chiến lược | Số tem | Confidence | Thời gian đo | Kết luận |
|---|---:|---:|---:|---|
| `ai` — đúng payload UI hiện tại | 1 | 0,046074 | 26,623 s | Sai mục tiêu nhiều tem |
| `auto` | 5 | 0,72 | 2,637 s | Nhận đủ năm vùng |
| `vector` | 5 | 0,72 | 2,482 s | Nhận đủ năm vùng |
| `simple-bg` | 5 | 1,00 | 2,377 s | Nhận đủ năm vùng |

Đưa mask `auto` qua writer production tạo được:

- ZIP gồm đúng 5 PNG RGBA độc lập;
- PDF đúng 5 trang;
- mỗi trang có đúng 1 đường spot `CutContour`;
- kích thước trang sau bù xén lần lượt khoảng `64,501 × 64,501`,
  `54,511 × 56,204`, `64,501 × 59,083`, `62,808 × 64,501` và
  `53,495 × 53,495 mm`.

Vì vậy yêu cầu “lấy riêng từng tem” đã được chứng minh là khả thi bằng code hiện có. Cần đổi
quyết định chiến lược ở entry UI và bổ sung fail-safe/cảnh báo; không cần viết lại export.

## 2. Sự thật của file nguồn

`pdfinfo` và inspector production xác nhận:

- PDF 1 trang, CorelDRAW 2020, khổ `330 × 480 mm`;
- có cả vector, raster và SMask/Alpha;
- **không có CutContour thực sự được vẽ** (`cut_contour_count = 0`);
- trên trang có 5 cụm artwork tách rời quan sát được.

Điểm này giải thích khác biệt với tab **PDF/PNG đã có biên**: khi file thật sự có
CutContour, pipeline dùng chính biên vector có sẵn tại
`backend/app/workers/sticker_source_pipeline.py:743-770`. File `Xep Tem.pdf` không có hợp
đồng đó nên phải suy vùng tem. Việc có nhiều path vector chung không đồng nghĩa các path đó
là đường dao an toàn.

Inspector kiểm CutContour thực tại
`backend/app/workers/sticker_source_inspector.py:394-408`, sau đó ghi nhận nguồn PDF có
vector/raster/Alpha tại `:411-462`.

## 3. Đường chạy live đã truy vết

```text
StickerCutlineTool — mode “Ảnh AI nhiều tem”
  → StickerSheetPanel.prepareCutline()
      desktop/.../StickerSheetPanel.tsx:155-169
  → detectStickers(tabId, 'ai', page)
      desktop/.../StickerSheetPanel.tsx:157
  → store gửi strategy nguyên trạng
      desktop/.../stickerSheetStore.ts:783-834
  → POST /api/sticker-sheet/{session}/detect
      backend/app/api/routes/sticker_sheet.py:226-304
  → detect_sticker_source(strategy='ai')
      backend/app/workers/sticker_source_pipeline.py:645-860
  → analyze_sticker_sheet()
      backend/app/workers/sticker_sheet_engine.py:746-852
  → một Alpha toàn trang → connected-components
      backend/app/workers/sticker_sheet_engine.py:769-782
  → manifest.instances → UI chỉ hiện số tem
      desktop/.../StickerSheetPanel.tsx:260-266
  → export lặp từng label > 0 và crop riêng
      backend/app/workers/sticker_sheet_export.py:306-346
```

Nhánh PDF đúng hơn đã tồn tại: với `strategy='auto'`, pipeline thử CutContour, vector,
Alpha và nền đơn giản trước AI tại
`backend/app/workers/sticker_source_pipeline.py:743-849`. Tuy nhiên entry hiện tại không cho
nhánh `auto` chạy.

Consumer live của giá trị sai là `detect_sticker_source()`: điều kiện chiến lược tại
`backend/app/workers/sticker_source_pipeline.py:743`, `:774`, `:800`, `:825` đọc trực tiếp
`strategy`; giá trị `ai` khiến cả bốn nhánh trước AI bị bỏ qua.

## 4. Phát hiện

### §XEPTEM.1 — `[CONFIRMED]` P1 / effort S-M — ép AI toàn trang làm rơi 4/5 tem

- Entry UI gọi cứng `detectStickers(tabId, 'ai', pageNumber)` tại
  `desktop/src/components/preprocess-tools/StickerSheetPanel.tsx:155-158`; nhận diện mọi trang
  cũng gọi cứng `ai` tại `:248-252`.
- Store và route truyền đúng giá trị này, nên đây không phải lỗi schema hay request stale.
- AI engine không phải object detector độc lập cho từng tem: nó sinh một Alpha rồi mới chạy
  connected-components tại `backend/app/workers/sticker_sheet_engine.py:769-782`.
- Artifact thật: `ai = 1` tem, trong khi `auto/vector/simple-bg = 5` tem trên cùng raster
  `3898 × 5670 px`.

**Bất biến bị vi phạm:** công cụ “nhiều tem” không được làm rơi các vùng tem tách rời khi một
chiến lược rẻ hơn, đã có trong production, nhận đủ chúng.

### §XEPTEM.2 — `[CONFIRMED]` P1 / effort S — cảnh báo và confidence thấp không tới người dùng

- Engine đã phát cảnh báo `Chỉ nhận diện được một tem trong ảnh.` tại
  `backend/app/workers/sticker_sheet_engine.py:685-692`.
- Session giữ cảnh báo trong manifest tại
  `backend/app/core/sticker_sheet_session.py:753-779`.
- Hợp đồng frontend khai báo `warnings` và `strategy_confidence` tại
  `desktop/src/lib/stickerSheetApi.ts:21-44` và `:84-93`.
- Panel chỉ hiển thị `Đã nhận diện N tem` tại
  `desktop/src/components/preprocess-tools/StickerSheetPanel.tsx:260-266`; không render warning
  hoặc confidence. Kết quả confidence `0,046074` vì vậy vẫn đi tiếp tới review/export.

**Bất biến bị vi phạm:** kết quả thiếu bằng chứng không được biến thành đường cắt mà không có
cảnh báo rõ hoặc đường khôi phục phù hợp.

### §XEPTEM.3 — `[CONFIRMED]` P2 / effort S — test khóa nhầm lựa chọn triển khai

- Test panel yêu cầu chính xác payload `'ai'` tại
  `desktop/src/components/preprocess-tools/StickerSheetPanel.test.tsx:329-358` và `:361-388`.
- Trong khi đó backend đã có test chứng minh `auto` nhận nhiều component nền trắng mà không gọi
  AI tại `backend/tests/test_sticker_source_pipeline.py:146-180`.
- Không có regression xuyên tầng “UI Ảnh nhiều tem → auto pipeline → N instance → N artifact”
  trên PDF Corel/vector+raster nền trắng.

Kết quả baseline vẫn xanh: `StickerSheetPanel.test.tsx` đạt `11/11`; toàn
`test_sticker_source_pipeline.py` đạt `24/24`. Đây là test-gap, không phải bằng chứng production
đúng với ca người dùng.

## 5. Các giả thuyết đã bác bỏ

| Giả thuyết | Trạng thái | Bằng chứng |
|---|---|---|
| Writer chỉ biết xuất một tem | `[DISPROVED]` | Cùng mask 5 label tạo ZIP 5 PNG và PDF 5 trang, mỗi trang 1 CutContour. |
| PDF hỏng hoặc không có vùng tách rời | `[DISPROVED]` | Ba chiến lược deterministic đều nhận đúng 5 vùng. |
| Có CutContour nhưng extractor bỏ sót | `[DISPROVED]` | Inspector và extractor production cùng trả 0 contour; file chỉ có artwork/vector/SMask. |
| Tăng model từ lite lên full sẽ giải quyết chắc chắn | `[SUSPECTED — không dùng làm hướng sửa]` | Lỗi kiến trúc là ép một saliency mask toàn trang; model lớn hơn không tạo hợp đồng instance detection. |

## 6. Giới hạn của bằng chứng hiện tại

- Đã đạt trace xuyên UI → route → engine → writer và đã parse/render artifact thật bằng venv
  dự án.
- Chưa thao tác lại trên cửa sổ Tauri thật trong lượt audit; quan sát runtime ban đầu đến từ
  phản ánh người dùng.
- Chưa có fixture regression lâu dài cho chính cấu trúc PDF Corel 5 artwork này, nên ca mới
  được ghi là `TRACED + artifact probe`, chưa nâng riêng lên `AUTO`.
- Tách đủ 5 vùng không đồng nghĩa đã chốt hình dao mong muốn. Hai logo tròn cho contour tròn;
  ba artwork có nền/chạm mép raster cho contour gần hình chữ nhật. Nếu yêu cầu silhouette chi
  tiết cho từng logo, nên tách ROI trước rồi mới chạy AI riêng từng ROI; không chạy một AI mask
  chung trên cả tờ.

## 7. Lô sửa đề xuất — chờ duyệt

### Lô A — sửa đúng nguyên nhân hiện tại, tối đa 4 file

1. `StickerSheetPanel.tsx`: dùng `strategy='auto'` cho trang hiện tại và tất cả trang; hiển thị
   warning nghiệp vụ. AI vẫn là fallback nội bộ của pipeline.
2. `StickerSheetPanel.test.tsx`: đổi oracle từ `'ai'` sang `'auto'`, khóa cảnh báo một-tem/
   confidence thấp.
3. `StickerCutlineTool.test.tsx`: khóa đường mode thật không ghi đè chiến lược về AI.
4. `test_sticker_source_pipeline.py`: thêm fixture PDF tổng hợp kiểu Corel nhiều vùng, chứng minh
   auto nhận đủ N và không nạp AI khi nền/vector đã đủ bằng chứng.

Gate sau lô:

- Vitest panel/tool + typecheck;
- pytest pipeline/API/export liên quan;
- chạy lại đúng `Xep Tem.pdf`: phải nhận 5 tem;
- ZIP phải có 5 PNG; PDF phải có 5 trang và 1 CutContour/trang;
- render cả 5 trang để người dùng duyệt hình dao, đặc biệt ba artwork nền chữ nhật.

### Lô B — tùy chọn chất lượng silhouette, chỉ làm sau khi nghiệm thu Lô A

Nếu người dùng muốn biên AI chi tiết cho từng logo thay vì chỉ tách đúng 5 vùng, triển khai hai
tầng: deterministic proposal tạo ROI → AI refine độc lập từng ROI → ghép label-map về trang gốc.
Lô này là thay đổi thuật toán riêng, cần corpus và artifact oracle riêng; không gộp vào quick-fix.

## 8. Chốt duyệt

Đề xuất duyệt **Lô A trước**. Nó sử dụng pipeline `auto` đã có, sửa đúng entry gây lỗi, nhanh hơn
khoảng 10 lần trên file đo và không thêm worker/cap tài nguyên. Sau khi xem 5 trang artifact,
quyết định riêng có cần Lô B hay không.

Kế hoạch hợp nhất đầy đủ (giữ toàn bộ thanh kéo AI và nhánh Xén vuông góc) nằm ở
`docs/KE_HOACH_HOP_NHAT_BU_XEN_TAO_DUONG_CAT_2026-08-15.md`.
