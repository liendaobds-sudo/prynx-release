//! PPE Viewer GPU - Multi-Page Virtualization & Spatial Pre-Cull (Milestone G3.5)
//!
//! Bo tri trang trong khong gian 2D lien tuc va loc khong gian (Spatial Culling):
//! - Ho tro SinglePage, Continuous Vertical, TwoUp (Facing Pages), TwoUpContinuous
//! - Spatial Pre-culling: chi xu ly va render cac trang nam trong tam nhin cua Viewport (kem buffer)
//! - Toi uu hoa cho tai lieu 1000+ trang: O(log N) hoac fast scan culling, khong ton VRAM/CPU

use serde::{Deserialize, Serialize};

/// Che do bo cuc trang tren Viewport
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PageLayoutMode {
    /// Hien thi tung trang don
    SinglePage,
    /// Cuon doc lien tuc (Continuous Vertical)
    Continuous,
    /// Hai trang song song (Facing Pages / Two-Up)
    TwoUp,
    /// Hai trang song song cuon lien tuc
    TwoUpContinuous,
}

/// Hinh hoc va vi tri cua mot trang trong khong gian Scene (Point / mm)
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PageGeometry {
    pub page_index: usize,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl PageGeometry {
    pub fn intersects(&self, min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> bool {
        let page_max_x = self.x + self.width;
        let page_max_y = self.y + self.height;

        !(self.x > max_x || page_max_x < min_x || self.y > max_y || page_max_y < min_y)
    }

    pub fn contains_point(&self, px: f32, py: f32) -> bool {
        px >= self.x && px <= (self.x + self.width) && py >= self.y && py <= (self.y + self.height)
    }
}

/// Bo cuc tong the cua tai lieu da trang
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentLayout {
    pub mode: PageLayoutMode,
    pub pages: Vec<PageGeometry>,
    pub page_gap: f32,
    pub total_width: f32,
    pub total_height: f32,
}

impl DocumentLayout {
    /// Tinh toan bo cuc cho danh sach kich thuoc cac trang
    pub fn compute(
        page_sizes: &[(f32, f32)], // (width, height) cua tung trang
        mode: PageLayoutMode,
        gap: f32,
    ) -> Self {
        let mut pages = Vec::with_capacity(page_sizes.len());
        let mut max_w = 0.0f32;
        let mut current_y = 0.0f32;

        match mode {
            PageLayoutMode::SinglePage => {
                for (idx, &(w, h)) in page_sizes.iter().enumerate() {
                    pages.push(PageGeometry {
                        page_index: idx,
                        x: 0.0,
                        y: 0.0,
                        width: w,
                        height: h,
                    });
                    max_w = max_w.max(w);
                    current_y = current_y.max(h);
                }
            }
            PageLayoutMode::Continuous => {
                for (idx, &(w, h)) in page_sizes.iter().enumerate() {
                    pages.push(PageGeometry {
                        page_index: idx,
                        x: 0.0,
                        y: current_y,
                        width: w,
                        height: h,
                    });
                    max_w = max_w.max(w);
                    current_y += h + gap;
                }
                // Bo bot gap o trang cuoi cung
                if !page_sizes.is_empty() {
                    current_y -= gap;
                }
            }
            PageLayoutMode::TwoUp | PageLayoutMode::TwoUpContinuous => {
                // Trang 0 dat ben phai (bia ngoai theo tieu chuan sach/tap chi), cac trang sau di theo cap
                let mut row_max_h = 0.0f32;
                let mut current_x = 0.0f32;

                for (idx, &(w, h)) in page_sizes.iter().enumerate() {
                    if idx == 0 {
                        // Trang bia: canh giua hoac ben phai
                        pages.push(PageGeometry {
                            page_index: idx,
                            x: w + gap,
                            y: current_y,
                            width: w,
                            height: h,
                        });
                        max_w = max_w.max((w + gap) + w);
                        current_y += h + gap;
                    } else {
                        let is_left = (idx % 2) == 1;
                        if is_left {
                            current_x = 0.0;
                            row_max_h = h;
                            pages.push(PageGeometry {
                                page_index: idx,
                                x: current_x,
                                y: current_y,
                                width: w,
                                height: h,
                            });
                            current_x += w + gap;
                        } else {
                            pages.push(PageGeometry {
                                page_index: idx,
                                x: current_x,
                                y: current_y,
                                width: w,
                                height: h,
                            });
                            row_max_h = row_max_h.max(h);
                            max_w = max_w.max(current_x + w);
                            current_y += row_max_h + gap;
                        }
                    }
                }
            }
        }

        Self {
            mode,
            pages,
            page_gap: gap,
            total_width: max_w,
            total_height: current_y.max(0.0),
        }
    }

    /// Spatial Pre-Culling: Loc danh sach cac trang co kha nang nhin thay trong Viewport
    /// kem theo mot khoang margin dem (buffer) de cuon muot
    pub fn cull_visible_pages(
        &self,
        viewport_min_x: f32,
        viewport_min_y: f32,
        viewport_max_x: f32,
        viewport_max_y: f32,
        buffer_margin: f32,
    ) -> Vec<usize> {
        let min_x = viewport_min_x - buffer_margin;
        let min_y = viewport_min_y - buffer_margin;
        let max_x = viewport_max_x + buffer_margin;
        let max_y = viewport_max_y + buffer_margin;

        // Voi Continuous Vertical, vi Y tang don dieu nen co the dung binary search
        // hoac fast scan. O day scan nhe cho moi che do
        self.pages
            .iter()
            .filter(|p| p.intersects(min_x, min_y, max_x, max_y))
            .map(|p| p.page_index)
            .collect()
    }

    /// Tim trang tai toa do Scene (Hit-Testing)
    pub fn find_page_at(&self, scene_x: f32, scene_y: f32) -> Option<usize> {
        self.pages
            .iter()
            .find(|p| p.contains_point(scene_x, scene_y))
            .map(|p| p.page_index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_continuous_layout_geometry() {
        let page_sizes = vec![(595.0, 842.0), (595.0, 842.0), (595.0, 842.0)];
        let layout = DocumentLayout::compute(&page_sizes, PageLayoutMode::Continuous, 20.0);

        assert_eq!(layout.pages.len(), 3);
        assert_eq!(layout.pages[0].y, 0.0);
        assert_eq!(layout.pages[1].y, 842.0 + 20.0);
        assert_eq!(layout.pages[2].y, (842.0 + 20.0) * 2.0);

        let expected_total_h = 842.0 * 3.0 + 20.0 * 2.0;
        assert_eq!(layout.total_height, expected_total_h);
    }

    #[test]
    fn test_spatial_pre_culling_1000_pages() {
        // Gia lap tai lieu 1000 trang A4 (595 x 842 pt)
        let page_sizes: Vec<(f32, f32)> = (0..1000).map(|_| (595.0, 842.0)).collect();
        let gap = 20.0;
        let layout = DocumentLayout::compute(&page_sizes, PageLayoutMode::Continuous, gap);

        // Nguoi dung dang zoom vao trang thu 500
        let target_page_y = (842.0 + gap) * 500.0;
        let viewport_h = 1000.0;

        // Viewport dang xem tu target_page_y den target_page_y + 1000
        let visible_pages = layout.cull_visible_pages(
            0.0,
            target_page_y,
            595.0,
            target_page_y + viewport_h,
            100.0, // buffer 100pt
        );

        // Chi duoc phep chua khoang 2 den 3 trang (trang 499, 500, 501), tuyet doi khong chua 1000 trang!
        assert!(!visible_pages.is_empty());
        assert!(visible_pages.len() <= 4, "So trang culled qua nhieu: {}", visible_pages.len());
        assert!(visible_pages.contains(&500), "Phai chua trang muc tieu 500");
    }

    #[test]
    fn test_hit_testing_page_lookup() {
        let page_sizes = vec![(500.0, 500.0), (500.0, 500.0)];
        let layout = DocumentLayout::compute(&page_sizes, PageLayoutMode::Continuous, 50.0);

        // Diem tren trang 0
        assert_eq!(layout.find_page_at(250.0, 250.0), Some(0));

        // Diem nam trong khoang gap giua trang 0 va trang 1
        assert_eq!(layout.find_page_at(250.0, 525.0), None);

        // Diem tren trang 1
        assert_eq!(layout.find_page_at(250.0, 600.0), Some(1));
    }
}
