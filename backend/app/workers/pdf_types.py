"""
pdf_types — Lightweight geometry types for PDF operations.

Replaces pdf_wrapper's Point, Rect, Matrix classes with pure Python dataclasses.
These are used throughout the codebase for coordinate math.
"""


class Point:
    """2D point used for PDF coordinate math."""
    __slots__ = ('x', 'y')

    def __init__(self, x, y=None):
        if isinstance(x, Point):
            self.x, self.y = x.x, x.y
        elif isinstance(x, (tuple, list)):
            self.x, self.y = float(x[0]), float(x[1])
        else:
            self.x, self.y = float(x), float(y)

    def __repr__(self):
        return f"Point({self.x:.4f}, {self.y:.4f})"

    def __iter__(self):
        yield self.x
        yield self.y


class Rect:
    """Axis-aligned rectangle for PDF boxes and drawing bounds."""
    __slots__ = ('x0', 'y0', 'x1', 'y1')

    def __init__(self, x0, y0=None, x1=None, y1=None):
        if isinstance(x0, Rect):
            self.x0, self.y0, self.x1, self.y1 = x0.x0, x0.y0, x0.x1, x0.y1
        elif isinstance(x0, (tuple, list)):
            self.x0, self.y0, self.x1, self.y1 = float(x0[0]), float(x0[1]), float(x0[2]), float(x0[3])
        else:
            self.x0, self.y0, self.x1, self.y1 = float(x0), float(y0), float(x1), float(y1)

    @property
    def width(self):
        return self.x1 - self.x0

    @property
    def height(self):
        return self.y1 - self.y0

    @property
    def is_empty(self):
        return self.width <= 0 or self.height <= 0

    def intersects(self, other):
        return not (other.x0 >= self.x1 or other.x1 <= self.x0 or
                    other.y0 >= self.y1 or other.y1 <= self.y0)

    def __and__(self, other):
        """Intersection of two rects."""
        return Rect(max(self.x0, other.x0), max(self.y0, other.y0),
                     min(self.x1, other.x1), min(self.y1, other.y1))

    def __or__(self, other):
        """Union bounding box of two rects."""
        return Rect(min(self.x0, other.x0), min(self.y0, other.y0),
                     max(self.x1, other.x1), max(self.y1, other.y1))

    def __iter__(self):
        yield self.x0
        yield self.y0
        yield self.x1
        yield self.y1

    def __repr__(self):
        return f"Rect({self.x0:.2f}, {self.y0:.2f}, {self.x1:.2f}, {self.y1:.2f})"


class Matrix:
    """Minimal affine transform matrix for rendering scale."""
    __slots__ = ('a', 'b', 'c', 'd', 'e', 'f')

    def __init__(self, a=1, b=0, c=0, d=1, e=0, f=0):
        if b == 0 and c == 0 and d == 0 and e == 0 and f == 0:
            # Matrix(scale, scale) shorthand
            self.a, self.b, self.c, self.d, self.e, self.f = a, 0, 0, a, 0, 0
        else:
            self.a, self.b, self.c, self.d, self.e, self.f = a, b, c, d, e, f
