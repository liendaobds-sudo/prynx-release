import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as ed from "https://esm.sh/@noble/ed25519@1.7.3";
import {
    deriveDeviceKeyIdV3,
    deriveLicenseRequestHashV3,
    LICENSE_PROTOCOL_V3,
    LICENSE_TOKEN_V3_DEFAULT_LEASE_SECONDS,
    LICENSE_TOKEN_V3_MAX_TTL_SECONDS,
    LICENSE_TOKEN_V3_LEGACY_TTL_SECONDS,
    LicenseProtocolV3Action,
    parseDevicePublicIdentityV3,
    parseLicenseTokenClaimsV3,
    parseServerLicenseChallengeV3,
    requiredPrynXLegacyIssueProtocolV3,
    verifyDeviceLicenseProofV3,
    type DevicePublicIdentityV3,
    type ServerLicenseChallengeV3,
} from "../_shared/license_protocol_v3.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Token license ký Ed25519 — sidecar (pdfcompare) verify bằng public key nhúng sẵn.
// Private key (base64 raw 32 byte) đặt ở secret LICENSE_SIGNING_KEY.
// TTL = NGÂN SÁCH OFFLINE THẬT của client, và cũng là ĐỘ TRỄ THU HỒI xấu nhất:
// sidecar production không giữ service key nên không gọi RPC được (xem license_guard
// ._verify_with_supabase) → biên giới duy nhất là token này. Kẻ chặn mạng dùng được
// tới đúng `exp`. Audit 2026-07-25 rút 7 ngày → 72h: vẫn qua được cuối tuần dài /
// chuyến công tác ngắn, nhưng cửa sổ thu hồi giảm hơn một nửa.
//
// RÀNG BUỘC: PHẢI ≤ cận chống-lùi-giờ ở cả hai verifier —
//   backend  license_guard._MAX_TOKEN_LIFETIME_SECONDS (env PRYNX_MAX_TOKEN_LIFETIME_SECONDS)
//   Rust     security.rs MAX_TOKEN_LIFETIME_SECS
// Hai cận đó đang là 8 ngày và CỐ Ý giữ nguyên trong giai đoạn chuyển tiếp: token
// 7 ngày đã phát trước đây vẫn còn hạn, siết cận xuống 4 ngày ngay sẽ khiến chúng bị
// từ chối ("lifetime implausible") → khách đang offline bị khoá oan. Chỉ siết cận
// xuống 4 ngày SAU KHI toàn bộ token 7 ngày đã hết hạn (≥ 7 ngày kể từ lúc deploy này).
const TOKEN_TTL_SECONDS = 72 * 60 * 60; // 72h
const LICENSE_PROTOCOL_V2 = 2;
const LICENSE_CHALLENGE_RE = /^[0-9a-f]{64}$/i;
const PRYNX_V1_ROLLOUT_MAX_SECONDS = 7 * 24 * 60 * 60;
const CLIENT_SIGNAL_DEDUPE_SECONDS = 15 * 60;
const INVALID_VERIFY_DEDUPE_SECONDS = 5 * 60;
const MAX_DETAILS_BYTES = 4096;
const ALLOWED_SIGNALS = new Set([
  'clock_anchor_rollback','clock_anchor_unavailable','clock_manipulation',
  'forward_clock_jump','supabase_blocked','offline_exceeded',
  'device_limit','integrity_violation','tamper_detected',
]);

interface VerifyRequest {
    license_key: string;
    machine_id: string;
    product_id: string;
    // Phiên bản app đang chạy — dùng để cấp ĐÚNG khoá tài nguyên của bản đó
    // (xem `lookupResourceKey`). Client cũ không gửi ⇒ không nhận khoá, vẫn chạy bình
    // thường vì binary cũ nhúng tài nguyên dạng plaintext.
    app_version?: string;
    /** Client mới xin lease 72h; v3 client cũ bỏ qua và nhận lease 15 phút. */
    offline_lease_seconds?: number;
    // Protocol v2 nối token với một challenge CSPRNG do native cấp trước khi
    // gọi Edge. Không ghi challenge vào telemetry/log.
    protocol_version?: number;
    challenge?: string;
    // Tín hiệu bất thường do client phát hiện (vd chỉnh đồng hồ). Ghi log server-side
    // bằng service role → không giả/flood trực tiếp được. Tùy chọn.
    client_signal?: { event_type: string; details?: Record<string, unknown> };
}

interface LicenseTokenV3Binding {
    deviceKeyId: string;
    challengeId: string;
}

interface PrynXProtocolPolicy {
    minimumIssueProtocol: 2 | 3;
    legacyIssueUntilSeconds: number;
}

type SecurityEventRow = {
    source: 'client' | 'server';
    event_type: string;
    product_id?: string | null;
    license_key?: string | null;
    machine_id?: string | null;
    ip?: string | null;
    user_agent?: string | null;
    customer_email?: string | null;
    details?: Record<string, unknown> | null;
};

type SecurityEventResult = {
    processed: boolean;
    stored: boolean;
    deduplicated: boolean;
};

function maskLicenseKey(value: string | null | undefined): string | null {
    if (!value) return null;
    if (value.length <= 12) return value.slice(0, 4) + '…';
    return value.slice(0, 8) + '…' + value.slice(-4);
}

function isSafeIdentifier(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

/**
 * Cửa sổ drain token v1 phải được ops bật bằng một Unix timestamp tương lai gần.
 * Mặc định/giá trị sai/hết hạn đều đóng; hard max 7 ngày ngăn cấu hình nhầm thành
 * đường downgrade dài hạn. `app_version` cố ý không phải security boundary.
 */
function isPrynXV1RolloutOpen(nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    const rawCutoff = Deno.env.get('PRYNX_LICENSE_V1_ROLLOUT_UNTIL')?.trim() ?? '';
    if (!/^[1-9][0-9]{9}$/.test(rawCutoff)) return false;
    const cutoff = Number(rawCutoff);
    return Number.isSafeInteger(cutoff)
        && cutoff > nowSeconds
        && cutoff <= nowSeconds + PRYNX_V1_ROLLOUT_MAX_SECONDS;
}

function sanitizeDetails(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    try {
        const serialized = JSON.stringify(value);
        if (new TextEncoder().encode(serialized).length > MAX_DETAILS_BYTES) return null;
        return JSON.parse(serialized) as Record<string, unknown>;
    } catch {
        return null;
    }
}

// Ghi sự kiện bảo mật vào security_logs bằng service role (bypass RLS).
// LUÔN bọc try/catch: lỗi ghi log KHÔNG được làm hỏng việc xác thực.
async function logSecurityEvent(
    supabase: ReturnType<typeof createClient>,
    row: SecurityEventRow,
    dedupeSeconds: number,
): Promise<SecurityEventResult> {
    try {
        const since = new Date(Date.now() - dedupeSeconds * 1000).toISOString();
        let duplicateQuery = supabase
            .from('security_logs')
            .select('id')
            .eq('event_type', row.event_type)
            .gte('created_at', since)
            .limit(1);

        if (row.source === 'client' && row.machine_id) {
            duplicateQuery = duplicateQuery.eq('machine_id', row.machine_id);
        } else if (row.ip) {
            duplicateQuery = duplicateQuery.eq('ip', row.ip);
        } else if (row.license_key) {
            duplicateQuery = duplicateQuery.eq('license_key', row.license_key);
        }

        const { data: duplicate, error: duplicateError } = await duplicateQuery.maybeSingle();
        if (duplicateError) {
            console.error('Security log dedupe query failed:', duplicateError.message);
        } else if (duplicate) {
            return { processed: true, stored: false, deduplicated: true };
        }

        const { error } = await supabase.from('security_logs').insert({
            source: row.source,
            event_type: row.event_type,
            product_id: row.product_id ?? null,
            license_key: maskLicenseKey(row.license_key),
            machine_id: row.machine_id ?? null,
            ip: row.ip ?? null,
            user_agent: row.user_agent ?? null,
            customer_email: row.customer_email ?? null,
            details: row.details ?? null,
        });
        if (error) {
            console.error('Security log insert failed:', error.message);
            return { processed: false, stored: false, deduplicated: false };
        }
        return { processed: true, stored: true, deduplicated: false };
    } catch (e) {
        console.error('logSecurityEvent failed (non-blocking):', e);
        return { processed: false, stored: false, deduplicated: false };
    }
}

function b64url(bytes: Uint8Array): string {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function sha256Hex16(s: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 16);
}

// SEC (F4): SHA-256 hex day du — dung lam khoa dem rk-grant theo license (khong luu key tho).
async function sha256Hex(s: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Khoá tài nguyên theo BẢN PHÁT HÀNH (anticrack 2026-07-26) ────────────────
// Engine dieline trong `pdfcompare_native` được MÃ HOÁ lúc build; khoá không nằm trong
// app mà nằm ở đây và chỉ đi kèm token ĐÃ KÝ khi license đủ quyền. Hệ quả: kẻ patch bỏ
// verify phía client cũng không mở được engine — muốn dùng phải có token thật. Khoá đổi
// mỗi bản phát hành nên một khoá bị rò chỉ mở được đúng bản đó.
//
// Bảng `release_resource_keys` chỉ service role đọc được (RLS deny-all) — xem migration
// `supabase/migrations/*_release_resource_keys.sql`.
const RESOURCE_FEATURE = 'packaging.dieline';

// [DIELINE-RK-GATE 2026-08-26] Cổng chống thu gom khoá ĐỔI BẢN CHẤT: chặn theo TỐC ĐỘ, không
// theo tổng số. Trần tổng cũ (`RK_VERSION_CAP = 5` bản khác nhau trong `RK_WINDOW_DAYS = 30`
// ngày, tính theo license) được thiết kế theo giả định "người dùng chạy một bản, thi thoảng
// update" — giả định đó sai với chính nhịp phát hành của dự án: đo được 10 bản khác nhau trong
// 30 ngày (rc.1 → rc.9). Cổng vì thế đang bắn vào khách hàng cập nhật bình thường, trong khi kẻ
// thu gom biết chờ vẫn gom đủ khoá. Mọi ngưỡng đặt trên "số bản trong 30 ngày" đều sai bản chất.
//
// Luật mới: tối đa RK_BURST_VERSION_LIMIT bản MỚI trong RK_BURST_WINDOW_MINUTES phút, đếm theo
// license (đổi máy KHÔNG reset bộ đếm — đó là chiều kẻ tấn công kiểm soát được). Xin lại khoá
// cho một bản ĐÃ được cấp không bao giờ tính thêm; luật idempotent đó nằm trong
// `claim_rk_grant_v2` (khoá chính `(license_hash, product_id, app_version)` của sổ cấp), và
// thiếu nó thì heartbeat 5 phút của một máy bình thường tự đốt hết hạn mức trong một giờ.
//
// Vì sao tốc độ là dấu vết đúng: người dùng thật chỉ tăng thêm một bản mỗi lần TẢI VÀ CÀI một
// build mới — cách nhau nhiều giờ tới nhiều ngày, kể cả ngày hotfix dày nhất. Kẻ thu gom lặp
// `app_version` trong vài giây tới vài phút. Hai hành vi cách nhau 2–3 bậc độ lớn, nên ngưỡng có
// biên an toàn rộng ở cả hai phía.
const RK_BURST_WINDOW_MINUTES = 60;
const RK_BURST_VERSION_LIMIT = 3;

// [DIELINE-RK-GATE 2026-08-26] Hợp đồng phản hồi khi khoá engine khuôn bế bị giữ lại (Design §D).
//
// Bảy giá trị, CHỈ đi vào phản hồi ở nhánh `result.status === 'VALID'`. KHÔNG bao giờ đi vào
// token: token chỉ có `rk` hoặc không, để bản cũ (engine plaintext) và user Free vẫn kích hoạt
// bình thường (3.6, 3.3).
//
// Ràng buộc nội dung — không có ngoại lệ: KHÔNG chứa giá trị khoá, KHÔNG chứa license key thô,
// KHÔNG chứa hash license, và KHÔNG chứa bộ đếm hay ngưỡng. Cửa sổ/ngưỡng chỉ đi vào
// `security_logs.details` phía server; đừng biến phản hồi thành công cụ đo cổng cho kẻ thu gom.
type RkStatus =
    // Token mang `rk` của đúng `app_version` đang chạy.
    | 'granted'
    // Client không gửi `app_version`, hoặc gửi chuỗi không qua regex SemVer-ish. Hành vi cũ (3.6).
    | 'not_requested'
    // `resourceKeyAllowed` false — plan Free / thiếu feature `packaging.dieline`. Hành vi cũ (3.3).
    | 'not_entitled'
    // Cổng cho phép nhưng không tra được hàng khoá chưa thu hồi cho bản đó.
    | 'no_key_for_version'
    // Cổng tốc độ từ chối.
    | 'burst_denied'
    // RPC cổng lỗi/không tồn tại và không có hàng legacy ⇒ fail-closed riêng `rk`.
    | 'infra_unavailable'
    // RPC cổng lỗi nhưng hàng đã đánh dấu legacy trả khoá.
    | 'legacy_fallback';

function resourceKeyAllowed(plan: string, features: string[] | null): boolean {
    if (plan === 'pro' || plan === 'dev') return true;
    return Array.isArray(features) && features.some((f) => f === '*' || f === RESOURCE_FEATURE);
}

async function lookupResourceKey(
    supabase: ReturnType<typeof createClient>,
    product_id: string,
    app_version: string | undefined,
    plan: string,
    features: string[] | null,
    legacyFallbackOnly = false,
): Promise<string | null> {
    if (!app_version || !resourceKeyAllowed(plan, features)) return null;
    let query = supabase
        .from('release_resource_keys')
        .select('resource_key, legacy_fallback')
        .eq('product_id', product_id)
        .eq('app_version', app_version)
        .eq('resource', 'dieline_engine')
        .is('revoked_at', null);
    if (legacyFallbackOnly) {
        query = query.eq('legacy_fallback', true);
    }
    const { data, error } = await query.maybeSingle();
    if (error) {
        // KHÔNG chặn kích hoạt: bản cũ (không mã hoá) vẫn phải dùng được. Bản đã khoá
        // sẽ tự báo "engine locked" phía client, và log này cho ops biết vì sao.
        console.error('Resource key lookup failed:', error.message);
        return null;
    }
    const key = data?.resource_key;
    return typeof key === 'string' && key.length > 0 ? key : null;
}

// Ký token: "<payload_b64url>.<sig_b64url>" — ký trên CHUỖI payload_b64url (khớp verifier Python).
async function signLicenseToken(
    license_key: string,
    machine_id: string,
    product_id: string,
    plan: string,
    features: string[] | null,
    resource_key: string | null,
    protocolVersion: number,
    challenge?: string,
    v3Binding?: LicenseTokenV3Binding,
    v3OfflineLeaseSeconds?: number,
    licenseExpiresAt?: string | null,
): Promise<string | null> {
    const privB64 = Deno.env.get("LICENSE_SIGNING_KEY");
    if (!privB64) {
        console.error("LICENSE_SIGNING_KEY not configured — cannot sign token");
        return null;
    }
    const priv = b64ToBytes(privB64.trim());
    const now = Math.floor(Date.now() / 1000);
    let tokenExpiresAt = now + TOKEN_TTL_SECONDS;
    if (protocolVersion === LICENSE_PROTOCOL_V3) {
        const requestedLease = v3OfflineLeaseSeconds ?? LICENSE_TOKEN_V3_DEFAULT_LEASE_SECONDS;
        if (!Number.isSafeInteger(requestedLease)
            || ![LICENSE_TOKEN_V3_LEGACY_TTL_SECONDS, LICENSE_TOKEN_V3_MAX_TTL_SECONDS]
                .includes(requestedLease)) return null;
        tokenExpiresAt = now + requestedLease;
    }
    if (typeof licenseExpiresAt === 'string') {
        const licenseExpirySeconds = Math.floor(Date.parse(licenseExpiresAt) / 1000);
        if (Number.isSafeInteger(licenseExpirySeconds)) {
            tokenExpiresAt = Math.min(tokenExpiresAt, licenseExpirySeconds);
        }
    }
    if (tokenExpiresAt <= now) return null;
    const payload = {
        k: await sha256Hex16(license_key),
        m: machine_id,
        p: product_id,
        plan,
        features: features || undefined,
        // `rk` nằm TRONG payload được ký ⇒ client không thể tự thêm/đổi khoá.
        rk: resource_key || undefined,
        exp: tokenExpiresAt,
    } as Record<string, unknown>;
    let tokenPayload = payload;
    if (protocolVersion === LICENSE_PROTOCOL_V2) {
        payload.v = LICENSE_PROTOCOL_V2;
        payload.iat = now;
        payload.challenge = challenge;
    } else if (protocolVersion === LICENSE_PROTOCOL_V3) {
        if (!v3Binding || machine_id !== v3Binding.deviceKeyId) {
            console.error('Refusing v3 token without canonical device binding');
            return null;
        }
        payload.exp = tokenExpiresAt;
        payload.v = LICENSE_PROTOCOL_V3;
        payload.iat = now;
        payload.d = v3Binding.deviceKeyId;
        payload.cnf = { jkt: v3Binding.deviceKeyId.slice(3) };
        payload.min_v = LICENSE_PROTOCOL_V3;
        payload.cid = v3Binding.challengeId;
        // Parse lại payload trước khi ký để `m=d`, `cnf`, `cid` và TTL không thể trôi
        // khi code cấp entitlement thay đổi về sau.
        try {
            tokenPayload = parseLicenseTokenClaimsV3(
                tokenPayload,
                now,
            ) as unknown as Record<string, unknown>;
        } catch {
            console.error('Refusing malformed v3 license token claims');
            return null;
        }
    }
    const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(tokenPayload)));
    const sig = await ed.sign(new TextEncoder().encode(payloadB64), priv);
    return payloadB64 + "." + b64url(sig);
}

type EdgeSupabaseClient = ReturnType<typeof createClient>;

interface RequestAuditContext {
    clientIp: string | null;
    userAgent: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readV3OfflineLeaseSeconds(value: unknown): number | null {
    if (value === undefined) return LICENSE_TOKEN_V3_DEFAULT_LEASE_SECONDS;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
    return [LICENSE_TOKEN_V3_LEGACY_TTL_SECONDS, LICENSE_TOKEN_V3_MAX_TTL_SECONDS]
        .includes(value)
        ? value
        : null;
}

function hasExactRequestKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[],
): boolean {
    const allowed = new Set([...required, ...optional]);
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
        && Object.keys(value).every((key) => allowed.has(key));
}

function isCanonicalUuid(value: unknown): value is string {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function isLowerHex(value: unknown, length: number): value is string {
    return typeof value === 'string'
        && value.length === length
        && /^[0-9a-f]+$/.test(value);
}

function equalAscii(left: string, right: string): boolean {
    let difference = left.length ^ right.length;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}

function readV3AppVersion(value: unknown): string | undefined | null {
    if (value === undefined) return undefined;
    return typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value)
        ? value
        : null;
}

async function readPrynXProtocolPolicy(
    supabase: EdgeSupabaseClient,
): Promise<PrynXProtocolPolicy | null> {
    const { data, error } = await supabase
        .from('prynx_protocol_policy')
        .select('minimum_issue_protocol,legacy_issue_until')
        .eq('product_id', 'prynx')
        .maybeSingle();
    if (error || !data) {
        console.error('PrynX protocol policy unavailable:', error?.message ?? 'missing row');
        return null;
    }
    const minimum = Number(data.minimum_issue_protocol);
    const legacyIssueUntilMilliseconds = Date.parse(String(data.legacy_issue_until));
    if (
        (minimum !== 2 && minimum !== 3) ||
        !Number.isFinite(legacyIssueUntilMilliseconds)
    ) {
        console.error('PrynX protocol policy malformed');
        return null;
    }
    return {
        minimumIssueProtocol: minimum,
        legacyIssueUntilSeconds: Math.floor(legacyIssueUntilMilliseconds / 1000),
    };
}

async function recordV3Failure(
    supabase: EdgeSupabaseClient,
    challengeId: string,
    resultCode: 'INVALID_PROOF' | 'KEY_MISMATCH' | 'INVALID_CHALLENGE',
): Promise<void> {
    const { error } = await supabase.rpc('record_prynx_device_challenge_failure_v3', {
        p_challenge_id: challengeId,
        p_result_code: resultCode,
    });
    if (error) console.error('Could not record v3 challenge failure:', error.message);
}

const V3_STATUS_MESSAGES: Readonly<Record<string, string>> = {
    INVALID: 'License không hợp lệ.',
    EXPIRED: 'License đã hết hạn.',
    KEY_MISMATCH: 'Khóa thiết bị không khớp.',
    MACHINE_REVOKED: 'Thiết bị đã bị thu hồi.',
    INVALID_CHALLENGE: 'Challenge không hợp lệ.',
    CHALLENGE_USED: 'Challenge đã được sử dụng.',
    CHALLENGE_EXPIRED: 'Challenge đã hết hạn.',
    CHALLENGE_LOCKED: 'Challenge đã bị khóa.',
    RECOVERY_REQUIRED: 'Thiết bị cần thực hiện khôi phục.',
    MIGRATION_CONFLICT: 'Không thể chuyển activation sang thiết bị này.',
    MIGRATION_PROOF_REQUIRED: 'Cần token cũ hợp lệ để chuyển activation sang TPM.',
    DEVICE_LIMIT: 'License đã đạt giới hạn thiết bị.',
    RATE_LIMITED: 'Thử quá nhiều lần. Vui lòng đợi rồi thử lại.',
    NOT_FOUND: 'Không tìm thấy activation.',
    FORBIDDEN: 'Yêu cầu bị từ chối.',
    INVALID_INPUT: 'Dữ liệu xác minh không hợp lệ.',
};

function v3StatusResponse(value: unknown, httpStatus = 200): Response {
    const record = isRecord(value) ? value : {};
    const status = typeof record.status === 'string'
        && Object.prototype.hasOwnProperty.call(V3_STATUS_MESSAGES, record.status)
        ? record.status
        : 'INVALID_INPUT';
    const response: Record<string, unknown> = {
        status,
        message: V3_STATUS_MESSAGES[status],
        protocol_version: LICENSE_PROTOCOL_V3,
        minimum_protocol: LICENSE_PROTOCOL_V3,
    };
    if (Number.isSafeInteger(record.current_activations)) {
        response.current_activations = record.current_activations;
    }
    if (Number.isSafeInteger(record.max_activations)) {
        response.max_activations = record.max_activations;
    }
    if (typeof record.expires_at === 'string') response.expires_at = record.expires_at;
    return jsonResponse(response, httpStatus);
}

async function issuePrynXV3Success(
    supabase: EdgeSupabaseClient,
    finalResult: Record<string, unknown>,
    challenge: ServerLicenseChallengeV3,
    appVersion: string | undefined,
    policy: PrynXProtocolPolicy,
    audit: RequestAuditContext,
    offlineLeaseSeconds: number,
): Promise<Response> {
    if (
        finalResult.status !== 'VALID' ||
        finalResult.device_key_id !== challenge.device_key_id ||
        finalResult.device_trust !== 'cng-key-proof' ||
        !Number.isSafeInteger(finalResult.protocol_floor) ||
        Number(finalResult.protocol_floor) < LICENSE_PROTOCOL_V3
    ) {
        console.error('Finalized v3 activation violates device authority policy');
        return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
    }

    const { data: licenseRow, error: licenseError } = await supabase
        .from('licenses')
        .select('license_key,customer_name,customer_email,plan,features,is_active,expires_at')
        .eq('id', challenge.license_id)
        .eq('product_id', 'prynx')
        .maybeSingle();
    if (
        licenseError ||
        !licenseRow ||
        licenseRow.is_active !== true ||
        !isSafeIdentifier(licenseRow.license_key, 50)
    ) {
        console.error('V3 entitlement lookup failed:', licenseError?.message ?? 'invalid license row');
        return jsonResponse({ status: 'ERROR', message: 'License entitlement lookup failed' }, 500);
    }

    const licenseKey = licenseRow.license_key as string;
    const plan = ['free', 'pro', 'dev'].includes(String(licenseRow.plan).toLowerCase())
        ? String(licenseRow.plan).toLowerCase()
        : 'free';
    const features = Array.isArray(licenseRow.features)
        ? licenseRow.features.filter((item: unknown): item is string => typeof item === 'string')
        : null;
    const customerEmail = typeof licenseRow.customer_email === 'string'
        ? licenseRow.customer_email.trim().toLowerCase()
        : null;

    let resourceKey: string | null = null;
    let rkStatus: RkStatus = 'not_requested';
    if (!appVersion) {
        // Token vẫn hợp lệ nhưng không cấp khoá tài nguyên không gắn phiên bản.
    } else if (!resourceKeyAllowed(plan, features)) {
        rkStatus = 'not_entitled';
    } else {
        const licenseHash = await sha256Hex(licenseKey);
        const { data: rkAllowed, error: rkClaimError } = await supabase.rpc('claim_rk_grant_v2', {
            p_license_hash: licenseHash,
            p_product_id: 'prynx',
            p_app_version: appVersion,
            p_machine_id: challenge.device_key_id,
            p_window_minutes: RK_BURST_WINDOW_MINUTES,
            p_version_limit: RK_BURST_VERSION_LIMIT,
        });
        if (rkClaimError) {
            console.error('V3 rk grant failed closed:', rkClaimError.message);
            resourceKey = await lookupResourceKey(
                supabase, 'prynx', appVersion, plan, features, true,
            );
            rkStatus = resourceKey ? 'legacy_fallback' : 'infra_unavailable';
            await logSecurityEvent(supabase, {
                source: 'server',
                event_type: resourceKey ? 'rk_legacy_fallback' : 'rk_claim_failed_closed',
                product_id: 'prynx',
                license_key: licenseKey,
                machine_id: challenge.device_key_id,
                ip: audit.clientIp,
                user_agent: audit.userAgent,
                customer_email: customerEmail,
                details: { app_version: appVersion, protocol_version: LICENSE_PROTOCOL_V3 },
            }, INVALID_VERIFY_DEDUPE_SECONDS);
        } else if (rkAllowed === true) {
            resourceKey = await lookupResourceKey(
                supabase, 'prynx', appVersion, plan, features,
            );
            rkStatus = resourceKey ? 'granted' : 'no_key_for_version';
            if (!resourceKey) {
                await logSecurityEvent(supabase, {
                    source: 'server',
                    event_type: 'rk_key_row_missing',
                    product_id: 'prynx',
                    license_key: licenseKey,
                    machine_id: challenge.device_key_id,
                    ip: audit.clientIp,
                    user_agent: audit.userAgent,
                    customer_email: customerEmail,
                    details: { app_version: appVersion, protocol_version: LICENSE_PROTOCOL_V3 },
                }, INVALID_VERIFY_DEDUPE_SECONDS);
            }
        } else {
            rkStatus = 'burst_denied';
            await logSecurityEvent(supabase, {
                source: 'server',
                event_type: 'rk_cap_exceeded',
                product_id: 'prynx',
                license_key: licenseKey,
                machine_id: challenge.device_key_id,
                ip: audit.clientIp,
                user_agent: audit.userAgent,
                customer_email: customerEmail,
                details: {
                    app_version: appVersion,
                    protocol_version: LICENSE_PROTOCOL_V3,
                    rule: 'burst_v1',
                    window_minutes: RK_BURST_WINDOW_MINUTES,
                    version_limit: RK_BURST_VERSION_LIMIT,
                },
            }, INVALID_VERIFY_DEDUPE_SECONDS);
        }
    }

    const token = await signLicenseToken(
        licenseKey,
        challenge.device_key_id,
        'prynx',
        plan,
        features,
        resourceKey,
        LICENSE_PROTOCOL_V3,
        undefined,
        { deviceKeyId: challenge.device_key_id, challengeId: challenge.challenge_id },
        offlineLeaseSeconds,
        typeof licenseRow.expires_at === 'string' ? licenseRow.expires_at : null,
    );
    if (!token) {
        return jsonResponse({ status: 'ERROR', message: 'License token signing failed' }, 500);
    }

    const response: Record<string, unknown> = {
        status: 'VALID',
        message: 'License hợp lệ.',
        protocol_version: LICENSE_PROTOCOL_V3,
        minimum_protocol: Math.max(policy.minimumIssueProtocol, LICENSE_PROTOCOL_V3),
        device_key_id: challenge.device_key_id,
        plan,
        features,
        rk_status: rkStatus,
        token,
    };
    if (typeof finalResult.expires_at === 'string') response.expires_at = finalResult.expires_at;
    if (Number.isSafeInteger(finalResult.remaining_days)) {
        response.remaining_days = finalResult.remaining_days;
    }
    if (typeof licenseRow.customer_name === 'string') {
        response.customer_name = licenseRow.customer_name;
    }
    return jsonResponse(response);
}

async function handlePrynXV3Challenge(
    body: Record<string, unknown>,
    supabase: EdgeSupabaseClient,
): Promise<Response> {
    if (!hasExactRequestKeys(
        body,
        ['step', 'protocol_version', 'license_key', 'product_id', 'action', 'device_identity'],
        ['app_version', 'offline_lease_seconds'],
    )) {
        return v3StatusResponse({ status: 'INVALID_INPUT' }, 400);
    }
    if (
        body.step !== 'challenge' ||
        body.protocol_version !== LICENSE_PROTOCOL_V3 ||
        body.product_id !== 'prynx' ||
        !isSafeIdentifier(body.license_key, 50) ||
        body.license_key !== body.license_key.trim() ||
        !/^[A-Z0-9-]{5,50}$/.test(body.license_key)
    ) {
        return v3StatusResponse({ status: 'INVALID_INPUT' }, 400);
    }
    if (
        body.action !== LicenseProtocolV3Action.Enroll &&
        body.action !== LicenseProtocolV3Action.Refresh &&
        body.action !== LicenseProtocolV3Action.ResourceKeyGrant &&
        body.action !== LicenseProtocolV3Action.Release &&
        body.action !== LicenseProtocolV3Action.Recover
    ) {
        return v3StatusResponse({ status: 'INVALID_INPUT' }, 400);
    }
    const appVersion = readV3AppVersion(body.app_version);
    if (appVersion === null) return v3StatusResponse({ status: 'INVALID_INPUT' }, 400);
    const offlineLeaseSeconds = readV3OfflineLeaseSeconds(body.offline_lease_seconds);
    const hasOfflineLease = Object.prototype.hasOwnProperty.call(body, 'offline_lease_seconds');
    if (offlineLeaseSeconds === null) {
        return v3StatusResponse({ status: 'INVALID_INPUT' }, 400);
    }

    let identity: DevicePublicIdentityV3;
    try {
        identity = parseDevicePublicIdentityV3(body.device_identity);
    } catch {
        return v3StatusResponse({ status: 'INVALID_INPUT' }, 400);
    }
    let derivedDeviceKeyId: string;
    let requestHash: string;
    try {
        derivedDeviceKeyId = await deriveDeviceKeyIdV3(identity.public_key_jwk);
        const requestIntent: Record<string, unknown> = {
            action: body.action,
            app_version: appVersion ?? null,
            legacy_machine_id: null,
        };
        if (hasOfflineLease) requestIntent.offline_lease_seconds = offlineLeaseSeconds;
        requestHash = await deriveLicenseRequestHashV3(requestIntent);
    } catch {
        return v3StatusResponse({ status: 'INVALID_INPUT' }, 400);
    }
    if (derivedDeviceKeyId !== identity.device_key_id) {
        return v3StatusResponse({ status: 'KEY_MISMATCH' }, 400);
    }

    const { data, error } = await supabase.rpc('issue_prynx_device_challenge_v3', {
        p_license_key: body.license_key,
        p_device_key_id: derivedDeviceKeyId,
        p_device_public_jwk: identity.public_key_jwk,
        p_action: body.action,
        p_request_hash: requestHash,
        p_legacy_machine_id: null,
    });
    if (error) {
        console.error('Could not issue PrynX v3 challenge:', error.message);
        return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
    }
    if (!isRecord(data) || data.status !== 'CHALLENGE') return v3StatusResponse(data);

    const projectedChallenge = {
        protocol_version: data.protocol_version,
        environment: data.environment,
        action: data.action,
        license_id: data.license_id,
        product_id: data.product_id,
        device_key_id: data.device_key_id,
        challenge_id: data.challenge_id,
        challenge: data.challenge,
        expires_at: data.expires_at,
        request_hash: data.request_hash,
    };
    let challenge: ServerLicenseChallengeV3;
    try {
        challenge = parseServerLicenseChallengeV3(projectedChallenge);
    } catch {
        console.error('Challenge RPC returned malformed v3 payload');
        return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
    }
    if (
        challenge.device_key_id !== derivedDeviceKeyId ||
        challenge.action !== body.action ||
        challenge.request_hash !== requestHash ||
        data.minimum_protocol !== LICENSE_PROTOCOL_V3
    ) {
        console.error('Challenge RPC returned inconsistent v3 payload');
        return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
    }
    return jsonResponse({
        status: 'CHALLENGE',
        ...challenge,
        minimum_protocol: LICENSE_PROTOCOL_V3,
    });
}

async function handlePrynXV3Prove(
    body: Record<string, unknown>,
    supabase: EdgeSupabaseClient,
    policy: PrynXProtocolPolicy,
    audit: RequestAuditContext,
): Promise<Response> {
    if (!hasExactRequestKeys(
        body,
        ['step', 'protocol_version', 'challenge_id', 'challenge', 'proof'],
        ['app_version', 'offline_lease_seconds'],
    )) {
        return v3StatusResponse({ status: 'INVALID_INPUT' }, 400);
    }
    if (
        body.step !== 'prove' ||
        body.protocol_version !== LICENSE_PROTOCOL_V3 ||
        !isCanonicalUuid(body.challenge_id) ||
        !isLowerHex(body.challenge, 64)
    ) {
        return v3StatusResponse({ status: 'INVALID_INPUT' }, 400);
    }
    const appVersion = readV3AppVersion(body.app_version);
    if (appVersion === null) return v3StatusResponse({ status: 'INVALID_INPUT' }, 400);
    const offlineLeaseSeconds = readV3OfflineLeaseSeconds(body.offline_lease_seconds);
    const hasOfflineLease = Object.prototype.hasOwnProperty.call(body, 'offline_lease_seconds');
    if (offlineLeaseSeconds === null) {
        return v3StatusResponse({ status: 'INVALID_INPUT' }, 400);
    }

    const { data: challengeRow, error: challengeError } = await supabase
        .from('prynx_device_challenges_v3')
        .select(
            'id,license_id,protocol_version,environment,product_id,action,device_key_id,' +
            'device_public_jwk,nonce_sha256,request_hash,' +
            'attempts,expires_at,consumed_at',
        )
        .eq('id', body.challenge_id)
        .maybeSingle();
    if (challengeError) {
        console.error('Could not load PrynX v3 challenge:', challengeError.message);
        return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
    }
    if (!challengeRow) return v3StatusResponse({ status: 'INVALID_CHALLENGE' }, 400);
    if (challengeRow.consumed_at !== null) return v3StatusResponse({ status: 'CHALLENGE_USED' });
    if (!Number.isInteger(challengeRow.attempts) || challengeRow.attempts >= 3) {
        return v3StatusResponse({ status: 'CHALLENGE_LOCKED' });
    }
    const expiresAtMilliseconds = Date.parse(String(challengeRow.expires_at));
    if (!Number.isFinite(expiresAtMilliseconds)) {
        return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
    }
    if (expiresAtMilliseconds <= Date.now()) {
        return v3StatusResponse({ status: 'CHALLENGE_EXPIRED' });
    }
    if (!isLowerHex(challengeRow.nonce_sha256, 64)) {
        return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
    }
    const nonceHash = await sha256Hex(body.challenge);
    if (!equalAscii(nonceHash, challengeRow.nonce_sha256)) {
        await recordV3Failure(supabase, body.challenge_id, 'INVALID_CHALLENGE');
        return v3StatusResponse({ status: 'INVALID_CHALLENGE' }, 400);
    }

    let expectedRequestHash: string;
    try {
        const requestIntent: Record<string, unknown> = {
            action: challengeRow.action,
            app_version: appVersion ?? null,
            legacy_machine_id: null,
        };
        if (hasOfflineLease) requestIntent.offline_lease_seconds = offlineLeaseSeconds;
        expectedRequestHash = await deriveLicenseRequestHashV3(requestIntent);
    } catch {
        return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
    }
    if (
        !isLowerHex(challengeRow.request_hash, 64) ||
        !equalAscii(expectedRequestHash, challengeRow.request_hash)
    ) {
        await recordV3Failure(supabase, body.challenge_id, 'INVALID_CHALLENGE');
        return v3StatusResponse({ status: 'INVALID_CHALLENGE' }, 400);
    }

    const challengeValue = {
        protocol_version: challengeRow.protocol_version,
        environment: challengeRow.environment,
        action: challengeRow.action,
        license_id: challengeRow.license_id,
        product_id: challengeRow.product_id,
        device_key_id: challengeRow.device_key_id,
        challenge_id: challengeRow.id,
        challenge: body.challenge,
        expires_at: Math.floor(expiresAtMilliseconds / 1000),
        request_hash: challengeRow.request_hash,
    };
    let challenge: ServerLicenseChallengeV3;
    let identity: DevicePublicIdentityV3;
    try {
        challenge = parseServerLicenseChallengeV3(challengeValue);
        identity = parseDevicePublicIdentityV3({
            protocol_version: LICENSE_PROTOCOL_V3,
            device_key_id: challengeRow.device_key_id,
            proof_alg: 'PS256',
            public_key_jwk: challengeRow.device_public_jwk,
        });
    } catch {
        return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
    }

    const proofVerdict = await verifyDeviceLicenseProofV3(
        identity,
        challenge,
        body.proof,
    );
    if (!proofVerdict.ok) {
        const failureCode = proofVerdict.error === 'KEY_MISMATCH'
            ? 'KEY_MISMATCH'
            : 'INVALID_PROOF';
        await recordV3Failure(supabase, body.challenge_id, failureCode);
        return v3StatusResponse({ status: failureCode }, 400);
    }

    // SEC (audit 2026-09-04 §SEC.16-A1): server chỉ tin proof PS256 trên
    // challenge một lần. Không nhận cờ phần cứng do client tự khai.
    const { data: finalData, error: finalError } = await supabase.rpc(
        'finalize_prynx_device_challenge_v3',
        {
            p_challenge_id: challenge.challenge_id,
            p_challenge: challenge.challenge,
            p_proof_sha256: proofVerdict.proofSha256,
        },
    );
    if (finalError) {
        console.error('Could not finalize PrynX v3 challenge:', finalError.message);
        return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
    }
    if (isRecord(finalData) && finalData.status === 'RELEASED') {
        return jsonResponse({
            status: 'RELEASED',
            protocol_version: LICENSE_PROTOCOL_V3,
            minimum_protocol: LICENSE_PROTOCOL_V3,
            device_key_id: challenge.device_key_id,
        });
    }
    if (!isRecord(finalData) || finalData.status !== 'VALID') return v3StatusResponse(finalData);
    return issuePrynXV3Success(
        supabase,
        finalData,
        challenge,
        appVersion,
        policy,
        audit,
        offlineLeaseSeconds,
    );
}

async function handlePrynXV3Request(
    body: Record<string, unknown>,
    supabase: EdgeSupabaseClient,
    audit: RequestAuditContext,
): Promise<Response> {
    const policy = await readPrynXProtocolPolicy(supabase);
    if (!policy) {
        return jsonResponse({ status: 'ERROR', message: 'License protocol policy unavailable' }, 500);
    }
    if (body.step === 'challenge') return handlePrynXV3Challenge(body, supabase);
    if (body.step === 'prove') return handlePrynXV3Prove(body, supabase, policy, audit);
    return v3StatusResponse({ status: 'INVALID_INPUT' }, 400);
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }
    if (req.method !== 'POST') {
        return jsonResponse({ status: 'ERROR', message: 'Method not allowed' }, 405);
    }

    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        const rawBody = await req.json().catch(() => null) as unknown;
        if (!isRecord(rawBody)) {
            return jsonResponse({ status: 'ERROR', message: 'Invalid JSON body' }, 400);
        }
        const clientIp = req.headers.get('cf-connecting-ip')?.trim().slice(0, 128)
            || req.headers.get('x-real-ip')?.trim().slice(0, 128)
            || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim().slice(0, 128)
            || null;
        const userAgent = req.headers.get('user-agent')?.slice(0, 512) || null;

        // SEC (audit 2026-09-04 §SEC.16-A1): v3 không đi qua validation HWID/RPC
        // legacy. Chỉ presence của `step` hoặc protocol 3 đã khóa request vào parser
        // exact-key v3; payload lỗi không được rơi xuống v1/v2 như một downgrade.
        if (rawBody.protocol_version === LICENSE_PROTOCOL_V3 || rawBody.step !== undefined) {
            return handlePrynXV3Request(rawBody, supabase, { clientIp, userAgent });
        }
        const body = rawBody as unknown as VerifyRequest;

        const {
            license_key,
            machine_id,
            product_id,
            app_version,
            client_signal,
            protocol_version,
            challenge,
        } = body;
        if (
            !isSafeIdentifier(license_key, 50)
            || !isSafeIdentifier(machine_id, 255)
            || !isSafeIdentifier(product_id, 50)
        ) {
            return jsonResponse({ status: 'ERROR', message: 'Invalid request fields' }, 400);
        }
        const normalizedProductId = product_id.trim().toLowerCase();
        const trimmedMachineId = machine_id.trim();
        // SEC (audit 2026-09-04 §SEC.16-A0.2): canonical HWID 16-hex là hợp
        // đồng RIÊNG của PrynX. Các sản phẩm legacy đã có activation theo casing
        // cũ; uppercase chúng ở Edge có thể tạo một device/seat thứ hai và làm
        // verify/release bất đối xứng. Migration toàn dữ liệu là một rollout khác.
        const normalizedMachineId = normalizedProductId === 'prynx'
            ? trimmedMachineId.toUpperCase()
            : trimmedMachineId;
        // Reset của Multi-Tem có contract lịch sử case-insensitive riêng. Giữ
        // lookup đó như trước nhưng không viết lại identity activation/token.
        const machineBlockLookupId = normalizedProductId === 'multi_tem_placer'
            ? trimmedMachineId.toUpperCase()
            : normalizedMachineId;
        // SEC (audit 2026-09-02 §SEC.16): PrynX native phát đúng 16 hex. Chuẩn hoá
        // một lần rồi dùng cùng giá trị cho block/count/token/log; không để casing hoặc
        // whitespace tạo hai danh tính logic. Đây là hardening tức thời, chưa thay thế
        // device-key proof của protocol kế tiếp.
        if (normalizedProductId === 'prynx' && !/^[0-9A-F]{16}$/.test(normalizedMachineId)) {
            return jsonResponse({ status: 'INVALID_DEVICE_ID', message: 'Mã máy không hợp lệ.' }, 400);
        }

        // Không cho client tự chọn semantics mơ hồ: thiếu protocol là legacy v1;
        // v2 bắt buộc challenge 32 byte hex và challenge không được gửi kèm v1.
        const protocolVersion = protocol_version === undefined ? 1 : protocol_version;
        if (protocolVersion !== 1 && protocolVersion !== LICENSE_PROTOCOL_V2) {
            return jsonResponse({ status: 'INVALID_PROTOCOL', message: 'Protocol xác minh không được hỗ trợ.' }, 400);
        }
        // Global floor nằm trong DB và chỉ tăng. V1 chỉ là cửa sổ con của giai đoạn
        // drain v2; env không được mở lại v1 sau cutoff DB hoặc sau khi floor lên 3.
        // Lỗi đọc/parse policy phải fail-closed trước RPC có thể tính activation.
        if (normalizedProductId === 'prynx') {
            const prynxProtocolPolicy = await readPrynXProtocolPolicy(supabase);
            if (!prynxProtocolPolicy) {
                return jsonResponse({ status: 'ERROR', message: 'License protocol policy unavailable' }, 500);
            }
            const nowSeconds = Math.floor(Date.now() / 1000);
            const requiredProtocol = requiredPrynXLegacyIssueProtocolV3({
                protocolVersion,
                minimumIssueProtocol: prynxProtocolPolicy.minimumIssueProtocol,
                legacyIssueUntilSeconds: prynxProtocolPolicy.legacyIssueUntilSeconds,
                nowSeconds,
                v1RolloutOpen: isPrynXV1RolloutOpen(nowSeconds),
            });
            if (requiredProtocol !== null) {
                return jsonResponse({
                    status: 'INVALID_PROTOCOL',
                    message: requiredProtocol === LICENSE_PROTOCOL_V2
                        ? 'PrynX yêu cầu giao thức xác minh v2.'
                        : 'PrynX yêu cầu giao thức xác minh v3.',
                    minimum_protocol: requiredProtocol,
                });
            }
        }
        if (protocolVersion === LICENSE_PROTOCOL_V2) {
            if (typeof challenge !== 'string' || !LICENSE_CHALLENGE_RE.test(challenge)) {
                return jsonResponse({ status: 'INVALID_CHALLENGE', message: 'Challenge xác minh không hợp lệ.' }, 400);
            }
        } else if (challenge !== undefined) {
            return jsonResponse({ status: 'INVALID_PROTOCOL', message: 'Challenge chỉ được dùng với protocol v2.' }, 400);
        }
        const normalizedChallenge = protocolVersion === LICENSE_PROTOCOL_V2
            ? (challenge as string).toLowerCase()
            : undefined;

        const signalType = client_signal?.event_type;
        const validSignalType = typeof signalType === 'string' && ALLOWED_SIGNALS.has(signalType);
        const signalDetails = validSignalType ? sanitizeDetails(client_signal?.details) : null;
        // SEC (audit 2026-08-22 §SEC.LIC.3): Reset quản trị tạo tombstone.
        // Kiểm tra trước RPC/token để máy bị reset không thể tự re-activate.
        if (normalizedProductId === 'prynx' || normalizedProductId === 'multi_tem_placer') {
            const { data: blockedLicense, error: blockedLicenseError } = await supabase
                .from('licenses')
                .select('id')
                .eq('license_key', license_key)
                .eq('product_id', normalizedProductId)
                .maybeSingle();
            if (blockedLicenseError) {
                console.error('Reset-block lookup failed:', blockedLicenseError.message);
                return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
            }
            if (blockedLicense?.id) {
                const { data: machineBlock, error: machineBlockError } = await supabase
                    .from('license_machine_blocks')
                    .select('id,reason')
                    .eq('license_id', blockedLicense.id)
                    .eq('machine_id', machineBlockLookupId)
                    .maybeSingle();
                if (machineBlockError) {
                    console.error('Machine reset-block lookup failed:', machineBlockError.message);
                    return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
                }
                if (machineBlock) {
                    await logSecurityEvent(supabase, {
                        source: 'server',
                        event_type: 'machine_revoked',
                        product_id: normalizedProductId,
                        license_key,
                        machine_id: normalizedMachineId,
                        ip: clientIp,
                        user_agent: userAgent,
                        details: { reason: machineBlock.reason || 'ADMIN_RESET' },
                    }, INVALID_VERIFY_DEDUPE_SECONDS);
                    return jsonResponse({
                        status: 'MACHINE_REVOKED',
                        message: 'Máy này đã bị reset khỏi license. Liên hệ quản trị viên để cấp lại quyền.',
                    });
                }
            }
        }


        // SEC (audit 2026-08 §SEC.1): chỉ gắn email sau khi key + sản phẩm
        // khớp license thật; key sai hoặc dò nhầm sản phẩm không được suy đoán chủ thể.
        let customerEmail: string | null = null;
        const { data: ownerRow, error: ownerLookupError } = await supabase
            .from('licenses')
            .select('id,customer_email')
            .eq('license_key', license_key)
            .eq('product_id', normalizedProductId)
            .maybeSingle();
        if (ownerLookupError) {
            console.error('License owner lookup failed; security log will omit email:', ownerLookupError.message);
            if (normalizedProductId === 'prynx') {
                return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
            }
        } else if (typeof ownerRow?.customer_email === 'string' && ownerRow.customer_email.trim()) {
            customerEmail = ownerRow.customer_email.trim().toLowerCase();
        }
        // Device đã nâng lên v3 không được quay lại đường HWID v2 trong lúc global
        // floor vẫn là 2 để drain client cũ. Guard chạy trước verify_license_edge,
        // nên request downgrade không thể re-activate hoặc tiêu thêm seat.
        if (
            normalizedProductId === 'prynx' &&
            protocolVersion === LICENSE_PROTOCOL_V2 &&
            ownerRow?.id
        ) {
            const { data: activationFloor, error: activationFloorError } = await supabase
                .from('license_activations')
                .select('protocol_floor')
                .eq('license_id', ownerRow.id)
                .ilike('machine_id', normalizedMachineId)
                .maybeSingle();
            if (activationFloorError) {
                console.error('Device protocol floor lookup failed:', activationFloorError.message);
                return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
            }
            if (Number(activationFloor?.protocol_floor ?? 1) >= LICENSE_PROTOCOL_V3) {
                return jsonResponse({
                    status: 'INVALID_PROTOCOL',
                    message: 'Thiết bị này yêu cầu giao thức xác minh v3.',
                    minimum_protocol: LICENSE_PROTOCOL_V3,
                });
            }
        }
        // Only the service-role Edge Function can call verify_license_edge and supply
        // clientIp. Public/legacy callers cannot choose this trusted rate-limit bucket.

        const { data, error } = await supabase.rpc('verify_license_edge', {
            p_license_key: license_key,
            p_machine_id: normalizedMachineId,
            p_product_id: normalizedProductId,
            p_client_ip: clientIp || 'unknown',
        });

        if (error) {
            console.error('RPC verify_license error:', error);
            return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
        }

        const result = data as Record<string, any>;

        // SEC (audit 2026-08-22 §SEC.LIC.3): kiểm tra lại sau RPC để đóng race
        // admin reset xảy ra trong lúc verify_license_edge đang chạy.
        if ((normalizedProductId === 'prynx' || normalizedProductId === 'multi_tem_placer')
            && result.status === 'VALID') {
            if (!ownerRow?.id) {
                return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
            }
            const { data: postBlock, error: postBlockError } = await supabase
                .from('license_machine_blocks')
                .select('id,reason')
                .eq('license_id', ownerRow.id)
                .eq('machine_id', machineBlockLookupId)
                .maybeSingle();
            if (postBlockError) {
                console.error('Post-verify reset-block lookup failed:', postBlockError.message);
                return jsonResponse({ status: 'ERROR', message: 'License verification failed' }, 500);
            }
            if (postBlock) {
                return jsonResponse({
                    status: 'MACHINE_REVOKED',
                    message: 'Máy này đã bị reset khỏi license. Liên hệ quản trị viên để cấp lại quyền.',
                });
            }
        }

        const response: Record<string, any> = {
            status: result.status || 'ERROR',
            message: result.message || 'Unknown status',
        };
        if (result.expires_at) response.expires_at = result.expires_at;
        if (result.remaining_days !== undefined) response.remaining_days = result.remaining_days;
        if (result.customer_name) response.customer_name = result.customer_name;
        if (result.current_activations !== undefined) response.current_activations = result.current_activations;
        if (result.max_activations !== undefined) response.max_activations = result.max_activations;

        // CHỈ khi hợp lệ mới phát token ký số (ngắn hạn) cho sidecar.
        if (result.status === 'VALID') {
            // Fail closed: missing/unknown entitlement must never unlock Pro.
            let plan = 'free';
            let features: string[] | null = null;
            const { data: licenseRow, error: entitlementError } = await supabase
                .from('licenses')
                .select('plan, features')
                .eq('license_key', license_key)
                .eq('product_id', normalizedProductId)
                .maybeSingle();
            if (entitlementError) {
                console.error('Entitlement lookup failed; refusing signed token:', entitlementError);
                return jsonResponse({ status: 'ERROR', message: 'License entitlement lookup failed' }, 500);
            }
            if (licenseRow) {
                plan = ['free', 'pro', 'dev'].includes(String(licenseRow.plan).toLowerCase())
                    ? String(licenseRow.plan).toLowerCase()
                    : 'free';
                features = Array.isArray(licenseRow.features)
                    ? licenseRow.features.filter((item: unknown): item is string => typeof item === 'string')
                    : null;
            }

            response.plan = plan;
            response.features = features;
            // Chỉ nhận SemVer-ish: `isSafeIdentifier` cố ý rất rộng (chuỗi không rỗng),
            // còn đây là giá trị dùng để tra bảng nên siết về đúng tập ký tự cần.
            const safeVersion = typeof app_version === 'string'
                && /^[0-9A-Za-z][0-9A-Za-z.\-+]{0,63}$/.test(app_version)
                ? app_version
                : undefined;
            // SEC (audit 2026-07-30 §SEC.2): trước khi cấp khóa dieline, đi qua cổng
            // chống thu gom. Nếu cổng lỗi, CHỈ bản legacy đã đánh dấu trong DB mới được
            // fallback; bản phát hành mới fail-closed riêng `rk` nhưng token license vẫn cấp.
            let resourceKey: string | null = null;
            // [DIELINE-RK-GATE 2026-08-26] Lý do dạng enum cho phản hồi (Design §D). Đặt ở MỌI
            // nhánh của khối dưới để không tồn tại đường đi nào trả về `status: VALID` trơn mà
            // client/ops không biết khoá engine có được cấp hay không (1.4).
            let rkStatus: RkStatus = 'not_requested';
            if (!safeVersion) {
                // Client cũ không gửi `app_version` (hoặc gửi chuỗi sai regex): giữ nguyên mặc
                // định `not_requested` và bỏ qua TOÀN BỘ khối `rk` như trước — không gọi cổng,
                // không tra bảng, không ghi log — token license vẫn cấp. Bản cũ nhúng engine
                // plaintext sống nhờ đúng nhánh này (3.6).
            } else if (!resourceKeyAllowed(plan, features)) {
                // Free / thiếu `packaging.dieline`: cổng entitlement từ chối TRƯỚC cổng tốc độ,
                // nên không tiêu suất cấp khoá và không sinh log — đúng hành vi cũ (3.3). Chỉ
                // thêm nhãn lý do để client không phải suy từ việc token thiếu `rk`.
                rkStatus = 'not_entitled';
            } else {
                const licenseHash = await sha256Hex(license_key);
                const { data: rkAllowed, error: rkClaimErr } = await supabase.rpc('claim_rk_grant_v2', {
                    p_license_hash: licenseHash,
                    p_product_id: normalizedProductId,
                    p_app_version: safeVersion,
                    // Chỉ để ops thấy độ lan của một license trong sổ cấp; KHÔNG tham gia điều
                    // kiện chặn. Dùng dạng chuẩn hoá (như khi tra `license_machine_blocks`) để
                    // một máy không bị đếm hai lần vì khác kiểu chữ.
                    p_machine_id: normalizedMachineId,
                    p_window_minutes: RK_BURST_WINDOW_MINUTES,
                    p_version_limit: RK_BURST_VERSION_LIMIT,
                });
                if (rkClaimErr) {
                    console.error('claim_rk_grant_v2 failed; checking legacy fallback:', rkClaimErr.message);
                    resourceKey = await lookupResourceKey(
                        supabase, normalizedProductId, safeVersion, plan, features, true,
                    );
                    // Fail-closed riêng `rk` GIỮ NGUYÊN: cổng không kết luận được thì chỉ hàng đã
                    // đánh dấu legacy được nhận. Không có nhánh fail-open nào (3.9, Property 3).
                    rkStatus = resourceKey ? 'legacy_fallback' : 'infra_unavailable';
                    await logSecurityEvent(supabase, {
                        source: 'server',
                        event_type: resourceKey ? 'rk_legacy_fallback' : 'rk_claim_failed_closed',
                        product_id: normalizedProductId, license_key, machine_id: normalizedMachineId,
                        ip: clientIp, user_agent: userAgent, customer_email: customerEmail,
                        details: { app_version: safeVersion },
                    }, INVALID_VERIFY_DEDUPE_SECONDS);
                } else if (rkAllowed === true) {
                    resourceKey = await lookupResourceKey(
                        supabase, normalizedProductId, safeVersion, plan, features,
                    );
                    rkStatus = resourceKey ? 'granted' : 'no_key_for_version';
                    if (!resourceKey) {
                        // [DIELINE-RK-GATE 2026-08-26] BỊT ĐIỂM MÙ. Trước bản vá này, nhánh "cổng
                        // cho phép nhưng tra bảng trả null" không ghi log gì cả: `rk` mất im lặng
                        // và `security_logs` rỗng, nên không phân biệt được với ca cột
                        // `legacy_fallback` thiếu (mọi select lỗi). Đo trên bảng quyết định: 28 ô
                        // mất `rk` mà không để lại dấu vết nào.
                        //
                        // `lookupResourceKey` trả null cho CẢ HAI nguyên nhân — không có hàng cho
                        // đúng `app_version` (hoặc đã `revoked_at`), và lỗi truy vấn. Event này
                        // vì thế cũng là dấu vết đầu tiên cho ca lỗi truy vấn; chi tiết lỗi đã có
                        // ở `console.error` trong `lookupResourceKey`.
                        await logSecurityEvent(supabase, {
                            source: 'server', event_type: 'rk_key_row_missing',
                            product_id: normalizedProductId, license_key, machine_id: normalizedMachineId,
                            ip: clientIp, user_agent: userAgent, customer_email: customerEmail,
                            details: { app_version: safeVersion },
                        }, INVALID_VERIFY_DEDUPE_SECONDS);
                    }
                } else {
                    // Vuot nguong toc do -> nghi harvest -> khong cap rk, ghi log server-side.
                    // Giữ NGUYÊN tên event `rk_cap_exceeded` để lịch sử `security_logs` liền mạch;
                    // danh tính luật mới nằm trong `details.rule`. Cửa sổ/ngưỡng CHỈ đi vào log,
                    // không bao giờ vào phản hồi.
                    rkStatus = 'burst_denied';
                    await logSecurityEvent(supabase, {
                        source: 'server', event_type: 'rk_cap_exceeded',
                        product_id: normalizedProductId, license_key, machine_id: normalizedMachineId,
                        ip: clientIp, user_agent: userAgent, customer_email: customerEmail,
                        details: {
                            app_version: safeVersion,
                            rule: 'burst_v1',
                            window_minutes: RK_BURST_WINDOW_MINUTES,
                            version_limit: RK_BURST_VERSION_LIMIT,
                        },
                    }, INVALID_VERIFY_DEDUPE_SECONDS);
                }
            }
            // [DIELINE-RK-GATE 2026-08-26] Chỉ NHÃN lý do — không khoá, không license key thô,
            // không hash license, không bộ đếm/ngưỡng. `app_version` không echo lại ở đây vì
            // client tự gửi nên không thêm được gì.
            response.rk_status = rkStatus;
            const token = await signLicenseToken(
                license_key, normalizedMachineId, normalizedProductId, plan, features, resourceKey,
                protocolVersion,
                normalizedChallenge,
            );
            if (token) response.token = token;

            // Chỉ chấp nhận telemetry sau khi server xác nhận key + machine hợp lệ.
            if (validSignalType && signalType) {
                const signalResult = await logSecurityEvent(supabase, {
                    source: 'client',
                    event_type: signalType,
                    product_id: normalizedProductId,
                    license_key,
                    machine_id: normalizedMachineId,
                    ip: clientIp,
                    user_agent: userAgent,
                    customer_email: customerEmail,
                    details: signalDetails,
                }, CLIENT_SIGNAL_DEDUPE_SECONDS);
                response.security_signal_processed = signalResult.processed;
                response.security_signal_stored = signalResult.stored;
                response.security_signal_deduplicated = signalResult.deduplicated;
            }
        } else {
            // Verify KHÔNG hợp lệ → ghi log server-side (không bypass được): key bị thu hồi,
            // hết hạn, vượt số máy, hoặc thử key sai. Đây là report đáng tin về dấu hiệu crack.
            await logSecurityEvent(supabase, {
                source: 'server', event_type: `verify_${String(result.status || 'ERROR').toLowerCase()}`,
                product_id: normalizedProductId, license_key, machine_id: normalizedMachineId, ip: clientIp, user_agent: userAgent,
                customer_email: customerEmail,
                details: {
                    message: result.message ?? null,
                    current_activations: result.current_activations ?? null,
                    max_activations: result.max_activations ?? null,
                },
            }, INVALID_VERIFY_DEDUPE_SECONDS);
        }

        return jsonResponse(response);
    } catch (error) {
        console.error('License verify error:', error);
        return jsonResponse({ status: 'ERROR', message: 'Internal server error' }, 500);
    }
});

function jsonResponse(data: Record<string, any>, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}
