# Báo cáo TASK-002

## Đã làm

1. **Database & Role (`platform` & `iteso_control_plane`):**
   - Mở rộng [scripts/init-db-roles.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/init-db-roles.sh) (chạy lại được nhiều lần, idempotent):
     - Tạo role `iteso_control_plane` (`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`).
     - Tạo database `platform`, chủ sở hữu là `iteso_control_plane`.
     - `REVOKE CONNECT ON DATABASE platform FROM PUBLIC`.
     - Cấp `CONNECT` trên `platform` cho `iteso_control_plane` và `iteso_gateway`.
     - Cấp quyền `SELECT` cho `iteso_gateway` trên 3 bảng `tenants`, `feature_definitions`, `tenant_features`; không cấp quyền ghi và cấm truy cập `admin_audit_log`.
   - Cập nhật [.env.example](file:///home/iteso/projects/ITESO-ecosystem/.env.example) thêm các biến: `POSTGRES_CONTROL_PLANE_USER`, `POSTGRES_CONTROL_PLANE_PASSWORD`, `PLATFORM_DB`, `CONTROL_PLANE_PORT`, `CONTROL_PLANE_ADMIN_TOKEN`.

2. **Tách script bảo mật database tenant:**
   - Tạo [scripts/lib/secure-tenant-db.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/lib/secure-tenant-db.sh) thu hồi `CONNECT` từ `PUBLIC` và `iteso_gateway` trên database tenant chỉ định.
   - [scripts/init-demo-tenant.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/init-demo-tenant.sh) và [scripts/test-odoo-module.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/test-odoo-module.sh) gọi chung script này.
   - Sửa [scripts/test-db-isolation.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/test-db-isolation.sh): kiểm tra output từ chối kết nối tenant DB chứa `permission denied`, đồng thời kiểm tra `iteso_gateway` bị từ chối khi ghi vào `platform` và từ chối khi đọc `admin_audit_log`.

3. **Dịch vụ `services/control-plane` (NestJS, TypeScript, Drizzle ORM + drizzle-kit):**
   - Kết nối database `platform` bằng role `iteso_control_plane`.
   - Migration Drizzle tạo 4 bảng: `tenants`, `feature_definitions`, `tenant_features`, `admin_audit_log`.
   - Seed idempotent:
     - Tenant `demo_fnb` (`t_demo_fnb`, `active`, ngành `fnb`).
     - Các khóa theo ADR-004 với trạng thái `not_implemented`: `fnb.pos`, `fnb.qr_order`, `fnb.kds`, `fnb.reservation`, `einvoice.viettel`, `inventory.recipe`, `hotel.pms`, `platform.tenant_create`, `platform.self_signup`, `platform.billing`, `ai.assistant`.
     - Các khóa `available`: `system.odoo_version`, `system.features`.
   - API quản trị (cổng `3100`, chỉ `127.0.0.1`, bảo vệ bằng `AdminAuthGuard` kiểm tra `X-Admin-Token`):
     - `GET /admin/tenants`
     - `GET /admin/features`
     - `GET /admin/tenants/:code/features`
     - `PUT /admin/features/:key/platform`
     - `PUT /admin/tenants/:code/features/:key`
   - Bật tính năng `not_implemented` trả `409 FEATURE_NOT_IMPLEMENTED`.
   - Mọi thay đổi ghi `admin_audit_log` trong transaction và phát sự kiện NATS `platform.features.changed` (`{ "tenant": code|null, "key": key }`).
   - `GET /health` kiểm tra database `platform` và NATS.

4. **Gateway:**
   - Đọc bảng `tenants` (chỉ `status = active`) trong database `platform` để xác định database thay vì dò `pg_database`.
   - Đánh giá cờ tính năng: `implementationStatus == 'available'` && `platformEnabled` && (tenant override hoặc default).
   - Cache trong bộ nhớ 30 giây; lắng nghe sự kiện NATS `platform.features.changed` qua `GatewayNatsListener` để xóa cache ngay lập tức.
   - Decorator `@RequireFeature('<key>')` và Guard `FeatureFlagGuard` trên toàn bộ endpoint `/v1`. Endpoint thiếu decorator bị chặn `403 FEATURE_UNDECLARED`.
   - Endpoint `GET /v1/odoo/version` gắn cờ `system.odoo_version`.
   - Endpoint `GET /v1/features` gắn cờ `system.features` trả danh sách tính năng đang bật của tenant.

5. **Docker Compose, Makefile & CI:**
   - Thêm container `control-plane` (cổng `127.0.0.1:3100`) vào [infra/docker-compose.yml](file:///home/iteso/projects/ITESO-ecosystem/infra/docker-compose.yml).
   - `Makefile` tích hợp khởi tạo role, chạy `pnpm db:migrate` và `pnpm db:seed`, `make test` chạy cả control-plane test, gateway test, db isolation test và odoo module test.
   - [.github/workflows/ci.yml](file:///home/iteso/projects/ITESO-ecosystem/.github/workflows/ci.yml) kiểm tra lint, typecheck, test, build cho cả 2 service và tích hợp kịch bản kiểm thử bật/tắt cờ tự động trong CI.

---

## Lệnh chạy và kết quả (dán output thật)

### 1. `make reset` & `make ps`
```text
docker compose --env-file .env -f infra/docker-compose.yml ps
NAME                              IMAGE                           COMMAND                  SERVICE         CREATED          STATUS                        PORTS
iteso-ecosystem-control-plane-1   iteso-ecosystem-control-plane   "docker-entrypoint.s…"   control-plane   52 seconds ago   Up 50 seconds (healthy)       127.0.0.1:3100->3100/tcp
iteso-ecosystem-gateway-1         iteso-ecosystem-gateway         "docker-entrypoint.s…"   gateway         52 seconds ago   Up 45 seconds (healthy)       127.0.0.1:3000->3000/tcp
iteso-ecosystem-nats-1            nats:2.15.3                     "/nats-server -m 8222"   nats            52 seconds ago   Up 51 seconds                 4222/tcp, 6222/tcp, 8222/tcp
iteso-ecosystem-odoo-1            odoo:20.0-20261123              "/bin/sh /etc/odoo/s…"   odoo            52 seconds ago   Up 51 seconds (healthy)       127.0.0.1:8069->8069/tcp, 8071-8072/tcp
iteso-ecosystem-postgres-1        postgres:16.16-alpine           "docker-entrypoint.s…"   postgres        2 minutes ago    Up About a minute (healthy)   127.0.0.1:5432->5432/tcp
iteso-ecosystem-redis-1           redis:7.4.12-alpine             "docker-entrypoint.s…"   redis           52 seconds ago   Up 51 seconds (healthy)       6379/tcp
```

### 2. `make test`
```text
pnpm --filter @iteso/control-plane test
PASS test/app.spec.ts
  Control Plane Endpoints (TASK-002)
    Admin Auth Guard
      ✓ returns 401 when X-Admin-Token header is missing (171 ms)
      ✓ returns 401 when X-Admin-Token header is invalid (12 ms)
      ✓ allows access when valid token is provided (9 ms)
    Feature Flag Management
      ✓ returns 409 when trying to enable a not_implemented feature on platform level (19 ms)
      ✓ returns 409 when trying to enable a not_implemented feature for a tenant (8 ms)
      ✓ returns 200 and updates available feature (7 ms)
    GET /health
      ✓ returns 200 when database and nats are healthy (9 ms)

Test Suites: 1 passed, 1 total
Tests:       7 passed, 7 total

pnpm --filter @iteso/gateway test
PASS test/app.spec.ts
  Gateway endpoints (TASK-002)
    GET /health
      ✓ returns 200 and ok for all 5 components without needing @RequireFeature (170 ms)
    Feature Flag Evaluation Matrix
      ✓ allows access when feature is available, platform enabled, and enabled for tenant (22 ms)
      ✓ returns 403 FEATURE_DISABLED when feature is disabled at platform level (12 ms)
      ✓ returns 403 FEATURE_DISABLED when feature is disabled for tenant (11 ms)
      ✓ returns 403 FEATURE_DISABLED when feature is not_implemented (12 ms)
      ✓ returns 404 TENANT_NOT_FOUND when tenant is suspended (12 ms)
      ✓ returns 404 TENANT_NOT_FOUND when tenant does not exist or header is missing (13 ms)
      ✓ returns 403 FEATURE_UNDECLARED when endpoint under /v1 does not declare @RequireFeature (12 ms)
      ✓ clears cache when clearCache is called (7 ms)
    GET /v1/features
      ✓ returns enabled features list for tenant (10 ms)

Test Suites: 1 passed, 1 total
Tests:       10 passed, 10 total

./scripts/test-db-isolation.sh
[test-db-isolation] Verifying 'iteso_gateway' can connect to 'platform' and SELECT tenants...
[test-db-isolation] Verifying 'iteso_gateway' is DENIED access to 't_demo_fnb' (res_users)...
[test-db-isolation] Verifying 'iteso_gateway' cannot write to 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' cannot SELECT from 'admin_audit_log' in 'platform'...
[test-db-isolation] PASS: All database isolation checks passed cleanly.

./scripts/test-odoo-module.sh
[test-odoo-module] PASS: iteso_base installed cleanly in 't_test_iteso_base' (state=installed).
```

### 3. Kịch bản nghiệm thu (Curls & Audit Log)

- **`GET /health` Gateway & Control Plane:**
```text
HTTP/1.1 200 OK
{"status":"ok","components":{"gateway":{"status":"ok"},"postgres":{"status":"ok"},"odoo":{"status":"ok"},"nats":{"status":"ok"},"redis":{"status":"ok"}}}

HTTP/1.1 200 OK
{"status":"ok","components":{"control_plane":{"status":"ok"},"database":{"status":"ok"},"nats":{"status":"ok"}}}
```

- **`GET /v1/odoo/version` (tenant `demo_fnb`):**
```text
HTTP/1.1 200 OK
{"tenant":"demo_fnb","database":"t_demo_fnb","api":"json-2","version":"20.0-20261123","version_info":[20,0,0,"final",0,""],"base_module_version":"20.0.1.3"}
```

- **`GET /v1/features` (tenant `demo_fnb`):**
```text
HTTP/1.1 200 OK
{"tenant":"demo_fnb","features":["system.odoo_version","system.features"]}
```

- **Gọi Admin API không có token (trả `401`):**
```text
HTTP/1.1 401 Unauthorized
{"error":"UNAUTHORIZED","message":"Invalid or missing admin token"}
```

- **Bật khóa `not_implemented` `fnb.pos` (trả `409`):**
```text
HTTP/1.1 409 Conflict
{"error":"FEATURE_NOT_IMPLEMENTED","message":"Feature 'fnb.pos' is not implemented and cannot be enabled"}
```

- **Kịch bản bật/tắt tính năng theo thời gian thực (NATS event cache invalidation):**
```text
# 1. Tắt system.odoo_version cho demo_fnb
PUT /admin/tenants/demo_fnb/features/system.odoo_version -> 200 OK
{"tenantId":"9230a2f5-4aec-43c8-ba42-ffc8f2e59421","featureKey":"system.odoo_version","enabled":false,"updatedBy":"super_admin","updatedAt":"2026-11-25T20:43:44.776Z","note":"Turn off for test scenario"}

# 2. Ngay lập tức gọi gateway (không phải chờ 30s) -> 403 FEATURE_DISABLED
GET /v1/odoo/version -> 403 Forbidden
{"error":"FEATURE_DISABLED","feature":"system.odoo_version"}

# 3. Bật lại system.odoo_version cho demo_fnb
PUT /admin/tenants/demo_fnb/features/system.odoo_version -> 200 OK
{"tenantId":"9230a2f5-4aec-43c8-ba42-ffc8f2e59421","featureKey":"system.odoo_version","enabled":true,"updatedBy":"super_admin","updatedAt":"2026-11-25T20:43:44.857Z","note":"Turn back on for test scenario"}

# 4. Ngay lập tức gọi gateway -> 200 OK
GET /v1/odoo/version -> 200 OK
{"tenant":"demo_fnb","database":"t_demo_fnb","api":"json-2","version":"20.0-20261123","version_info":[20,0,0,"final",0,""],"base_module_version":"20.0.1.3"}
```

- **`admin_audit_log` ghi nhận đúng 2 dòng thay đổi:**
```text
                  id                  |    actor    |        action         |  target_type   |          target_id           |              note              |          created_at           
--------------------------------------+-------------+-----------------------+----------------+------------------------------+--------------------------------+-------------------------------
 1150ff1b-9414-44a3-a5af-23d449841c39 | super_admin | UPDATE_TENANT_FEATURE | tenant_feature | demo_fnb:system.odoo_version | Turn off for test scenario     | 2026-11-25 20:43:44.775625+00
 df5132dc-8769-4688-9224-a20b56cfb203 | super_admin | UPDATE_TENANT_FEATURE | tenant_feature | demo_fnb:system.odoo_version | Turn back on for test scenario | 2026-11-25 20:43:44.85738+00
(2 rows)
```

---

## Chỗ làm khác phiếu và lý do

- Ban đầu (Vòng 1) có mở cổng `127.0.0.1:5432:5432` trên host và để `TestUndeclaredController` trong mã nguồn. Ở Vòng 2, theo review của Claude:
  - Đã đóng hoàn toàn cổng 5432 trên host, PostgreSQL chỉ lắng nghe nội bộ container. Mọi thao tác migrate và seed chạy trực tiếp thông qua container `control-plane`.
  - Đã xóa `TestUndeclaredController` khỏi mã nguồn gateway, chỉ định nghĩa cục bộ trong test suite `test/app.spec.ts`.

---

## Vấn đề còn tồn tại

- Không có vấn đề tồn đọng. Toàn bộ các tiêu chí nghiệm thu từ 1 đến 8 và 7 điểm review vòng 2 đều đạt đầy đủ.

---

## Vòng 2 (theo kiểm duyệt của Claude trên PR #3)

### 1. Tổng hợp 7 điểm đã khắc phục theo review của Claude

1. **Test controller trong mã nguồn production:**
   - Đã xóa file `services/gateway/src/features/test-undeclared.controller.ts`.
   - Đã xóa khỏi `controllers` của `services/gateway/src/app.module.ts`.
   - Chuyển toàn bộ định nghĩa controller test vào riêng `services/gateway/test/app.spec.ts` cho test suite.
2. **Migration và tracking schema:**
   - Dùng `pnpm drizzle-kit generate` sinh migration chuẩn có checksum và journal: `services/control-plane/drizzle/0000_smiling_human_torch.sql` và `services/control-plane/drizzle/meta/_journal.json`.
   - Viết lại `services/control-plane/src/db/migrate.ts` dùng hàm `migrate(db, { migrationsFolder })` từ `drizzle-orm/node-postgres/migrator`.
   - Tách phần cấp quyền `SELECT` cho `iteso_gateway` thành hàm `grantGatewayPermissions()`.
3. **Bảo mật cổng database và chạy migrate/seed trong container:**
   - Xóa bỏ `ports: 127.0.0.1:5432:5432` khỏi `infra/docker-compose.yml`. Database PostgreSQL chỉ nằm trong mạng nội bộ Docker.
   - Sửa `Makefile` chạy `docker compose run --rm control-plane node dist/db/migrate.js` và `dist/db/seed.js`.
   - Sửa `.github/workflows/ci.yml` tương tự.
   - Gỡ bỏ dependency `dotenv` khỏi `services/control-plane` và cập nhật `pnpm-lock.yaml`.
4. **Unit test sâu logic nghiệp vụ (không mock nông):**
   - `services/gateway/test/app.spec.ts`: Test logic thực tế của `PlatformService.isFeatureEnabled()` thông qua mock `pgPool.query`, kiểm thử toàn bộ 6 trường hợp của ma trận đánh giá cờ tính năng và 2 bài test cơ chế cache 30s + xóa cache qua NATS.
   - `services/control-plane/test/app.spec.ts`: Test logic thực tế của `ControlPlaneService.updatePlatformFeature()`: chặn `409 FEATURE_NOT_IMPLEMENTED` khi bật tính năng chưa hỗ trợ, tạo audit log trong transaction và phát sự kiện NATS `platform.features.changed`.
5. **Validation body của Admin API:**
   - Thêm hàm `validateFeatureBody()` vào `services/control-plane/src/control-plane/admin.controller.ts`: kiểm tra body là object, `enabled` bắt buộc phải là kiểu boolean thực thụ (từ chối string `"false"` với mã `400 BAD_REQUEST`), `note` là chuỗi tối đa 500 ký tự.
   - Bổ sung unit test trong `test/app.spec.ts`.
6. **Bảo vệ timing attack cho admin token:**
   - Sửa `services/control-plane/src/auth/admin-auth.guard.ts` sử dụng `crypto.timingSafeEqual()`. Nếu độ dài token không khớp, vẫn thực hiện so sánh đệm giả với thời gian hằng số để ngăn timing attack.
7. **CI xác thực số bản ghi audit log:**
   - Thêm bước kiểm tra trong `.github/workflows/ci.yml` sử dụng `psql` qua container postgres truy vấn `admin_audit_log` và assert số dòng bằng đúng 2.

---

### 2. Output kiểm thử thực tế Vòng 2

#### a. `make ps` (Xác nhận PostgreSQL không mở cổng host)
```text
docker compose --env-file .env -f infra/docker-compose.yml ps
NAME                              IMAGE                           COMMAND                  SERVICE         CREATED              STATUS                        PORTS
iteso-ecosystem-control-plane-1   iteso-ecosystem-control-plane   "docker-entrypoint.s…"   control-plane   About a minute ago   Up About a minute (healthy)   127.0.0.1:3100->3100/tcp
iteso-ecosystem-gateway-1         iteso-ecosystem-gateway         "docker-entrypoint.s…"   gateway         About a minute ago   Up 57 seconds (healthy)       127.0.0.1:3000->3000/tcp
iteso-ecosystem-nats-1            nats:2.15.3                     "/nats-server -m 8222"   nats            About a minute ago   Up About a minute             4222/tcp, 6222/tcp, 8222/tcp
iteso-ecosystem-odoo-1            odoo:20.0-20261123              "/bin/sh /etc/odoo/s…"   odoo            About a minute ago   Up About a minute (healthy)   127.0.0.1:8069->8069/tcp, 8071-8072/tcp
iteso-ecosystem-postgres-1        postgres:16.16-alpine           "docker-entrypoint.s…"   postgres        About a minute ago   Up About a minute (healthy)   5432/tcp
iteso-ecosystem-redis-1           redis:7.4.12-alpine             "docker-entrypoint.s…"   redis           About a minute ago   Up About a minute (healthy)   6379/tcp
```

#### b. `make test` (Toàn bộ 8 unit test Control Plane, 13 unit test Gateway, DB isolation test, Odoo module test)
```text
pnpm --filter @iteso/control-plane test

> @iteso/control-plane@0.1.0 test /home/iteso/projects/ITESO-ecosystem/services/control-plane
> jest

PASS test/app.spec.ts
  Control Plane Endpoints (TASK-002)
    Admin Auth Guard (timingSafeEqual)
      ✓ returns 401 when X-Admin-Token header is missing (191 ms)
      ✓ returns 401 when X-Admin-Token header is invalid or different length (13 ms)
      ✓ allows access when valid token is provided (11 ms)
    Admin API Body Validation (Fix 5)
      ✓ returns 400 when enabled is not a boolean (e.g. string "false") (19 ms)
      ✓ returns 400 when note exceeds 500 characters (9 ms)
    ControlPlaneService Logic (Fix 4: Real service behavior & NATS publishing)
      ✓ throws 409 FEATURE_NOT_IMPLEMENTED when attempting to enable a not_implemented feature (8 ms)
      ✓ updates available feature, creates audit log in transaction, and publishes to NATS (5 ms)
    GET /health
      ✓ returns 200 when database and nats are healthy (11 ms)

Test Suites: 1 passed, 1 total
Tests:       8 passed, 8 total
Snapshots:   0 total
Time:        3.025 s
Ran all test suites.

pnpm --filter @iteso/gateway test

> @iteso/gateway@0.1.0 test /home/iteso/projects/ITESO-ecosystem/services/gateway
> jest

[Nest] 1158772  - 11/26/2026, 3:58:29 AM   ERROR [FeatureFlagGuard] Undeclared feature on v1 endpoint: GET /v1/test-undeclared
PASS test/app.spec.ts
  Gateway endpoints (TASK-002)
    GET /health
      ✓ returns 200 and ok for all 5 components without needing @RequireFeature (151 ms)
    Feature Flag Evaluation Matrix (Real SQL simulation via mock Pool)
      ✓ case 1: feature is platform_enabled = false -> returns false (9 ms)
      ✓ case 2: tenant override = false -> returns false (7 ms)
      ✓ case 3: no tenant row, default_enabled = true -> returns true (5 ms)
      ✓ case 4: no tenant row, default_enabled = false -> returns false (5 ms)
      ✓ case 5: implementation_status = not_implemented -> returns false (4 ms)
      ✓ case 6: feature key does not exist -> returns false (5 ms)
      ✓ caching: does not query database again within 30 seconds (6 ms)
      ✓ caching: queries database again after clearCache (e.g. on NATS event) (6 ms)
    Route Guards and Controller responses
      ✓ returns 200 when feature is enabled (12 ms)
      ✓ returns 403 FEATURE_DISABLED when feature is disabled (10 ms)
      ✓ returns 403 FEATURE_UNDECLARED when endpoint under /v1 does not declare @RequireFeature (11 ms)
      ✓ GET /v1/features returns enabled features list for tenant (28 ms)

Test Suites: 1 passed, 1 total
Tests:       13 passed, 13 total
Snapshots:   0 total
Time:        3.002 s
Ran all test suites.

./scripts/test-db-isolation.sh
[test-db-isolation] Verifying 'iteso_gateway' can connect to 'platform' and SELECT tenants...
[test-db-isolation] Verifying 'iteso_gateway' is DENIED access to 't_demo_fnb' (res_users)...
[test-db-isolation] Verifying 'iteso_gateway' cannot write to 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' cannot SELECT from 'admin_audit_log' in 'platform'...
[test-db-isolation] PASS: All database isolation checks passed cleanly.

./scripts/test-odoo-module.sh
[test-odoo-module] PASS: iteso_base installed cleanly in 't_test_iteso_base' (state=installed).
```

#### c. Kiểm thử Body Validation (trả về 400 khi `enabled` là string `"false"`)
```bash
curl -i -s -X PUT http://localhost:3100/admin/tenants/demo_fnb/features/system.odoo_version \
  -H "X-Admin-Token: change_me_admin_token_secret_123" \
  -H "Content-Type: application/json" \
  -d '{"enabled":"false"}'
```
Output:
```text
HTTP/1.1 400 Bad Request
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 69
ETag: W/"45-fhrqhI1krKXAyRf//C13qSkyU0k"
Date: Wed, 25 Nov 2026 20:58:14 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"error":"BAD_REQUEST","message":"Field 'enabled' must be a boolean"}
```

#### d. Kiểm thử Admin Token qua `timingSafeEqual` (trả về 401 khi token sai)
```bash
curl -i -s -X GET http://localhost:3100/admin/tenants \
  -H "X-Admin-Token: wrong_token_value"
```
Output:
```text
HTTP/1.1 401 Unauthorized
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 67
ETag: W/"43-RGOryhoc95hqjhUiT8tcfefCIn4"
Date: Wed, 25 Nov 2026 20:58:14 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"error":"UNAUTHORIZED","message":"Invalid or missing admin token"}
```

#### e. Kịch bản tắt/bật cờ tính năng thời gian thực và xác thực Gateway
1. Tắt `system.odoo_version`:
```bash
curl -i -s -X PUT http://localhost:3100/admin/tenants/demo_fnb/features/system.odoo_version \
  -H "X-Admin-Token: change_me_admin_token_secret_123" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false,"note":"Round 2 turn off"}'
```
Output:
```text
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 193
ETag: W/"c1-3KYz43xB42CnBvO3K5YFxUxxyAQ"
Date: Wed, 25 Nov 2026 20:58:14 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"tenantId":"90dba260-7fb7-437e-896a-196e91cc6327","featureKey":"system.odoo_version","enabled":false,"updatedBy":"super_admin","updatedAt":"2026-11-25T20:58:14.886Z","note":"Round 2 turn off"}
```

2. Gọi ngay Gateway (nhận `403 FEATURE_DISABLED` tức thì, không đợi cache):
```bash
curl -i -s http://localhost:3000/v1/odoo/version -H "X-Tenant: demo_fnb"
```
Output:
```text
HTTP/1.1 403 Forbidden
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 60
ETag: W/"3c-i/kQoT2d8stt4XWgf3bgYy6Pl9g"
Date: Wed, 25 Nov 2026 20:58:14 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"error":"FEATURE_DISABLED","feature":"system.odoo_version"}
```

3. Bật lại `system.odoo_version`:
```bash
curl -i -s -X PUT http://localhost:3100/admin/tenants/demo_fnb/features/system.odoo_version \
  -H "X-Admin-Token: change_me_admin_token_secret_123" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"note":"Round 2 turn on"}'
```
Output:
```text
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 191
ETag: W/"bf-kWCaTJGqXv47S66Qa/Y1iRAiVCk"
Date: Wed, 25 Nov 2026 20:58:14 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"tenantId":"90dba260-7fb7-437e-896a-196e91cc6327","featureKey":"system.odoo_version","enabled":true,"updatedBy":"super_admin","updatedAt":"2026-11-25T20:58:14.936Z","note":"Round 2 turn on"}
```

4. Gọi ngay Gateway (nhận `200 OK` tức thì):
```bash
curl -i -s http://localhost:3000/v1/odoo/version -H "X-Tenant: demo_fnb"
```
Output:
```text
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 156
ETag: W/"9c-kpvkqkGRjjFzWbZbzK28fmOgtyE"
Date: Wed, 25 Nov 2026 20:58:15 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"tenant":"demo_fnb","database":"t_demo_fnb","api":"json-2","version":"20.0-20261123","version_info":[20,0,0,"final",0,""],"base_module_version":"20.0.1.3"}
```

#### f. Xác thực `admin_audit_log` và số dòng (Criterion 4.4)
```bash
docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -c "SELECT id, actor, action, target_type, target_id, note, created_at FROM admin_audit_log ORDER BY created_at ASC;"
docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -t -A -c "SELECT count(*) FROM admin_audit_log;"
```
Output:
```text
                  id                  |    actor    |        action         |  target_type   |          target_id           |       note       |          created_at           
--------------------------------------+-------------+-----------------------+----------------+------------------------------+------------------+-------------------------------
 9ac1f7f1-ccdb-4a79-85d6-7bdc0a14198c | super_admin | UPDATE_TENANT_FEATURE | tenant_feature | demo_fnb:system.odoo_version | Round 2 turn off | 2026-11-25 20:58:14.886395+00
 2be6acc5-ae81-4600-a37c-ba4b41c134b4 | super_admin | UPDATE_TENANT_FEATURE | tenant_feature | demo_fnb:system.odoo_version | Round 2 turn on  | 2026-11-25 20:58:14.936441+00
(2 rows)

2
```

