-- ============================================================
-- PrintSolutions/PrynX — SECURITY HOTFIX (đã verify LIVE 2026-06-20)
-- Chạy trong Supabase Dashboard > SQL Editor (project ryvyuxjgdcvoxujqmggm).
-- Vá 2 lỗ anon key (public) khai thác được ngay:
--   FIX 1: site_settings lộ sepay_api_key / sepay_webhook_secret
--   FIX 2: orders cho anon đọc PII khách (order_code, customer_email)
-- Idempotent + an toàn. KÈM truy vấn kiểm chứng ở cuối.
--
-- ⚠️ SAU KHI CHẠY: phải deploy lại edge function sepay-webhook (đã sửa đọc
--    api key từ payment_secrets) — xem ghi chú cuối file. Và rotate service_role key.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- FIX 1 — Tách secret thanh toán ra bảng riêng (chỉ admin + service_role)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_secrets (
  id                   int PRIMARY KEY DEFAULT 1,
  sepay_api_key        text,
  sepay_webhook_secret text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_secrets_singleton CHECK (id = 1)
);

ALTER TABLE public.payment_secrets ENABLE ROW LEVEL SECURITY;

-- anon KHÔNG có quyền gì. authenticated chỉ thao tác được nếu là admin (RLS).
-- service_role (edge function sepay-webhook) BYPASS RLS nên vẫn đọc được.
REVOKE ALL ON public.payment_secrets FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.payment_secrets TO authenticated;

DROP POLICY IF EXISTS "Admin manage payment_secrets" ON public.payment_secrets;
CREATE POLICY "Admin manage payment_secrets" ON public.payment_secrets
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Chuyển dữ liệu hiện có từ site_settings sang (nếu cột còn tồn tại).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='site_settings'
               AND column_name='sepay_api_key') THEN
    INSERT INTO public.payment_secrets (id, sepay_api_key, sepay_webhook_secret)
    SELECT 1, sepay_api_key, sepay_webhook_secret FROM public.site_settings LIMIT 1
    ON CONFLICT (id) DO UPDATE
      SET sepay_api_key        = EXCLUDED.sepay_api_key,
          sepay_webhook_secret = EXCLUDED.sepay_webhook_secret,
          updated_at           = now();
    RAISE NOTICE 'Đã chuyển sepay secret sang payment_secrets.';
  END IF;
END $$;

-- Xoá cột secret khỏi bảng public (anon select * không còn lộ nữa).
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS sepay_api_key;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS sepay_webhook_secret;

-- ─────────────────────────────────────────────────────────────
-- FIX 2 — orders: gỡ MỌI policy SELECT mở cho anon
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- Gỡ tự động mọi policy SELECT có điều kiện 'true' (mở cho mọi role) — nguyên nhân rò.
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname='public' AND tablename='orders'
      AND cmd='SELECT' AND COALESCE(qual,'') = 'true'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.orders', pol.policyname);
    RAISE NOTICE 'Đã gỡ policy SELECT mở trên orders: %', pol.policyname;
  END LOOP;
END $$;

-- Gỡ thêm theo tên (phòng trường hợp tên cũ còn sót).
DROP POLICY IF EXISTS "Anyone can view orders by code"   ON public.orders;
DROP POLICY IF EXISTS "Anyone can view orders"           ON public.orders;
DROP POLICY IF EXISTS "Public can view orders"           ON public.orders;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.orders;

-- Bảo đảm policy đọc ĐÚNG tồn tại: chủ đơn (theo email JWT) HOẶC admin.
DROP POLICY IF EXISTS "Owner or admin can read orders" ON public.orders;
CREATE POLICY "Owner or admin can read orders" ON public.orders
  FOR SELECT
  USING (
    public.is_admin()
    OR customer_email = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
  );
-- (KHÔNG đụng policy "Anyone can create orders" — checkout vẫn cần.)

-- ─────────────────────────────────────────────────────────────
-- KIỂM CHỨNG — chạy riêng sau khi áp (kỳ vọng kết quả trong ngoặc):
-- ─────────────────────────────────────────────────────────────
-- 1) site_settings KHÔNG còn cột secret  (kỳ vọng: 0 dòng)
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name='site_settings' AND column_name LIKE 'sepay_%secret%' OR column_name='sepay_api_key';
--
-- 2) orders KHÔNG còn policy SELECT qual='true'  (kỳ vọng: 0 dòng)
--    SELECT policyname, cmd, qual FROM pg_policies
--    WHERE tablename='orders' AND cmd='SELECT' AND qual='true';
--
-- 3) RLS đã bật  (kỳ vọng: relrowsecurity = true cho cả hai)
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname IN ('orders','payment_secrets','site_settings');
--
-- Sau đó test bằng anon key (curl) — đều phải KHÔNG trả dữ liệu:
--   GET /rest/v1/orders?select=customer_email&limit=1            -> []
--   GET /rest/v1/payment_secrets?select=sepay_api_key            -> [] / 401
-- ============================================================
