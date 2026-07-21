"""
Duyệt tài nguyên PDF ĐỆ QUY cho preflight.

Các rule cũ chỉ đọc ``page/Resources`` ở mức trang → BỎ SÓT nội dung nằm trong
Form XObject lồng nhau (rất phổ biến từ Illustrator/InDesign), trong appearance
stream của annotation, và font Type3. Module này gom một chỗ việc duyệt để mọi
rule (font/image/colorspace/transparency) cùng nhìn thấy đủ tài nguyên.

Nguyên tắc an toàn:
  - CHỐNG đệ quy vô hạn: theo dõi objgen đã thăm (Form XObject có thể tự tham
    chiếu vòng).
  - CHỐNG nổ số lượng: trần số node duyệt.
  - Best-effort: mọi lỗi resolve/parse đều nuốt (debug log), không làm hỏng cả
    lượt preflight.
"""
from __future__ import annotations

import logging
from typing import Iterator

import pikepdf

logger = logging.getLogger(__name__)

# Trần số node (page-resource-scope) để tránh nổ trên PDF dựng bất thường.
_MAX_NODES = 4000


def _objgen_key(obj) -> tuple | None:
    """Khoá nhận dạng object để chống thăm lặp (theo objgen nếu là indirect)."""
    try:
        og = getattr(obj, "objgen", None)
        if og and og != (0, 0):
            return tuple(og)
    except Exception:
        pass
    return None


def _resolve(obj):
    """Resolve indirect reference (best-effort)."""
    try:
        if hasattr(obj, "resolve") and callable(getattr(obj, "resolve", None)):
            return obj.resolve()
    except Exception:
        pass
    return obj


def iter_resource_dicts(page, pdf: pikepdf.Pdf) -> Iterator[pikepdf.Dictionary]:
    """Sinh ra MỌI ``/Resources`` dict liên quan tới một trang.

    Gồm: resource của trang, resource của mọi Form XObject lồng (đệ quy), và
    resource trong appearance stream (/AP) của annotation trên trang. Mỗi dict
    chỉ sinh một lần (dedupe theo objgen).
    """
    seen_res: set = set()
    visited_xobj: set = set()
    node_budget = [_MAX_NODES]
    yield_res: list = []

    def _emit_res(res) -> None:
        """Thêm resource dict vào danh sách trả về (dedupe theo objgen)."""
        if res is None:
            return
        res = _resolve(res)
        if not isinstance(res, pikepdf.Dictionary):
            return
        key = _objgen_key(res)
        if key is not None:
            if key in seen_res:
                return
            seen_res.add(key)
        yield_res.append(res)

    def _walk_xobjects(res):
        """Đệ quy vào Form XObject trong một resource dict."""
        if node_budget[0] <= 0:
            return
        try:
            xobjects = res.get("/XObject")
        except Exception:
            return
        if not xobjects:
            return
        xobjects = _resolve(xobjects)
        if not isinstance(xobjects, pikepdf.Dictionary):
            return
        try:
            items = list(xobjects.items())
        except Exception:
            return
        for _name, ref in items:
            node_budget[0] -= 1
            if node_budget[0] <= 0:
                return
            obj = _resolve(ref)
            if not isinstance(obj, (pikepdf.Stream, pikepdf.Dictionary)):
                continue
            try:
                subtype = str(obj.get("/Subtype", ""))
            except Exception:
                continue
            if subtype != "/Form":
                continue
            key = _objgen_key(obj)
            if key is not None:
                if key in visited_xobj:
                    continue
                visited_xobj.add(key)
            form_res = _resolve(obj.get("/Resources"))
            if isinstance(form_res, pikepdf.Dictionary):
                _emit_res(form_res)
                _walk_xobjects(form_res)

    # 1) Resource của trang
    try:
        page_res = _resolve(page.get("/Resources"))
    except Exception:
        page_res = None
    if isinstance(page_res, pikepdf.Dictionary):
        _emit_res(page_res)
        _walk_xobjects(page_res)

    # 2) Resource trong appearance stream của annotation
    try:
        annots = _resolve(page.get("/Annots"))
    except Exception:
        annots = None
    if isinstance(annots, pikepdf.Array):
        for a in list(annots):
            node_budget[0] -= 1
            if node_budget[0] <= 0:
                break
            a = _resolve(a)
            if not isinstance(a, pikepdf.Dictionary):
                continue
            ap = _resolve(a.get("/AP"))
            if not isinstance(ap, pikepdf.Dictionary):
                continue
            # /AP có thể là /N, /D, /R; mỗi cái là stream hoặc sub-dict theo state.
            for _apk, apv in list(ap.items()):
                apv = _resolve(apv)
                streams = []
                if isinstance(apv, pikepdf.Stream):
                    streams = [apv]
                elif isinstance(apv, pikepdf.Dictionary):
                    streams = [_resolve(v) for v in apv.values()]
                for st in streams:
                    if not isinstance(st, pikepdf.Stream):
                        continue
                    ap_res = _resolve(st.get("/Resources"))
                    if isinstance(ap_res, pikepdf.Dictionary):
                        _emit_res(ap_res)
                        _walk_xobjects(ap_res)

    for res in yield_res:
        yield res


def iter_fonts(page, pdf: pikepdf.Pdf) -> Iterator[tuple[str, pikepdf.Object]]:
    """Sinh (font_name, font_dict) từ mọi resource của trang (đệ quy XObject/AP).

    Với Type3 font, CharProcs của nó không chứa font con nên không cần đệ quy
    thêm. Type0 (composite) được trả nguyên dict Type0; caller tự descend
    DescendantFonts để đọc FontDescriptor/FontFile.
    """
    seen_fonts: set = set()
    for res in iter_resource_dicts(page, pdf):
        try:
            fonts = _resolve(res.get("/Font"))
        except Exception:
            continue
        if not isinstance(fonts, pikepdf.Dictionary):
            continue
        try:
            items = list(fonts.items())
        except Exception:
            continue
        for name, ref in items:
            obj = _resolve(ref)
            if not isinstance(obj, pikepdf.Dictionary):
                continue
            key = _objgen_key(obj)
            if key is not None:
                if key in seen_fonts:
                    continue
                seen_fonts.add(key)
            yield str(name), obj


def iter_images(page, pdf: pikepdf.Pdf) -> Iterator[tuple[str, pikepdf.Object]]:
    """Sinh (image_name, image_stream) từ mọi resource (đệ quy) + SMask.

    Gồm image XObject trong trang và trong Form XObject lồng, cùng SMask (mask
    mềm — cũng là image XObject) gắn trên mỗi image.
    """
    seen_img: set = set()

    def _emit(name, obj):
        obj = _resolve(obj)
        if not isinstance(obj, (pikepdf.Stream, pikepdf.Dictionary)):
            return
        key = _objgen_key(obj)
        if key is not None:
            if key in seen_img:
                return
            seen_img.add(key)
        yield str(name), obj
        # SMask cũng là image XObject riêng → kiểm luôn (transparency/alpha).
        try:
            smask = _resolve(obj.get("/SMask"))
        except Exception:
            smask = None
        if isinstance(smask, (pikepdf.Stream, pikepdf.Dictionary)):
            skey = _objgen_key(smask)
            if skey is None or skey not in seen_img:
                if skey is not None:
                    seen_img.add(skey)
                yield f"{name}.SMask", smask

    for res in iter_resource_dicts(page, pdf):
        try:
            xobjects = _resolve(res.get("/XObject"))
        except Exception:
            continue
        if not isinstance(xobjects, pikepdf.Dictionary):
            continue
        try:
            items = list(xobjects.items())
        except Exception:
            continue
        for name, ref in items:
            obj = _resolve(ref)
            if not isinstance(obj, (pikepdf.Stream, pikepdf.Dictionary)):
                continue
            try:
                subtype = str(obj.get("/Subtype", ""))
            except Exception:
                continue
            if subtype != "/Image":
                continue
            yield from _emit(name, obj)
