# Báo cáo TASK-005: Máy POS dùng chung, Đăng nhập bằng PIN & Danh sách Roster ngoại tuyến

## Đã làm

1. **Dữ liệu & Migration Drizzle (`0004_add_pos_devices_and_pins.sql`):**
   - Tạo migration tại [services/control-plane/drizzle/0004_add_pos_devices_and_pins.sql](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/drizzle/0004_add_pos_devices_and_pins.sql):
     - Bảng `branches`: `id` (uuid, PK), `tenant_id` (FK `tenants`), `code` (varchar 50, duy nhất theo tenant), `name`, `status` (enum `branch_status`: `active`, `disabled`), `created_at`.
     - Bảng `pos_devices`: `id` (uuid, PK), `tenant_id` (FK `tenants`), `branch_id` (FK `branches`), `name` (varchar 100), `token_hash` (varchar 64 hex SHA-256, duy nhất), `status` (enum `pos_device_status`: `active`, `revoked`), `paired_by_membership_id`, `paired_at`, `last_seen_at`, `revoked_at`.
     - Bảng `pos_pairing_codes`: `id` (uuid, PK), `tenant_id`, `branch_id`, `device_name`, `code_hash` (varchar 64 hex SHA-256), `created_by_membership_id`, `expires_at` (10 phút), `used_at`.
     - Bảng `membership_pins`: `membership_id` (uuid, PK, FK `memberships`), `pin_hash` (argon2id), `updated_at`, `failed_attempts` (mặc định 0), `locked_until` (timestamp).
     - Cột `refresh_tokens.device_id`: FK `pos_devices.id`, null đối với phiên đăng nhập mật khẩu thông thường.
   - Cập nhật phân quyền least-privilege cho `iteso_gateway` trong [services/control-plane/src/db/migrate.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/db/migrate.ts) và [scripts/init-db-roles.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/init-db-roles.sh):
     - `iteso_gateway` chỉ được `SELECT (id, tenant_id, branch_id, status)` trên bảng `pos_devices`.
     - Tuyệt đối bị từ chối truy cập `pos_devices.token_hash`, `branches`, `pos_pairing_codes`, `membership_pins`. Kiểm tra tự động 100% trong [scripts/test-db-isolation.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/test-db-isolation.sh).

2. **Cấu hình Quyền & Tính năng mẫu (Seed):**
   - Cập nhật [services/control-plane/src/db/seed.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/db/seed.ts):
     - Thêm tính năng `pos.devices` (nhóm `pos`), `implementation_status = 'available'`.
     - Thêm 3 quyền mới:
       - `pos.device.manage`: Ghép máy, xem danh sách và thu hồi máy POS;
       - `pos.session.open`: Đăng nhập phiên POS bằng PIN;
       - `staff.pin.reset`: Xóa PIN của nhân viên.
     - Phân bổ vai trò mẫu:
       - Chủ (`owner`) và Quản lý (`manager`): có đủ cả 3 quyền;
       - Thu ngân (`cashier`), Phục vụ (`waiter`), Bếp (`kitchen`): có quyền `pos.session.open`;
       - Kế toán (`accountant`): không có quyền nào trong 3 quyền này.
     - Seed chi nhánh `main` ("Chi nhánh chính") cho các tenant mẫu `demo_fnb` và `demo_fnb2`.

3. **Control-plane: Nghiệp vụ Thiết bị POS, PIN & Roster ngoại tuyến:**
   - Tạo tiện ích xác thực mã PIN và ghép mã tại [services/control-plane/src/auth/crypto.util.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/auth/crypto.util.ts):
     - `generatePairingCode(8)`: Tạo mã 8 ký tự từ tập ký tự CSPRNG `[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]`, bỏ triệt để các ký tự dễ nhầm lẫn `0`, `O`, `1`, `I`.
     - `validatePinComplexity(pin, phone)`: Kiểm tra đúng 6 chữ số, từ chối mã có 6 số giống nhau (vd `111111`), chuỗi liên tiếp tăng/giảm (vd `123456`, `654321`), hoặc trùng với 6 số cuối số điện thoại.
   - Mở rộng [services/control-plane/src/auth/token.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/auth/token.service.ts):
     - Hỗ trợ thêm các trường `did` (device ID) và `bid` (branch ID) trong payload `AccessTokenPayload`.
     - Thêm `signRosterJws(payload)`: Ký Ed25519 JWS với thời hạn 24 giờ (`exp`), audience `iteso-pos`, issuer `iteso-control-plane`.
     - Thêm `getPublicJwk()`: Xuất khóa công khai Ed25519 dạng JWK (`OKP`, `Ed25519`) để POS client kiểm tra offline.
   - Tạo [services/control-plane/src/control-plane/pos-device.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/control-plane/pos-device.service.ts) và [services/control-plane/src/control-plane/pos-device.controller.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/control-plane/pos-device.controller.ts):
     - `POST /v1/pos/pairing-codes`: Yêu cầu quyền `pos.device.manage`. Tạo mã ghép 8 ký tự có hạn 10 phút, lưu mã băm SHA-256. Trả về mã ghép một lần duy nhất.
     - `POST /v1/pos/devices/pair`: Endpoint công khai, giới hạn 10 req/phút/IP. Khớp mã băm SHA-256, kiểm tra thời hạn và đánh dấu đã dùng (`used_at`) nguyên tử. Sinh thiết bị mới với `device_token` CSPRNG 32 bytes (64 hex), lưu `token_hash` SHA-256 vào database. Trả `{ device_id, device_token, branch, roster_public_jwk }`.
     - `GET /v1/pos/devices`: Trả danh sách thiết bị thuộc tenant (tuyệt đối không lộ token).
     - `DELETE /v1/pos/devices/:id`: Đặt `status = 'revoked'`, `revoked_at = NOW()`, thu hồi mọi refresh token có `device_id` này, phát sự kiện NATS `platform.devices.changed` `{ device_id, tenant_id }`, và ghi `admin_audit_log`.
     - `PUT /v1/me/pin`: Yêu cầu access token có `amr` chứa `pwd` (buộc đăng nhập bằng mật khẩu). Kiểm tra lại mật khẩu hiện tại, kiểm tra độ phức tạp của PIN, băm bằng `argon2id` và lưu vào `membership_pins`.
     - `DELETE /v1/staff/:membership_id/pin`: Yêu cầu quyền `staff.pin.reset`, xóa PIN của thành viên trong tenant.
     - `POST /v1/pos/auth/pin`: Header `Authorization: Device <device_token>`. Kiểm tra trạng thái máy, chi nhánh, membership, quyền `pos.session.open`. Kiểm tra PIN bằng argon2id. Cơ chế bảo vệ khóa tài khoản: sai PIN tăng `failed_attempts` nguyên tử, sai 5 lần khóa 5 phút; chống rò rỉ thời gian (timing attacks) bằng dummy argon2 hash khi người dùng chưa đặt PIN hoặc không hợp lệ; mọi lỗi trả chung `401 INVALID_PIN`. Cấp access token 15 phút mang `did`, `bid`, `amr: ['pin']` và refresh token gắn với `device_id` có hạn tối đa 12 giờ (cap 12h) từ lúc nhập PIN.
     - `POST /v1/pos/auth/refresh`: Xoay vòng refresh token gắn thiết bị, giữ nguyên mốc 12 giờ hết hạn ban đầu.
     - `GET /v1/pos/roster`: Cấp danh sách nhân viên ngoại tuyến đã ký JWS (24h exp), chỉ gồm các thành viên thuộc chi nhánh, có quyền `pos.session.open` và đã đặt PIN. Cập nhật `last_seen_at` của thiết bị.

4. **Gateway: Xác minh Thiết bị & Ủy quyền POS:**
   - Tạo [services/gateway/src/auth/device-verification.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/auth/device-verification.service.ts):
     - Truy vấn `pos_devices (id, tenant_id, branch_id, status)` qua PostgreSQL pool của `iteso_gateway`.
     - Cache kết quả thiết bị trong bộ nhớ 30 giây.
     - Lắng nghe NATS topic `platform.devices.changed`, xóa cache ngay lập tức (<2s) khi thiết bị bị thu hồi.
   - Cập nhật [services/gateway/src/auth/auth.guard.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/auth/auth.guard.ts):
     - Khi access token có claim `did`, kiểm tra qua `DeviceVerificationService`: nếu máy không tồn tại hoặc bị thu hồi (`revoked`), từ chối ngay với `401 DEVICE_REVOKED`.
     - Nếu token có claim `bid`, xác minh chi nhánh thuộc đúng thiết bị.
   - Cập nhật [services/gateway/src/auth/auth-proxy.controller.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/auth/auth-proxy.controller.ts):
     - Chuyển tiếp các route `/v1/pos/*`, `/v1/me/pin`, `/v1/staff/:id/pin` sang control-plane.
     - Gắn decorator `@RequireFeature('pos.devices')` và các quyền tương ứng `@RequirePermission('pos.device.manage')`, `@RequirePermission('staff.pin.reset')`, hoặc `@Public()`.
     - Chuyển tiếp header `Authorization` (Bearer token hoặc Device token) và client IP.

5. **Xử lý tồn đọng từ TASK-004:**
   - **Siết biểu thức key Odoo hệ thống:** Cập nhật [services/control-plane/src/cli/register-tenant-system-key.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/cli/register-tenant-system-key.ts) siết chặt regex về đúng `^[0-9a-f]{40}_oak$` theo mã nguồn Odoo 20.
   - **Kịch bản nghiệm thu kiểm tra challenge_token qua restart:** Bổ sung vào kịch bản nghiệm thu: Lấy `challenge_token`, thực hiện xác thực TOTP lần 1 (lưu `jti` vào Redis), khởi động lại container `control-plane` (`docker compose restart control-plane`), và kiểm tra việc dùng lại `challenge_token` này với mã TOTP mới bị từ chối `401 Token has already been used`.

---

## Kết quả 10 Tiêu chí Nghiệm thu (Real Output)

Toàn bộ 10 tiêu chí nghiệm thu chạy hoàn toàn tự động trong `node ./scripts/test-acceptance-criteria.js`:

```text
=================================================================
STARTING TASK-005 ACCEPTANCE CRITERIA VERIFICATION
=================================================================

--- Setup: Authenticating demo accounts ---
Owner MID: 14345ef1-3243-45dc-80b6-f6f9d4a4d38e, Cashier MID: 250eeb60-290d-491b-b049-a5148fa17c96

--- Criterion 1: Pairing code generation & POS device pairing ---
Pairing code response: {
  pairing_code: 'R6XJ5982',
  expires_at: '2026-11-27T11:53:42.118Z',
  device_name: 'POS Quầy 1',
  branch_code: 'main'
}
Paired device info: {
  device_id: '53d2392a-0054-49e2-a5fe-e178f81d3598',
  branch: {
    id: '9966253d-26be-4b9d-a973-c89ed384fdf3',
    code: 'main',
    name: 'Chi nhánh chính'
  },
  has_token: true,
  has_jwk: true
}
✓ Criterion 1 PASS: Pairing code generated and device paired successfully.

--- Criterion 2: Cashier sets PIN & logs in on POS device (403 diagnostics) ---
✓ Criterion 2 PASS: Cashier PIN login token carries cashier permissions (403 on diagnostics).

--- Criterion 3: Owner sets PIN & logs in on POS device (200 with odoo_uid) ---
Owner diagnostics response: {
  tenant: 'demo_fnb',
  database: 't_demo_fnb',
  api: 'json-2',
  version: '20.0-20261123',
  version_info: [ 20, 0, 0, 'final', 0, '' ],
  base_module_version: '20.0.1.3',
  odoo_uid: 7
}
✓ Criterion 3 PASS: Owner PIN login token yields 200 OK with owner odoo_uid.

--- Criterion 4: Fast user switching on same device without passwords ---
✓ Criterion 4 PASS: Fast user switching completed in 3 API calls without passwords.

--- Criterion 5: PIN brute-force lockout after 5 failed attempts ---
Database lock state (failed_attempts|locked_until_active): 5|t
✓ Criterion 5 PASS: Account locked after 5 failed attempts, 6th attempt rejected.

--- Criterion 6: Offline Roster download, Ed25519 signature & Argon2 verification ---
Roster payload summary: {
  iss: 'iteso-control-plane',
  sub: '53d2392a-0054-49e2-a5fe-e178f81d3598',
  aud: 'iteso-pos',
  exp: 1795866223,
  members_count: 2
}
✓ Criterion 6 PASS: Roster JWS signature verified, payload correct, offline PIN check succeeded.

--- Criterion 7: Device revocation & immediate gateway rejection (<2s) ---
✓ Criterion 7 PASS: Device revoked; gateway immediately returns 401 DEVICE_REVOKED, refresh and roster rejected.

--- Criterion 8: Pairing code reuse/expiry & PIN complexity ---
✓ Criterion 8 PASS: Pairing code reuse/expiry and PIN complexity properly enforced.

--- Criterion 9: Regressions & TASK-004 Backlog Items ---
9.1 Testing challenge_token reuse after control-plane restart...
Restarting control-plane container...
 Container iteso-ecosystem-control-plane-1 Restarting 
 Container iteso-ecosystem-control-plane-1 Started 
Waiting for control-plane to restart and become healthy...
✓ 9.1 Reused challenge_token strictly rejected after restart (Redis persistence verified).
[test-db-isolation] Verifying 'iteso_gateway' can connect to 'platform' and SELECT tenants...
[test-db-isolation] Verifying 'iteso_gateway' is DENIED access to 't_demo_fnb' (res_users)...
[test-db-isolation] Verifying 'iteso_gateway' cannot write to 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' cannot SELECT from 'admin_audit_log' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' cannot SELECT from 'accounts' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' can SELECT the 6 permitted columns from 'membership_odoo_users' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT unpermitted column 'last_error' or 'synced_at' on 'membership_odoo_users'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'tenant_odoo_system_keys' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'refresh_tokens' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' can SELECT permitted 4 columns from 'pos_devices' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT unpermitted column 'token_hash' on 'pos_devices'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'branches' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'pos_pairing_codes' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'membership_pins' in 'platform'...
[test-db-isolation] PASS: All database isolation checks passed cleanly.
✓ Criterion 9 PASS: Prior tasks criteria, backlog items, and database isolation intact.

--- Criterion 10: Git history check for secrets ---
✓ Criterion 10 PASS: No secret keys, credentials or .env in git history.

=================================================================
ALL TASK-005 ACCEPTANCE CRITERIA PASSED SUCCESSFULLY (10/10)!
=================================================================
```

---

## Kết quả kiểm tra toàn diện (`make test`)

```text
pnpm --filter @iteso/control-plane test

> @iteso/control-plane@0.1.0 test /home/iteso/projects/ITESO-ecosystem/services/control-plane
> jest

PASS test/odoo-provisioning.spec.ts
PASS test/pos-device.spec.ts
PASS test/app.spec.ts (5.774 s)

Test Suites: 3 passed, 3 total
Tests:       29 passed, 29 total
Snapshots:   0 total
Time:        6.501 s
Ran all test suites.
pnpm --filter @iteso/gateway test

> @iteso/gateway@0.1.0 test /home/iteso/projects/ITESO-ecosystem/services/gateway
> jest

PASS test/device-verification.spec.ts
PASS test/odoo-credential.spec.ts
PASS test/app.spec.ts

Test Suites: 3 passed, 3 total
Tests:       31 passed, 31 total
Snapshots:   0 total
Time:        4.178 s
Ran all test suites.
./scripts/test-db-isolation.sh
[test-db-isolation] PASS: All database isolation checks passed cleanly.
./scripts/test-odoo-module.sh
[test-odoo-module] ALL TESTS PASSED for iteso_base.
node ./scripts/test-acceptance-criteria.js
ALL TASK-005 ACCEPTANCE CRITERIA PASSED SUCCESSFULLY (10/10)!
```
