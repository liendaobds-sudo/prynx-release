import sys
import math
sys.path.append('d:/pdfcompare/backend')
from app.workers.nup_layout_solver import solve_optimal_layout as solve_auto
from app.workers.nup_layout_solver import _py_solve_optimal_layout as py_solve
import pdfcompare_native
rust_solve = pdfcompare_native.solve_optimal_layout

scenarios = [
    {
        "name": "L-Shape User Scenario (Card 16 items)",
        "usable_w": 779.52875, "usable_h": 1128.190699,
        "orig_w": 260.7919, "orig_h": 158.7417,
        "gap_x": 5.6693, "gap_y": 5.6693,
        "strategy": "optimal_auto",
        "secondary_gap": 34.0158
    },
    {
        "name": "Standard Grid (No Secondary Gap)",
        "usable_w": 1000.0, "usable_h": 1000.0,
        "orig_w": 200.0, "orig_h": 300.0,
        "gap_x": 10.0, "gap_y": 10.0,
        "strategy": "optimal_auto",
        "secondary_gap": None
    },
    {
        "name": "L-Shape with Extreme Gap",
        "usable_w": 800.0, "usable_h": 800.0,
        "orig_w": 250.0, "orig_h": 100.0,
        "gap_x": 5.0, "gap_y": 5.0,
        "strategy": "optimal_auto",
        "secondary_gap": 150.0
    },
    {
        "name": "Simple Auto (Fallback)",
        "usable_w": 800.0, "usable_h": 800.0,
        "orig_w": 250.0, "orig_h": 100.0,
        "gap_x": 5.0, "gap_y": 5.0,
        "strategy": "simple_auto",
        "secondary_gap": 10.0
    }
]

print("=== VERIFICATION PASS: RUST VS PYTHON PARITY ===")
failures = 0
for i, s in enumerate(scenarios):
    print(f"\n[{i+1}] {s['name']}")
    
    # Python run
    py_res = py_solve(s["usable_w"], s["usable_h"], s["orig_w"], s["orig_h"], s["gap_x"], s["gap_y"], s["strategy"], s["secondary_gap"])
    py_yield = py_res.get("totalItems", len(py_res.get("cells", [])))
    py_w = py_res.get("overallWidth", 0)
    py_h = py_res.get("overallHeight", 0)
    
    # Rust run
    rust_res = rust_solve(s["usable_w"], s["usable_h"], s["orig_w"], s["orig_h"], s["gap_x"], s["gap_y"], s["strategy"], s["secondary_gap"])
    rust_yield = rust_res.get("totalItems", len(rust_res.get("cells", [])))
    rust_w = rust_res.get("overallWidth", 0)
    rust_h = rust_res.get("overallHeight", 0)
    
    print(f"  PY:   Yield={py_yield}, W={py_w:.3f}, H={py_h:.3f}")
    print(f"  RUST: Yield={rust_yield}, W={rust_w:.3f}, H={rust_h:.3f}")
    
    # Assertions
    if py_yield != rust_yield:
        print(f"  FAILED: Yield mismatch! Py={py_yield} vs Rust={rust_yield}")
        failures += 1
        continue
        
    if not math.isclose(py_w, rust_w, abs_tol=0.1) or not math.isclose(py_h, rust_h, abs_tol=0.1):
        print(f"  FAILED: Dimensions mismatch!")
        failures += 1
        continue
        
    print("  PASS: 100% Parity")

print(f"\nTOTAL FAILURES: {failures}")
if failures == 0:
    print("ALL TESTS PASSED SUCCESSFULLY.")
else:
    sys.exit(1)
