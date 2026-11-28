# Báo cáo TASK-007: Trang quản trị web nền và bảng điều khiển Super Admin

## Đã làm

1. **Khắc phục triệt để Backlog từ TASK-006:**
   - **Internal Token Guard & Gateway halt:** Cập nhật [services/control-plane/src/auth/internal-token.guard.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/auth/internal-token.guard.ts) và [services/gateway/src/sync/sync.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/sync/sync.service.ts) để kiểm tra bắt buộc token nội bộ `internal_api.token` phải tồn tại và có độ dài chính xác 32 bytes; ném lỗi nghiêm trọng và dừng khởi động nếu thiếu hoặc không đúng chuẩn.
   - **Lỗi giải mã key Odoo trả về `retry`:** Cập nhật [services/gateway/src/odoo/odoo-credential.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/odoo/odoo-credential.service.ts) và [services/gateway/src/sync/sync.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/sync/sync.service.ts): khi giải mã API key Odoo thất bại (lỗi cấu hình/khóa mã hóa), hệ thống trả về mã trạng thái `retry` (lỗi hệ thống có thể thử lại sau) thay vì báo `MEMBER_DISABLED`.

2. **OpenAPI Spec & `packages/api-client` (Tự động sinh từ spec):**
   - Tích hợp `@nestjs/swagger` vào `control-plane` và `gateway`.
   - Viết CLI export OpenAPI specs:
     - `services/control-plane/src/cli/export-openapi.ts` -> xuất `services/control-plane/openapi.json`.
     - `services/gateway/src/cli/export-openapi.ts` -> xuất `services/gateway/openapi.json`.
   - Xây dựng package [packages/api-client](file:///home/iteso/projects/ITESO-ecosystem/packages/api-client) sử dụng `openapi-typescript` để sinh mã TypeScript types đầy đủ và định nghĩa hai typed client wrapper `ControlPlaneClient` và `GatewayClient`.
   - Thêm lệnh `pnpm gen:api` ở root workspace và bổ sung bước kiểm tra tự động `git diff --exit-code packages/api-client` vào CI GitHub Actions để đảm bảo client luôn đồng bộ 100% với backend.

3. **Thư viện Giao diện dùng chung `packages/ui`:**
   - Xây dựng gói component dùng chung chuẩn Tailwind CSS: `Button`, `Input`, `Switch`, `Table`, `Badge`, `Alert`, và `AppLayout`.
   - Các components được gán đầy đủ `data-testid` để phục vụ kiểm thử E2E Playwright ổn định và chính xác.

4. **Ứng dụng Web Quản trị `apps/admin-web` (Next.js 15 App Router & BFF):**
   - **Mô hình BFF & Bảo mật phiên:**
     - Trình duyệt **tuyệt đối không bao giờ** lưu trữ hay tiếp cận `access_token` hoặc `refresh_token` (không có trong `localStorage`, `sessionStorage` hay `document.cookie`).
     - Quản lý phiên qua cookie `iteso_admin_session`: mã hóa AES-256-GCM với khóa bí mật 32 bytes từ `infra/secrets/admin_web_session.key`, thiết lập cờ `HttpOnly`, `SameSite=Strict`, `Secure`.
     - Ứng dụng dừng khởi động ngay lập tức nếu thiếu khóa bí mật `admin_web_session.key` hoặc khóa không đủ 32 bytes (đã kiểm chứng bằng test suite `session.spec.ts`).
     - Chống tấn công CSRF: xác thực chặt chẽ `Origin` / `Host` cho toàn bộ các route POST/PUT/DELETE chuyển tiếp API.
     - Thiết lập Content Security Policy (CSP) chặt chẽ trong `next.config.mjs`.
   - **Đa ngôn ngữ (i18n):**
     - Hỗ trợ tiếng Việt (`vi.json`, mặc định) và tiếng Anh (`en.json`) với đầy đủ các nhãn, thông báo lỗi nghiệp vụ.
   - **Các trang & Chức năng triển khai:**
     - `/login`: Đăng nhập hợp nhất hỗ trợ Super Admin (xác thực mật khẩu + bước 2 TOTP Google Authenticator) và thành viên tenant (chọn tenant nếu có nhiều chi nhánh).
     - `/platform/tenants`: Danh sách toàn bộ doanh nghiệp, trạng thái hoạt động, thông tin liên hệ và lối tắt quản lý cấu hình.
     - `/platform/tenants/[code]/features`: Bảng điều khiển bật/tắt (override) tính năng cho từng tenant (Bật/Tắt/Mặc định nền tảng), phản ánh hiệu lực tức thời.
     - `/platform/features`: Danh sách tính năng toàn nền tảng và trạng thái triển khai.
     - `/platform/audit-log`: Nhật ký thao tác quản trị viên ghi nhận actor UUID, hành động (ví dụ `UPDATE_TENANT_FEATURE`), đối tượng tác động và thời gian thực hiện.
     - `/t/[tenantCode]`: Bảng điều khiển dành riêng cho thành viên tenant (hiển thị lời chào, tên quán, vai trò người dùng, danh sách tính năng đang hoạt động); tự động chặn 403 nếu truy cập trái phép vào phân hệ `/platform`.
     - Phân quyền & Điều hướng: Tự động điều hướng và chặn truy cập trái phép giữa các vai trò Super Admin và Tenant Member.

5. **Container hóa & Docker Compose:**
   - Tạo `apps/admin-web/Dockerfile` tối ưu hóa chạy standalone Next.js.
   - Bổ sung service `admin-web` vào `infra/docker-compose.yml` (port 3001), phụ thuộc `control-plane` và `gateway`, có healthcheck endpoint `/api/health`.
   - Bổ sung script sinh khóa `admin_web_session.key` vào `scripts/generate-keys.sh` và `Makefile`.

6. **Kiểm thử E2E Playwright với Hệ thống thật (6/6 Kịch bản Đạt):**
   - Viết toàn bộ 6 kịch bản kiểm thử E2E trong [tests/e2e/admin-web.spec.ts](file:///home/iteso/projects/ITESO-ecosystem/tests/e2e/admin-web.spec.ts) chạy trực tiếp với Docker Compose stack thật (không mock).
   - Tự động chụp ảnh màn hình cho cả hai khổ hiển thị: Điện thoại di động (iPhone viewport: 390x844) và Máy tính bàn (Desktop viewport: 1280x800) lưu vào `artifacts/admin-web-screenshots/`.

---

## 6 Kịch bản Kiểm thử Nghiệm thu & Ảnh chụp Artifacts

Thư mục lưu trữ: `artifacts/admin-web-screenshots/`

| STT | Kịch bản nghiệm thu | Kết quả E2E | Artifact Ảnh chụp Desktop | Artifact Ảnh chụp Mobile |
|:---:|:---|:---:|:---|:---|
| 1 | Super Admin đăng nhập thành công với TOTP | **ĐẠT** | `scenario-1-super-admin-desktop.png` | `scenario-1-super-admin-mobile.png` |
| 2 | Super Admin nhập sai TOTP 6 số hiển thị lỗi tiếng Việt | **ĐẠT** | `scenario-2-invalid-totp-desktop.png` | `scenario-2-invalid-totp-mobile.png` |
| 3 | Super Admin bật/tắt cờ `pos.devices` cho `demo_fnb`, kiểm tra Gateway API và Audit Log | **ĐẠT** | `scenario-3-feature-toggle-desktop.png` | `scenario-3-feature-toggle-mobile.png` |
| 4 | `owner@demo.local` đăng nhập vào tenant và bị chặn 403 khi vào `/platform` | **ĐẠT** | `scenario-4-tenant-owner-desktop.png` | `scenario-4-tenant-owner-mobile.png` |
| 5 | Trình duyệt không lưu token trong `localStorage`, `sessionStorage`, `document.cookie` | **ĐẠT** | `scenario-5-token-security-desktop.png` | `scenario-5-token-security-mobile.png` |
| 6 | Đăng xuất xóa cookie và nút Back không thể vào lại trang nội bộ | **ĐẠT** | `scenario-6-logout-desktop.png` | `scenario-6-logout-mobile.png` |

---

## Output kiểm tra thực tế

### 1. Playwright E2E Tests (Hệ thống thật, 6/6 kịch bản ĐẠT)

```text
Running 6 tests using 1 worker

     1 …eb E2E Scenarios › Kịch bản 1: Super Admin đăng nhập thành công với TOTP
  ✓  1 …Scenarios › Kịch bản 1: Super Admin đăng nhập thành công với TOTP (2.5s)
     2 …ios › Kịch bản 2: Super Admin nhập sai TOTP 6 số hiển thị lỗi tiếng Việt
  ✓  2 …ịch bản 2: Super Admin nhập sai TOTP 6 số hiển thị lỗi tiếng Việt (2.5s)
     3 …in bật / tắt cờ pos.devices cho demo_fnb và kiểm tra Gateway + Audit log
  ✓  3 …/ tắt cờ pos.devices cho demo_fnb và kiểm tra Gateway + Audit log (4.5s)
     4 …ản 4: owner@demo.local đăng nhập vào tenant và bị chặn khi vào /platform
  ✓  4 …wner@demo.local đăng nhập vào tenant và bị chặn khi vào /platform (2.8s)
     5 …uyệt không lưu token trong localStorage, sessionStorage, document.cookie
  ✓  5 …ông lưu token trong localStorage, sessionStorage, document.cookie (2.9s)
     6 …h bản 6: Đăng xuất xóa cookie và nút Back không thể vào lại trang nội bộ
  ✓  6 …: Đăng xuất xóa cookie và nút Back không thể vào lại trang nội bộ (4.2s)

  6 passed (20.8s)
```

Danh sách file ảnh chụp artifact được tạo ra:
```text
-rw-r--r-- 1 iteso iteso  49K scenario-1-super-admin-desktop.png
-rw-r--r-- 1 iteso iteso  31K scenario-1-super-admin-mobile.png
-rw-r--r-- 1 iteso iteso  28K scenario-2-invalid-totp-desktop.png
-rw-r--r-- 1 iteso iteso  25K scenario-2-invalid-totp-mobile.png
-rw-r--r-- 1 iteso iteso 156K scenario-3-feature-toggle-desktop.png
-rw-r--r-- 1 iteso iteso 114K scenario-3-feature-toggle-mobile.png
-rw-r--r-- 1 iteso iteso  22K scenario-4-tenant-owner-desktop.png
-rw-r--r-- 1 iteso iteso  19K scenario-4-tenant-owner-mobile.png
-rw-r--r-- 1 iteso iteso  49K scenario-5-token-security-desktop.png
-rw-r--r-- 1 iteso iteso  31K scenario-5-token-security-mobile.png
-rw-r--r-- 1 iteso iteso  27K scenario-6-logout-desktop.png
-rw-r--r-- 1 iteso iteso  23K scenario-6-logout-mobile.png
```

### 2. Static Check, Build & Generator Đồng bộ (`pnpm lint && pnpm typecheck && pnpm test && pnpm gen:api && git diff --exit-code packages/api-client`)

```text
> turbo run lint
 Tasks:    7 successful, 7 total

> turbo run typecheck
 Tasks:    7 successful, 7 total

> turbo run test
@iteso/admin-web:test: PASS test/session.spec.ts
@iteso/admin-web:test: Test Suites: 1 passed, 1 total
@iteso/admin-web:test: Tests:       5 passed, 5 total
@iteso/gateway:test: Test Suites: 4 passed, 4 total
@iteso/gateway:test: Tests:       47 passed, 47 total
@iteso/control-plane:test: Test Suites: 3 passed, 3 total
@iteso/control-plane:test: Tests:       39 passed, 39 total
 Tasks:    5 successful, 5 total

> pnpm gen:api
[export-openapi] Control plane OpenAPI spec written to services/control-plane/openapi.json
[export-openapi] Gateway OpenAPI spec written to services/gateway/openapi.json
[api-client:gen] Generating TypeScript types from OpenAPI specs...
✨ openapi-typescript 7.13.0
🚀 services/control-plane/openapi.json → packages/api-client/src/control-plane.types.ts
✨ openapi-typescript 7.13.0
🚀 services/gateway/openapi.json → packages/api-client/src/gateway.types.ts
[api-client:gen] Types generated successfully.

> git diff --exit-code packages/api-client
(exit code 0 - không có sai lệch)
```

### 3. Tương thích Ngược: Kiểm tra Nghiệm thu TASK-005 và TASK-006

```text
=================================================================
ALL TASK-005 ACCEPTANCE CRITERIA PASSED SUCCESSFULLY (9/9)!
=================================================================
=================================================================
ALL TASK-006 ACCEPTANCE CRITERIA PASSED SUCCESSFULLY (12/12)!
=================================================================
```

### 4. Kiểm tra Không lọt Bí mật vào Git

```text
$ git check-ignore infra/secrets/* .env
infra/secrets/admin_web_session.key
infra/secrets/ed25519_private.pem
infra/secrets/ed25519_public.pem
infra/secrets/internal_api.token
infra/secrets/odoo_credentials.key
infra/secrets/platform_encryption.key
.env
```
