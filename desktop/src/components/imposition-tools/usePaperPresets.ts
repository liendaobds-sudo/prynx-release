import { useState } from 'react';
import type { PaperUsage, SavedForm } from './paperUtils';

export function usePaperPresets(storageKey: string) {
    // Imposer truyền storageKey cố định theo workspace; đọc lazy để không tạo render phụ khi mount.
    const [savedForms, setSavedForms] = useState<SavedForm[]>(() => {
        try {
            const data = localStorage.getItem(storageKey);
            return data ? JSON.parse(data) as SavedForm[] : [];
        } catch {
            // Preset local hỏng định dạng: giữ danh sách mặc định để dialog vẫn mở được.
            return [];
        }
    });

    const handleSavePreset = (name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh' = 'in_nhanh', gripperMargin: number = 0, usages: PaperUsage[] = ['in_nhanh']) => {
        const newPreset: SavedForm = {
            id: 'custom_' + Date.now(),
            name, w, h, marginTop: mT, marginBottom: mB, marginLeft: mL, marginRight: mR, marginMode: mode, classification, usages, gripperMargin
        };
        const newList = [...savedForms, newPreset];
        setSavedForms(newList);
        localStorage.setItem(storageKey, JSON.stringify(newList));
        return newPreset.id;
    };

    const handleUpdatePreset = (id: string, name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh' = 'in_nhanh', gripperMargin: number = 0, usages: PaperUsage[] = ['in_nhanh']) => {
        const newList = savedForms.map(f => f.id === id ? { ...f, name, w, h, marginTop: mT, marginBottom: mB, marginLeft: mL, marginRight: mR, marginMode: mode, classification, usages, gripperMargin } : f);
        setSavedForms(newList);
        localStorage.setItem(storageKey, JSON.stringify(newList));
    };

    const handleDeletePreset = (id: string) => {
        const newList = savedForms.filter(f => f.id !== id);
        setSavedForms(newList);
        localStorage.setItem(storageKey, JSON.stringify(newList));
    };

    return { savedForms, handleSavePreset, handleUpdatePreset, handleDeletePreset };
}
