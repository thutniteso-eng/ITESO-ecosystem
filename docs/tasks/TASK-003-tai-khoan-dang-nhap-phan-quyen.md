# TASK-003: Tài khoản, đăng nhập, vai trò và phân quyền

- Người giao: Claude (kiến trúc)
- Người làm: Antigravity
- Người duyệt cuối: Product Owner
- Giai đoạn: GĐ 0 — Nền móng
- Căn cứ: ADR-005 (đọc kỹ cả mục "Bổ sung khi triển khai"), ADR-004, ADR-006

## Mục tiêu

Sau task này:
- Người dùng đăng nhập bằng email hoặc số điện thoại + mật khẩu, nhận access token và refresh token.
- Mọi API `/v1` (trừ đăng nhập) đều yêu cầu token, kiểm tra cả cờ tính năng lẫn quyền.
- Super Admin đăng nhập bằng mật khẩu + mã xác thực hai lớp (TOTP). **Admin token tạm của TASK-002 bị gỡ hoàn toàn.**

Không làm: người dùng Odoo riêng cho từng membership (TASK-004), máy POS và PIN (TASK-005), giao diện.

## Vị trí làm việc

Như các task trước: `~/projects/ITESO-ecosystem` (WSL). Kéo `main` mới nhất, làm trên nhánh `task/TASK-003-auth`.

## Việc cần làm

### 1. Dữ liệu (migration mới trong control-plane, sinh bằng drizzle-kit)

| Bảng | Cột chính |
| --- | --- |
| `accounts` | `id` uuid, `email` (unique, có thể rỗng), `phone` (unique, có thể rỗng; phải có ít nhất một trong hai), `password_hash`, `totp_secret_enc` (rỗng được), `totp_enabled`, `is_platform_admin`, `status` (`active`/`disabled`), `failed_attempts`, `locked_until`, `created_at`, `updated_at` |
| `permissions` | `key` (PK, dạng `<nhóm>.<hành động>`), `group`, `description` |
| `roles` | `id`, `tenant_id`, `name`, `is_owner`, `created_at`; unique (`tenant_id`, `name`) |
| `role_permissions` | `role_id`, `permission_key`; PK đôi |
| `memberships` | `id`, `account_id`, `tenant_id`, `status` (`active`/`disabled`), `branch_scope` text[] (rỗng = mọi chi nhánh), `created_at`; unique (`account_id`, `tenant_id`) |
| `membership_roles` | `membership_id`, `role_id`; PK đôi |
| `refresh_tokens` | `id`, `account_id`, `membership_id` (rỗng được), `family_id`, `token_hash` (SHA-256), `expires_at`, `revoked_at`, `replaced_by`, `created_at`, `user_agent`, `ip` |

- `iteso_gateway` **không** được đọc các bảng này. Quyền của gateway giữ như TASK-002.

### 2. Danh mục quyền và vai trò mẫu (seed, chạy lại được nhiều lần)

- Quyền: `system.diagnostics.view`, `settings.manage`, `settings.roles.manage`, `pos.order.create`, `pos.order.void`, `pos.discount.apply`, `report.revenue.view`, `inventory.manage`, `accounting.view`.
- Mỗi tenant khi seed có 6 vai trò mẫu:

  | Vai trò | Quyền |
  | --- | --- |
  | Chủ (`is_owner = true`) | Tất cả |
  | Quản lý | Tất cả trừ `settings.roles.manage` |
  | Thu ngân | `pos.order.create`, `pos.discount.apply` |
  | Phục vụ | `pos.order.create` |
  | Bếp | không quyền nào ở task này |
  | Kế toán | `report.revenue.view`, `accounting.view` |

- Tài khoản demo cho `demo_fnb`, mật khẩu lấy từ `.env`:
  - `owner@demo.local`: vai trò Chủ.
  - `cashier@demo.local`: vai trò Thu ngân.
  - `multi@demo.local`: thuộc 2 tenant. Seed thêm tenant `demo_fnb2` trong `platform`. Chỉ cần bản ghi trong `platform`; chưa cần database Odoo cho tenant này.
- Thêm khóa cờ `system.auth` (`available`, bật mặc định). Gắn cờ này cho các route đăng nhập.

### 3. Khóa ký token
- Cặp khóa Ed25519, sinh tự động khi `make up` nếu chưa có, lưu ở `infra/secrets/` (thêm vào `.gitignore`).
- Control-plane giữ khóa bí mật để ký. Gateway chỉ giữ khóa công khai để xác minh. Mỗi khóa có `kid`, để sau này xoay vòng được.
- Mã hóa `totp_secret` bằng AES-256-GCM, khóa lấy từ `PLATFORM_ENCRYPTION_KEY` trong `.env` (32 byte, base64). `.env.example` chỉ có giá trị mẫu.

### 4. Đăng nhập (control-plane xử lý; gateway chuyển tiếp `/v1/auth/*` sang control-plane)

| Endpoint | Việc |
| --- | --- |
| `POST /v1/auth/login` `{identifier, password}` | Đúng thông tin và có đúng 1 membership: trả `access_token` + `refresh_token`. Có nhiều membership: trả `{ "next": "select_tenant", "selection_token", "tenants": [...] }`. Là Super Admin: trả `{ "next": "totp", "challenge_token" }` |
| `POST /v1/auth/select-tenant` `{selection_token, tenant}` | Trả token cho tenant đã chọn |
| `POST /v1/auth/totp` `{challenge_token, code}` | Super Admin nhập mã 6 số, đúng thì trả token có `amr: ["pwd","otp"]` |
| `POST /v1/auth/refresh` `{refresh_token}` | Đổi token mới; token cũ bị thu hồi |
| `POST /v1/auth/logout` `{refresh_token}` | Thu hồi cả "họ" refresh token |
| `GET /v1/me` | Tài khoản, tenant, vai trò, danh sách quyền |

Quy tắc bắt buộc:
- **Mật khẩu:** băm Argon2id (bộ nhớ tối thiểu 19 MiB, `t = 2`, `p = 1`), dài tối thiểu 10 ký tự.
- **Sai mật khẩu 5 lần liên tiếp** thì khóa tài khoản 15 phút. Thông báo lỗi luôn chung chung (`INVALID_CREDENTIALS`), không tiết lộ tài khoản có tồn tại hay không, kể cả khi đang bị khóa.
- **Access token:** JWT ký EdDSA, sống 15 phút. Claim: `sub` (account id), `tid` (mã tenant; Super Admin không có), `mid` (membership id), `roles`, `perms` (danh sách quyền), `amr`, `kid`.
- **Refresh token:** 32 byte ngẫu nhiên, chỉ lưu hash SHA-256, sống 30 ngày, đổi mới mỗi lần dùng. Dùng lại một refresh token đã đổi thì thu hồi cả họ token đó và trả `401` (phát hiện token bị đánh cắp).
- `selection_token` và `challenge_token` sống 5 phút, chỉ dùng được 1 lần.

### 5. Gateway kiểm tra token và quyền
- Guard toàn cục xác minh JWT (chữ ký, hạn dùng, `kid`).
- Với route đã đăng nhập: **tenant lấy từ token, không lấy từ header**. Nếu có `X-Tenant` mà khác `tid` trong token thì trả `403 TENANT_MISMATCH`.
- Mọi route `/v1` phải khai báo **cả hai**:
  - `@RequireFeature('<key>')`;
  - `@Public()` hoặc `@RequirePermission('<key>')`.

  Thiếu phần quyền thì trả `403 PERMISSION_UNDECLARED` và ghi log lỗi.
- Không có hoặc token sai: `401 UNAUTHENTICATED`. Có token nhưng thiếu quyền: `403 PERMISSION_DENIED`.
- Áp dụng cho các route hiện có:
  - `GET /v1/odoo/version`: cần quyền `system.diagnostics.view`.
  - `GET /v1/features`: chỉ cần đăng nhập. Dùng một quyền "mọi thành viên" do Antigravity đề xuất tên, ghi rõ trong báo cáo.
- Gateway vẫn gọi Odoo bằng `ODOO_DEV_API_KEY` như cũ (TASK-004 mới thay).

### 6. Super Admin thay admin token
- Lệnh CLI trong container control-plane: `node dist/cli/create-platform-admin.js --email ... --password ...`. Lệnh in ra chuỗi `otpauth://`, để anh quét bằng ứng dụng xác thực trên điện thoại. Có tùy chọn `--totp-secret` để CI dùng một bí mật cố định.
- Thêm `make create-platform-admin` gọi lệnh trên (hỏi email và mật khẩu khi chạy).
- `/admin/*` của control-plane chỉ chấp nhận access token có `is_platform_admin` **và** `amr` chứa `otp`. **Xóa `AdminAuthGuard` dùng `X-Admin-Token` và biến `CONTROL_PLANE_ADMIN_TOKEN`.**
- Thêm API quản trị:
  - `POST /admin/accounts`: tạo tài khoản.
  - `POST /admin/tenants/:code/memberships`: gắn tài khoản vào tenant, kèm vai trò.
  - `PUT /admin/accounts/:id/password`: đặt lại mật khẩu khi dev.
  - `GET /admin/tenants/:code/roles`: danh sách vai trò.

  Mọi thao tác đều ghi `admin_audit_log` với `actor` là id tài khoản thật, không phải chuỗi `super_admin`.

### 7. Compose, Makefile, CI
- `make up` sinh khóa (nếu chưa có), chạy migrate và seed như TASK-002.
- CI dựng toàn bộ hệ thống và chạy kịch bản ở mục "Tiêu chí nghiệm thu". Super Admin trong CI dùng `--totp-secret` cố định. Mã TOTP sinh bằng một script nhỏ trong repo.

## Test tự động bắt buộc (dùng logic thật, chỉ giả lập database/mạng khi cần)

- Băm và kiểm mật khẩu. Khóa tài khoản sau 5 lần sai; sau 15 phút mở lại (giả lập thời gian).
- Đăng nhập: 1 membership; nhiều membership; Super Admin cần TOTP; TOTP sai; `selection_token`/`challenge_token` dùng lần 2 bị từ chối.
- Refresh: đổi mới thành công; dùng lại token cũ thì cả họ token bị thu hồi.
- Gateway: không token; token hết hạn; token ký bằng khóa khác; thiếu quyền; `TENANT_MISMATCH`; `PERMISSION_UNDECLARED`.
- Super Admin không có `otp` trong `amr` gọi `/admin/*` bị từ chối.

## Tiêu chí nghiệm thu (chạy trong CI, dán output thật vào báo cáo)

1. `make reset` rồi `make up` chạy xong; khóa được sinh; `git status` không có file trong `infra/secrets/`.
2. `owner@demo.local` đăng nhập được; `GET /v1/me` trả tenant `demo_fnb`, vai trò Chủ và đủ quyền.
3. `GET /v1/odoo/version`:
   - không có token: `401`;
   - token của `cashier@demo.local`: `403 PERMISSION_DENIED`;
   - token của `owner@demo.local`: `200`.
4. Gửi token `demo_fnb` kèm `X-Tenant: demo_fnb2`: `403 TENANT_MISMATCH`.
5. Sai mật khẩu 5 lần thì lần thứ 6 đúng mật khẩu vẫn bị từ chối với cùng thông báo `INVALID_CREDENTIALS`.
6. Refresh thành công. Dùng lại refresh token cũ thì nhận `401`, và refresh token mới nhất của họ đó cũng không dùng được nữa.
7. `multi@demo.local` đi qua bước chọn tenant.
8. Kịch bản bật/tắt cờ của TASK-002 chạy lại bằng token Super Admin (mật khẩu + TOTP). Gọi `/admin/*` với `X-Admin-Token` cũ không còn tác dụng (`401`).
9. `make test` xanh; CI xanh.
10. Lịch sử Git không có khóa, mật khẩu hay bí mật TOTP thật.

## Mẫu báo cáo

Ghi vào `docs/tasks/TASK-003-report.md`, cùng mẫu với các task trước. Ghi riêng tên quyền "mọi thành viên" đã chọn, và mọi chỗ làm khác phiếu.

## Quy tắc

- Chỗ nào phiếu chưa rõ hoặc thấy cần làm khác: dừng lại và hỏi, không tự đổi hướng.
- Không merge. Claude kiểm duyệt và merge khi CI xanh.
