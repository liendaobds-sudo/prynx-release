/** Hệ số quy đổi 1 đơn vị → mm (backend luôn nhận mm). */
export const UNIT_TO_MM: Record<'mm' | 'cm' | 'pt' | 'inch', number> = {
    mm: 1,
    cm: 10,
    pt: 25.4 / 72,
    inch: 25.4,
};
