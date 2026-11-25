# ADR-005: Định danh và phân quyền

- Trạng thái: Đã duyệt (Product Owner, 25/11/2026)
- Ngày: 25/11/2026
- Liên quan: ADR-001, ADR-002, ADR-004

## Bối cảnh

Người dùng đăng nhập vào app và web của ITESO, không vào Odoo. Một người có thể làm cho nhiều doanh nghiệp (ví dụ kế toán dịch vụ). Nhân viên nhà hàng dùng chung máy POS, đổi ca liên tục, và phải đăng nhập được cả khi mất mạng. Mỗi doanh nghiệp tự đặt vai trò cho nhân viên của mình.

Ba cách đã xét:

| Cách | Vì sao không chọn / chọn |
| --- | --- |
| Đăng nhập bằng tài khoản Odoo | Không chọn: tài khoản Odoo nằm riêng trong từng database, không có tài khoản dùng chung nhiều doanh nghiệp, giao diện đăng nhập bị gắn với Odoo |
| Dựng Keycloak làm máy chủ định danh | Không chọn lúc này: nặng cho laptop 16 GB, thêm một hệ thống phải vận hành. Vẫn chuyển sang được sau vì gateway dùng chuẩn OIDC/JWT |
| **Dịch vụ định danh của ITESO trong control plane** | **Chọn**: nhẹ, kiểm soát hoàn toàn, hỗ trợ được đăng nhập PIN và offline cho POS |

## Quyết định

### 1. Tài khoản và thành viên
- **Tài khoản (account)** là toàn cục, lưu trong database `platform`: email hoặc số điện thoại, mật khẩu băm bằng Argon2id, xác thực hai lớp (TOTP) tùy chọn.
- **Thành viên (membership)** gắn một tài khoản vào một tenant, kèm vai trò, phạm vi chi nhánh và trạng thái. Một tài khoản có nhiều membership, nên một người làm cho nhiều doanh nghiệp vẫn dùng một tài khoản.
- Mỗi membership liên kết với một người dùng Odoo (`res.users`) trong database của tenant đó. Control plane tự tạo người dùng Odoo này; người dùng cuối không bao giờ thấy hay đăng nhập vào Odoo.

### 2. Đăng nhập
- `POST /v1/auth/login`: đăng nhập bằng email/điện thoại + mật khẩu. Nếu tài khoản thuộc nhiều tenant thì chọn tenant ở bước tiếp theo.
- Gateway cấp **access token** (JWT, sống 15 phút) chứa tài khoản, tenant, vai trò; và **refresh token** (30 ngày, đổi mới sau mỗi lần dùng, lưu dạng băm, thu hồi được).
- Khóa ký JWT dùng thuật toán bất đối xứng (EdDSA), xoay vòng được.

### 3. Máy POS dùng chung và chế độ offline
- **Ghép thiết bị:** quản lý ghép máy POS vào một chi nhánh một lần, máy nhận **device token** dài hạn, thu hồi được từ trang quản trị.
- **Đăng nhập nhanh bằng PIN** trên máy đã ghép: nhân viên nhập PIN 4–6 số để vào ca, đổi người trong vài giây.
- **Offline:** máy lưu sẵn danh sách nhân viên của chi nhánh kèm PIN đã băm, nên mất mạng vẫn đăng nhập và bán được. Mọi thao tác offline ghi kèm người làm; khi có mạng, sync engine đẩy lên và gateway kiểm tra lại quyền.
- Nhập sai PIN 5 lần thì khóa nhân viên đó trên máy trong 5 phút.

### 4. Phân quyền
- **Quyền** là khóa dạng `<nhóm>.<hành động>`, ví dụ `pos.order.create`, `pos.order.void`, `pos.discount.apply`, `report.revenue.view`, `settings.manage`.
- **Vai trò** là tập quyền. ITESO cung cấp vai trò mẫu (Chủ, Quản lý, Thu ngân, Phục vụ, Bếp, Kế toán); **mỗi tenant tự tạo và sửa vai trò** trong trang quản trị.
- Vai trò **Chủ** luôn có toàn quyền trong tenant và không bị người khác gỡ.
- **Gateway kiểm tra quyền ở mỗi endpoint**, cùng chỗ với kiểm tra cờ tính năng (ADR-004). Endpoint phải khai báo cả khóa tính năng lẫn khóa quyền; kiểm duyệt từ chối endpoint thiếu khai báo.

### 5. Gateway gọi Odoo bằng quyền của ai
- **Gateway gọi Odoo bằng chính người dùng Odoo của membership đang thao tác**, dùng API key riêng của người dùng đó. API key được mã hóa trong database `platform`, khóa giải mã nằm trong biến môi trường, không nằm trong database.
- Vai trò ITESO được ánh xạ sang vài nhóm quyền Odoo thô (Bán hàng, Quản lý bán hàng, Kế toán, Quản trị). Quyền chi tiết do gateway kiểm tra; Odoo là lớp chặn thứ hai.
- **Không dùng một tài khoản kỹ thuật có toàn quyền** để gọi Odoo thay mọi người. Cách đó bỏ qua phân quyền của Odoo, và nhật ký của Odoo (người tạo, người sửa) sẽ không cho biết ai thật sự làm.
- Ngoại lệ duy nhất là tác vụ hệ thống (nâng cấp module, nạp dữ liệu demo, tạo tenant). Các tác vụ này dùng tài khoản hệ thống riêng và ghi nhật ký.

### 6. Super Admin nền tảng
- Tài khoản quản trị nền tảng tách riêng khỏi tài khoản tenant, **bắt buộc xác thực hai lớp**.
- Super Admin quản lý tenant, cờ tính năng, nâng cấp. Khi cần xem dữ liệu của một tenant để hỗ trợ thì bật "phiên hỗ trợ" có thời hạn, và mọi thao tác trong phiên đều ghi nhật ký.

### 7. Khách gọi món qua QR
- Không cần tài khoản. Mã QR ở bàn chứa token có chữ ký (tenant, chi nhánh, bàn), đổi được từ trang quản trị khi cần.
- Mỗi lần quét tạo một phiên gắn với bàn, có giới hạn tần suất gửi đơn. Đơn của khách luôn chờ nhân viên xác nhận.

### 8. Thư viện
NestJS + Passport, `argon2` để băm, `jose` để ký và kiểm JWT.

## Hệ quả

- Tốt: một người một tài khoản cho nhiều doanh nghiệp; POS đổi ca nhanh và đăng nhập được khi mất mạng; vai trò do từng doanh nghiệp tự đặt; nhật ký Odoo ghi đúng người làm.
- Phải trả giá: ITESO tự giữ phần đăng nhập nên phải làm kỹ (băm mật khẩu, khóa ký, thu hồi token, giới hạn số lần thử). Khi có nhiều khách, có thể chuyển sang Keycloak mà không phải đổi app, vì app chỉ làm việc với JWT của gateway.

## Áp dụng

- Phần đăng nhập, tài khoản, membership, vai trò mẫu làm trong TASK-003 (sau khi TASK-002 dựng control plane), trước mọi tính năng nghiệp vụ.
- Quên mật khẩu (qua email hoặc Zalo OTP) là tính năng riêng, có cờ `auth.password_reset`. Trong giai đoạn dev, Super Admin đặt lại mật khẩu từ trang quản trị.
