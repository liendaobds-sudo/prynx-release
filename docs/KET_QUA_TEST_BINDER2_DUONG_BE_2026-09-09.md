# Kết quả test Binder2 - đường bế PDF/PNG đã có biên

Ngày: 2026-09-09. Phạm vi: **classic PDF/PNG đã có biên**, không dùng export của
Tách nhiều tem. Đây là baseline/điều tra, chưa sửa thuật toán sản phẩm trong lượt này.

## 1. File và thiết lập

- Nguồn: `D:/pdfcompare/test/Binder2.pdf`, 13 trang, 759.172 byte.
- SHA-256 trước/sau giữ nguyên:
  `4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`.
- Cả 13 trang có một RGB JPEG + SMask 8-bit; content chỉ có `q/cm/Do/Q`.
  Không có đường vector/CutContour sẵn. Biên đầu vào là Alpha raster.
- Trang 1-8 khoảng 500 DPI; trang 9-13 khoảng 300 DPI. Engine chạy 300 DPI như route.
- Thiết lập từ default code: `original`, góc `preserve`, offset 0 mm, bleed 0 mm,
  bỏ nền trắng bật, lấp lỗ bật, `auto_safe`, xuất CUT tất cả trang, crop theo tem.
  Thử Khử răng cưa **30 và 70**. Đây không phải khẳng định thiết lập đang lưu của user.
- Giữ đủ 13 trang đầu vào/đầu ra; **không** truyền `process_pages`, không ép chạy
  tuần tự hoặc giảm worker. Windows process pool chạy thật ngoài sandbox.

## 2. Đường kiểm đã chạy

`inspect_sticker_source` -> session riêng -> `detect_sticker_source(strategy='alpha',
preview_only=True)` -> `promote_source_session` -> `build_sticker_cutline_preview`
-> `snapshot_classic_cutline_preview` -> `StickerEngine.process_pdf` -> mở lại PDF
bằng pikepdf -> đọc đúng phần `/CutContour CS` -> render bằng Poppler.

Session root được chuyển vào TemporaryDirectory **chỉ trong process probe**;
không đọc/đóng session người dùng đang chạy. Không gọi mô hình AI hoặc mạng.

Theo classic hiện hành, chỉ trang Viewer đang active có snapshot override;
các trang còn lại vẫn được xử lý bởi engine direct. Đã thử active trang 1 và trang 5.
Đây là kiểm backend/worker + artifact theo hợp đồng đã trace, **chưa click trên Tauri**.
Route còn lớp entitlement, scheduler, phục vụ file và watermark; probe không đại
diện việc nghiệm thu các lớp đó.

## 3. Baseline: Viewer ở trang 1, Khử răng cưa 30

| Trang | Đường bao | Lệnh thẳng | Cubic | Lệnh ngắn <0,25 mm |
|---|---:|---:|---:|---:|
| 1 | 1 | 0 | 18 | 0 |
| 2 | 8 | 582 | 0 | 299 |
| 3 | 7 | 253 | 0 | 161 |
| 4 | 15 | 959 | 0 | 629 |
| 5 | 1 | **279** | **0** | **172** |
| 6 | 2 | 0 | 87 | 0 |
| 7 | 1 | 0 | 52 | 0 |
| 8 | 1 | 0 | 55 | 0 |
| 9 | 9 | 0 | 106 | 0 |
| 10 | 5 | 0 | 87 | 0 |
| 11 | 12 | 385 | 0 | 247 |
| 12 | 6 | 0 | 148 | 1 |
| 13 | 10 | 0 | 248 | 2 |

Toàn file: **3.259 lệnh**, **1.511 lệnh dưới 0,25 mm**. Không tính hai tay nắm
của cubic thành hai node phụ. Nhiều đường bao ở một số trang có thể là thành phần
rời thật (chữ, lá...), không tự coi đó là rác cần gộp hoặc xóa.

Trang 5 là ca rõ nhất: một đường bao duy nhất có 279 line, đoạn nhỏ nhất
**0,030107 mm**, trung vị **0,199853 mm**, 78 khoảng neo dưới 0,1 mm. Như vậy
phản ánh node sát có bằng chứng trên **lệnh PDF thật**, không chỉ ảnh preview.
Mốc 0,25 mm là phép đo so sánh, chưa phải chuẩn áp dụng cho mọi máy bế.

## 4. Nguyên nhân đã xác minh

### BINDER2.1 - Khử răng cưa rơi khi fan-out

`sticker_engine.py:9015-9035` gọi `_process_parallel` nhưng thiếu
`cutline_denoise`. Downstream `:11759` lấy `kw.get('cutline_denoise', 0)`;
worker `:8669` truyền 0; nơi tiêu thụ thật ở `:9551`.

Probe bọc **chỉ quan sát** lời gọi parent, không thay tham số/thuật toán:
cả yêu cầu 30 và 70 đều ghi `denoise_present=false`. Snapshot của trang đang
preview vẫn được truyền, nên trang đó có thể đổi trong khi các trang khác không đổi.

Đã so hash của toàn bộ các đoạn `kind/p0/p1/p2/p3` đọc lại PDF:
**trang 2-13 giống hệt giữa mức 30 và 70** khi Viewer ở trang 1.
Trang 1 đổi 18 -> 34 cubic, vì nhận snapshot riêng. Điều này đồng thời cho thấy
Khử răng cưa hiện tại không phải một thanh giảm node đơn điệu.

### BINDER2.2 - Fallback bo polygon sinh lại node ngắn

Đã gọi chính entry worker trên file 13 trang, `_page_subset=[4]`, và kiểm hash
lệnh cắt bằng baseline full export trang 5: **khớp tuyệt đối**. Không tạo một PDF
nguồn một trang khác rồi suy ngược về pipeline nhiều trang.

Instrumentation helper chỉ đọc trước/sau, không đổi kết quả:

```text
Contour đầu vào: 3.652 node
  -> simplify 0,20 mm: 107 node
  -> round polygon: 279 node
  -> fitter không có candidate được chấp nhận
  -> fallback: 279 line trong PDF
```

Đường chạy: `_fit_preserved_contour_paths` tại `sticker_engine.py:3298` trả None;
caller `:10090` dùng `_preserved_contour_fallback_geometry`; helper `:3120` gọi
`_round_preserved_corners` với bán kính **0,40 mm**, `quad_segs=3` (`:1328-1329`).
Hai phép buffer dương/âm tại `:1344-1345` trả Polygon, không trả cung Bézier.
Writer nhánh `cut_fitted_paths is None` tại `:11154-11179` ghi polyline preserve.

Vì vậy bước “bo nhẹ” hiện tại có thể làm **tăng lại số node sau simplify** và
giao nhiều chord ngắn cho máy. Không khắc phục bằng tăng `quad_segs` mù vì sẽ
tăng thêm node, cũng không xóa các góc thật chỉ để giảm số đếm.

### BINDER2.3 - Kết quả phụ thuộc trang đang preview

Giữ cùng file và thiết lập, chỉ đổi trang nhận snapshot từ 1 sang 5:

| Trang PDF | Viewer ở trang 1 | Viewer ở trang 5 |
|---|---|---|
| 1 | 18 cubic, canonical | 34 cubic, direct |
| 5 | **279 line, 172 đoạn ngắn**, direct | **103 cubic, 0 đoạn ngắn**, canonical |

Trang 2-4 và 6-13 giữ nguyên path hash. Hai lần đều xuất đủ 13 trang.
Đã assert từng lệnh cubic PDF của trang có snapshot khớp canonical sau làm tròn.
Không phải writer tự phá cùng một canonical: **các trang đang đi hai đường dựng khác nhau**.

Các trang 2/3/4/6/9-13 được detector Alpha phân thành nhiều instance; UI classic
hiện từ chối preview vì kiểm `instances.length !== 1`
(`useClassicCutlinePreview.ts:435`). Không dùng export sheet để lách rồi gọi là
classic đã đạt. Cần xử lý hợp đồng này khi thống nhất đường dựng theo trang.

103 cubic chưa có nghĩa máy chạy hoàn toàn mượt: riêng preview trang 5 vẫn có
bước nhảy độ cong cao; đây chỉ là so sánh với polyline 279 đoạn, không phải kết
quả Simplify đã tối ưu.

## 5. Artifact và tái lập

- [PDF baseline - mức 30, Viewer trang 1](D:/pdfcompare/output/pdf/Binder2-cutline-test-2026-09-09/Binder2_classic_denoise_30.pdf)
- [PDF mức 70, Viewer trang 1](D:/pdfcompare/output/pdf/Binder2-cutline-test-2026-09-09/Binder2_classic_denoise_70.pdf)
- [PDF mức 30, Viewer trang 5](D:/pdfcompare/output/pdf/Binder2-cutline-test-2026-09-09/Binder2_classic_denoise_30_viewer5.pdf)
- Dữ liệu: `docs/audit/BINDER2_CUTLINE_2026-09-09/evidence.json` và `evidence_viewer5.json`.
- Harness: `docs/audit/BINDER2_CUTLINE_2026-09-09/probe.py`.

```powershell
.\backend\venv\Scripts\python.exe -B docs/audit/BINDER2_CUTLINE_2026-09-09/probe.py
.\backend\venv\Scripts\python.exe -B docs/audit/BINDER2_CUTLINE_2026-09-09/probe.py --viewer-page 5 --denoise 30 --trace-fallback-page 5
```

Đã đọc/render toàn bộ 13 trang nguồn, hai baseline và bản Viewer5 bằng contact
sheet. Công cụ app trả `Transport closed`, nhưng runtime Python/Poppler trên đĩa
được xác minh và chạy trực tiếp. Sandbox chặn ghi thư mục output ở lần đầu;
đã xin quyền và chạy phép kiểm ngoài sandbox, không né bằng đổi worker hoặc
sửa quyền hệ thống.

Các lần export đo khoảng 6,1-6,3 giây, chỉ là N=1 từng cấu hình và không phải
benchmark tốc độ máy cắt. Source hash trước/sau giữ nguyên; session tạm đã dọn.

## 6. Thứ tự sửa điều chỉnh theo file thật

1. Giữ `cutline_denoise` qua fan-out; thêm regression nhiều trang và không làm
   mất snapshot/đơn vị. Đây là lỗi classic khác với A1 export sheet đã sửa trước đó.
2. Thống nhất đường dựng của trang đang xem và trang còn lại; không thay đổi
   quỹ đạo chỉ vì chuyển trang Viewer, không bỏ qua các biên hợp lệ gồm nhiều phần rời.
3. Thay fallback polygon dày bằng biểu diễn cong/gộp có kiểm chứng; giữ góc/lỗ,
   lấy chính đường baseline làm chuẩn với dung sai mm. Khóa trang 5 trước, sau đó
   trang 2/4/11 và corpus 13 trang.
4. Đưa Simplify/giảm node ra **giao diện PDF/PNG đã có biên**, dùng chung lõi với
   các consumer khác, hiển thị node trước/sau và sai số.

Đây là kết quả test/điều tra, không tuyên bố đã sửa các mục mới hay đã nghiệm thu
Illustrator/driver/máy bế. Chưa có file sau Simplify của Illustrator để so định lượng.
