/**
 * recipeStore — Lưu/tải/CRUD + export/import Recipe.
 *
 * Spec: .kiro/specs/recipe-record-playback (Task 3).
 * Sao mẫu `presetManager.ts`: Tauri AppData JSON (mỗi recipe 1 file), fallback
 * localStorage (dev/non-Tauri). KHÁC presetManager: gate Tauri theo
 * `window.__TAURI_INTERNALS__` để môi trường node/test bỏ qua Tauri sạch sẽ.
 */
import { type Recipe, isRecipe, deserializeRecipe, RECIPE_SCHEMA_VERSION } from './recipeTypes';
import { RECIPE_OP_META } from './recipeOps';
import { tv } from '../../i18n';

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
        // PHẢI dùng join: appDataDir() trên Windows KHÔNG có dấu phân cách cuối →
        // `${appData}recipes` tạo thư mục SIBLING "com.prynx.apprecipes" nằm NGOÀI
        // scope $APPDATA/** nên readDir bị chặn → panel trắng (bug 2026-07-08).
        const dir = await tauriPath.join(appData, 'recipes');
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
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes));
    } catch {
        // RECIPE (audit 2026-08-17 §STORE.4): quota/lỗi ghi phải nổi lên RÕ RÀNG, không
        // bị nuốt rồi gộp thành "file không hợp lệ" ở đường import.
        throw new Error(tv('Không lưu được quy trình vào bộ nhớ trình duyệt (có thể đã đầy dung lượng).'));
    }
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
            // Đọc qua lệnh Rust read_dir_json (KHÔNG vướng scope plugin-fs — giống
            // write_file_atomic ở đường ghi). Trước đây tauriFs.readDir bị chặn scope
            // trên $APPDATA nên recipe đã ghi ra đĩa nhưng panel trắng (bug 2026-07-08).
            const { invoke } = await import('@tauri-apps/api/core');
            const contents = await invoke<string[]>('read_dir_json', { dir });
            const out: Recipe[] = [];
            for (const content of contents) {
                try {
                    const r = JSON.parse(content);
                    if (isRecipe(r)) out.push(r);
                } catch { /* skip corrupted */ }
            }
            return sortByUpdated(out);
        } catch (e) {
            // read_dir_json fail → ĐỪNG nuốt im lặng: trước đây bug này khiến recipe
            // đã lưu ra đĩa nhưng panel trắng trơn.
            console.warn('[recipe] Không đọc được thư mục recipe, fallback localStorage:', e);
        }
    }
    return sortByUpdated(lsRead());
}

/** Lưu (tạo mới hoặc cập nhật) một recipe. Tự cập nhật updatedAt. */
export async function saveRecipe(recipe: Recipe): Promise<void> {
    await initTauri();
    const toSave: Recipe = { ...recipe, updatedAt: new Date().toISOString() };

    const dir = await getRecipesDir();
    if (dir && tauriFs) {
        const filePath = `${dir}/${toSave.id}.json`;
        const json = JSON.stringify(toSave, null, 2);
        // RECIPE (audit 2026-08-17 §STORE.2): trên desktop, đĩa là nguồn DUY NHẤT.
        // Ghi NGUYÊN TỬ (temp+rename). Lỗi phải NÉM ra để UI không báo "đã lưu" giả —
        // trước đây rơi âm thầm sang localStorage rồi lần load sau đọc đĩa → recipe biến
        // mất. Không còn fallback writeTextFile (cũng thiếu quyền, là code chết).
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('write_file_atomic', {
            path: filePath,
            contents: new TextEncoder().encode(json),
        });
        return;
    }
    const all = lsRead();
    const idx = all.findIndex(r => r.id === toSave.id);
    if (idx >= 0) all[idx] = toSave; else all.push(toSave);
    lsWrite(all);
}

/** Xóa recipe theo id. Fail-loud: ném lỗi nếu xóa thất bại. */
export async function deleteRecipe(id: string): Promise<void> {
    await initTauri();
    const dir = await getRecipesDir();
    if (dir && tauriFs) {
        // RECIPE (audit 2026-08-17 §STORE.1): capability không có fs:allow-remove nên
        // tauriFs.remove bị ACL chặn (im lặng). Dùng lệnh Rust scoped `delete_file_scoped`
        // — lỗi được NÉM ra để UI không báo "đã xóa" giả rồi recipe hiện lại lần refresh.
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('delete_file_scoped', { path: `${dir}/${id}.json` });
        return;
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
    // RECIPE (audit 2026-08-17 §STORE.3): KHÔNG âm thầm dán nhãn lại schema. Recipe
    // schema MỚI hơn không thể diễn giải đúng → từ chối rõ ràng thay vì hạ về v1.
    if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > RECIPE_SCHEMA_VERSION) {
        throw new Error(tv('Quy trình thuộc phiên bản mới hơn bản PrynX hiện tại nên không mở được. Hãy cập nhật phần mềm.'));
    }
    // §STORE.3: chặn thao tác không nhận diện được (fail-closed) — tránh nhập bước
    // mà phát lại sẽ không hiểu, âm thầm bỏ qua.
    const unknown = parsed.steps.find(
        (s) => !Object.prototype.hasOwnProperty.call(RECIPE_OP_META, s.opId),
    );
    if (unknown) {
        throw new Error(tv('Quy trình chứa thao tác không nhận diện được: ') + `"${unknown.opId}".`);
    }
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

/**
 * Import recipe từ File (UI). NÉM lỗi có thông điệp rõ ràng (schema mới/opId lạ/
 * quota) để UI hiển thị đúng nguyên nhân thay vì gộp thành "file không hợp lệ".
 */
export async function importRecipeFromFile(file: File): Promise<Recipe> {
    return importRecipeFromText(await file.text());
}
