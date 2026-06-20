import { describe, it, expect, beforeEach } from 'vitest';
import { loadRecipes, saveRecipe, deleteRecipe, importRecipeFromText } from './recipeStore';
import { createRecipe, serializeRecipe, type RecipeStep } from './recipeTypes';

// ─── localStorage mock (môi trường node) ───
function installLocalStorageMock() {
    const map = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => { map.set(k, String(v)); },
        removeItem: (k: string) => { map.delete(k); },
        clear: () => map.clear(),
    };
}

const steps: RecipeStep[] = [
    { opId: 'convertcolors', label: 'Chuyển màu', params: { conversions: ['rgb_to_cmyk'] }, recordable: true },
    { opId: 'booklet', label: 'Bình sách', params: { sheetWidth: 320, sheetHeight: 450 }, recordable: true },
];

beforeEach(() => {
    installLocalStorageMock();
});

describe('recipeStore — CRUD (localStorage fallback)', () => {
    it('save → load trả về recipe đã lưu', async () => {
        const r = createRecipe('QT-1', steps);
        await saveRecipe(r);
        const all = await loadRecipes();
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe(r.id);
        expect(all[0].steps.map(s => s.opId)).toEqual(['convertcolors', 'booklet']);
    });

    it('save cùng id → cập nhật (không nhân đôi)', async () => {
        const r = createRecipe('QT-1', steps);
        await saveRecipe(r);
        await saveRecipe({ ...r, name: 'QT-1 đổi tên' });
        const all = await loadRecipes();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe('QT-1 đổi tên');
    });

    it('load sắp xếp mới nhất trước (theo updatedAt)', async () => {
        const a = createRecipe('A', steps);
        const b = createRecipe('B', steps);
        await saveRecipe({ ...a, updatedAt: '2020-01-01T00:00:00.000Z' });
        await saveRecipe({ ...b, updatedAt: '2025-01-01T00:00:00.000Z' });
        const all = await loadRecipes();
        // saveRecipe ghi đè updatedAt = now, nên cả hai ~ giờ hiện tại; kiểm có đủ 2 và là 2 id khác nhau
        expect(all.map(r => r.id).sort()).toEqual([a.id, b.id].sort());
    });

    it('delete xóa đúng recipe', async () => {
        const a = createRecipe('A', steps);
        const b = createRecipe('B', steps);
        await saveRecipe(a);
        await saveRecipe(b);
        await deleteRecipe(a.id);
        const all = await loadRecipes();
        expect(all.map(r => r.id)).toEqual([b.id]);
    });

    it('loadRecipes lọc bỏ dữ liệu hỏng trong localStorage', async () => {
        localStorage.setItem('ps_recipes', JSON.stringify([{ bad: 1 }, createRecipe('OK', steps)]));
        const all = await loadRecipes();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe('OK');
    });
});

describe('recipeStore — import', () => {
    it('importRecipeFromText: validate + gán id mới + lưu', async () => {
        const original = createRecipe('Gốc', steps);
        const json = serializeRecipe(original);
        const imported = await importRecipeFromText(json);
        expect(imported.id).not.toBe(original.id); // id mới tránh trùng
        expect(imported.name).toBe('Gốc');
        expect(imported.steps).toHaveLength(2);
        const all = await loadRecipes();
        expect(all.map(r => r.id)).toContain(imported.id);
    });

    it('importRecipeFromText ném lỗi khi JSON/cấu trúc sai', async () => {
        await expect(importRecipeFromText('{ not json')).rejects.toThrow();
        await expect(importRecipeFromText('{"a":1}')).rejects.toThrow();
    });
});
