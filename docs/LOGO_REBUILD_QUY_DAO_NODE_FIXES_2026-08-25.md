# Nhật ký xử lý vector hóa logo — 2026-08-25

## Trạng thái

Đã hoàn tất lô triển khai sau khi người dùng duyệt xử lý toàn bộ các finding chính của audit đường cong/node.

## Đã xử lý

- Dựng biên silhouette alpha bán trong suốt bằng marching-squares, nội suy subpixel và chuẩn hóa winding.
- Nhận dạng circle/ellipse trước fitter; xuất 4 cubic, tự tăng lên 8/16… khi ngân sách sai số hai chiều chưa đạt. Không hard-cap freeform.
- Bổ sung Schneider reparameterization Newton–Raphson và chế độ `trajectory_completion`: cubic-first trên nhịp cong, chỉ giữ Line cho nhịp thẳng hoặc góc thật.
- Đăng ký shared boundary FlatColor theo cạnh lattice vô hướng; fit một lần và đảo thứ tự/control khi dùng ở nhãn đối diện.
- QC hậu artifact: flatten SVG cuối, bắt tự giao cắt/T-junction/overlap, đo góc tiếp tuyến mọi join thật và truyền telemetry ra backend/UI.
- UI preset rõ ràng, hiển thị node/segment/primitive/sai số hai chiều/tangent artifact; thêm toggle xem anchor và handle Bézier trên SVG.
- Worker giữ độ phân giải nguồn khi dùng core + preset để tránh biến circle thành staircase do upscale NEAREST.

## Verify

- Native: `cargo fmt -- --check`, `cargo check --locked`, `cargo test --locked --lib logo` — 86 passed.
- Backend: `backend\\venv\\Scripts\\python.exe -m pytest backend\\tests\\test_logo_rebuild.py -q` — 72 passed.
- Desktop: targeted Logo workspace + i18n catalog — 44 passed; `npm run typecheck` — passed.
- Native release: `maturin develop --release --locked` — cài thành công sau khi dừng/restart backend dev; smoke worker thật — 3 passed.
- Runtime: endpoint capabilities trả core `0.2.0-dev.1`, đủ 4 preset và geometry metrics v1.

## Ghi chú hợp đồng

Scene production vẫn ghi `M/L/C/Z` để tương thích downstream; primitive circle/ellipse được hạ thành cubic 4/8 theo sai số đã kiểm. Semantic `<circle>/<ellipse>/<path A>` là lô tương lai riêng, không cần để đạt mục tiêu 4/8 anchor hiện tại.
