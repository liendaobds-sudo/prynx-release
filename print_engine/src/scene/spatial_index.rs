//! PPE Viewer GPU - Spatial Index & Text Hit-Testing (Milestone G1.5)
//!
//! Chi muc khong gian cho phep tra cuu nhanh cac doi tuong do hoa va chu (Text Runs)
//! tren Scene Local Space cho cac tinh nang:
//! - Hit-testing diem chuot (Point Hit-Test)
//! - Vung chon chu nhat (Box Selection)
//! - Trinh trich xuat van ban theo thu tu doc (Reading Order Text Extraction)

use crate::geom::Rect;
use crate::scene::types::{SceneCommand, SceneIR, SceneTextRun};

/// Muc chi muc khong gian luu tru thong tin bounds va command_id.
#[derive(Debug, Clone)]
pub struct SpatialItem {
    pub command_id: u64,
    pub bounds: Rect,
    pub is_text: bool,
}

/// Chi muc khong gian tren Scene Local Space.
#[derive(Debug, Clone)]
pub struct SpatialIndex {
    items: Vec<SpatialItem>,
}

impl SpatialIndex {
    /// Xay dung chi muc khong gian tu SceneIR.
    pub fn build_from_scene(scene: &SceneIR) -> Self {
        let mut items = Vec::with_capacity(scene.commands.len());

        for cmd in &scene.commands {
            match cmd {
                SceneCommand::Path(p) => {
                    items.push(SpatialItem {
                        command_id: p.id,
                        bounds: p.bounds,
                        is_text: false,
                    });
                }
                SceneCommand::Text(t) => {
                    items.push(SpatialItem {
                        command_id: t.id,
                        bounds: t.bounds,
                        is_text: true,
                    });
                }
                SceneCommand::Image(img) => {
                    items.push(SpatialItem {
                        command_id: img.id,
                        bounds: img.bounds,
                        is_text: false,
                    });
                }
                SceneCommand::Shading(sh) => {
                    items.push(SpatialItem {
                        command_id: sh.id,
                        bounds: sh.bounds,
                        is_text: false,
                    });
                }
                _ => {}
            }
        }

        Self { items }
    }

    /// Hit-test tai mot diem trong Scene Local Space voi dung sai tolerance.
    ///
    /// Tra ve command_id cua doi tuong nam tren cung (duoc ve sau cung).
    pub fn hit_test_point(&self, x: f32, y: f32, tolerance: f32) -> Option<u64> {
        let test_box = Rect::new(
            x - tolerance,
            y - tolerance,
            x + tolerance,
            y + tolerance,
        );

        // Duyet nguoc tu tren xuong duoi (top-most object)
        for item in self.items.iter().rev() {
            if item.bounds.intersect(&test_box).is_some() {
                return Some(item.command_id);
            }
        }
        None
    }

    /// Tim kiem text run giao voi diem (x, y).
    pub fn hit_test_text<'a>(&self, scene: &'a SceneIR, x: f32, y: f32) -> Option<&'a SceneTextRun> {
        let test_box = Rect::new(x - 0.5, y - 0.5, x + 0.5, y + 0.5);

        for cmd in scene.commands.iter().rev() {
            if let SceneCommand::Text(t) = cmd {
                if t.bounds.intersect(&test_box).is_some() {
                    return Some(t);
                }
            }
        }
        None
    }

    /// Chon tat ca cac text runs nam trong hoac giao voi hop chu nhat (Selection Rect).
    pub fn select_text_in_rect<'a>(&self, scene: &'a SceneIR, rect: &Rect) -> Vec<&'a SceneTextRun> {
        let mut results = Vec::new();

        for cmd in &scene.commands {
            if let SceneCommand::Text(t) = cmd {
                if t.bounds.intersect(rect).is_some() {
                    results.push(t);
                }
            }
        }

        // Sap xep theo thu tu doc: tu tren xuong duoi (y giam dan trong PDF), tu trai sang phai (x tang dan)
        results.sort_by(|a, b| {
            let y_diff = (b.bounds.y1 - a.bounds.y1).abs();
            if y_diff < 5.0 {
                // Cung dong
                a.bounds.x0.partial_cmp(&b.bounds.x0).unwrap_or(std::cmp::Ordering::Equal)
            } else {
                b.bounds.y1.partial_cmp(&a.bounds.y1).unwrap_or(std::cmp::Ordering::Equal)
            }
        });

        results
    }

    /// Trich xuat toan bo chu trong Scene theo thu tu doc.
    pub fn extract_text(&self, scene: &SceneIR) -> String {
        let full_rect = scene.bounds;
        let runs = self.select_text_in_rect(scene, &full_rect);

        let mut text = String::new();
        for (i, run) in runs.iter().enumerate() {
            if i > 0 {
                text.push(' ');
            }
            text.push_str(&run.text);
        }
        text
    }
}
