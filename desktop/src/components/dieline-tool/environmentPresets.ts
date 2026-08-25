/** Hình dạng nguồn sáng phẳng dùng để dựng môi trường studio thủ tục. */
type LightformerForm = 'circle' | 'ring' | 'rect';

interface LightformerConfig {
    form?: LightformerForm;
    intensity: number;
    color: string;
    position: [number, number, number];
    rotation?: [number, number, number];
    scale: number | [number, number];
}

export interface HdriPreset {
    id: string;
    label: string;
    file?: string;
    ambient: string;
    lightformers: LightformerConfig[];
}

/** Các preset studio dựng cục bộ, không phát sinh request mạng. */
export const HDRI_PRESETS: HdriPreset[] = [
    {
        id: 'studio-soft',
        label: 'Studio mềm',
        ambient: '#dfe6ee',
        lightformers: [
            { form: 'rect', intensity: 3.0, color: '#fff6ec', position: [0, 6, 2], rotation: [-Math.PI / 2, 0, 0], scale: [10, 10] },
            { form: 'rect', intensity: 1.2, color: '#eaf2ff', position: [0, 1, 8], rotation: [0, 0, 0], scale: [12, 6] },
            { form: 'rect', intensity: 1.0, color: '#ffffff', position: [-8, 3, -2], rotation: [0, Math.PI / 2, 0], scale: [6, 8] },
            { form: 'rect', intensity: 1.0, color: '#ffffff', position: [8, 3, -2], rotation: [0, -Math.PI / 2, 0], scale: [6, 8] },
        ],
    },
    {
        id: 'studio-contrast',
        label: 'Studio tương phản',
        ambient: '#1a1d24',
        lightformers: [
            { form: 'rect', intensity: 6.0, color: '#ffffff', position: [4, 6, 4], rotation: [-Math.PI / 3, Math.PI / 6, 0], scale: [4, 6] },
            { form: 'rect', intensity: 3.0, color: '#cfe0ff', position: [-6, 4, -4], rotation: [0, Math.PI / 2, 0], scale: [3, 8] },
            { form: 'circle', intensity: 0.6, color: '#ffffff', position: [0, 2, 7], scale: 6 },
        ],
    },
    {
        id: 'studio-cool',
        label: 'Studio trung tính lạnh',
        ambient: '#c9d6e8',
        lightformers: [
            { form: 'rect', intensity: 2.6, color: '#eef4ff', position: [0, 7, 0], rotation: [-Math.PI / 2, 0, 0], scale: [12, 12] },
            { form: 'rect', intensity: 1.4, color: '#dbe8ff', position: [-6, 3, 4], rotation: [0, Math.PI / 4, 0], scale: [6, 8] },
            { form: 'rect', intensity: 1.4, color: '#dbe8ff', position: [6, 3, 4], rotation: [0, -Math.PI / 4, 0], scale: [6, 8] },
            { form: 'ring', intensity: 0.8, color: '#ffffff', position: [0, 2, 9], scale: 5 },
        ],
    },
    {
        id: 'studio-warm',
        label: 'Studio ấm',
        ambient: '#efe0cf',
        lightformers: [
            { form: 'rect', intensity: 3.2, color: '#ffe7c4', position: [0, 6, 3], rotation: [-Math.PI / 2.5, 0, 0], scale: [10, 8] },
            { form: 'rect', intensity: 1.6, color: '#ffd9a0', position: [-7, 2, 2], rotation: [0, Math.PI / 3, 0], scale: [5, 7] },
            { form: 'circle', intensity: 1.0, color: '#fff0dc', position: [5, 3, 6], scale: 6 },
        ],
    },
    {
        id: 'product-hero',
        label: 'Product hero',
        ambient: '#d8dce4',
        lightformers: [
            { form: 'rect', intensity: 4.2, color: '#fff4e0', position: [4, 7, 5], rotation: [-Math.PI / 3, Math.PI / 8, 0], scale: [5, 7] },
            { form: 'rect', intensity: 1.1, color: '#dfe6ff', position: [-5, 3, 2], rotation: [0, Math.PI / 3, 0], scale: [6, 8] },
            { form: 'rect', intensity: 0.9, color: '#ffffff', position: [2, 2, 6], scale: [8, 5] },
            { form: 'rect', intensity: 1.4, color: '#ffe8cf', position: [-3, 4, -6], rotation: [0, Math.PI / 2, 0], scale: [4, 8] },
            { form: 'circle', intensity: 0.5, color: '#ffffff', position: [0, 1, 0], scale: 12 },
        ],
    },
    {
        id: 'product-lowkey',
        label: 'Product low-key',
        ambient: '#1a1d24',
        lightformers: [
            { form: 'rect', intensity: 5.5, color: '#ffffff', position: [3, 6, 4], rotation: [-Math.PI / 3, Math.PI / 6, 0], scale: [3, 5] },
            { form: 'rect', intensity: 2.2, color: '#8fb6ff', position: [1, -1, -5], rotation: [0, 0, 0], scale: [4, 6] },
            { form: 'circle', intensity: 0.35, color: '#bcd0ff', position: [-4, 2, 3], scale: 5 },
        ],
    },
];

const FALLBACK_PRESET: HdriPreset = HDRI_PRESETS[0];

export function getHdriPreset(id: string): HdriPreset {
    return HDRI_PRESETS.find((preset) => preset.id === id) ?? FALLBACK_PRESET;
}
