//! PPE Viewer GPU - Invalidation Manager & Revision Tracker (Milestone G1.5)
//!
//! He thong quan ly vo hieu hoa cache 4 cap (L0 - L3) theo Schema v1 (§4):
//! - L0: Camera (Zoom, Pan, DPR, Viewport resize) -> 0 byte, 0 CPU recompile
//! - L1: View State (OCG Layer, Plate visibility, Overprint preview) -> Re-build Graph, Scene bat bien
//! - L2: Resource / Profile (ICC, Spot alternate, XObject image cache) -> Invalidate resource ID
//! - L3: Document Structural Edit (Content stream, Undo/Redo) -> Recompile SceneIR trang do

use std::collections::HashSet;

/// 4 cap vo hieu hoa cache cua PPE Viewer GPU.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum InvalidationLevel {
    /// L0: Camera change (Zoom, Pan, Viewport size, DPR). Chi cap nhat ViewTransform.
    L0Camera,
    /// L1: View State change (OCG layers, plate visibility, overprint preview toggle).
    L1ViewState,
    /// L2: Resource / Profile edit (ICC profile, spot color alternate, cached image).
    L2ResourceProfile,
    /// L3: Document Structural Edit (Content stream change, page deletion, undo/redo).
    L3DocumentEdit,
}

/// Bo theo doi phien ban va quan ly invalidation cache cho mot trang PDF.
#[derive(Debug, Clone)]
pub struct SceneRevisionTracker {
    page_number: usize,
    scene_revision: u64,
    graph_revision: u64,
    compile_count: usize,
    graph_build_count: usize,
    invalidated_resources: HashSet<String>,
}

impl SceneRevisionTracker {
    pub fn new(page_number: usize) -> Self {
        Self {
            page_number,
            scene_revision: 1,
            graph_revision: 1,
            compile_count: 0,
            graph_build_count: 0,
            invalidated_resources: HashSet::new(),
        }
    }

    pub fn page_number(&self) -> usize {
        self.page_number
    }

    pub fn scene_revision(&self) -> u64 {
        self.scene_revision
    }

    pub fn graph_revision(&self) -> u64 {
        self.graph_revision
    }

    pub fn compile_count(&self) -> usize {
        self.compile_count
    }

    pub fn graph_build_count(&self) -> usize {
        self.graph_build_count
    }

    /// Ghi nhan mot lan compile SceneIR that su.
    pub fn record_compile(&mut self) {
        self.compile_count += 1;
        self.scene_revision = self.scene_revision.wrapping_add(1);
    }

    /// Ghi nhan mot lan build RenderGraph that su.
    pub fn record_graph_build(&mut self) {
        self.graph_build_count += 1;
        self.graph_revision = self.graph_revision.wrapping_add(1);
    }

    /// Yeu cau vo hieu hoa theo cap do (Invalidation Level).
    ///
    /// Tra ve true neu can compile lai SceneIR (chi o cap L3).
    pub fn invalidate(&mut self, level: InvalidationLevel) -> bool {
        match level {
            InvalidationLevel::L0Camera => {
                // BAT BIEN COT LOI: L0 khong lam tang revision, khong compile lai scene, khong ton chi phi CPU
                false
            }
            InvalidationLevel::L1ViewState => {
                // L1: SceneIR giu nguyen, chi RenderGraph can build lai de cap nhat visibility
                self.graph_revision = self.graph_revision.wrapping_add(1);
                false
            }
            InvalidationLevel::L2ResourceProfile => {
                // L2: SceneIR giu nguyen, danh dau can cap nhat resource / LUT
                self.graph_revision = self.graph_revision.wrapping_add(1);
                false
            }
            InvalidationLevel::L3DocumentEdit => {
                // L3: Toan bo SceneIR va RenderGraph can compile lai tu dau
                self.scene_revision = self.scene_revision.wrapping_add(1);
                self.graph_revision = self.graph_revision.wrapping_add(1);
                self.invalidated_resources.clear();
                true
            }
        }
    }

    /// Vo hieu hoa mot resource cu the (vd anh nhung hoac ICC profile bi sua).
    pub fn invalidate_resource(&mut self, resource_id: &str) {
        self.invalidated_resources.insert(resource_id.to_string());
        self.graph_revision = self.graph_revision.wrapping_add(1);
    }

    pub fn is_resource_invalidated(&self, resource_id: &str) -> bool {
        self.invalidated_resources.contains(resource_id)
    }

    pub fn clear_invalidated_resource(&mut self, resource_id: &str) {
        self.invalidated_resources.remove(resource_id);
    }
}
