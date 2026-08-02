// ============================================================
// CÁC LOẠI MÀNG CÁN — độ dày và tính chất
//
// Nguồn: 'Bảng Tra Định Lượng Giấy.xlsm', sheet 'Các loại độ dày màng'
// (120 dòng, 8 bảng con: cơ nhiệt, thấm khí, quang học, sức căng bề mặt,
// PE/PP/PET/Nylon/PVDC, màng mạ kim loại).
//
// Module này lấy phần XƯỞNG IN DÙNG ĐẾN: độ dày (µm), xử lý corona,
// hàn nhiệt được không, và đặc điểm nhận biết bằng tay/mắt. Các bảng
// tính chất polymer sâu (Tg, Tm, WVTR, modul kéo căng…) để ở
// FILM_POLYMER_PROPERTIES bên dưới, dạng tra cứu thô.
//
// Đơn vị độ dày ở đây là MICROMET (µm), KHÁC với mm của giấy —
// 1 µm = 0.001 mm. Dùng `thicknessMm()` để đổi khi cộng vào gáy sách.
// ============================================================

/** Một loại màng dùng trong gia công in */
export interface LaminationFilm {
    /** Mã màng như xưởng gọi */
    code: string;
    /** Độ dày nhỏ nhất (µm) */
    thicknessMinUm: number;
    /** Độ dày lớn nhất (µm) — bằng min nếu sheet chỉ ghi một số */
    thicknessMaxUm: number;
    /** Nguyên văn ô độ dày trong sheet (VD '20–30', '25–40') */
    thicknessRaw: string;
    /** Xử lý corona — nguyên văn (VD '38 / 1 mặt') */
    corona?: string;
    /** Hàn nhiệt được không — nguyên văn sheet */
    heatSeal?: string;
    /** Đặc điểm nhận biết / lưu ý khi gia công */
    note?: string;
    /** true = màng mạ kim loại (metalized) */
    metalized?: boolean;
}

/**
 * Màng gia công thông dụng — gộp từ 3 bảng con của sheet:
 * 'Tính chất và một số đặc điểm của PP', bảng PE/PET/Nylon/Cellophane/PVC,
 * và bảng màng mạ kim loại.
 */
export const LAMINATION_FILMS: LaminationFilm[] = [
    {
        code: 'BOPP',
        thicknessMinUm: 20,
        thicknessMaxUm: 30,
        thicknessRaw: '20–30',
        corona: '38 / 1 mặt',
        heatSeal: 'Không',
        note: 'Tương đối cứng, dùng tay kéo hai chiều không co giãn. Hơi bị co rút khi hàn ở nhiệt độ cao.',
    },
    {
        code: 'Matt OPP',
        thicknessMinUm: 20,
        thicknessMaxUm: 20,
        thicknessRaw: '20',
        corona: '38 / 2 mặt',
        heatSeal: 'Không',
        note: 'Một mặt mờ, một mặt bóng.',
    },
    {
        code: 'KOPP',
        thicknessMinUm: 22,
        thicknessMaxUm: 22,
        thicknessRaw: '22',
        corona: '38 / 1 mặt',
        heatSeal: 'Có, dính yếu',
        note: 'Màu hơi ngả vàng, giòn hơn OPP, hàn nhiệt mặt có corona.',
    },
    {
        code: 'BOPP Heatseal',
        thicknessMinUm: 20,
        thicknessMaxUm: 20,
        thicknessRaw: '20',
        corona: '38 / 1 mặt',
        heatSeal: 'Có, dính yếu',
        note: 'Dễ giãn hơn màng BOPP, hàn nhiệt ở mặt ngoài không corona.',
    },
    {
        code: 'CPP',
        thicknessMinUm: 25,
        thicknessMaxUm: 40,
        thicknessRaw: '25–40',
        corona: '38 / 1 mặt',
        heatSeal: 'Có, dính chắc',
        note: 'Hơi mềm, trong suốt nhưng kém bóng hơn OPP, kéo giãn ít về một trục.',
    },
    {
        code: 'PCPP',
        thicknessMinUm: 25,
        thicknessMaxUm: 80,
        thicknessRaw: '25–80',
        corona: '38 / 1 mặt',
        heatSeal: 'Có, dính yếu',
        note: 'Màu trắng đục (giống ngọc trai), kéo không giãn.',
    },
    {
        code: 'PE',
        thicknessMinUm: 40,
        thicknessMaxUm: 120,
        thicknessRaw: '40–120',
        corona: '38–40 / 1 mặt',
        heatSeal: 'Có, dính chắc',
        note: 'Màng mềm dẻo, dễ giãn.',
    },
    {
        code: 'PET',
        thicknessMinUm: 12,
        thicknessMaxUm: 12,
        thicknessRaw: '12',
        corona: '42–44 / 1 mặt',
        heatSeal: 'Không',
        note: 'Màng cứng, bóng, vò nghe sột soạt, không co giãn, chịu nhiệt tốt.',
    },
    {
        code: 'Nylon',
        thicknessMinUm: 15,
        thicknessMaxUm: 15,
        thicknessRaw: '15',
        corona: '50–52 / 1 mặt',
        heatSeal: 'Không',
        note: 'Màng mềm mại, dai, dễ hút ẩm, dễ nhăn, dùng tay kéo màng co giãn nhiều, chịu nhiệt tốt.',
    },
    {
        code: 'Cellophane',
        thicknessMinUm: 20,
        thicknessMaxUm: 20,
        thicknessRaw: '20',
        corona: '38 / 2 mặt',
        heatSeal: 'Không',
        note: 'Nếm có vị đắng, có khả năng giữ nếp xoắn, hút ẩm cao, màu cuộn ngả vàng.',
    },
    {
        code: 'PVC',
        thicknessMinUm: 35,
        thicknessMaxUm: 50,
        thicknessRaw: '35–40–50',
        corona: '38 / 2 mặt',
        heatSeal: 'Không',
        note: 'Tương đối cứng, khá bóng, bị cháy khi ngâm dung môi, bị co dưới tác dụng nhiệt.',
    },
    {
        code: 'MCPP',
        thicknessMinUm: 20,
        thicknessMaxUm: 25,
        thicknessRaw: '20–25',
        corona: '38 / 1 mặt',
        heatSeal: 'Có',
        note: 'Màng sáng bóng, khi kéo giãn màng bị mờ đi. In trên mặt mạ metalized.',
        metalized: true,
    },
    {
        code: 'MPET',
        thicknessMinUm: 12,
        thicknessMaxUm: 12,
        thicknessRaw: '12',
        corona: '38–42 / 1 mặt',
        heatSeal: 'Không',
        note: 'Cứng, vò kêu sột soạt, sáng bóng hơn MCPP, kéo không giãn. In trên mặt mạ metalized.',
        metalized: true,
    },
    {
        code: 'MPVC',
        thicknessMinUm: 25,
        thicknessMaxUm: 30,
        thicknessRaw: '25–30',
        corona: '38 / 1 mặt',
        heatSeal: 'Không',
        note: 'Màng giòn, có khả năng xoắn, dễ xé cong theo mọi hướng. In trên mặt mạ metalized.',
        metalized: true,
    },
    {
        code: 'Hicor',
        thicknessMinUm: 25,
        thicknessMaxUm: 25,
        thicknessRaw: '25',
        corona: '38 / 1 mặt',
        heatSeal: 'Không',
        note: 'Có khả năng xoắn, xé thẳng theo hướng ngang của máy. In trên mặt mạ metalized.',
        metalized: true,
    },
];

/** Sức căng bề mặt (dynes/cm) — bảng con 'Sức căng bề mặt' */
export const FILM_SURFACE_TENSION: Array<{ film: string; dynesRaw: string }> = [
    { film: 'PP, OPP, BOPP', dynesRaw: '29–31' },
    { film: 'PE', dynesRaw: '30–31' },
    { film: 'PS', dynesRaw: '38' },
    { film: 'PA', dynesRaw: '<36' },
    { film: 'PVC', dynesRaw: '39' },
    { film: 'PET', dynesRaw: '41–44' },
];

/**
 * Tính chất cơ nhiệt của màng thông dụng — bảng con đầu sheet.
 * Giữ dạng chuỗi vì phần lớn ô là khoảng giá trị, không phải một số.
 */
export const FILM_MECHANICAL_PROPERTIES: Array<{
    film: string;
    thicknessUm: string;
    tensileMd: string;
    tensileCd: string;
    elongationMd: string;
    elongationTd: string;
    sealTempC: string;
}> = [
    { film: 'LDPE', thicknessUm: '25–250', tensileMd: '200–280', tensileCd: '160–230', elongationMd: '300–450', elongationTd: '450–680', sealTempC: '100–110' },
    { film: 'HDPE', thicknessUm: '20–25', tensileMd: '33', tensileCd: '25', elongationMd: '800', elongationTd: '1000', sealTempC: '–' },
    { film: 'PP', thicknessUm: '25–50', tensileMd: '410', tensileCd: '290', elongationMd: '730', elongationTd: '700', sealTempC: '155–165' },
    { film: 'PA-6 (oriented)', thicknessUm: '13–20', tensileMd: '300', tensileCd: '300', elongationMd: '70', elongationTd: '70', sealTempC: '–' },
];

/**
 * Khả năng thấm khí O₂, dầu mỡ, WVTR — bảng con 'Khả năng thấm khí oxy…'
 * Giữ dạng chuỗi vì ô Excel là khoảng giá trị.
 */
export const FILM_PERMEABILITY: Array<{
    film: string;
    thicknessUm: string;
    /** cm³/(m²·24h) */
    o2Permeability: string;
    oilResistance: string;
    /** g/m²/24h */
    wvtr: string;
}> = [
    { film: 'LDPE', thicknessUm: '25–250', o2Permeability: '4250–5000', oilResistance: 'Khá, tốt', wvtr: '2.5–3.8' },
    { film: 'LDPE', thicknessUm: '30–100', o2Permeability: '3500–6000', oilResistance: 'Khá, tốt', wvtr: '1.4–2.6' },
    { film: 'HDPE', thicknessUm: '20–25', o2Permeability: '4000–300', oilResistance: '–', wvtr: '4.0–3.5' },
    { film: 'HDPE', thicknessUm: '40–70', o2Permeability: '2000–800', oilResistance: '–', wvtr: '2.5–1.5' },
    { film: 'PP', thicknessUm: '25–100', o2Permeability: '2500', oilResistance: 'Rất tốt', wvtr: '2.0' },
    { film: 'PA-6 (oriented)', thicknessUm: '13–22', o2Permeability: '28–18', oilResistance: 'Tốt', wvtr: '35–20' },
];

/**
 * Độ đục, độ bóng, độ trong — bảng con 'Độ đục, độ bóng, độ trong…'
 * Độ trong tính theo % so với thủy tinh 92%.
 */
export const FILM_OPTICAL_PROPERTIES: Array<{
    film: string;
    /** % */
    haze: string;
    gloss: string;
    /** % so với thủy tinh 92% */
    clarity: string;
}> = [
    { film: 'LDPE', haze: '6.0', gloss: '75', clarity: '65' },
    { film: 'LLDPE', haze: '6.0', gloss: '75', clarity: '65' },
    { film: 'HDPE', haze: '3.0', gloss: '78', clarity: '–' },
    { film: 'OPP', haze: '3.0', gloss: '85', clarity: '80' },
    { film: 'OPS', haze: '1.0', gloss: '150', clarity: '92' },
    { film: 'PVC', haze: '1.0', gloss: '150', clarity: '90' },
    { film: 'Nylon 6', haze: '–', gloss: '–', clarity: '–' },
    { film: 'Nylon 6 Biax', haze: '3.0', gloss: '20', clarity: '88' },
    { film: 'Cellophane-Polymer', haze: '1.0', gloss: '90', clarity: '90' },
];

/**
 * Tính chất điển hình của các màng PE — bảng con 'các tính chất điển hình
 * của các màng polyethylene'.
 */
export const FILM_PE_PROPERTIES: Array<{
    property: string;
    ldpe: string;
    lldpe: string;
    hdpe: string;
}> = [
    { property: 'Nhiệt độ chuyển hóa thủy tinh (Tg, °C)', ldpe: '-120', lldpe: '-120', hdpe: '-120' },
    { property: 'Nhiệt độ nóng chảy (Tm, °C)', ldpe: '105–115', lldpe: '122–124', hdpe: '128–138' },
    { property: 'Nhiệt độ biến dạng nhiệt tại 455 kPa (°C)', ldpe: '40–44', lldpe: '–', hdpe: '62–91' },
    { property: 'Mật độ (g/cm³)', ldpe: '0.915–0.940', lldpe: '0.915–0.935', hdpe: '0.94–0.97' },
    { property: 'Modul kéo căng (GPa)', ldpe: '0.2–0.5', lldpe: '–', hdpe: '0.6–1.1' },
    { property: 'Độ bền kéo căng (MPa)', ldpe: '8–31', lldpe: '20–45', hdpe: '17–45' },
    { property: 'Độ giãn dài (%)', ldpe: '100–965', lldpe: '350–850', hdpe: '10–1200' },
    { property: 'WVTR tại 37,8°C và RH = 90% (g·µm/m²·d)', ldpe: '375–500', lldpe: '–', hdpe: '125' },
    { property: 'Khả năng thấm O₂ tại 25°C (10³ cm³·µm/m²·d·atm)', ldpe: '160–210', lldpe: '–', hdpe: '40–73' },
];

/**
 * Tính chất điển hình của PP, BOPP, PVC — bảng con 'Các tính chất đặc trưng
 * của các màng PP, BOPP và PVC'.
 */
export const FILM_PP_PVC_PROPERTIES: Array<{
    property: string;
    pp: string;
    bopp: string;
    pvc: string;
}> = [
    { property: 'Nhiệt độ chuyển hóa thủy tinh (Tg, °C)', pp: '-10', bopp: '-10', pvc: '75–105' },
    { property: 'Nhiệt độ nóng chảy (Tm, °C)', pp: '160–175', bopp: '160–175', pvc: '212' },
    { property: 'Nhiệt độ biến dạng nhiệt tại 455 kPa (°C)', pp: '107–121', bopp: '–', pvc: '57–82' },
    { property: 'Mật độ (g/cm³)', pp: '0.89–0.91', bopp: '0.89–0.91', pvc: '1.35–1.41' },
    { property: 'Modul kéo căng (GPa)', pp: '1.1–1.5', bopp: '1.7–2.4', pvc: '–' },
    { property: 'Độ bền kéo căng (MPa)', pp: '31–43', bopp: '120–240', pvc: '10–55' },
    { property: 'Độ giãn dài (%)', pp: '500–650', bopp: '30–150', pvc: '14–450' },
    { property: 'WVTR tại 37,8°C và RH = 90% (g·µm/m²·d)', pp: '100–300', bopp: '100–125', pvc: '750–15.700' },
    { property: 'Khả năng thấm O₂ tại 25°C (10³ cm³·µm/m²·d·atm)', pp: '50–94', bopp: '37–58', pvc: '3.7–240' },
];

/**
 * Tính chất điển hình của PET — bảng con 'Các tính chất điển hình của màng PET'.
 */
export const FILM_PET_PROPERTIES: Array<{
    property: string;
    petUnoriented: string;
    petOriented: string;
}> = [
    { property: 'Nhiệt độ chuyển hóa thủy tinh (Tg, °C)', petUnoriented: '73–80', petOriented: '73–80' },
    { property: 'Nhiệt độ nóng chảy (Tm, °C)', petUnoriented: '245–265', petOriented: '245–265' },
    { property: 'Nhiệt độ biến dạng nhiệt tại 455 kPa (°C)', petUnoriented: '38–129', petOriented: '–' },
];

/**
 * Tính chất điển hình của Nylon — bảng con 'Các tính chất điển hình của màng nylon'.
 */
export const FILM_NYLON_PROPERTIES: Array<{
    property: string;
    nylon6: string;
    nylon11: string;
    nylonMxd6: string;
}> = [
    { property: 'Nhiệt độ chuyển hóa thủy tinh (Tg, °C)', nylon6: '60', nylon11: '–', nylonMxd6: '64' },
    { property: 'Nhiệt độ nóng chảy (Tm, °C)', nylon6: '210–220', nylon11: '180–190', nylonMxd6: '243' },
    { property: 'Nhiệt độ biến dạng nhiệt tại 455 kPa (°C)', nylon6: '–', nylon11: '–', nylonMxd6: '–' },
];

/** Độ dày màng đổi sang mm — để cộng vào tính gáy sách hoặc bù khuôn bế */
export function filmThicknessMm(film: LaminationFilm, which: 'min' | 'max' = 'max'): number {
    const um = which === 'min' ? film.thicknessMinUm : film.thicknessMaxUm;
    return um / 1000;
}

/** Tra màng theo mã, bỏ qua hoa/thường và khoảng trắng thừa */
export function findFilm(code: string): LaminationFilm | undefined {
    const target = code.trim().toLowerCase().replace(/\s+/g, ' ');
    return LAMINATION_FILMS.find(f => f.code.toLowerCase() === target);
}

/** Danh sách màng hàn nhiệt được — lọc theo cột 'Khả năng hàn nhiệt' */
export function listHeatSealableFilms(): LaminationFilm[] {
    return LAMINATION_FILMS.filter(f => f.heatSeal?.startsWith('Có'));
}
