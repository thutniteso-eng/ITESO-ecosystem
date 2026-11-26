# TASK-004: Mỗi thành viên một người dùng Odoo riêng

- Người giao: Claude (kiến trúc)
- Người làm: Antigravity
- Người duyệt cuối: Product Owner
- Giai đoạn: GĐ 0 — Nền móng
- Căn cứ: ADR-005 mục 5 và mục "Bổ sung khi triển khai (27/11/2026)", ADR-001, ADR-006

## Mục tiêu

Sau task này:
- Mỗi membership có một người dùng Odoo riêng (`res.users`) trong database của tenant. Gateway gọi Odoo bằng API key của chính người đó. **Biến `ODOO_DEV_API_KEY` bị gỡ hoàn toàn.**
- Tắt một membership thì người đó mất quyền gọi Odoo ngay, không cần đợi access token hết hạn.
- Nhật ký Odoo (người tạo, người sửa) ghi đúng người thao tác.
- Xử lý xong các tồn đọng của TASK-003 (mục 8).

Không làm: máy POS và PIN (TASK-005), phiên hỗ trợ của Super Admin, cài module nghiệp vụ (POS, kho, kế toán), giao diện.

## Vị trí làm việc

Như các task trước: `~/projects/ITESO-ecosystem` (WSL). Kéo `main` mới nhất, làm trên nhánh `task/TASK-004-odoo-users`.

## Việc cần làm

### 1. Module Odoo `iteso_base`: cổng cấp người dùng (provisioning)

Thêm model trừu tượng `iteso.provisioning` với các phương thức công khai (gọi được qua JSON-2):

| Phương thức | Việc |
| --- | --- |
| `provision_member(membership_id, name, group_xmlids)` | Tạo hoặc cập nhật người dùng có login `iteso-<membership_id>`; đặt `active = True`, tên hiển thị, nhóm quyền. Trả `{uid, login}`. Chạy lại nhiều lần không sinh bản ghi trùng |
| `issue_member_key(uid, ttl_days)` | Sinh API key mới (scope `rpc`, tên `iteso-gateway`) cho người dùng đó, có hạn `ttl_days`. Trả key thô **một lần duy nhất** cùng `expires_at` |
| `revoke_member_keys(uid, keep_newest)` | Xóa các key `iteso-gateway` của người dùng; `keep_newest = True` thì giữ lại key mới nhất (dùng khi xoay vòng) |
| `disable_member(uid)` | Đặt `active = False` và xóa mọi API key của người dùng |

Quy tắc bắt buộc:
- Mọi phương thức kiểm tra người gọi là `iteso_system` **và** thuộc `base.group_system`; không đúng thì `AccessError`.
- Chỉ chấp nhận nhóm trong danh sách cho phép, khai báo trong module. Hiện tại danh sách chỉ có `base.group_user`. Gửi `base.group_system` hoặc `base.group_erp_manager` thì bị từ chối.
- Người dùng `iteso-*` không có mật khẩu dùng được, nên không đăng nhập web Odoo được.
- Sinh key bằng API chuẩn của Odoo (`res.users.apikeys._generate` hoặc hàm tương đương trong Odoo 20). **Không chèn thẳng vào bảng `res_users_apikeys` bằng SQL.** Trước khi làm, đọc mã nguồn Odoo 20 trong container để biết chữ ký hàm và giới hạn thời hạn key với người dùng không phải quản trị. Ghi kết quả vào báo cáo.
- Có test Odoo (`odoo --test-enable`) cho kiểm tra người gọi, danh sách nhóm cho phép và chạy lại nhiều lần.

### 2. Người dùng hệ thống `iteso_system` cho từng tenant

- `scripts/init-demo-tenant.sh`, khi tạo hoặc cập nhật tenant, tạo người dùng `iteso_system` (nhóm `base.group_system`, không đăng nhập web được) và sinh API key cho người này. Đây là tác vụ hệ thống, được làm qua `odoo shell` theo ADR-005.
- Key thô của `iteso_system` được chuyển thẳng qua stdin sang lệnh CLI control-plane `node dist/cli/register-tenant-system-key.js --tenant <code>`. Lệnh này mã hóa key bằng `PLATFORM_ENCRYPTION_KEY` rồi lưu vào bảng `tenant_odoo_system_keys`. **Key thô không được in ra màn hình, log hay file.**
- Gỡ đoạn chèn key `iteso-gateway-dev` bằng SQL trong script hiện tại.
- Gateway **không bao giờ** đọc được key hệ thống.

### 3. Dữ liệu (migration mới trong control-plane)

| Bảng | Cột chính | Ai được đọc |
| --- | --- | --- |
| `tenant_odoo_system_keys` | `tenant_id` (PK), `key_enc`, `created_at`, `rotated_at` | Chỉ control-plane |
| `membership_odoo_users` | `membership_id` (PK), `tenant_id`, `odoo_uid`, `odoo_login`, `api_key_enc`, `key_expires_at`, `status` (`pending`/`active`/`disabled`/`error`), `last_error`, `synced_at` | Control-plane ghi. Gateway chỉ `SELECT` các cột `membership_id`, `tenant_id`, `odoo_uid`, `api_key_enc`, `key_expires_at`, `status` |
| `roles` (thêm cột) | `odoo_groups text[]`, mặc định `{base.group_user}` | Chỉ control-plane |

- `api_key_enc` mã hóa AES-256-GCM bằng **khóa riêng** `infra/secrets/odoo_credentials.key`. Khóa này khác `PLATFORM_ENCRYPTION_KEY`; `generate-keys.sh` sinh nó (`chmod 600`, chủ sở hữu uid 1000), mount vào control-plane và gateway. Nhờ vậy gateway giải mã được key Odoo nhưng không giải mã được bí mật TOTP.
- Mọi quyền khác của `iteso_gateway` giữ nguyên như TASK-003.

### 4. Control-plane: đồng bộ người dùng Odoo

Tạo service `OdooProvisioningService`, gọi `iteso.provisioning` qua JSON-2 bằng key hệ thống của tenant.

- **Khi nào đồng bộ:**
  - Tạo membership.
  - Đổi vai trò hoặc trạng thái membership.
  - CLI `node dist/cli/provision-odoo-users.js --tenant <code>` (đồng bộ mọi membership của tenant).
  - API `POST /admin/tenants/:code/memberships/:id/odoo-sync`.
- **Thêm API** `PUT /admin/tenants/:code/memberships/:id` `{status?, roleNames?}` để tắt hoặc bật membership và đổi vai trò; có ghi `admin_audit_log`.
- **Nhóm quyền Odoo** của một người là hợp các `odoo_groups` của mọi vai trò người đó có.
- **Thứ tự khi cấp key:** gọi `provision_member`, rồi `issue_member_key` (`ttl_days` lấy từ `ODOO_MEMBER_KEY_TTL_DAYS`, mặc định 90), mã hóa và lưu, rồi `revoke_member_keys(keep_newest=True)`. Cuối cùng phát NATS `platform.odoo_credentials.changed` `{membership_id}`.
- **Tắt membership:** gọi `disable_member`, đặt `status = disabled`, xóa `api_key_enc`, phát NATS.
- **Tenant chưa có database Odoo** (ví dụ `demo_fnb2`): đặt `status = pending`, không báo lỗi.
- **Odoo lỗi:** đặt `status = error` kèm `last_error`. API quản trị vẫn trả thành công cho phần dữ liệu `platform`, kèm `"odoo_sync": "error"`.
- **Xoay vòng tự động:** mỗi lần khởi động và sau đó mỗi 24 giờ, cấp key mới cho các key còn dưới 14 ngày, và thử lại các bản ghi `error`.
- `make up` gọi CLI đồng bộ cho `demo_fnb` sau bước tạo tenant mẫu.

### 5. Gateway gọi Odoo bằng key của thành viên

- `OdooService.callJson2` nhận ngữ cảnh `{tenantCode, membershipId}` lấy từ token (`tid`, `mid`). Không còn đọc `ODOO_DEV_API_KEY`.
- `OdooCredentialService` đọc `membership_odoo_users` theo `membership_id`, kiểm tra:
  - `tenant_id` khớp với tenant trong token; không khớp thì `403 TENANT_MISMATCH` và ghi log cảnh báo;
  - `status = active` và key chưa hết hạn; không đạt thì `403 ODOO_USER_NOT_PROVISIONED`.
- Key đã giải mã chỉ giữ trong bộ nhớ, tối đa 60 giây. Nhận NATS `platform.odoo_credentials.changed` thì xóa cache của membership đó ngay.
- Odoo trả `401`: xóa cache, đọc lại key một lần rồi gọi lại. Vẫn `401` thì trả `502 ODOO_AUTH_FAILED`.
- Gỡ `ODOO_DEV_API_KEY` khỏi `.env.example`, Compose, script, code và test.

### 6. Compose, Makefile, CI

- Sinh khóa `odoo_credentials.key` cùng các khóa khác; CI dựng toàn bộ hệ thống và chạy kịch bản ở mục "Tiêu chí nghiệm thu".
- Kiểm tra quyền database: `iteso_gateway` đọc được 6 cột cho phép của `membership_odoo_users`; đọc `api_key_enc` của bảng hệ thống, `accounts` hay `refresh_tokens` đều bị từ chối.

### 7. Báo cáo những gì đã kiểm trên Odoo 20

Ghi trong báo cáo: chữ ký hàm sinh API key, giới hạn thời hạn key, và cách gọi phương thức của model trừu tượng qua JSON-2 (đường dẫn và định dạng body đã chạy được thật).

### 8. Tồn đọng từ TASK-003

1. **Thu hồi cả họ refresh token khi phát hiện xoay vòng đồng thời:** việc thu hồi phải được ghi lại kể cả khi transaction xoay vòng bị hủy (ghi sau khi transaction kết thúc, hoặc bằng transaction riêng). Có test chứng minh: sau khi phát hiện, cả họ token đều bị thu hồi.
2. **Khóa mã hóa dùng cho test** chuyển khỏi `auth.service.ts` sang file thiết lập test. Code chính không còn giá trị khóa nào.
3. **Mã TOTP chỉ dùng được một lần:** lưu bước thời gian (time-step) đã dùng gần nhất của mỗi tài khoản; mã thuộc bước đã dùng hoặc cũ hơn thì bị từ chối.
4. **`jti` của `selection_token`/`challenge_token`** lưu trong Redis (`SET NX` có TTL 5 phút) thay cho bộ nhớ.
5. **Proxy `/v1/auth/*`** chuyển IP thật của client (`X-Forwarded-For`) và `User-Agent` sang control-plane. Control-plane chỉ tin `X-Forwarded-For` khi request đến từ gateway, và ghi hai giá trị này vào `refresh_tokens.ip` và `refresh_tokens.user_agent`.

## Test tự động bắt buộc (dùng logic thật, chỉ giả lập database/mạng khi cần)

- Gateway: cache 60 giây; NATS xóa cache; `tenant_id` không khớp; `status` khác `active`; key hết hạn; Odoo `401` rồi thử lại một lần.
- Control-plane: hợp nhóm quyền từ nhiều vai trò; thứ tự cấp key rồi mới thu hồi key cũ; tenant chưa có Odoo thì `pending`; Odoo lỗi thì `error`; chọn đúng các key cần xoay vòng.
- Odoo: test của module `iteso_base` như mục 1.
- Các test của mục 8.
- **Nhắc lại bài học TASK-002:** không giả lập chính phần đang cần kiểm. Kiểm tra với Odoo thật phải nằm trong kịch bản nghiệm thu của CI, không thay bằng mock.

## Tiêu chí nghiệm thu (chạy trong CI, dán output thật vào báo cáo)

1. `make reset` rồi `make up` chạy xong. `grep -rn ODOO_DEV_API_KEY` trong repo (trừ `docs/`) không còn kết quả.
2. Trong database `t_demo_fnb`: có người dùng `iteso-<mid>` cho `owner@demo.local` và `cashier@demo.local`, `active = true`, mỗi người đúng 1 key `iteso-gateway`, và không ai thuộc `base.group_system` trừ `admin` và `iteso_system`.
3. Token của `owner@demo.local` gọi `GET /v1/odoo/version` được `200`. Response có thêm trường `odoo_uid` trùng với uid của `iteso-<mid của owner>`.
4. Super Admin gọi `PUT /admin/tenants/demo_fnb/memberships/<mid của owner>` với `{status:"disabled"}`. Trong vòng 2 giây, cùng access token cũ gọi `/v1/odoo/version` nhận `403 ODOO_USER_NOT_PROVISIONED`, và trong Odoo người dùng đó có `active = false`, không còn key. Bật lại thì gọi được `200`.
5. Gọi trực tiếp Odoo JSON-2 bằng key của `iteso-<mid>` tới `iteso.provisioning/provision_member` bị từ chối (`AccessError`).
6. Chạy đồng bộ hai lần liên tiếp không sinh người dùng hay key trùng.
7. `multi@demo.local` ở tenant `demo_fnb2` có `status = pending`.
8. Kiểm tra quyền database của `iteso_gateway` như mục 6.
9. Các kịch bản nghiệm thu của TASK-002 và TASK-003 vẫn đạt.
10. `make test` xanh; CI xanh; lịch sử Git không có key, mật khẩu hay bí mật thật.

## Mẫu báo cáo

Ghi vào `docs/tasks/TASK-004-report.md`, cùng mẫu với các task trước, kèm mục 7 và mọi chỗ làm khác phiếu.

## Quy tắc

- Chỗ nào phiếu chưa rõ hoặc thấy cần làm khác: dừng lại và hỏi, không tự đổi hướng.
- Không merge. Claude kiểm duyệt và merge khi CI xanh.
