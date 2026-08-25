export interface CropMarksConfig {
    style: number; // 1 hoặc 2
    distance: number; // mm
    length: number; // mm
    thickness: number; // mm
}

export const DEFAULT_MARKS_CONFIG: CropMarksConfig = {
    style: 1,
    distance: 3.0,
    length: 5.0,
    thickness: 0.25
};
