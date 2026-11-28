# ADR-008: Giao diện — trang quản trị web và app POS

- Trạng thái: Đề xuất (chờ Product Owner duyệt)
- Ngày: 28/11/2026
- Liên quan: ADR-004, ADR-005, ADR-007; Kế hoạch GĐ 1 (đã duyệt)

## Bối cảnh

Từ GĐ 1 hệ thống có giao diện: trang quản trị web (Super Admin và chủ hoặc quản lý của từng doanh nghiệp) và app POS (điện thoại Android trước, theo quyết định của PO ngày 28/11/2026). Cần chốt công nghệ, cách đăng nhập an toàn trên trình duyệt, và cách giữ frontend luôn khớp với API, trước khi viết dòng giao diện đầu tiên.

## Quyết định

1. **Cấu trúc monorepo**
   - `apps/admin-web`: Next.js (bản ổn định mới nhất, App Router, TypeScript strict).
   - `apps/pos`: Expo / React Native (bản SDK ổn định mới nhất), build Android trước.
   - `packages/api-client`: kiểu dữ liệu và hàm gọi API **sinh tự động** từ OpenAPI.
   - `packages/ui`: màu, chữ, khoảng cách và các thành phần dùng chung.

2. **Đăng nhập trên web theo mô hình BFF (backend-for-frontend)**
   - Trình duyệt **không bao giờ giữ access token hay refresh token**. Server của Next.js gọi `/v1/auth/*` rồi cất token trong một **cookie phiên được mã hóa** (AES-256-GCM, khóa riêng `infra/secrets/admin_web_session.key`), có các cờ `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`.
   - Mọi lệnh gọi API đều đi từ server Next.js tới gateway hoặc control-plane. Server tự làm mới access token khi hết hạn.
   - Chống CSRF: `SameSite=Strict`, và các request thay đổi dữ liệu phải có header `Origin` trùng với địa chỉ của trang.
   - Thời hạn cookie bằng thời hạn phiên phía máy chủ: Super Admin tối đa 12 giờ (ADR-005); người dùng doanh nghiệp theo refresh token.
   - Bắt buộc có các header bảo mật: `Content-Security-Policy` (không có `unsafe-eval`; `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy`.

3. **Hai khu vực trên cùng một trang**
   - `/platform/*` dành cho Super Admin, dùng các API `/admin/*` của control-plane.
   - `/t/<mã tenant>/*` dành cho người dùng doanh nghiệp, đi qua gateway.
   - Giao diện ẩn mọi mục không đủ quyền hoặc có tính năng đang tắt. Đây chỉ là để dễ dùng: **máy chủ vẫn là nơi chặn**.

4. **Hợp đồng API**
   - Gateway và control-plane xuất OpenAPI từ code (decorator của NestJS).
   - `packages/api-client` sinh từ hai file đó.
   - CI chạy lệnh sinh lại client rồi `git diff --exit-code`: API đổi mà client không đổi theo thì CI đỏ.

5. **Giao diện chung**
   - Tailwind CSS và bộ thành phần tự quản trong `packages/ui` (kiểu shadcn/ui: chép code vào repo, không phụ thuộc thư viện đóng).
   - Tiếng Việt là mặc định, mọi chuỗi chữ nằm trong file dịch; tiếng Anh bổ sung dần.
   - Thiết kế cho điện thoại trước: trang quản trị dùng tốt trên màn hình 360 px.

6. **App POS** (chi tiết ở TASK-011)
   - Expo, SQLite (`expo-sqlite`) cho dữ liệu offline.
   - Device token cất trong Android Keystore (`expo-secure-store`); nhật ký thao tác theo ADR-007.
   - Máy in ESC/POS nối qua TCP trong mạng LAN (TASK-014).

7. **Kiểm thử giao diện**
   - Trang quản trị: test end-to-end bằng **Playwright** trong CI, chạy với hệ thống thật (Compose). Ảnh chụp màn hình của từng kịch bản được lưu thành artifact của CI để PO xem không cần cài gì.
   - App POS: test đơn vị bằng Jest; test end-to-end trên máy ảo Android sẽ chốt ở TASK-011.

8. **Chạy trên máy dev:** `admin-web` là một service trong Compose, cổng `127.0.0.1:3001`, khởi động cùng `make up`.

## Hệ quả

- **Tốt:**
  - Token không lộ ra JavaScript của trình duyệt, nên lỗi XSS cũng không lấy được phiên đăng nhập.
  - Frontend và backend không lệch nhau âm thầm.
  - PO xem được giao diện qua ảnh chụp trong CI hoặc qua `http://localhost:3001`.
- **Phải chấp nhận:**
  - Server Next.js là một chặng trung gian, thêm độ trễ nhỏ.
  - Thêm một khóa bí mật cần quản lý.
  - CI chạy lâu hơn vì có thêm Playwright.
