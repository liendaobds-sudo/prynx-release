# S&R nesting lặp ổn định - triển khai 2026-09-07

## Yêu cầu đã duyệt

Người dùng đã duyệt: xếp dàn nhiều mẫu được tự do; Bình trang S&R phải nesting và lặp ổn định. Theo báo cáo BAO_CAO_AUDIT_NESTING_LECH_HANG_2026-09-07.md, triển khai theo lô nhỏ có verify.

- Chỉ đổi StepRepeatSingleSheet; giữ N-up autofill/quantity fulfillment/free-gang.
- Lồng contour thật và lặp basis/motif; không chọn lại greedy tự do làm final chỉ để đạt số lượng.
- Sàn đối chiếu bốn artifact nguồn 6/7/8/12: 66/66/57/29. Giữ nguyên số gốc; không hạ test để che mất tem.
- Giữ gap theo trục, miền góc, biên, né ốc, cancel, validator, source/manifest/PDF parity và full công suất máy mạnh.
- Không sửa license, không stop/restart app người dùng, không commit hoặc build/publish release.

## Baseline

HEAD ban đầu: 79f05a399cb1669e6fb7cd1b84babfcbc7e3aebc. Giữ nguyên thay đổi S1/B-F và frontend tác vụ khác.

Source SHA-256: efcde4f0a16aca0a5a54ee2d952945afe2eb70dd2073bc9ff59ee87292b257ab.
Native trước: CAC22B947E503B3E42D70ED9567E37E40B76707A27B869E83F6DDCCA606FCBE9, baselineVersion 12.
Snapshot: backend/.audit-tmp/row-drift-native-20260907/before/pdfcompare_native.cp311-win_amd64.pyd; không thay binary app.
Máy: 34.107.990.016 byte RAM / 16 logical CPU. Core probe dùng grant 15; không đổi admission production.

Core-before: 1 warm-up + 3 mẫu, 4 contour, handles mới; không gồm detector/HTTP/writer/GUI. Source 6/7/8 giữ 66/66/57; hoa source12 dao động 28-29 theo deadline/tải. Đây là dữ liệu trước sửa, không tự giảm sàn mục tiêu29. Full RESULT console bị cắt; 12 dòng ROW đo chính còn nguyên và được lưu riêng, không giả vờ đã có toàn bộ telemetry.

## Lô triển khai

| Lô | Phạm vi | Chốt | Trạng thái |
|---|---|---|---|
| R1 | baseline.rs + module con periodic, multi_start.rs, actual fixture + test Rust (5 file) | Đỏ trước; motif/basis độc lập flag; count/gap/marks/rotation/cancel | **12/12 test phạm vi đạt** sau chốt baseline không cắt motif; chưa nghiệm thu GUI |
| R2 | Native mới và tích hợp manual/Auto/legacy fallback | Version/fingerprint mới; reference cũ không dùng nhầm; nhánh khác giữ pose/score | **RUNTIME BACKEND đạt**; wheel đã cài vào `backend/venv`, smoke trực tiếp 145/145; GUI/Tauri/installer chưa nghiệm thu |
| R3 | Artifact + A/B + log cuối | PDF thật bốn hình; số tem/quỹ đạo/time đúng scope | **ARTIFACT + AUTO đạt**; PDF 8 trang, 4 mẫu giữ sàn 69/71/58/31; CUT có đúng placement+4 ốc, không `cm`/`Do` |

## Bẫy cần giữ

- Gate prefers_periodic_motif(), không is_single_sheet_autofill() vì hàm sau gồm N-up.
- Bump BASELINE_VERSION đổi fingerprint hợp lệ; so nhánh không đổi bằng pose/score/raster, không whole-manifest hash.
- Hot session/capabilities cache theo process: reload UI chưa chứng minh dùng native mới.
- native/build.rs chưa watch riêng imposition_core/src: kiểm hash .pyd và capabilities thực, không chỉ build identity.
- Auto quality gate có legacy grid/L-fill và UI lỗi/hủy có provisional fallback; manual true-shape chưa chứng minh cả Auto.

## Nhật ký

Snapshot copy lần đầu bị sandbox chặn, retry được duyệt thành công. Lỗi import trước đó do path snapshot chưa tạo, không phải lỗi native. Harness baseline đã giảm output lặp để lần đo sau không bị cắt console. Kết luận R2/R3 nằm ở cuối nhật ký; cổng RUNTIME vẫn giữ HOLD.

### R1 - đỏ trước sửa

Fixture JSON giữ nguyên bốn engineRequest, contour solver (67/45/70/118 đỉnh), bốn ốc mỗi ca và 218 placement cũ; source/settings đối chiếu kho F. SHA-256 fixture: `98491adff4a2b0e738ca6dfc939fc2e81fcaa7c05f648c067828c132cc40446d` tại thời điểm tạo.

Lệnh `cargo test --release --test mixed_nesting_step_repeat_user_pages actual_user_baseline_is_periodic_beyond_first_row -- --nocapture --test-threads=1` đã chạy trước khi thay core. Lượt đầu sandbox chặn ghi rlib; chạy lại ngoài sandbox được duyệt, biên dịch 19,01 s rồi test **FAIL đúng cả nguồn 6/7/8/12**: 66/66/57/29 tem, `periodic_motif=false`, checker basis đều trả `None`. Thời gian baseline fixed-work trong test: 657/125/670/2351 ms. Không gọi test đỏ này là lỗi môi trường.

Checker đã được siết thêm điều kiện phase chung sau lần RED đầu; verify cuối phải biên dịch lại phiên bản test mới nhất. Không hạ floor hoặc thay contour để làm test xanh.

Full binary test trước sửa đã chạy 8 ca: 4 pass / 4 fail. Fixture, checker âm/dương, floor fixed-work và free-gang đạt; các chốt periodicity đỏ và hoa nguồn12 dưới deadline chỉ có28/29 tem. Binary này là snapshot đã compile trước core, không coi nó đã bao lần siết checker cuối.

Đã thêm chốt S&R tại multi_start: không nhận baseline thiếu periodic authority hoặc cứu bằng free-gang; N-up vẫn giữ rescue cũ. Chưa verify bản sửa vì module periodic đang triển khai cùng lô.

### R1 - đã verify phạm vi; chuyển R2

Main đã chạy lại toàn target mới nhất: **12 passed**, 68,68 s. Fixed-work cho 69/71/58/31 tem (sàn 66/66/57/29), checker basis/coset độc lập đều đạt, final geometry validator đạt, fixed-work grant1/3 cùng pose/score. Production control3000ms cũng giữ sàn sau khi periodic baseline chuyển sang chỉ tôn trọng cancel; ca60độ-only-fit, cancel-before và normalizer chặn cận160.000 con đều đạt.

Timing core production của hoa nguồn12: baseline3001ms, baseline-validation409ms, publication807ms, tổng4217ms. Budget3000ms không bao gồm chốt validation/publication; không nói tổngwall đã <=3giây.

Hai ca synthetic đầu tiên viết sai schema `quantity:0`/gọi nhầm tầng capacity; đã sửa test theo schema autofill bỏ quantity và kiểm `AutofillCapacityBoundTooLarge` tại normalize. Không sửa dữ liệu bốn contour thật hoặc hạ sàn. Nghi vấn cấp phát cực lớn qua API được thu hẹp vì normalizer đã chặn cận >100k; streaming vẫn giảm bộ nhớ đệm và giữ cancel đúng.

Broad check đã có lib47pass và baseline42pass/2ignored; còn1 test version cũ đòi12 trong khi đổi thuật toán có chủ đích lên13. R2 cập nhật assertion metadata này, không đổi golden hình học. Reviewer còn nêu một ca vật cản cần tái hiện: corridor hẹp cần phase không có trong edge/midpoint hiện hữu. Chưa build/install native mới cho app.

### R2 - native và integration

- `maturin build --release` đã build wheel mới từ `imposition_core` hiện hành với `PRYNX_BUILD_*` explicit; capabilities thực báo `baselineVersion=13`, protocol/engine/validator giữ nguyên hợp đồng và build identity `077f23637a9279f3dc98441cbcd02a1c5abe011469cbba403af1c62e310fa6f9`.
- Không cài đè `backend/venv` vì Windows trả `WinError 5` trên `.pyd` đang được process khác giữ; không dừng/restart app người dùng. Integration chạy bằng wheel cô lập qua `PYTHONPATH`, không dùng nhầm binary cũ.
- `backend/tests/test_nesting_production_pipeline.py` + `test_mixed_nesting_native.py`: **67 passed, 1 warning Pydantic hiện hữu**.
- Final wheel explicit identity chạy thêm entry/route/preview: `test_nup_true_shape_nesting_entry.py` **78 passed**, dispatch + auto-route **65 passed**, preview capacity **47 passed**; tổng integration backend đã đo **257 passed, 1 warning Pydantic hiện hữu**.
- Core regression sau thay đổi periodic baseline: `mixed_nesting_baseline` 43 passed/2 ignored, `mixed_nesting_baseline_budget` 8 passed, `mixed_nesting_baseline_rotate` 13 passed, `mixed_nesting_deadline_in_region` 8 passed, `mixed_nesting_solver` 41 passed; `cargo fmt -- --check` đạt.

### R3 - artifact thật và A/B

- Chạy public `run_true_shape_nesting()` trên `test/test nesting.pdf` (SHA-256 `efcde4f0a16aca0a5a54ee2d952945afe2eb70dd2073bc9ff59ee87292b257ab`), settings S&R 320×430 mm, gap 2×2 mm, lề 3 mm, ốc 5 mm; chỉ chọn source pages **6/7/8/12**.
- Native mới tạo 4 manifest `baselineVersion=13`, tất cả `status=completed`, `selectedCandidate=baseline`, `trialsRun=0`; số tem lần lượt **69/71/58/31**, không thấp hơn sàn **66/66/57/29**. Tổng **229** placement; PDF output 8 trang (Front/CUT cho 4 mẫu), SHA-256 `3cb4b9e94c570bcf19f7d6b9fce03c69ee2c49ea304210f97e525f39b7884b00`.
- Kiểm PDF: CUT page 2/4/6/8 có lần lượt **73/75/62/35** vòng (placement + 4 ốc), toàn bộ `cm=0`, `Do=0`; không phát hiện CTM/Form ẩn. Artifact: `D:/pdfcompare/tmp/r2-r3-production-final-final/step-repeat.pdf`, evidence: `docs/audit/NESTING_ROW_DRIFT_R2_R3_EVIDENCE_2026-09-07.json`.
- Bản sửa bắt buộc periodic baseline **không cắt giữa motif theo deadline**; deadline chỉ được ghi nhận tại barrier sau baseline, nên page 6/page 12 có thể vượt 3 giây wall-clock để giữ sàn (đã đo khoảng 3,6 s và 5,4 s ở lượt artifact). Đây là trade-off chất lượng đã chọn, không tuyên bố speedup.

### Trạng thái sau R2/R3

R1/R2/R3 đã có bằng chứng core, native, integration, artifact và runtime backend. Còn mở riêng cổng **GUI/TAURI/INSTALLER**: mở lại app dev, thao tác thật Bình tem bế và nghiệm thu installer/release.

### Runtime backend sau khi người dùng tắt app dev

- `pip install --force-reinstall` wheel final đã thành công sau khi app dev đóng; `backend/venv` báo `baselineVersion=13`, build identity `077f23637a9279f3dc98441cbcd02a1c5abe011469cbba403af1c62e310fa6f9`.
- Smoke/regression trực tiếp bằng package đã cài: **145 passed, 1 warning Pydantic hiện hữu**.
- Artifact runtime sạch: `D:/pdfcompare/tmp/r2-r3-production-runtime-final/step-repeat.pdf`, SHA-256 `1c512270a9f5b6afab458184f0e13bed02eac8d3b9baa620b1aaf4fb8277e846`; 8 trang, 229 placement, giữ sàn 69/71/58/31; CUT 73/75/62/35 vòng, `cm=0`, `Do=0`.
