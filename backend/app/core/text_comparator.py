import difflib
from dataclasses import dataclass

@dataclass
class TextDiffResult:
    is_identical: bool
    added_blocks: list[dict]
    removed_blocks: list[dict]
    changed_blocks: list[dict]

class TextComparator:
    """
    Compares text content between two PDF pages.
    Provides semantic descriptions of changes (e.g., "Changed X to Y") 
    to augment the visual pixel differences.
    """
    
    def compare_blocks(self, blocks_a: list[dict], blocks_b: list[dict]) -> TextDiffResult:
        """
        Compare two lists of text blocks extracted by pdfplumber.
        Each block is {text, x0, y0, x1, y1, fontname, size}.
        """
        # Sort blocks by Y (top-to-bottom) then X (left-to-right) to form reading order
        blocks_a.sort(key=lambda b: (round(b.get("y0", 0) / 10), b.get("x0", 0)))
        blocks_b.sort(key=lambda b: (round(b.get("y0", 0) / 10), b.get("x0", 0)))
        
        texts_a = [b.get("text", "") for b in blocks_a]
        texts_b = [b.get("text", "") for b in blocks_b]
        
        if texts_a == texts_b:
            return TextDiffResult(True, [], [], [])
            
        matcher = difflib.SequenceMatcher(None, texts_a, texts_b)
        
        added = []
        removed = []
        changed = []
        
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "replace":
                # Text was modified
                for idx_a, idx_b in zip(range(i1, i2), range(j1, j2)):
                    b_a = blocks_a[idx_a]
                    b_b = blocks_b[idx_b]
                    changed.append({
                        "original": b_a["text"],
                        "new": b_b["text"],
                        "x": min(b_a["x0"], b_b["x0"]),
                        "y": min(b_a["y0"], b_b["y0"]),
                        "width": max(b_a["x1"], b_b["x1"]) - min(b_a["x0"], b_b["x0"]),
                        "height": max(b_a["y1"], b_b["y1"]) - min(b_a["y0"], b_b["y0"])
                    })
            elif tag == "delete":
                for idx_a in range(i1, i2):
                    b_a = blocks_a[idx_a]
                    removed.append({
                        "text": b_a["text"],
                        "x": b_a["x0"],
                        "y": b_a["y0"],
                        "width": b_a["x1"] - b_a["x0"],
                        "height": b_a["y1"] - b_a["y0"]
                    })
            elif tag == "insert":
                for idx_b in range(j1, j2):
                    b_b = blocks_b[idx_b]
                    added.append({
                        "text": b_b["text"],
                        "x": b_b["x0"],
                        "y": b_b["y0"],
                        "width": b_b["x1"] - b_b["x0"],
                        "height": b_b["y1"] - b_b["y0"]
                    })
                    
        return TextDiffResult(False, added, removed, changed)
