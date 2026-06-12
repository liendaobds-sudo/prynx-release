import { useState, useEffect, useRef } from 'react';
import { BoxType, BoxDimensions, PanelDesign, BoxState } from './types';
import { Dieline2D } from './components/Dieline2D';
import { Visualizer3D } from './components/Visualizer3D';
import {
  Settings,
  Hammer,
  Play,
  Pause,
  Layers,
  Sparkles,
  Download,
  RotateCcw,
  Palette,
  Package,
  Heart,
  HelpCircle,
  FileDown,
  ChevronRight,
  Info,
  Sliders,
  Type
} from 'lucide-react';

const PRESET_DESIGNS: Record<BoxType, Record<string, PanelDesign>> = {
  'tuck-end': {
    front: {
      panelId: 'front',
      backgroundColor: '#0f172a', // Slate dark blue
      text: 'ECO COSMETICS',
      textColor: '#34d399', // Emerald
      textSize: 12,
      textX: 50,
      textY: 45,
      textRotation: 0,
      sticker: 'leaf',
      stickerScale: 25,
      stickerX: 50,
      stickerY: 18,
    },
    back: {
      panelId: 'back',
      backgroundColor: '#0f172a',
      text: '100% ORGANIC & CRUELTY FREE',
      textColor: '#94a3b8',
      textSize: 8,
      textX: 50,
      textY: 80,
      textRotation: 0,
      sticker: 'sparkles',
      stickerScale: 20,
      stickerX: 50,
      stickerY: 45,
    },
    left: {
      panelId: 'left',
      backgroundColor: '#34d399', // green
      text: 'GREEN LIFE',
      textColor: '#0f172a',
      textSize: 10,
      textX: 50,
      textY: 50,
      textRotation: 90,
      sticker: '',
      stickerScale: 20,
      stickerX: 50,
      stickerY: 50,
    },
    right: {
      panelId: 'right',
      backgroundColor: '#34d399',
      text: 'NATURAL ESSENCE',
      textColor: '#0f172a',
      textSize: 10,
      textX: 50,
      textY: 50,
      textRotation: -90,
      sticker: '',
      stickerScale: 20,
      stickerX: 50,
      stickerY: 50,
    },
    top: {
      panelId: 'top',
      backgroundColor: '#0f172a',
      text: 'Premium Pack',
      textColor: '#e2e8f0',
      textSize: 10,
      textX: 50,
      textY: 50,
      textRotation: 0,
      sticker: 'gift',
      stickerScale: 20,
      stickerX: 50,
      stickerY: 15,
    }
  },
  'mailer': {
    bottom: {
      panelId: 'bottom',
      backgroundColor: '#1c1917', // Dark wood
      text: 'MADE WITH LOVE',
      textColor: '#fb923c', // Orange
      textSize: 8,
      textX: 50,
      textY: 50,
      textRotation: 0,
      sticker: 'heart',
      stickerScale: 15,
      stickerX: 50,
      stickerY: 18,
    },
    top: {
      panelId: 'top',
      backgroundColor: '#1c1917',
      text: 'PIZZA PLANET',
      textColor: '#f43f5e', // Hot pink
      textSize: 16,
      textX: 50,
      textY: 40,
      textRotation: 0,
      sticker: 'sparkles',
      stickerScale: 30,
      stickerX: 50,
      stickerY: 75,
    },
    frontWall: {
      panelId: 'frontWall',
      backgroundColor: '#f43f5e',
      text: 'DELIVERY FRESH',
      textColor: '#ffffff',
      textSize: 10,
      textX: 50,
      textY: 50,
      textRotation: 0,
      sticker: '',
      stickerScale: 20,
      stickerX: 50,
      stickerY: 50,
    }
  },
  'gift-tray': {
    sleeveTop: {
      panelId: 'sleeveTop',
      backgroundColor: '#4338ca', // Indigo
      text: 'MEMORIES COLLECTION',
      textColor: '#fcd34d', // Gold yellow
      textSize: 11,
      textX: 50,
      textY: 45,
      textRotation: 0,
      sticker: 'gift',
      stickerScale: 25,
      stickerX: 50,
      stickerY: 18,
    },
    trayBase: {
      panelId: 'trayBase',
      backgroundColor: '#ffffff',
      text: 'THANK YOU FOR BEING HERE',
      textColor: '#4338ca',
      textSize: 10,
      textX: 50,
      textY: 50,
      textRotation: 0,
      sticker: 'smile',
      stickerScale: 20,
      stickerX: 50,
      stickerY: 20,
    }
  }
};

const DEFAULT_DIMENSIONS: Record<BoxType, BoxDimensions> = {
  'tuck-end': { width: 120, height: 160, depth: 70, flap: 30, thickness: 1.0 },
  'mailer': { width: 220, height: 50, depth: 160, flap: 25, thickness: 1.5 },
  'gift-tray': { width: 150, height: 60, depth: 110, flap: 25, thickness: 1.2 },
};

export default function App() {
  const [boxType, setBoxType] = useState<BoxType>('tuck-end');
  const [dimensions, setDimensions] = useState<BoxDimensions>(DEFAULT_DIMENSIONS['tuck-end']);
  const [foldProgress, setFoldProgress] = useState<number>(0.6); // start semi-folded
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [animationSpeed, setAnimationSpeed] = useState<number>(0.4);
  const [material, setMaterial] = useState<'matte' | 'glossy' | 'kraft'>('kraft');
  const [paperWeight, setPaperWeight] = useState<number>(350); // gsm
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>('front');
  const [designs, setDesigns] = useState<Record<string, PanelDesign>>(PRESET_DESIGNS['tuck-end']);
  const [viewMode, setViewMode] = useState<'split' | '2d' | '3d'>('split');

  // Animation sweep state control variables
  const animationRef = useRef<number | null>(null);
  const sweepDirectionRef = useRef<'forward' | 'backward'>('forward');

  // Loop of folding sweep state
  useEffect(() => {
    if (!isPlaying) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      return;
    }

    const animateSweep = () => {
      setFoldProgress((prev) => {
        const step = 0.005 * animationSpeed;
        if (sweepDirectionRef.current === 'forward') {
          const next = prev + step;
          if (next >= 1.0) {
            // Pause brief moment then sweep back
            sweepDirectionRef.current = 'backward';
            return 1.0;
          }
          return next;
        } else {
          const next = prev - step;
          if (next <= 0.0) {
            sweepDirectionRef.current = 'forward';
            return 0.0;
          }
          return next;
        }
      });
      animationRef.current = requestAnimationFrame(animateSweep);
    };

    animationRef.current = requestAnimationFrame(animateSweep);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isPlaying, animationSpeed]);

  // Handle box type changes
  const handleBoxTypeChange = (type: BoxType) => {
    setBoxType(type);
    setDimensions(DEFAULT_DIMENSIONS[type]);
    setDesigns(PRESET_DESIGNS[type] || {});
    // Focus a reasonable default panel for design controls
    if (type === 'tuck-end') {
      setSelectedPanelId('front');
    } else if (type === 'mailer') {
      setSelectedPanelId('top');
    } else {
      setSelectedPanelId('sleeveTop');
    }
  };

  // Modify active design parameters
  const updateActiveDesign = (updates: Partial<PanelDesign>) => {
    if (!selectedPanelId) return;

    setDesigns((prev) => {
      const current = prev[selectedPanelId] || {
        panelId: selectedPanelId,
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
        stickerY: 50,
      };

      return {
        ...prev,
        [selectedPanelId]: {
          ...current,
          ...updates,
        },
      };
    });
  };

  // Dimension helpers
  const handleDimensionChange = (key: keyof BoxDimensions, value: number) => {
    setDimensions((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  // Production Calculations
  const getProductionStats = () => {
    const { width: W, height: H, depth: D, flap: F } = dimensions;
    let flatW = 0;
    let flatH = 0;

    if (boxType === 'tuck-end') {
      flatW = W * 2 + D * 2 + F * 0.7;
      flatH = H + D * 2 + F * 2;
    } else if (boxType === 'mailer') {
      flatW = W + H * 4;
      flatH = D * 2 + H * 3 + F * 2;
    } else {
      // Tray + sleeve length combined flat-pack representation
      flatW = Math.max(W + H * 4, W * 2 + H * 2 + F);
      flatH = Math.max(D * 2 + H * 2, D);
    }

    const areaM2 = (flatW * flatH) / 1000000; // in square meters
    const weightGrams = areaM2 * paperWeight;

    return {
      flatWidth: Math.round(flatW),
      flatHeight: Math.round(flatH),
      areaInCm2: Math.round(areaM2 * 10000),
      weightGrms: weightGrams.toFixed(1),
      estimatedVolumeLtr: ((W * H * D) / 1000000).toFixed(2),
    };
  };

  const stats = getProductionStats();

  // Export 2D dieline as complete standalone SVG
  const handleExportSVG = () => {
    const svgEl = document.querySelector('svg');
    if (!svgEl) return;

    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svgEl);

    if (!source.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)) {
      source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    const svgBlob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
    const svgUrl = URL.createObjectURL(svgBlob);
    const downloadLink = document.createElement('a');
    downloadLink.href = svgUrl;
    downloadLink.download = `BoxCraft3D_Dieline_${boxType}_${dimensions.width}x${dimensions.height}x${dimensions.depth}mm.svg`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
  };

  // Export 3D Snapshot picture of the card WebGL scene
  const handleExport3DSnapshot = () => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return;

    const imgData = canvas.toDataURL('image/png');
    const downloadLink = document.createElement('a');
    downloadLink.href = imgData;
    downloadLink.download = `BoxCraft3D_Model_${boxType}.png`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
  };

  const currentDesign = selectedPanelId ? designs[selectedPanelId] || {
    panelId: selectedPanelId,
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
    stickerY: 50,
  } : null;

  const getPanelNameInVi = (id: string) => {
    const mapping: Record<string, string> = {
      front: 'Mặt Trước (Front)',
      back: 'Mặt Sau (Back)',
      left: 'Hông Trái (Left)',
      right: 'Hông Phải (Right)',
      top: 'Lắp đậy Trên (Top Lid)',
      topTuck: 'Mép Gài Trên (Top Tuck)',
      bottom: 'Nắp Dưới / Mặt Đáy (Bottom)',
      bottomTuck: 'Mép Gài Dưới (Bottom Tuck)',
      glue: 'Mép Dán Góc (Glue Flap)',
      leftDustTop: 'Tai Phụ Trái Trên',
      rightDustTop: 'Tai Phụ Phải Trên',
      leftDustBottom: 'Tai Phụ Trái Dưới',
      rightDustBottom: 'Tai Phụ Phải Dưới',
      // Mailer
      rearWall: 'Vách Sau (Rear)',
      frontWall: 'Vách Trước (Front)',
      frontRoll: 'Khóa Gấp Vách Trước',
      leftWall: 'Vách Hông Trái',
      rightWall: 'Vách Hông Phải',
      leftRoll: 'Lót Khóa Trái',
      rightRoll: 'Lót Khóa Phải',
      topLeftEar: 'Tai Nắp Trái',
      topRightEar: 'Tai Nắp Phải',
      rearLeftDust: 'Tai Góc Sau Trái',
      rearRightDust: 'Tai Góc Sau Phải',
      frontLeftDust: 'Tai Góc Trước Trái',
      frontRightDust: 'Tai Góc Trước Phải',
      // Tray Sleeve
      trayBase: 'Đáy Khay Chứa',
      trayFront: 'Khay - Vách Trước',
      trayBack: 'Khay - Vách Sau',
      trayLeft: 'Khay - Vách Trái',
      trayRight: 'Khay - Vách Phải',
      trayLeftInner: 'Khay - Lót Gấp Trái',
      trayRightInner: 'Khay - Lót Gấp Phải',
      sleeveTop: 'Mặt Trên Vỏ Sleeve',
      sleeveRight: 'Hông Phải Vỏ Sleeve',
      sleeveBottom: 'Mặt Dưới Vỏ Sleeve',
      sleeveLeft: 'Hông Trái Vỏ Sleeve',
      sleeveGlue: 'Mép Dán Vỏ Sleeve'
    };
    return mapping[id] || id;
  };

  const sharedState: BoxState = {
    type: boxType,
    dimensions,
    foldProgress,
    designs,
    material,
    paperWeight,
  };

  return (
    <div className="flex flex-col min-h-screen bg-[#0A0A0A] text-[#E0E0E0] font-sans antialiased overflow-hidden select-none">
      {/* Header bar */}
      <header className="h-14 border-b border-[#2A2A2A] flex items-center justify-between px-6 bg-[#121212] shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 bg-orange-500 rounded-sm rotate-45 flex items-center justify-center shadow-lg shadow-orange-500/20">
              <div className="w-2 h-2 bg-black rounded-full"></div>
            </div>
            <span className="font-bold tracking-tighter text-xl text-white font-display">BOXCRAFT 3D</span>
            <span className="text-[9px] font-mono tracking-wider bg-orange-500/10 text-orange-400 font-extrabold px-1.5 py-0.5 rounded border border-orange-500/20">STUDIO BETA</span>
          </div>
          <span className="text-xs text-gray-400 hidden lg:inline-block border-l border-[#2A2A2A] pl-4 font-medium">Bản vẽ thiết kế khuôn trải dieline và hiển thị lắp ghép 3D tự động</span>
        </div>

        {/* View mode switcher */}
        <div className="flex items-center bg-[#1E1E1E] rounded-md border border-[#333] p-1 gap-1">
          <button
            onClick={() => setViewMode('split')}
            className={`cursor-pointer text-xs font-bold px-4 py-1.5 rounded transition-all ${
              viewMode === 'split' ? 'bg-orange-500 text-black font-extrabold shadow-md' : 'text-gray-400 hover:text-white'
            }`}
          >
            Chia Đôi (Split)
          </button>
          <button
            onClick={() => setViewMode('2d')}
            className={`cursor-pointer text-xs font-bold px-4 py-1.5 rounded transition-all ${
              viewMode === '2d' ? 'bg-orange-500 text-black font-extrabold shadow-md' : 'text-gray-400 hover:text-white'
            }`}
          >
            Bản vẽ 2D Plane
          </button>
          <button
            onClick={() => setViewMode('3d')}
            className={`cursor-pointer text-xs font-bold px-4 py-1.5 rounded transition-all ${
              viewMode === '3d' ? 'bg-orange-500 text-black font-extrabold shadow-md' : 'text-gray-400 hover:text-white'
            }`}
          >
            Mô hình 3D Model
          </button>
        </div>

        {/* Action downlods buttons */}
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-[#1E1E1E] rounded-md px-3 py-1.5 border border-[#333]">
            <span className="text-xs text-gray-500 mr-2 uppercase font-mono font-bold tracking-wider">Export</span>
            <button
              onClick={handleExportSVG}
              className="text-xs font-bold hover:text-orange-500 transition-colors text-white cursor-pointer"
              title="Tải khuôn trải 2D dạng ảnh vector SVG"
            >
              SVG DIELINE
            </button>
          </div>
          <button
            onClick={handleExport3DSnapshot}
            className="cursor-pointer bg-orange-500 hover:bg-orange-400 text-black font-bold text-xs px-5 py-2 rounded shadow-lg shadow-orange-500/20 transition-all uppercase tracking-wide"
          >
            SHARE SNAPSHOT PREVIEW (PNG)
          </button>
        </div>
      </header>

      {/* Workspace Area split layout */}
      <main className="flex-1 flex min-h-0 relative">
        
        {/* SIDEBAR: BOX CONFIGURATION & DESIGN ENGINE CONTROLS */}
        <aside className="w-[360px] border-r border-[#2A2A2A] bg-[#121212] overflow-y-auto flex flex-col shrink-0 text-sm select-none">
          
          {/* BOX TYPES SELECTOR TAB */}
          <div className="p-5 border-b border-[#2A2A2A]/60">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold block mb-3">Kiểu Hộp Thiết Kế (Box Template)</span>
            <div className="grid grid-cols-3 gap-2 bg-[#1E1E1E] border border-[#333] p-1 rounded-md">
              <button
                onClick={() => handleBoxTypeChange('tuck-end')}
                className={`cursor-pointer py-2.5 px-1 text-center rounded text-xs font-bold transition-all flex flex-col items-center gap-1.5 ${
                  boxType === 'tuck-end' ? 'bg-[#2A2A2A] text-orange-500 border border-[#333]' : 'text-gray-400 hover:text-white'
                }`}
              >
                <Package size={14} />
                <span>Nắp Gài</span>
              </button>
              <button
                onClick={() => handleBoxTypeChange('mailer')}
                className={`cursor-pointer py-2.5 px-1 text-center rounded text-xs font-bold transition-all flex flex-col items-center gap-1.5 ${
                  boxType === 'mailer' ? 'bg-[#2A2A2A] text-orange-500 border border-[#333]' : 'text-gray-400 hover:text-white'
                }`}
              >
                <Layers size={14} />
                <span>Hộp Mailer</span>
              </button>
              <button
                onClick={() => handleBoxTypeChange('gift-tray')}
                className={`cursor-pointer py-2.5 px-1 text-center rounded text-xs font-bold transition-all flex flex-col items-center gap-1.5 ${
                  boxType === 'gift-tray' ? 'bg-[#2A2A2A] text-orange-500 border border-[#333]' : 'text-gray-400 hover:text-white'
                }`}
              >
                <Sparkles size={14} />
                <span>Khay Trượt</span>
              </button>
            </div>
          </div>

          {/* PARAMETERS SLIDERS SECTION */}
          <div className="p-5 border-b border-[#2A2A2A]/60 bg-[#0A0A0A]/20">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-4">
              <Sliders size={12} className="text-gray-400" />
              <span>Thông Số Kích Thước (Dimensions)</span>
            </div>
            
            <div className="flex flex-col gap-4">
              {/* Width Slider */}
              <div className="group/item">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-gray-400">Chiều rộng (Width):</span>
                  <span className="font-mono bg-[#1E1E1E] px-2 py-0.5 rounded border border-[#333] text-white font-bold">{dimensions.width} <span className="text-gray-500 text-[10px]">mm</span></span>
                </div>
                <input
                  type="range"
                  min="50"
                  max="300"
                  step="5"
                  value={dimensions.width}
                  onChange={(e) => handleDimensionChange('width', parseInt(e.target.value))}
                  className="w-full h-1 bg-[#333] rounded-lg appearance-none cursor-pointer accent-orange-500"
                />
              </div>

              {/* Height Slider */}
              <div className="group/item">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-gray-400">Chiều cao (Height):</span>
                  <span className="font-mono bg-[#1E1E1E] px-2 py-0.5 rounded border border-[#333] text-white font-bold">{dimensions.height} <span className="text-gray-500 text-[10px]">mm</span></span>
                </div>
                <input
                  type="range"
                  min="40"
                  max="300"
                  step="5"
                  value={dimensions.height}
                  onChange={(e) => handleDimensionChange('height', parseInt(e.target.value))}
                  className="w-full h-1 bg-[#333] rounded-lg appearance-none cursor-pointer accent-orange-500"
                />
              </div>

              {/* Depth Slider */}
              <div className="group/item">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-gray-400">Chiều sâu (Depth):</span>
                  <span className="font-mono bg-[#1E1E1E] px-2 py-0.5 rounded border border-[#333] text-white font-bold">{dimensions.depth} <span className="text-gray-500 text-[10px]">mm</span></span>
                </div>
                <input
                  type="range"
                  min="30"
                  max="250"
                  step="5"
                  value={dimensions.depth}
                  onChange={(e) => handleDimensionChange('depth', parseInt(e.target.value))}
                  className="w-full h-1 bg-[#333] rounded-lg appearance-none cursor-pointer accent-orange-500"
                />
              </div>

              {/* Flap Size slider */}
              <div className="group/item">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-gray-400">Tai gài / Mép dán (Flap):</span>
                  <span className="font-mono bg-[#1E1E1E] px-2 py-0.5 rounded border border-[#333] text-white font-bold">{dimensions.flap} <span className="text-gray-500 text-[10px]">mm</span></span>
                </div>
                <input
                  type="range"
                  min="15"
                  max="50"
                  step="2"
                  value={dimensions.flap}
                  onChange={(e) => handleDimensionChange('flap', parseInt(e.target.value))}
                  className="w-full h-1 bg-[#333] rounded-lg appearance-none cursor-pointer accent-orange-500"
                />
              </div>
            </div>
          </div>

          {/* INTERACTIVE FOLD PROGRESS CONTROL */}
          <div className="p-5 border-b border-[#2A2A2A]/60">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-[#888888] font-bold mb-3">
              <span>Đóng / Mở Thủ Công</span>
              <span className="text-orange-500">Kéo thanh trượt để lắp ráp</span>
            </div>

            <div className="bg-[#1E1E1E] p-4 rounded-xl border border-[#333] flex flex-col gap-3">
              <div className="w-full">
                <div className="flex items-center justify-between text-xs mb-2">
                  <span className="text-gray-400 font-medium">Góc gập mô lặp:</span>
                  <span className="font-mono text-orange-400 font-bold bg-orange-500/10 px-2 py-0.5 rounded border border-orange-500/20 text-xs">{(foldProgress * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={foldProgress}
                  onChange={(e) => {
                    setFoldProgress(parseFloat(e.target.value));
                    setIsPlaying(false);
                  }}
                  className="w-full h-2 bg-[#2A2A2A] rounded appearance-none cursor-pointer accent-orange-500"
                />
                <div className="flex justify-between text-[10px] text-gray-500 font-mono mt-2 px-1">
                  <span>Trải phẳng (2D)</span>
                  <span>50%</span>
                  <span>Đóng hộp (3D)</span>
                </div>
              </div>
            </div>
          </div>

          {/* DYNAMIC DESIGN GRAPHICS EDITOR (For clicked panel in dieline) */}
          <div className="flex-1 p-5 bg-[#0A0A0A]/10">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-4 pb-2 border-b border-[#2A2A2A]/40">
              <Palette size={13} className="text-gray-400" />
              <span>Thiết Kế Đồ Họa Bề Mặt (Surface Artwork)</span>
            </div>

            {selectedPanelId ? (
              <div className="flex flex-col gap-4">
                {/* ID Tag */}
                <div className="flex items-center justify-between bg-[#1E1E1E] border border-[#333] px-3.5 py-2.5 rounded-md">
                  <div className="flex flex-col">
                    <span className="text-[9px] text-gray-500 uppercase font-mono font-bold leading-none mb-1">Mặt đang chọn chỉnh sửa</span>
                    <span className="text-xs font-bold text-orange-500 leading-none">{getPanelNameInVi(selectedPanelId)}</span>
                  </div>
                  <span className="text-[10px] bg-[#2A2A2A] px-1.5 py-0.5 rounded text-white font-mono border border-[#333]">2D &amp; 3D Sync</span>
                </div>

                {/* Background color selection picker */}
                <div>
                  <label className="text-xs text-gray-400 font-medium block mb-2">Màu nền mặt này (Panel Background):</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={currentDesign?.backgroundColor || '#ffffff'}
                      onChange={(e) => updateActiveDesign({ backgroundColor: e.target.value })}
                      className="w-10 h-10 border border-[#333] outline-none rounded bg-[#1e1e1e] cursor-pointer shadow-sm shrink-0"
                    />
                    <div className="flex-1 flex flex-wrap gap-1">
                      {['#ffffff', '#f4f4f5', '#fce7f3', '#fee2e2', '#dcfce7', '#dbeafe', '#fef9c3', '#0f172a', '#1e293b', '#a26229'].map((c) => (
                        <button
                          key={c}
                          onClick={() => updateActiveDesign({ backgroundColor: c })}
                          style={{ backgroundColor: c }}
                          className={`w-6 h-6 rounded cursor-pointer border hover:scale-110 transition-transform ${
                            currentDesign?.backgroundColor === c ? 'border-orange-500' : 'border-[#333]'
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                {/* Text entry field */}
                <div className="border-t border-[#2A2A2A]/40 pt-4">
                  <div className="flex items-center gap-1.5 text-xs text-gray-400 font-semibold mb-2">
                    <Type size={13} className="text-gray-500" />
                    <span>Nội dung / Chữ In (Custom Text):</span>
                  </div>
                  <input
                    type="text"
                    value={currentDesign?.text || ''}
                    onChange={(e) => updateActiveDesign({ text: e.target.value })}
                    placeholder="Nhập tên thương hiệu, lời cảm ơn..."
                    className="w-full bg-[#1E1E1E] border border-[#333] px-3 py-2.5 rounded text-xs text-white placeholder-gray-600 focus:outline-none focus:border-orange-500 font-sans"
                  />
                  
                  {currentDesign?.text && (
                    <div className="flex flex-col gap-2.5 mt-3 bg-[#1E1E1E]/65 p-3.5 rounded border border-[#333]">
                      
                      {/* Text color picker */}
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-gray-400">Màu chữ (Text):</span>
                        <div className="flex items-center gap-1.5">
                          {['#000000', '#ffffff', '#ef4444', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6'].map(col => (
                            <button
                              key={col}
                              onClick={() => updateActiveDesign({ textColor: col })}
                              style={{ backgroundColor: col }}
                              className={`w-4 h-4 rounded-full cursor-pointer hover:scale-110 transition-all ${
                                currentDesign?.textColor === col ? 'ring-1 ring-orange-500 ring-offset-1 ring-offset-[#1b1b1b]' : ''
                              }`}
                            />
                          ))}
                        </div>
                      </div>

                      {/* Font Size slider */}
                      <div>
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="text-gray-400">Cỡ chữ:</span>
                          <span className="font-mono text-white font-bold">{currentDesign?.textSize}px</span>
                        </div>
                        <input
                          type="range"
                          min="6"
                          max="28"
                          value={currentDesign?.textSize || 12}
                          onChange={(e) => updateActiveDesign({ textSize: parseInt(e.target.value) })}
                          className="w-full h-1 bg-[#2A2A2A] rounded appearance-none cursor-pointer accent-orange-500"
                        />
                      </div>

                      {/* Text Position Y Slider */}
                      <div>
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="text-gray-400">Vị trí đứng (Y percent):</span>
                          <span className="font-mono text-white font-bold">{currentDesign?.textY}%</span>
                        </div>
                        <input
                          type="range"
                          min="10"
                          max="90"
                          value={currentDesign?.textY || 50}
                          onChange={(e) => updateActiveDesign({ textY: parseInt(e.target.value) })}
                          className="w-full h-1 bg-[#2A2A2A] rounded appearance-none cursor-pointer accent-orange-500"
                        />
                      </div>

                      {/* Text Rotation */}
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-gray-400">Xoay chữ:</span>
                        <div className="flex gap-1">
                          {[0, 90, 180, 270].map((deg) => (
                            <button
                              key={deg}
                              onClick={() => updateActiveDesign({ textRotation: deg })}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                                currentDesign?.textRotation === deg ? 'bg-[#2A2A2A] text-orange-400 font-bold border border-[#333]' : 'text-gray-500 border border-transparent'
                              }`}
                            >
                              {deg}°
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Built-in Sticker illustrations picker */}
                <div className="border-t border-[#2A2A2A]/40 pt-4">
                  <label className="text-xs text-gray-400 font-semibold block mb-2">Hình in trang trí (Sticker / Icon):</label>
                  <div className="grid grid-cols-5 gap-1.5">
                    {/* None Option */}
                    <button
                      onClick={() => updateActiveDesign({ sticker: '' })}
                      className={`cursor-pointer py-1.5 px-1 rounded text-[10px] font-bold border flex items-center justify-center transition-all ${
                        !currentDesign?.sticker ? 'bg-orange-500 text-black border-orange-500' : 'bg-[#1E1E1E] text-gray-500 border-[#333]'
                      }`}
                    >
                      Bỏ chọn
                    </button>
                    {['gift', 'heart', 'star', 'smile', 'leaf', 'coffee', 'shopping', 'shield', 'sparkles'].map((ico) => (
                      <button
                        key={ico}
                        onClick={() => updateActiveDesign({ sticker: ico })}
                        className={`cursor-pointer py-1.5 px-1 rounded text-[10px] uppercase font-bold border flex items-center justify-center transition-all ${
                          currentDesign?.sticker === ico ? 'bg-orange-500/10 text-orange-400 border-orange-500/50 scale-105' : 'bg-[#1E1E1E] text-gray-400 border-[#333] hover:text-white hover:border-[#444]'
                        }`}
                      >
                        {ico}
                      </button>
                    ))}
                  </div>

                  {currentDesign?.sticker && (
                    <div className="flex flex-col gap-2.5 mt-3 bg-[#1E1E1E]/65 p-3.5 rounded border border-[#333]">
                      {/* Sticker position Y */}
                      <div>
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="text-gray-400">Tỷ lệ đứng hình in (Y):</span>
                          <span className="font-mono text-white font-bold">{currentDesign?.stickerY}%</span>
                        </div>
                        <input
                          type="range"
                          min="10"
                          max="90"
                          value={currentDesign?.stickerY || 30}
                          onChange={(e) => updateActiveDesign({ stickerY: parseInt(e.target.value) })}
                          className="w-full h-1 bg-[#2A2A2A] rounded appearance-none cursor-pointer accent-orange-500"
                        />
                      </div>

                      {/* Sticker Scale slider */}
                      <div>
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="text-gray-400">Kích thước hình in:</span>
                          <span className="font-mono text-white font-bold">{currentDesign?.stickerScale}%</span>
                        </div>
                        <input
                          type="range"
                          min="10"
                          max="50"
                          value={currentDesign?.stickerScale || 20}
                          onChange={(e) => updateActiveDesign({ stickerScale: parseInt(e.target.value) })}
                          className="w-full h-1 bg-[#2A2A2A] rounded appearance-none cursor-pointer accent-orange-500"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* MATERIAL PACKAGING SELECTION CHIP */}
                <div className="border-t border-[#2A2A2A]/40 pt-4">
                  <label className="text-xs text-gray-400 font-semibold block mb-2">Chất liệu bề mặt hộp (Cardboard Type):</label>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => setMaterial('kraft')}
                      className={`cursor-pointer py-2 px-1 text-center rounded text-xs font-bold border transition-all ${
                        material === 'kraft' ? 'bg-orange-500/10 text-orange-400 border-orange-500/30' : 'bg-transparent text-gray-400 border-[#333] hover:text-white'
                      }`}
                    >
                      Kraft Nâu
                    </button>
                    <button
                      onClick={() => setMaterial('matte')}
                      className={`cursor-pointer py-2 px-1 text-center rounded text-xs font-bold border transition-all ${
                        material === 'matte' ? 'bg-orange-500/10 text-orange-400 border-orange-500/30' : 'bg-transparent text-gray-400 border-[#333] hover:text-white'
                      }`}
                    >
                      Bìa Trắng Matte
                    </button>
                    <button
                      onClick={() => setMaterial('glossy')}
                      className={`cursor-pointer py-2 px-1 text-center rounded text-xs font-bold border transition-all ${
                        material === 'glossy' ? 'bg-orange-500/10 text-orange-400 border-orange-500/30' : 'bg-transparent text-gray-400 border-[#333] hover:text-white'
                      }`}
                    >
                      Bóng Glossy
                    </button>
                  </div>
                </div>

              </div>
            ) : (
              <div className="flex flex-col items-center justify-center text-center p-6 bg-[#121212] border border-[#2A2A2A] rounded mt-4">
                <Info size={18} className="text-gray-500 mb-2" />
                <p className="text-xs text-gray-400 font-medium">Bấm chọn một mặt trực tiếp trên bản vẽ 2D để trang trí in ấn</p>
              </div>
            )}
          </div>

          {/* METADATA INDIVIDUAL SPECIFICATIONS COMPRESSION */}
          <div className="p-5 border-t border-[#2A2A2A] bg-[#121212] mt-auto shrink-0">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[#888888] font-bold mb-3">
              <Package size={12} className="text-gray-400" />
              <span>Sản Lượng Cơ Học Hộp (Specs)</span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs text-gray-400">
              <div className="bg-[#1E1E1E] border border-[#333] p-2.5 rounded">
                <div className="text-[10px] text-gray-500 uppercase font-mono">Bảng trải lớn (Flat Sheet)</div>
                <div className="font-mono text-white font-bold mt-1 text-xs">
                  {stats.flatWidth}x{stats.flatHeight} <span className="text-[10px] text-gray-500">mm</span>
                </div>
              </div>
              <div className="bg-[#1E1E1E] border border-[#333] p-2.5 rounded">
                <div className="text-[10px] text-gray-500 uppercase font-mono">D.Tích giấy bìa layout</div>
                <div className="font-mono text-white font-bold mt-1 text-xs">{stats.areaInCm2} cm²</div>
              </div>
              <div className="bg-[#1E1E1E] border border-[#333] p-2.5 rounded">
                <div className="text-[10px] text-gray-500 uppercase font-mono">Trọng lượng hộp ước lượng</div>
                <div className="font-mono text-white font-bold mt-1 text-xs">~{stats.weightGrms} g</div>
              </div>
              <div className="bg-[#1E1E1E] border border-[#333] p-2.5 rounded">
                <div className="text-[10px] text-gray-500 uppercase font-mono">Thể tích hộp phủ bì</div>
                <div className="font-mono text-orange-400 font-bold mt-1 text-xs">{stats.estimatedVolumeLtr} Lít</div>
              </div>
            </div>

            <div className="mt-3.5 text-[10.5px] text-gray-500 flex items-start gap-1">
              <Info size={11} className="shrink-0 mt-0.5" />
              <span>Thay đổi góc gập hoặc kéo thanh trượt kích thước để xem dieline & amp; mô phỏng 3D lắp ráp hoàn thiện.</span>
            </div>
          </div>

        </aside>

        {/* WORKSPACE PREVIEW ENGINES DISPLAY */}
        <div className="flex-1 bg-[#0A0A0A] p-5 pb-20 flex flex-col gap-4 overflow-hidden relative">
          
          <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-5 h-full min-h-0">
            {/* Split screen display */}
            {(viewMode === 'split' || viewMode === '2d') && (
              <div className={`h-full min-h-0 ${viewMode === '2d' ? 'col-span-2' : ''}`}>
                <Dieline2D
                  state={sharedState}
                  selectedPanelId={selectedPanelId}
                  onSelectPanel={(id) => setSelectedPanelId(id)}
                />
              </div>
            )}
            
            {(viewMode === 'split' || viewMode === '3d') && (
              <div className={`h-full min-h-0 ${viewMode === '3d' ? 'col-span-2' : ''}`}>
                <Visualizer3D state={sharedState} />
              </div>
            )}
          </div>

          {/* FLOATING HUD ASSEMBLY SLIDER BAR */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 bg-[#161616]/95 backdrop-blur-md border border-orange-500/30 px-6 py-4 rounded-full shadow-2xl flex flex-col sm:flex-row items-center gap-4 w-[92%] max-w-[580px] border-b-2 border-b-orange-500">
            <div className="flex items-center gap-3 shrink-0 self-start sm:self-auto">
              <div className="w-2.5 h-2.5 bg-orange-500 rounded-full animate-pulse shadow-md shadow-orange-500/50"></div>
              <div className="flex flex-col">
                <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider leading-none mb-1">MÔ PHỎNG LẮP GHÉP HỘP</span>
                <span className="text-xs text-orange-400 font-mono font-bold bg-[#222] px-2 py-0.5 rounded border border-[#333]">{(foldProgress * 100).toFixed(0)}% Hoàn thành</span>
              </div>
            </div>
            
            <div className="flex-1 flex items-center gap-3 w-full">
              <span className="text-[10px] text-gray-500 font-mono font-extrabold shrink-0">Phẳng (2D)</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                id="main-fold-slider"
                value={foldProgress}
                onChange={(e) => {
                  setFoldProgress(parseFloat(e.target.value));
                  setIsPlaying(false);
                }}
                className="flex-1 h-3 bg-[#2A2A2A] rounded-lg appearance-none cursor-pointer accent-orange-500 hover:accent-orange-400 border border-[#3a3a3a]"
              />
              <span className="text-[10px] text-orange-500 font-mono font-extrabold shrink-0">Hộp Gập (3D)</span>
            </div>
          </div>

        </div>

      </main>
    </div>
  );
}
