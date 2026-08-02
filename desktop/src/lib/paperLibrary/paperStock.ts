// ============================================================
// Bảng tra ĐỊNH LƯỢNG (g/m²) → ĐỘ DÀY MỘT TỜ (mm)
//
// Nguồn: bảng tra cứu của nhà in (ảnh gốc do chủ nhà in cung cấp,
// nhập tay 2026-07-30). Đây là số đo thực tế theo dòng giấy đang
// bán trên thị trường VN, KHÔNG phải công thức tính từ tỉ trọng —
// nên không được "làm tròn cho đẹp" hay suy ra bằng nội suy.
//
// Cách ghi tên: giữ NGUYÊN cách nhà in gọi khi đặt giấy
// (VD "Couche 60.2", "Duplex 300(2S)", "Kraft 120 Nhật") để thợ
// chế bản đối chiếu được với phiếu đặt giấy.
// ============================================================

import type { PaperStock } from './types';

/** Couche (tráng phủ bóng) — 24 dòng */
const COUCHE: PaperStock[] = [
    { id: 'couche-60-2', family: 'couche', name: 'Couche 60.2', gsm: 60.2, thicknessMm: 0.050 },
    { id: 'couche-64', family: 'couche', name: 'Couche 64', gsm: 64, thicknessMm: 0.055 },
    { id: 'couche-70', family: 'couche', name: 'Couche 70', gsm: 70, thicknessMm: 0.060 },
    { id: 'couche-80', family: 'couche', name: 'Couche 80', gsm: 80, thicknessMm: 0.065 },
    { id: 'couche-90', family: 'couche', name: 'Couche 90', gsm: 90, thicknessMm: 0.068 },
    { id: 'couche-100', family: 'couche', name: 'Couche 100', gsm: 100, thicknessMm: 0.080 },
    { id: 'couche-110', family: 'couche', name: 'Couche 110', gsm: 110, thicknessMm: 0.090 },
    { id: 'couche-115', family: 'couche', name: 'Couche 115', gsm: 115, thicknessMm: 0.095 },
    { id: 'couche-120', family: 'couche', name: 'Couche 120', gsm: 120, thicknessMm: 0.100 },
    { id: 'couche-140', family: 'couche', name: 'Couche 140', gsm: 140, thicknessMm: 0.120 },
    { id: 'couche-148', family: 'couche', name: 'Couche 148', gsm: 148, thicknessMm: 0.130 },
    { id: 'couche-150', family: 'couche', name: 'Couche 150', gsm: 150, thicknessMm: 0.135 },
    { id: 'couche-157', family: 'couche', name: 'Couche 157', gsm: 157, thicknessMm: 0.140 },
    { id: 'couche-170', family: 'couche', name: 'Couche 170', gsm: 170, thicknessMm: 0.150 },
    { id: 'couche-180', family: 'couche', name: 'Couche 180', gsm: 180, thicknessMm: 0.155 },
    { id: 'couche-190', family: 'couche', name: 'Couche 190', gsm: 190, thicknessMm: 0.160 },
    { id: 'couche-200', family: 'couche', name: 'Couche 200', gsm: 200, thicknessMm: 0.170 },
    { id: 'couche-210', family: 'couche', name: 'Couche 210', gsm: 210, thicknessMm: 0.180 },
    { id: 'couche-230', family: 'couche', name: 'Couche 230', gsm: 230, thicknessMm: 0.205 },
    { id: 'couche-250', family: 'couche', name: 'Couche 250', gsm: 250, thicknessMm: 0.235 },
    { id: 'couche-270', family: 'couche', name: 'Couche 270', gsm: 270, thicknessMm: 0.250 },
    { id: 'couche-280', family: 'couche', name: 'Couche 280', gsm: 280, thicknessMm: 0.260 },
    { id: 'couche-300', family: 'couche', name: 'Couche 300', gsm: 300, thicknessMm: 0.280 },
    { id: 'couche-350', family: 'couche', name: 'Couche 350', gsm: 350, thicknessMm: 0.330 },
];

/**
 * Couche Matt (tráng phủ mờ) — 20 dòng thường + 5 dòng 1S = 25 dòng.
 * 5 dòng cuối bảng gốc ghi tắt kiểu "C80 (1S)" = couche matt tráng 1 mặt.
 */
const COUCHE_MATT: PaperStock[] = [
    { id: 'couche-matt-52-3', family: 'couche_matt', name: 'Couche Matt 52.3', gsm: 52.3, thicknessMm: 0.055 },
    { id: 'couche-matt-60-2', family: 'couche_matt', name: 'Couche Matt 60.2', gsm: 60.2, thicknessMm: 0.060 },
    { id: 'couche-matt-64', family: 'couche_matt', name: 'Couche Matt 64', gsm: 64, thicknessMm: 0.065 },
    { id: 'couche-matt-70', family: 'couche_matt', name: 'Couche Matt 70', gsm: 70, thicknessMm: 0.070 },
    { id: 'couche-matt-80', family: 'couche_matt', name: 'Couche Matt 80', gsm: 80, thicknessMm: 0.080 },
    { id: 'couche-matt-100', family: 'couche_matt', name: 'Couche Matt 100', gsm: 100, thicknessMm: 0.100 },
    { id: 'couche-matt-115', family: 'couche_matt', name: 'Couche Matt 115', gsm: 115, thicknessMm: 0.115 },
    { id: 'couche-matt-120', family: 'couche_matt', name: 'Couche Matt 120', gsm: 120, thicknessMm: 0.120 },
    { id: 'couche-matt-130', family: 'couche_matt', name: 'Couche Matt 130', gsm: 130, thicknessMm: 0.130 },
    { id: 'couche-matt-140', family: 'couche_matt', name: 'Couche Matt 140', gsm: 140, thicknessMm: 0.140 },
    { id: 'couche-matt-148', family: 'couche_matt', name: 'Couche Matt 148', gsm: 148, thicknessMm: 0.150 },
    { id: 'couche-matt-150', family: 'couche_matt', name: 'Couche Matt 150', gsm: 150, thicknessMm: 0.155 },
    { id: 'couche-matt-170', family: 'couche_matt', name: 'Couche Matt 170', gsm: 170, thicknessMm: 0.170 },
    { id: 'couche-matt-190', family: 'couche_matt', name: 'Couche Matt 190', gsm: 190, thicknessMm: 0.190 },
    { id: 'couche-matt-200', family: 'couche_matt', name: 'Couche Matt 200', gsm: 200, thicknessMm: 0.200 },
    { id: 'couche-matt-210', family: 'couche_matt', name: 'Couche Matt 210', gsm: 210, thicknessMm: 0.210 },
    { id: 'couche-matt-230', family: 'couche_matt', name: 'Couche Matt 230', gsm: 230, thicknessMm: 0.230 },
    { id: 'couche-matt-250', family: 'couche_matt', name: 'Couche Matt 250', gsm: 250, thicknessMm: 0.250 },
    { id: 'couche-matt-270', family: 'couche_matt', name: 'Couche Matt 270', gsm: 270, thicknessMm: 0.270 },
    { id: 'couche-matt-300', family: 'couche_matt', name: 'Couche Matt 300', gsm: 300, thicknessMm: 0.300 },
    { id: 'couche-matt-c80-1s', family: 'couche_matt', name: 'C80 (1S)', gsm: 80, thicknessMm: 0.080, coating: '1S' },
    { id: 'couche-matt-c90-1s', family: 'couche_matt', name: 'C90 (1S)', gsm: 90, thicknessMm: 0.090, coating: '1S' },
    { id: 'couche-matt-c120-1s', family: 'couche_matt', name: 'C120 (1S)', gsm: 120, thicknessMm: 0.120, coating: '1S' },
    { id: 'couche-matt-c140-1s', family: 'couche_matt', name: 'C140 (1S)', gsm: 140, thicknessMm: 0.140, coating: '1S' },
    { id: 'couche-matt-c160-1s', family: 'couche_matt', name: 'C160 (1S)', gsm: 160, thicknessMm: 0.160, coating: '1S' },
];

/** Duplex (bìa cứng) — 10 dòng 2S + 14 dòng 1S = 24 dòng */
const DUPLEX: PaperStock[] = [
    { id: 'duplex-230-2s', family: 'duplex', name: 'Duplex 230(2S)', gsm: 230, thicknessMm: 0.260, coating: '2S' },
    { id: 'duplex-250-2s', family: 'duplex', name: 'Duplex 250(2S)', gsm: 250, thicknessMm: 0.280, coating: '2S' },
    { id: 'duplex-270-2s', family: 'duplex', name: 'Duplex 270(2S)', gsm: 270, thicknessMm: 0.300, coating: '2S' },
    { id: 'duplex-300-2s', family: 'duplex', name: 'Duplex 300(2S)', gsm: 300, thicknessMm: 0.380, coating: '2S' },
    { id: 'duplex-350-2s', family: 'duplex', name: 'Duplex 350(2S)', gsm: 350, thicknessMm: 0.430, coating: '2S' },
    { id: 'duplex-370-2s', family: 'duplex', name: 'Duplex 370(2S)', gsm: 370, thicknessMm: 0.450, coating: '2S' },
    { id: 'duplex-400-2s', family: 'duplex', name: 'Duplex 400(2S)', gsm: 400, thicknessMm: 0.500, coating: '2S' },
    { id: 'duplex-430-2s', family: 'duplex', name: 'Duplex 430(2S)', gsm: 430, thicknessMm: 0.520, coating: '2S' },
    { id: 'duplex-450-2s', family: 'duplex', name: 'Duplex 450(2S)', gsm: 450, thicknessMm: 0.560, coating: '2S' },
    { id: 'duplex-500-2s', family: 'duplex', name: 'Duplex 500(2S)', gsm: 500, thicknessMm: 0.600, coating: '2S' },
    { id: 'duplex-150-1s', family: 'duplex', name: 'Duplex 150 (1S)', gsm: 150, thicknessMm: 0.180, coating: '1S' },
    { id: 'duplex-170-1s', family: 'duplex', name: 'Duplex 170 (1S)', gsm: 170, thicknessMm: 0.200, coating: '1S' },
    { id: 'duplex-180-1s', family: 'duplex', name: 'Duplex 180 (1S)', gsm: 180, thicknessMm: 0.220, coating: '1S' },
    { id: 'duplex-200-1s', family: 'duplex', name: 'Duplex 200 (1S)', gsm: 200, thicknessMm: 0.240, coating: '1S' },
    { id: 'duplex-230-1s', family: 'duplex', name: 'Duplex 230 (1S)', gsm: 230, thicknessMm: 0.280, coating: '1S' },
    { id: 'duplex-250-1s', family: 'duplex', name: 'Duplex 250 (1S)', gsm: 250, thicknessMm: 0.300, coating: '1S' },
    { id: 'duplex-270-1s', family: 'duplex', name: 'Duplex 270 (1S)', gsm: 270, thicknessMm: 0.350, coating: '1S' },
    { id: 'duplex-280-1s', family: 'duplex', name: 'Duplex 280 (1S)', gsm: 280, thicknessMm: 0.360, coating: '1S' },
    { id: 'duplex-300-1s', family: 'duplex', name: 'Duplex 300 (1S)', gsm: 300, thicknessMm: 0.380, coating: '1S' },
    { id: 'duplex-350-1s', family: 'duplex', name: 'Duplex 350 (1S)', gsm: 350, thicknessMm: 0.400, coating: '1S' },
    { id: 'duplex-400-1s', family: 'duplex', name: 'Duplex 400 (1S)', gsm: 400, thicknessMm: 0.520, coating: '1S' },
    { id: 'duplex-450-1s', family: 'duplex', name: 'Duplex 450 (1S)', gsm: 450, thicknessMm: 0.600, coating: '1S' },
    { id: 'duplex-500-1s', family: 'duplex', name: 'Duplex 500 (1S)', gsm: 500, thicknessMm: 0.670, coating: '1S' },
    { id: 'duplex-550-1s', family: 'duplex', name: 'Duplex 550 (1S)', gsm: 550, thicknessMm: 0.700, coating: '1S' },
];

/** Bristol — 14 dòng, toàn bộ 2S */
const BRISTOL: PaperStock[] = [
    { id: 'bristol-170-2s', family: 'bristol', name: 'Bristol 170(2S)', gsm: 170, thicknessMm: 0.170, coating: '2S' },
    { id: 'bristol-180-2s', family: 'bristol', name: 'Bristol 180(2S)', gsm: 180, thicknessMm: 0.180, coating: '2S' },
    { id: 'bristol-190-2s', family: 'bristol', name: 'Bristol 190(2S)', gsm: 190, thicknessMm: 0.190, coating: '2S' },
    { id: 'bristol-200-2s', family: 'bristol', name: 'Bristol 200(2S)', gsm: 200, thicknessMm: 0.200, coating: '2S' },
    { id: 'bristol-210-2s', family: 'bristol', name: 'Bristol 210(2S)', gsm: 210, thicknessMm: 0.210, coating: '2S' },
    { id: 'bristol-230-2s', family: 'bristol', name: 'Bristol 230(2S)', gsm: 230, thicknessMm: 0.230, coating: '2S' },
    { id: 'bristol-250-2s', family: 'bristol', name: 'Bristol 250(2S)', gsm: 250, thicknessMm: 0.260, coating: '2S' },
    { id: 'bristol-260-2s', family: 'bristol', name: 'Bristol 260(2S)', gsm: 260, thicknessMm: 0.270, coating: '2S' },
    { id: 'bristol-270-2s', family: 'bristol', name: 'Bristol 270(2S)', gsm: 270, thicknessMm: 0.290, coating: '2S' },
    { id: 'bristol-280-2s', family: 'bristol', name: 'Bristol 280(2S)', gsm: 280, thicknessMm: 0.300, coating: '2S' },
    { id: 'bristol-300-2s', family: 'bristol', name: 'Bristol 300(2S)', gsm: 300, thicknessMm: 0.315, coating: '2S' },
    { id: 'bristol-310-2s', family: 'bristol', name: 'Bristol 310(2S)', gsm: 310, thicknessMm: 0.350, coating: '2S' },
    { id: 'bristol-350-2s', family: 'bristol', name: 'Bristol 350(2S)', gsm: 350, thicknessMm: 0.380, coating: '2S' },
    { id: 'bristol-400-2s', family: 'bristol', name: 'Bristol 400(2S)', gsm: 400, thicknessMm: 0.480, coating: '2S' },
];

/** Ivory (Ngà) — 19 dòng thường + 6 dòng lưng kraft = 25 dòng */
const IVORY: PaperStock[] = [
    { id: 'ivory-170', family: 'ivory', name: 'Ivory 170', gsm: 170, thicknessMm: 0.200 },
    { id: 'ivory-180', family: 'ivory', name: 'Ivory 180', gsm: 180, thicknessMm: 0.220 },
    { id: 'ivory-190', family: 'ivory', name: 'Ivory 190', gsm: 190, thicknessMm: 0.250 },
    { id: 'ivory-200', family: 'ivory', name: 'Ivory 200', gsm: 200, thicknessMm: 0.270 },
    { id: 'ivory-210', family: 'ivory', name: 'Ivory 210', gsm: 210, thicknessMm: 0.280 },
    { id: 'ivory-220', family: 'ivory', name: 'Ivory 220', gsm: 220, thicknessMm: 0.300 },
    { id: 'ivory-230', family: 'ivory', name: 'Ivory 230', gsm: 230, thicknessMm: 0.310 },
    { id: 'ivory-250', family: 'ivory', name: 'Ivory 250', gsm: 250, thicknessMm: 0.340 },
    { id: 'ivory-270', family: 'ivory', name: 'Ivory 270', gsm: 270, thicknessMm: 0.370 },
    { id: 'ivory-280', family: 'ivory', name: 'Ivory 280', gsm: 280, thicknessMm: 0.380 },
    { id: 'ivory-300', family: 'ivory', name: 'Ivory 300', gsm: 300, thicknessMm: 0.410 },
    { id: 'ivory-330', family: 'ivory', name: 'Ivory 330', gsm: 330, thicknessMm: 0.450 },
    { id: 'ivory-350', family: 'ivory', name: 'Ivory 350', gsm: 350, thicknessMm: 0.480 },
    { id: 'ivory-370', family: 'ivory', name: 'Ivory 370', gsm: 370, thicknessMm: 0.520 },
    { id: 'ivory-400', family: 'ivory', name: 'Ivory 400', gsm: 400, thicknessMm: 0.570 },
    { id: 'ivory-420', family: 'ivory', name: 'Ivory 420', gsm: 420, thicknessMm: 0.660 },
    { id: 'ivory-450', family: 'ivory', name: 'Ivory 450', gsm: 450, thicknessMm: 0.700 },
    { id: 'ivory-480', family: 'ivory', name: 'Ivory 480', gsm: 480, thicknessMm: 0.750 },
    { id: 'ivory-500', family: 'ivory', name: 'Ivory 500', gsm: 500, thicknessMm: 0.800 },
    { id: 'ivory-190-kraft', family: 'ivory', name: 'Ivory 190_Lưng Kraft', gsm: 190, thicknessMm: 0.250, note: 'Lưng kraft' },
    { id: 'ivory-198-kraft', family: 'ivory', name: 'Ivory 198_Lưng Kraft', gsm: 198, thicknessMm: 0.270, note: 'Lưng kraft' },
    { id: 'ivory-233-kraft', family: 'ivory', name: 'Ivory 233_Lưng Kraft', gsm: 233, thicknessMm: 0.310, note: 'Lưng kraft' },
    { id: 'ivory-285-kraft', family: 'ivory', name: 'Ivory 285_Lưng Kraft', gsm: 285, thicknessMm: 0.390, note: 'Lưng kraft' },
    { id: 'ivory-312-kraft', family: 'ivory', name: 'Ivory 312_Lưng Kraft', gsm: 312, thicknessMm: 0.430, note: 'Lưng kraft' },
    { id: 'ivory-444-kraft', family: 'ivory', name: 'Ivory 444_Lưng Kraft', gsm: 444, thicknessMm: 0.600, note: 'Lưng kraft' },
];

/** Fort (giấy offset không tráng phủ) — 23 dòng, bảng gốc chia 4 nhóm theo dòng giấy */
const FORT: PaperStock[] = [
    { id: 'fort-58-bb', family: 'fort', name: 'Fort 58 BB', gsm: 58, thicknessMm: 0.080, origin: 'BB' },
    { id: 'fort-65-bb', family: 'fort', name: 'Fort 65 BB', gsm: 65, thicknessMm: 0.085, origin: 'BB' },
    { id: 'fort-60-indo', family: 'fort', name: 'Fort 60 Indo', gsm: 60, thicknessMm: 0.080, origin: 'Indo' },
    { id: 'fort-70-indo', family: 'fort', name: 'Fort 70 Indo', gsm: 70, thicknessMm: 0.090, origin: 'Indo' },
    { id: 'fort-80-indo', family: 'fort', name: 'Fort 80 Indo', gsm: 80, thicknessMm: 0.100, origin: 'Indo' },
    { id: 'fort-100-indo', family: 'fort', name: 'Fort 100 Indo', gsm: 100, thicknessMm: 0.120, origin: 'Indo' },
    { id: 'fort-120', family: 'fort', name: 'Fort 120', gsm: 120, thicknessMm: 0.150 },
    { id: 'fort-140', family: 'fort', name: 'Fort 140', gsm: 140, thicknessMm: 0.190 },
    { id: 'fort-150', family: 'fort', name: 'Fort 150', gsm: 150, thicknessMm: 0.200 },
    { id: 'fort-160', family: 'fort', name: 'Fort 160', gsm: 160, thicknessMm: 0.210 },
    { id: 'fort-165', family: 'fort', name: 'Fort 165', gsm: 165, thicknessMm: 0.220 },
    { id: 'fort-170', family: 'fort', name: 'Fort 170', gsm: 170, thicknessMm: 0.225 },
    { id: 'fort-180', family: 'fort', name: 'Fort 180', gsm: 180, thicknessMm: 0.240 },
    { id: 'fort-190', family: 'fort', name: 'Fort 190', gsm: 190, thicknessMm: 0.250 },
    { id: 'fort-200', family: 'fort', name: 'Fort 200', gsm: 200, thicknessMm: 0.260 },
    { id: 'fort-210', family: 'fort', name: 'Fort 210', gsm: 210, thicknessMm: 0.280 },
    { id: 'fort-230', family: 'fort', name: 'Fort 230', gsm: 230, thicknessMm: 0.300 },
    { id: 'fort-250', family: 'fort', name: 'Fort 250', gsm: 250, thicknessMm: 0.330 },
    { id: 'fort-270', family: 'fort', name: 'Fort 270', gsm: 270, thicknessMm: 0.350 },
    { id: 'fort-300', family: 'fort', name: 'Fort 300', gsm: 300, thicknessMm: 0.380 },
    { id: 'fort-350', family: 'fort', name: 'Fort 350', gsm: 350, thicknessMm: 0.420 },
    { id: 'fort-385', family: 'fort', name: 'Fort 385', gsm: 385, thicknessMm: 0.450 },
    { id: 'fort-400', family: 'fort', name: 'Fort 400', gsm: 400, thicknessMm: 0.480 },
];

/**
 * Art — 21 dòng, gồm 4 dòng sản phẩm: EK, Econo, Natural, Elica.
 * EK 75 và EK 90 có hai mã (-01, -02) cùng định lượng nhưng bảng tra
 * ghi riêng, nên giữ thành hai dòng độc lập.
 */
const ART: PaperStock[] = [
    { id: 'art-ek-75-01', family: 'art', name: 'EK 75 - 01', gsm: 75, thicknessMm: 0.120, origin: 'EK' },
    { id: 'art-ek-75-02', family: 'art', name: 'EK 75 - 02', gsm: 75, thicknessMm: 0.140, origin: 'EK' },
    { id: 'art-ek-90-01', family: 'art', name: 'EK 90 - 01', gsm: 90, thicknessMm: 0.140, origin: 'EK' },
    { id: 'art-ek-90-02', family: 'art', name: 'EK 90 - 02', gsm: 90, thicknessMm: 0.140, origin: 'EK' },
    { id: 'art-econo-100', family: 'art', name: 'Econo 100', gsm: 100, thicknessMm: 0.120, origin: 'Econo' },
    { id: 'art-econo-120', family: 'art', name: 'Econo 120', gsm: 120, thicknessMm: 0.150, origin: 'Econo' },
    { id: 'art-econo-150', family: 'art', name: 'Econo 150', gsm: 150, thicknessMm: 0.200, origin: 'Econo' },
    { id: 'art-econo-170', family: 'art', name: 'Econo 170', gsm: 170, thicknessMm: 0.225, origin: 'Econo' },
    { id: 'art-econo-190', family: 'art', name: 'Econo 190', gsm: 190, thicknessMm: 0.250, origin: 'Econo' },
    { id: 'art-econo-250', family: 'art', name: 'Econo 250', gsm: 250, thicknessMm: 0.330, origin: 'Econo' },
    { id: 'art-econo-300', family: 'art', name: 'Econo 300', gsm: 300, thicknessMm: 0.380, origin: 'Econo' },
    { id: 'art-natural-90', family: 'art', name: 'Natural 90', gsm: 90, thicknessMm: 0.120, origin: 'Natural' },
    { id: 'art-natural-120', family: 'art', name: 'Natural 120', gsm: 120, thicknessMm: 0.150, origin: 'Natural' },
    { id: 'art-natural-160', family: 'art', name: 'Natural 160', gsm: 160, thicknessMm: 0.210, origin: 'Natural' },
    { id: 'art-natural-200', family: 'art', name: 'Natural 200', gsm: 200, thicknessMm: 0.250, origin: 'Natural' },
    { id: 'art-natural-250', family: 'art', name: 'Natural 250', gsm: 250, thicknessMm: 0.330, origin: 'Natural' },
    { id: 'art-elica-100', family: 'art', name: 'Elica 100', gsm: 100, thicknessMm: 0.120, origin: 'Elica' },
    { id: 'art-elica-150', family: 'art', name: 'Elica 150', gsm: 150, thicknessMm: 0.200, origin: 'Elica' },
    { id: 'art-elica-170', family: 'art', name: 'Elica 170', gsm: 170, thicknessMm: 0.225, origin: 'Elica' },
    { id: 'art-elica-190', family: 'art', name: 'Elica 190', gsm: 190, thicknessMm: 0.250, origin: 'Elica' },
    { id: 'art-elica-250', family: 'art', name: 'Elica 250', gsm: 250, thicknessMm: 0.330, origin: 'Elica' },
];

/** Kraft — 8 dòng kraft trắng Nhật + 12 dòng kraft Nhật + 8 dòng kraft Châu Âu = 28 dòng */
const KRAFT: PaperStock[] = [
    { id: 'kraft-trang-80-nhat', family: 'kraft', name: 'Kraft (Trắng) 80 Nhật', gsm: 80, thicknessMm: 0.110, origin: 'Nhật', note: 'Kraft trắng' },
    { id: 'kraft-trang-100-nhat', family: 'kraft', name: 'Kraft (Trắng) 100 Nhật', gsm: 100, thicknessMm: 0.140, origin: 'Nhật', note: 'Kraft trắng' },
    { id: 'kraft-trang-120-nhat', family: 'kraft', name: 'Kraft (Trắng) 120 Nhật', gsm: 120, thicknessMm: 0.165, origin: 'Nhật', note: 'Kraft trắng' },
    { id: 'kraft-trang-150-nhat', family: 'kraft', name: 'Kraft (Trắng) 150 Nhật', gsm: 150, thicknessMm: 0.200, origin: 'Nhật', note: 'Kraft trắng' },
    { id: 'kraft-trang-180-nhat', family: 'kraft', name: 'Kraft (Trắng) 180 Nhật', gsm: 180, thicknessMm: 0.250, origin: 'Nhật', note: 'Kraft trắng' },
    { id: 'kraft-trang-210-nhat', family: 'kraft', name: 'Kraft (Trắng) 210 Nhật', gsm: 210, thicknessMm: 0.290, origin: 'Nhật', note: 'Kraft trắng' },
    { id: 'kraft-trang-230-nhat', family: 'kraft', name: 'Kraft (Trắng) 230 Nhật', gsm: 230, thicknessMm: 0.320, origin: 'Nhật', note: 'Kraft trắng' },
    { id: 'kraft-trang-250-nhat', family: 'kraft', name: 'Kraft (Trắng) 250 Nhật', gsm: 250, thicknessMm: 0.350, origin: 'Nhật', note: 'Kraft trắng' },
    { id: 'kraft-50-nhat', family: 'kraft', name: 'Kraft 50 Nhật', gsm: 50, thicknessMm: 0.070, origin: 'Nhật' },
    { id: 'kraft-60-nhat', family: 'kraft', name: 'Kraft 60 Nhật', gsm: 60, thicknessMm: 0.090, origin: 'Nhật' },
    { id: 'kraft-70-nhat', family: 'kraft', name: 'Kraft 70 Nhật', gsm: 70, thicknessMm: 0.110, origin: 'Nhật' },
    { id: 'kraft-80-nhat', family: 'kraft', name: 'Kraft 80 Nhật', gsm: 80, thicknessMm: 0.120, origin: 'Nhật' },
    { id: 'kraft-100-nhat', family: 'kraft', name: 'Kraft 100 Nhật', gsm: 100, thicknessMm: 0.145, origin: 'Nhật' },
    { id: 'kraft-120-nhat', family: 'kraft', name: 'Kraft 120 Nhật', gsm: 120, thicknessMm: 0.175, origin: 'Nhật' },
    { id: 'kraft-160-nhat', family: 'kraft', name: 'Kraft 160 Nhật', gsm: 160, thicknessMm: 0.190, origin: 'Nhật' },
    { id: 'kraft-170-nhat', family: 'kraft', name: 'Kraft 170 Nhật', gsm: 170, thicknessMm: 0.200, origin: 'Nhật' },
    { id: 'kraft-180-nhat', family: 'kraft', name: 'Kraft 180 Nhật', gsm: 180, thicknessMm: 0.210, origin: 'Nhật' },
    { id: 'kraft-210-nhat', family: 'kraft', name: 'Kraft 210 Nhật', gsm: 210, thicknessMm: 0.250, origin: 'Nhật' },
    { id: 'kraft-250-nhat', family: 'kraft', name: 'Kraft 250 Nhật', gsm: 250, thicknessMm: 0.300, origin: 'Nhật' },
    { id: 'kraft-280-nhat', family: 'kraft', name: 'Kraft 280 Nhật', gsm: 280, thicknessMm: 0.330, origin: 'Nhật' },
    { id: 'kraft-100-chau-au', family: 'kraft', name: 'Kraft 100 Châu Âu', gsm: 100, thicknessMm: 0.140, origin: 'Châu Âu' },
    { id: 'kraft-135-chau-au', family: 'kraft', name: 'Kraft 135 Châu Âu', gsm: 135, thicknessMm: 0.160, origin: 'Châu Âu' },
    { id: 'kraft-160-chau-au', family: 'kraft', name: 'Kraft 160 Châu Âu', gsm: 160, thicknessMm: 0.190, origin: 'Châu Âu' },
    { id: 'kraft-200-chau-au', family: 'kraft', name: 'Kraft 200 Châu Âu', gsm: 200, thicknessMm: 0.260, origin: 'Châu Âu' },
    { id: 'kraft-250-chau-au', family: 'kraft', name: 'Kraft 250 Châu Âu', gsm: 250, thicknessMm: 0.310, origin: 'Châu Âu' },
    { id: 'kraft-300-chau-au', family: 'kraft', name: 'Kraft 300 Châu Âu', gsm: 300, thicknessMm: 0.380, origin: 'Châu Âu' },
    { id: 'kraft-370-chau-au', family: 'kraft', name: 'Kraft 370 Châu Âu', gsm: 370, thicknessMm: 0.460, origin: 'Châu Âu' },
    { id: 'kraft-440-chau-au', family: 'kraft', name: 'Kraft 440 Châu Âu', gsm: 440, thicknessMm: 0.560, origin: 'Châu Âu' },
];

/** Nhóm còn lại: 9 Cal + 1 Crystal + 3 Bisomi + 8 Pelure + 3 Carbonless = 24 dòng */
const OTHER: PaperStock[] = [
    { id: 'cal-53', family: 'other', name: 'Cal 53', gsm: 53, thicknessMm: 0.050 },
    { id: 'cal-63', family: 'other', name: 'Cal 63', gsm: 63, thicknessMm: 0.060 },
    { id: 'cal-73', family: 'other', name: 'Cal 73', gsm: 73, thicknessMm: 0.070 },
    { id: 'cal-83', family: 'other', name: 'Cal 83', gsm: 83, thicknessMm: 0.075 },
    { id: 'cal-90', family: 'other', name: 'Cal 90', gsm: 90, thicknessMm: 0.080 },
    { id: 'cal-112', family: 'other', name: 'Cal 112', gsm: 112, thicknessMm: 0.095 },
    { id: 'cal-150', family: 'other', name: 'Cal 150', gsm: 150, thicknessMm: 0.120 },
    { id: 'cal-180', family: 'other', name: 'Cal 180', gsm: 180, thicknessMm: 0.150 },
    { id: 'cal-200', family: 'other', name: 'Cal 200', gsm: 200, thicknessMm: 0.170 },
    { id: 'crystal-230', family: 'other', name: 'Crystal 230', gsm: 230, thicknessMm: 0.300 },
    { id: 'bisomi-vn-110', family: 'other', name: 'Bisomi VN 110', gsm: 110, thicknessMm: 0.150, origin: 'VN' },
    { id: 'bisomi-thai-160', family: 'other', name: 'Bisomi Thái 160', gsm: 160, thicknessMm: 0.200, origin: 'Thái' },
    { id: 'bisomi-thai-165', family: 'other', name: 'Bisomi Thái 165', gsm: 165, thicknessMm: 0.240, origin: 'Thái' },
    { id: 'pelure-35-indo', family: 'other', name: 'Pelure 35 Indo', gsm: 35, thicknessMm: 0.050, origin: 'Indo' },
    { id: 'pelure-40-indo', family: 'other', name: 'Pelure 40 Indo', gsm: 40, thicknessMm: 0.060, origin: 'Indo' },
    { id: 'pelure-30-vn', family: 'other', name: 'Pelure 30 VN', gsm: 30, thicknessMm: 0.045, origin: 'VN' },
    { id: 'pelure-35-vn', family: 'other', name: 'Pelure 35 VN', gsm: 35, thicknessMm: 0.050, origin: 'VN' },
    { id: 'pelure-40-vn', family: 'other', name: 'Pelure 40 VN', gsm: 40, thicknessMm: 0.060, origin: 'VN' },
    { id: 'pelure-50-vn', family: 'other', name: 'Pelure 50 VN', gsm: 50, thicknessMm: 0.070, origin: 'VN' },
    { id: 'pelure-45-nhat', family: 'other', name: 'Pelure 45 Nhật', gsm: 45, thicknessMm: 0.065, origin: 'Nhật' },
    { id: 'pelure-50-nhat', family: 'other', name: 'Pelure 50 Nhật', gsm: 50, thicknessMm: 0.070, origin: 'Nhật' },
    { id: 'carbonless-dau-55', family: 'other', name: 'Carbonless_Đầu 55', gsm: 55, thicknessMm: 0.055, note: 'Tờ đầu liên' },
    { id: 'carbonless-giua-50', family: 'other', name: 'Carbonless_Giữa 50', gsm: 50, thicknessMm: 0.050, note: 'Tờ giữa liên' },
    { id: 'carbonless-cuoi-55', family: 'other', name: 'Carbonless_Cuối 55', gsm: 55, thicknessMm: 0.055, note: 'Tờ cuối liên' },
];

/** Toàn bộ bảng tra định lượng, gộp mọi họ giấy */
export const PAPER_STOCKS: PaperStock[] = [
    ...COUCHE,
    ...COUCHE_MATT,
    ...DUPLEX,
    ...BRISTOL,
    ...IVORY,
    ...FORT,
    ...ART,
    ...KRAFT,
    ...OTHER,
];

/** Nhãn tiếng Việt của từng họ giấy — dùng cho dropdown chọn giấy */
export const PAPER_FAMILY_LABELS: Record<string, string> = {
    couche: 'Couche',
    couche_matt: 'Couche Matt',
    duplex: 'Duplex',
    bristol: 'Bristol',
    ivory: 'Ivory (Ngà)',
    fort: 'Fort',
    art: 'Art',
    kraft: 'Kraft',
    other: 'Loại khác',
};
