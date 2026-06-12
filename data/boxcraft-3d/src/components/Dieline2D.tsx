import React from 'react';
import { BoxState, BoxDimensions } from '../types';
import { Sparkles, Gift, Heart, Star, Smile, Leaf, Coffee, ShoppingBag, ShieldCheck, HelpCircle } from 'lucide-react';

interface Dieline2DProps {
  state: BoxState;
  selectedPanelId: string | null;
  onSelectPanel: (panelId: string) => void;
}

export const STICKER_ICONS: Record<string, React.ComponentType<any>> = {
  gift: Gift,
  heart: Heart,
  star: Star,
  smile: Smile,
  leaf: Leaf,
  coffee: Coffee,
  shopping: ShoppingBag,
  shield: ShieldCheck,
  sparkles: Sparkles,
};

export const Dieline2D: React.FC<Dieline2DProps> = ({ state, selectedPanelId, onSelectPanel }) => {
  const { type, dimensions, designs } = state;
  const { width: W, height: H, depth: D, flap: F } = dimensions;

  // Let's gather the layout of panels based on box type
  // SVG coordinates: Center of SVG is (0, 0), Y goes down (standard SVG coordinates, but we can do calculations)
  
  interface SvgPanel {
    id: string;
    label: string;
    labelVi: string;
    x: number; // Top-left X
    y: number; // Top-left Y
    w: number; // Width
    h: number; // Height
    type: 'face' | 'flap' | 'dust-flap' | 'glue-flap';
    rotation?: number; // Visual design rotation
  }

  let panels: SvgPanel[] = [];
  let viewBox = '';

  if (type === 'tuck-end') {
    // Front panel is centered at (-W/2, -H/2)
    const fx = -W / 2;
    const fy = -H / 2;

    panels = [
      { id: 'front', label: 'Front Panel', labelVi: 'Mặt Trước', x: fx, y: fy, w: W, h: H, type: 'face' },
      { id: 'right', label: 'Right Side', labelVi: 'Hông Phải', x: fx + W, y: fy, w: D, h: H, type: 'face' },
      { id: 'left', label: 'Left Side', labelVi: 'Hông Trái', x: fx - D, y: fy, w: D, h: H, type: 'face' },
      { id: 'back', label: 'Back Panel', labelVi: 'Mặt Sau', x: fx - D - W, y: fy, w: W, h: H, type: 'face' },
      { id: 'glue', label: 'Glue Joint', labelVi: 'Mép Dán', x: fx - D - W - F * 0.7, y: fy + 5, w: F * 0.7, h: H - 10, type: 'glue-flap' },
      
      // Top panels (Y decreases is UP in Cartesian, but SVG Y goes down. Let's make UP go negative in Y)
      { id: 'top', label: 'Top Lid', labelVi: 'Nắp Trên', x: fx, y: fy - D, w: W, h: D, type: 'face' },
      { id: 'topTuck', label: 'Top Tuck', labelVi: 'Tai Cài Trên', x: fx + 4, y: fy - D - F, w: W - 8, h: F, type: 'flap' },
      
      // Bottom panels (Y increases is DOWN)
      { id: 'bottom', label: 'Bottom Lid', labelVi: 'Nắp Dưới', x: fx, y: fy + H, w: W, h: D, type: 'face' },
      { id: 'bottomTuck', label: 'Bottom Tuck', labelVi: 'Tai Cài Dưới', x: fx + 4, y: fy + H + D, w: W - 8, h: F, type: 'flap' },

      // Dust Flaps (attached to left/right top and bottom)
      { id: 'leftDustTop', label: 'Top-Left Dust Flap', labelVi: 'Tai Phụ Trái Trên', x: fx - D + 3, y: fy - D * 0.8, w: D - 6, h: D * 0.8, type: 'dust-flap' },
      { id: 'rightDustTop', label: 'Top-Right Dust Flap', labelVi: 'Tai Phụ Phải Trên', x: fx + W + 3, y: fy - D * 0.8, w: D - 6, h: D * 0.8, type: 'dust-flap' },
      { id: 'leftDustBottom', label: 'Bot-Left Dust Flap', labelVi: 'Tai Phụ Trái Dưới', x: fx - D + 3, y: fy + H, w: D - 6, h: D * 0.8, type: 'dust-flap' },
      { id: 'rightDustBottom', label: 'Bot-Right Dust Flap', labelVi: 'Tai Phụ Phải Dưới', x: fx + W + 3, y: fy + H, w: D - 6, h: D * 0.8, type: 'dust-flap' },
    ];

    // Compute viewBox with safety padding
    const minX = fx - D - W - F - 30;
    const maxX = fx + W + D + 30;
    const minY = fy - D - F - 30;
    const maxY = fy + H + D + F + 30;
    viewBox = `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;

  } else if (type === 'mailer') {
    // Bottom panel is centered at (-W/2, -D/2)
    const bx = -W / 2;
    const by = -D / 2;

    panels = [
      { id: 'bottom', label: 'Bottom Panel', labelVi: 'Mặt Đáy', x: bx, y: by, w: W, h: D, type: 'face' },
      
      // Walls (attached to bottom)
      { id: 'rearWall', label: 'Rear Wall', labelVi: 'Vách Sau', x: bx, y: by - H, w: W, h: H, type: 'face' },
      { id: 'frontWall', label: 'Front Wall', labelVi: 'Vách Trước', x: bx, y: by + D, w: W, h: H, type: 'face' },
      { id: 'frontRoll', label: 'Front Roll-over', labelVi: 'Khóa Vách Trước', x: bx + 2, y: by + D + H, w: W - 4, h: H - 2, type: 'flap' },
      
      // Left and Right walls (H high, D wide)
      { id: 'leftWall', label: 'Left Outer Wall', labelVi: 'Vách Ngoài Trái', x: bx - H, y: by, w: H, h: D, type: 'face' },
      { id: 'rightWall', label: 'Right Outer Wall', labelVi: 'Vách Ngoài Phải', x: bx + W, y: by, w: H, h: D, type: 'face' },

      // Inside fold-over locks for left and right
      { id: 'leftRoll', label: 'Left Roll-over', labelVi: 'Khóa Vách Trái', x: bx - H * 2, y: by + 2, w: H - 2, h: D - 4, type: 'flap' },
      { id: 'rightRoll', label: 'Right Roll-over', labelVi: 'Khóa Vách Phải', x: bx + W + H, y: by + 2, w: H - 2, h: D - 4, type: 'flap' },

      // Top Lid and Tuck-in sides (attached to Rear wall)
      { id: 'top', label: 'Top Lid/Cover', labelVi: 'Nắp Hộp', x: bx, y: by - H - D, w: W, h: D, type: 'face' },
      { id: 'topTuck', label: 'Front Insert Flap', labelVi: 'Mép Gài Nắp', x: bx + 4, y: by - H - D - F, w: W - 8, h: F, type: 'flap' },
      
      // Top Lid Side Ears
      { id: 'topLeftEar', label: 'Top Left Ear', labelVi: 'Tai Nắp Trái', x: bx - F, y: by - H - D + 2, w: F, h: D - 4, type: 'dust-flap' },
      { id: 'topRightEar', label: 'Top Right Ear', labelVi: 'Tai Nắp Phải', x: bx + W, y: by - H - D + 2, w: F, h: D - 4, type: 'dust-flap' },

      // Rear dust wings locking sides (attached to Left/Right of Rear Wall)
      { id: 'rearLeftDust', label: 'Rear Left Dust Wing', labelVi: 'Tai Góc Sau Trái', x: bx - F, y: by - H + 2, w: F, h: H - 4, type: 'dust-flap' },
      { id: 'rearRightDust', label: 'Rear Right Dust Wing', labelVi: 'Tai Góc Sau Phải', x: bx + W, y: by - H + 2, w: F, h: H - 4, type: 'dust-flap' },
      
      // Front dust flaps locking sides
      { id: 'frontLeftDust', label: 'Front Left Dust Wing', labelVi: 'Tai Góc Trước Trái', x: bx - F, y: by + D + 2, w: F, h: H - 4, type: 'dust-flap' },
      { id: 'frontRightDust', label: 'Front Right Dust Wing', labelVi: 'Tai Góc Trước Phải', x: bx + W, y: by + D + 2, w: F, h: H - 4, type: 'dust-flap' },
    ];

    const minX = bx - H * 2 - 30;
    const maxX = bx + W + H * 2 + 30;
    const minY = by - H - D - F - 30;
    const maxY = by + D + H + H + 30;
    viewBox = `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;

  } else {
    // gift-tray: Draw Open Box Tray on Left, Sleeve Wrapping on Right
    // Center at (-W/2 - D/2, -H/2)
    const midGap = 60;
    const tx = -W - D - midGap/2;
    const ty = -D / 2;

    const sx = midGap/2;
    const sy = -D / 2;

    // Sleeve dimensions: W x D x H wrap around width and height
    // Panel 1: Top (W x D), Panel 2: Right (H x D), Panel 3: Bottom (W x D), Panel 4: Left (H x D)
    panels = [
      // === TRAY PIECE ===
      { id: 'trayBase', label: 'Tray Base', labelVi: 'Đáy Khay', x: tx, y: ty, w: W, h: D, type: 'face' },
      { id: 'trayFront', label: 'Tray Front Wall', labelVi: 'Vách Thiết Khay Trước', x: tx, y: ty + D, w: W, h: H, type: 'face' },
      { id: 'trayBack', label: 'Tray Back Wall', labelVi: 'Vách Thiết Khay Sau', x: tx, y: ty - H, w: W, h: H, type: 'face' },
      { id: 'trayLeft', label: 'Tray Left Wall', labelVi: 'Vách Thiết Khay Trái', x: tx - H, y: ty, w: H, h: D, type: 'face' },
      { id: 'trayRight', label: 'Tray Right Wall', labelVi: 'Vách Thiết Khay Phải', x: tx + W, y: ty, w: H, h: D, type: 'face' },
      { id: 'trayLeftInner', label: 'Tray Left Double-Wall', labelVi: 'Gấp Vách Trái', x: tx - H * 2, y: ty + 1, w: H - 1, h: D - 2, type: 'flap' },
      { id: 'trayRightInner', label: 'Tray Right Double-Wall', labelVi: 'Gấp Vách Phải', x: tx + W + H, y: ty + 1, w: H - 1, h: D - 2, type: 'flap' },

      // === SLEEVE PIECE ===
      { id: 'sleeveTop', label: 'Sleeve Top', labelVi: 'Vỏ - Mặt Trên', x: sx, y: sy, w: W, h: D, type: 'face' },
      { id: 'sleeveRight', label: 'Sleeve Right', labelVi: 'Vỏ - Hông Phải', x: sx + W, y: sy, w: H, h: D, type: 'face' },
      { id: 'sleeveBottom', label: 'Sleeve Bottom', labelVi: 'Vỏ - Mặt Dưới', x: sx + W + H, y: sy, w: W, h: D, type: 'face' },
      { id: 'sleeveLeft', label: 'Sleeve Left', labelVi: 'Vỏ - Hông Trái', x: sx + W * 2 + H, y: sy, w: H, h: D, type: 'face' },
      { id: 'sleeveGlue', label: 'Sleeve Glue Lid', labelVi: 'Mép Dán Vỏ', x: sx + W * 2 + H * 2, y: sy + 4, w: F * 0.6, h: D - 8, type: 'glue-flap' },
    ];

    const minX = tx - H * 2 - 30;
    const maxX = sx + W * 2 + H * 2 + F + 30;
    const minY = Math.min(ty - H, sy) - 30;
    const maxY = Math.max(ty + D + H, sy + D) + 30;
    viewBox = `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
  }

  // Draw dimension arrows
  // We can render custom labels or lines on the canvas to represent technical guides
  const renderDimensionLines = () => {
    // Only render dimension paths on the dieline
    if (type === 'tuck-end') {
      const fx = -W / 2;
      const fy = -H / 2;
      return (
        <g className="text-[10px] fill-orange-500 stroke-orange-500/40" strokeWidth="1">
          {/* Width Line */}
          <line x1={fx} y1={fy + H + 20} x2={fx + W} y2={fy + H + 20} strokeDasharray="3,3" />
          <path d={`M ${fx} ${fy+H+17} L ${fx} ${fy+H+23} M ${fx+W} ${fy+H+17} L ${fx+W} ${fy+H+23}`} strokeWidth="2" />
          <text x={fx + W/2} y={fy + H + 35} textAnchor="middle" className="font-mono font-bold tracking-wider">W: {W}mm</text>

          {/* Height Line */}
          <line x1={fx + W + 20} y1={fy} x2={fx + W + 20} y2={fy + H} strokeDasharray="3,3" />
          <path d={`M ${fx+W+17} ${fy} L ${fx+W+23} ${fy} M ${fx+W+17} ${fy+H} L ${fx+W+23} ${fy+H}`} strokeWidth="2" />
          <text x={fx + W + 25} y={fy + H/2} textAnchor="start" dominantBaseline="middle" className="font-mono font-bold tracking-wider">H: {H}mm</text>

          {/* Depth Line */}
          <line x1={fx} y1={fy - 20} x2={fx + W} y2={fy - 20} strokeDasharray="3,3" />
          <path d={`M ${fx} ${fy-23} L ${fx} ${fy-17} M ${fx+W} ${fy-23} L ${fx+W} ${fy-17}`} strokeWidth="2" />
          {/* For depth, show the Top Lid height which is Depth */}
          <line x1={fx - 20} y1={fy} x2={fx - 20} y2={fy - D} strokeDasharray="3,3" />
          <path d={`M ${fx-23} ${fy} L ${fx-17} ${fy} M ${fx-23} ${fy-D} L ${fx-17} ${fy-D}`} strokeWidth="2" />
          <text x={fx - 25} y={fy - D/2} textAnchor="end" dominantBaseline="middle" className="font-mono font-bold tracking-wider">D: {D}mm</text>
        </g>
      );
    } else if (type === 'mailer') {
      const bx = -W / 2;
      const by = -D / 2;
      return (
        <g className="text-[10px] fill-orange-500 stroke-orange-500/40" strokeWidth="1">
          {/* Width */}
          <line x1={bx} y1={by + D + H + 15} x2={bx + W} y2={by + D + H + 15} strokeDasharray="3,3" />
          <path d={`M ${bx} ${by+D+H+12} L ${bx} ${by+D+H+18} M ${bx+W} ${by+D+H+12} L ${bx+W} ${by+D+H+18}`} strokeWidth="2" />
          <text x={bx + W/2} y={by + D + H + 28} textAnchor="middle" className="font-mono font-bold">W: {W}mm</text>

          {/* Depth */}
          <line x1={bx + W + H + 15} y1={by} x2={bx + W + H + 15} y2={by + D} strokeDasharray="3,3" />
          <path d={`M ${bx+W+H+12} ${by} L ${bx+W+H+18} ${by} M ${bx+W+H+12} ${by+D} L ${bx+W+H+18} ${by+D}`} strokeWidth="2" />
          <text x={bx + W + H + 20} y={by + D/2} textAnchor="start" dominantBaseline="middle" className="font-mono font-bold">D: {D}mm</text>

          {/* Box Wall Height H */}
          <line x1={bx - 15} y1={by} x2={bx - 15} y2={by - H} strokeDasharray="3,3" />
          <path d={`M ${bx-18} ${by} L ${bx-12} ${by} M ${bx-18} ${by-H} L ${bx-12} ${by-H}`} strokeWidth="2" />
          <text x={bx - 20} y={by - H/2} textAnchor="end" dominantBaseline="middle" className="font-mono font-bold">H: {H}mm</text>
        </g>
      );
    } else {
      // Gift-tray drawer/sleeve
      const tx = -W - D - 30;
      const ty = -D / 2;
      return (
        <g className="text-[10px] fill-orange-500 stroke-orange-500/40" strokeWidth="1">
          {/* Width of Tray Base */}
          <line x1={tx} y1={ty + D + H + 15} x2={tx + W} y2={ty + D + H + 15} strokeDasharray="3,3" />
          <path d={`M ${tx} ${ty+D+H+12} L ${tx} ${ty+D+H+18} M ${tx+W} ${ty+D+H+12} L ${tx+W} ${ty+D+H+18}`} strokeWidth="2" />
          <text x={tx + W/2} y={ty + D + H + 28} textAnchor="middle" className="font-mono font-bold">W: {W}mm</text>

          {/* Height of tray wall */}
          <line x1={tx - H - 15} y1={ty} x2={tx - H - 15} y2={ty + D} strokeDasharray="3,3" />
          <path d={`M ${tx-H-18} ${ty} L ${tx-H-12} ${ty} M ${tx-H-18} ${ty+D} L ${tx-H-12} ${ty+D}`} strokeWidth="2" />
          <text x={tx - H - 20} y={ty + D/2} textAnchor="end" dominantBaseline="middle" className="font-mono font-bold">D: {D}mm</text>

          <line x1={tx} y1={ty - H - 15} x2={tx + W} y2={ty - H - 15} strokeDasharray="3,3" />
          <text x={tx + W/2} y={ty - H - 25} textAnchor="middle" className="font-mono font-bold">H: {H}mm</text>
        </g>
      );
    }
  };

  return (
    <div className="w-full h-full bg-[#0F0F0F] rounded-xl flex flex-col overflow-hidden relative border border-[#2A2A2A]">
      <div className="flex items-center justify-between px-5 py-3.5 bg-[#121212] border-b border-[#2A2A2A] shrink-0">
        <div className="flex items-center gap-2">
          <span className="flex h-2.5 w-2.5 rounded-full bg-orange-500 shadow shadow-orange-500/50 animate-pulse"></span>
          <h3 className="font-bold text-sm tracking-tight text-[#E0E0E0] font-display">Khuôn Trải Bản Vẽ 2D (Interactive Dieline)</h3>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2 text-gray-400">
            <span className="w-2.5 h-0.5 border-t-2 border-dashed border-sky-400"></span> Đường Gấp (Crease)
          </div>
          <div className="flex items-center gap-2 text-gray-400">
            <span className="w-2.5 h-0.5 border-t-2 border-rose-500"></span> Đường Cắt (Cut Line)
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative p-4 flex items-center justify-center bg-[#0F0F0F]" style={{ backgroundImage: 'radial-gradient(#222 1px, transparent 1px)', backgroundSize: '16px 16px' }}>
        {/* Draw main dieline using SVG */}
        <svg
          viewBox={viewBox}
          className="w-full h-full select-none"
          style={{ maxHeight: 'calc(100% - 10px)' }}
        >
          {/* Define clipPaths or patterns for visual styling */}
          <defs>
            <pattern id="cardboardPattern" width="8" height="8" patternUnits="userSpaceOnUse">
              <rect width="8" height="8" fill="#2d2217" />
              <line x1="0" y1="0" x2="0" y2="8" stroke="#3d2d20" strokeWidth="1" />
            </pattern>
            <pattern id="diagonalHatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="4" height="4" fill="transparent" />
              <line x1="0" y1="0" x2="0" y2="4" stroke="#ffffff" strokeWidth="0.5" strokeOpacity="0.15" />
            </pattern>
          </defs>

          {/* Grid background for technical feel */}
          <g>
            <rect x="-1000" y="-1000" width="2000" height="2000" fill="transparent" />
          </g>

          {/* Dimension Lines */}
          {renderDimensionLines()}

          {/* Render individual dieline panels */}
          {panels.map((p) => {
            const isSelected = selectedPanelId === p.id;
            const design = designs[p.id] || {
              backgroundColor: '#ffffff',
              text: '',
              textColor: '#000000',
              textSize: 12,
              textX: 50,
              textY: 50,
              textRotation: 0,
              sticker: '',
              stickerScale: 20,
              stickerX: 50,
              stickerY: 30,
            };

            // Custom shape calculation for flap corner tapering
            let pointsString = '';
            const padding = 1.0; // small contraction to show fold joins clearly

            if (p.type === 'flap') {
              // Flaps have tapered corners
              const top = p.y;
              const bottom = p.y + p.h;
              const left = p.x;
              const right = p.x + p.w;
              const taper = Math.min(p.h * 0.4, p.w * 0.15); // corner taper

              // Determine direction of flap (whether it's on top or bottom)
              const isTopFlap = p.id.toLowerCase().includes('top') || p.id.toLowerCase().includes('inner') || p.id.toLowerCase().includes('roll');
              
              if (p.id.includes('Left') || p.id.includes('left')) {
                // Horizontal flap extending left
                pointsString = `${left + taper},${top} ${right},${top} ${right},${bottom} ${left + taper},${bottom}`;
              } else if (p.id.includes('Right') || p.id.includes('right')) {
                // Horizontal flap extending right
                pointsString = `${left},${top} ${right - taper},${top} ${right - taper},${bottom} ${left},${bottom}`;
              } else if (isTopFlap) {
                // Upward tapering flap
                pointsString = `${left + taper},${top} ${right - taper},${top} ${right},${bottom} ${left},${bottom}`;
              } else {
                // Downward tapering flap
                pointsString = `${left},${top} ${right},${top} ${right - taper},${bottom} ${left + taper},${bottom}`;
              }
            } else if (p.type === 'dust-flap') {
              // Dust flaps usually have tapered round corners or diagonal shapes
              const top = p.y;
              const bottom = p.y + p.h;
              const left = p.x;
              const right = p.x + p.w;
              const taper = p.h * 0.25;

              if (p.id.includes('top') || p.id.includes('Top')) {
                // Taper top
                pointsString = `${left + taper},${top} ${right - taper},${top} ${right},${bottom} ${left},${bottom}`;
              } else if (p.id.includes('bottom') || p.id.includes('Bottom')) {
                // Taper bottom
                pointsString = `${left},${top} ${right},${top} ${right - taper},${bottom} ${left + taper},${bottom}`;
              } else {
                pointsString = `${left},${top} ${right},${top} ${right},${bottom} ${left},${bottom}`;
              }
            } else if (p.type === 'glue-flap') {
              // Glue flap usually has heavy taper
              const top = p.y;
              const bottom = p.y + p.h;
              const left = p.x;
              const right = p.x + p.w;
              const taperH = p.h * 0.08;

              if (p.id === 'glue') {
                pointsString = `${left},${top + taperH} ${right},${top} ${right},${bottom} ${left},${bottom - taperH}`;
              } else {
                pointsString = `${left},${top} ${right},${top} ${right},${bottom} ${left},${bottom}`;
              }
            }

            // Design visual coordinates
            const textPosX = p.x + (design.textX / 100) * p.w;
            const textPosY = p.y + (design.textY / 100) * p.h;

            const stickerPosX = p.x + (design.stickerX / 100) * p.w;
            const stickerPosY = p.y + (design.stickerY / 100) * p.h;

            const StickerIcon = STICKER_ICONS[design.sticker];

            return (
              <g
                key={p.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectPanel(p.id);
                }}
                className="cursor-pointer group/node"
              >
                {/* DRAW PANEL SHAPE BACKGROUND */}
                {pointsString ? (
                  <polygon
                    points={pointsString}
                    fill={design.backgroundColor}
                    stroke={isSelected ? '#3b82f6' : '#d4d4d8'}
                    strokeWidth={isSelected ? '2' : '1.2'}
                    className="transition-all duration-150 group-hover/node:fill-zinc-100/5"
                    style={{ fill: design.backgroundColor }}
                  />
                ) : (
                  <rect
                    x={p.x}
                    y={p.y}
                    width={p.w}
                    height={p.h}
                    fill={design.backgroundColor}
                    stroke={isSelected ? '#3b82f6' : '#d4d4d8'}
                    strokeWidth={isSelected ? '2.5' : '1.2'}
                    className="transition-all duration-150 group-hover/node:bg-opacity-80"
                    rx={2}
                  />
                )}

                {/* Score lines indicators inside layout (Only showing folding joins) */}
                {/* Visualizing score-lines as light teal dotted lines to guide the eye */}
                {!pointsString && p.type === 'face' && (
                  <rect
                    x={p.x + 0.5}
                    y={p.y + 0.5}
                    width={p.w - 1}
                    height={p.h - 1}
                    fill="transparent"
                    stroke="#38bdf8"
                    strokeWidth="0.8"
                    strokeDasharray="4,4"
                    pointerEvents="none"
                    opacity="0.5"
                  />
                )}

                {/* Draw Cut lines (outer boundaries) - we draw custom lines around elements to represent industrial dieline look */}
                {/* Selection Outline glow */}
                {isSelected && (
                  <g pointerEvents="none">
                    <rect
                      x={p.x - 3}
                      y={p.y - 3}
                      width={p.w + 6}
                      height={p.h + 6}
                      fill="transparent"
                      stroke="#fbbf24"
                      strokeWidth="1"
                      strokeDasharray="2,2"
                    />
                  </g>
                )}

                {/* Technical Hatches for glue flaps */}
                {p.type === 'glue-flap' && (
                  <g pointerEvents="none">
                    <polygon
                      points={pointsString || `${p.x},${p.y} ${p.x+p.w},${p.y} ${p.x+p.w},${p.y+p.h} ${p.x},${p.y+p.h}`}
                      fill="url(#diagonalHatch)"
                    />
                  </g>
                )}

                {/* STICKER */}
                {design.sticker && StickerIcon && (
                  <g
                    transform={`translate(${stickerPosX}, ${stickerPosY})`}
                    pointerEvents="none"
                    className="text-zinc-900 filter drop-shadow-sm transition-transform"
                  >
                    <g transform={`scale(${design.stickerScale / 25}) translate(${-12}, ${-12})`}>
                      <StickerIcon
                        size={24}
                        fill={design.textColor}
                        stroke={design.backgroundColor === '#ffffff' || design.backgroundColor === '#f4f4f5' ? '#000000' : '#ffffff'}
                        strokeWidth={1.5}
                      />
                    </g>
                  </g>
                )}

                {/* DESIGNED CUSTOM TEXT */}
                {design.text && (
                  <text
                    x={textPosX}
                    y={textPosY}
                    fill={design.textColor}
                    fontSize={design.textSize * 0.75}
                    fontWeight="bold"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    pointerEvents="none"
                    transform={`rotate(${design.textRotation}, ${textPosX}, ${textPosY})`}
                    style={{ fontStyle: 'normal' }}
                    className="font-sans select-none pointer-events-none drop-shadow-sm tracking-wide"
                  >
                    {design.text}
                  </text>
                )}

                {/* PANEL TEXT LABEL (Human-readable, small centered text helper) */}
                <g className="opacity-0 group-hover/node:opacity-100 transition-opacity pointer-events-none">
                  {/* Subtle dark backing card */}
                  <rect
                    x={p.x + p.w / 2 - 45}
                    y={p.y + p.h / 2 - 10}
                    width="90"
                    height="20"
                    rx="4"
                    fill="#18181b"
                    opacity="0.9"
                  />
                  <text
                    x={p.x + p.w / 2}
                    y={p.y + p.h / 2}
                    fill="#a1a1aa"
                    fontSize={7.5}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="font-sans font-medium"
                  >
                    {p.labelVi}
                  </text>
                </g>
              </g>
            );
          })}

          {/* Red Boundary Cut lines on Top Layer */}
          <g stroke="#f43f5e" strokeWidth="1" fill="none" opacity="0.8" pointerEvents="none">
            {/* Draw outer cut edge indicators */}
            {panels.map((p) => {
              // Standard panels have bounding boxes, let's draw subtle indicator notches at corner cuts
              if (p.type === 'glue-flap') {
                return null; // already drawn via polygon
              }
              return (
                <rect
                  key={`cut-${p.id}`}
                  x={p.x}
                  y={p.y}
                  width={p.w}
                  height={p.h}
                  className="stroke-rose-600/30"
                />
              );
            })}
          </g>
        </svg>

        {/* Selected panel float-over helper badge */}
        {selectedPanelId && (
          <div className="absolute bottom-4 left-4 right-4 bg-zinc-900/90 backdrop-blur border border-zinc-750 px-3 py-2 rounded-lg flex items-center justify-between shadow-lg text-xs">
            <div className="flex items-center gap-2">
              <span className="text-zinc-400">Đang chọn:</span>
              <span className="kbd bg-zinc-800 text-amber-300 font-bold px-1.5 py-0.5 rounded border border-zinc-700">
                {panels.find(p => p.id === selectedPanelId)?.labelVi || selectedPanelId}
              </span>
            </div>
            <button
              onClick={() => onSelectPanel('')}
              className="text-rose-400 hover:text-rose-300 font-medium cursor-pointer transition-colors"
            >
              Hủy chọn ×
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
