    const holes: PathSegment[] = [];
    const annotations: any[] = [];
    const h1 = snap(gableStyle === 'pitched' ? sideW / Math.sqrt(3) : sideW / 2);
    const h2 = snap(0.9 * h1);
    const defaultH = snap(h1 + h2);
    
    // Tính toán vị trí rãnh (slot) sao cho khớp chính xác với ngàm mái chính
    const gableFold = gableStyle === 'pitched' ? 60 : 90;
    const insetA = snap(gableStyle === 'pitched' ? (panelW - 5 / 6 * panelW) / 2 : 0);
    const TRW = snap(overrideTRW > 0 ? overrideTRW : panelW / 9);
    const rectH = snap((ratioSLH / 100) * h2);
    
    const Z_height = h1 * Math.cos(gableFold * Math.PI / 180);
    const minH = snap(Math.sqrt(insetA * insetA + Z_height * Z_height) + 15);
    const triH = snap(Math.max(overrideH > 0 ? overrideH : defaultH, minH));
    const xMid = snap((xLeft + xRight) / 2);
