# ADR-006: Control plane và dữ liệu nền tảng

- Trạng thái: Đề xuất (chờ Product Owner duyệt)
- Ngày: 26/11/2026
- Liên quan: ADR-002, ADR-004, ADR-005

## Bối cảnh

ADR-002 và ADR-004 cần một nơi lưu danh sách tenant, cờ tính năng và nhật ký quản trị. ADR-005 cần thêm tài khoản và membership. Đây là dữ liệu của nền tảng, không phải dữ liệu nghiệp vụ của tenant, nên không nằm trong database Odoo của tenant nào.

## Quyết định

1. **Dịch vụ riêng `services/control-plane`** (NestJS, TypeScript). Dịch vụ này là nơi duy nhất **ghi** dữ liệu nền tảng.

2. **Database `platform`** trong cùng cụm PostgreSQL, thuộc sở hữu của role `iteso_control_plane`. Role này có `LOGIN`, không phải superuser, không tạo được database hay role.

3. **Gateway chỉ được đọc** những bảng cần thiết trong `platform` (`SELECT`), bằng role `iteso_gateway` đã có. Gateway không ghi vào `platform`. Đọc trực tiếp giúp mỗi request không phải gọi thêm một dịch vụ; cache 30 giây cộng sự kiện NATS (ADR-004) giữ dữ liệu luôn mới.

4. **Schema và migration:** dùng Drizzle ORM + drizzle-kit. Migration là file SQL trong repo, chạy tự động khi `make up`. Không sửa tay schema.

5. **Bảng ban đầu:**
   - `tenants`: mã, tên database, tên hiển thị, trạng thái (`active` / `suspended`), các gói ngành đã cài.
   - `feature_definitions`: khóa, nhóm, mô tả, trạng thái code (`available` / `not_implemented`), công tắc tầng nền tảng, giá trị mặc định cho tenant.
   - `tenant_features`: giá trị bật/tắt theo từng tenant.
   - `admin_audit_log`: ai làm gì, lúc nào, giá trị trước và sau, ghi chú.
   - Tài khoản, membership, vai trò (ADR-005) thêm ở TASK-003.

6. **API quản trị** của control plane chỉ mở trên `127.0.0.1`. **Tạm thời** được bảo vệ bằng một admin token đặt trong `.env`. TASK-003 sẽ thay bằng đăng nhập Super Admin có xác thực hai lớp. Admin token bị gỡ ở TASK-003.

7. **Mọi thay đổi cờ** đều ghi `admin_audit_log` và phát sự kiện NATS `platform.features.changed`. Gateway nhận sự kiện thì xóa cache ngay.

8. **Database của tenant không cho `PUBLIC` kết nối.** Mọi bước tạo database tenant phải chạy `REVOKE CONNECT ... FROM PUBLIC`, dùng chung một script.

## Hệ quả

- Tốt: dữ liệu nền tảng tách khỏi dữ liệu nghiệp vụ; quyền ghi tập trung một chỗ; gateway đọc nhanh.
- Phải trả giá: thêm một dịch vụ và một container (nhẹ, khoảng 50 MB RAM). Admin token tạm là điểm yếu có chủ đích, chỉ tồn tại trên laptop và phải gỡ ở TASK-003.
