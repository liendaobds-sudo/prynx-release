# Preview Bình tem / CNC: UI, tiến trình và tốc độ

## Phạm vi và trạng thái

Khảo sát hẹp theo câu hỏi của người dùng: vì sao sức chứa/pager khác nhau, CNC không thấy thanh tiến trình và có thể tăng tốc preview thế nào. Lượt này chỉ chẩn đoán và đo read-only; không sửa code ứng dụng. Các thay đổi nesting/license/renderer đang có trong working tree thuộc lượt trước và được giữ nguyên.

Ảnh người dùng cho thấy “Sức chứa: 32 tem/tờ”, “tờ 2/17”. Ảnh không chứa cấu hình/profile đang chạy hoặc request, nên không dùng nó để khẳng định nhánh tính toán của CNC thực tế.

## Kết luận đã kiểm chứng

### §PV26.1 — P1 / S: cấu hình chia nhóm của Bình trang lệch giữa preview và export

- `desktop/src/components/imposition-tools/ImposerDashboard.tsx:2116`: `_effGroupingPv` truyền nguyên `s.groupingStrategy` cho preview Tem/CNC.
- Cùng file, `:1240`: bảng sức chứa batch cũng dùng grouping nguyên trạng.
- Cùng file, `:1661`: export ép `groupingStrategy='none'` khi `taskMode='step_repeat'`.
- `store/slices/nupSlice.ts:133`: giá trị mặc định là `maximize_area`; `workspaceSlice.ts:41` đổi tác vụ không chuẩn hóa grouping.
- `trueShapeNestingRollout.ts:274`: S&R chỉ chấp nhận `none/free_gang` cho true-shape. Guard backend tương ứng nằm tại `backend/app/workers/nup_true_shape_nesting.py:287`.

Đã chạy chính hàm TypeScript hiện tại bằng transpile trong bộ nhớ, không sửa module. Input: rollout bật, Bình trang, Xếp tối ưu, hai mẫu PENTAGON/CUSTOM cùng tham gia; chỉ đổi tool/grouping:

| Công cụ | Grouping preview | Preview vào nesting | Sau chuẩn hóa grouping=none |
|---|---|---|---|
| Bình tem | maximize_area | Không | Có |
| CNC | maximize_area | Không | Có |
| Bình tem | none | Có | Có |
| CNC | none | Có | Có |

Đây là lỗi hợp đồng có bằng chứng logic, có thể khiến preview không có thanh % và export chọn engine khác nếu không có quyết định forceLegacyGrid đã chốt. Chưa đọc profile/runtime request của chính ảnh, nên chưa khẳng định đây là nguyên nhân duy nhất của ca người dùng.

Đề xuất: một chính sách cấu hình hiệu lực dùng chung cho preview đơn, bảng sức chứa và export; không ghi đè profile Dàn nhiều mẫu khi chuyển sang Bình trang. Kiểm tra thêm identity/handoff và giữ đúng template đang xem.

### §PV26.2 — UI dùng chung; phản hồi tính toán chưa đồng nhất giữa các nhánh

- Cả Tem/CNC render cùng `GridPreview` (`ImposerDashboard.tsx:2125`).
- Pager hiện khi `layoutResult.sheets.length > 1` (`GridPreview.tsx:3501`), không kiểm loại công cụ. “2/17” chỉ tờ preview đại diện đang chọn, không tự đồng nghĩa phải in 17 tờ.
- Thanh tiến trình bị gate bởi `usesTrueShape` và trạng thái đang chạy, không bị chặn riêng CNC (`GridPreview.tsx:3362`).
- Nhánh nesting tạo job, nhận progress và lấy result (`:2629`); nhánh lưới dùng endpoint đồng bộ (`:2720`), chỉ có spinner (`:3875/:4174`).
- Tool profile lưu riêng cấu hình (`ImposerDashboard.tsx:325`, `store/profiles.ts:8`), nên cùng file không đồng nghĩa cùng task/layout/strategy/grouping/quantity.
- CUSTOM được xét trên toàn bộ tập mẫu tham gia, không chỉ trang đang xem (`trueShapeNestingRollout.ts:230`).

Đề xuất: dùng chung vùng trạng thái chờ và nhãn sức chứa/pager; nhánh có tiến trình thật mới hiện %, nhánh chưa có thì hiện trạng thái không xác định. Không dựng phần trăm giả, không đổi solver chỉ để có thanh tiến trình.

## Phép đo mới trên file 17 trang

Nguồn: `D:/pdfcompare/test/cac loai hinh - Copy.pdf`.

SHA256: `018D6CD297DEACB983C1472C01335F5A5C3DF5ADB1E3E9F1666AA093CFF80730`.

Chạy backend venv trong process riêng, gọi helper thật; không HTTP/Tauri, không render SVG, không xuất PDF, không chạy solver true-shape. Tờ 320×430 mm, lề 3 mm, gap 2 mm, không ốc. Những số dưới đây là chi phí từng helper, không phải latency toàn preview.

| Pha | Lần 1, ms | Lần 2, ms | Lần 3, ms |
|---|---:|---:|---:|
| Dò cả 17 trang | 233.39 | 44.42 | 44.82 |
| Layout lưới trang 1 / PENTAGON | 87.52 | 2.03 | 0.81 |
| Layout lưới trang 7 / PENTAGON | 1.31 | 0.65 | 0.49 |
| Layout lưới trang 13 / CUSTOM | 9.70 | 5.59 | 5.99 |
| Layout lưới trang 14 / DUMBBELL | 385.02 | 333.19 | 356.96 |
| Layout lưới trang 15 / HAMMER | 388.52 | 355.71 | 383.01 |

Dựng 17 job đầu vào (có dò lại, chưa solve): **404.87 ms**, N=1 sau detector đã chạy. Không cộng số này với detector như hai pha không giao nhau. Layout helper chạy trên cùng document trong một process; warm chịu ảnh hưởng import/cache nội bộ. Không suy speedup cold/warm của toàn ứng dụng từ bảng này.

Sức chứa raw của năm trang lần lượt 28, 65, 67, 30, 42, ổn định trong ba lần; chưa né ốc/finalize và không phải số trong ảnh người dùng.

## Tăng tốc: ưu tiên cần đo, không hứa phần trăm

1. **Tránh tính trùng khi preview và bảng sức chứa khởi động cùng lúc.** Hai đường đã dùng chung `_NEST_A_CACHE`, nhưng cache miss → compute nằm ngoài khóa, nên có thể cùng tính một key (`imposition.py:3853`, `:4509`). Đo số lần compute đồng thời trước; chỉ thêm cơ chế gộp request đang tính nếu tái hiện được. Không giới thiệu cache này như tính năng chưa tồn tại.
2. **Tái dùng dữ liệu nguồn giữa các job S&R.** Pin/dedup hiện trong phạm vi một job (`nesting_production_pipeline.py:460`), còn một file nhiều mẫu tạo nhiều job. Đây là backlog shared snapshot/cross-job hash; phải bảo toàn fingerprint, vòng đời snapshot và hủy job, không bỏ kiểm tra nguồn.
3. **Giảm thời gian tới hình đầu tiên và trả dần từng tờ đã xác minh.** Đã có preview lưới tạm sau debounce 250 ms, job nesting sau 750 ms; không coi đó là tối ưu mới. Nếu mở rộng trả từng tờ nesting thì phải giữ trạng thái tạm/chốt, ngăn kết quả cũ ghi đè và chỉ export manifest đã sẵn sàng.
4. **Tối ưu dựng nét/render sau khi có payload nếu đo thấy UI bị khựng.** Chuẩn hóa hình học mỗi mẫu trước khi nhân bản, tránh ghép nét lặp từng ô/mỗi lần progress cập nhật. Không dùng đếm số điểm để suy đoạn hở/vòng kín; không giảm độ chính xác khuôn để lấy tốc độ.

Các thứ đã làm không đề xuất lại: batch wave scheduler, handoff/reference, cache preview/batch, lazy NFP, provisional preview, reason-check NFP reuse. Không tăng worker mù hoặc bỏ kiểm va chạm; mọi điều chỉnh tài nguyên tuân theo RAM-gating.

Baseline cũ `test nesting.pdf` 13 trang: cold median 15.417 s, warm 2.736 s, N=3, warm không solve. Xem `BAO_CAO_AUDIT_NESTING_THONG_MINH_HIEU_NANG_2026-09-05.md:5.4`. Đây là số trước bản sửa và explicit backend nesting, không phải kết quả hiện tại của file 17 trang, không dùng để hứa tăng tốc.

## Chốt đề xuất

Lô nhỏ đầu tiên: sửa §PV26.1 và thống nhất vùng trạng thái §PV26.2; thêm regression cùng file/cấu hình Tem↔CNC, named/CUSTOM, S&R/gang, fallback/cancel, và kiểm runtime. Lượt khảo sát này dừng ở báo cáo, chờ duyệt trước khi triển khai.

Lô tốc độ riêng: đo first-paint, all-pages-ready, cold/warm và số lần solve/compute bằng cùng cấu hình thực; tối ưu đúng pha chiếm thời gian, giữ số tem/chất lượng và preview–export parity. Chưa có A/B sau sửa để công bố phần trăm tăng tốc.
