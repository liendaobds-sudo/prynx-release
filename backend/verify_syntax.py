import py_compile
import sys

files = [
    'app/core/ink_manager.py',
    'app/core/preflight_engine.py',
    'app/core/action_engine.py',
    'app/core/pdf_object_ops.py',
    'app/core/pdfx_export.py',
    'app/core/page_boxes.py',
    'app/core/separations.py',
    'app/core/softproof.py',
    'app/core/preflight_rules/structure.py',
    'app/core/preflight_rules/images.py',
    'app/core/preflight_rules/colors.py',
    'app/core/preflight_rules/fonts.py',
    'app/api/routes/preflight.py',
]

ok = 0
fail = 0
for f in files:
    try:
        py_compile.compile(f, doraise=True)
        print(f"OK  {f}")
        ok += 1
    except py_compile.PyCompileError as e:
        print(f"ERR {f}: {e}")
        fail += 1

print(f"\n{'='*50}")
print(f"Total: {ok} OK, {fail} FAILED")
