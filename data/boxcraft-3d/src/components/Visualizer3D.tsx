import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BoxState, PanelDesign } from '../types';

interface Visualizer3DProps {
  state: BoxState;
}

export const Visualizer3D: React.FC<Visualizer3DProps> = ({ state }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);

  // Keep stateRef up to date to prevent closures lagging in the render loop if any
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth || 500;
    const height = container.clientHeight || 450;

    // SCENE
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0A0A0A');

    // CAMERA
    const camera = new THREE.PerspectiveCamera(45, width / height, 1, 2500);
    camera.position.set(250, 300, 350);

    // RENDERER
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // CONTROLS
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 + 0.15; // prevent going too far under ground
    controls.minDistance = 100;
    controls.maxDistance = 1200;

    // LIGHTS
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambientLight);

    // Studio Keylight
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
    keyLight.position.set(200, 450, 250);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.bias = -0.001;
    scene.add(keyLight);

    // Soft backlight for packaging reflections
    const fillLight = new THREE.DirectionalLight(0xe0f2fe, 0.45);
    fillLight.position.set(-200, 200, -200);
    scene.add(fillLight);

    // Subtle floor light bouncing
    const groundLight = new THREE.DirectionalLight(0xffedd5, 0.2);
    groundLight.position.set(0, -300, 0);
    scene.add(groundLight);

    // STAGE FLOOR (Sleek dark mirror floor with shadow reception)
    const floorGeo = new THREE.PlaneGeometry(1500, 1500);
    const floorMat = new THREE.ShadowMaterial({ opacity: 0.12 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -110;
    floor.receiveShadow = true;
    scene.add(floor);

    // Grid helper for precise desktop feel
    const gridHelper = new THREE.GridHelper(1000, 40, '#2d2e33', '#1e1f22');
    gridHelper.position.y = -109.5;
    scene.add(gridHelper);

    // DRAW STICKERS TO CANVAS
    const drawStickerOnCanvas = (
      ctx: CanvasRenderingContext2D,
      type: string,
      x: number,
      y: number,
      size: number,
      color: string,
      bgColor: string
    ) => {
      ctx.save();
      ctx.translate(x, y);

      const outlineColor = bgColor === '#ffffff' || bgColor === '#f4f4f5' ? '#000000' : '#ffffff';
      ctx.strokeStyle = outlineColor;
      ctx.lineWidth = size * 0.12;
      ctx.fillStyle = color;

      if (type === 'heart') {
        const s = size * 0.75;
        ctx.beginPath();
        ctx.moveTo(0, s / 4);
        ctx.bezierCurveTo(0, -s / 2, -s, -s / 2, -s, s / 4);
        ctx.bezierCurveTo(-s, s * 0.8, 0, s * 1.1, 0, s * 1.3);
        ctx.bezierCurveTo(0, s * 1.1, s, s * 0.8, s, s / 4);
        ctx.bezierCurveTo(s, -s / 2, 0, -s / 2, 0, s / 4);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
      } else if (type === 'star') {
        const points = 5;
        const outerRadius = size * 0.85;
        const innerRadius = size * 0.35;
        ctx.beginPath();
        for (let i = 0; i < points * 2; i++) {
          const angle = (Math.PI * i) / points - Math.PI / 2;
          const r = i % 2 === 0 ? outerRadius : innerRadius;
          ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
      } else if (type === 'gift') {
        const w = size * 1.2;
        const h = size * 1.2;
        // Box
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        ctx.fillRect(-w / 2, -h / 2, w, h);
        // Ribbons
        ctx.fillStyle = outlineColor;
        ctx.fillRect(-w * 0.1, -h / 2, w * 0.2, h);
        ctx.fillRect(-w / 2, -h * 0.1, w, h * 0.2);
        // Bow tie loop curves
        ctx.beginPath();
        ctx.arc(-w * 0.2, -h / 2 - w * 0.1, w * 0.15, 0, Math.PI * 2);
        ctx.arc(w * 0.2, -h / 2 - w * 0.1, w * 0.15, 0, Math.PI * 2);
        ctx.strokeStyle = outlineColor;
        ctx.lineWidth = size * 0.1;
        ctx.stroke();
      } else if (type === 'smile') {
        ctx.beginPath();
        ctx.arc(0, 0, size * 0.9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
        // Eyes
        ctx.fillStyle = outlineColor;
        ctx.beginPath();
        ctx.arc(-size * 0.3, -size * 0.2, size * 0.15, 0, Math.PI * 2);
        ctx.arc(size * 0.3, -size * 0.2, size * 0.15, 0, Math.PI * 2);
        ctx.fill();
        // Mouth
        ctx.beginPath();
        ctx.arc(0, size * 0.1, size * 0.45, 0, Math.PI);
        ctx.stroke();
      } else if (type === 'leaf') {
        ctx.beginPath();
        ctx.ellipse(0, 0, size * 0.8, size * 0.45, Math.PI / 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
        // Stem line
        ctx.beginPath();
        ctx.moveTo(-size * 0.8, size * 0.8);
        ctx.lineTo(size * 0.8, -size * 0.8);
        ctx.strokeStyle = outlineColor;
        ctx.stroke();
      } else if (type === 'coffee') {
        const r = size * 0.7;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI);
        ctx.lineTo(r, -r * 0.4);
        ctx.lineTo(-r, -r * 0.4);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
        // Handle
        ctx.beginPath();
        ctx.arc(r * 0.9, -r * 0.1, r * 0.4, -Math.PI / 2, Math.PI / 2);
        ctx.stroke();
        // Steam strings
        ctx.beginPath();
        ctx.moveTo(-r * 0.3, -r * 0.7);
        ctx.bezierCurveTo(-r * 0.4, -r * 1.0, -r * 0.1, -r * 1.1, -r * 0.25, -r * 1.4);
        ctx.moveTo(r * 0.1, -r * 0.7);
        ctx.bezierCurveTo(0, -r * 1.0, r * 0.3, -r * 1.1, r * 0.15, -r * 1.4);
        ctx.stroke();
      } else if (type === 'sparkles') {
        ctx.fillStyle = color;
        const drawSingleStar = (ox: number, oy: number, r: number) => {
          ctx.beginPath();
          ctx.moveTo(ox, oy - r);
          ctx.quadraticCurveTo(ox, oy, ox + r, oy);
          ctx.quadraticCurveTo(ox, oy, ox, oy + r);
          ctx.quadraticCurveTo(ox, oy, ox - r, oy);
          ctx.quadraticCurveTo(ox, oy, ox, oy - r);
          ctx.closePath();
          ctx.fill();
        };
        drawSingleStar(0, -size * 0.4, size * 0.5);
        drawSingleStar(-size * 0.5, size * 0.3, size * 0.35);
        drawSingleStar(size * 0.5, size * 0.2, size * 0.3);
      } else {
        // generic circle badge
        ctx.beginPath();
        ctx.arc(0, 0, size * 0.7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
      }

      ctx.restore();
    };

    // CREATE DYNAMIC SHAPES FOR DIELINE ACCURACY (NOT PLAIN RECTANGLES)
    const createShapeForPanel = (id: string, w: number, h: number, mirrorX: boolean = false): THREE.Shape => {
      const shape = new THREE.Shape();
      const lowerId = id.toLowerCase();

      // If mirrored, flip horizontal signs
      const x0 = mirrorX ? w / 2 : -w / 2;
      const x1 = mirrorX ? -w / 2 : w / 2;
      const y0 = -h / 2;
      const y1 = h / 2;

      if (lowerId.includes('tuck')) {
        // Round tuck flap (curved corners for insertion smoothness)
        const r = Math.min(h * 0.7, w * 0.22, 12);
        
        shape.moveTo(x0, y0);
        shape.lineTo(x0, y1 - r);
        shape.quadraticCurveTo(x0, y1, x0 + (mirrorX ? -r : r), y1);
        shape.lineTo(x1 - (mirrorX ? -r : r), y1);
        shape.quadraticCurveTo(x1, y1, x1, y1 - r);
        shape.lineTo(x1, y0);
        shape.closePath();
      } else if (lowerId.includes('dust') || lowerId.includes('ear')) {
        // Tapered dust flaps (trapezoidal slant to prevent collisions inside)
        const taperWidth = w * 0.18; // inset on each side
        const straightY = y0 + h * 0.2; // keep 20% flat near fold line for strength
        
        shape.moveTo(x0, y0);
        shape.lineTo(x0, straightY);
        shape.lineTo(x0 + (mirrorX ? -taperWidth : taperWidth), y1);
        shape.lineTo(x1 - (mirrorX ? -taperWidth : taperWidth), y1);
        shape.lineTo(x1, straightY);
        shape.lineTo(x1, y0);
        shape.closePath();
      } else if (lowerId.includes('glue')) {
        // Glue flaps slant vắt góc nhọn
        const carveVal = Math.min(w * 0.45, 10);
        
        // Starts at hinge edge which is on the right side (+X side)
        shape.moveTo(x1, y0);
        shape.lineTo(x0 + (mirrorX ? -carveVal : carveVal), y0);
        shape.lineTo(x0, y0 + carveVal);
        shape.lineTo(x0, y1 - carveVal);
        shape.lineTo(x0 + (mirrorX ? -carveVal : carveVal), y1);
        shape.lineTo(x1, y1);
        shape.closePath();
      } else {
        // Standard rectangle for major panels
        shape.moveTo(x0, y0);
        shape.lineTo(x0, y1);
        shape.lineTo(x1, y1);
        shape.lineTo(x1, y0);
        shape.closePath();
      }

      return shape;
    };

    // GENERATE RICH TEXTURED DUAL CANVAS MATERIALS
    const makeDoubleSidedPanelGeometry = (
      panelId: string,
      w: number,
      h: number,
      design: PanelDesign,
      materialType: 'matte' | 'glossy' | 'kraft',
      cardboardThickness: number = 0.8
    ): THREE.Group => {
      const panelGroup = new THREE.Group();

      // We will create two planes slightly set back-to-back to prevent Z-fighting and look realistic
      const offsetZ = cardboardThickness / 2 + 0.05;

      // Use shape geometry to reflect authentic dielines (with bevels and fillets)
      const shape = createShapeForPanel(panelId, w, h, false);
      const innerShape = createShapeForPanel(panelId, w, h, true);
      const outerGeo = new THREE.ShapeGeometry(shape);
      const innerGeo = new THREE.ShapeGeometry(innerShape);
      innerGeo.rotateY(Math.PI); // inner panel rotated 180deg to face inward

      // 1. OUTER TEXTURE CANVAS
      const canvasOut = document.createElement('canvas');
      const scale = 5; // dynamic scaling for extreme crisp graphics
      canvasOut.width = Math.max(w * scale, 64);
      canvasOut.height = Math.max(h * scale, 64);
      const ctxO = canvasOut.getContext('2d')!;

      // Background color
      if (materialType === 'kraft') {
        ctxO.fillStyle = '#e5ba8f'; // Kraft cardboard krafty brown
        ctxO.fillRect(0, 0, canvasOut.width, canvasOut.height);
        // Draw fiber patterns for organic cardboard look
        ctxO.fillStyle = '#dbab7d';
        for (let i = 0; i < 200; i++) {
          const fx = Math.random() * canvasOut.width;
          const fy = Math.random() * canvasOut.height;
          const fw = Math.random() * 8 + 2;
          ctxO.fillRect(fx, fy, fw, 1.5);
        }
      } else {
        ctxO.fillStyle = design.backgroundColor || '#ffffff';
        ctxO.fillRect(0, 0, canvasOut.width, canvasOut.height);
      }

      // Draw custom sticker
      if (design.sticker) {
        const sx = (design.stickerX / 100) * canvasOut.width;
        const sy = (design.stickerY / 100) * canvasOut.height;
        const ssize = (design.stickerScale / 100) * Math.min(canvasOut.width, canvasOut.height) * 1.5;
        drawStickerOnCanvas(ctxO, design.sticker, sx, sy, ssize, design.textColor, design.backgroundColor);
      }

      // Draw custom text
      if (design.text) {
        ctxO.save();
        const tx = (design.textX / 100) * canvasOut.width;
        const ty = (design.textY / 100) * canvasOut.height;
        ctxO.translate(tx, ty);
        ctxO.rotate((design.textRotation * Math.PI) / 180);

        const calculatedFontSize = Math.max((design.textSize / 100) * Math.min(canvasOut.width, canvasOut.height) * 1.3, 10);
        ctxO.font = `bold ${calculatedFontSize}px Inter, system-ui, sans-serif`;
        ctxO.fillStyle = design.textColor || '#000000';
        ctxO.textAlign = 'center';
        ctxO.textBaseline = 'middle';

        // simple text shadow for premium look
        ctxO.shadowColor = 'rgba(0,0,0,0.15)';
        ctxO.shadowBlur = 4;
        ctxO.shadowOffsetX = 1;
        ctxO.shadowOffsetY = 2;

        ctxO.fillText(design.text, 0, 0);
        ctxO.restore();
      }

      // Create outer material
      const textureOut = new THREE.CanvasTexture(canvasOut);
      textureOut.colorSpace = THREE.SRGBColorSpace;
      
      const roughVal = materialType === 'glossy' ? 0.15 : materialType === 'kraft' ? 0.95 : 0.6;
      const metalVal = materialType === 'glossy' ? 0.08 : 0.0;
      
      const outerMat = new THREE.MeshStandardMaterial({
        map: textureOut,
        roughness: roughVal,
        metalness: metalVal,
        side: THREE.FrontSide,
        bumpScale: 0.15,
      });

      // 2. INNER SURFACE CANVAS
      const canvasIn = document.createElement('canvas');
      canvasIn.width = 64;
      canvasIn.height = 64;
      const ctxI = canvasIn.getContext('2d')!;

      if (materialType === 'kraft') {
        ctxI.fillStyle = '#cca075';
        ctxI.fillRect(0, 0, 64, 64);
      } else {
        ctxI.fillStyle = '#fafafa';
        ctxI.fillRect(0, 0, 64, 64);
        ctxI.fillStyle = '#f4f4f5';
        ctxI.fillRect(2, 2, 60, 60);
      }

      const textureIn = new THREE.CanvasTexture(canvasIn);
      const innerMat = new THREE.MeshStandardMaterial({
        map: textureIn,
        roughness: 0.85,
        metalness: 0.0,
        side: THREE.FrontSide,
      });

      // Create outer mesh
      const outerMesh = new THREE.Mesh(outerGeo, outerMat);
      outerMesh.position.z = offsetZ;
      outerMesh.castShadow = true;
      outerMesh.receiveShadow = true;
      panelGroup.add(outerMesh);

      // Create inner mesh
      const innerMesh = new THREE.Mesh(innerGeo, innerMat);
      innerMesh.position.z = -offsetZ;
      innerMesh.castShadow = true;
      innerMesh.receiveShadow = true;
      panelGroup.add(innerMesh);

      // Edge border cardboard mesh (only for main panels to align perfectly without overlapping cut bevels)
      const lowerId = panelId.toLowerCase();
      const isMainPanel = !lowerId.includes('tuck') && 
                          !lowerId.includes('dust') && 
                          !lowerId.includes('ear') && 
                          !lowerId.includes('glue') && 
                          !lowerId.includes('roll');

      if (isMainPanel) {
        const edgeColor = materialType === 'kraft' ? 0xd0a375 : 0xf1f1f4;
        const edgeMat = new THREE.MeshStandardMaterial({
          color: edgeColor,
          roughness: 0.9,
        });
        
        const edgeTopGeo = new THREE.BoxGeometry(w, cardboardThickness, cardboardThickness);
        const edgeTop = new THREE.Mesh(edgeTopGeo, edgeMat);
        edgeTop.position.set(0, h/2, 0);
        panelGroup.add(edgeTop);

        const edgeBottom = edgeTop.clone();
        edgeBottom.position.set(0, -h/2, 0);
        panelGroup.add(edgeBottom);

        const edgeLeftGeo = new THREE.BoxGeometry(cardboardThickness, h, cardboardThickness);
        const edgeLeft = new THREE.Mesh(edgeLeftGeo, edgeMat);
        edgeLeft.position.set(-w/2, 0, 0);
        panelGroup.add(edgeLeft);

        const edgeRight = edgeLeft.clone();
        edgeRight.position.set(w/2, 0, 0);
        panelGroup.add(edgeRight);
      }

      return panelGroup;
    };

    // ACTIVE MODEL GRAPHICS NODE
    let currentBoxObject: THREE.Group | null = null;

    const buildBoxModel = (boxState: BoxState) => {
      const { type, dimensions, foldProgress, designs, material } = boxState;
      const { width: W, height: H, depth: D, flap: F } = dimensions;

      // Folding angles
      const foldRatio = foldProgress; // 0 flat, 1 folded
      const foldRad = foldRatio * (Math.PI / 2); // 90 degree folds

      const modelGroup = new THREE.Group();

      const getDesignOf = (id: string): PanelDesign => {
        return designs[id] || {
          panelId: id,
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
      };

      if (type === 'tuck-end') {
        // === STANDARD TUCK END BOX TREE ===
        // Stationary root: Front Panel
        const frontGroup = makeDoubleSidedPanelGeometry('front', W, H, getDesignOf('front'), material);
        modelGroup.add(frontGroup);

        // 1. LEFT PINION
        const leftPivot = new THREE.Group();
        leftPivot.position.set(-W / 2, 0, 0);
        leftPivot.rotation.y = -foldRad;
        frontGroup.add(leftPivot);

        const leftPanel = makeDoubleSidedPanelGeometry('left', D, H, getDesignOf('left'), material);
        leftPanel.position.set(-D / 2, 0, 0);
        leftPivot.add(leftPanel);

        // 1.1 BACK PINION (Attached to Left Panel)
        const backPivot = new THREE.Group();
        backPivot.position.set(-D, 0, 0);
        backPivot.rotation.y = -foldRad;
        leftPivot.add(backPivot);

        const backPanel = makeDoubleSidedPanelGeometry('back', W, H, getDesignOf('back'), material);
        backPanel.position.set(-W / 2, 0, 0);
        backPivot.add(backPanel);

        // 1.1.1 GLUE FLAP (Attached to Back Panel)
        const gluePivot = new THREE.Group();
        gluePivot.position.set(-W, 0, 0);
        gluePivot.rotation.y = -foldRad * 1.05;
        backPivot.add(gluePivot);

        const glueFlap = makeDoubleSidedPanelGeometry('glue', F * 0.7, H - 6, getDesignOf('glue'), material);
        glueFlap.position.set(-F * 0.35, 0, 0);
        gluePivot.add(glueFlap);

        // 2. RIGHT PANEL PIECE
        const rightPivot = new THREE.Group();
        rightPivot.position.set(W / 2, 0, 0);
        rightPivot.rotation.y = foldRad;
        frontGroup.add(rightPivot);

        const rightPanel = makeDoubleSidedPanelGeometry('right', D, H, getDesignOf('right'), material);
        rightPanel.position.set(D / 2, 0, 0);
        rightPivot.add(rightPanel);

        // 3. TOP LID (Folds from Front Top edge)
        const topPivot = new THREE.Group();
        topPivot.position.set(0, H / 2, 0);
        topPivot.rotation.x = -foldRad;
        frontGroup.add(topPivot);

        const topPanel = makeDoubleSidedPanelGeometry('top', W, D, getDesignOf('top'), material);
        topPanel.position.set(0, D / 2, 0);
        topPivot.add(topPanel);

        // 3.1 TOP TUCK FLAP (Folds from Top Lid top edge)
        const topTuckPivot = new THREE.Group();
        topTuckPivot.position.set(0, D / 2, 0);
        topTuckPivot.rotation.x = -foldRad;
        topPanel.add(topTuckPivot);

        const topTuckFlap = makeDoubleSidedPanelGeometry('topTuck', W - 6, F, getDesignOf('topTuck'), material);
        topTuckFlap.position.set(0, F / 2, 0);
        topTuckPivot.add(topTuckFlap);

        // 4. BOTTOM LID (Folds from Front Bottom edge)
        const bottomPivot = new THREE.Group();
        bottomPivot.position.set(0, -H / 2, 0);
        bottomPivot.rotation.z = Math.PI; // Rotate 180 degrees around Z so it faces downwards correctly
        bottomPivot.rotation.x = foldRad; // Positive rotation folds it backwards towards -Z
        frontGroup.add(bottomPivot);

        const bottomPanel = makeDoubleSidedPanelGeometry('bottom', W, D, getDesignOf('bottom'), material);
        bottomPanel.position.set(0, D / 2, 0); // Positive offset just like top lid!
        bottomPivot.add(bottomPanel);

        // 4.1 BOTTOM TUCK FLAP
        const bottomTuckPivot = new THREE.Group();
        bottomTuckPivot.position.set(0, D / 2, 0); // Positive offset like top lid!
        bottomTuckPivot.rotation.x = -foldRad; // Negative rotation tucks it inside
        bottomPanel.add(bottomTuckPivot);

        const bottomTuckFlap = makeDoubleSidedPanelGeometry('bottomTuck', W - 8, F, getDesignOf('bottomTuck'), material);
        bottomTuckFlap.position.set(0, F / 2, 0); // Positive offset like top lid!
        bottomTuckPivot.add(bottomTuckFlap);

        // 5. SIDE COVERS: DUST FLAPS (attached to Left & Right panels, fold inside top and bottom)
        const leftDustTopPivot = new THREE.Group();
        leftDustTopPivot.position.set(0, H / 2, 0);
        leftDustTopPivot.rotation.x = -foldRad; // Negative rotation folds it inwards
        leftPanel.add(leftDustTopPivot);
        const leftDustTop = makeDoubleSidedPanelGeometry('leftDustTop', D - 6, D * 0.8, getDesignOf('leftDustTop'), material);
        leftDustTop.position.set(0, (D * 0.8) / 2, 0);
        leftDustTopPivot.add(leftDustTop);

        const rightDustTopPivot = new THREE.Group();
        rightDustTopPivot.position.set(0, H / 2, 0);
        rightDustTopPivot.rotation.x = -foldRad; // Negative rotation folds it inwards
        rightPanel.add(rightDustTopPivot);
        const rightDustTop = makeDoubleSidedPanelGeometry('rightDustTop', D - 6, D * 0.8, getDesignOf('rightDustTop'), material);
        rightDustTop.position.set(0, (D * 0.8) / 2, 0);
        rightDustTopPivot.add(rightDustTop);

        // Bottom left dust flap (attached to Left, folds inside top and bottom)
        const leftDustBottomPivot = new THREE.Group();
        leftDustBottomPivot.position.set(0, -H / 2, 0);
        leftDustBottomPivot.rotation.z = Math.PI; // Rotate 180 degrees around Z so it faces downwards correctly
        leftDustBottomPivot.rotation.x = foldRad; // Positive rotation folds it inwards
        leftPanel.add(leftDustBottomPivot);
        const leftDustBottom = makeDoubleSidedPanelGeometry('leftDustBottom', D - 6, D * 0.8, getDesignOf('leftDustBottom'), material);
        leftDustBottom.position.set(0, (D * 0.8) / 2, 0); // Positive offset
        leftDustBottomPivot.add(leftDustBottom);

        // Bottom right dust flap (attached to Right, folds inside top and bottom)
        const rightDustBottomPivot = new THREE.Group();
        rightDustBottomPivot.position.set(0, -H / 2, 0);
        rightDustBottomPivot.rotation.z = Math.PI; // Rotate 180 degrees around Z so it faces downwards correctly
        rightDustBottomPivot.rotation.x = foldRad; // Positive rotation folds it inwards
        rightPanel.add(rightDustBottomPivot);
        const rightDustBottom = makeDoubleSidedPanelGeometry('rightDustBottom', D - 6, D * 0.8, getDesignOf('rightDustBottom'), material);
        rightDustBottom.position.set(0, (D * 0.8) / 2, 0); // Positive offset
        rightDustBottomPivot.add(rightDustBottom);

        // Center entire model in view space
        modelGroup.position.set(0, 0, 0);

      } else if (type === 'mailer') {
        // === MAILER BOX 3D FOLD TREE ===
        // Stationary root: Bottom Panel (W x D) lying horizontal in XZ-plane at y = -30
        const bottomGroup = makeDoubleSidedPanelGeometry('bottom', W, D, getDesignOf('bottom'), material);
        bottomGroup.rotation.x = -Math.PI / 2; // Lie flat on floor
        modelGroup.add(bottomGroup);

        // 1. REAR WALL (Folds UP on rear edge z = -D/2)
        const rearPivot = new THREE.Group();
        rearPivot.position.set(0, D / 2, 0);
        rearPivot.rotation.x = -foldRad;
        bottomGroup.add(rearPivot);

        const rearWall = makeDoubleSidedPanelGeometry('rearWall', W, H, getDesignOf('rearWall'), material);
        rearWall.position.set(0, H / 2, 0);
        rearPivot.add(rearWall);

        // 1.05 REAR WALL DUST WINGS (Left/Right)
        const rearLeftDustPivot = new THREE.Group();
        rearLeftDustPivot.position.set(-W / 2, 0, 0);
        rearLeftDustPivot.rotation.y = -foldRad;
        rearWall.add(rearLeftDustPivot);

        const rearLeftDust = makeDoubleSidedPanelGeometry('rearLeftDust', F, H - 4, getDesignOf('rearLeftDust'), material);
        rearLeftDust.position.set(-F / 2, 0, 0);
        rearLeftDustPivot.add(rearLeftDust);

        const rearRightDustPivot = new THREE.Group();
        rearRightDustPivot.position.set(W / 2, 0, 0);
        rearRightDustPivot.rotation.y = foldRad;
        rearWall.add(rearRightDustPivot);

        const rearRightDust = makeDoubleSidedPanelGeometry('rearRightDust', F, H - 4, getDesignOf('rearRightDust'), material);
        rearRightDust.position.set(F / 2, 0, 0);
        rearRightDustPivot.add(rearRightDust);

        // 1.1 TOP COVER LID (Attached to Rear wall top edge)
        const topPivot = new THREE.Group();
        topPivot.position.set(0, H, 0);
        topPivot.rotation.x = -foldRad;
        rearWall.add(topPivot);

        const topPanel = makeDoubleSidedPanelGeometry('top', W, D, getDesignOf('top'), material);
        topPanel.position.set(0, D / 2, 0);
        topPivot.add(topPanel);

        // 1.1.1 TOP TUCK FLAP
        const topTuckPivot = new THREE.Group();
        topTuckPivot.position.set(0, D / 2, 0);
        topTuckPivot.rotation.x = -foldRad;
        topPanel.add(topTuckPivot);

        const topTuck = makeDoubleSidedPanelGeometry('topTuck', W - 8, F, getDesignOf('topTuck'), material);
        topTuck.position.set(0, F / 2, 0);
        topTuckPivot.add(topTuck);

        // 1.1.2 TOP LID SIDE EARS (Left/Right)
        const topLeftEarPivot = new THREE.Group();
        topLeftEarPivot.position.set(-W / 2, D / 2, 0);
        topLeftEarPivot.rotation.y = -foldRad;
        topPanel.add(topLeftEarPivot);

        const topLeftEar = makeDoubleSidedPanelGeometry('topLeftEar', F, D - 4, getDesignOf('topLeftEar'), material);
        topLeftEar.position.set(-F / 2, 0, 0);
        topLeftEarPivot.add(topLeftEar);

        const topRightEarPivot = new THREE.Group();
        topRightEarPivot.position.set(W / 2, D / 2, 0);
        topRightEarPivot.rotation.y = foldRad;
        topPanel.add(topRightEarPivot);

        const topRightEar = makeDoubleSidedPanelGeometry('topRightEar', F, D - 4, getDesignOf('topRightEar'), material);
        topRightEar.position.set(F / 2, 0, 0);
        topRightEarPivot.add(topRightEar);

        // 2. FRONT WALL (Folds UP from Bottom Front edge)
        const frontPivot = new THREE.Group();
        frontPivot.position.set(0, -D / 2, 0);
        frontPivot.rotation.x = foldRad;
        bottomGroup.add(frontPivot);

        const frontWall = makeDoubleSidedPanelGeometry('frontWall', W, H, getDesignOf('frontWall'), material);
        frontWall.position.set(0, -H / 2, 0);
        frontPivot.add(frontWall);

        // 2.05 FRONT WALL DUST WINGS (Left/Right)
        const frontLeftDustPivot = new THREE.Group();
        frontLeftDustPivot.position.set(-W / 2, 0, 0);
        frontLeftDustPivot.rotation.y = -foldRad;
        frontWall.add(frontLeftDustPivot);

        const frontLeftDust = makeDoubleSidedPanelGeometry('frontLeftDust', F, H - 4, getDesignOf('frontLeftDust'), material);
        frontLeftDust.position.set(-F / 2, 0, 0);
        frontLeftDustPivot.add(frontLeftDust);

        const frontRightDustPivot = new THREE.Group();
        frontRightDustPivot.position.set(W / 2, 0, 0);
        frontRightDustPivot.rotation.y = foldRad;
        frontWall.add(frontRightDustPivot);

        const frontRightDust = makeDoubleSidedPanelGeometry('frontRightDust', F, H - 4, getDesignOf('frontRightDust'), material);
        frontRightDust.position.set(F / 2, 0, 0);
        frontRightDustPivot.add(frontRightDust);

        // 2.1 FRONT TUCK INNER ROUND ROLL
        const frontRollPivot = new THREE.Group();
        frontRollPivot.position.set(0, -H / 2, 0);
        frontRollPivot.rotation.x = foldRad;
        frontWall.add(frontRollPivot);

        const frontRoll = makeDoubleSidedPanelGeometry('frontRoll', W - 4, H - 2, getDesignOf('frontRoll'), material);
        frontRoll.position.set(0, -(H - 2) / 2, 0);
        frontRollPivot.add(frontRoll);

        // 3. LEFT OUTER WALL (Folds UP from Left edge)
        const leftWallPivot = new THREE.Group();
        leftWallPivot.position.set(-W / 2, 0, 0);
        leftWallPivot.rotation.y = -foldRad;
        bottomGroup.add(leftWallPivot);

        const leftOuterWall = makeDoubleSidedPanelGeometry('leftWall', H, D, getDesignOf('leftWall'), material);
        leftOuterWall.position.set(-H / 2, 0, 0);
        leftWallPivot.add(leftOuterWall);

        // 3.1 LEFT INNER FOLD ROUND ROLL LINK
        const leftRollPivot = new THREE.Group();
        leftRollPivot.position.set(-H / 2, 0, 0);
        leftRollPivot.rotation.y = -foldRad;
        leftOuterWall.add(leftRollPivot);

        const leftRoll = makeDoubleSidedPanelGeometry('leftRoll', H - 2, D - 4, getDesignOf('leftRoll'), material);
        leftRoll.position.set(-(H - 2) / 2, 0, 0);
        leftRollPivot.add(leftRoll);

        // 4. RIGHT OUTER WALL (Folds UP from Right edge)
        const rightWallPivot = new THREE.Group();
        rightWallPivot.position.set(W / 2, 0, 0);
        rightWallPivot.rotation.y = foldRad;
        bottomGroup.add(rightWallPivot);

        const rightOuterWall = makeDoubleSidedPanelGeometry('rightWall', H, D, getDesignOf('rightWall'), material);
        rightOuterWall.position.set(H / 2, 0, 0);
        rightWallPivot.add(rightOuterWall);

        // 4.1 RIGHT INNER FOLD ROUND ROLL LINK
        const rightRollPivot = new THREE.Group();
        rightRollPivot.position.set(H / 2, 0, 0);
        rightRollPivot.rotation.y = foldRad;
        rightOuterWall.add(rightRollPivot);

        const rightRoll = makeDoubleSidedPanelGeometry('rightRoll', H - 2, D - 4, getDesignOf('rightRoll'), material);
        rightRoll.position.set((H - 2) / 2, 0, 0);
        rightRollPivot.add(rightRoll);

        // Shift model upwards and center
        modelGroup.position.set(0, 0, 0);

      } else {
        // === GIFT BOX: TRAY AND SLEEVE GẤP VÀ TRƯỢT ===
        // Drawer is nested inside the sleeve.
        // Opening animation splits them up!
        // foldProgress = 0.0 -> flat side-by-side sheets on the floor
        // foldProgress = 0.5 -> both fully folded but Drawer is fully slid out of Sleeve!
        // foldProgress = 1.0 -> both fully folded and Drawer is tucked completely inside Sleeve!

        // Let's implement this gorgeous sliding workflow:
        const isFlat = foldRatio < 0.15;
        
        // 1. THE SLEEVE PIECE Group (outer cover tube)
        // If flat, placed on right. If folded, centered at (0, 0, 0)
        const sleeveGroup = new THREE.Group();
        modelGroup.add(sleeveGroup);

        if (isFlat) {
          sleeveGroup.position.set(W + 50, -40, 0);
        } else {
          sleeveGroup.position.set(0, 0, 0);
        }

        // Sleeve Panels (Top: stationary root of Sleeve, size W x D)
        const sleeveTop = makeDoubleSidedPanelGeometry('sleeveTop', W, D, getDesignOf('sleeveTop'), material);
        sleeveTop.rotation.x = -Math.PI / 2;
        sleeveGroup.add(sleeveTop);

        // Right side folds down by 90
        const slRightPivot = new THREE.Group();
        slRightPivot.position.set(W / 2, 0, 0);
        slRightPivot.rotation.y = -foldRad;
        sleeveTop.add(slRightPivot);
        const sleeveRight = makeDoubleSidedPanelGeometry('sleeveRight', H, D, getDesignOf('sleeveRight'), material);
        sleeveRight.position.set(H / 2, 0, 0);
        slRightPivot.add(sleeveRight);

        // Bottom side folds relative to Right by 90
        const slBotPivot = new THREE.Group();
        slBotPivot.position.set(H, 0, 0);
        slBotPivot.rotation.y = -foldRad;
        slRightPivot.add(slBotPivot);
        const sleeveBottom = makeDoubleSidedPanelGeometry('sleeveBottom', W, D, getDesignOf('sleeveBottom'), material);
        sleeveBottom.position.set(W / 2, 0, 0);
        slBotPivot.add(sleeveBottom);

        // Left side folds relative to Bottom by 90
        const slLeftPivot = new THREE.Group();
        slLeftPivot.position.set(W, 0, 0);
        slLeftPivot.rotation.y = -foldRad;
        slBotPivot.add(slLeftPivot);
        const sleeveLeft = makeDoubleSidedPanelGeometry('sleeveLeft', H, D, getDesignOf('sleeveLeft'), material);
        sleeveLeft.position.set(H / 2, 0, 0);
        slLeftPivot.add(sleeveLeft);

        // Glue Joint folds relative to Left by 90
        const slGluePivot = new THREE.Group();
        slGluePivot.position.set(H, 0, 0);
        slGluePivot.rotation.y = -foldRad;
        slLeftPivot.add(slGluePivot);
        const sleeveGlue = makeDoubleSidedPanelGeometry('sleeveGlue', F * 0.6, D - 8, getDesignOf('sleeveGlue'), material);
        sleeveGlue.position.set((F * 0.6) / 2, 0, 0);
        slGluePivot.add(sleeveGlue);


        // 2. THE TRAY / DRAWER PIECE Group
        const trayGroup = new THREE.Group();
        modelGroup.add(trayGroup);

        // Tray sliding logic
        // If flat: placed on left.
        // If folding:
        // - at foldRatio = 0.15 to 0.7: Tray is fully folded, and sliding outwards (showing inside).
        // - at foldRatio = 0.7 to 1.0: Tray slides inside the Sleeve cover tube!
        let tx = 0, ty = 0, tz = 0;
        
        if (isFlat) {
          tx = -W - 50;
          ty = -40;
          tz = 0;
          trayGroup.rotation.set(0, 0, 0);
        } else {
          // Slide in along Z direction (hollow tube opens along depth axis)
          // When 1.0 closed, slideOffset is 0.
          // When 0.7 open, slideOffset is D * 0.85
          const slideProgress = foldRatio < 0.7 
            ? 1 // fully out
            : (1.0 - foldRatio) / 0.3; // 1 to 0
          
          tx = 0;
          ty = -0.6; // slightly lower to slide without clipping inside sleeve
          tz = slideProgress * D * 0.85; 
        }

        trayGroup.position.set(tx, ty, tz);

        // Tray Base (W - 3 x D - 3, stationary at tray root)
        const trayBase = makeDoubleSidedPanelGeometry('trayBase', W - 3, D - 3, getDesignOf('trayBase'), material);
        trayBase.rotation.x = -Math.PI / 2;
        trayGroup.add(trayBase);

        // Front Wall Folds
        const trFrontPivot = new THREE.Group();
        trFrontPivot.position.set(0, -(D - 3) / 2, 0);
        trFrontPivot.rotation.x = foldRad;
        trayBase.add(trFrontPivot);
        const trayFront = makeDoubleSidedPanelGeometry('trayFront', W - 4, H - 2, getDesignOf('trayFront'), material);
        trayFront.position.set(0, -(H - 2) / 2, 0);
        trFrontPivot.add(trayFront);

        // Back Wall Folds
        const trBackPivot = new THREE.Group();
        trBackPivot.position.set(0, (D - 3) / 2, 0);
        trBackPivot.rotation.x = -foldRad;
        trayBase.add(trBackPivot);
        const trayBack = makeDoubleSidedPanelGeometry('trayBack', W - 4, H - 2, getDesignOf('trayBack'), material);
        trayBack.position.set(0, (H - 2) / 2, 0);
        trBackPivot.add(trayBack);

        // Left Wall Folds
        const trLeftPivot = new THREE.Group();
        trLeftPivot.position.set(-(W - 3) / 2, 0, 0);
        trLeftPivot.rotation.y = foldRad;
        trayBase.add(trLeftPivot);
        const trayLeft = makeDoubleSidedPanelGeometry('trayLeft', H - 2, D - 4, getDesignOf('trayLeft'), material);
        trayLeft.position.set(-(H - 2) / 2, 0, 0);
        trLeftPivot.add(trayLeft);

        // Right Wall Folds
        const trRightPivot = new THREE.Group();
        trRightPivot.position.set((W - 3) / 2, 0, 0);
        trRightPivot.rotation.y = -foldRad;
        trayBase.add(trRightPivot);
        const trayRight = makeDoubleSidedPanelGeometry('trayRight', H - 2, D - 4, getDesignOf('trayRight'), material);
        trayRight.position.set((H - 2) / 2, 0, 0);
        trRightPivot.add(trayRight);
      }

      // Add simple bounding scale to model group so huge sizes don't fly off-screen
      const maxDim = Math.max(W, H, D);
      let scaleFactor = 1.0;
      if (maxDim > 200) scaleFactor = 200 / maxDim;
      if (maxDim < 80) scaleFactor = 120 / maxDim;
      modelGroup.scale.set(scaleFactor, scaleFactor, scaleFactor);

      // Cast shadow for entire group
      modelGroup.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
      });

      return modelGroup;
    };

    // Rebuild the entire box on state updates
    const updateScene = () => {
      if (currentBoxObject) {
        scene.remove(currentBoxObject);
        // Clean materials/geometries of stale meshes to prevent memory leak
        currentBoxObject.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.geometry.dispose();
            if (Array.isArray(node.material)) {
              node.material.forEach(m => m.dispose());
            } else {
              node.material.dispose();
            }
          }
        });
      }

      const currentState = stateRef.current;
      currentBoxObject = buildBoxModel(currentState);
      scene.add(currentBoxObject);

      // Hide floor and grid when presenting in 2D flat mode to prevent visual clutter
      if (floor && gridHelper) {
        floor.visible = currentState.foldProgress > 0.02;
        gridHelper.visible = currentState.foldProgress > 0.02;
      }
    };

    // TRIGGER INITIAL BUILD
    updateScene();

    // RENDER LOOP
    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      controls.update();

      // Subtle slow floating rotation if we idle, only if not actively interacting
      if (currentBoxObject) {
        currentBoxObject.rotation.y += 0.002;
      }

      renderer.render(scene, camera);
    };
    animate();

    // RESPONSIVE RESIZE
    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(container);

    // Watcher for external state changes
    const stateWatcher = {
      update: () => {
        updateScene();
      }
    };

    // Store stateWatcher inside dynamic window/ref context if needed
    // However, React's dependency array on state will trigger useEffect rebuild, which is cleaner!
    
    // CLEANUP
    return () => {
      cancelAnimationFrame(animationFrameId);
      controls.dispose();
      resizeObserver.disconnect();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [state.type, state.dimensions, state.foldProgress, state.designs, state.material, state.paperWeight]);

  return (
    <div className="w-full h-full bg-[#0F0F0F] rounded-xl flex flex-col overflow-hidden relative border border-[#2A2A2A]">
      <div className="flex items-center justify-between px-5 py-3.5 bg-[#121212] border-b border-[#2A2A2A] shrink-0">
        <div className="flex items-center gap-2">
          <span className="flex h-2.5 w-2.5 rounded-full bg-orange-500 shadow shadow-orange-500/50 animate-pulse"></span>
          <h3 className="font-bold text-sm tracking-tight text-[#E0E0E0] font-display">Hiển Thị Phối Cảnh 3D Đóng Mở Folding Model</h3>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-gray-400">
          <kbd className="px-1.5 py-0.5 bg-[#1E1E1E] rounded border border-[#333]">Chuột trái</kbd> Xoay mô hình • <kbd className="px-1.5 py-0.5 bg-[#1E1E1E] rounded border border-[#333]">Cuộn</kbd> Thu Phóng
        </div>
      </div>

      {/* 3D RENDER CANVAS TARGET CONTAINER */}
      <div ref={containerRef} className="flex-1 min-h-0 w-full h-full relative" />

      {/* Quick Visual Status overlay */}
      <div className="absolute top-16 left-4 bg-[#1E1E1E]/90 backdrop-blur-md px-3 py-2 rounded border border-[#333] hover:bg-[#1E1E1E] transition-all">
        <div className="flex flex-col gap-1 text-[11px]">
          <div className="flex items-center gap-2 text-gray-300">
            <span className="font-medium text-gray-400">Tỷ lệ gấp:</span>
            <span className="font-mono text-orange-500 font-bold">{(state.foldProgress * 100).toFixed(0)}%</span>
          </div>
          <div className="flex items-center gap-2 text-gray-300">
            <span className="font-medium text-gray-400">Chất liệu:</span>
            <span className="font-semibold text-gray-300 capitalize">
              {state.material === 'kraft' ? 'Giấy nâu Kraft' : state.material === 'glossy' ? 'Bóng Cao Cấp' : 'Giấy Trắng Matte'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
