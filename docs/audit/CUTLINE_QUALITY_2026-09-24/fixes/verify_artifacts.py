"""Đo lại đúng corpus sau sửa; giữ nguyên mọi bằng chứng trước sửa."""
from pathlib import Path
import json
import runpy
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
AUDIT = HERE.parent
OUTPUT = ROOT / "output/pdf/Cutline-quality-fixed-2026-09-24"


def main():
    # Tái dùng đúng phép đo đã audit, chỉ đổi thư mục đích; không sửa fixture.
    script = runpy.run_path(str(AUDIT / "probe_artifacts.py"))
    function = script["main"]
    function.__globals__.update(HERE=HERE, OUTPUT=OUTPUT)
    for mode in ("original", "round"):
        for tolerance in (0, .1):
            sys.argv = ["probe", "--page", "12", "--mode", mode,
                        "--tolerance", str(tolerance)] + (["--auto"] if tolerance else [])
            function()

    verify_existing()


def verify_existing():
    sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]
    import numpy as np
    from test_cutline_cubic_simplify import _sample, _dense_distance
    comparisons = []
    for mode in ("original", "round"):
        base, target = [json.loads((HERE / (f"Binder2_p12_{mode}_s{value:.3f}" + ("_auto" if value else "") + ".json")).read_text(encoding="utf-8"))
                        for value in (0, .1)]
        to_pt = lambda ring: np.asarray(ring) * 72 / 25.4
        assert len(base["rings_mm"][0]) == len(target["rings_mm"][0])
        distances = [_dense_distance(_sample(to_pt(a)), _sample(to_pt(b)))
                     for a, b in zip(base["rings_mm"][0], target["rings_mm"][0])]
        same_artwork = base["pages"][0]["artwork_raster"] == target["pages"][0]["artwork_raster"]
        same_placement = base["pages"][0]["artwork_content_normalized_sha256"] == target["pages"][0]["artwork_content_normalized_sha256"]
        same_page = base["pages"][0]["media_box_pt"] == target["pages"][0]["media_box_pt"]
        assert same_artwork and same_placement and same_page and max(distances) <= .1
        comparisons.append(dict(mode=mode, sampled_distance_mm=distances,
                                same_artwork_pixels=same_artwork,
                                same_artwork_placement=same_placement, same_page_box=same_page,
                                before=base["pages"][0]["nodes"], after=target["pages"][0]["nodes"]))
    (HERE / "artifact_cross_check.json").write_text(json.dumps(comparisons, indent=2), encoding="utf-8")
    print(json.dumps(comparisons), flush=True)


if __name__ == "__main__":
    verify_existing() if "--verify-only" in sys.argv else main()
