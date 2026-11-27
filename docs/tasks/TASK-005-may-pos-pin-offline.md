# TASK-005: Ghép máy POS, đăng nhập bằng PIN, danh sách nhân viên cho chế độ offline

- Người giao: Claude (kiến trúc)
- Người làm: Antigravity
- Người duyệt cuối: Product Owner
- Giai đoạn: GĐ 0 — Nền móng
- Căn cứ: ADR-005 mục 3 và mục "Bổ sung khi triển khai (27/11/2026 — TASK-005)", ADR-004, ADR-006

## Mục tiêu

Làm phần **máy chủ** cho máy POS dùng chung. Chưa có app POS: mọi bước được kiểm bằng script giả lập máy POS trong CI. Sau task này:

- Quản lý ghép một máy POS vào một chi nhánh bằng mã ghép dùng một lần. Máy nhận **device token** dài hạn, thu hồi được.
- Trên máy đã ghép, nhân viên đăng nhập bằng **PIN 6 số** để vào ca và đổi người trong vài giây.
- Máy tải được **danh sách nhân viên của chi nhánh** (có chữ ký số) để đăng nhập khi mất mạng.
- Thu hồi máy thì mọi phiên trên máy đó mất hiệu lực ngay.

Không làm: app POS, bán hàng, sync engine (việc đẩy dữ liệu offline lên máy chủ thuộc GĐ 1), cài module POS của Odoo.

## Vị trí làm việc

`~/projects/ITESO-ecosystem` (WSL). Kéo `main` mới nhất, làm trên nhánh `task/TASK-005-pos-devices`.

## Quyết định kiến trúc (đã chốt, không tự đổi)

1. **Chi nhánh** là một bảng riêng trong `platform`. `memberships.branch_scope` chứa mã chi nhánh; mảng rỗng nghĩa là mọi chi nhánh.
2. **Device token:** chuỗi ngẫu nhiên 32 byte. Control-plane chỉ lưu bản băm SHA-256. Header gửi lên: `Authorization: Device <token>`.
3. **PIN:** đúng 6 chữ số. Mỗi membership một PIN, băm bằng argon2id với cùng tham số như mật khẩu. Từ chối PIN dễ đoán: 6 số giống nhau, dãy tăng hoặc giảm liên tiếp, và 6 số cuối của số điện thoại tài khoản.
4. **Phiên PIN:**
   - Access token 15 phút có thêm các claim `did` (mã máy), `bid` (mã chi nhánh), `amr: ["pin"]`.
   - Refresh token **gắn với máy**, sống tối đa 12 giờ tính từ lúc nhập PIN, có xoay vòng và phát hiện dùng lại như TASK-003.
   - Hết 12 giờ phải nhập lại PIN.
5. **Danh sách nhân viên cho offline (roster):**
   - Control-plane ký bằng khóa Ed25519 hiện có, dạng JWS, có `exp` sau 24 giờ.
   - Roster chỉ chứa nhân viên đang hoạt động, thuộc chi nhánh của máy, có quyền `pos.session.open` và đã đặt PIN. Mỗi người gồm: `membership_id`, tên hiển thị, danh sách quyền và hash PIN argon2id.
   - **Rủi ro chấp nhận:** ai chiếm được máy thì có thể dò PIN từ roster. PIN chỉ là lớp tiện lợi cho thao tác POS tại chi nhánh; máy chủ sẽ kiểm tra lại quyền khi đồng bộ (GĐ 1). Roster hết hạn sau 24 giờ để giới hạn thiệt hại.
6. **Gateway kiểm tra máy:**
   - Token có `did` thì gateway kiểm tra máy còn hiệu lực trong bảng `pos_devices`. Gateway chỉ được đọc các cột `id`, `tenant_id`, `branch_id`, `status`.
   - Cache 30 giây, và xóa ngay khi nhận NATS `platform.devices.changed`.

## Việc cần làm

### 1. Dữ liệu (migration mới)

| Bảng | Cột chính |
| --- | --- |
| `branches` | `id`, `tenant_id`, `code` (duy nhất trong tenant), `name`, `status` (`active`/`disabled`), `created_at` |
| `pos_devices` | `id`, `tenant_id`, `branch_id`, `name`, `token_hash` (duy nhất), `status` (`active`/`revoked`), `paired_by_membership_id`, `paired_at`, `last_seen_at`, `revoked_at` |
| `pos_pairing_codes` | `id`, `tenant_id`, `branch_id`, `device_name`, `code_hash`, `created_by_membership_id`, `expires_at` (10 phút), `used_at` |
| `membership_pins` | `membership_id` (PK), `pin_hash`, `updated_at`, `failed_attempts`, `locked_until` |
| `refresh_tokens` (thêm cột) | `device_id` (null nếu không phải phiên PIN) |

Quyền của `iteso_gateway`: chỉ thêm `SELECT (id, tenant_id, branch_id, status)` trên `pos_devices`.

### 2. Quyền và tính năng (seed)

- Quyền mới:
  - `pos.device.manage`: ghép, xem, thu hồi máy;
  - `pos.session.open`: đăng nhập POS bằng PIN;
  - `staff.pin.reset`: xóa PIN của nhân viên.
- Vai trò mẫu:
  - Chủ và Quản lý: cả 3 quyền;
  - Thu ngân, Phục vụ, Bếp: `pos.session.open`;
  - Kế toán: không có quyền nào trong 3 quyền này.
- Tính năng mới `pos.devices` (nhóm `pos`): `implementation_status = available`, platform bật, mặc định bật cho tenant. Mọi endpoint ở mục 3 và 4 khai báo `@RequireFeature('pos.devices')`.
- Seed chi nhánh `main` ("Chi nhánh chính") cho `demo_fnb` và `demo_fnb2`.

### 3. Endpoint (control-plane xử lý, gateway chuyển tiếp như `/v1/auth/*`)

| Endpoint | Xác thực | Việc |
| --- | --- | --- |
| `POST /v1/pos/pairing-codes` `{branch_code, device_name}` | Access token có `pos.device.manage` | Tạo mã ghép 8 ký tự (chữ hoa và số, bỏ các ký tự dễ nhầm `0 O 1 I`), hạn 10 phút. Trả mã **một lần** |
| `POST /v1/pos/devices/pair` `{pairing_code}` | Public, giới hạn 10 lần/phút/IP | Mã đúng, còn hạn và chưa dùng thì tạo máy, trả `{device_id, device_token, branch, roster_public_jwk}`. Mã bị đánh dấu đã dùng **nguyên tử** |
| `GET /v1/pos/devices` | `pos.device.manage` | Danh sách máy của tenant (không có token) |
| `DELETE /v1/pos/devices/:id` | `pos.device.manage` | Thu hồi máy: đặt `revoked`, thu hồi mọi refresh token có `device_id` này, phát NATS `platform.devices.changed`, ghi audit |
| `PUT /v1/me/pin` `{pin, password}` | Access token đăng nhập bằng mật khẩu (`amr` có `pwd`) | Đặt hoặc đổi PIN; bắt buộc nhập lại mật khẩu |
| `DELETE /v1/staff/:membership_id/pin` | `staff.pin.reset` | Xóa PIN của nhân viên trong cùng tenant |
| `POST /v1/pos/auth/pin` `{membership_id, pin}` | `Authorization: Device <token>` | Đăng nhập PIN như mục 4 |
| `POST /v1/pos/auth/refresh` `{refresh_token}` | `Authorization: Device <token>` | Xoay vòng refresh token của phiên PIN; token phải thuộc đúng máy |
| `GET /v1/pos/roster` | `Authorization: Device <token>` | Trả roster JWS như "Quyết định" 5; cập nhật `last_seen_at` |

### 4. Đăng nhập bằng PIN: thứ tự kiểm tra

1. Device token hợp lệ và máy đang `active`; tenant và chi nhánh của máy đang hoạt động.
2. Membership thuộc tenant của máy, đang `active`, có chi nhánh của máy trong `branch_scope` (hoặc `branch_scope` rỗng), và có quyền `pos.session.open`.
3. PIN đã đặt và chưa bị khóa. Sai PIN thì tăng `failed_attempts` **nguyên tử**; sai 5 lần thì khóa 5 phút. Mọi lỗi ở bước 2–3 đều trả chung `401 INVALID_PIN`, có chạy argon2 giả như TASK-003 để không lộ thông tin qua thời gian phản hồi.
4. Cấp access token (mục "Quyết định" 4) và refresh token gắn máy.

### 5. Gateway

- `AuthGuard`: token có `did` thì kiểm tra máy theo "Quyết định" 6; máy bị thu hồi thì `401 DEVICE_REVOKED`. Có `bid` thì nó phải nằm trong tenant của token.
- Gỡ test cũ nếu nó giả định token luôn đến từ mật khẩu.

### 6. Tồn đọng từ TASK-004

1. Siết biểu thức kiểm tra key hệ thống Odoo về đúng `^[0-9a-f]{40}_oak$` (theo mã nguồn Odoo 20 đã đọc).
2. Thêm kịch bản nghiệm thu: lấy `challenge_token`, khởi động lại control-plane, dùng lại `challenge_token` thì bị từ chối.

## Test tự động bắt buộc

- PIN dễ đoán bị từ chối; đặt PIN thiếu mật khẩu hoặc dùng token PIN để đặt PIN thì bị từ chối.
- Mã ghép: hết hạn, dùng lại, hai request ghép đồng thời cùng một mã (chỉ một request thành công).
- Đăng nhập PIN:
  - sai chi nhánh;
  - thiếu quyền;
  - membership bị tắt;
  - khóa sau 5 lần sai và mở lại sau 5 phút (giả lập thời gian);
  - `401 INVALID_PIN` giống hệt nhau cho mọi nguyên nhân.
- Roster: chỉ đúng người và đúng chi nhánh, chữ ký kiểm được bằng `roster_public_jwk`, có `exp`.
- Thu hồi máy: refresh token gắn máy bị thu hồi; gateway trả `DEVICE_REVOKED` trong vòng 2 giây.
- Bài học cũ vẫn áp dụng: không giả lập chính phần đang kiểm; các kịch bản đầu-cuối chạy với hệ thống thật trong CI.

## Tiêu chí nghiệm thu (chạy trong CI, dán output thật vào báo cáo)

1. `owner@demo.local` tạo mã ghép cho chi nhánh `main`; script giả lập máy ghép thành công và nhận `device_token`.
2. `cashier@demo.local` đăng nhập bằng mật khẩu và đặt PIN. Máy đăng nhập bằng PIN của cashier, rồi gọi `GET /v1/odoo/version` thì nhận `403` vì thiếu quyền `system.diagnostics.view`. Kết quả này chứng minh token PIN mang đúng quyền của người.
3. Owner đặt PIN; máy đăng nhập bằng PIN của owner và gọi `/v1/odoo/version` được `200`, `odoo_uid` là của owner.
4. Đổi người trên cùng máy (cashier rồi owner rồi cashier) xong trong 3 lần gọi API, không cần mật khẩu.
5. Sai PIN 5 lần thì lần thứ 6 bị khóa, kể cả khi PIN đúng.
6. Roster tải về chứa owner và cashier, không chứa ai không có quyền `pos.session.open` hay chưa đặt PIN. Script kiểm được chữ ký và dùng hash trong roster xác minh đúng PIN mà không gọi máy chủ.
7. Owner thu hồi máy: trong vòng 2 giây, mọi access token mang `did` của máy nhận `401 DEVICE_REVOKED`, refresh gắn máy bị từ chối, và `GET /v1/pos/roster` bằng device token cũ bị từ chối.
8. Mã ghép dùng lần hai hoặc quá 10 phút đều bị từ chối.
9. Kịch bản nghiệm thu của TASK-002, TASK-003 và TASK-004 vẫn đạt; quyền database của `iteso_gateway` đúng như mục 1.
10. `make test` xanh; CI xanh; repo không có token, PIN hay mã bí mật thật.

## Mẫu báo cáo

Ghi vào `docs/tasks/TASK-005-report.md` như các task trước.

## Quy tắc

- Chỗ nào phiếu chưa rõ hoặc thấy cần làm khác: dừng lại và hỏi, không tự đổi hướng.
- Không merge. Claude kiểm duyệt và merge khi CI xanh.
