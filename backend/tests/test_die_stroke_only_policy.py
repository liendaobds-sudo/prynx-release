"""C1 — stroke-only die path policy (không chọn mảng tô / fill)."""
from app.workers.die_detection import _has_fill_paint, _is_stroke_only_path, _score_die_candidate


class _FakeRect:
    def __init__(self, w=200.0, h=100.0):
        self.width = w
        self.height = h


def test_fill_only_not_stroke_only():
    assert _is_stroke_only_path({"type": "f", "fill": (1, 0, 0), "color": None}) is False
    assert _is_stroke_only_path({"type": "sf", "fill": (0, 1, 0), "color": (0, 0, 0)}) is False


def test_stroke_pure_is_stroke_only():
    assert _is_stroke_only_path({"type": "s", "fill": None, "color": (1, 0, 1)}) is True


def test_empty_fill_tuple_ok():
    assert _has_fill_paint({"fill": ()}) is False
    assert _has_fill_paint({"fill": False}) is False


def test_score_fill_path_strong_zero():
    path = {
        "type": "f",
        "fill": (1, 0, 0),
        "color": None,
        "width": 0.5,
        "items": [],
        "rect": _FakeRect(50, 50),
        "closePath": True,
        "spot_name": None,
    }
    strong, weak, _ = _score_die_candidate(path, _FakeRect(), set(), [], 0.05)
    assert strong == 0
    assert weak == 0
