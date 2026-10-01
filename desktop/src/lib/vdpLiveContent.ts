import type { VdpToolField } from '../hooks/useVdpTool';

type VdpRecord = Readonly<Record<string, unknown>>;
interface LogicItem {
    column?: unknown;
    operator?: unknown;
    value?: unknown;
    action?: unknown;
    result?: unknown;
}

export interface ResolvedVdpLiveContent {
    visible: boolean;
    content: string;
    missingColumn?: string;
    unsupportedFormat?: string;
}

const hasColumn = (row: VdpRecord, column: string) => Object.prototype.hasOwnProperty.call(row, column);
const stringValue = (value: unknown): string => value == null ? 'None' : typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value);
// Python strip/split coi U+001C–001F là khoảng trắng và giữ BOM U+FEFF.
const strip = (value: string) => value.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, '');

// VDP (audit 2026-10-01): so sánh như casefold của Python, kể cả ß/ς/ligature.
// Giữ i không chấm: Unicode không gộp ký tự này với I trong so sánh mặc định.
const normalize = (value: unknown): string => value == null ? '' : Array.from(strip(stringValue(value)), char => (
    char === '\u0131' ? char : char.toLowerCase().toUpperCase().toLowerCase()
)).join('');

function matches(item: LogicItem, row: VdpRecord): boolean {
    const cell = normalize(row[String(item.column ?? '')]);
    const value = normalize(item.value);
    switch (item.operator ?? 'eq') {
        case 'eq': return cell === value;
        case 'ne': return cell !== value;
        case 'contains': return cell.includes(value);
        case 'empty': return cell === '';
        case 'not_empty': return cell !== '';
        default: return false;
    }
}

function logicItems(value: unknown): LogicItem[] {
    return Array.isArray(value) ? value.filter((item): item is LogicItem => !!item && typeof item === 'object') : [];
}

class MissingColumn extends Error {
    constructor(readonly column: string) { super(column); }
}
class UnsupportedFormat extends Error {
    constructor(readonly format: string) { super(format); }
}

function assertColumns(items: LogicItem[], row: VdpRecord): void {
    for (const item of items) {
        const column = String(item.column ?? '');
        if (!hasColumn(row, column)) throw new MissingColumn(column);
    }
}

function scanBranch(text: string, start: number, terminators: string): [string, number, string] {
    let value = '';
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (char === '\\' && '\\:}'.includes(text[i + 1] ?? '\0')) {
            value += text[++i];
        } else if (terminators.includes(char)) {
            return [value, i, char];
        } else {
            value += char;
        }
    }
    return [value, text.length, ''];
}

/** Cùng ngữ nghĩa với resolve_inline: nhánh là literal, không đệ quy. */
export function resolveVdpInline(text: string, row: VdpRecord): string {
    let output = '';
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
            let question = i + 1;
            while (question < text.length && !'{}:?'.includes(text[question])) question++;
            if (text[question] === '?' && question > i + 1) {
                const [yes, colon, yesTerm] = scanBranch(text, question + 1, ':}');
                if (yesTerm === ':') {
                    const [no, end, noTerm] = scanBranch(text, colon + 1, '}');
                    if (noTerm === '}') {
                        const column = text.slice(i + 1, question);
                        if (!hasColumn(row, column)) throw new MissingColumn(column);
                        output += normalize(row[column]) ? yes : no;
                        i = end;
                        continue;
                    }
                }
            }
        }
        output += text[i];
    }
    return output;
}

function titleCase(value: string): string {
    const special: Record<string, string> = {
        '\u0149': '\u02bcN', '\u1fb2': '\u1fba\u0345', '\u1fb3': '\u1fbc', '\u1fb4': '\u0386\u0345',
        '\u1fb7': '\u0391\u0342\u0345', '\u1fbc': '\u1fbc', '\u1fc2': '\u1fca\u0345', '\u1fc3': '\u1fcc',
        '\u1fc4': '\u0389\u0345', '\u1fc7': '\u0397\u0342\u0345', '\u1fcc': '\u1fcc', '\u1ff2': '\u1ffa\u0345',
        '\u1ff3': '\u1ffc', '\u1ff4': '\u038f\u0345', '\u1ff7': '\u03a9\u0342\u0345', '\u1ffc': '\u1ffc',
    };
    const titleChar = (char: string): string => {
        const code = char.codePointAt(0)!;
        if (special[char]) return special[char];
        if (code >= 0x01c4 && code <= 0x01cc) return String.fromCodePoint(code - (code - 0x01c4) % 3 + 1);
        if (code >= 0x01f1 && code <= 0x01f3) return '\u01f2';
        if (code >= 0x10d0 && code <= 0x10ff) return char;
        if (code >= 0x1f80 && code <= 0x1faf) return String.fromCodePoint(code | 8);
        const upper = Array.from(char.toUpperCase());
        return upper[0] + upper.slice(1).join('').toLowerCase();
    };
    const chars = Array.from(value);
    const isCased = (char: string) => /\p{Cased}/u.test(char);
    const hasCasedNeighbor = (index: number, direction: number): boolean => {
        for (let next = index + direction; next >= 0 && next < chars.length; next += direction) {
            if (!/\p{Case_Ignorable}/u.test(chars[next])) return isCased(chars[next]);
        }
        return false;
    };
    let previousCased = false;
    return chars.map((char, index) => {
        const cased = isCased(char);
        const lower = char === 'Σ' && hasCasedNeighbor(index, -1) && !hasCasedNeighbor(index, 1) ? 'ς' : char.toLowerCase();
        const result = previousCased ? lower : titleChar(char);
        previousCased = cased;
        return result;
    }).join('');
}

// Làm tròn half-even trên giá trị IEEE-754 thật, giống f"{num:,.Nf}" của Python.
// Không dùng toFixed/Intl mặc định vì 2.5 và 2.675 có kết quả khác nhau.
function formatNumber(value: number, decimals: number): string {
    if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value < 0 ? '-inf' : 'inf';
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setFloat64(0, Math.abs(value));
    const bits = buffer.getBigUint64(0);
    const exponentBits = Number((bits >> 52n) & 0x7ffn);
    const mantissa = (bits & ((1n << 52n) - 1n)) + (exponentBits ? 1n << 52n : 0n);
    const exponent = (exponentBits || 1) - 1023 - 52;
    let numerator = mantissa * 10n ** BigInt(decimals);
    const denominator = exponent < 0 ? 1n << BigInt(-exponent) : 1n;
    if (exponent > 0) numerator <<= BigInt(exponent);
    let rounded = numerator / denominator;
    const remainder = numerator % denominator;
    if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded % 2n === 1n)) rounded++;
    const digits = rounded.toString().padStart(decimals + 1, '0');
    const integer = decimals ? digits.slice(0, -decimals) : digits;
    const fraction = decimals ? `.${digits.slice(-decimals)}` : '';
    return `${value < 0 || Object.is(value, -0) ? '-' : ''}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction}`;
}

function parseDate(raw: string): Date | null {
    const value = strip(raw);
    const patterns: Array<[RegExp, 'ymd' | 'dmy' | 'mdy']> = [
        [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, 'ymd'],
        [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, 'dmy'],
        [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, 'mdy'],
        [/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, 'ymd'],
        [/^(\d{1,2})-(\d{1,2})-(\d{4})$/, 'dmy'],
        [/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/, 'ymd'],
        [/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{1,2})$/, 'dmy'],
    ];
    for (const [pattern, order] of patterns) {
        const match = value.match(pattern);
        if (!match) continue;
        const [, a, b, c, hh = '0', mm = '0', ss = '0'] = match;
        const [year, month, day] = order === 'ymd' ? [+a, +b, +c] : order === 'dmy' ? [+c, +b, +a] : [+c, +a, +b];
        if (year < 1 || year > 9999) continue;
        const date = new Date(0);
        date.setUTCFullYear(year, month - 1, day);
        date.setUTCHours(+hh, +mm, +ss, 0);
        if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
            && date.getUTCHours() === +hh && date.getUTCMinutes() === +mm && date.getUTCSeconds() === +ss) return date;
    }
    return null;
}

function formatDate(raw: string, format: string): string {
    const date = parseDate(raw);
    if (!date) return raw;
    const pad = (value: number, count = 2) => String(value).padStart(count, '0');
    const firstDay = new Date(date);
    firstDay.setUTCMonth(0, 1);
    firstDay.setUTCHours(0, 0, 0, 0);
    const tokens: Record<string, string> = {
        '%': '%', Y: pad(date.getUTCFullYear(), 4), y: pad(date.getUTCFullYear() % 100),
        m: pad(date.getUTCMonth() + 1), d: pad(date.getUTCDate()), H: pad(date.getUTCHours()),
        I: pad(date.getUTCHours() % 12 || 12), M: pad(date.getUTCMinutes()), S: pad(date.getUTCSeconds()),
        f: '000000', j: pad(Math.floor((date.getTime() - firstDay.getTime()) / 86400000) + 1, 3),
        w: String(date.getUTCDay()), u: String(date.getUTCDay() || 7), z: '', Z: '',
    };
    // strftime với tên tháng/ngày, AM/PM hoặc %c/%x/%X phụ thuộc locale của
    // process Python. Không đoán theo locale WebView: đánh dấu LIVE chưa hỗ trợ.
    return format.replace(/%(.)|%$/g, (token, directive: string | undefined) => {
        if (directive && hasColumn(tokens, directive)) return tokens[directive];
        throw new UnsupportedFormat(`date:${token}`);
    });
}

function applyFormat(raw: string, func: string | undefined, arg: string | undefined): string {
    // float/int của Python nhận mọi chữ số Unicode Decimal_Number và dấu
    // gạch dưới giữa hai chữ số; Number() của JavaScript không tự đổi chúng.
    const asciiDigits = (value: string): string => value.replace(/\p{Decimal_Number}/gu, char => {
        let code = char.codePointAt(0)!;
        let offset = 0;
        while (/\p{Decimal_Number}/u.test(String.fromCodePoint(--code))) offset++;
        return String(offset % 10);
    });
    const integerArg = (): number => {
        const value = asciiDigits(strip(arg || '0'));
        if (!/^[+-]?\d(?:_?\d)*$/.test(value)) return NaN;
        return Number(value.replaceAll('_', ''));
    };
    switch (func?.toLowerCase()) {
        case 'upper': return raw.toUpperCase();
        case 'lower': return raw.toLowerCase();
        case 'title': case 'cap': return titleCase(raw);
        case 'trim': return strip(raw);
        case 'pad': case 'padl': case 'padr': {
            const width = integerArg();
            if (!Number.isSafeInteger(width)) return raw;
            const value = strip(raw);
            try {
                const padding = '0'.repeat(Math.max(0, width - Array.from(value).length));
                return func.toLowerCase() === 'padr' ? value + padding : padding + value;
            } catch {
                return raw; // Giống backend: định dạng không hợp lệ giữ nguyên ô.
            }
        }
        case 'number': case 'num': case 'money': {
            const decimals = integerArg();
            if (!Number.isSafeInteger(decimals) || decimals < 0) return raw;
            // LIVE chạy trong render của WebView; không tạo chuỗi khổng lồ chỉ
            // vì một token có precision bất thường. PDF backend vẫn là nguồn sự thật.
            if (decimals > 100) throw new UnsupportedFormat(`${func}:${arg}`);
            let value = asciiDigits(strip(raw.replaceAll(',', '')));
            if (/(?:^|[^\d])_|_(?:[^\d]|$)/.test(value)) return raw;
            value = value.replaceAll('_', '');
            if (!/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|inf(?:inity)?|nan)$/i.test(value)) return raw;
            const number = /^[+-]?inf(?:inity)?$/i.test(value) ? (value.startsWith('-') ? -Infinity : Infinity) : Number(value);
            try {
                return formatNumber(number, decimals);
            } catch {
                return raw;
            }
        }
        case 'date': return formatDate(raw, arg || '%d/%m/%Y');
        default: return raw;
    }
}

function substitute(text: string, row: VdpRecord): string {
    return text.replace(/\{([^{}|\[\]]+)(?:\[(\d+)(?:\|([^\]]*))?\])?(?:\|([a-zA-Z]+)(?::([^}]*))?)?\}/g,
        (token, column: string, index: string | undefined, delimiter: string | undefined, func: string | undefined, arg: string | undefined) => {
            if (!hasColumn(row, column)) return token;
            let raw = stringValue(row[column]);
            if (index !== undefined) {
                const parts = delimiter ? raw.split(delimiter).map(strip) : strip(raw).split(/[\p{White_Space}\u001c-\u001f]+/u);
                raw = parts[Number(index) - 1] ?? '';
            }
            return applyFormat(raw, func, arg);
        });
}

/** VDP (audit 2026-10-01): cùng thứ tự và lỗi cột như resolve_field_content. */
export function resolveVdpLiveContent(field: VdpToolField, row?: VdpRecord | null): ResolvedVdpLiveContent {
    const fallback = field.textContent ?? (field.name ? `{${field.name}}` : '');
    if (!row) return { visible: true, content: fallback };
    try {
        const conditions = logicItems(field.conditions);
        assertColumns(conditions, row);
        if (conditions.some(condition => condition.action === 'hide_if' ? matches(condition, row) : !matches(condition, row))) {
            return { visible: false, content: '' };
        }
        let content = field.textContent == null || (hasColumn(row, field.name) && !fallback.includes('{'))
            ? `{${field.name}}` : fallback;
        const rules = logicItems(field.rules);
        assertColumns(rules, row);
        const rule = rules.find(item => matches(item, row));
        if (rule) content = String(rule.result || '');
        content = substitute(resolveVdpInline(content, row), row);
        if (field.type === 'image' && (!content || (content.startsWith('{') && content.endsWith('}')))) {
            content = typeof field.imagePath === 'string' ? field.imagePath : '';
        }
        return { visible: true, content };
    } catch (error) {
        if (error instanceof MissingColumn) return { visible: true, content: `MISSING: ${field.name}`, missingColumn: error.column };
        // Giữ template gốc để LIVE không biến mất im lặng khi directive phụ
        // thuộc locale Python chưa có bản tương đương trong WebView.
        if (error instanceof UnsupportedFormat) return { visible: true, content: fallback, unsupportedFormat: error.format };
        throw error;
    }
}

/** ID riêng chỉ dành cho dữ liệu bìa nhiều cụm; không ghi đè cột CSV trùng ID. */
export function resolveVdpPreviewContent(field: VdpToolField, state?: {
    enabled: boolean;
    currentRecord: VdpRecord | null;
    sourceTitle?: string;
} | null): ResolvedVdpLiveContent {
    if (!state?.enabled || !state.currentRecord) return resolveVdpLiveContent(field);
    let row = state.currentRecord;
    const fallback = field.textContent ?? (field.name ? `{${field.name}}` : '');
    const singleFieldToken = strip(fallback) === `{${field.name}}`;
    const isNumbering = /^(?:Số nhảy|Bìa):/.test(state.sourceTitle ?? '');
    // Giữ tương thích dữ liệu số nhảy/bìa: các generator cũ phát record theo
    // id field, trong khi CSV/VDP chuẩn phát theo tên cột.
    if (isNumbering && singleFieldToken && hasColumn(row, field.id)) {
        row = { ...row, [field.name]: row[field.id] };
    } else if (isNumbering && singleFieldToken && typeof field.fieldName === 'string' && hasColumn(row, field.fieldName)) {
        row = { ...row, [field.name]: row[field.fieldName] };
    }
    return resolveVdpLiveContent(field, row);
}

/** Trả đường dẫn nguồn; caller chọn protocol đọc file phù hợp với môi trường. */
export function resolveVdpLiveImagePath(field: VdpToolField, content: string): string {
    const value = strip(content);
    if (!value || (value.startsWith('{') && value.endsWith('}'))) return typeof field.imagePath === 'string' ? field.imagePath : '';
    if (/^(?:https?:|data:|blob:|[a-z]:[\\/]|[\\/])/i.test(value)) return value;
    const base = typeof field.imageBaseDir === 'string' ? field.imageBaseDir : '';
    return base ? `${base.replace(/[\\/]$/, '')}${base.includes('\\') ? '\\' : '/'}${value}` : value;
}
