from dataclasses import dataclass, field

@dataclass
class PreflightIssue:
    """A single preflight check result."""
    rule_id: str
    severity: str           # "error" | "warning" | "info"
    page: int | None        # Page number (1-indexed), None = file-level
    object_ref: str         # e.g. "Image /Im1" or "Font /F3"
    description: str        # Vietnamese description
    auto_fixable: bool      # True if ActionEngine can fix this
    bbox: list[float] | None = None # [x0, y0, x1, y1] Bounding box if available
    bboxes: list[list[float]] | None = None # Multiple bounding boxes if applicable


@dataclass
class PreflightReport:
    """Complete preflight report for a PDF file."""
    file_name: str
    total_pages: int
    issues: list[PreflightIssue] = field(default_factory=list)
    summary: dict = field(default_factory=dict)
    color_summary: dict = field(default_factory=dict)
    font_summary: dict = field(default_factory=dict)
    image_summary: dict = field(default_factory=dict)


ALL_RULES = [
    "COLOR_RGB_DETECTED",
    "COLOR_SPOT_DETECTED",
    "FONT_NOT_EMBEDDED",
    "TRANSPARENCY_DETECTED",
    "IMAGE_LOW_RES",
    "IMAGE_HIGH_DPI",
    "BLEED_MISSING",
    "OVERPRINT_DETECTED",
    "PAGE_SIZE_MISMATCH",
    "TEXT_DETECTED",
    "IMAGE_NOT_EMBEDDED",
    "GIF_IN_PDF",
    "PROGRESSIVE_JPEG",
    "OBJECT_OFF_PAGE",
    "PDF_VERSION_MISMATCH",
]
