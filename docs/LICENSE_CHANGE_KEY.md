# Đổi license key (PrynX) + release_machine_activation

## Client (`pdfcompare`)
- `useAuthStore.changeLicenseKey` — verify-first, rồi gọi `release_machine_activation` (best-effort) cho key cũ.
- UI: About + LicenseLockOverlay (`ChangeLicenseKeyPanel`).

## Server (`printsolutions-main`)
Migration:
`supabase/migrations/20260717_release_machine_activation.sql`

### Deploy Supabase
```bash
# SQL Editor trên project Supabase PrintSolutions, hoặc:
cd D:\printsolutions-main
# supabase db push   # nếu CLI đã link project
```

Hoặc dán nội dung file migration vào Supabase Dashboard → SQL → Run.

### RPC
```sql
release_machine_activation(p_license_key, p_machine_id, p_product_id default 'prynx')
→ { status: 'OK' | 'NOOP' | 'NOT_FOUND' | 'INVALID_INPUT', deactivated, ... }
```

Client **không** fail đổi key nếu RPC chưa deploy (catch + warn log).
