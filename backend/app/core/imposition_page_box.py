'''Choose the page box used by booklet imposition.

Most print PDFs keep a small bleed in MediaBox, so MediaBox remains the default.
Some design/export tools, however, put multiple logical pages on a large MediaBox
and expose the real page through CropBox.  Treating that canvas as the page makes
booklet spreads many times too wide and silently crops/reorders visible artwork.
'''


def effective_imposition_box(page):
    media = page.mediabox or page.cropbox or page.trimbox or page.rect
    crop = page.cropbox
    if crop is None or media is None:
        return media

    media_w = abs(float(media.width))
    media_h = abs(float(media.height))
    crop_w = abs(float(crop.width))
    crop_h = abs(float(crop.height))
    if media_w <= 0 or media_h <= 0 or crop_w <= 0 or crop_h <= 0:
        return media

    width_ratio = crop_w / media_w
    height_ratio = crop_h / media_h
    area_ratio = (crop_w * crop_h) / (media_w * media_h)

    # Small differences are normal bleed/crop margins and must keep MediaBox.
    # A large one-axis/area difference means CropBox is the logical page itself.
    if width_ratio < 0.80 or height_ratio < 0.80 or area_ratio < 0.75:
        return crop
    return media
