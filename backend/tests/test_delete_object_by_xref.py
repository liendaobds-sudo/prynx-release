"""
Bug A: delete-object chỉ được xóa ảnh KHỚP xref yêu cầu, KHÔNG xóa mù mọi ảnh.

Bug cũ: lặp mọi XObject /Image và del tất → yêu cầu xóa 1 ảnh làm mất SẠCH ảnh
trên trang (mất dữ liệu âm thầm, vẫn trả success). Test dựng trang 2 ảnh, xóa 1,
xác nhận ảnh còn lại KHÔNG bị xóa.
"""
import pikepdf
import pytest

from app.api.routes.preflight import _delete_images_by_ref, ObjectToDelete


def _make_two_image_page(path: str) -> tuple[int, int]:
    """Trang có 2 image XObject (/Im1, /Im2). Trả (objnum_im1, objnum_im2)."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))

    def _img():
        st = pikepdf.Stream(pdf, b"\xff" * 12)
        st["/Type"] = pikepdf.Name("/XObject")
        st["/Subtype"] = pikepdf.Name("/Image")
        st["/Width"] = 2
        st["/Height"] = 2
        st["/BitsPerComponent"] = 8
        st["/ColorSpace"] = pikepdf.Name("/DeviceRGB")
        return pdf.make_indirect(st)

    im1 = _img()
    im2 = _img()
    page["/Resources"] = pikepdf.Dictionary({
        "/XObject": pikepdf.Dictionary({"/Im1": im1, "/Im2": im2}),
    })
    pdf.save(path)
    pdf.close()

    # Đọc lại để lấy object number ổn định như khi endpoint list trả về.
    pdf2 = pikepdf.Pdf.open(path)
    xobjs = pdf2.pages[0]["/Resources"]["/XObject"]
    nums = {}
    for name, ref in xobjs.items():
        obj = ref
        nums[str(name)] = obj.objgen[0]
    pdf2.close()
    return nums["/Im1"], nums["/Im2"]


def test_delete_only_targeted_image(tmp_path):
    src = str(tmp_path / "two_img.pdf")
    num_im1, _num_im2 = _make_two_image_page(src)

    pdf = pikepdf.Pdf.open(src)
    page = pdf.pages[0]

    # Yêu cầu xóa CHỈ ảnh Im1 (theo object number).
    removed = _delete_images_by_ref(page, [ObjectToDelete(type="image", bbox=[0, 0, 1, 1], xref=num_im1)])
    assert removed == 1, "phải xóa đúng 1 ảnh"

    xobjs = page["/Resources"]["/XObject"]
    remaining = {str(n) for n in xobjs.keys()}
    assert "/Im2" in remaining, "ảnh KHÔNG được yêu cầu xóa phải còn lại (chống mất dữ liệu)"
    assert "/Im1" not in remaining, "ảnh được yêu cầu xóa phải bị gỡ"
    pdf.close()


def test_delete_no_xref_removes_nothing(tmp_path):
    """Client cũ không gửi xref → an toàn: không xóa gì (thà không xóa còn hơn xóa nhầm)."""
    src = str(tmp_path / "two_img.pdf")
    _make_two_image_page(src)

    pdf = pikepdf.Pdf.open(src)
    page = pdf.pages[0]
    removed = _delete_images_by_ref(page, [ObjectToDelete(type="image", bbox=[0, 0, 1, 1], xref=None)])
    assert removed == 0
    xobjs = page["/Resources"]["/XObject"]
    assert len({str(n) for n in xobjs.keys()}) == 2, "không có xref → giữ nguyên mọi ảnh"
    pdf.close()
