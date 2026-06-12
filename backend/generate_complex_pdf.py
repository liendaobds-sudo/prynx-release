import pikepdf
import app.workers.pdf_wrapper as pdf_lib
from app.workers.pdf_types import Rect, Point

def generate_complex_test_file():
    doc = pdf_lib.open()
    page = doc.new_page(width=200, height=200)
    
    # 3. A "die-cut" path (Spot Color simulation)
    # We will simulate a die cut path by drawing a shape with a specific stroke color (e.g., pure red RGB(1, 0, 0))
    shape = page.new_shape()
    shape.draw_circle(Point(100, 100), 50)
    shape.finish(color=(1, 0, 0), width=1.0, closePath=True)
    shape.commit()
    
    # Save the file
    out_path = "golden_tests/real_test_input.pdf"
    doc.save(out_path)
    print(f"Generated {out_path}")

if __name__ == "__main__":
    generate_complex_test_file()
