/**
 * recipeStore — Lưu/tải/CRUD + export/import Recipe.
 *
 * Spec: .kiro/specs/recipe-record-playback (Task 3).
 * Sao mẫu `presetManager.ts`: Tauri AppData JSON (mỗi recipe 1 file), fallback
 * localStorage (dev/non-Tauri). KHÁC presetManager: gate Tauri theo
 * `window.__TAURI_INTERNALS__` để môi trường node/test bỏ qua Tauri sạch sẽ.
 */
import { type Recipe, isRecipe, deserializeRecipe, RECIPE_SCHEMA_VERSION } from './recipeTypes';

const STORAGE_KEY = 'ps_recipes';

function generateId(): string {
    return Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
}

// ─── Tauri (chỉ khi thực sự chạy trong app desktop) ───
let tauriFs: any = null;
let tauriPath: any = null;
let _tauriTried = false;

function isTauri(): boolean {
    return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
}

async function initTauri() {
    if (_tauriTried) return;
    _tauriTried = true;
    if (!isTauri()) return;
    try {
        tauriFs = await import('@tauri-apps/plugin-fs');
        tauriPath = await import('@tauri-apps/api/path');
    } catch {
        tauriFs = null;
        tauriPath = null;
    }
}

async function getRecipesDir(): Promise<string | null> {
    if (!tauriPath || !tauriFs) return null;
    try {
        const appData = await tauriPath.appDataDir();
        const dir = `${appData}recipes`;
        try { await tauriFs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
        return dir;
    } catch {
        return null;
    }
}

// ─── localStorage fallback (guard cho môi trường không có DOM) ───
function lsRead(): Recipe[] {
    if (typeof localStorage === 'undefined') return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter(isRecipe) : [];
    } catch {
        return [];
    }
}

function lsWrite(recipes: Recipe[]): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes));
}

function sortByUpdated(recipes: Recipe[]): Recipe[] {
    return [...recipes].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// ─── CRUD ───

/** Tải toàn bộ recipe (mới nhất trước). */
export async function loadRecipes(): Promise<Recipe[]> {
    await initTauri();
    const dir = await getRecipesDir();
    if (dir && tauriFs) {
        try {
            const entries = await tauriFs.readDir(dir);
            const out: Recipe[] = [];
            for (const entry of entries) {
                if (entry.name?.endsWith('.json')) {
                    try {
                        const content = await tauriFs.readTextFile(`${dir}/${entry.name}`);
                        const r = JSON.parse(content);
                        if (isRecipe(r)) out.push(r);
                    } catch { /* skip corrupted */ }
                }
            }
            return sortByUpdated(out);
        } catch { /* fallback */ }
    }
    return sortByUpdated(lsRead());
}

/** Lưu (tạo mới hoặc cập nhật) một recipe. Tự cập nhật updatedAt. */
export async function saveRecipe(recipe: Recipe): Promise<void> {
    await initTauri();
    const toSave: Recipe = { ...recipe, updatedAt: new Date().toISOString() };

    const dir = await getRecipesDir();
    if (dir && tauriFs) {
        try {
            await tauriFs.writeTextFile(`${dir}/${toSave.id}.json`, JSON.stringify(toSave, null, 2));
            return;
        } catch { /* fallback */ }
    }
    const all = lsRead();
    const idx = all.findIndex(r => r.id === toSave.id);
    if (idx >= 0) all[idx] = toSave; else all.push(toSave);
    lsWrite(all);
}

/** Xóa recipe theo id. */
export async function deleteRecipe(id: string): Promise<void> {
    await initTauri();
    const dir = await getRecipesDir();
    if (dir && tauriFs) {
        try {
            await tauriFs.remove(`${dir}/${id}.json`);
            return;
        } catch { /* fallback */ }
    }
    lsWrite(lsRead().filter(r => r.id !== id));
}

// ─── Export / Import ───

/** Export một recipe ra file .json tải về (chỉ chạy trong môi trường có DOM). */
export function exportRecipeAsFile(recipe: Recipe): void {
    if (typeof document === 'undefined') return;
    const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `recipe_${recipe.name.replace(/[^a-zA-Z0-9_\u00C0-\u1EF9]/g, '_')}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * Import recipe từ chuỗi JSON: validate, gán id mới (tránh trùng), cập nhật
 * updatedAt + schemaVersion, lưu lại, trả Recipe. THUẦN (test được, không cần File).
 * @throws nếu JSON/cấu trúc sai.
 */
export async function importRecipeFromText(text: string): Promise<Recipe> {
    const parsed = deserializeRecipe(text); // ném lỗi nếu sai cấu trúc
    const now = new Date().toISOString();
    const recipe: Recipe = {
        ...parsed,
        id: generateId(),
        updatedAt: now,
        schemaVersion: RECIPE_SCHEMA_VERSION,
    };
    await saveRecipe(recipe);
    return recipe;
}

/** Import recipe từ File (UI). Trả null nếu lỗi. */
export async function importRecipeFromFile(file: File): Promise<Recipe | null> {
    try {
        return await importRecipeFromText(await file.text());
    } catch {
        return null;
    }
}
