/**
 * Preset Manager — Lưu/tải thiết lập bình bài
 * 
 * Lưu trữ presets dưới dạng JSON trong Tauri AppData.
 * Fallback sang localStorage nếu Tauri không khả dụng (dev mode).
 */

// ─── Preset Interface ───
export interface ImpositionPreset {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  description: string;
  
  // Chế độ bình bài
  taskMode: 'booklet' | 'nup';
  
  // Thiết lập giấy (chung)
  paper: {
    formsize: string;
    customSheetWidth: number;
    customSheetHeight: number;
    bleed: number;
    gapX: number;
    gapY: number;
    marginTop: number;
    marginBottom: number;
    marginLeft: number;
    marginRight: number;
    marginMode: 'labels_only' | 'include_marks';
    spreadDistribution?: 'clustered' | 'even';
  };
  
  // Thiết lập marks (chung)
  marks: {
    markType: 'none' | 'corners' | 'guillotine';
    markOffset?: number;
    markLength?: number;
    markThickness?: number;
    markStyle?: 'style1' | 'style2';
  };
  
  // Booklet settings (chỉ khi taskMode = 'booklet')
  booklet?: {
    signatureMode: 'continuous' | 'saddle' | 'thread' | 'cut_stacks' | 'flush_mount';
    foliosize: number;
    paperThickness: number;
    /** BOOKLET (audit 2026-07-31 §B.1): thông số In nhanh ảnh hưởng trực tiếp output. */
    gutterMargin?: number;
    blankPlacement?: 'end' | 'center';
    scaleMode: '100' | 'fit' | 'chain_nup' | 'cut_stack';
    interleave: 'normal' | 'all_fronts_first' | 'reverse_backs' | 'reverse_backs_180';
    foldPattern?: string;
    gripperMargin?: number;
  };
  
  // N-Up settings (chỉ khi taskMode = 'nup')
  nup?: {
    layoutType: 'repeat' | 'sequential' | 'cut_stacks' | 'ratio_stack' | 'mixed_guillotine';
    columns: number;
    rows: number;
    gridStrategy: 'manual' | 'simple_auto' | 'optimal_auto' | 'staggered' | 'row_alt' | 'head_to_tail';
    /** Optional để preset cũ mặc định về tắt. */
    alternateRotation?: 'none' | 'row' | 'column';
    duplexFlow: 'normal' | 'double';
    align: string;
    clusterMode: 'none' | 'row' | 'column';
    clusterCount: number;
    clusterGap: number;
    clusterGapMode: 'item' | 'mark';
    groupingStrategy?: 'maximize_area' | 'strict_ratio' | 'cluster_tile' | 'none';
    /** Tùy chọn để preset cũ vẫn nạp được và mặc định về tắt. */
    cutBorder?: {
      enabled: boolean;
      position: 'trim' | 'bleed';
      color: string;
      thickness: number;
    };
  };
}

// ─── Storage Key ───
const STORAGE_KEY = 'ps_imposition_presets';

// ─── Unique ID Generator ───
function generateId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
}

// ─── Try to use Tauri filesystem, fallback to localStorage ───
// Giữ module Tauri dưới dạng type import để dev/test vẫn nạp động như trước,
// nhưng không làm mất hợp đồng API ở biên lưu preset.
let tauriFs: typeof import('@tauri-apps/plugin-fs') | null = null;
let tauriPath: typeof import('@tauri-apps/api/path') | null = null;

async function initTauri() {
  try {
    tauriFs = await import('@tauri-apps/plugin-fs');
    tauriPath = await import('@tauri-apps/api/path');
  } catch {
    // Tauri not available (dev mode), use localStorage
  }
}

async function getPresetsDir(): Promise<string | null> {
  if (!tauriPath || !tauriFs) return null;
  try {
    const appData = await tauriPath.appDataDir();
    // PHẢI join: appDataDir() trên Windows KHÔNG có trailing slash → `${appData}presets`
    // tạo thư mục SIBLING "com.prynx.appresets" ngoài scope $APPDATA/** (bug 2026-07-08).
    const presetsDir = await tauriPath.join(appData, 'presets');
    try {
      await tauriFs.mkdir(presetsDir, { recursive: true });
    } catch { /* already exists */ }
    return presetsDir;
  } catch {
    return null;
  }
}

// ─── CRUD Operations ───

/** Load all presets */
export async function loadPresets(): Promise<ImpositionPreset[]> {
  await initTauri();
  
  // Try Tauri filesystem first. Đọc qua lệnh Rust read_dir_json (giống write_file_atomic)
  // → KHÔNG vướng scope plugin-fs. readDir của plugin-fs từng trả rỗng dù file có trên
  // đĩa → preset đã lưu không hiện lại sau khởi động (bug 2026-07-08).
  const dir = await getPresetsDir();
  if (dir && tauriFs) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const contents = await invoke<string[]>('read_dir_json', { dir });
      const presets: ImpositionPreset[] = [];
      for (const content of contents) {
        try { presets.push(JSON.parse(content)); } catch { /* skip corrupted files */ }
      }
      return presets.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    } catch (e) {
      console.warn('[preset] Không đọc được thư mục preset, fallback localStorage:', e);
    }
  }
  
  // Fallback: localStorage
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/** Save a preset */
export async function savePreset(preset: ImpositionPreset): Promise<void> {
  await initTauri();
  
  const dir = await getPresetsDir();
  if (dir && tauriFs) {
    const filePath = `${dir}/${preset.id}.json`;
    const json = JSON.stringify(preset, null, 2);
    // Ghi NGUYÊN TỬ (temp+rename) chống hỏng file preset nếu crash giữa lúc ghi đè.
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_file_atomic', { path: filePath, contents: new TextEncoder().encode(json) });
      return;
    } catch {
      // Fallback: ghi thẳng (lệnh atomic không khả dụng / path bị chặn).
      try { await tauriFs.writeTextFile(filePath, json); return; } catch { /* → localStorage */ }
    }
  }
  
  // Fallback: localStorage
  const all = await loadPresets();
  const idx = all.findIndex(p => p.id === preset.id);
  if (idx >= 0) {
    all[idx] = preset;
  } else {
    all.push(preset);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/** Delete a preset */
export async function deletePreset(id: string): Promise<void> {
  await initTauri();
  
  const dir = await getPresetsDir();
  if (dir && tauriFs) {
    try {
      await tauriFs.remove(`${dir}/${id}.json`);
      return;
    } catch { /* fallback */ }
  }
  
  // Fallback: localStorage
  const all = await loadPresets();
  const filtered = all.filter(p => p.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

/** Create a new preset from current settings */
export function createPreset(name: string, description: string, settings: Omit<ImpositionPreset, 'id' | 'name' | 'description' | 'createdAt' | 'updatedAt'>): ImpositionPreset {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    name,
    description,
    createdAt: now,
    updatedAt: now,
    ...settings,
  };
}

/** Export a preset as a downloadable JSON file */
export function exportPresetAsFile(preset: ImpositionPreset): void {
  const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `preset_${preset.name.replace(/[^a-zA-Z0-9_\u00C0-\u1EF9]/g, '_')}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Import a preset from a JSON file */
export async function importPresetFromFile(file: File): Promise<ImpositionPreset | null> {
  try {
    const text = await file.text();
    const preset = JSON.parse(text) as ImpositionPreset;
    
    // Validate basic structure
    if (!preset.name || !preset.taskMode || !preset.paper) {
      throw new Error('Invalid preset format');
    }
    
    // Assign new ID to avoid conflicts
    preset.id = generateId();
    preset.updatedAt = new Date().toISOString();
    
    await savePreset(preset);
    return preset;
  } catch {
    return null;
  }
}
