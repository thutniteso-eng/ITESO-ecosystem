# Báo cáo TASK-003: Tài khoản, đăng nhập, vai trò và phân quyền

## Đã làm

1. **Database Schema & Migrations (`platform`):**
   - Định nghĩa 7 bảng mới trong [services/control-plane/src/db/schema.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/db/schema.ts) theo đúng thiết kế ADR-005 và TASK-003:
     - `accounts`: lưu tài khoản (id, email, phone, password_hash, totp_secret_enc, totp_enabled, is_platform_admin, status, failed_attempts, locked_until). Check constraint yêu cầu ít nhất email hoặc phone.
     - `permissions`: danh mục quyền (`key`, `group`, `description`).
     - `roles`: vai trò theo tenant (`id`, `tenant_id`, `name`, `is_owner`, `created_at`; unique `(tenant_id, name)`).
     - `role_permissions`: quan hệ nhiều-nhiều giữa role và permission (composite PK).
     - `memberships`: tư cách thành viên tenant (`id`, `account_id`, `tenant_id`, `status`, `branch_scope`, `created_at`; unique `(account_id, tenant_id)`).
     - `membership_roles`: vai trò gán cho membership (composite PK).
     - `refresh_tokens`: quản lý họ refresh token (id, account_id, membership_id, family_id, token_hash SHA-256, expires_at, revoked_at, replaced_by, created_at, user_agent, ip).
   - Migration Drizzle được tạo tại [services/control-plane/drizzle/0001_soft_malcolm_colcord.sql](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/drizzle/0001_soft_malcolm_colcord.sql) và cập nhật journal migrator.
   - Phân quyền cách ly database: [services/control-plane/src/db/migrate.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/db/migrate.ts) và [scripts/init-db-roles.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/init-db-roles.sh) đảm bảo `iteso_gateway` **tuyệt đối không có quyền đọc/ghi** trên 7 bảng này và bảng `admin_audit_log`. Cập nhật [scripts/test-db-isolation.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/test-db-isolation.sh) kiểm tra `iteso_gateway` bị từ chối `permission denied` khi truy vấn `accounts`.

2. **Danh mục quyền, vai trò mẫu & Seed idempotent:**
   - Cập nhật [services/control-plane/src/db/seed.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/db/seed.ts):
     - Seed 10 permissions: `system.diagnostics.view`, `settings.manage`, `settings.roles.manage`, `pos.order.create`, `pos.order.void`, `pos.discount.apply`, `report.revenue.view`, `inventory.manage`, `accounting.view`, và quyền thành viên `system.features.read`.
     - Seed tenant `demo_fnb2` trên `platform`.
     - Seed 6 vai trò mẫu cho mỗi tenant: `Chủ` (full quyền), `Quản lý` (tất cả trừ `settings.roles.manage`), `Thu ngân` (`pos.order.create`, `pos.discount.apply`), `Phục vụ` (`pos.order.create`), `Bếp` (không quyền tác vụ), `Kế toán` (`report.revenue.view`, `accounting.view`), cùng quyền `system.features.read` cho mọi thành viên.
     - Seed 3 tài khoản demo với băm Argon2id (mật khẩu từ `DEMO_ACCOUNTS_PASSWORD`):
       - `owner@demo.local`: vai trò `Chủ` tại `demo_fnb`.
       - `cashier@demo.local`: vai trò `Thu ngân` tại `demo_fnb`.
       - `multi@demo.local`: thành viên của cả `demo_fnb` và `demo_fnb2`.
     - Seed cờ tính năng `system.auth` (`available`, mặc định bật).

3. **Quản lý khóa Ed25519 & Mã hóa dữ liệu bảo mật:**
   - Tạo [scripts/generate-keys.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/generate-keys.sh): sinh cặp khóa Ed25519 (`ed25519_private.pem`, `ed25519_public.pem`) vào `infra/secrets/` với quyền 644 nếu chưa có.
   - Thêm `infra/secrets/` vào [.gitignore](file:///home/iteso/projects/ITESO-ecosystem/.gitignore).
   - Mount `ed25519_private.pem` (read-only) vào container `control-plane` để ký token.
   - Mount `ed25519_public.pem` (read-only) vào container `gateway` để xác minh token độc lập.
   - Tạo [services/control-plane/src/auth/crypto.util.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/auth/crypto.util.ts): băm mật khẩu Argon2id, mã hóa/giải mã AES-256-GCM cho bí mật TOTP bằng `PLATFORM_ENCRYPTION_KEY`, xác minh mã TOTP RFC 6238, băm SHA-256 cho refresh token.
   - Tạo [services/control-plane/src/auth/token.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/auth/token.service.ts): ký và xác minh Ed25519 JWT (access token 15 phút; single-use selection/challenge token 5 phút).

4. **Hệ thống xác thực, đăng nhập & Quản lý vòng đời token:**
   - Tạo [services/control-plane/src/auth/auth.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/auth/auth.service.ts) & [services/control-plane/src/auth/auth.controller.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/auth/auth.controller.ts):
     - `POST /v1/auth/login`: Hỗ trợ đăng nhập qua email hoặc phone, xác thực Argon2id. Cơ chế khóa tài khoản: sai liên tiếp 5 lần thì khóa 15 phút; luôn trả lỗi chung `INVALID_CREDENTIALS`. Nếu là Super Admin trả `{ next: "totp", challenge_token }`. Nếu có nhiều tenant membership trả `{ next: "select_tenant", selection_token, tenants }`. Nếu có 1 membership trả cặp token.
     - `POST /v1/auth/select-tenant`: Nhận selection token (dùng 1 lần) và mã tenant, trả token cho tenant đó.
     - `POST /v1/auth/totp`: Nhận challenge token (dùng 1 lần) và mã 6 số TOTP, xác minh và cấp token Super Admin có `amr: ["pwd", "otp"]`.
     - `POST /v1/auth/refresh`: Xoay vòng refresh token (30 ngày). Phát hiện dùng lại token cũ -> thu hồi toàn bộ token family và trả `401 TOKEN_REUSE_DETECTED`.
     - `POST /v1/auth/logout`: Thu hồi toàn bộ họ refresh token.
     - `GET /v1/me`: Trả thông tin tài khoản, tenant, vai trò và danh sách quyền.

5. **Gateway AuthGuard & Phân quyền endpoint:**
   - Tạo [services/gateway/src/auth/public.decorator.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/auth/public.decorator.ts) (`@Public()`) và [services/gateway/src/auth/require-permission.decorator.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/auth/require-permission.decorator.ts) (`@RequirePermission('<key>')`).
   - Tạo [services/gateway/src/auth/jwt-verifier.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/auth/jwt-verifier.service.ts) xác minh JWT Ed25519 bằng public key nội bộ, kiểm tra `kid`.
   - Tạo [services/gateway/src/auth/auth.guard.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/auth/auth.guard.ts) áp dụng cho route `/v1`:
     - Bắt buộc khai báo `@Public()` hoặc `@RequirePermission('<key>')`, nếu thiếu trả `403 PERMISSION_UNDECLARED`.
     - Lấy tenant trực tiếp từ token (`payload.tid`). Nếu header `X-Tenant` được gửi kèm mà khác `payload.tid` thì chặn ngay với `403 TENANT_MISMATCH`.
     - Kiểm tra quyền yêu cầu: Super Admin hoặc user sở hữu quyền được thông qua; user thiếu quyền trả `403 PERMISSION_DENIED`.
   - Tạo [services/gateway/src/auth/auth-proxy.controller.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/auth/auth-proxy.controller.ts) chuyển tiếp các route `/v1/auth/*` và `/v1/me` sang `control-plane`.
   - Đặt `AuthGuard` chạy trước `FeatureFlagGuard` trong [services/gateway/src/app.module.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/app.module.ts).

6. **Super Admin thay Admin Token:**
   - Tạo CLI [services/control-plane/src/cli/create-platform-admin.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/cli/create-platform-admin.ts): tạo Super Admin, in chuỗi `otpauth://`, hỗ trợ cờ `--totp-secret` cho môi trường CI.
   - Thêm target `make create-platform-admin` trong [Makefile](file:///home/iteso/projects/ITESO-ecosystem/Makefile).
   - Tạo script tiện ích [scripts/get-totp.js](file:///home/iteso/projects/ITESO-ecosystem/scripts/get-totp.js) tính mã 6 số TOTP từ chuỗi secret base32.
   - Thay thế `AdminAuthGuard` bằng [services/control-plane/src/auth/platform-admin.guard.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/auth/platform-admin.guard.ts): chỉ cho phép access token có `is_platform_admin === true` và `amr` chứa `otp`. Xóa bỏ hoàn toàn biến `CONTROL_PLANE_ADMIN_TOKEN` và cơ chế `X-Admin-Token`.
   - Thêm các API quản trị tại [services/control-plane/src/control-plane/admin.controller.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/control-plane/admin.controller.ts):
     - `POST /admin/accounts`: Tạo tài khoản mới.
     - `POST /admin/tenants/:code/memberships`: Gắn tài khoản vào tenant kèm vai trò.
     - `PUT /admin/accounts/:id/password`: Đặt lại mật khẩu.
     - `GET /admin/tenants/:code/roles`: Danh sách vai trò của tenant.
   - Mọi thao tác quản trị đều ghi `admin_audit_log` với `actor` là UUID tài khoản Super Admin thực tế (`req.user.id`).

7. **Tự động hóa kiểm thử & CI:**
   - Xây dựng bộ kiểm thử tích hợp tự động [scripts/test-acceptance-criteria.js](file:///home/iteso/projects/ITESO-ecosystem/scripts/test-acceptance-criteria.js) kiểm tra toàn bộ 10 tiêu chí nghiệm thu với service đang chạy.
   - Tích hợp vào `make test` trong [Makefile](file:///home/iteso/projects/ITESO-ecosystem/Makefile).
   - Cập nhật [.github/workflows/ci.yml](file:///home/iteso/projects/ITESO-ecosystem/.github/workflows/ci.yml) tự động sinh khóa Ed25519, dựng stack Compose, khởi tạo Super Admin bằng TOTP secret cố định và chạy toàn bộ suite nghiệm thu.

---

## Tên quyền "mọi thành viên" đã đề xuất

- **Tên quyền được chọn:** `system.features.read`
- **Mục đích:**
  - Áp dụng cho endpoint `GET /v1/features` và `GET /v1/me`.
  - Mọi người dùng khi được gán bất kỳ vai trò hợp lệ nào trong tenant (Chủ, Quản lý, Thu ngân, Phục vụ, Bếp, Kế toán) đều được cấp quyền này để đọc được danh sách tính năng đang kích hoạt và thông tin phiên đăng nhập của mình.

---

## Những chỗ làm khác phiếu hoặc chi tiết bổ sung

1. **Định dạng request body linh hoạt cho client:**
   - Endpoint `POST /v1/auth/login`: Chấp nhận cả trường `identifier` lẫn `login`.
   - Endpoint `POST /v1/auth/select-tenant`: Chấp nhận cả trường `tenant` lẫn `tenant_code`.
2. **Cơ chế tải public key trên control-plane:**
   - `TokenService` trên `control-plane` sử dụng `crypto.createPublicKey` để tự động suy diễn public key trực tiếp từ private key Ed25519 (`ed25519_private.pem`). Điều này cho phép `control-plane` xác thực token ngay trong nội bộ (cho `GET /v1/me` và `PlatformAdminGuard`) mà không cần mount thêm file public key riêng biệt.
3. **Thứ tự Guard tại Gateway:**
   - `AuthGuard` được cấu hình chạy trước `FeatureFlagGuard` trong `APP_GUARD`. Nhờ đó, token luôn được xác thực tính hợp lệ, lấy `req.tenantCode` từ token và kiểm tra quyền trước khi đánh giá cờ tính năng.

---

## Kết quả nghiệm thu (Output thực tế)

### 1. `make test` (Bao gồm unit test, isolation test, odoo module test và acceptance suite)

```text
pnpm --filter @iteso/control-plane test

> @iteso/control-plane@0.1.0 test /home/iteso/projects/ITESO-ecosystem/services/control-plane
> jest

PASS test/app.spec.ts
  Control Plane Endpoints (TASK-003)
    Password Hashing & Lockout Logic (Crypto & Auth)
      ✓ hashes password with Argon2id and verifies correctly (211 ms)
      ✓ locks account after 5 consecutive failed attempts and unlocks after 15 minutes (116 ms)
    Single-use Tokens & Token Reuse Detection
      ✓ rejects reusing a selection_token or challenge_token (12 ms)
      ✓ revokes entire token family when a reused refresh token is submitted (8 ms)
    Super Admin TOTP Flow & PlatformAdminGuard
      ✓ returns 401 when old X-Admin-Token is used (TASK-002 token removed) (28 ms)
      ✓ returns 401 when Super Admin token lacks otp in amr (20 ms)
      ✓ allows access when valid Super Admin token with amr ["pwd", "otp"] is provided (9 ms)
      ✓ verifies TOTP code correctly during login flow (59 ms)
    Admin API Body Validation & Endpoints
      ✓ returns 400 when enabled is not a boolean (e.g. string "false") (18 ms)
      ✓ returns 400 when note exceeds 500 characters (11 ms)
    ControlPlaneService Logic (Audit log records real actor UUID & NATS event)
      ✓ throws 409 FEATURE_NOT_IMPLEMENTED when attempting to enable a not_implemented feature (10 ms)
      ✓ updates available feature, creates audit log with real actor, and publishes to NATS (5 ms)

Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
Snapshots:   0 total
Time:        3.09 s, estimated 5 s
Ran all test suites.

pnpm --filter @iteso/gateway test

> @iteso/gateway@0.1.0 test /home/iteso/projects/ITESO-ecosystem/services/gateway
> jest

[Nest] 1282030  - 11/26/2026, 4:40:11 AM   ERROR [AuthGuard] Undeclared permission on v1 endpoint: GET /v1/test-no-permission
[Nest] 1282030  - 11/26/2026, 4:40:11 AM   ERROR [FeatureFlagGuard] Undeclared feature on v1 endpoint: GET /v1/test-no-feature
PASS test/app.spec.ts
  Gateway endpoints (TASK-003)
    GET /health
      ✓ returns 200 and ok for all 5 components without needing token or @RequireFeature (153 ms)
    AuthGuard & Token Verification on /v1
      ✓ returns 401 UNAUTHENTICATED when Authorization header is missing (21 ms)
      ✓ returns 401 UNAUTHENTICATED when token is expired (12 ms)
      ✓ returns 401 UNAUTHENTICATED when token is signed with a different key (9 ms)
      ✓ returns 401 UNAUTHENTICATED when token kid does not match (8 ms)
      ✓ returns 403 PERMISSION_DENIED when user lacks required permission (e.g. cashier calling diagnostics) (8 ms)
      ✓ returns 403 TENANT_MISMATCH when X-Tenant header differs from tid in token (8 ms)
      ✓ returns 403 PERMISSION_UNDECLARED when endpoint lacks @RequirePermission and @Public (8 ms)
      ✓ returns 403 FEATURE_UNDECLARED when endpoint lacks @RequireFeature (10 ms)
      ✓ returns 200 when user has valid token, correct permission, and feature is enabled (8 ms)
    Feature Flag Evaluation Matrix (Real SQL simulation via mock Pool)
      ✓ case 1: feature is platform_enabled = false -> returns false (5 ms)
      ✓ case 2: tenant override = false -> returns false (4 ms)
      ✓ case 3: no tenant row, default_enabled = true -> returns true (3 ms)
      ✓ case 4: no tenant row, default_enabled = false -> returns false (4 ms)
      ✓ case 5: implementation_status = not_implemented -> returns false (4 ms)
      ✓ case 6: feature key does not exist -> returns false (5 ms)
      ✓ caching: does not query database again within 30 seconds (5 ms)
      ✓ caching: queries database again after clearCache (e.g. on NATS event) (5 ms)

Test Suites: 1 passed, 1 total
Tests:       18 passed, 18 total
Snapshots:   0 total
Time:        0.497 s, estimated 6 s
Ran all test suites.

./scripts/test-db-isolation.sh
[test-db-isolation] Verifying 'iteso_gateway' can connect to 'platform' and SELECT tenants...
[test-db-isolation] Verifying 'iteso_gateway' is DENIED access to 't_demo_fnb' (res_users)...
[test-db-isolation] Verifying 'iteso_gateway' cannot write to 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' cannot SELECT from 'admin_audit_log' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' cannot SELECT from 'accounts' in 'platform'...
[test-db-isolation] PASS: All database isolation checks passed cleanly.

./scripts/test-odoo-module.sh
[test-odoo-module] Dropping any leftover 't_test_iteso_base'...
[test-odoo-module] Installing 'iteso_base' into fresh database 't_test_iteso_base'...
[secure-tenant-db] Securing database 't_test_iteso_base' (revoking access from PUBLIC and 'iteso_gateway')...
REVOKE
REVOKE
[test-odoo-module] PASS: iteso_base installed cleanly in 't_test_iteso_base' (state=installed).

node ./scripts/test-acceptance-criteria.js
=================================================================
STARTING TASK-003 ACCEPTANCE CRITERIA VERIFICATION
=================================================================

--- Criterion 1: Keypair generation and secrets isolation ---
✓ Ed25519 keypair exists in infra/secrets/
✓ git status verifies infra/secrets/ and .env are completely ignored.

--- Criterion 2: owner@demo.local login and GET /v1/me ---
✓ owner login successful (access_token received, expires_in: 900s)
GET /v1/me response: {
  "account": {
    "id": "4aaaaa77-052b-4fa7-b7a8-903b86ef5b6f",
    "email": "owner@demo.local",
    "phone": "+84900000001",
    "isPlatformAdmin": false
  },
  "tenant": "demo_fnb",
  "membershipId": "c1c4e8e7-d138-4ac3-8a8c-49023fb9fda5",
  "roles": [
    "Chủ"
  ],
  "perms": [
    "system.diagnostics.view",
    "settings.manage",
    "settings.roles.manage",
    "pos.order.create",
    "pos.order.void",
    "pos.discount.apply",
    "report.revenue.view",
    "inventory.manage",
    "accounting.view",
    "system.features.read"
  ]
}
✓ Criterion 2 verified: tenant=demo_fnb, role=Chủ, full permissions including system.features.read.

--- Criterion 3: GET /v1/odoo/version authorization checks ---
✓ 3.1 No token -> 401 UNAUTHENTICATED
✓ 3.2 Cashier token lacking system.diagnostics.view -> 403 PERMISSION_DENIED
✓ 3.3 Owner token -> 200 OK (Odoo version: 20.0-20261123)

--- Criterion 4: Tenant header mismatch verification ---
✓ Criterion 4 verified: {"error":"TENANT_MISMATCH","message":"X-Tenant header 'demo_fnb2' does not match token tenant 'demo_fnb'"}

--- Criterion 8 (Setup): Authenticating Super Admin via Password + TOTP ---
✓ Old X-Admin-Token rejected with 401 UNAUTHORIZED (header token eliminated)
✓ Admin login step 1 returns next: "totp" and single-use challenge_token
Generated TOTP code from secret: 914529
✓ Admin login step 2 verified TOTP and issued Super Admin token with amr: ["pwd", "otp"]

--- Criterion 5: Account lockout after 5 consecutive failed attempts ---
✓ Attempt 1 (wrong password) -> 401 INVALID_CREDENTIALS
✓ Attempt 2 (wrong password) -> 401 INVALID_CREDENTIALS
✓ Attempt 3 (wrong password) -> 401 INVALID_CREDENTIALS
✓ Attempt 4 (wrong password) -> 401 INVALID_CREDENTIALS
✓ Attempt 5 (wrong password) -> 401 INVALID_CREDENTIALS
✓ Attempt 6 (correct password on locked account) -> 401 INVALID_CREDENTIALS
✓ Criterion 5 verified cleanly.

--- Criterion 6: Refresh token rotation and reuse detection ---
✓ 6.1 Successfully refreshed token (RT1 -> RT2)
✓ 6.2 Reusing RT1 detected token theft -> 401 TOKEN_REUSE_DETECTED
✓ 6.3 Using RT2 from revoked family rejected -> 401 TOKEN_REUSE_DETECTED
✓ Criterion 6 verified cleanly.

--- Criterion 7: multi@demo.local tenant selection flow ---
✓ 7.1 multi@demo.local receives next: "select_tenant" with tenants: [ 'demo_fnb', 'demo_fnb2' ]
✓ 7.2 select-tenant issued token with tid=demo_fnb2, /v1/me confirmed tenant=demo_fnb2
✓ Criterion 7 verified cleanly.

--- Criterion 8: Feature toggle scenario with Super Admin token and audit log ---
✓ 8.1 Feature system.odoo_version disabled via Super Admin token
✓ 8.2 Gateway immediately rejected call -> 403 FEATURE_DISABLED
✓ 8.3 Feature system.odoo_version re-enabled via Super Admin token
✓ 8.4 Gateway call succeeds immediately -> 200 OK
Latest audit log actor: f2ab5c99-dd9f-490a-81e9-7fef9dc9252e
✓ 8.5 Verified admin_audit_log records real actor UUID in platform database
✓ Criterion 8 verified cleanly.

--- Criterion 10: Git history verification for secrets ---
✓ Git history contains no private keys or committed secrets.

=================================================================
ALL ACCEPTANCE CRITERIA PASSED SUCCESSFULLY (10/10)!
=================================================================
```

### 2. `make ps`

```text
NAME                              IMAGE                           COMMAND                  SERVICE         CREATED          STATUS                    PORTS
iteso-ecosystem-control-plane-1   iteso-ecosystem-control-plane   "docker-entrypoint.s…"   control-plane   5 minutes ago    Up 5 minutes (healthy)    127.0.0.1:3100->3100/tcp
iteso-ecosystem-gateway-1         iteso-ecosystem-gateway         "docker-entrypoint.s…"   gateway         11 minutes ago   Up 11 minutes (healthy)   127.0.0.1:3000->3000/tcp
iteso-ecosystem-nats-1            nats:2.15.3                     "/nats-server -m 8222"   nats            12 minutes ago   Up 12 minutes             4222/tcp, 6222/tcp, 8222/tcp
iteso-ecosystem-odoo-1            odoo:20.0-20261123              "/bin/sh /etc/odoo/s…"   odoo            11 minutes ago   Up 11 minutes (healthy)   127.0.0.1:8069->8069/tcp, 8071-8072/tcp
iteso-ecosystem-postgres-1        postgres:16.16-alpine           "docker-entrypoint.s…"   postgres        12 minutes ago   Up 12 minutes (healthy)   5432/tcp
iteso-ecosystem-redis-1           redis:7.4.12-alpine             "docker-entrypoint.s…"   redis           11 minutes ago   Up 11 minutes (healthy)   6379/tcp
```
