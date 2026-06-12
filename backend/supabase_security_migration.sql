-- ═══════════════════════════════════════════════════════════
-- PrynX Security Migration v3 — dùng schema có sẵn
-- license_activations: license_id, machine_id, is_active
-- licenses: id (uuid), license_key, max_activations
-- ═══════════════════════════════════════════════════════════

-- Step 1: Rate limit log (bảng mới)
CREATE TABLE IF NOT EXISTS license_verification_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ip_address TEXT,
    license_key CHARACTER VARYING,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE license_verification_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "No public access log" ON license_verification_log;
CREATE POLICY "No public access log" ON license_verification_log FOR ALL USING (false);
REVOKE ALL ON license_verification_log FROM anon;

-- Step 2: RLS
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_activations ENABLE ROW LEVEL SECURITY;

-- Step 3: Drop old function (exact old signature) then create new
DROP FUNCTION IF EXISTS verify_license(text, text, text, text);
DROP FUNCTION IF EXISTS verify_license(character varying, character varying, character varying);

CREATE OR REPLACE FUNCTION verify_license(
    p_license_key text,
    p_machine_id text,
    p_product_id text DEFAULT 'prynx'
) RETURNS jsonb AS $$
DECLARE
    license_record RECORD;
    hwid_count INT;
    allowed_devices INT;
    req_ip TEXT;
    rate_count INT;
BEGIN
    -- Rate limit: max 10 per minute per IP
    req_ip := coalesce(
        current_setting('request.header.x-forwarded-for', true),
        current_setting('request.header.x-real-ip', true),
        'unknown'
    );

    SELECT COUNT(*) INTO rate_count
    FROM license_verification_log
    WHERE ip_address = req_ip
      AND created_at > NOW() - INTERVAL '1 minute';

    IF rate_count > 10 THEN
        RETURN jsonb_build_object('status', 'RATE_LIMITED', 'message', 'Too many requests');
    END IF;

    INSERT INTO license_verification_log (ip_address, license_key)
    VALUES (req_ip, p_license_key);

    DELETE FROM license_verification_log WHERE created_at < NOW() - INTERVAL '24 hours';

    -- Find license
    SELECT * INTO license_record
    FROM licenses
    WHERE license_key = p_license_key
      AND product_id = p_product_id
      AND is_active = true;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'License not found or inactive');
    END IF;

    -- Check expiry
    IF license_record.expires_at IS NOT NULL AND license_record.expires_at < NOW() THEN
        RETURN jsonb_build_object('status', 'EXPIRED', 'message', 'License has expired');
    END IF;

    -- Device limit (dùng license_activations.license_id + licenses.id)
    allowed_devices := COALESCE(license_record.max_activations, 2);

    SELECT COUNT(DISTINCT la.machine_id) INTO hwid_count
    FROM license_activations la
    WHERE la.license_id = license_record.id
      AND la.is_active = true;

    IF hwid_count >= allowed_devices THEN
        IF NOT EXISTS (
            SELECT 1 FROM license_activations
            WHERE license_id = license_record.id 
              AND machine_id = p_machine_id
              AND is_active = true
        ) THEN
            RETURN jsonb_build_object(
                'status', 'DEVICE_LIMIT',
                'message', format('Đã dùng trên %s thiết bị (tối đa %s)', hwid_count, allowed_devices),
                'max_devices', allowed_devices
            );
        END IF;
    END IF;

    -- Register/update activation (dùng license_id, không phải license_key)
    INSERT INTO license_activations (license_id, machine_id, activated_at, is_active)
    VALUES (license_record.id, p_machine_id, NOW(), true)
    ON CONFLICT (license_id, machine_id)
    DO UPDATE SET activated_at = NOW(), is_active = true;

    RETURN jsonb_build_object('status', 'VALID', 'message', 'License verified');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION verify_license(text, text, text) TO anon;
