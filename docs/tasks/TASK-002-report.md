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

- Cổng PostgreSQL trong `docker-compose.yml` được mở trên `127.0.0.1:5432:5432` thay vì chỉ chạy trong mạng nội bộ, nhằm cho phép lệnh `make up` / `make reset` chạy các script `pnpm db:migrate` và `pnpm db:seed` từ host WSL2 trực tiếp vào database `platform`. Cổng chỉ lắng nghe `127.0.0.1` nên vẫn đảm bảo an toàn, không lộ ra mạng ngoài.
- Thêm controller `TestUndeclaredController` (`GET /v1/test-undeclared`) trong `services/gateway` để phục vụ test tự động xác nhận cơ chế chặn `403 FEATURE_UNDECLARED` khi route `/v1` không khai báo decorator `@RequireFeature`.

---

## Vấn đề còn tồn tại

- Không có vấn đề tồn đọng. Toàn bộ các tiêu chí nghiệm thu từ 1 đến 8 đều đạt đầy đủ.
