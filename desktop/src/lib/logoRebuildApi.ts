import {
  authenticatedFetch,
  formatApiErrorDetail,
  getApiUrl,
  prepareFileForUpload,
} from './api';

export type LogoRebuildMode = 'monochrome' | 'fixed_palette';

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface LogoRebuildSettings {
  mode: LogoRebuildMode;
  palette: string[];
  background_color?: string;
  crop?: { x: number; y: number; width: number; height: number };
  perspective_points?: NormalizedPoint[];
  smoothing: number;
  despeckle_size_px: number;
  illumination_correction: boolean;
}

export interface LogoRebuildCapabilities {
  version: string;
  modes: LogoRebuildMode[];
  supported_formats: string[];
  auto_color_enabled: false;
  preview_engine_enabled: boolean;
  engine: { engine: string; version: string; cancellable: boolean } | null;
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
  status: 'ready';
  job_id: string;
  svg: string;
  width_px: number;
  height_px: number;
  warnings: string[];
  engine: string;
  engine_version: string;
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
