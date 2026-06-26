// ============================================================
// Core Type Definitions — Parametric Dieline Generator
// ============================================================

/** Điểm 2D với tọa độ đã được snap tolerance */
export interface Point2D {
    x: number;
    y: number;
}

/** Loại nét vẽ */
export type PathTag = 'CUT' | 'CREASE' | 'BLEED';

/** Loại đoạn đường */
export type SegmentType = 'line' | 'arc' | 'bezier';

/** Đoạn đường cơ bản */
export interface PathSegment {
    /** Danh sách điểm (2 điểm cho line, nhiều điểm cho arc nội suy) */
    points: Point2D[];
    /** Tag phân loại: CUT (cắt), CREASE (cấn), BLEED (tràn lề) */
    tag: PathTag;
    /** Loại đoạn: line, arc hoặc bezier */
    type: SegmentType;
    /** 4 điểm điều khiển Cubic Bezier [P0, CP1, CP2, P3] (chỉ dùng khi type='bezier') */
    controlPoints?: [Point2D, Point2D, Point2D, Point2D];
}

/** Mặt phẳng (Panel) trong bản vẽ bế */
export interface Panel {
    /** Tên mặt (VD: 'front', 'left', 'tuck_top') */
    name: string;
    /** Nhãn hiển thị tiếng Việt */
    label: string;
    /** Danh sách đường viền của mặt */
    paths: PathSegment[];
    /** Đường viền ngoài khép kín (theo thứ tự các đỉnh liên tiếp). Nếu có, 3D sẽ dùng thuộc tính này thay vì tự dò. */
    outline?: Point2D[];
    /** Các mảng lỗ rỗng bên trong mặt phẳng (mỗi lỗ là 1 mảng điểm khép kín). Chỉ dùng cho 3D. */
    holes?: Point2D[][];
    /** Các điểm chú thích trên mặt phẳng (chỉ dùng cho hiển thị 2D khi bật Hiện chi tiết) */
    annotations?: { point: Point2D, text: string, anchor?: 'start'|'middle'|'end', baseline?: 'hanging'|'middle'|'baseline'|'bottom' }[];
    /** Tên panel cha trong cây động học (null nếu là gốc) */
    parent: string | null;
    /** Cạnh bản lề / trục gập (2 điểm đầu-cuối) */
    pivotEdge: [Point2D, Point2D] | null;
    /** Góc gập mục tiêu khi fold_progress=1 (độ, VD: 90, -90, 180) */
    foldAngle: number;
    /** Hướng gập: 1 = gập lên (dương Y), -1 = gập xuống (âm Y) */
    foldDirection: 1 | -1;
    /** Khoảng tiến trình gập [start, end] trong dải 0→1.
     *  VD: [0, 0.4] = panel này gập trong 40% đầu tiên.
     *  Nếu không set → tự động tính theo độ sâu trong cây panel. */
    foldPhase?: [number, number];
    /** (Chỉ 3D) Dịch panel theo pháp tuyến mặt phẳng khuôn (trục Z thế giới)
     *  một lượng mm SAU khi gập — dùng để XẾP LỚP các mặt gập phẳng (vd bì thư:
     *  tai dán/mặt sau/nắp gập áp 180° về cùng phía nhưng tách lớp để không
     *  đồng phẳng gây z-fighting và xếp đúng thứ tự chồng). */
    stackZ?: number;
    /** (CHỈ 3D — KHÔNG ảnh hưởng path/outline 2D) Dịch panel một lượng mm dọc
     *  trục Z TRONG HỆ QUY CHIẾU CỦA PANEL CHA (sau khi áp ma trận gập của
     *  chính panel này, trước khi áp ma trận cha). Dùng để đẩy hẳn một mí gập
     *  180° (vd MÍ MIỆNG túi giấy) về phía SAU mặt tường (vào lòng túi) bằng
     *  hình học THẬT — tường (finish) che kín từ ngoài, không lộ mặt sau giấy,
     *  không phụ thuộc may rủi của polygonOffset khi hai mặt đồng phẳng.
     *  Giá trị ÂM = đẩy về phía trong (−z cục bộ của tường). */
    renderZShift?: number;
    /** (CHỈ 3D — KHÔNG ảnh hưởng path/outline 2D) Dữ liệu render miếng đệm góc
     *  khay. Miếng góc là MỘT tờ giấy gồm 2 tam giác (a,d,c) và (a,c,dP) nối
     *  liền dọc NẾP GẬP CHÉO a→c (đúng đường nhấn đỏ ở giữa khuôn 2D). Khi gập:
     *  tam giác (a,d,c) đi theo vách trước/sau; tam giác (a,c,dP) gập quanh nếp
     *  chéo để bám vách hông → 2 nửa luôn dính nhau dọc a→c (không cắt rời),
     *  đồng thời kéo 2 vách dựng lên. Toạ độ ở hệ phẳng (chưa gập). */
    gusset?: {
        /** Vách trước/sau mà tam giác (a,d,c) bám vào. */
        frontWall: string;
        /** Vách hông mà tam giác (a,c,dP) gập áp vào. */
        sideWall: string;
        /** Góc neo (giao 2 bản lề vách). */
        a: Point2D;
        /** Đỉnh dọc cạnh đứng vách trước/sau. */
        d: Point2D;
        /** Đỉnh nhọn (cuối nếp gập chéo). */
        c: Point2D;
        /** Đỉnh phía vách hông (đối xứng d qua a→c). */
        dP: Point2D;
        /** Tâm hộp (x,y) để chọn chiều lật hướng vào trong. */
        center: Point2D;
    };
}

/** Mô hình khuôn bế hoàn chỉnh */
export interface DielineModel {
    /** Tên mẫu hộp */
    name: string;
    /** Mã tiêu chuẩn (VD: 'ECMA-A20.20') */
    standardCode: string;
    /** Mô tả tiếng Việt */
    description: string;
    /** Danh sách mặt phẳng */
    panels: Panel[];
    /** Tất cả đường vẽ (phẳng, chưa gập) */
    allPaths: PathSegment[];
    /** Bounding box */
    boundingBox: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    };
    /** Thông số đầu vào */
    params: BoxParams;
    /** Cảnh báo về kích thước / khả năng sản xuất */
    warnings?: string[];
    /** (Chỉ hộp diêm tray+sleeve) Vector tịnh tiến (hệ phẳng-đã-gập) để KHAY
     *  LỒNG vào VỎ ở cuối hoạt ảnh kéo đóng. Lớp render dồn toàn bộ gập vào
     *  [0, NEST_START] rồi trượt khay theo vector này trong [NEST_START, 1]. */
    nesting?: { x: number; y: number; z: number };
}

/** Thông số hộp đầu vào */
export interface BoxParams {
    /** Chiều dài lọt lòng (mm) */
    L: number;
    /** Chiều rộng / hông lọt lòng (mm) */
    W: number;
    /** Chiều cao / chiều sâu lọt lòng (mm) */
    D: number;
    /** Độ dày vật liệu (mm) */
    T: number;
    /** Dung sai an toàn (mm), mặc định 0.5 */
    C: number;
    /** Rộng mép dán keo (mm), mặc định 15 */
    G: number;
    /** Chiều cao tai đút (mm), mặc định 15 */
    TH: number;
    /** Vị trí tai dán: 'left' hoặc 'right', mặc định 'left' */
    glueSide: 'left' | 'right';
    /** Loại hộp: 'rte' = Reverse Tuck End, 'slb' = Snap-Lock Bottom, 'gable' = Gable Box, 'paper_bag' = Túi giấy SOS, 'cup_sleeve' = Bọc ly, 'pizza' = Pizza Box FEFCO 0426, 'envelope' = Bì thư, 'tray' = Hộp diêm / Khay */
    boxType: 'rte' | 'slb' | 'gable' | 'paper_bag' | 'cup_sleeve' | 'pizza' | 'envelope' | 'tray';
    /** Thứ tự panel: 'WLWL' = Hông→Mặt→Hông→Lưng, 'LWLW' = Mặt→Hông→Lưng→Hông */
    panelOrder: 'WLWL' | 'LWLW';
    /** Chiều cao phần tay cầm vượt khỏi cạnh trên thân hộp (mm), mặc định 40 */
    HH: number;
    /** Chiều rộng lỗ quai xách (mm), 0 = tự động theo công thức (2/5 × AB) */
    HW: number;
    /** Chiều cao lỗ quai xách (mm), 0 = tự động theo công thức (1/2 × h2) */
    HHL: number;
    /** Hình dạng lỗ quai: 'oval' hoặc 'roundRect' */
    handleShape: 'oval' | 'roundRect';
    /** Vị trí lỗ quai: 'bottom' (sát đáy) | 'center' (giữa) */
    handleY: 'bottom' | 'center';
    /** Chiều cao tay cầm mái chính (mm), 0 = tự động (0.9 * h1) */
    HFH: number;
    /** Chiều rộng rãnh tai phụ (mm), mặc định = 3 */
    SLW: number;
    /** Tỷ lệ chiều sâu rãnh so với tay cầm (%), mặc định = 85 */
    SLH: number;
    /** Chiều rộng ngàm khóa mái chính (mm), 0 = tự động (L / 9) */
    TRW: number;
    /** Số cặp lồi-lõm đáy gài (0 = tự động theo L: <150→1, 150-250→2, ≥250→3) */
    SLP: number;
    /** Kiểu mái cho hộp quai xách: 'flat' (mái bằng) | 'pitched' (mái dốc) */
    gableStyle: 'flat' | 'pitched';
    /** Rộng lưỡi khóa nắp (mm), mặc định 15 */
    LTW: number;
    /** Cao lưỡi khóa nắp (mm), mặc định 20 */
    LTH: number;
    /** Bật/tắt lưỡi khóa nắp */
    lockTab: boolean;

    /** Chiều cao tai phụ bụi (mm), 0 = tự động theo công thức min(L/2-1, W+T) */
    DFH: number;

    // ── Paper Bag params ──
    /** Chiều cao gấp đáy (mm), 0 = tự động (W/2 + 10) */
    BF: number;
    /** Bán kính lỗ xỏ dây quai (mm), 0 = tự động (2.5mm) */
    HR: number;
    /** Khoảng cách lỗ quai từ mép trên (mm), 0 = tự động (25mm) */
    HM: number;
    /** Khoảng cách giữa 2 lỗ quai cùng mặt (mm), 0 = tự động */
    HS: number;
    /** Bật/tắt lỗ xỏ dây quai */
    handleHoles: boolean;

    // ── Cup Sleeve params ──
    /** Đường kính miệng nhỏ (mm), mặc định 70 */
    cupD1: number;
    /** Đường kính miệng lớn (mm), mặc định 80 */
    cupD2: number;
    /** Chiều cao ly (mm), mặc định 90 */
    cupH: number;
    /** % bao phủ chu vi (100 = trọn vòng), mặc định 100 */
    cupCoverage: number;
    /** Loại chiều cao: 'slant' = chiều xiên, 'vertical' = chiều đứng */
    cupHeightType: 'slant' | 'vertical';
    /** Vị trí vạt dán: 'right' | 'left' | 'none' */
    cupFlapPosition: 'right' | 'left' | 'none';

    // ── Envelope params ──
    /** Rộng bì thư lọt lòng (mm), mặc định 220 (DL) */
    envW: number;
    /** Cao bì thư lọt lòng (mm), mặc định 110 (DL) */
    envH: number;
    /** Cao nắp dán seal flap (mm), 0 = tự động */
    envFH: number;
    /** Rộng tai hông side flap (mm), 0 = tự động */
    envSF: number;
    /** Dạng nắp dán: 'straight' | 'pointed' | 'rounded' */
    envFlapShape: 'straight' | 'pointed' | 'rounded';
    /** Kiểu bì: 'wallet' (nắp dọc) | 'pocket' (nắp ngang) */
    envStyle: 'wallet' | 'pocket';
    /** Bật/tắt cửa sổ trong suốt */
    envWindow: boolean;
    /** Rộng cửa sổ (mm) */
    envWindowW: number;
    /** Cao cửa sổ (mm) */
    envWindowH: number;
    /** Vị trí X cửa sổ từ mép trái front panel (mm) */
    envWindowX: number;
    /** Vị trí Y cửa sổ từ mép dưới front panel (mm) */
    envWindowY: number;

    // ── Matchbox Tray (Hộp diêm / Khay) params ──
    /** Rộng lưỡi thụt tai khóa vách (mm), mặc định 15 */
    trayTongueW: number;
    /** Rộng mí dán keo của vỏ bao (mm), mặc định 15.
     *  Độc lập với dầm khay (G). */
    sleeveGlue: number;

    // ── Pizza Box (FEFCO 0426) params ──
    /** Bật/tắt lỗ thông hơi trên nắp */
    pizzaVent: boolean;
    /** Đường kính lỗ thông hơi (mm), 0 = tự động (~6mm) */
    pizzaVentD: number;
    /** Bật/tắt khóa nắp phía trước (ngàm gài nắp) */
    pizzaFrontLock: boolean;
    /** Bật/tắt chấu khóa góc (xếp chồng / tăng cứng) */
    pizzaCornerLock: boolean;
}

/** Giá trị mặc định cho BoxParams */
export const DEFAULT_PARAMS: BoxParams = {
    L: 100,
    W: 60,
    D: 200,
    T: 0.5,
    C: 0.5,
    G: 15,
    TH: 15,
    glueSide: 'left',
    boxType: 'rte',
    panelOrder: 'WLWL',
    HH: 0,
    HW: 0,
    HHL: 0,
    handleShape: 'oval',
    handleY: 'bottom',
    HFH: 0,
    SLW: 3,
    SLH: 85,
    TRW: 0,
    SLP: 0,
    gableStyle: 'pitched',
    LTW: 15,
    LTH: 20,
    lockTab: true,
    DFH: 0,
    BF: 0,
    HR: 0,
    HM: 0,
    HS: 0,
    handleHoles: true,
    cupD1: 70,
    cupD2: 80,
    cupH: 90,
    cupCoverage: 100,
    cupHeightType: 'slant',
    cupFlapPosition: 'right',
    envW: 220,
    envH: 110,
    envFH: 0,
    envSF: 0,
    envFlapShape: 'pointed',
    envStyle: 'wallet',
    envWindow: false,
    envWindowW: 90,
    envWindowH: 45,
    envWindowX: 15,
    envWindowY: 15,
    trayTongueW: 15,
    sleeveGlue: 15,
    pizzaVent: true,
    pizzaVentD: 0,
    pizzaFrontLock: true,
    pizzaCornerLock: true,
};

/** Thông tin metadata của loại hộp (để build thư viện) */
export interface BoxTemplate {
    id: string;
    name: string;
    nameVi: string;
    standardCode: string;
    description: string;
    descriptionVi: string;
    /** Hàm sinh dieline từ thông số */
    generate: (params: BoxParams) => DielineModel;
}
