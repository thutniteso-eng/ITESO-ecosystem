# TASK-007: Trang quản trị web nền và bảng điều khiển Super Admin

- Người giao: Claude (kiến trúc)
- Người làm: Antigravity
- Người duyệt cuối: Product Owner
- Giai đoạn: GĐ 1 — Lõi F&B (task đầu tiên)
- Căn cứ: ADR-008 (bắt buộc đọc trước), ADR-004, ADR-005; Kế hoạch GĐ 1

## Mục tiêu

PO mở `http://localhost:3001` trên laptop hoặc điện thoại, đăng nhập Super Admin bằng mật khẩu và mã 6 số, rồi:
- xem danh sách doanh nghiệp;
- bật/tắt tính năng cho toàn nền tảng và cho từng doanh nghiệp;
- xem nhật ký thao tác quản trị.

Người dùng doanh nghiệp đăng nhập được và thấy trang chào có tên, doanh nghiệp và vai trò của mình. Phần quản lý nhân viên làm ở TASK-008.

## Vị trí làm việc

`~/projects/ITESO-ecosystem` (WSL), kéo `main` mới nhất, nhánh `task/TASK-007-admin-web`. Nếu `make up` báo thiếu bảng thì chạy `make reset` (TASK-006 đã sửa migration `0005`).

## Việc cần làm

### 1. Khung `apps/admin-web` và `packages/ui`

- Next.js App Router, TypeScript strict, ESLint và Prettier theo cấu hình chung của repo; chạy được với `pnpm` và Turborepo.
- Tailwind và các thành phần tối thiểu trong `packages/ui`: nút, ô nhập, công tắc bật/tắt, bảng, thông báo, khung trang có menu (thu gọn trên điện thoại).
- Đa ngôn ngữ: tiếng Việt mặc định, mọi chuỗi chữ nằm trong file dịch, có sẵn cấu trúc cho tiếng Anh.
- Header bảo mật theo ADR-008 mục 2.

### 2. Đăng nhập theo mô hình BFF (ADR-008 mục 2)

**Trang `/login`:**
- Nhập email hoặc số điện thoại và mật khẩu.
- Nếu là Super Admin thì sang trang nhập mã 6 số.
- Nếu là người dùng doanh nghiệp có nhiều doanh nghiệp thì sang trang chọn doanh nghiệp; có một thì vào thẳng.

**Cookie phiên:**
- Mã hóa AES-256-GCM bằng `infra/secrets/admin_web_session.key`. `generate-keys.sh` sinh khóa, `chmod 600`, chủ sở hữu uid 1000.
- Thiếu khóa hoặc khóa sai độ dài thì admin-web **dừng khi khởi động**.
- Cờ cookie đúng như ADR-008.

**Trong phiên:**
- Server tự làm mới token khi hết hạn; refresh thất bại thì xóa cookie và quay về `/login`.
- `/logout` gọi `/v1/auth/logout` rồi xóa cookie.

**Hiển thị lỗi bằng tiếng Việt**, không lộ chi tiết kỹ thuật: sai thông tin, tài khoản bị khóa tạm thời, mã 6 số sai, hết phiên.

**Chống CSRF:** route thay đổi dữ liệu kiểm tra `Origin`.

### 3. Khu vực Super Admin `/platform`

- **Doanh nghiệp:** danh sách gồm mã, tên, trạng thái, ngày tạo, số thành viên.
- **Tính năng toàn nền tảng:**
  - danh sách khóa tính năng theo nhóm, có `implementation_status` và công tắc bật/tắt cấp platform;
  - tính năng `not_implemented` hiển thị nhãn "Chưa có" và không bật được.
- **Tính năng theo doanh nghiệp:** mỗi khóa có 3 lựa chọn: **Theo mặc định**, **Bật**, **Tắt**. Hiển thị giá trị đang có hiệu lực.
- **Nhật ký quản trị:** bảng có lọc theo thời gian, người làm, loại thao tác, phân trang 50 dòng một trang.
- Mọi thao tác bật/tắt phải ghi vào `admin_audit_log` (như TASK-002) và hiện ngay trong nhật ký.

### 4. Khu vực doanh nghiệp `/t/<mã>`

- Trang chào: tên người dùng, tên doanh nghiệp, vai trò, danh sách tính năng đang bật.
- Menu chỉ hiện mục người đó có quyền; các mục của TASK-008 hiện "Sắp có".
- Người dùng doanh nghiệp vào `/platform` thì nhận `403`; Super Admin vào `/t/...` thì được chuyển về `/platform`. Phiên hỗ trợ tenant để sau.

### 5. API bổ sung (control-plane)

- `GET /admin/tenants` trả thêm số thành viên và ngày tạo.
- `GET /admin/audit-log?from&to&actor&action&page`: chỉ Super Admin; phân trang; có test.
- Gắn decorator OpenAPI cho mọi endpoint mà admin-web dùng, ở cả control-plane và gateway.

### 6. `packages/api-client` (ADR-008 mục 4)

- Lệnh `pnpm gen:api` sinh client từ OpenAPI của hai service.
- CI chạy lại lệnh này rồi `git diff --exit-code`.

### 7. Compose, Makefile, CI

- Service `admin-web` trong Compose: cổng `127.0.0.1:3001`, mount khóa phiên, gọi control-plane và gateway qua mạng nội bộ; `make up` khởi động cùng các service khác.
- Job CI mới: Playwright chạy với hệ thống thật. Ảnh chụp màn hình của mỗi kịch bản (cả khổ điện thoại 390 px và khổ máy tính) được upload thành artifact `admin-web-screenshots`.

### 8. Tồn đọng từ TASK-006

1. `InternalTokenGuard` và gateway: thiếu `internal_api.token` hoặc token không đủ 32 byte thì **dừng khi khởi động**.
2. Giải mã key Odoo thất bại trả `retry` (lỗi cấu hình), không trả `MEMBER_DISABLED`.

## Test bắt buộc

- **Đơn vị:**
  - mã hóa và giải mã cookie, cookie bị sửa thì bị từ chối;
  - làm mới token;
  - kiểm tra `Origin`;
  - phân trang nhật ký.
- **Playwright (end-to-end, hệ thống thật):**
  1. Super Admin đăng nhập bằng mật khẩu và mã 6 số. Mã được sinh trong test từ bí mật của Super Admin tạo riêng cho CI, không dùng tài khoản thật của PO.
  2. Nhập sai mã 6 số thì hiện lỗi, không vào được.
  3. Tắt `pos.devices` cho `demo_fnb` thì một dòng mới xuất hiện trong nhật ký, và gọi API ghép máy của `demo_fnb` trả `403`. Bật lại thì chạy bình thường.
  4. `owner@demo.local` đăng nhập, thấy trang chào đúng tên, doanh nghiệp và vai trò; vào `/platform` thì bị chặn.
  5. Cookie có `HttpOnly` và `SameSite=Strict`; JavaScript trên trang (`document.cookie`, `localStorage`) không đọc được token nào.
  6. Đăng xuất xong, bấm Back không vào lại được trang cần đăng nhập.
- Không giả lập chính phần đang kiểm.

## Tiêu chí nghiệm thu (dán output thật và đường dẫn artifact ảnh chụp vào báo cáo)

1. `make up` rồi mở `http://localhost:3001`, đăng nhập Super Admin bằng mật khẩu và mã 6 số chạy đúng trên laptop.
2. Cả 6 kịch bản Playwright đạt trong CI; có artifact ảnh chụp ở khổ điện thoại và khổ máy tính.
3. Không có token nào trong `localStorage`, `sessionStorage` hay cookie đọc được bằng JavaScript.
4. CI kiểm tra `api-client` khớp với OpenAPI.
5. Mọi kịch bản nghiệm thu của GĐ 0 vẫn đạt; `make test` và CI xanh; repo không có khóa hay mật khẩu thật.

## Mẫu báo cáo

Ghi vào `docs/tasks/TASK-007-report.md` như các task trước, kèm link artifact ảnh chụp.

## Quy tắc

- Chỗ nào phiếu chưa rõ hoặc thấy cần làm khác: dừng lại và hỏi, không tự đổi hướng.
- Không merge. Claude kiểm duyệt và merge khi CI xanh.
