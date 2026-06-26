"""End-to-end: mép kẹp (gripper) PHẢI chừa vùng cạnh nạp giấy trong Bình Cắt Xén.

Bug đã sửa: run_nup_engine bỏ qua gripperMargin (chỉ log) → bài tràn vào vùng kẹp.
Test: cùng job, gripper lớn phải LÀM GIẢM sức chứa/ tờ → TĂNG số tờ output. Nếu engine
bỏ qua gripper (bug cũ) thì số tờ bằng nhau và test FAIL.
"""
import io


def _mk_src(path, w=255, h=255):
    """1 trang nguồn ~90mm vuông (255pt)."""
    from app.workers import pdf_wrapper as pdf_lib
    d = pdf_lib.open()
    pg = d.new_page(width=w, height=h)
    sh = pg.new_shape()
    sh.draw_rect(pdf_lib.Rect(10, 10, w - 10, h - 10))
    sh.finish(color=(0, 0, 0), fill=(0.5, 0.5, 0.5))
    sh.commit()
    buf = io.BytesIO(); d.save(buf); d.close()
    open(path, "wb").write(buf.getvalue())


def _run_sheets(tmp_path, gripper_mm):
    from app.workers.nup_engine import run_nup_engine
    import pikepdf

    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / f"out_{gripper_mm}.pdf")
    _mk_src(src)
    settings = {
        "imposerMode": "guillotine",
        "sheetWidth": 300, "sheetHeight": 300,   # mm → 850pt
        "bleed": 0, "gapX": 0, "gapY": 0,
        "marginTop": 0, "marginBottom": 0, "marginLeft": 0, "marginRight": 0,
        "gripperMargin": gripper_mm,
        "markType": "none",
        "gridStrategy": "simple_auto",
        "layoutType": "sequential",
        "targetQuantity": 18,
    }
    run_nup_engine(src, out, settings, job_id=f"grip{gripper_mm}")
    with pikepdf.open(out) as pdf:
        return len(pdf.pages)


def test_gripper_reduces_capacity_increases_sheets(tmp_path):
    # Khổ 300mm (850pt), item 90mm (255pt): không gripper → 3×3=9/tờ → 18 con = 2 tờ.
    # gripper 120mm (340pt) → lề đáy hiệu dụng 340pt → usable_h 510pt → còn 3×2=6/tờ → 3 tờ.
    pages_no_gripper = _run_sheets(tmp_path, 0)
    pages_with_gripper = _run_sheets(tmp_path, 120)
    assert pages_no_gripper == 2, f"không gripper kỳ vọng 2 tờ, thực {pages_no_gripper}"
    assert pages_with_gripper > pages_no_gripper, (
        f"gripper phải giảm sức chứa → tăng số tờ; "
        f"no_gripper={pages_no_gripper}, with_gripper={pages_with_gripper}"
    )
