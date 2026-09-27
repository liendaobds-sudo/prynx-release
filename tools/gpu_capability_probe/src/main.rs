//! PPE Viewer GPU - GPU Capability Probe
//!
//! Cong cu tham do nang luc GPU (wgpu: D3D12, Vulkan) tren moi truong thuc te.
//! Xuat bao cao JSON ve cac adapter, limits, features va format capabilities.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ProbeReport {
    pub tool_version: String,
    pub wgpu_version: String,
    pub primary_adapter_index: Option<usize>,
    pub adapters: Vec<AdapterDetails>,
    pub verdict: ProbeVerdict,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AdapterDetails {
    pub index: usize,
    pub name: String,
    pub vendor_id: u32,
    pub vendor_hex: String,
    pub device_id: u32,
    pub device_hex: String,
    pub device_type: String,
    pub driver: String,
    pub driver_info: String,
    pub backend: String,
    pub limits: AdapterLimitsSummary,
    pub features: Vec<String>,
    pub key_formats: BTreeMap<String, FormatSupport>,
    pub device_test: DeviceTestResult,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AdapterLimitsSummary {
    pub max_texture_dimension_1d: u32,
    pub max_texture_dimension_2d: u32,
    pub max_texture_dimension_3d: u32,
    pub max_texture_array_layers: u32,
    pub max_buffer_size: u64,
    pub max_storage_buffer_binding_size: u64,
    pub max_uniform_buffer_binding_size: u64,
    pub max_compute_workgroup_storage_size: u32,
    pub max_compute_invocations_per_workgroup: u32,
    pub max_compute_workgroup_size_x: u32,
    pub max_compute_workgroup_size_y: u32,
    pub max_compute_workgroup_size_z: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FormatSupport {
    pub render_attachment: bool,
    pub texture_binding: bool,
    pub storage_binding: bool,
    pub copy_src: bool,
    pub copy_dst: bool,
    pub filterable: bool,
    pub blendable: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeviceTestResult {
    pub success: bool,
    pub error: Option<String>,
    pub test_texture_created: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProbeVerdict {
    pub meets_minimum_requirements: bool,
    pub hardware_accelerated: bool,
    pub recommended_backend: String,
    pub max_texture_dimension_2d: u32,
    pub supports_rgba16f_render: bool,
    pub supports_compute_shaders: bool,
    pub notes: Vec<String>,
}

fn check_format(adapter: &wgpu::Adapter, format: wgpu::TextureFormat) -> FormatSupport {
    let tf = adapter.get_texture_format_features(format);
    FormatSupport {
        render_attachment: tf.allowed_usages.contains(wgpu::TextureUsages::RENDER_ATTACHMENT),
        texture_binding: tf.allowed_usages.contains(wgpu::TextureUsages::TEXTURE_BINDING),
        storage_binding: tf.allowed_usages.contains(wgpu::TextureUsages::STORAGE_BINDING),
        copy_src: tf.allowed_usages.contains(wgpu::TextureUsages::COPY_SRC),
        copy_dst: tf.allowed_usages.contains(wgpu::TextureUsages::COPY_DST),
        filterable: tf.flags.contains(wgpu::TextureFormatFeatureFlags::FILTERABLE),
        blendable: tf.flags.contains(wgpu::TextureFormatFeatureFlags::BLENDABLE),
    }
}

async fn test_device_creation(adapter: &wgpu::Adapter) -> DeviceTestResult {
    let req = adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("PPE_Probe_Device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_webgl2_defaults(),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    ).await;

    match req {
        Ok((device, _queue)) => {
            // Test creating a minimal RGBA8 texture
            let tex_desc = wgpu::TextureDescriptor {
                label: Some("PPE_Probe_Test_Texture"),
                size: wgpu::Extent3d {
                    width: 512,
                    height: 512,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            };
            let tex = device.create_texture(&tex_desc);
            let _view = tex.create_view(&wgpu::TextureViewDescriptor::default());

            DeviceTestResult {
                success: true,
                error: None,
                test_texture_created: true,
            }
        }
        Err(e) => DeviceTestResult {
            success: false,
            error: Some(format!("{}", e)),
            test_texture_created: false,
        },
    }
}

fn inspect_features(features: &wgpu::Features) -> Vec<String> {
    let mut list = Vec::new();
    let checks = [
        (wgpu::Features::TEXTURE_FORMAT_16BIT_NORM, "TEXTURE_FORMAT_16BIT_NORM"),
        (wgpu::Features::FLOAT32_FILTERABLE, "FLOAT32_FILTERABLE"),
        (wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES, "TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES"),
        (wgpu::Features::BGRA8UNORM_STORAGE, "BGRA8UNORM_STORAGE"),
        (wgpu::Features::RG11B10UFLOAT_RENDERABLE, "RG11B10UFLOAT_RENDERABLE"),
        (wgpu::Features::CLEAR_TEXTURE, "CLEAR_TEXTURE"),
        (wgpu::Features::MULTI_DRAW_INDIRECT, "MULTI_DRAW_INDIRECT"),
        (wgpu::Features::POLYGON_MODE_LINE, "POLYGON_MODE_LINE"),
        (wgpu::Features::TIMESTAMP_QUERY, "TIMESTAMP_QUERY"),
        (wgpu::Features::PIPELINE_STATISTICS_QUERY, "PIPELINE_STATISTICS_QUERY"),
    ];
    for (feat, name) in checks {
        if features.contains(feat) {
            list.push(name.to_string());
        }
    }
    list
}

fn run_probe() -> ProbeReport {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        flags: wgpu::InstanceFlags::default(),
        backend_options: wgpu::BackendOptions::default(),
    });

    let adapters = instance.enumerate_adapters(wgpu::Backends::all());

    let mut adapter_details_list = Vec::new();
    let mut primary_idx = None;

    for (idx, adapter) in adapters.into_iter().enumerate() {
        let info = adapter.get_info();
        let limits = adapter.limits();
        let features = adapter.features();

        let device_type_str = match info.device_type {
            wgpu::DeviceType::DiscreteGpu => "DiscreteGpu",
            wgpu::DeviceType::IntegratedGpu => "IntegratedGpu",
            wgpu::DeviceType::Cpu => "Cpu",
            wgpu::DeviceType::VirtualGpu => "VirtualGpu",
            wgpu::DeviceType::Other => "Other",
        };

        let backend_str = format!("{:?}", info.backend);

        let mut key_formats = BTreeMap::new();
        key_formats.insert("Rgba8Unorm".into(), check_format(&adapter, wgpu::TextureFormat::Rgba8Unorm));
        key_formats.insert("Rgba8UnormSrgb".into(), check_format(&adapter, wgpu::TextureFormat::Rgba8UnormSrgb));
        key_formats.insert("Bgra8Unorm".into(), check_format(&adapter, wgpu::TextureFormat::Bgra8Unorm));
        key_formats.insert("Bgra8UnormSrgb".into(), check_format(&adapter, wgpu::TextureFormat::Bgra8UnormSrgb));
        key_formats.insert("Rgba16Float".into(), check_format(&adapter, wgpu::TextureFormat::Rgba16Float));
        key_formats.insert("R32Float".into(), check_format(&adapter, wgpu::TextureFormat::R32Float));
        key_formats.insert("R8Unorm".into(), check_format(&adapter, wgpu::TextureFormat::R8Unorm));

        let device_test = pollster::block_on(test_device_creation(&adapter));

        let limits_summary = AdapterLimitsSummary {
            max_texture_dimension_1d: limits.max_texture_dimension_1d,
            max_texture_dimension_2d: limits.max_texture_dimension_2d,
            max_texture_dimension_3d: limits.max_texture_dimension_3d,
            max_texture_array_layers: limits.max_texture_array_layers,
            max_buffer_size: limits.max_buffer_size,
            max_storage_buffer_binding_size: limits.max_storage_buffer_binding_size as u64,
            max_uniform_buffer_binding_size: limits.max_uniform_buffer_binding_size as u64,
            max_compute_workgroup_storage_size: limits.max_compute_workgroup_storage_size,
            max_compute_invocations_per_workgroup: limits.max_compute_invocations_per_workgroup,
            max_compute_workgroup_size_x: limits.max_compute_workgroup_size_x,
            max_compute_workgroup_size_y: limits.max_compute_workgroup_size_y,
            max_compute_workgroup_size_z: limits.max_compute_workgroup_size_z,
        };

        let details = AdapterDetails {
            index: idx,
            name: info.name,
            vendor_id: info.vendor,
            vendor_hex: format!("0x{:04x}", info.vendor),
            device_id: info.device,
            device_hex: format!("0x{:04x}", info.device),
            device_type: device_type_str.to_string(),
            driver: info.driver,
            driver_info: info.driver_info,
            backend: backend_str,
            limits: limits_summary,
            features: inspect_features(&features),
            key_formats,
            device_test,
        };

        if primary_idx.is_none() && (device_type_str == "DiscreteGpu" || device_type_str == "IntegratedGpu") {
            primary_idx = Some(idx);
        }

        adapter_details_list.push(details);
    }

    if primary_idx.is_none() && !adapter_details_list.is_empty() {
        primary_idx = Some(0);
    }

    // Verdict calculation
    let mut notes = Vec::new();
    let mut meets_min = false;
    let mut hw_accel = false;
    let mut rec_backend = "None".to_string();
    let mut max_2d = 0;
    let mut rgba16f_render = false;
    let mut compute_ok = false;

    if let Some(p_idx) = primary_idx {
        if let Some(p) = adapter_details_list.get(p_idx) {
            hw_accel = p.device_type == "DiscreteGpu" || p.device_type == "IntegratedGpu";
            rec_backend = p.backend.clone();
            max_2d = p.limits.max_texture_dimension_2d;
            compute_ok = p.limits.max_compute_invocations_per_workgroup >= 256;

            if let Some(fmt) = p.key_formats.get("Rgba16Float") {
                rgba16f_render = fmt.render_attachment && fmt.texture_binding;
            }

            if hw_accel && max_2d >= 8192 && p.device_test.success {
                meets_min = true;
                notes.push(format!("Adapter '{}' ({}) dat toan bo chi tieu toi thieu cho PPE Viewer GPU.", p.name, p.backend));
            } else {
                notes.push("Adapter khong thoa man mot so chi tieu toi thieu (can max_texture_dimension_2d >= 8192 va hardware acceleration).".to_string());
            }

            if max_2d >= 16384 {
                notes.push(format!("max_texture_dimension_2d dat muc cao ({}px), ho tro render texture kich thuoc lon.", max_2d));
            }
        }
    } else {
        notes.push("Khong tim thay bat ky adapter GPU nao!".to_string());
    }

    let verdict = ProbeVerdict {
        meets_minimum_requirements: meets_min,
        hardware_accelerated: hw_accel,
        recommended_backend: rec_backend,
        max_texture_dimension_2d: max_2d,
        supports_rgba16f_render: rgba16f_render,
        supports_compute_shaders: compute_ok,
        notes,
    };

    ProbeReport {
        tool_version: env!("CARGO_PKG_VERSION").to_string(),
        wgpu_version: "24.0".to_string(),
        primary_adapter_index: primary_idx,
        adapters: adapter_details_list,
        verdict,
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let output_path = if args.len() > 1 {
        Some(args[1].clone())
    } else {
        None
    };

    let report = run_probe();

    let json_str = serde_json::to_string_pretty(&report).expect("Failed to serialize probe report to JSON");

    if let Some(ref path_str) = output_path {
        let p = Path::new(path_str);
        if let Some(parent) = p.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(p, &json_str).unwrap_or_else(|e| {
            eprintln!("Khong the ghi file ket qua tai '{}': {}", path_str, e);
            std::process::exit(1);
        });
        println!("Da ghi bao cao GPU probe tai: {}", path_str);
    } else {
        println!("{}", json_str);
    }

    if !report.verdict.meets_minimum_requirements {
        eprintln!("CANH BAO: GPU khong dat tieu chi toi thieu cho PPE Viewer GPU!");
        std::process::exit(2);
    }
}
