//! Hợp đồng compile như một crate bên ngoài của PPE.

use print_engine::geom::Region;
use print_engine::ink::{InkBuffer, InkSpace};
use print_engine::raster::mask::{rect_path, FillRule, Rasterizer};

#[test]
fn external_caller_can_construct_and_fill_a_soft_mask() {
    let owner = InkBuffer::new(4, 4, InkSpace::new()).expect("buffer phải tạo được");
    let mut soft_mask = owner
        .new_soft_mask(Region::full(4, 4), 0.0)
        .expect("caller ngoài crate phải tạo được soft-mask dùng chung ngân sách");
    soft_mask.values_mut().fill(1.0);
    soft_mask.values_mut()[0] = 0.25;

    let path = rect_path(0.0, 0.0, 4.0, 4.0).expect("path phải hợp lệ");
    let mut raster = Rasterizer::new(4, 4).expect("raster phải tạo được");
    let coverage = raster
        .fill_path(&path, FillRule::NonZero, false, None, Some(&soft_mask))
        .expect("soft-mask đặc phải còn coverage");

    assert!((coverage[0] - 0.25).abs() < 1e-6);
    assert_eq!(soft_mask.region(), Region::full(4, 4));
}
