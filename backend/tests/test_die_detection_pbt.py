"""
Property-based tests cho die-shape-detection-ssot (Phase 0–3).

Khóa lại các bất biến chính của lớp Detection SSOT bằng Hypothesis. Không cần
Rust (Property 12 Rust==Python thuộc Phase 4, để riêng).

Feature: die-shape-detection-ssot
"""
import math
import pytest
from hypothesis import given, settings, strategies as st

from app.workers.shape_types import (
    ShapeType, SHAPE_TYPE_NAMES, from_legacy_value, from_legacy_name, coerce_shape_type,
)
from app.workers.die_detection import (
    DetectedShape, Trim, DetectionConfig, make_custom_shape,
    to_legacy_response, from_legacy_settings, shape_to_dict, shape_from_dict,
    detect_die_shapes, _match_die_channel, MAX_TRIM_PT,
)


# ── Fakes cho doc/page (không cần file PDF / cv2 / shapely) ──────────────────
class _FakeRect:
    def __init__(self, w, h):
        self.width = w
        self.height = h


class _FakePage:
    def __init__(self, idx, boom=False, w=200.0, h=200.0):
        self.idx = idx
        self.boom = boom
        self.rotation = 0
        self.rect = _FakeRect(w, h)
        self.mediabox = _FakeRect(w, h)
        self.cropbox = None
        self.trimbox = None
        self._page = {}

    def extract_vector_paths(self):
        if self.boom:
            raise RuntimeError(f"boom page {self.idx}")
        return []  # không có đường bế → CUSTOM(custom)


class _FakeDoc:
    def __init__(self, n, boom_set=frozenset()):
        self.page_count = n
        self.boom_set = boom_set

    def __len__(self):
        return self.page_count

    def __getitem__(self, i):
        return _FakePage(i, boom=(i in self.boom_set))


# =========================================================================
# Property 1: DetectedShape luôn well-formed (R1.1, 1.3, 1.5, 1.6)
# =========================================================================
# Feature: die-shape-detection-ssot, Property 1: DetectedShape luôn well-formed
@given(
    page=st.integers(min_value=0, max_value=10_000),
    stype=st.sampled_from(list(ShapeType)),
    w=st.floats(min_value=0.001, max_value=MAX_TRIM_PT, allow_nan=False, allow_infinity=False),
    h=st.floats(min_value=0.001, max_value=MAX_TRIM_PT, allow_nan=False, allow_infinity=False),
    conf=st.floats(min_value=0.0, max_value=1.0, allow_nan=False),
)
@settings(max_examples=200)
def test_detected_shape_well_formed(page, stype, w, h, conf):
    s = DetectedShape(page=page, type=stype, props={}, trim=Trim(w, h),
                      poly=(), source="vector", confidence=conf)
    assert isinstance(s.type, ShapeType)
    assert 0.0 <= s.confidence <= 1.0
    assert 0.0 < s.trim.w <= MAX_TRIM_PT and 0.0 < s.trim.h <= MAX_TRIM_PT
    # JSON round-trip giữ nguyên type + trim
    s2 = shape_from_dict(shape_to_dict(s))
    assert s2.type is s.type and s2.trim.w == s.trim.w and s2.trim.h == s.trim.h


# confidence ngoài [0,1] hoặc trim <=0 phải bị từ chối
@given(conf=st.floats(allow_nan=False, allow_infinity=False).filter(lambda c: c < 0 or c > 1))
@settings(max_examples=50)
def test_detected_shape_rejects_bad_confidence(conf):
    with pytest.raises(ValueError):
        DetectedShape(page=0, type=ShapeType.CUSTOM, props={}, trim=Trim(10, 10),
                      poly=(), source="custom", confidence=conf)


# =========================================================================
# Property 3: Nhận diện có tính quyết định / idempotence (R3.10, 15.1)
# =========================================================================
# Feature: die-shape-detection-ssot, Property 3: Nhận diện có tính quyết định
@given(n=st.integers(min_value=1, max_value=120))
@settings(max_examples=30)
def test_detection_idempotent(n):
    doc = _FakeDoc(n)
    r1 = detect_die_shapes(doc)
    r2 = detect_die_shapes(doc)
    r3 = detect_die_shapes(doc)
    seq1 = [(s.page, s.type, s.source) for s in r1.shapes]
    seq2 = [(s.page, s.type, s.source) for s in r2.shapes]
    seq3 = [(s.page, s.type, s.source) for s in r3.shapes]
    assert seq1 == seq2 == seq3


# =========================================================================
# Property 4: Cô lập lỗi theo từng trang (R4.1, 4.3, 4.4, 5.4, 15.4)
# =========================================================================
# Feature: die-shape-detection-ssot, Property 4: Cô lập lỗi theo từng trang
@given(data=st.data(), n=st.integers(min_value=1, max_value=60))
@settings(max_examples=50)
def test_per_page_isolation(data, n):
    boom = data.draw(st.frozensets(st.integers(min_value=0, max_value=n - 1), max_size=n))
    res = detect_die_shapes(_FakeDoc(n, boom_set=boom))
    # đủ N kết quả theo thứ tự
    assert res.total_pages == n and len(res.shapes) == n
    assert [s.page for s in res.shapes] == list(range(n))
    # trang lỗi → CUSTOM(custom); failed_pages 1-based; success_pages khớp
    assert set(res.failed_pages) == {b + 1 for b in boom}
    assert res.success_pages == n - len(boom)
    for b in boom:
        assert res.shapes[b].type is ShapeType.CUSTOM
        assert res.statuses[b].ok is False
    # trang không lỗi giống hệt khi chạy file không lỗi
    clean = detect_die_shapes(_FakeDoc(n))
    for i in range(n):
        if i not in boom:
            assert res.shapes[i].type is clean.shapes[i].type


# =========================================================================
# Property 8: Xử lý đủ N trang theo đúng thứ tự, không giới hạn 30 (R5.1, 5.2, 6.4)
# =========================================================================
# Feature: die-shape-detection-ssot, Property 8: Xử lý đủ N trang theo đúng thứ tự
@given(n=st.integers(min_value=1, max_value=300), bs=st.integers(min_value=10, max_value=500))
@settings(max_examples=40)
def test_full_page_coverage(n, bs):
    res = detect_die_shapes(_FakeDoc(n), DetectionConfig(batch_size=bs))
    assert res.total_pages == n
    assert [s.page for s in res.shapes] == list(range(n))  # không sót/lặp, đúng thứ tự


# =========================================================================
# Property 6: Khớp tên kênh khuôn full-name, case-insensitive, độc lập CMYK (R3.7, 3.9)
# =========================================================================
_DIE_NAMES = DetectionConfig().die_channel_names
_DIE_LOWER = frozenset(x.lower() for x in _DIE_NAMES)


# Feature: die-shape-detection-ssot, Property 6: Khớp tên kênh khuôn
@given(name=st.sampled_from(_DIE_NAMES), upper=st.booleans())
@settings(max_examples=80)
def test_channel_match_full_name_case_insensitive(name, upper):
    spot = name.upper() if upper else name.lower()
    assert _match_die_channel(spot, _DIE_LOWER) is True
    # DeviceN nối '+' chứa kênh khuôn → vẫn khớp
    assert _match_die_channel(f"Other+{spot}", _DIE_LOWER) is True


# Feature: die-shape-detection-ssot, Property 6: Khớp tên kênh khuôn
@given(name=st.sampled_from(_DIE_NAMES),
       pad=st.text(alphabet="abcXYZ", min_size=1, max_size=4))
@settings(max_examples=80)
def test_channel_no_substring_match(name, pad):
    # Chuỗi con (không khớp toàn bộ tên) KHÔNG được khớp
    assert _match_die_channel(name + pad, _DIE_LOWER) is False


def test_channel_cmyk_names_not_excluded():
    # Nếu kênh khuôn được cấu hình trùng tên CMYK thì vẫn khớp (độc lập CMYK — R3.9)
    cfg_lower = frozenset({"magenta"})
    assert _match_die_channel("Magenta", cfg_lower) is True
    # còn với danh sách khuôn mặc định, 'Cyan' không phải kênh khuôn → không khớp
    assert _match_die_channel("Cyan", _DIE_LOWER) is False


# =========================================================================
# Property 16: Ánh xạ enum cũ → enum thống nhất (R10.5)
# =========================================================================
# Feature: die-shape-detection-ssot, Property 16: Ánh xạ enum cũ → enum thống nhất
@given(member=st.sampled_from(list(ShapeType)))
@settings(max_examples=50)
def test_enum_mapping(member):
    assert from_legacy_name(member.name) is member          # theo TÊN
    assert from_legacy_value(member.value) is member         # theo NHÃN
    assert coerce_shape_type(member) is member
    assert coerce_shape_type(member.name) is member
    assert coerce_shape_type(member.value) is member


def test_enum_invalid_raises():
    with pytest.raises(ValueError):
        from_legacy_name("NOT_A_SHAPE")
    with pytest.raises(ValueError):
        from_legacy_value("Không tồn tại")


def test_enum_exactly_11():
    assert len(SHAPE_TYPE_NAMES) == 11


# =========================================================================
# Property 17: Round-trip mapping legacy ↔ DetectedShape (R14.2)
# =========================================================================
# Feature: die-shape-detection-ssot, Property 17: Round-trip mapping legacy ↔ DetectedShape
@given(
    pages=st.lists(st.integers(min_value=0, max_value=50), min_size=1, max_size=12, unique=True),
    data=st.data(),
)
@settings(max_examples=60)
def test_legacy_roundtrip(pages, data):
    shapes_by_page = {}
    dims_by_page = {}
    for p in pages:
        t = data.draw(st.sampled_from(list(ShapeType)))
        w = data.draw(st.floats(min_value=1.0, max_value=500.0, allow_nan=False))
        h = data.draw(st.floats(min_value=1.0, max_value=500.0, allow_nan=False))
        shapes_by_page[str(p)] = t.name
        dims_by_page[str(p)] = {"w": w, "h": h}
    mapped = from_legacy_settings({
        "detectedShapesByPage": shapes_by_page,
        "detectedDimensionsByPage": dims_by_page,
    })
    # không sót/thêm trang; type bảo toàn
    assert set(mapped.keys()) == set(pages)
    for p in pages:
        assert mapped[p].type.name == shapes_by_page[str(p)]


# =========================================================================
# to_legacy_response giữ contract cũ + perPage, không fail toàn cục (R14.1, R4.7)
# =========================================================================
@given(n=st.integers(min_value=1, max_value=40), data=st.data())
@settings(max_examples=40)
def test_legacy_response_shape(n, data):
    boom = data.draw(st.frozensets(st.integers(min_value=0, max_value=n - 1), max_size=n))
    res = detect_die_shapes(_FakeDoc(n, boom_set=boom))
    resp = to_legacy_response(res)
    assert set(["shapes", "dimensions", "shapeParams", "perPage", "success"]).issubset(resp.keys())
    assert resp["success"] is True                  # không fail toàn cục
    assert len(resp["shapes"]) == n == len(resp["dimensions"]) == len(resp["shapeParams"])
    assert len(resp["perPage"]) == n
