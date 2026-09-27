//! PPE Viewer GPU - GPU Device Context & Texture Resources (Milestone G2.1)
//!
//! Khoi tao GPU Adapter, Device, Queue qua wgpu 24 (DirectX 12 / Vulkan).
//! Quan ly cap phat Intermediate Textures (Rgba16Float cho CMYK/Spot) va Target Surfaces.

use thiserror::Error;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64,Ordering};
// PERF (audit 2026-09-25 §R25.GPU.31): ID wgpu có thể trùng giữa hai Instance.
static NEXT_CONTEXT_ID:AtomicU64=AtomicU64::new(1);

#[derive(Error, Debug)]
pub enum GpuError {
    #[error("Pass GPU cần fallback PPE: {0}")]
    UnsupportedPass(String),
    #[error("Khong tim thay GPU adapter phu hop")]
    AdapterNotFound,
    #[error("Khong the yeu cau GPU device tu adapter: {0}")]
    RequestDeviceFailed(String),
    #[error("Loi doc lai buffer tu GPU: {0}")]
    ReadbackFailed(String),
}

/// Ngu canh GPU thiet bi dieu phoi pipeline render cua PPE Viewer GPU.
pub struct GpuContext {
    identity:u64,
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter_info: wgpu::AdapterInfo,
    device_error: Arc<Mutex<Option<String>>>,
    pub(crate) timing_sink: Arc<Mutex<Option<crate::timing::TimingSink>>>,
}

impl GpuContext {
    pub fn identity(&self)->u64{self.identity}
    /// Khoi tao GpuContext dong bo bang pollster block_on.
    pub fn new_sync() -> Result<Self, GpuError> {
        pollster::block_on(Self::new_async())
    }

    /// Khoi tao GpuContext bat dong bo.
    pub async fn new_async() -> Result<Self, GpuError> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::PRIMARY, // DirectX 12 & Vulkan tren Windows
            ..Default::default()
        });

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .ok_or(GpuError::AdapterNotFound)?;

        let adapter_info = adapter.get_info();

        // Kiem tra cac tinh nang bo sung cua adapter
        let supported_features = adapter.features();
        let mut required_features = wgpu::Features::empty();
        // PERF (audit 2026-09-27 §V27.B3): chỉ collector opt-in mới thêm query;
        // đường sản phẩm bình thường không chịu chi phí timestamp/readback.
        let timing=wgpu::Features::TIMESTAMP_QUERY|wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;
        if cfg!(debug_assertions) && std::env::var("PRYNX_GPU_TIMING").as_deref()==Ok("1") && supported_features.contains(timing){required_features|=timing;}

        if supported_features.contains(wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES) {
            required_features |= wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
        }

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("PPE_Viewer_GPU_Device"),
                    required_features,
                    // Dùng khả năng thật cho viewport/ảnh lớn, không chặn mọi GPU
                    // ở mặc định WebGPU 128 MiB cho một storage binding.
                    required_limits: wgpu::Limits {
                        max_storage_buffer_binding_size: adapter.limits().max_storage_buffer_binding_size,
                        max_buffer_size: adapter.limits().max_buffer_size,
                        max_texture_dimension_2d: adapter.limits().max_texture_dimension_2d,
                        ..wgpu::Limits::default()
                    },
                    memory_hints: wgpu::MemoryHints::Performance,
                },
                None,
            )
            .await
            .map_err(|e| GpuError::RequestDeviceFailed(e.to_string()))?;

        let device_error = Arc::new(Mutex::new(None));
        let error_sink = device_error.clone();
        device.on_uncaptured_error(Box::new(move |error| {
            if let Ok(mut slot) = error_sink.lock() {
                *slot = Some(error.to_string());
            }
        }));

        Ok(Self {
            identity:NEXT_CONTEXT_ID.fetch_add(1,Ordering::Relaxed),
            instance,
            adapter,
            device,
            queue,
            adapter_info,
            device_error,
            timing_sink: Arc::new(Mutex::new(None)),
        })
    }

    /// Lấy và xoá lỗi GPU chưa được consume; presenter dùng để phân biệt
    /// device-lost/validation với lỗi surface mà không làm rơi UI.
    pub fn take_device_error(&self) -> Option<String> {
        self.device_error.lock().ok().and_then(|mut value| value.take())
    }

    /// Tao intermediate texture RGBA16F dung chua du lieu muc CMYK/Spot va intermediate blending.
    pub fn create_intermediate_texture(
        &self,
        width: u32,
        height: u32,
        label: Option<&str>,
    ) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label,
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
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

    /// Tao target display texture (vd Rgba8Unorm hoac Bgra8UnormSrgb cho Swapchain/Presentation).
    pub fn create_target_texture(
        &self,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        label: Option<&str>,
    ) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label,
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })
    }

    /// Doc lai pixel tu texture ve host memory (dung cho test parity va verification).
    pub fn readback_texture_rgba8(
        &self,
        texture: &wgpu::Texture,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, GpuError> {
        let bytes_per_pixel = 4u32;
        let unaligned_bytes_per_row = width * bytes_per_pixel;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let bytes_per_row = (unaligned_bytes_per_row + align - 1) & !(align - 1);
        let buffer_size = (bytes_per_row * height) as wgpu::BufferAddress;

        let staging_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Readback_Staging_Buffer"),
            size: buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Readback_Encoder"),
            });

        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &staging_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        self.queue.submit(Some(encoder.finish()));

        let slice = staging_buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            tx.send(result).unwrap();
        });
        self.device.poll(wgpu::Maintain::Wait);

        rx.recv()
            .map_err(|e| GpuError::ReadbackFailed(e.to_string()))?
            .map_err(|e| GpuError::ReadbackFailed(e.to_string()))?;

        let mapped = slice.get_mapped_range();
        let mut tightly_packed = Vec::with_capacity((width * height * bytes_per_pixel) as usize);

        for row in 0..height {
            let start = (row * bytes_per_row) as usize;
            let end = start + unaligned_bytes_per_row as usize;
            tightly_packed.extend_from_slice(&mapped[start..end]);
        }

        drop(mapped);
        staging_buffer.unmap();

        Ok(tightly_packed)
    }
}
