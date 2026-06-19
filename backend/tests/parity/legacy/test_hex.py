from app.workers.sticker_imposer_pkg.grid_layouts import _py_calculate_staggered_hex_layout, _native

def compare():
    usable_w = 1000
    usable_h = 1000
    item_w = 100
    item_h = 100
    gap_x = 5
    gap_y = 5
    
    res_py = _py_calculate_staggered_hex_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
    res_rs = _native.sticker_staggered_hex(usable_w, usable_h, item_w, item_h, gap_x, gap_y)
    
    print("PYTHON:")
    print("Total:", res_py.get('totalItems'))
    if res_py.get('items'):
        print("First 3 items:", res_py['items'][:3])
        print("Row 1 items (indices 8,9,10):", res_py['items'][8:11])
        
    print("\nRUST:")
    print("Total:", res_rs.get('totalItems'))
    if res_rs.get('cells'):
        print("First 3 items:", res_rs['cells'][:3])
        print("Row 1 items (indices 8,9,10):", res_rs['cells'][8:11])

if __name__ == '__main__':
    compare()
