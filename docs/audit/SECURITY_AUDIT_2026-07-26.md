# PrynX security audit — 2026-07-26

## Scope

- Desktop renderer and Tauri command boundary
- Python sidecar HTTP/WebSocket authentication
- License token issuance and verification
- Generated result-file access
- Filesystem and asset-protocol capabilities
- Native Rust/PyO3 dependencies
- Release-script fail-closed behavior
- Supabase Edge Function, RPC privileges, rate limiting, activation concurrency,
  entitlement derivation, and release resource keys
- npm, pip, and Rust dependency advisories

No release build was run during this audit.

## Remediations completed

### Request and license authentication

- The request HMAC now binds timestamp, one-time nonce, normalized HTTP method,
  raw path, license key, hardware ID, and verified-token hash.
- WebSockets enforce the same proof, signed license token, product audience, and
  clock guard before accepting a connection.
- The `prynx` product audience is mandatory in Python, Tauri, and the native
  dieline engine.
- Renderer license verification now uses the Edge Function. Direct access to the
  public `verify_license` RPC was removed from login and license-change flows.
- Native startup no longer reloads a plaintext/base64 license key from
  `localStorage`; legacy data is migrated to DPAPI and deleted, or native storage
  fails closed.
- Backend fetch interception compares parsed origins instead of URL prefixes,
  preserves the effective `Request` overrides, signs the method actually sent,
  and prevents caller headers from replacing native authentication headers.

### Sidecar and local resources

- Release startup fails closed when the sidecar port is occupied, token
  provisioning fails, or the challenge-response health proof is invalid.
- Generated `/results` artifacts require a path-scoped HMAC URL.
- Filesystem/asset scopes no longer expose the entire home directory and deny
  common credential/key files.
- Atomic copy validates both source and destination extensions and allowed paths.

### Release and protected engine

- Release mode rejects `SkipNuitka`, skipped preflight QA, missing protected
  resource secrets, and plaintext dieline output.
- Release resource keys are immutable per product/version/resource; a rebuild
  reuses the existing key instead of silently rotating it.
- Native image decoding is limited to PNG and JPEG rather than enabling every
  default `image` codec.
- PyO3/numpy were migrated to 0.29 and the affected native bindings were updated.

### Supabase

- PrynX verification is service-role Edge-only. The public legacy RPC rejects
  PrynX, preventing a stolen key from consuming activation slots.
- Rate-limit buckets store hashes rather than raw IP/license values and use
  transaction advisory locks to close concurrent bypasses.
- Device activation counting is serialized per license and recounted after
  activation.
- Release resource keys are RLS-protected, validated as 32-byte base64 values,
  and protected by an immutability trigger.
- Order product, plan, and feature entitlements are derived from the purchased
  package rather than renderer-provided values.

## Verification evidence

- Python backend: 1,289 passed, 7 skipped.
- Tauri Rust: 39 passed.
- Native Rust: 9 passed.
- `imposition_core`: 36 passed.
- `print_engine`: 508 passed across unit/integration suites.
- Desktop targeted API/auth tests: 5 passed; TypeScript check passed.
- Website: TypeScript check passed; 256 tests passed, 1 skipped.
- Desktop npm production audit: 0 known vulnerabilities.
- Backend `pip-audit`: 0 known vulnerabilities.
- All four Cargo lockfiles: no active vulnerability error.
- JSON, CI YAML, PowerShell AST, and scoped diff checks passed.

## Known residuals

1. `react-router-dom` 7.18.1 is reported for an RSC-only advisory. PrynX is a
   client-side SPA and does not use the unstable RSC APIs. Downgrading to 7.11.0
   reintroduces multiple SPA-relevant XSS/open-redirect advisories; npm has not
   published the advisory's patched 8.3.0 version, so 7.18.1 is retained.
2. RustSec reports unmaintained dependencies (`paste`, `ttf-parser`, and
   target-only GTK3/UNIC packages). `glib` 0.18.5 is present only in the Linux
   Tauri dependency graph; the shipped PrynX target is Windows. These warnings
   have no available drop-in patch and are not active Cargo audit failures.
3. The website baseline still has six unrelated failing tests: three stale
   nesting expectations and three `ScrollToTop` tests that render without a
   Router. The security/dependency changes compile, and 256 other tests pass.
4. The desktop full suite previously showed three order/isolation failures in
   upload/merge tests; those files pass when run together with the new API/auth
   regression tests (5/5).

## Layer-2 crypto-lock scope decision (booklet imposition)

Considered extending the dieline Layer-2 crypto-lock (AES-256-GCM engine
payload decrypted at runtime with the license `rk` claim, executed in the
pure-Rust `boa` JS interpreter) to the main Pro features. Outcome: **do not
extend it; rely on Layer-1** (Ed25519 server-signed license token gating every
backend route). Reasons:

1. **Layer-2 only protects interpreted script text.** Compiled machine code is
   already self-protecting. Of the Pro features, only booklet imposition ships
   its core algorithm as readable JS in the WebView bundle
   (`desktop/src/lib/imposerEngine/*.ts`). Everything else is already machine
   code: bình tem bế/CNC and bình cắt xén run in Rust `imposition_core`;
   separations/soft-proof in Rust `print_engine`; preflight, VDP core, cutline,
   and PDF assembly are Python compiled with Nuitka. `processHandlers.ts:63`
   confirms the main N-up/die-cut output layout is computed backend-side and
   `NupGridSolver` now only serves booklet.

2. **The booklet algorithm is not export-only — the interactive preview runs the
   same code in cleartext.** Unlike dieline (a single `__prynxGenerateDieline`
   request/response boundary shared by preview and export), booklet runs its
   core algorithm synchronously in React on every parameter change:
   - Export: `pdfImposer.ts` → `serializeBookletPlan` → JSON → backend
   - "Xem Bài In" (SheetViewerDialog): `generateBindingMap`
   - Product panel (ProductFirstPanel): `ProductAdvisor` → `NupGridSolver`
   - Dashboard: `CatalogPlanner`, `SheetOptimizer`

   Encrypting only the export path would be security theater — the same
   algorithm is readable in the preview modules. Wrapping both preview and
   export in `boa` would be a large refactor that routes every interactive
   parameter change through an IPC + pure-Rust-interpreter round trip, risking
   preview jank, for a low IP payoff.

3. **The booklet core is largely standard print-industry knowledge** (page
   ordering, signature/tay-sách layout, Kodak Preps fold tables), not a trade
   secret comparable to the dieline geometry engine. The actual PDF execution
   is already backend Rust/Nuitka.

Conclusion: Layer-1 remains the licensing boundary for all Pro features; the
dieline Layer-2 lock stays as-is and is not replicated to booklet.

## Deployment status

### Deployed on 2026-07-26 (production project `ryvyuxjgdcvoxujqmggm`)

- **`release_resource_keys` table** — created via Management API `POST /database/query`
  using the SQL from `supabase/migrations/20260726090000_release_resource_keys.sql`.
  6 columns, RLS enabled, no policy (service_role-only, deny-all), unique index on
  `resource_key`. Verified: PostgREST schema cache now resolves the table, the
  service-role `SELECT` the build script runs returns `HTTP 200 []` (correct empty
  pre-build state). No existing table was touched — new isolated table only, so no
  effect on current customers or licenses.

  Note: `supabase db push` was **deliberately not used**. Its `--dry-run` refused due
  to migration-history drift (remote versions not matching local files), and a blanket
  push would have dragged unreviewed pending migrations (`server_side_pricing`,
  `prynx_security_audit_fixes`, etc.) onto production. Only the single isolated table
  the build requires was applied.

- **`license-verify` Edge Function** — deployed v10 → **v11** (ACTIVE). The running
  bundle now contains the dieline resource-key logic (`app_version`, `lookupResourceKey`,
  `release_resource_keys`, signed `rk` claim); v10 had none. Change is additive — no
  security helper was removed (verified by comparing function/const inventories against
  the deployed bundle). Backward compatibility verified by reading the code:
  - Clients that don't send `app_version` → `lookupResourceKey` returns null → no lock,
    activation proceeds unchanged.
  - Resource-key lookup error (incl. missing table) → does not block activation.
  - `rk` undefined → omitted from signed payload → token identical to the old shape.
  - `rk` is placed inside the Ed25519-signed payload, so a client cannot inject/alter it.
  Post-deploy smoke test (bogus license) returned clean JSON error, not a crash — the
  function boots, parses, calls the RPC, and handles errors. The dieline branch only
  runs on `status === 'VALID'`, which a bogus key never reaches.

### Still pending (require user decision / action)

- **Other drifted migrations** (`server_side_pricing`, `prynx_security_audit_fixes`,
  and the Feb-dated history drift) — need a deliberate `migration repair` / `db pull`
  reconciliation, not a blanket push. Not touched.
- **Signing/resource secrets on the build machine** — `PRYNX_SUPABASE_URL` and
  `PRYNX_SUPABASE_SERVICE_KEY` are available from the Supabase Dashboard;
  `TAURI_SIGNING_PRIVATE_KEY` already exists at `~/.tauri/prynx.key` (verified to match
  the embedded updater pubkey, no passphrase).
- **Supabase access token** `sbp_…` generated for this deployment should be **revoked**.
- **Release build** from a clean, reviewed state remains a separate step (not run).
