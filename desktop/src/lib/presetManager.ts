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
    scaleMode: '100' | 'fit' | 'chain_nup' | 'cut_stack';
    interleave: 'normal' | 'all_fronts_first' | 'reverse_backs' | 'reverse_backs_180';
    foldPattern?: string;
    gripperMargin?: number;
  };
  
  // N-Up settings (chỉ khi taskMode = 'nup')
  nup?: {
    layoutType: 'repeat' | 'sequential' | 'cut_stacks';
    columns: number;
    rows: number;
    gridStrategy: 'manual' | 'simple_auto' | 'optimal_auto' | 'staggered' | 'row_alt' | 'head_to_tail';
    duplexFlow: 'normal' | 'double';
    align: string;
    clusterMode: 'none' | 'row' | 'column';
    clusterCount: number;
    clusterGap: number;
    clusterGapMode: 'item' | 'mark';
  };
}

// ─── Storage Key ───
const STORAGE_KEY = 'ps_imposition_presets';

// ─── Unique ID Generator ───
function generateId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
}

// ─── Try to use Tauri filesystem, fallback to localStorage ───
let tauriFs: any = null;
let tauriPath: any = null;

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
    const presetsDir = `${appData}presets`;
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
  
  // Try Tauri filesystem first
  const dir = await getPresetsDir();
  if (dir && tauriFs) {
    try {
      const entries = await tauriFs.readDir(dir);
      const presets: ImpositionPreset[] = [];
      for (const entry of entries) {
        if (entry.name?.endsWith('.json')) {
          try {
            const content = await tauriFs.readTextFile(`${dir}/${entry.name}`);
            presets.push(JSON.parse(content));
          } catch { /* skip corrupted files */ }
        }
      }
      return presets.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    } catch {
      // Fallback to localStorage
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
