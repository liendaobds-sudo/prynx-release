//! PPE Viewer GPU - Form & Resource Invocation Scope
//!
//! Quan ly pham vi goi tai nguyen (Form XObject, Tiling Pattern, Type3).
//! Đảm bảo cùng một resource nhưng khac CTM/GraphicsState se sinh ra InvocationKey
//! rieng biet, tranh loi va cham cache khi binh ban (step-and-repeat).

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::geom::Matrix;

/// Dinh danh duy nhat cua mot lan goi Form / Pattern / Type3.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct InvocationKey {
    pub resource_id: String,
    pub matrix_bits: [u32; 6],
    pub gstate_hash: u64,
    pub scope_depth: usize,
    pub sequence_id: u64,
}

impl InvocationKey {
    pub fn new(
        resource_id: String,
        ctm: &Matrix,
        gstate_hash: u64,
        scope_depth: usize,
        sequence_id: u64,
    ) -> Self {
        Self {
            resource_id,
            matrix_bits: [
                ctm.a.to_bits(),
                ctm.b.to_bits(),
                ctm.c.to_bits(),
                ctm.d.to_bits(),
                ctm.e.to_bits(),
                ctm.f.to_bits(),
            ],
            gstate_hash,
            scope_depth,
            sequence_id,
        }
    }
}

/// Bo theo doi ngan xep goi Form XObject.
#[derive(Debug)]
pub struct FormInvocationScopeManager {
    depth: usize,
    sequence_counter: u64,
}

impl FormInvocationScopeManager {
    pub fn new() -> Self {
        Self {
            depth: 0,
            sequence_counter: 0,
        }
    }

    pub fn current_depth(&self) -> usize {
        self.depth
    }

    /// Tao invocation key duy nhat khi gap operator `Do` tren Form XObject.
    pub fn enter_invocation(
        &mut self,
        resource_id: &str,
        ctm: &Matrix,
        alpha: f32,
        overprint: bool,
    ) -> InvocationKey {
        self.depth = self.depth.saturating_add(1);
        self.sequence_counter = self.sequence_counter.wrapping_add(1);

        let mut hasher = DefaultHasher::new();
        alpha.to_bits().hash(&mut hasher);
        overprint.hash(&mut hasher);
        let gstate_hash = hasher.finish();

        InvocationKey::new(
            resource_id.to_string(),
            ctm,
            gstate_hash,
            self.depth,
            self.sequence_counter,
        )
    }

    /// Roi khoi pham vi Form XObject hien tai.
    pub fn exit_invocation(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }
}
