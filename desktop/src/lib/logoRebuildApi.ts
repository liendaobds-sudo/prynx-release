import {
  authenticatedFetch,
  formatApiErrorDetail,
  getApiUrl,
  prepareFileForUpload,
} from './api';

export type LogoRebuildMode = 'monochrome' | 'fixed_palette';
export type LogoCurvePreset = 'automatic' | 'faithful' | 'balanced' | 'trajectory_completion';
export type LogoRebuildEngine = 'prynx_core' | 'vtracer';

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface LogoRebuildSettings {
  mode: LogoRebuildMode;
  engine: LogoRebuildEngine;
  palette: string[];
  background_color?: string;
  curve_preset?: LogoCurvePreset;
  crop?: { x: number; y: number; width: number; height: number };
  perspective_points?: NormalizedPoint[];
  smoothing: number;
  despeckle_size_px: number;
  illumination_correction: boolean;
  physical_width_mm?: number;
  physical_height_mm?: number;
}

export interface LogoRebuildCapabilities {
  version: string;
  modes: LogoRebuildMode[];
  supported_formats: string[];
  auto_color_enabled: false;
  preview_engine_enabled: boolean;
  engine: {
    curve_presets?: LogoCurvePreset[];
    geometry_metrics_version?: number | null;
    engine: string;
    version: string;
    cancellable: boolean;
    structured_result: boolean;
    result_schema_version: number | null;
    legacy_engine: string | null;
    legacy_version: string | null;
  } | null;
  legacy_vtracer_enabled: boolean;
  limitations: string[];
}

export interface LogoPaletteSuggestion {
  color: string;
  coverage_ratio: number;
}

export interface LogoRebuildPreflight {
  status: 'ready';
  source: {
    width_px: number;
    height_px: number;
    mode: string;
    format: string;
    file_size_bytes: number;
    has_alpha: boolean;
    has_icc_profile: boolean;
    dpi: [number, number] | null;
  };
  settings: LogoRebuildSettings;
  palette_suggestions: LogoPaletteSuggestion[];
  warnings: string[];
  limitations: string[];
}

export interface LogoRebuildPreview {
  status: 'ready' | 'review' | 'rejected';
  job_id: string;
  svg: string;
  width_px: number;
  height_px: number;
  physical_width_mm: number | null;
  physical_height_mm: number | null;
  warnings: string[];
  engine: string;
  engine_version: string;
  result_schema_version: number | null;
  artifact_sha256: string | null;
  preprocess_hash: string | null;
  native_metrics: {
    layer_count: number;
    component_count: number;
    outer_count: number;
    hole_count: number;
    source_nodes: number;
    output_nodes: number;
    max_error_px: number;
    max_symmetric_distance_px?: number;
    line_segments?: number;
    cubic_segments?: number;
    circle_count?: number;
    ellipse_count?: number;
    max_smooth_tangent_jump_degrees?: number;
    artifact_max_tangent_jump_degrees?: number;
    raster_scale: number;
    iou: number;
    mae: number;
  } | null;
  complexity: {
    path_count: number;
    drawable_path_count: number;
    node_count: number;
    tiny_path_count: number;
    tiny_path_ratio: number;
    svg_bytes: number;
    removed_redundant_paths: number;
  };
  review_reasons: string[];
  review_actions: string[];
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  let detail: unknown;
  try {
    detail = (await response.json())?.detail;
  } catch {
    detail = undefined;
  }
  return new Error(formatApiErrorDetail(detail, fallback));
}

export async function getLogoRebuildCapabilities(): Promise<LogoRebuildCapabilities> {
  const response = await authenticatedFetch(`${getApiUrl()}/logo-rebuild/capabilities`);
  if (!response.ok) throw await responseError(response, 'Không đọc được khả năng vector hóa logo.');
  return response.json();
}

export async function preflightLogoRebuild(
  file: File,
  settings: LogoRebuildSettings,
  signal?: AbortSignal,
): Promise<LogoRebuildPreflight> {
  const upload = await prepareFileForUpload(file);
  const body = new FormData();
  body.append('file', upload, file.name);
  body.append('settings_json', JSON.stringify(settings));
  const response = await authenticatedFetch(getApiUrl() + '/logo-rebuild/preflight', {
    method: 'POST',
    body,
    signal,
  });
  if (!response.ok) throw await responseError(response, 'Không thể phân tích màu từ ảnh.');
  return response.json();
}

export async function createLogoRebuildPreview(
  file: File,
  settings: LogoRebuildSettings,
  jobId: string,
  signal?: AbortSignal,
): Promise<LogoRebuildPreview> {
  const upload = await prepareFileForUpload(file);
  const body = new FormData();
  body.append('file', upload, file.name);
  body.append('settings_json', JSON.stringify(settings));
  body.append('job_id', jobId);
  const response = await authenticatedFetch(`${getApiUrl()}/logo-rebuild/preview`, {
    method: 'POST',
    body,
    signal,
  });
  if (!response.ok) throw await responseError(response, 'Không thể tạo SVG preview.');
  return response.json();
}

export async function cancelLogoRebuildPreview(jobId: string): Promise<boolean> {
  const response = await authenticatedFetch(`${getApiUrl()}/logo-rebuild/jobs/${jobId}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw await responseError(response, 'Không thể hủy preview logo.');
  const payload = await response.json();
  return payload.cancelled === true;
}
