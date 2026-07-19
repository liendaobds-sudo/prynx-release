from xml.etree import ElementTree

from app.workers.cut_export.cut_model import CutModel, CutPath
from app.workers.cut_export.emitters.svg import SvgEmitter


def test_svg_emitter_escapes_untrusted_layer_metadata():
    model = CutModel(
        paths=[
            CutPath(
                points=[(0, 0), (10, 0), (10, 10)],
                tool_tag='knife\" onload=\"alert(1)',
            )
        ],
        sheet_w_mm=20,
        sheet_h_mm=20,
    )

    svg = SvgEmitter(stroke='red\" onload=\"alert(2)').emit(model).decode('utf-8')

    root = ElementTree.fromstring(svg)
    group = next(iter(root))
