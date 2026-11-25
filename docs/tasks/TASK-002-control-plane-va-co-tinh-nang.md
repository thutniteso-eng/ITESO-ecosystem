# TASK-002: Control plane, danh mục tenant và cờ tính năng

- Người giao: Claude (kiến trúc)
- Người làm: Antigravity
- Người duyệt cuối: Product Owner
- Giai đoạn: GĐ 0 — Nền móng
- Căn cứ: ADR-002, ADR-004, ADR-006 (đọc lại ADR-001, ADR-003 về quy tắc chung)

## Mục tiêu

Sau task này:
- Có dịch vụ `control-plane` và database `platform`, lưu danh sách tenant và cờ tính năng.
- Gateway xác định tenant từ `platform`, không còn dò `pg_database`.
- Gateway chặn endpoint có tính năng đang tắt bằng `403 FEATURE_DISABLED`.
- Super Admin (tạm dùng admin token) bật/tắt được tính năng qua API. Thay đổi có hiệu lực ngay và được ghi nhật ký.

**Không làm đăng nhập, không làm giao diện.**

## Vị trí làm việc

Như TASK-001: chỉ làm trong `~/projects/ITESO-ecosystem` (WSL). Kéo `main` mới nhất về trước khi bắt đầu, làm trên nhánh `task/TASK-002-control-plane`.

## Việc cần làm

### 1. Database và role (mở rộng `scripts/init-db-roles.sh`, chạy lại được nhiều lần)
- Tạo role `iteso_control_plane` với `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`.
- Tạo database `platform`, chủ sở hữu là `iteso_control_plane`. `REVOKE CONNECT ON DATABASE platform FROM PUBLIC`; chỉ cấp `CONNECT` cho `iteso_control_plane` và `iteso_gateway`.
- `iteso_gateway` chỉ có `SELECT` trên `tenants`, `feature_definitions`, `tenant_features`. Không có quyền ghi, không được đọc `admin_audit_log`. Cấp quyền sau khi migration tạo bảng; dùng `ALTER DEFAULT PRIVILEGES` hoặc cấp lại trong bước migration.
- Thêm vào `.env.example`: `POSTGRES_CONTROL_PLANE_USER`, `POSTGRES_CONTROL_PLANE_PASSWORD`, `CONTROL_PLANE_ADMIN_TOKEN` (giá trị mẫu `change_me...`).

### 2. Script dùng chung cho database tenant
- Tách bước "thu hồi `CONNECT` từ `PUBLIC` và `iteso_gateway`" thành `scripts/lib/secure-tenant-db.sh <tên_db>`. `init-demo-tenant.sh` và `test-odoo-module.sh` đều gọi script này.
- Sửa `scripts/test-db-isolation.sh`: kiểm tra output có chứa `permission denied`, không chỉ kiểm tra lệnh thất bại (ghi chú ở review vòng 2 của TASK-001).

### 3. Dịch vụ `services/control-plane` (NestJS, TypeScript, Drizzle ORM + drizzle-kit)
- Kết nối database `platform` bằng role `iteso_control_plane`.
- Migration tạo 4 bảng:

  | Bảng | Cột chính |
  | --- | --- |
  | `tenants` | `id` uuid, `code` (unique, `^[a-z0-9_]+$`), `db_name` (unique), `display_name`, `status` (`active`/`suspended`), `industries` text[], `created_at`, `updated_at` |
  | `feature_definitions` | `key` (PK, dạng `<nhóm>.<tên>`), `group`, `description`, `implementation_status` (`available`/`not_implemented`), `platform_enabled` bool, `default_enabled` bool |
  | `tenant_features` | `tenant_id`, `feature_key`, `enabled`, `updated_by`, `updated_at`, `note`; PK (`tenant_id`, `feature_key`) |
  | `admin_audit_log` | `id`, `actor`, `action`, `target_type`, `target_id`, `before` jsonb, `after` jsonb, `note`, `created_at` |

- Seed chạy lại được nhiều lần:
  - Tenant `demo_fnb` (`db_name` = `t_demo_fnb`, ngành `fnb`, `active`).
  - Các khóa trong ADR-004 với `implementation_status = not_implemented`, vì chưa có code: `fnb.pos`, `fnb.qr_order`, `fnb.kds`, `fnb.reservation`, `einvoice.viettel`, `inventory.recipe`, `hotel.pms`, `platform.tenant_create`, `platform.self_signup`, `platform.billing`, `ai.assistant`.
  - Một khóa thật để kiểm thử cơ chế: `system.odoo_version` (`available`, bật ở tầng nền tảng, bật mặc định), gắn với endpoint `GET /v1/odoo/version`.

- API quản trị (cổng `3100`, chỉ `127.0.0.1`, mọi request phải có header `X-Admin-Token` khớp `.env`; sai hoặc thiếu trả `401`):

  | Endpoint | Việc |
  | --- | --- |
  | `GET /admin/tenants` | Danh sách tenant |
  | `GET /admin/features` | Danh sách khóa và trạng thái tầng nền tảng |
  | `GET /admin/tenants/:code/features` | Trạng thái hiệu lực của từng khóa cho tenant |
  | `PUT /admin/features/:key/platform` | Bật/tắt tầng nền tảng. Body `{ "enabled": bool, "note": string }` |
  | `PUT /admin/tenants/:code/features/:key` | Bật/tắt cho tenant. Body `{ "enabled": bool, "note": string }` |

- Quy tắc:
  - Bật một khóa `not_implemented` trả `409 FEATURE_NOT_IMPLEMENTED`.
  - Mọi thay đổi ghi `admin_audit_log`, trong cùng giao dịch với thay đổi, rồi phát NATS `platform.features.changed` với `{ "tenant": code|null, "key": key }`.
  - `/health` của control-plane kiểm tra database `platform` và NATS.

### 4. Gateway
- **Xác định tenant:** đọc bảng `tenants` (chỉ `status = active`) thay cho việc dò `pg_database`. Bỏ quyền `CONNECT` của `iteso_gateway` vào database `postgres` nếu không còn cần.
- **Đánh giá cờ:** tính năng bật khi và chỉ khi `implementation_status = available` **và** `platform_enabled` **và** (giá trị trong `tenant_features`, nếu không có thì `default_enabled`).
- **Cache** kết quả trong bộ nhớ tối đa 30 giây. Khi nhận NATS `platform.features.changed` thì xóa cache ngay.
- **Khai báo bắt buộc:** decorator `@RequireFeature('<key>')` trên mọi route dưới `/v1`. Route `/v1` thiếu khai báo bị chặn `403 FEATURE_UNDECLARED` và ghi log lỗi. `/health` không cần khai báo.
- `GET /v1/odoo/version` khai báo `system.odoo_version`.
- `GET /v1/features` (khai báo `system.features`, khóa này `available`, bật mặc định, thêm vào seed): trả danh sách khóa đang bật cho tenant trong header `X-Tenant`.
- Tính năng tắt: `403` với body `{ "error": "FEATURE_DISABLED", "feature": "<key>" }`.

### 5. Compose, Makefile, CI
- Thêm dịch vụ `control-plane` vào Compose (cổng `127.0.0.1:3100`).
- `make up`: tạo role và database, chạy migration và seed, rồi mới khởi động gateway.
- `make test`: thêm test của control-plane.
- CI: thêm lint/typecheck/test/build cho control-plane. Job Compose thêm kịch bản ở mục "Tiêu chí nghiệm thu" số 4.

## Test tự động bắt buộc

- Bảng đánh giá cờ ở gateway, mỗi trường hợp một test: nền tảng tắt; tenant tắt; tenant không có dòng riêng thì dùng mặc định; `not_implemented`; tenant `suspended`; tenant không tồn tại.
- Cache được xóa khi nhận sự kiện NATS.
- Route `/v1` thiếu `@RequireFeature` bị chặn `FEATURE_UNDECLARED`.
- Control plane: thiếu hoặc sai token trả `401`; bật khóa `not_implemented` trả `409`; mỗi thay đổi tạo đúng 1 dòng `admin_audit_log`.
- `iteso_gateway` không ghi được vào `platform` và không đọc được `admin_audit_log`.

## Ngoài phạm vi

Đăng nhập, tài khoản, vai trò (TASK-003). Giao diện quản trị. Tạo tenant mới qua API. Dữ liệu nhà hàng mẫu.

## Tiêu chí nghiệm thu

1. `make reset` rồi `make up` chạy xong, không lỗi; 6 container đều healthy.
2. `GET /v1/odoo/version` với `X-Tenant: demo_fnb` vẫn trả `200`.
3. `GET /v1/features` với `X-Tenant: demo_fnb` trả danh sách có `system.odoo_version` và `system.features`.
4. Kịch bản bật/tắt (chạy trong CI, dán output thật vào báo cáo):
   1. `PUT /admin/tenants/demo_fnb/features/system.odoo_version` với `enabled=false` → `200`.
   2. Ngay sau đó `GET /v1/odoo/version` → `403 FEATURE_DISABLED` (không phải chờ hết 30 giây).
   3. Bật lại → `200`.
   4. `admin_audit_log` có đúng 2 dòng cho 2 thay đổi trên.
5. Bật `fnb.pos` → `409 FEATURE_NOT_IMPLEMENTED`.
6. Gọi API quản trị không có token → `401`.
7. `make test` xanh; CI xanh trên Pull Request (repo đã public nên Actions chạy được).
8. Không có mật khẩu hay token thật trong lịch sử Git.

## Mẫu báo cáo

Ghi vào `docs/tasks/TASK-002-report.md`, cùng mẫu với TASK-001: Đã làm / Lệnh chạy và kết quả (output thật) / Chỗ làm khác phiếu và lý do / Vấn đề còn tồn tại.

## Quy tắc

- Chỗ nào phiếu chưa rõ hoặc thấy cần làm khác: dừng lại và hỏi, không tự đổi hướng.
- Không merge. Claude kiểm duyệt và merge khi CI xanh.
