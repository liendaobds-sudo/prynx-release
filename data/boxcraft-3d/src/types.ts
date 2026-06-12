export type BoxType = 'tuck-end' | 'mailer' | 'gift-tray';

export interface BoxDimensions {
  width: number;  // W (mm)
  height: number; // H (mm)
  depth: number;  // D (mm)
  flap: number;   // Flap or tuck joint size (mm), default 30
  thickness: number; // g/m² or thickness (mm)
}

export interface PanelDesign {
  panelId: string;
  backgroundColor: string;
  text: string;
  textColor: string;
  textSize: number;
  textX: number; // Percentage center offset, e.g. 50 (middle)
  textY: number; // Percentage center offset, e.g. 50 (middle)
  textRotation: number; // Degrees (0, 90, 180, 270)
  sticker: string; // Key of built-in icons or dataURL
  stickerScale: number;
  stickerX: number;
  stickerY: number;
}

export interface BoxState {
  type: BoxType;
  dimensions: BoxDimensions;
  foldProgress: number; // 0 to 1 (0 = flat dieline, 1 = fully folded)
  designs: Record<string, PanelDesign>; // Keyed by panelId
  material: 'matte' | 'glossy' | 'kraft';
  paperWeight: number; // GSM (grams per square meter)
}

export interface PanelDefinition {
  id: string;
  label: string;
  labelVi: string;
  w: number;
  h: number;
  // Positioning variables helper for SVG and 3D placement
  x: number;
  y: number;
}
