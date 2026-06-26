// ============================================================
// Barrel export — Mockup 3D Realism (Logic Layer)
//
// Điểm vào duy nhất cho lớp logic thuần `lib/mockup3d/`.
// Các module logic (panelSolid, foldCompensation, artworkMapping,
// materialLibrary, maskValidation, exportSizing, explodedView,
// dimensionFormat) sẽ được re-export tại đây khi triển khai ở các
// task tiếp theo. Hiện tại chỉ export các kiểu cục bộ.
// _Requirements: 9.2_
// ============================================================

export * from './types';
export * from './foldCompensation';
export * from './materialLibrary';
export * from './maskValidation';
export * from './panelSolid';
export * from './artworkMapping';
export * from './explodedView';
export * from './dimensionFormat';
export * from './exportSizing';
