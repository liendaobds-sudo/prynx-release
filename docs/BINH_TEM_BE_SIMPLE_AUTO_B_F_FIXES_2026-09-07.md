# Bình tem bế — sửa lệch và hoàn tất B–F (2026-09-07)

## Yêu cầu hiện hành

Mục tiêu giữ nguyên: **“1 sửa lệch sau đó làm hết kế hoạch từ B đến F, ko cần hỏi lại giữa chừng,”**.

Người dùng đã duyệt toàn bộ phạm vi và bỏ chốt hỏi lại giữa các lô. Vẫn giữ lô nhỏ ≤5 file code/test, đo/verify trước khi chuyển tiếp; không thay đổi chất lượng hoặc hạ công suất máy mạnh. Không commit, không hoàn tác các thay đổi của người dùng/phiên khác.

Nguồn kế hoạch: BAO_CAO_AUDIT_BINH_TEM_BE_PREVIEW_THUC_THI_HIEU_NANG_2026-09-07.md §7; điểm lệch: BINH_TEM_BE_PREVIEW_A1_A2_FIXES_2026-09-07.md. A1–A2 trước đó được giữ nguyên. HEAD đầu lượt: 79f05a399cb1669e6fb7cd1b84babfcbc7e3aebc; working tree có thay đổi đang làm ở backend và frontend.

## Ma trận hoàn thành — không thu hẹp mục tiêu

| Mục | Việc phải hoàn thành | Bằng chứng/cổng ra | Trạng thái |
|---|---|---|---|
| S1 | Sửa simple_auto preview ↔ export, quét consumer cùng khuôn và một mẫu | Lựa chọn UI đi đúng cả preview/engine; PDF/raster/boxes/source bất biến; optimal_auto không đổi | SOURCE + AUTO + ARTIFACT theo ca kiểm bên dưới |
| B | Tắt WARNING CUT trong vòng nóng khi diagnostics off | Dev opt-in, compiled fail-closed, stream/PDF bytes không đổi | SOURCE + AUTO + BYTE-ARTIFACT + BENCH |
| C | Không phát batch ở tab nền; latest-only và cleanup | React thật: debounce/source/HTTP/JSON/unmount/reactivate/multi-tab; không bỏ capacity mới | SOURCE + AUTO; GUI chưa nghiệm thu, license đã mở lại |
| D | Dùng lại hình học bất biến theo part/side trong preview và writer | Không parse lại polygon theo từng ô; giữ identity, alias, holes, rotation, invalid input; pixel/geometry parity | SOURCE + AUTO + ARTIFACT + BENCH |
| E | Index placement theo sheet một lần | O(P) grouping, giữ thứ tự UTF-8/recipe/report/duplex và output | SOURCE + AUTO + ARTIFACT; visits 3P |
| F | Tối ưu nạp manifest đã đo, không chỉ ghi báo cáo | Giữ hash/schema/native validator/source/lease/TOCTOU; order/failure/cancel, RAM/CPU admission; A/B thật | SOURCE + AUTO + ARTIFACT + BENCH N20 |

Đã triển khai và kiểm tự động/artifact đủ S1 và B–F. Không nâng thành nghiệm thu Tauri/installer. Người dùng đã xác minh lại license thành công; Computer Use mở được Bình Tem Bế từ Home nhưng bị người dùng dừng bằng Esc trước khi hoàn tất preview → export. Phản hồi mới về layout lệch hàng được ưu tiên theo `BAO_CAO_AUDIT_NESTING_LECH_HANG_2026-09-07.md`; chốt chất lượng/GUI vẫn còn mở.

## S1 — sửa lệch lựa chọn lưới

### Bằng chứng và thay đổi

UI GridSettingsSection cho chọn simple_auto (Lưới đơn giản), nhưng nup_engine full-layout luôn truyền optimal_auto. Full-layout được đọc tại S&R, N-up một mẫu và nhánh đồng nhất. Khi sửa export, regression đã bắt được preview đồng nhất cũng đang ép optimal_auto; đã sửa cả hai producer.

- backend/app/workers/nup_engine.py: full-layout dùng simple_auto khi được yêu cầu; các strategy đặc biệt khác giữ policy cũ.
- backend/app/api/routes/imposition.py: preview đồng nhất dùng cùng policy.
- backend/tests/test_sticker_simple_preview_export_parity.py: 24 ca artifact/raster, gồm 4 góc Rotate, lề/gap thập phân, S&R nhiều mẫu, N-up một mẫu/cùng khuôn, cold/warm/batch.
- Đây là sửa correctness: simple_auto giữ đúng lưới người dùng chọn, không âm thầm thêm L-fill. optimal_auto vẫn giữ phương án tối ưu; không đổi golden.

### Verify

- Baseline 20 ca đầu: 9 fail / 11 pass; export 13 so với preview/oracle 12.
- Sau patch export đơn lẻ: test cùng khuôn phát hiện thêm 1 fail / 3 pass; không bỏ qua hồi quy này.
- Sau patch đủ preview + export: **24 passed**, 5,05 s; đọc PDF/CUT/raster cả hai mẫu, có kiểm cạnh dư, source hash và page boxes.
- Nhóm rộng 8 file: **131 passed + 1 WinError 5 môi trường** (named pipe ProcessPoolExecutor). Đúng ca nhiều chunk chạy lại ngoài sandbox: **1 passed**, 3,08 s. Không gọi invocation sandbox ban đầu xanh.

## B — log CUT

- ShapeBuilder.finish chỉ phát DEBUG khi logger cho DEBUG và PRYNX_CUT_PATH_DEBUG bật trong dev; authority development_diagnostics chặn binary đóng gói bật lại qua env.
- Không đổi toán tử path/OCG; không bỏ các kiểm tra dữ liệu.
- Test 64 CUT paths: baseline phát 64 WARNING ngay cả diagnostics off, 4 test đỏ. Sau sửa diagnostics off trả 0 log; dev opt-in trả DEBUG, non-dev/compiled vẫn 0.
- PDF off/on dùng static ID có **byte giống nhau**; nhóm continuity + simple parity + finalizer + clip raster: **42 passed**, 5,75 s.

## C — đã verify source/React

Hai file Dashboard và groupingParity tests. Controller theo từng effect/generation; chặn tab nền trước debounce, kiểm source/epoch/tab/OCG sau mỗi await, truyền signal cho upload/HTTP, cleanup chỉ hủy request sở hữu. Giữ capacity mới nhất, không để batch cũ ghi đè hoặc khôi phục epoch đã reset.

Subagent đã chạy 31 test grouping parity + 1 background-dialog test; eslint hai file sạch. Parent rerun Dashboard/GridPreview/mixed API **125 passed**, typecheck standalone đạt. Vitest lần đầu bị sandbox chặn spawn EPERM, đã chạy lại ngoài sandbox thành công. HTTP abort không tự dừng CPU của route sync đã nhận; không tuyên bố đã có cooperative cancellation backend.

## F — bằng chứng chuẩn bị (giữ làm lịch sử)

Fixed 13 manifest / 659 placement, 412.330 byte, cùng source/native fingerprint như baseline audit. Native thực nhả GIL: CPU/wall của parallel khoảng 6, serial khoảng 1. N=3 sau 1 warm-up:

| Phase | Serial median | Parallel planned 13 threads |
|---|---:|---:|
| Native validator | 2.219,836 ms | 547,708 ms |
| Full decode/identity/native validation | 2.452,754 ms | 741,378 ms |

Đây là feasibility probe, chưa RSS/full load/lease/export SLO. Tổng CPU tăng; không gọi là cải thiện CPU efficiency. Không đổi payload/pose/source và không gia hạn marker của kho cũ.

Hướng F phải giữ nguyên validation authority, song song việc độc lập sau admission. Thứ tự tài nguyên phải khớp solve hiện hữu **CPU → RAM** để tránh deadlock. RAM phải tính cả decoded dicts giữ lại, placement×vertices và spatial buckets, không nhân số thread từ 256 MiB hint rồi coi như có proof RAM. Generic load vẫn native-validate, không dùng proof xuyên request để bỏ kiểm tra.

## D — context khuôn/mặt được dùng trên đường thật

Bốn file của lô: nup_artwork.py, nesting_preview_capacity.py, nesting_imposition_render.py, test_manifest_part_context.py.

Factory tạo ManifestPartContext frozen, không giữ mapping nguồn; token factory không nằm trong DTO. Sở hữu sâu polygon và binding, kiểm part/hash/side/pose từng occurrence như cũ. Chỉ chuẩn hóa part/side thực dùng, không biến report/side bỏ qua thành điều kiện chặn mới. Raw resolver vẫn tương thích.

- 8 placement: preview parse ring 32→4, writer 48→6.
- Alias/mutation, constructor/replace, malformed polygon/pose/identity, holes, góc lẻ và toàn pixel Front/CUT được khóa.
- Parent chạy **156 passed**, gồm preview capacity với native thật.
- Cùng 13 manifest cố định/659 ô, hai warm-up + N20 xen kẽ: projection **346,567→185,507 ms**; response hash bằng nhau. Đây là chi phí projection, không phải toàn preview.

## E — index placement theo tờ

Hai file: nesting_imposition_render.py + test_nesting_writer_sheet_index.py.

Index được dựng một lần, validate từng occurrence trước dedup, giữ sort UTF-8 instanceId và exact recipe multiset. Sheet plan, render và report nhận cùng index. Các helper độc lập vẫn có fallback tương thích; đường writer thật không quét P theo mỗi tờ.

- Actual public writer S10/20/40: visits **260/920/3440→60/120/240**; ba lượt tuyến tính (_assert_renderable, _sheet_count, index).
- Giữ unique/non-unique/report/duplex, giá trị pose khác 1e-8 không bị gộp, duplicate pose giữ multiset.
- Sáu tổ hợp artifact hợp lệ giống toàn pixel, report, metadata, source và manifest.
- Parent **115 passed**. Không biến counter thành phần trăm tốc độ toàn export.

## F — nạp/kiểm manifest song song có admission

Ba file code/test chính: nesting_manifest_batch.py, nesting_manifest_store.py, test_nesting_manifest_batch.py. Harness benchmark riêng được lưu trong evidence.

- Không sửa _decode_record_core hoặc dùng proof để bỏ native validation.
- Prepass từng file có CPU→RAM admission; chỉ giữ size/digest/cost scalar, bỏ raw/tree trước nhả reservation.
- Reread có expected size, kiểm descriptor và đọc tối đa N+1; SHA-256 phải khớp prepass rồi mới full decode.
- Mỗi record/duplicate vẫn kiểm canonical envelope, hash, schema/build, native validator; không cache proof xuyên request.
- Planner/CPU coordinator hiện hữu; số lane chỉ co khi RAM thật không chứa nổi full batch. Không thêm cap hằng số lên máy mạnh.
- RAM model v1 tính raw/decoded trees, placement×vertices và spatial memberships. Cận tổng membership (12+2M)N, M=512, được chứng minh theo mean extent và khóa bằng test Rust-assumption/spatial sweep.
- CPU nhả trước source phase, RAM giữ đến hết resolve/renew/materialize; mọi lỗi/hủy/submit failure đều drain thread trước nhả.
- Source lease, expiry, no-replace, source hash trước/sau, và thứ tự output giữ nguyên. Không có claim preempt native hay hủy shared restore vì một subscriber bỏ chờ.
- Một record giữ fast path cũ, không trả thêm phí batch prepass.

64 test helper/tích hợp; parent mở rộng trước checkpoint **273 pass + 3 lỗi sandbox named pipe**, ba ca đó rerun ngoài sandbox **3 pass**. Có test store thật: native đủ mỗi record, no source trước barrier, CPU trống/RAM còn giữ, hash/schema/build/pose và tăng/đổi bytes tại các cửa sổ đọc.

### Benchmark F cuối — không ghép số từ các workload khác

Tạo một lần rồi giữ **13 manifest / 659 placement**. Baseline chỉ dùng method load_many trước F; decoder/source và writer D/E giống nhau ở cả hai nhánh. Hai warm-up + 20 lần đo xen kẽ, không solve lại. Source không đổi, mọi dữ liệu loaded được đối chiếu; raster toàn 26 trang ở cặp đo đầu/cuối giống nhau.

| Phase | Before median | After median | Before P95 | After P95 |
|---|---:|---:|---:|---:|
| Full load/validate/source/lease | 2.776,660 ms | **1.095,589 ms** | 2.844,350 ms | 1.122,442 ms |
| Export từ cùng reference | 5.245,434 ms | **3.563,229 ms** | 5.326,904 ms | 3.678,414 ms |

- Riêng F giảm khoảng **60,5% full load** và **32,1% export** trong workload này.
- Peak RSS sampled: load 113,543→114,059 MiB; export 117,512→118,289 MiB. Không phải strict allocator upper bound.
- Kiểm grant thật: 13 worker, coordinator capacity15/held13, reservation **935,389 MiB**, sau call về 0. Không hạ máy mạnh về 1–4 worker.
- CPU-time tăng khi song song; không gọi đó là tiết kiệm tổng CPU. Đã kiểm tier/env/unknown và contention bằng fixture, chưa phải benchmark máy RAM thấp vật lý hoặc coordinator xuyên process.
- Không bao gồm HTTP, outer process startup hoặc first paint Tauri.

B substage riêng N20 (1.000 CUT path + save PDF, synchronous StringIO logger): 16,504→7,021 ms, 1.000→0 log, PDF byte-identical. Không dùng số này làm speedup toàn export hoặc I/O đĩa.

## Kiểm chứng cuối toàn phạm vi

- Backend 21 file liên quan: **770 passed, 1 skipped**, 90,66 s; chạy ngoài sandbox để phủ process/lease thật.
- Skip hiện hữu: test_p6b_chua_co_route_reachable, vì route đã thêm ở P7a và thuộc test phase đó.
- Frontend liên quan: **125 passed**; background-dialog test riêng **1 passed**.
- Typecheck Windows, cú pháp Python và diff-check đạt; không golden update, không commit/build release.
- Không sửa các thay đổi ngoài phạm vi đang có trong workspace.

## Chốt GUI/giới hạn còn lại

Lần đọc cửa sổ trước báo **Computer Use app approval timed out**; đây chỉ còn là lịch sử, không phải trở ngại hiện tại. Lượt tiếp tục 2026-09-07 đã đọc được screenshot và accessibility của đúng cửa sổ **PrynX - Print made easy!**, process debug ở desktop/src-tauri/target/debug/pdf-inspector.exe (window id 6751614).

Quan sát lịch sử trước khi người dùng khôi phục license: hộp **“Không thể xác minh bản quyền”**, nội dung **“Chưa có checkpoint thời gian tin cậy. Vui lòng kết nối internet để xác minh bản quyền.”**. Agent không click/nhập key hoặc thay đổi license/đồng hồ/cài đặt bảo mật. Việc thấy hộp này không phải bằng chứng lỗi do các lô hiệu năng gây ra.

Người dùng sau đó báo **“đã thử lại được rồi”**; quan sát mới xác nhận Home không còn hộp bản quyền. Agent kích hoạt cửa sổ, mở tab Bình Tem Bế và bấm vùng chọn file (hai click); file `test nesting.pdf` xuất hiện, preview báo chờ tài nguyên. Không ghi nhận thao tác agent chọn tên file trong picker. Người dùng dừng Computer Use bằng Esc; agent không tiếp tục điều khiển app. Chưa hoàn tất kiểm preview → export simple/optimal, tab nền và thay đổi nguồn; `verifiedRuntime` vẫn là `false`, installer/máy RAM thấp vật lý chưa nghiệm thu.

Kiểm tra toàn vẹn độc lập ở lượt tiếp tục: **17/17 SHA-256** trong sourceSnapshot khớp file hiện hành (gồm fixture PDF và native), HEAD không đổi; ma trận S1/B–F khớp kế hoạch gốc. Đây là kiểm hash/đối chiếu bằng chứng, không phải chạy lại toàn bộ test. Không có thay đổi code trong lượt cập nhật trạng thái này.

Mọi phần code theo S1/B–F đã có bằng chứng ở trên, nhưng không đóng nghiệm thu toàn mục tiêu. Phản hồi tiếp theo của người dùng về nesting lệch hàng đã được xác nhận trên artifact và truy tới hở bảo đảm mẫu lặp S&R. Xem `BAO_CAO_AUDIT_NESTING_LECH_HANG_2026-09-07.md` và `audit/NESTING_ROW_DRIFT_EVIDENCE_2026-09-07.json`. Tốc độ/parity trước-sau không chứng minh layout cũ đã đáp ứng yêu cầu đều hàng; chưa sửa thuật toán trong lượt chẩn đoán mới.

Bằng chứng gồm raw số đo, script, hash source và giới hạn: [BINH_TEM_BE_B_F_EVIDENCE_2026-09-07.json](D:/pdfcompare/docs/audit/BINH_TEM_BE_B_F_EVIDENCE_2026-09-07.json).
