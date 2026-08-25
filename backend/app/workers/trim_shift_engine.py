"""
Trim & Shift Engine (pikepdf) — tương đương Quite Imposing "Trim and Shift".

Trên phạm vi trang chọn được (all/even/odd/range), thực hiện:
1. Trim/thêm khoảng trắng từng cạnh (top/bottom/left/right, ± mm) — bằng điều
   chỉnh MediaBox + CropBox, KHÔNG vẽ lại nội dung.
2. Shift nội dung (dx/dy cố định, mm).
3. Binding (lề trong/ngoài): dx đảo dấu theo trang lẻ/chẵn.
4. Creep / bù gáy: shift tăng dần tuyến tính theo vị trí trang trong tập.

Dùng pikepdf (C++/QPDF). Trim = chỉnh box (nhanh, giữ nguyên nội dung); shift =
prepend `q 1 0 0 1 dx dy cm` … `Q` bao toàn bộ content stream của trang.
"""

import math

import pikepdf

MM_TO_PTS = 72 / 25.4

# Box tối thiểu sau trim (tránh box đảo ngược / rỗng làm hỏng PDF).
MIN_BOX_PTS = 1.0


def _resolve_pages(apply_to: str, total: int) -> set:
    """Parse apply_to → set trang 0-based. all/even/odd/range "a-b,n" (1-based).

    Copy đồng bộ với pdf_tools_engine.resize_pages: even = trang chẵn (2,4,6 →
    index 1,3,5), odd = trang lẻ (1,3,5 → index 0,2,4). Range hỗ trợ "a-b" mở
    ("5-" = tới hết) và số lẻ "n".
    """
    if apply_to == 'all':
        return set(range(total))
    if apply_to == 'even':
        return set(range(1, total, 2))
    if apply_to == 'odd':
        return set(range(0, total, 2))
    pages = set()
    for part in apply_to.split(','):
        part = part.strip()
        if not part:
            continue
        if '-' in part:
            a, _, b = part.partition('-')
            a, b = a.strip(), b.strip()
            if a.isdigit():
                start = int(a)
                end = int(b) if b.isdigit() else total
                for p in range(start, end + 1):
                    if 1 <= p <= total:
                        pages.add(p - 1)
        elif part.isdigit():
            p = int(part)
            if 1 <= p <= total:
                pages.add(p - 1)
    return pages


def _get_box(page, key: str, fallback=None):
    """Đọc box của trang, fallback theo thứ tự cho trước rồi A4."""
    box = page.get(key)
    if box is not None:
        return [float(box[0]), float(box[1]), float(box[2]), float(box[3])]
    if fallback is not None:
        return fallback
    mb = page.get("/MediaBox")
    if mb is not None:
        return [float(mb[0]), float(mb[1]), float(mb[2]), float(mb[3])]
    return [0.0, 0.0, 595.28, 841.89]


def _norm_rotate(page) -> int:
    """Đọc /Rotate của trang, chuẩn hoá về {0,90,180,270}."""
    r = page.get("/Rotate")
    try:
        r = int(r) % 360
    except (TypeError, ValueError):
        return 0
    return r if r in (0, 90, 180, 270) else 0


def _map_trims_to_content(rotate: int, vt: float, vb: float, vl: float, vr: float):
    """Định tuyến trim theo cạnh NHÌN (top/bottom/left/right) → lượng cộng vào
    cạnh NỘI DUNG (chưa xoay). Trả (a_left, a_bottom, a_right, a_top).

    /Rotate là góc xoay THEO CHIỀU KIM ĐỒNG HỒ khi hiển thị, nên cạnh người dùng
    thấy khác cạnh trong hệ toạ độ nội dung. Ví dụ Rotate 90: cạnh trên (nhìn)
    chính là cạnh trái (nội dung).
    """
    if rotate == 90:
        return (vt, vl, vb, vr)
    if rotate == 180:
        return (vr, vt, vl, vb)
    if rotate == 270:
        return (vb, vr, vt, vl)
    return (vl, vb, vr, vt)


def _rotate_shift(rotate: int, dx: float, dy: float):
    """Chuyển vector dịch (dx,dy) từ hệ NHÌN (đã xoay) → hệ NỘI DUNG (chưa xoay),
    để `cm` translate dịch đúng hướng người dùng thấy trên trang có /Rotate."""
    if rotate == 90:
        return (-dy, dx)
    if rotate == 180:
        return (-dx, -dy)
    if rotate == 270:
        return (dy, -dx)
    return (dx, dy)


def _clamp_box(box):
    """Đảm bảo box không đảo ngược / rỗng: bề rộng & cao ≥ MIN_BOX_PTS."""
    x0, y0, x1, y1 = box
    if x1 - x0 < MIN_BOX_PTS:
        x1 = x0 + MIN_BOX_PTS
    if y1 - y0 < MIN_BOX_PTS:
        y1 = y0 + MIN_BOX_PTS
    return [x0, y0, x1, y1]


def _intersect(inner, outer):
    """Giao 2 box [x0,y0,x1,y1] (dùng để ép CropBox nằm trong MediaBox)."""
    return [
        max(inner[0], outer[0]), max(inner[1], outer[1]),
        min(inner[2], outer[2]), min(inner[3], outer[3]),
    ]


def _apply_mirror_fill(pdf, page, frame, a_l, a_b, a_r, a_t):
    """Lấp vùng lề MỚI (do thêm khoảng trắng) bằng nội dung lật gương.

    frame = box nội dung gốc [x0,y0,x1,y1]; a_l/a_b/a_r/a_t = lượng NỞ mỗi cạnh
    (chỉ cạnh > 0 mới có lề trắng cần lấp). Kỹ thuật y hệt page_boxes.add_mirror_bleed:
    snapshot BYTES nội dung gốc thành Form XObject ĐỘC LẬP (đọc bytes TRƯỚC khi ghi
    đè page.Contents → chống đệ quy vô hạn khi form dùng chung stream với trang),
    rồi vẽ bản gốc + các bản phản chiếu qua trục từng cạnh/góc.
    """
    x0, y0, x1, y1 = frame
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return

    contents_obj = page.obj.get("/Contents")
    if isinstance(contents_obj, pikepdf.Array):
        orig_bytes = b"\n".join(bytes(s.read_bytes()) for s in contents_obj)
    elif contents_obj is not None:
        orig_bytes = bytes(contents_obj.read_bytes())
    else:
        orig_bytes = b""

    try:
        res_src = page.Resources
    except Exception:
        res_src = pikepdf.Dictionary()
    orig_res = pdf.make_indirect(pikepdf.Dictionary(res_src))

    fx = pikepdf.Stream(pdf, orig_bytes)
    fx.Type = pikepdf.Name.XObject
    fx.Subtype = pikepdf.Name.Form
    fx.BBox = pikepdf.Array([x0, y0, x1, y1])
    fx.Resources = orig_res
    fx_ref = pdf.make_indirect(fx)
    page[pikepdf.Name("/Resources")] = pikepdf.Dictionary({
        "/XObject": pikepdf.Dictionary({"/Fmx": fx_ref})
    })

    def _draw(clip, matrix):
        cx, cy, cw, ch = clip
        a, bb, c, d, e, f = matrix
        return [
            "q",
            f"{cx:.4f} {cy:.4f} {cw:.4f} {ch:.4f} re W n",
            f"{a:.6f} {bb:.6f} {c:.6f} {d:.6f} {e:.4f} {f:.4f} cm",
            "/Fmx Do",
            "Q",
        ]

    ops = _draw((x0, y0, w, h), (1, 0, 0, 1, 0, 0))  # nội dung gốc
    if a_l > 0:
        ops += _draw((x0 - a_l, y0, a_l, h), (-1, 0, 0, 1, 2 * x0, 0))
    if a_r > 0:
        ops += _draw((x1, y0, a_r, h), (-1, 0, 0, 1, 2 * x1, 0))
    if a_b > 0:
        ops += _draw((x0, y0 - a_b, w, a_b), (1, 0, 0, -1, 0, 2 * y0))
    if a_t > 0:
        ops += _draw((x0, y1, w, a_t), (1, 0, 0, -1, 0, 2 * y1))
    if a_l > 0 and a_b > 0:
        ops += _draw((x0 - a_l, y0 - a_b, a_l, a_b), (-1, 0, 0, -1, 2 * x0, 2 * y0))
    if a_r > 0 and a_b > 0:
        ops += _draw((x1, y0 - a_b, a_r, a_b), (-1, 0, 0, -1, 2 * x1, 2 * y0))
    if a_l > 0 and a_t > 0:
        ops += _draw((x0 - a_l, y1, a_l, a_t), (-1, 0, 0, -1, 2 * x0, 2 * y1))
    if a_r > 0 and a_t > 0:
        ops += _draw((x1, y1, a_r, a_t), (-1, 0, 0, -1, 2 * x1, 2 * y1))

    page[pikepdf.Name("/Contents")] = pikepdf.Stream(pdf, "\n".join(ops).encode("ascii"))



def _split_user_unit(page) -> float:
    """Đọc UserUnit hợp lệ để lề nhập theo mm giữ đúng kích thước vật lý."""
    try:
        value = float(page.get("/UserUnit", 1) or 1)
    except (TypeError, ValueError, OverflowError):
        return 1.0
    return value if math.isfinite(value) and 0 < value <= 75000 else 1.0


def _normalize_split_config(config: dict) -> tuple[str, int, list[dict[str, float]]]:
    """Chuẩn hóa cấu hình tách mảnh và đổi lề mm sang đơn vị tọa độ PDF."""
    if not isinstance(config, dict) or not bool(config.get("enabled", False)):
        raise ValueError("Chế độ tách mảnh chưa được bật.")

    axis = str(config.get("axis", "vertical")).strip().lower()
    if axis not in {"vertical", "horizontal"}:
        raise ValueError("Chiều tách chỉ được là dọc hoặc ngang.")

    try:
        count = int(config.get("count", 2))
    except (TypeError, ValueError):
        raise ValueError("Số mảnh phải là 2 hoặc 3.")
    if count not in (2, 3):
        raise ValueError("Số mảnh phải là 2 hoặc 3.")

    raw_pieces = config.get("pieces", [])
    if raw_pieces is None:
        raw_pieces = []
    if not isinstance(raw_pieces, list):
        raise ValueError("Cấu hình lề từng mảnh không hợp lệ.")

    pieces: list[dict[str, float]] = []
    for index in range(count):
        raw = raw_pieces[index] if index < len(raw_pieces) else {}
        if raw is None:
            raw = {}
        if not isinstance(raw, dict):
            raise ValueError(f"Lề của mảnh {index + 1} không hợp lệ.")

        piece: dict[str, float] = {}
        for edge in ("top", "bottom", "left", "right"):
            try:
                value_mm = float(raw.get(edge, 0) or 0)
            except (TypeError, ValueError):
                raise ValueError(f"Lề {edge} của mảnh {index + 1} phải là số.")
            if not math.isfinite(value_mm) or value_mm < 0:
                raise ValueError(f"Lề {edge} của mảnh {index + 1} không được âm.")
            piece[edge] = value_mm
        pieces.append(piece)
    return axis, count, pieces


def _page_to_full_form(pdf: pikepdf.Pdf, page, box: list[float]):
    """Tạo Form XObject bao toàn bộ MediaBox, không làm mất bleed/đối tượng ngoài Crop."""
    box_keys = ("/MediaBox", "/CropBox", "/TrimBox", "/BleedBox", "/ArtBox")
    saved_direct = {
        key: page.obj.get(pikepdf.Name(key))
        for key in box_keys
    }
    try:
        # as_form_xobject() chọn box nhỏ nhất; đồng bộ tạm mọi box về MediaBox
        # để trang đã bình có dấu/bleed ngoài TrimBox vẫn nằm trong mảnh.
        full = pikepdf.Array(box)
        for key in box_keys:
            page[pikepdf.Name(key)] = full
        return page.as_form_xobject()
    finally:
        for key, value in saved_direct.items():
            name = pikepdf.Name(key)
            if value is None:
                try:
                    del page[name]
                except (KeyError, TypeError):
                    pass
            else:
                page[name] = value


def _split_pages(
    pdf: pikepdf.Pdf,
    output_path: str,
    apply_to: str,
    config: dict,
) -> str:
    """Tách các trang chọn thành mảnh mới, có nền trắng đục và lề riêng."""
    from app.core.page_boxes import _canonicalize_rotated_page_for_mirror

    axis, count, pieces = _normalize_split_config(config)
    total = len(pdf.pages)
    target = _resolve_pages(str(apply_to or "all"), total)
    if not target and str(apply_to or "all") not in {"all", "even", "odd"}:
        raise ValueError("Không có trang hợp lệ trong phạm vi tách mảnh.")

    out = pikepdf.Pdf.new()
    try:
        # Giữ profile màu/layer cấp tài liệu khi dựng PDF mới.
        for key in ("/OCProperties", "/OutputIntents"):
            value = pdf.Root.get(key)
            if value is not None:
                try:
                    out.Root[pikepdf.Name(key)] = out.copy_foreign(value)
                except Exception:
                    pass

        for index in range(total):
            source_page = pdf.pages[index]
            if index not in target:
                out.pages.append(source_page)
                continue

            # Chuẩn hóa hướng nhìn trước khi tính đường cắt; output luôn /Rotate=0.
            _canonicalize_rotated_page_for_mirror(pdf, source_page)
            source_box = _get_box(source_page, "/MediaBox")
            sx0, sy0, sx1, sy1 = source_box
            source_w = sx1 - sx0
            source_h = sy1 - sy0
            if source_w < MIN_BOX_PTS or source_h < MIN_BOX_PTS:
                raise ValueError(f"Trang {index + 1} có khổ không hợp lệ để tách.")

            user_unit = _split_user_unit(source_page)
            form = _page_to_full_form(pdf, source_page, source_box)

            if axis == "vertical":
                piece_w = source_w / count
                piece_rects = [
                    [sx0 + piece_w * part, sy0,
                     sx0 + piece_w * (part + 1), sy1]
                    for part in range(count)
                ]
            else:
                piece_h = source_h / count
                # Thứ tự tự nhiên là trên → dưới, đúng thứ tự đọc/bình lại.
                piece_rects = [
                    [sx0, sy1 - piece_h * (part + 1),
                     sx1, sy1 - piece_h * part]
                    for part in range(count)
                ]

            for part, rect in enumerate(piece_rects):
                margin_mm = pieces[part]
                margin = {
                    edge: margin_mm[edge] * MM_TO_PTS / user_unit
                    for edge in ("top", "bottom", "left", "right")
                }
                rect_w = rect[2] - rect[0]
                rect_h = rect[3] - rect[1]
                page_w = rect_w + margin["left"] + margin["right"]
                page_h = rect_h + margin["bottom"] + margin["top"]
                if page_w < MIN_BOX_PTS or page_h < MIN_BOX_PTS:
                    raise ValueError(f"Mảnh {part + 1} của trang {index + 1} có khổ không hợp lệ.")

                dest = out.add_blank_page(page_size=(page_w, page_h))
                full_dest_box = pikepdf.Array([0.0, 0.0, page_w, page_h])
                for key in ("/MediaBox", "/CropBox", "/TrimBox", "/BleedBox", "/ArtBox"):
                    dest[pikepdf.Name(key)] = full_dest_box
                dest[pikepdf.Name("/Rotate")] = 0
                if user_unit != 1.0:
                    dest[pikepdf.Name("/UserUnit")] = user_unit

                # Lề của mảnh phải là giấy trắng đục, không phải vùng alpha trong suốt.
                background = (
                    f"q 1 1 1 rg 0 0 {page_w:.6f} {page_h:.6f} re f Q\n"
                )
                dest.contents_add(pikepdf.Stream(out, background.encode("ascii")))
                name = dest.add_resource(form, pikepdf.Name.XObject)
                tx = margin["left"] - rect[0]
                ty = margin["bottom"] - rect[1]
                draw = (
                    f"q {margin['left']:.6f} {margin['bottom']:.6f} "
                    f"{rect_w:.6f} {rect_h:.6f} re W n "
                    f"1 0 0 1 {tx:.6f} {ty:.6f} cm {str(name)} Do Q"
                )
                dest.contents_add(pikepdf.Stream(out, draw.encode("ascii")))

        from app.workers.pdf_tools_engine import save_pdf_compat
        save_pdf_compat(pdf=out, path=output_path)
    finally:
        out.close()
    return output_path


def trim_shift(
    source_path: str,
    output_path: str,
    apply_to: str = 'all',
    trim_top_mm: float = 0.0,
    trim_bottom_mm: float = 0.0,
    trim_left_mm: float = 0.0,
    trim_right_mm: float = 0.0,
    shift_x_mm: float = 0.0,
    shift_y_mm: float = 0.0,
    binding_enabled: bool = False,
    binding_mm: float = 0.0,
    binding_inward: bool = True,
    creep_enabled: bool = False,
    creep_mm: float = 0.0,
    creep_axis: str = 'x',
    mirror_fill: bool = False,
    content_mode: str = 'original',
    keep_bleed: bool = False,
    split_config: dict | None = None,
) -> str:
    """Áp trim + shift lên các trang trong tập apply_to.

    trim_*_mm: dương = thêm khoảng trắng (nở box), âm = cắt (co box).
    shift_x/y_mm: dịch nội dung, x dương = phải, y dương = lên (theo hệ PDF).
    binding: dx bổ sung theo lề gáy — trang lẻ +bind, trang chẵn -bind (khi
        inward=True; hướng đảo khi inward=False).
    creep: shift tăng dần tuyến tính từ 0 (trang đầu trong tập) tới creep_mm
        (trang cuối trong tập), cộng vào trục creep_axis ('x' hoặc 'y').
    mirror_fill: khi thêm lề (trim dương), lấp vùng trắng mới bằng nội dung sát
        mép phản chiếu ra ngoài (mirror bleed). Chỉ áp cho trang KHÔNG xoay.
    content_mode: 'original' = giữ nguyên (nội dung ẩn ngoài CropBox cũ có thể
        lòi ra khi nới khổ); 'clip' = cắt nội dung vào vùng nhìn thấy CŨ (CropBox
        gốc), phần khổ mới để trắng. Bỏ qua clip khi mirror_fill bật (mâu thuẫn).
    keep_bleed: khi trim, dịch TrimBox/BleedBox theo cùng delta để lượng bleed
        không đổi (chỉ khi trang đã có sẵn box đó — không tạo mới).
    split_config: khi enabled, thay mỗi trang được chọn bằng 2 hoặc 3 mảnh đều
        theo trục dọc/ngang, cộng lề trắng riêng từng mảnh; các tham số trim/shift
        scalar được bỏ qua trong chế độ này.
    """
    if isinstance(split_config, dict) and bool(split_config.get("enabled", False)):
        # UIUX (audit 2026-08-24 §TRIM.F1): tách hình học và lề trắng là một
        # thao tác nguyên tử; không đi vòng qua Split PDF/Crop.
        with pikepdf.Pdf.open(source_path) as pdf:
            return _split_pages(pdf, output_path, apply_to, split_config)

    trim_top = trim_top_mm * MM_TO_PTS
    trim_bottom = trim_bottom_mm * MM_TO_PTS
    trim_left = trim_left_mm * MM_TO_PTS
    trim_right = trim_right_mm * MM_TO_PTS
    base_dx = shift_x_mm * MM_TO_PTS
    base_dy = shift_y_mm * MM_TO_PTS
    bind_pt = binding_mm * MM_TO_PTS
    creep_pt = creep_mm * MM_TO_PTS

    with pikepdf.Pdf.open(source_path) as pdf:
        total = len(pdf.pages)
        target = _resolve_pages(apply_to, total)
        if not target and str(apply_to or "all") not in {"all", "even", "odd"}:
            raise ValueError("Không có trang hợp lệ trong phạm vi Trim & Shift.")
        ordered = sorted(target)
        max_pos = max(len(ordered) - 1, 1)

        for pos, idx in enumerate(ordered):
            page = pdf.pages[idx]
            page_num = idx + 1  # 1-based
            rotate = _norm_rotate(page)
            orig_mb = _get_box(page, "/MediaBox")  # box gốc (cho mirror, trước trim)
            orig_cb = _get_box(page, "/CropBox", fallback=orig_mb)  # vùng nhìn cũ (cho clip)

            dx = base_dx
            dy = base_dy

            if binding_enabled and bind_pt:
                sign = 1.0 if (page_num % 2 == 1) else -1.0
                if not binding_inward:
                    sign = -sign
                dx += sign * bind_pt

            if creep_enabled and creep_pt:
                frac = pos / max_pos
                delta = creep_pt * frac
                if creep_axis == 'y':
                    dy += delta
                else:
                    dx += delta

            # --- Trim: chỉnh box (không phá nội dung) ---
            # Cộng/trừ delta lên box ĐANG DÙNG (giữ CropBox gốc thay vì ghi đè),
            # định tuyến theo /Rotate để cạnh trim khớp cạnh người dùng nhìn.
            if trim_top or trim_bottom or trim_left or trim_right:
                a_l, a_b, a_r, a_t = _map_trims_to_content(
                    rotate, trim_top, trim_bottom, trim_left, trim_right)
                mb = _get_box(page, "/MediaBox")
                new_mb = _clamp_box([
                    mb[0] - a_l, mb[1] - a_b, mb[2] + a_r, mb[3] + a_t,
                ])
                # CropBox: giữ box gốc + cùng delta, rồi kẹp trong MediaBox mới.
                cb = _get_box(page, "/CropBox", fallback=mb)
                new_cb = _clamp_box(_intersect([
                    cb[0] - a_l, cb[1] - a_b, cb[2] + a_r, cb[3] + a_t,
                ], new_mb))
                page[pikepdf.Name("/MediaBox")] = pikepdf.Array(new_mb)
                page[pikepdf.Name("/CropBox")] = pikepdf.Array(new_cb)

                # --- Keep bleed: dịch TrimBox/BleedBox cùng delta để lượng bleed
                # không đổi (Quite ≥4.0). Chỉ đụng box ĐÃ tồn tại, không tạo mới.
                if keep_bleed:
                    for bkey in ("/TrimBox", "/BleedBox", "/ArtBox"):
                        if page.get(bkey) is not None:
                            ob = _get_box(page, bkey)
                            nb = _clamp_box(_intersect([
                                ob[0] - a_l, ob[1] - a_b, ob[2] + a_r, ob[3] + a_t,
                            ], new_mb))
                            page[pikepdf.Name(bkey)] = pikepdf.Array(nb)

                # --- Mirror-fill: lấp lề trắng MỚI bằng nội dung lật gương ---
                # Chỉ trang không xoay (mirror theo trục thẳng sẽ sai nếu /Rotate≠0)
                # và chỉ khi có cạnh NỞ dương (a_* > 0 mới có lề trắng cần lấp).
                if mirror_fill and rotate == 0 and (a_l > 0 or a_b > 0 or a_r > 0 or a_t > 0):
                    _apply_mirror_fill(
                        pdf, page, orig_mb,
                        max(a_l, 0.0), max(a_b, 0.0), max(a_r, 0.0), max(a_t, 0.0),
                    )

            # --- Shift: prepend q cm … Q bao toàn bộ content stream ---
            # Xoay vector dịch về hệ nội dung để hướng đúng như người dùng nhìn.
            if dx or dy:
                cdx, cdy = _rotate_shift(rotate, dx, dy)
                cdx += 0.0  # chuẩn hoá -0.0 → 0.0 (tránh "-0.0000" trong stream)
                cdy += 0.0
                prefix = f"q 1 0 0 1 {cdx:.4f} {cdy:.4f} cm\n".encode('ascii')
                page.contents_add(pikepdf.Stream(pdf, prefix), prepend=True)
                page.contents_add(pikepdf.Stream(pdf, b"\nQ"), prepend=False)

            # --- Clip mode ("Improved" của Quite): cắt nội dung vào VÙNG NHÌN CŨ
            # (CropBox gốc) để nội dung ẩn ngoài đó không lòi ra khi nới khổ; phần
            # mới để trắng. Prepend SAU shift để clip bao NGOÀI CÙNG (nằm trên đầu
            # stream, ôm trọn cả lớp shift). Mâu thuẫn với mirror-fill (mirror cố ý
            # vẽ ra ngoài) → bỏ qua clip nếu đã mirror.
            if content_mode == 'clip' and not mirror_fill:
                cx0, cy0, cx1, cy1 = orig_cb
                clip = f"q {cx0:.4f} {cy0:.4f} {cx1 - cx0:.4f} {cy1 - cy0:.4f} re W n\n".encode('ascii')
                page.contents_add(pikepdf.Stream(pdf, clip), prepend=True)
                page.contents_add(pikepdf.Stream(pdf, b"\nQ"), prepend=False)

        # Lưu tương thích pdf-lib (xref cổ điển) → frontend nạp lại được sau khi
        # bù xén (tránh 'Invalid header in flate stream' ở bước resize kế tiếp).
        from app.workers.pdf_tools_engine import save_pdf_compat
        save_pdf_compat(pdf, output_path)

    return output_path
