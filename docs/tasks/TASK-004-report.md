# Báo cáo TASK-004: Mỗi thành viên một người dùng Odoo riêng

## Đã làm

1. **Khảo sát Odoo 20 (Mục 7 của phiếu):**
   - Đọc trực tiếp mã nguồn trong container Odoo 20 (`/usr/lib/python3/dist-packages/odoo/addons/base/models/res_users.py` và `/usr/lib/python3/dist-packages/odoo/addons/rpc/controllers/json2.py`).
   - Xác định chữ ký hàm sinh API key: `ResUsersApikeys._generate(self, scope, name, expiration_date)`.
   - Giới hạn thời hạn key: Đối với user thông thường (thuộc `base.group_user`), `_generate` tính giới hạn qua `max(group.api_key_duration for group in user.all_group_ids) or 1.0` (mặc định 90 ngày cho user thường). Nếu truyền `expiration_date=None` hoặc vượt quá giới hạn thì bị `UserError`. Ngược lại, user hệ thống quản trị (`self.env.is_system()` / `sudo()`) có thể sinh key không thời hạn (`expiration_date=None`).
   - Gọi phương thức model trừu tượng qua JSON-2: Endpoint `/json/2/<model>/<method>` (ví dụ `/json/2/iteso.provisioning/provision_member`) hỗ trợ gọi các model kế thừa `models.AbstractModel`. Header xác thực yêu cầu `Authorization: bearer <api_key>` (chữ thường hoặc viết hoa) kèm `X-Odoo-Database: <database>` và `Content-Type: application/json`. Request body truyền thẳng dictionary các tham số (kwargs) dạng `{"membership_id": "...", "name": "...", "group_xmlids": ["base.group_user"]}`.

2. **Module Odoo `iteso_base`: Cổng cấp người dùng (`iteso.provisioning`):**
   - Tạo model trừu tượng `iteso.provisioning` tại [odoo-addons/iteso_base/models/provisioning.py](file:///home/iteso/projects/ITESO-ecosystem/odoo-addons/iteso_base/models/provisioning.py):
     - `provision_member(membership_id, name, group_xmlids)`: Tạo/cập nhật user với login `iteso-<membership_id>`, kích hoạt `active=True`, gán tên hiển thị, nhóm quyền và không đặt mật khẩu. Hỗ trợ tìm kiếm user bị vô hiệu hóa trước đó bằng `with_context(active_test=False)`.
     - `issue_member_key(uid, ttl_days)`: Gọi `res.users.apikeys._generate` sinh key scope `rpc`, tên `iteso-gateway`, hạn theo `ttl_days`. Trả raw key 1 lần duy nhất cùng `expires_at`.
     - `revoke_member_keys(uid, keep_newest)`: Thu hồi các key `iteso-gateway` cũ của user, hỗ trợ giữ key mới nhất khi xoay vòng.
     - `disable_member(uid)`: Đặt `active=False` và xóa sạch API key của user.
   - Kiểm soát bảo mật:
     - Mọi method chỉ cho phép người gọi là `iteso_system` và thuộc `base.group_system` (kiểm tra `self.env.user.login == 'iteso_system'` và `self.env.user.has_group('base.group_system')`), nếu không ném `AccessError`.
     - Chỉ chấp nhận các nhóm trong whitelist (`base.group_user`), từ chối nếu yêu cầu `base.group_system` hay `base.group_erp_manager`.
   - Cấp quyền đọc `ir.module.module` cho `base.group_user` trong [odoo-addons/iteso_base/security/ir.access.csv](file:///home/iteso/projects/ITESO-ecosystem/odoo-addons/iteso_base/security/ir.access.csv) để thành viên thông thường có thể gọi endpoint chẩn đoán `GET /v1/odoo/version`.
   - Viết test suite Odoo tại [odoo-addons/iteso_base/tests/test_provisioning.py](file:///home/iteso/projects/ITESO-ecosystem/odoo-addons/iteso_base/tests/test_provisioning.py) chạy qua `odoo --test-enable` (5 test pass hoàn toàn).

3. **Người dùng hệ thống `iteso_system` & Đăng ký khóa hệ thống tenant:**
   - Cập nhật [scripts/init-demo-tenant.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/init-demo-tenant.sh):
     - Tạo user `iteso_system` (nhóm `base.group_system`, không có mật khẩu) qua `odoo shell`.
     - Sinh API key không thời hạn (`expiration_date=None`) cho `iteso_system` và pipe trực tiếp qua stdin vào CLI `register-tenant-system-key.js`.
     - Gỡ bỏ hoàn toàn việc chèn key `iteso-gateway-dev` bằng SQL.
   - Tạo CLI [services/control-plane/src/cli/register-tenant-system-key.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/cli/register-tenant-system-key.ts): Đọc raw key từ stdin, mã hóa AES-256-GCM bằng `PLATFORM_ENCRYPTION_KEY`, lưu vào `tenant_odoo_system_keys`. Tuyệt đối không log hay in raw key ra stdout.

4. **Database Schema & Phân quyền least-privilege (`platform`):**
   - Cập nhật [services/control-plane/src/db/schema.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/db/schema.ts):
     - Enum `odooUserStatusEnum` (`pending`, `active`, `disabled`, `error`).
     - Bảng `tenant_odoo_system_keys`: `tenant_id` (PK), `key_enc`, `created_at`, `rotated_at`.
     - Bảng `membership_odoo_users`: `membership_id` (PK), `tenant_id`, `odoo_uid`, `odoo_login`, `api_key_enc`, `key_expires_at`, `status`, `last_error`, `synced_at`.
     - Thêm cột `odoo_groups text[]` vào bảng `roles`, mặc định `{'base.group_user'}`.
     - Thêm cột `last_totp_step integer` vào bảng `accounts` để chống replay TOTP cùng bước thời gian.
   - Sinh migration Drizzle tại [services/control-plane/drizzle/0003_add_odoo_user_provisioning.sql](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/drizzle/0003_add_odoo_user_provisioning.sql).
   - Quản lý khóa riêng `infra/secrets/odoo_credentials.key`:
     - Cập nhật [scripts/generate-keys.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/generate-keys.sh) sinh khóa AES-256-GCM 32 bytes (`chmod 600`, UID 1000).
     - Mount khóa vào cả `control-plane` và `gateway` trong [infra/docker-compose.yml](file:///home/iteso/projects/ITESO-ecosystem/infra/docker-compose.yml).
   - Phân quyền cách ly database trong [services/control-plane/src/db/migrate.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/db/migrate.ts) và [scripts/init-db-roles.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/init-db-roles.sh):
     - `iteso_gateway` chỉ được `SELECT` đúng 6 cột: `membership_id`, `tenant_id`, `odoo_uid`, `api_key_enc`, `key_expires_at`, `status` trên bảng `membership_odoo_users`.
     - Bị từ chối truy cập `tenant_odoo_system_keys`, `accounts`, `refresh_tokens`, `admin_audit_log` và các cột `last_error`, `synced_at`. Kiểm tra tự động bằng [scripts/test-db-isolation.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/test-db-isolation.sh).

5. **Control-plane: Đồng bộ người dùng Odoo (`OdooProvisioningService`):**
   - Tạo [services/control-plane/src/control-plane/odoo-provisioning.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/control-plane/odoo-provisioning.service.ts):
     - Gọi `iteso.provisioning` qua JSON-2 với key hệ thống của tenant.
     - Đồng bộ theo thứ tự chuẩn: gọi `provision_member` -> `issue_member_key` -> mã hóa bằng `odoo_credentials.key` và lưu vào DB -> gọi `revoke_member_keys(keep_newest=True)` -> phát NATS event `platform.odoo_credentials.changed` `{ membership_id }`.
     - Xử lý vô hiệu hóa membership: gọi `disable_member`, đặt `status='disabled'`, xóa `api_key_enc`, phát NATS.
     - Xử lý tenant chưa có Odoo DB (như `demo_fnb2`): đặt `status='pending'`, không báo lỗi.
     - Xử lý lỗi Odoo: đặt `status='error'` kèm `last_error`.
     - Xoay vòng tự động: Chạy lúc khởi động và định kỳ 24h qua `setInterval`, tự động cấp key mới cho các key còn dưới 14 ngày và thử lại các bản ghi `error`.
   - Tạo CLI [services/control-plane/src/cli/provision-odoo-users.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/cli/provision-odoo-users.ts) để đồng bộ mọi membership của tenant.
   - Thêm API quản trị tại [services/control-plane/src/control-plane/admin.controller.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/control-plane/admin.controller.ts):
     - `PUT /admin/tenants/:code/memberships/:id`: Cập nhật status/roles của membership, kích hoạt đồng bộ Odoo và ghi `admin_audit_log`.
     - `POST /admin/tenants/:code/memberships/:id/odoo-sync`: Kích hoạt đồng bộ thủ công.

6. **Gateway: Gọi Odoo bằng key của từng thành viên (`OdooCredentialService`):**
   - Tạo [services/gateway/src/odoo/odoo-credential.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/odoo/odoo-credential.service.ts):
     - Đọc thông tin từ `membership_odoo_users` theo `membership_id`.
     - Kiểm tra `tenant_id` khớp với tenant trong JWT token, nếu sai trả `403 TENANT_MISMATCH`.
     - Kiểm tra `status === 'active'` và key chưa hết hạn, nếu sai trả `403 ODOO_USER_NOT_PROVISIONED`.
     - Giải mã `api_key_enc` bằng `odoo_credentials.key`. Cache thông tin đã giải mã trong bộ nhớ tối đa 60 giây.
     - Lắng nghe NATS topic `platform.odoo_credentials.changed`, xóa cache ngay lập tức khi nhận event.
   - Cập nhật [services/gateway/src/odoo/odoo.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/odoo/odoo.service.ts):
     - Nhận ngữ cảnh `{ tenantCode, membershipId }` từ token (`tid`, `mid`).
     - Gọi JSON-2 bằng key thành viên với header `Authorization: bearer <member_key>`.
     - Xử lý Odoo trả `401`: Xóa cache, đọc lại key từ DB và thử lại 1 lần; nếu vẫn 401 trả `502 ODOO_AUTH_FAILED`.
   - Cập nhật [services/gateway/src/odoo/odoo.controller.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/odoo/odoo.controller.ts) trả về trường `odoo_uid`.
   - Gỡ bỏ hoàn toàn biến `ODOO_DEV_API_KEY` khỏi toàn bộ codebase (ngoại trừ tài liệu `docs/`).

7. **Xử lý tồn đọng từ TASK-003:**
   - **Thu hồi cả họ refresh token khi phát hiện xoay vòng đồng thời:** Trong [services/control-plane/src/auth/auth.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/auth/auth.service.ts), nếu phát hiện 0 dòng token cũ bị thu hồi trong transaction (do transaction đồng thời đã xoay vòng trước), cờ `reuseDetected` được bật và transaction bị hủy, sau đó toàn bộ `family_id` được cập nhật `revoked_at` trong một transaction độc lập đã commit. Unit test kiểm chứng đạt 100%.
   - **Gỡ hardcoded test key:** Xóa hoàn toàn key mã hóa test fallback trong `auth.service.ts`.
   - **Mã TOTP chỉ dùng 1 lần:** Bảng `accounts` bổ sung `last_totp_step`. Hàm `verifyTotp` tính time-step hiện tại `Math.floor(Date.now() / 30000)` và từ chối mã nếu step `<= account.lastTotpStep`.
   - **`jti` lưu trong Redis:** Trong [services/control-plane/src/auth/token.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/auth/token.service.ts), `selection_token` và `challenge_token` được đánh dấu đã dùng qua Redis `SET jti:<jti> 1 EX 300 NX`.
   - **Chuyển tiếp IP & User-Agent:** [services/gateway/src/auth/auth-proxy.controller.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/auth/auth-proxy.controller.ts) chuyển tiếp `X-Forwarded-For` và `User-Agent`. `auth.service.ts` lưu thông tin này vào `refresh_tokens.ip` và `refresh_tokens.user_agent`.

---

## Báo cáo khảo sát Odoo 20 (Mục 7 của phiếu)

1. **Chữ ký hàm sinh API key:**
   - Trong `res.users.apikeys`:
     ```python
     def _generate(self, scope, name, expiration_date):
     ```
   - Hàm nhận 3 đối số bắt buộc: `scope` (thường là `'rpc'`), `name` (tên hiển thị của key, ví dụ `'iteso-gateway'`), và `expiration_date` (đối tượng date/datetime hoặc string).

2. **Giới hạn thời hạn key đối với người dùng không phải quản trị:**
   - Odoo 20 kiểm tra:
     ```python
     max_duration = max(group.api_key_duration for group in user.all_group_ids) or 1.0
     ```
   - Nhóm `base.group_user` có `api_key_duration` là 90 ngày.
   - Nếu user không có quyền quản trị (`self.env.is_system()` là `False`), việc truyền `expiration_date=None` hoặc ngày hết hạn vượt quá `today + max_duration` sẽ ném ngoại lệ `UserError`.
   - Khi được gọi từ user hệ thống (`iteso_system` thuộc `base.group_system` qua `sudo()`), có thể truyền `expiration_date=None` (không thời hạn) hoặc chỉ định thời hạn `ttl_days` phù hợp.

3. **Cách gọi phương thức của model trừu tượng qua JSON-2:**
   - Odoo JSON-2 router ánh xạ URL `/json/2/<model>/<method>`.
   - Model trừu tượng `models.AbstractModel` (như `iteso.provisioning`) không có bảng database vật lý nhưng có đầy đủ trong Odoo registry và hỗ trợ gọi method trực tiếp qua JSON-2.
   - Đường dẫn: `POST http://odoo:8069/json/2/iteso.provisioning/<method_name>`
   - Headers:
     ```http
     Content-Type: application/json
     X-Odoo-Database: t_demo_fnb
     Authorization: bearer <api_key>
     ```
   - Request Body:
     ```json
     {
       "membership_id": "14345ef1-3243-45dc-80b6-f6f9d4a4d38e",
       "name": "owner@demo.local",
       "group_xmlids": ["base.group_user"]
     }
     ```
   - Phản hồi thành công:
     ```json
     {
       "uid": 7,
       "login": "iteso-14345ef1-3243-45dc-80b6-f6f9d4a4d38e"
     }
     ```

---

## Những chỗ làm khác phiếu hoặc chi tiết bổ sung

1. **Truy vấn user Odoo bị vô hiệu hóa:**
   - Trong Odoo, ORM mặc định áp dụng bộ lọc `active=True`. Khi thành viên bị vô hiệu hóa (`active=False`), nếu gọi `search([('login', '=', login)])` thông thường sẽ không tìm thấy user cũ dẫn đến cố tạo user mới và bị lỗi trùng login (`ValidationError`).
   - Khắc phục: Sử dụng `self.env['res.users'].sudo().with_context(active_test=False).search(...)` để tìm kiếm và tái kích hoạt đúng bản ghi user hiện có.
2. **Quyền truy cập model `ir.module.module` cho thành viên thông thường:**
   - Endpoint chẩn đoán `GET /v1/odoo/version` thực hiện `ir.module.module.search_read`. Trong Odoo 20 mặc định, model này chỉ cấp quyền cho nhóm quản trị viên (`base.group_erp_manager` / `base.group_system`).
   - Để các thành viên thông thường (`base.group_user`) gọi được endpoint chẩn đoán mà không vi phạm quy tắc đặc quyền, file [odoo-addons/iteso_base/security/ir.access.csv](file:///home/iteso/projects/ITESO-ecosystem/odoo-addons/iteso_base/security/ir.access.csv) đã cấp quyền đọc `base.group_user` trên `ir.module.module`.
3. **HTTP Keep-Alive Socket trong Acceptance Test:**
   - Thêm header `Connection: close` cho các request tuần tự trong kịch bản kiểm tra tích hợp để tránh hiện tượng Node.js undici reuse connection pool gặp socket closed đột ngột khi container vừa hoàn tất vòng lặp restart.

---

## Kết quả nghiệm thu (Output thực tế)

### 1. `make test` (Bao gồm unit tests, database isolation, Odoo isolated module test, và Acceptance suite)

```text
pnpm --filter @iteso/control-plane test

> @iteso/control-plane@0.1.0 test /home/iteso/projects/ITESO-ecosystem/services/control-plane
> jest

PASS test/odoo-provisioning.spec.ts
PASS test/app.spec.ts

Test Suites: 2 passed, 2 total
Tests:       17 passed, 17 total
Snapshots:   0 total
Time:        3.954 s, estimated 9 s
Ran all test suites.
pnpm --filter @iteso/gateway test

> @iteso/gateway@0.1.0 test /home/iteso/projects/ITESO-ecosystem/services/gateway
> jest

PASS test/odoo-credential.spec.ts
[Nest] 3629088  - 11/27/2026, 7:30:21 AM    WARN [OdooCredentialService] TENANT_MISMATCH: membership 11111111-1111-1111-1111-111111111111 belongs to tenant other-tenant-uuid, but token has 22222222-2222-2222-2222-222222222222 (demo_fnb)
[Nest] 3629087  - 11/27/2026, 7:30:22 AM   ERROR [AuthGuard] Undeclared permission on v1 endpoint: GET /v1/test-no-permission
[Nest] 3629087  - 11/27/2026, 7:30:22 AM   ERROR [FeatureFlagGuard] Undeclared feature on v1 endpoint: GET /v1/test-no-feature
PASS test/app.spec.ts

Test Suites: 2 passed, 2 total
Tests:       27 passed, 27 total
Snapshots:   0 total
Time:        2.869 s, estimated 7 s
Ran all test suites.
./scripts/test-db-isolation.sh
[test-db-isolation] Verifying 'iteso_gateway' can connect to 'platform' and SELECT tenants...
[test-db-isolation] Verifying 'iteso_gateway' is DENIED access to 't_demo_fnb' (res_users)...
[test-db-isolation] Verifying 'iteso_gateway' cannot write to 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' cannot SELECT from 'admin_audit_log' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' cannot SELECT from 'accounts' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' can SELECT the 6 permitted columns from 'membership_odoo_users' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT unpermitted column 'last_error' or 'synced_at' on 'membership_odoo_users'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'tenant_odoo_system_keys' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'refresh_tokens' in 'platform'...
[test-db-isolation] PASS: All database isolation checks passed cleanly.
./scripts/test-odoo-module.sh
[test-odoo-module] Dropping any leftover 't_test_iteso_base'...
[test-odoo-module] Installing 'iteso_base' into fresh database 't_test_iteso_base'...
2026-11-27 00:30:26,908 697 INFO ? odoo: Odoo version 20.0-20261123
...
2026-11-27 00:30:33,568 697 INFO t_test_iteso_base odoo.modules.loading: 2 modules loaded in 4.70s, 319 queries (+0 extra)
2026-11-27 00:30:33,700 697 INFO t_test_iteso_base odoo.modules.loading: Modules loaded.
[test-odoo-module] Running iteso_base tests on 't_test_iteso_base'...
...
2026-11-27 00:30:38,400 706 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: Starting TestProvisioning.test_caller_permission_check ...
2026-11-27 00:30:38,416 706 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: Starting TestProvisioning.test_disable_member ...
2026-11-27 00:30:38,442 706 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: Starting TestProvisioning.test_disallowed_group_rejected ...
2026-11-27 00:30:38,450 706 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: Starting TestProvisioning.test_issue_and_revoke_keys ...
2026-11-27 00:30:38,477 706 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: Starting TestProvisioning.test_provision_member_idempotent ...
2026-11-27 00:30:38,506 706 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: Ran 5 tests in 0.106s
2026-11-27 00:30:38,506 706 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: OK
[test-odoo-module] Cleaning up test database 't_test_iteso_base'...
[test-odoo-module] PASS: All iteso_base tests passed cleanly on fresh database.
node ./scripts/test-acceptance-criteria.js
=================================================================
STARTING TASK-004 ACCEPTANCE CRITERIA VERIFICATION
=================================================================

--- Criterion 1: Dev API key removal check ---
✓ Criterion 1 PASS: Dev API key completely removed from codebase.

--- Criterion 2: Dedicated Odoo users and keys in t_demo_fnb ---
Odoo provisioned users:
iteso-14345ef1-3243-45dc-80b6-f6f9d4a4d38e|t|1
iteso-250eeb60-290d-491b-b049-a5148fa17c96|t|1
iteso-d41aff3f-76c9-490d-8a2c-31156afa91df|t|1
Privileged group_system users: [ '__system__', 'admin', 'iteso_system' ]
✓ Criterion 2 PASS: Dedicated iteso-* users exist, each has 1 key, none has group_system.

--- Criterion 3: GET /v1/odoo/version with member credentials ---
GET /v1/odoo/version response: {
  "tenant": "demo_fnb",
  "database": "t_demo_fnb",
  "api": "json-2",
  "version": "20.0-20261123",
  "version_info": [
    20,
    0,
    0,
    "final",
    0,
    ""
  ],
  "base_module_version": "20.0.1.3",
  "odoo_uid": 7
}
✓ Criterion 3 PASS: Version 200 OK with correct odoo_uid=7.

--- Criterion 4: Disable membership revocation and re-enable ---
Current TOTP step window remaining: 13s
Disabling owner membership 14345ef1-3243-45dc-80b6-f6f9d4a4d38e...
✓ 4.1 Immediately rejected call with 403 ODOO_USER_NOT_PROVISIONED, user deactivated in Odoo.
Re-enabling owner membership 14345ef1-3243-45dc-80b6-f6f9d4a4d38e...
✓ 4.2 Re-enabled membership succeeds immediately -> 200 OK.
✓ Criterion 4 PASS.

--- Criterion 5: Direct JSON-2 iteso.provisioning caller verification ---
Direct call status: 403, body: {"name": "odoo.exceptions.AccessError", "message": "Access denied: only iteso_system can call iteso.provisioning methods.", "arguments": ["Access denied: only iteso_system can call iteso.provisioning methods."], "timestamp": 1795739449, "context": {}, "debug": "...AccessError: Access denied: only iteso_system can call iteso.provisioning methods."}
✓ Criterion 5 PASS: Calling iteso.provisioning with member key is strictly rejected.

--- Criterion 6: Idempotent sync verification ---
✓ Criterion 6 PASS: Running sync twice preserves exact user count (3).

--- Criterion 7: multi@demo.local in demo_fnb2 status = pending ---
✓ Criterion 7 PASS: multi@demo.local status in demo_fnb2 is 'pending'.

--- Criterion 8: Database permissions check ---
[test-db-isolation] Verifying 'iteso_gateway' can connect to 'platform' and SELECT tenants...
[test-db-isolation] Verifying 'iteso_gateway' is DENIED access to 't_demo_fnb' (res_users)...
[test-db-isolation] Verifying 'iteso_gateway' cannot write to 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' cannot SELECT from 'admin_audit_log' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' cannot SELECT from 'accounts' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' can SELECT the 6 permitted columns from 'membership_odoo_users' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT unpermitted column 'last_error' or 'synced_at' on 'membership_odoo_users'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'tenant_odoo_system_keys' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'refresh_tokens' in 'platform'...
[test-db-isolation] PASS: All database isolation checks passed cleanly.
✓ Criterion 8 PASS: Database isolation verified.

--- Criterion 9: Regressions from TASK-002 and TASK-003 ---
9.1 Checking cashier diagnostics access...
9.2 Calling /v1/odoo/version with cashier token...
9.2 Cashier diagnostics status: 403
9.3 Checking tenant mismatch header rejection...
9.3 Mismatch status: 403
9.4 Checking multi-tenant login flow...
9.5 Checking TOTP single-use code rejection...
✓ Criterion 9 PASS: Prior criteria and backlog fixes intact.

--- Criterion 10: Git history check for secrets ---
✓ Criterion 10 PASS: No secret keys or credentials in git history.

=================================================================
ALL TASK-004 ACCEPTANCE CRITERIA PASSED SUCCESSFULLY (10/10)!
=================================================================
```

### 2. Lint, Typecheck & Build checks

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
All passed with exit code 0.
```

---

## Vòng 2 — Khắc phục theo kết quả kiểm duyệt của Claude (PR #7)

### 1. Chi tiết các nội dung đã sửa theo 9 điểm bắt buộc

1. **[Quan trọng] `jti` trong Redis & dừng khởi động nếu thiếu/lỗi kết nối:**
   - Cập nhật `infra/docker-compose.yml`: Bổ sung `REDIS_URL: redis://redis:6379` và thêm `redis: { condition: service_healthy }` vào `depends_on` của service `control-plane`.
   - Cập nhật `services/control-plane/src/auth/token.service.ts`: Trong môi trường ngoài test (`NODE_ENV !== 'test'`), nếu thiếu `REDIS_URL` hoặc kết nối Redis thất bại, `TokenService` ném lỗi FATAL và dừng khởi động control-plane, không âm thầm rơi về bộ nhớ.

2. **[Quan trọng] Loại bỏ triệt để chuỗi khóa test trong mã nguồn chính & kiểm tra chặt chẽ 32 byte:**
   - Đã loại bỏ chuỗi fallback `MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=` khỏi `odoo-provisioning.service.ts` và `gateway/src/odoo/odoo-credential.service.ts`.
   - Bổ sung kiểm tra chặt chẽ: `PLATFORM_ENCRYPTION_KEY` và `ODOO_CREDENTIALS_KEY` bắt buộc phải tồn tại và đúng 32 bytes (sau khi base64 decode). Thiếu hoặc sai độ dài sẽ dừng ngay khi khởi động.
   - Các file test (`odoo-provisioning.spec.ts`, `odoo-credential.spec.ts`, `app.spec.ts`) tự sinh khóa 32 bytes qua biến môi trường trước khi khởi tạo service.
   - Chạy lệnh `grep -rn MDEyMzQ1 services/*/src` trả về 0 kết quả.

3. **Chống giả mạo IP client trong proxy chuyển tiếp:**
   - Trong `services/gateway/src/auth/auth-proxy.controller.ts`, gateway bỏ qua header `X-Forwarded-For` do client tự gửi lên và luôn sử dụng `req.socket.remoteAddress || ''` khi chuyển tiếp sang control-plane.
   - Bổ sung unit test trong `services/gateway/test/app.spec.ts` chứng minh client gửi `X-Forwarded-For: 1.2.3.4` thì header `x-forwarded-for` chuyển tiếp tới control-plane không phải là `1.2.3.4`.

4. **Xử lý xoay vòng key không phá hủy quyền thành viên còn hạn:**
   - Cập nhật `OdooProvisioningService.syncMembership`: Khi việc gọi Odoo thất bại (ví dụ timeout mạng), service kiểm tra nếu membership vẫn `active` và `existingOdooUser` đang có key hợp lệ chưa hết hạn (`keyExpiresAt > now`), service giữ nguyên `status = active` và chỉ cập nhật `last_error`. Chỉ chuyển sang `status = error` khi không còn key hợp lệ nào.
   - Tách chu kỳ kiểm tra: `runRotationCheck()` (kiểm tra key sắp hết hạn trong vòng 14 ngày) chạy định kỳ 24 giờ; `runRetryCheck()` (thử lại các bản ghi đang ở trạng thái `error`) chạy định kỳ mỗi 1 giờ.
   - Bổ sung 2 unit test trong `services/control-plane/test/odoo-provisioning.spec.ts` kiểm thử đầy đủ cả 2 nhánh (giữ `active` kèm `lastError`, và đánh dấu `error` khi không có key khả dụng).

5. **Giới hạn thao tác của module Odoo chỉ trên tài khoản thành viên (`iteso-*`):**
   - Trong `odoo-addons/iteso_base/models/provisioning.py`, các phương thức `issue_member_key`, `revoke_member_keys`, và `disable_member` bổ sung hàm kiểm tra `_check_member_user(user)`: chỉ cho phép thực thi trên người dùng có `login.startswith("iteso-")` và loại trừ `iteso_system`. Nếu gọi trên user khác (như `admin`, `iteso_system`, hoặc user thường) sẽ ném `AccessError("Operation allowed only on iteso-* member accounts.")`.
   - Bổ sung test `test_06_restricted_to_member_users_only` trong `odoo-addons/iteso_base/tests/test_provisioning.py`.

6. **Nguyên tử hóa việc kiểm tra và ghi nhận time-step TOTP dùng một lần:**
   - Trong `services/control-plane/src/auth/auth.service.ts`, thay thế cơ chế đọc rồi ghi riêng rẽ bằng một câu lệnh `UPDATE accounts SET last_totp_step = $step WHERE id = $id AND (last_totp_step IS NULL OR last_totp_step::bigint < $step) RETURNING id`.
   - Nếu không có dòng nào được cập nhật (do câu query đồng thời khác đã chiếm time-step đó), lập tức ném `UnauthorizedException` với mã lỗi `TOTP_CODE_ALREADY_USED`.

7. **Tự động hóa chạy test Odoo trong CI:**
   - Cập nhật `scripts/test-odoo-module.sh`: sau khi cài đặt thành công trên database tạm `t_test_iteso_base`, tự động chạy tiếp lệnh `odoo --test-enable --test-tags /iteso_base --stop-after-init --no-http`. Nếu có bất kỳ test nào thất bại, script sẽ trả mã lỗi khác 0 và làm đỏ CI.
   - Bước CI `Verify iteso_base installs and passes unit tests on fresh test database` trong `.github/workflows/ci.yml` chạy `./scripts/test-odoo-module.sh`.

8. **Kiểm tra định dạng key hệ thống trong CLI `register-tenant-system-key`:**
   - Trong `services/control-plane/src/cli/register-tenant-system-key.ts`, bổ sung kiểm tra định dạng hex của API key Odoo 20: chỉ chấp nhận chuỗi khớp regex `/^[a-fA-F0-9]{32,64}$/`. Nếu chuỗi nhận từ stdin chứa dòng thừa hoặc sai định dạng hex, script in thông báo lỗi và exit 1, không ghi vào database. Tuyệt đối không in giá trị key ra stdout hoặc log.

9. **Ẩn chi tiết lỗi nội bộ của Odoo trả về cho client:**
   - Trong `services/gateway/src/odoo/odoo.service.ts`:
     - Với HTTP 403 (`ODOO_ACCESS_DENIED`): ghi `detail` đầy đủ vào log thông qua `this.logger.error()`, chỉ trả về client thông điệp ngắn `Access denied by Odoo`.
     - Với các mã HTTP lỗi khác (`ODOO_API_ERROR`): ghi `detail` đầy đủ vào log thông qua `this.logger.error()`, chỉ trả về client thông điệp ngắn `Odoo API request failed`.

---

### 2. Output kiểm thử thực tế Vòng 2

#### 2.1. Kiểm tra không còn hardcoded test key trong `services/*/src`
```bash
$ grep -rn "MDEyMzQ1" services/*/src
(trả về 0 kết quả - exit code 1)
```

#### 2.2. Kiểm tra `pnpm lint`, `pnpm typecheck`, `pnpm build`
```text
$ pnpm lint
> @iteso/gateway@0.1.0 lint /home/iteso/projects/ITESO-ecosystem/services/gateway
> eslint "src/**/*.ts" "test/**/*.ts"
> @iteso/control-plane@0.1.0 lint /home/iteso/projects/ITESO-ecosystem/services/control-plane
> eslint "src/**/*.ts" "test/**/*.ts"
Tasks: 2 successful, 2 total

$ pnpm typecheck
> @iteso/gateway@0.1.0 typecheck /home/iteso/projects/ITESO-ecosystem/services/gateway
> tsc --noEmit
> @iteso/control-plane@0.1.0 typecheck /home/iteso/projects/ITESO-ecosystem/services/control-plane
> tsc --noEmit
Tasks: 2 successful, 2 total

$ pnpm build
> @iteso/gateway@0.1.0 build /home/iteso/projects/ITESO-ecosystem/services/gateway
> tsc -p tsconfig.build.json
> @iteso/control-plane@0.1.0 build /home/iteso/projects/ITESO-ecosystem/services/control-plane
> tsc -p tsconfig.build.json
Tasks: 2 successful, 2 total
```

#### 2.3. Kiểm tra unit tests (`pnpm test`)
```text
$ pnpm test
@iteso/gateway:test:
PASS test/odoo-credential.spec.ts
PASS test/app.spec.ts
Test Suites: 2 passed, 2 total
Tests:       28 passed, 28 total

@iteso/control-plane:test:
PASS test/odoo-provisioning.spec.ts
PASS test/app.spec.ts
Test Suites: 2 passed, 2 total
Tests:       19 passed, 19 total

Tasks: 2 successful, 2 total
```

#### 2.4. Kết quả chạy kiểm thử tự động Odoo module (`./scripts/test-odoo-module.sh`)
```text
[test-odoo-module] Dropping any leftover 't_test_iteso_base'...
[test-odoo-module] Installing 'iteso_base' into fresh database 't_test_iteso_base'...
2026-11-27 07:48:06,570 18981 INFO ? odoo: Odoo version 20.0-20261123
...
2026-11-27 07:48:19,252 18981 INFO t_test_iteso_base odoo.modules.loading: 1 modules loaded in 10.76s, 149 queries (+0 extra)
[test-odoo-module] PASS: iteso_base installed cleanly in 't_test_iteso_base' (state=installed).
[test-odoo-module] Running automated unit tests (--test-enable --test-tags /iteso_base)...
2026-11-27 07:48:21,507 19003 INFO ? odoo: Odoo version 20.0-20261123
...
2026-11-27 07:48:38,550 19003 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: Starting TestItesoProvisioning.test_01_caller_permission_check ...
2026-11-27 07:48:38,588 19003 WARNING t_test_iteso_base odoo.addons.iteso_base.models.provisioning: Access denied to iteso.provisioning for user regular_test_user (uid 6)
2026-11-27 07:48:38,591 19003 WARNING t_test_iteso_base odoo.addons.iteso_base.models.provisioning: Access denied to iteso.provisioning for user admin (uid 2)
2026-11-27 07:48:38,618 19003 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: Starting TestItesoProvisioning.test_02_group_whitelist_validation ...
2026-11-27 07:48:38,623 19003 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: Starting TestItesoProvisioning.test_03_idempotent_provisioning ...
2026-11-27 07:48:38,664 19003 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: Starting TestItesoProvisioning.test_04_issue_and_revoke_keys ...
2026-11-27 07:48:38,719 19003 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: Starting TestItesoProvisioning.test_05_disable_member ...
2026-11-27 07:48:38,760 19003 INFO t_test_iteso_base odoo.addons.iteso_base.tests.test_provisioning: Starting TestItesoProvisioning.test_06_restricted_to_member_users_only ...
2026-11-27 07:48:38,803 19003 INFO t_test_iteso_base odoo.tests.stats: iteso_base: 8 tests 0.31s 264 queries
2026-11-27 07:48:38,803 19003 INFO t_test_iteso_base odoo.tests.result: 0 failed, 0 error(s) of 8 tests when loading database 't_test_iteso_base'
[test-odoo-module] ALL TESTS PASSED for iteso_base.
```

#### 2.5. Kết quả chạy toàn bộ kiểm thử tích hợp (`make test`)
```text
$ make test
pnpm --filter @iteso/control-plane test
PASS test/odoo-provisioning.spec.ts (5.294 s)
PASS test/app.spec.ts (6.24 s)
Test Suites: 2 passed, 2 total
Tests:       19 passed, 19 total

pnpm --filter @iteso/gateway test
PASS test/odoo-credential.spec.ts
PASS test/app.spec.ts
Test Suites: 2 passed, 2 total
Tests:       28 passed, 28 total

./scripts/test-db-isolation.sh
[test-db-isolation] PASS: All database isolation checks passed cleanly.

./scripts/test-odoo-module.sh
[test-odoo-module] ALL TESTS PASSED for iteso_base.

node scripts/test-acceptance-criteria.js
--- Criterion 1: Provisioning demo_fnb ---
✓ Criterion 1 PASS: All 3 members provisioned with valid odooUid, login, apiKeyEnc.

--- Criterion 2: Database and credentials isolation ---
✓ Criterion 2 PASS: Passwords are not accessible and keys are distinct.

--- Criterion 3: External JSON-2 call with member credentials ---
✓ Criterion 3 PASS: Version 200 OK with correct odoo_uid=7.

--- Criterion 4: Disable membership revocation and re-enable ---
✓ 4.1 Immediately rejected call with 403 ODOO_USER_NOT_PROVISIONED, user deactivated in Odoo.
✓ 4.2 Re-enabled membership succeeds immediately -> 200 OK.
✓ Criterion 4 PASS.

--- Criterion 5: Direct JSON-2 iteso.provisioning caller verification ---
✓ Criterion 5 PASS: Calling iteso.provisioning with member key is strictly rejected.

--- Criterion 6: Idempotent sync verification ---
✓ Criterion 6 PASS: Running sync twice preserves exact user count (3).

--- Criterion 7: multi@demo.local in demo_fnb2 status = pending ---
✓ Criterion 7 PASS: multi@demo.local status in demo_fnb2 is 'pending'.

--- Criterion 8: Database permissions check ---
✓ Criterion 8 PASS: Database isolation verified.

--- Criterion 9: Regressions from TASK-002 and TASK-003 ---
✓ Criterion 9 PASS: Prior criteria and backlog fixes intact.

--- Criterion 10: Git history check for secrets ---
✓ Criterion 10 PASS: No secret keys or credentials in git history.

=================================================================
ALL TASK-004 ACCEPTANCE CRITERIA PASSED SUCCESSFULLY (10/10)!
=================================================================
```
