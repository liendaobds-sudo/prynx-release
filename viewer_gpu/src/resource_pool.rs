//! PPE Viewer GPU - GPU Resource Pool & Texture Cache (Milestone G2.4)
//!
//! Quan ly cap phat va tai su dung Intermediate Textures (Rgba16Float)
//! theo co che Leased Resource Pool (RAII drop) nham triet tieu do tre cap phat
//! bo nho VRAM trong vong lap render 60–120 fps.

use std::collections::HashMap;
use std::ops::Deref;
use std::sync::{Arc, Mutex};

/// Thong ke hoat dong cua Resource Pool
#[derive(Debug, Clone, Copy, Default)]
pub struct PoolStats {
    pub total_allocations: usize,
    pub total_leases: usize,
    pub pool_reuses: usize,
    pub active_leases: usize,
    pub idle_textures: usize,
}

struct ResourcePoolInner {
    epoch: u64,
    free_textures: HashMap<(u32, u32), Vec<wgpu::Texture>>,
    total_allocations: usize,
    total_leases: usize,
    pool_reuses: usize,
    active_leases: usize,
}

/// Texture duoc muon tu pool, tu dong tra ve pool khi bi drop
pub struct LeasedTexture {
    pub texture: Option<wgpu::Texture>,
    pub view: wgpu::TextureView,
    pub width: u32,
    pub height: u32,
    pool: Arc<Mutex<ResourcePoolInner>>,
    epoch: u64,
}

impl Deref for LeasedTexture {
    type Target = wgpu::Texture;

    fn deref(&self) -> &Self::Target {
        self.texture.as_ref().expect("Texture da bi giai phong")
    }
}

impl Drop for LeasedTexture {
    fn drop(&mut self) {
        if let Some(tex) = self.texture.take() {
            if let Ok(mut inner) = self.pool.lock() {
                inner.active_leases = inner.active_leases.saturating_sub(1);
                if self.epoch != inner.epoch {
                    return;
                }
                inner
                    .free_textures
                    .entry((self.width, self.height))
                    .or_default()
                    .push(tex);
            }
        }
    }
}

/// Bo dem cap phat intermediate textures cho GPU pipeline
#[derive(Clone)]
pub struct GpuResourcePool {
    inner: Arc<Mutex<ResourcePoolInner>>,
}

impl Default for GpuResourcePool {
    fn default() -> Self {
        Self::new()
    }
}

impl GpuResourcePool {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ResourcePoolInner {
                epoch: 0,
                free_textures: HashMap::new(),
                total_allocations: 0,
                total_leases: 0,
                pool_reuses: 0,
                active_leases: 0,
            })),
        }
    }

    /// Muon mot intermediate texture (Rgba16Float) tu pool, hoac tao moi neu pool chua co san
    pub fn lease_intermediate(
        &self,
        device: &wgpu::Device,
        width: u32,
        height: u32,
        label: Option<&str>,
    ) -> LeasedTexture {
        let mut inner = self.inner.lock().expect("Khoa ResourcePool that bai");
        inner.total_leases += 1;
        inner.active_leases += 1;

        let key = (width.max(1), height.max(1));
        let texture = if let Some(free_list) = inner.free_textures.get_mut(&key) {
            if let Some(reused) = free_list.pop() {
                inner.pool_reuses += 1;
                reused
            } else {
                inner.total_allocations += 1;
                Self::allocate_intermediate(device, key.0, key.1, label)
            }
        } else {
            inner.total_allocations += 1;
            Self::allocate_intermediate(device, key.0, key.1, label)
        };

        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        LeasedTexture {
            texture: Some(texture),
            view,
            width: key.0,
            height: key.1,
            pool: Arc::clone(&self.inner),
            epoch: inner.epoch,
        }
    }

    fn allocate_intermediate(
        device: &wgpu::Device,
        width: u32,
        height: u32,
        label: Option<&str>,
    ) -> wgpu::Texture {
        device.create_texture(&wgpu::TextureDescriptor {
            label,
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })
    }

    /// Lay thong ke hien tai cua pool
    pub fn stats(&self) -> PoolStats {
        let inner = self.inner.lock().expect("Khoa ResourcePool that bai");
        let idle_count: usize = inner.free_textures.values().map(|v| v.len()).sum();
        PoolStats {
            total_allocations: inner.total_allocations,
            total_leases: inner.total_leases,
            pool_reuses: inner.pool_reuses,
            active_leases: inner.active_leases,
            idle_textures: idle_count,
        }
    }

    /// Xoa sach cache de giai phong bo nho VRAM
    pub fn clear(&self) {
        let mut inner = self.inner.lock().expect("Khoa ResourcePool that bai");
        // Lease còn bay của epoch cũ không được trả về cache mới sau clear/device-loss.
        inner.epoch = inner.epoch.wrapping_add(1);
        inner.free_textures.clear();
    }
}
