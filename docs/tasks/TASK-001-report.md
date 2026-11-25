# Báo cáo TASK-001

## Đã làm

- Tạo repo private `thutniteso-eng/ITESO-ecosystem` trên GitHub với nhánh mặc định `main`. Commit đầu tiên (`b9ccae5`) chỉ gồm 7 file nguyên bản (`README.md`, `docs/adr/ADR-001..005`, `docs/tasks/TASK-001-...md`), không chỉnh sửa nội dung.
- Thực hiện toàn bộ công việc còn lại trên nhánh `task/TASK-001-bootstrap`.
- Khởi tạo khung monorepo với `pnpm` workspaces + Turborepo (`package.json`, `pnpm-workspace.yaml`, `turbo.json`), `.gitignore`, `.editorconfig`, `.env.example` (không commit `.env` hay mật khẩu/khóa thật), cùng các thư mục `apps/`, `services/`, `odoo-addons/`, `packages/`, `infra/`, `scripts/` và `README.md` cho các thư mục chưa có code.
- Xây dựng dịch vụ `services/gateway` (NestJS, TypeScript, Node 24 LTS) với đúng 2 endpoint:
  - `GET /health`: kiểm tra trạng thái `gateway`, `postgres`, `odoo`, `nats`, `redis` (`ok` hoặc `error` kèm `reason`).
  - `GET /v1/odoo/version`: nhận header `X-Tenant`, ánh xạ sang database `t_<mã>` (ADR-002), kiểm tra tồn tại tenant (trả `404 TENANT_NOT_FOUND` nếu không tồn tại hoặc header không hợp lệ), gọi Odoo 20 qua External JSON-2 API (`POST /json/2/ir.module.module/search_read` kèm `X-Odoo-Database` + `Authorization: bearer`) và `/json/version` để trả về phiên bản Odoo 20.
  - Viết test tự động (`services/gateway/test/app.spec.ts`) kiểm thử cả 2 endpoint (5/5 test đạt).
- Tạo module Odoo tối thiểu `odoo-addons/iteso_base` (LGPL-3, phụ thuộc `base`, chưa có model).
- Cấu hình Docker Compose trong `infra/docker-compose.yml` với 5 dịch vụ ghim tag cụ thể:
  - `postgres:16.16-alpine` (chỉ nội bộ Compose)
  - `odoo:20.0-20261123` (mở cổng `8069`, mount `odoo-addons/` read-only, `dbfilter = ^t_.*$`, `list_db = False`, nạp `admin_passwd` và thông số DB từ `.env` lúc khởi chạy qua `infra/odoo/start-odoo.sh`)
  - `nats:2.15.3` (chỉ nội bộ Compose)
  - `redis:7.4.12-alpine` (chỉ nội bộ Compose)
  - `gateway` (build từ `services/gateway/Dockerfile`, mở cổng `3000`)
- Tạo `Makefile` ở gốc repo (`make up`, `make down`, `make reset`, `make seed`, `make test`) và script hỗ trợ (`scripts/init-demo-tenant.sh`, `scripts/test-odoo-module.sh`).
- Tạo workflow CI `.github/workflows/ci.yml` chạy trên PR và push vào `main` (cài dependency, lint, typecheck, test gateway, dựng Compose, khởi tạo `t_demo_fnb`, cài thử `iteso_base` vào DB test và kiểm tra endpoint + tắt database manager).

## Lệnh chạy và kết quả (dán output thật)

- `make up`:
```text
[+] up 6/6
 ✔ Container iteso-ecosystem-redis-1    Healthy
 ✔ Container iteso-ecosystem-postgres-1 Healthy
 ✔ Container iteso-ecosystem-nats-1     Healthy
 ✔ Container iteso-ecosystem-odoo-1     Healthy
 ✔ Container iteso-ecosystem-gateway-1  Healthy
./scripts/init-demo-tenant.sh
[init-demo-tenant] Checking if database 't_demo_fnb' exists...
[init-demo-tenant] Initializing database 't_demo_fnb' with module 'iteso_base'...
2026-11-25 13:39:08,892 27 INFO t_demo_fnb odoo.modules.loading: 17 modules loaded in 4.46s, 5345 queries (+5345 extra)
2026-11-25 13:39:09,253 27 INFO t_demo_fnb odoo.registry: Registry loaded in 16.741s
[init-demo-tenant] Database 't_demo_fnb' initialized with 'iteso_base'.
[init-demo-tenant] Ensuring dev JSON-2 API key is configured on 't_demo_fnb'...
Dev API key ready for user: admin
[init-demo-tenant] Done.
real 0m24.545s
```

- `curl /health`:
```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{"status":"ok","components":{"gateway":{"status":"ok"},"postgres":{"status":"ok"},"odoo":{"status":"ok"},"nats":{"status":"ok"},"redis":{"status":"ok"}}}
```

- `curl /v1/odoo/version`:
```text
# Header X-Tenant: demo_fnb
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{"tenant":"demo_fnb","database":"t_demo_fnb","api":"json-2","version":"20.0-20261123","version_info":[20,0,0,"final",0,""],"base_module_version":"20.0.1.3"}

# Header X-Tenant: khong_ton_tai
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8

{"error":"TENANT_NOT_FOUND","message":"Tenant 'khong_ton_tai' not found"}

# Kiểm tra /web/database/manager (list_db = False)
<div class="alert alert-danger text-center">The database manager has been disabled by the administrator</div>
```

- `make test`:
```text
pnpm --filter @iteso/gateway test

PASS test/app.spec.ts
  Gateway endpoints (TASK-001)
    GET /health
      ✓ returns 200 and ok for all 5 components when healthy (137 ms)
      ✓ returns 503 with reason when a dependency fails (8 ms)
    GET /v1/odoo/version
      ✓ returns Odoo 20 version for existing tenant demo_fnb via JSON-2 API (8 ms)
      ✓ returns 404 TENANT_NOT_FOUND for non-existent tenant (6 ms)
      ✓ returns 404 TENANT_NOT_FOUND when X-Tenant header is missing or invalid (9 ms)

Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
Snapshots:   0 total
Time:        2.386 s, estimated 3 s

./scripts/test-odoo-module.sh
[test-odoo-module] Dropping any leftover 't_test_iteso_base'...
[test-odoo-module] Installing 'iteso_base' into fresh database 't_test_iteso_base'...
2026-11-25 13:39:44,308 66 INFO t_test_iteso_base odoo.registry: Registry loaded in 16.364s
[test-odoo-module] PASS: iteso_base installed cleanly in 't_test_iteso_base' (state=installed).
```

## Trả lời 5 câu xác minh ở mục 8

1. **Image Docker chính thức của Odoo 20.0 Community:**
   - Tên repository: `odoo` (`docker.io/library/odoo`).
   - Tag cố định mới nhất tại thời điểm kiểm tra: `odoo:20.0-20261123` (digest `sha256:6709a38456a588273462c83400a0b6dbe09038deefc05846a8d3d25231dbb82e`, chạy `Odoo Server 20.0-20261123`). Đã ghim đúng tag này trong `infra/docker-compose.yml`.

2. **External API được Odoo 20 khuyến nghị và API bị ngừng hỗ trợ:**
   - **Khuyến nghị:** **External JSON-2 API** (`POST /json/2/<model>/<method>` với `Authorization: bearer <API_KEY>` và `X-Odoo-Database: <db_name>`, cùng `/json/version` cho thông tin phiên bản). Gateway đã triển khai theo JSON-2 API.
   - **Ngừng hỗ trợ (deprecated):** Trong mã nguồn `odoo/addons/rpc/controllers/__init__.py` của `odoo:20.0-20261123` có thông báo chính thức:
     > *"The `/xmlrpc`, `/xmlrpc/2` and `/jsonrpc` endpoints are deprecated in Odoo 19 and scheduled for removal in Odoo 22."*
     (Ngoài ra dịch vụ `db` qua RPC đã bị gỡ bỏ ở Odoo 20).

3. **Phiên bản PostgreSQL mà Odoo 20 hỗ trợ:**
   - Trong `/usr/lib/python3/dist-packages/odoo/release.py` dòng 41: `MIN_PG_VERSION = 16` (yêu cầu **PostgreSQL 16 trở lên**).
   - Đã sử dụng `postgres:16.16-alpine` trong `infra/docker-compose.yml`.

4. **Module `l10n_vn_edi_viettel` và danh sách module `l10n_vn*` trong Community 20.0:**
   - **Có** trong bản Odoo 20.0 Community, giấy phép `LGPL-3`, phụ thuộc `["l10n_vn"]` (`summary: "E-invoicing using SInvoice by Viettel"`).
   - Danh sách toàn bộ 4 module `l10n_vn*` có sẵn trong `/usr/lib/python3/dist-packages/odoo/addons/`:
     - `l10n_vn`
     - `l10n_vn_edi_viettel`
     - `l10n_vn_edi_viettel_pos`
     - `l10n_vn_edi_viettel_stock`

5. **Mức RAM thực tế khi toàn bộ Compose chạy (`docker stats`) và đề xuất `.wslconfig`:**
   - Kết quả đo thực tế (`docker stats --no-stream`) cho 5 container của dự án ở trạng thái sẵn sàng sau khi khởi tạo `t_demo_fnb`:
     | Container | CPU % | MEM USAGE |
     | --- | --- | --- |
     | `iteso-ecosystem-odoo-1` | 0.01% | 102.1 MiB |
     | `iteso-ecosystem-postgres-1` | 0.03% | 85.75 MiB |
     | `iteso-ecosystem-gateway-1` | 0.00% | 54.43 MiB |
     | `iteso-ecosystem-nats-1` | 0.11% | 5.18 MiB |
     | `iteso-ecosystem-redis-1` | 0.92% | 4.77 MiB |
     | **Tổng (5 container)** | — | **~252.2 MiB** |
   - Lưu ý: Khi cài module hoặc tải nhiều addon/tenant thực tế, Odoo + PostgreSQL + build frontend/backend sẽ tăng lên khoảng 1.5–4 GB.
   - Đề xuất cấu hình `C:\Users\<user>\.wslconfig` cho máy Windows 10 16 GB RAM (theo ADR-003, tối đa ~10 GB cho WSL2):
     ```ini
     [wsl2]
     memory=8GB
     processors=4
     swap=4GB
     autoMemoryReclaim=gradual
     ```
     (Có thể nâng `memory=10GB` ở GĐ 1–2 khi chạy thêm Next.js + Expo + nhiều tenant đồng thời).

## Chỗ làm khác phiếu (nếu có) và lý do

- Trong `services/gateway` và `scripts/init-demo-tenant.sh`, đã thêm biến `ODOO_DEV_API_KEY` vào `.env.example` và tự động nạp key dev cho user `admin` trong `t_demo_fnb` lúc chạy `make up`. Lý do: External JSON-2 API (`/json/2/<model>/<method>`) của Odoo 20 bắt buộc xác thực `Authorization: bearer <API_KEY>` (`auth='bearer'`, `bearer_scope='rpc'`). Cơ chế này chỉ dùng tạm cho bootstrap TASK-001; ở task tiếp theo (ADR-005) sẽ thay bằng API key riêng cho từng membership người dùng.
- `git config --local user.email` trong repo cục bộ được cấu hình sang địa chỉ noreply của tài khoản GitHub (`273327510+thutniteso-eng@users.noreply.github.com`) vì GitHub bật chế độ bảo vệ email riêng tư (`GH007`).

## Vấn đề còn tồn tại / câu hỏi cho Claude

- Khi bật `proxy_mode = True` trên Odoo 20, mặc định Odoo chỉ lắng nghe `127.0.0.1:8069` nên đã khai báo tường minh `http_interface = 0.0.0.0` trong `infra/odoo/odoo.conf` để `gateway` và host kết nối được.
- `README.md` ở nhánh `main` giữ nguyên văn theo yêu cầu; sau khi PR TASK-001 được merge, có thể cập nhật mục "Chạy môi trường dev" trong `README.md` ở task tiếp theo nếu Claude/PO muốn.
