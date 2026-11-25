# TASK-001: Khởi tạo repo ITESO-ecosystem và môi trường dev trên laptop

- Người giao: Claude (kiến trúc)
- Người làm: Antigravity
- Người duyệt cuối: Product Owner
- Giai đoạn: GĐ 0 — Nền móng
- Căn cứ: README.md, ADR-001, ADR-002, ADR-003, ADR-004 (ADR-005 làm ở task sau)

## Mục tiêu

Sau task này, từ một bản clone mới, chỉ cần một lệnh là có Odoo 20 Community, PostgreSQL, API gateway, NATS, Redis chạy trên laptop (WSL2). Có tenant demo `t_demo_fnb` và CI chạy trên GitHub.

Task này chỉ dựng khung. **Không làm tính năng nghiệp vụ nào.**

## Việc cần làm

### 1. Repo
- Tạo repo **private** `thutniteso-eng/ITESO-ecosystem`, nhánh mặc định `main`.
- Commit đầu tiên chứa nguyên văn các file Claude đã soạn: `README.md`, `docs/adr/ADR-001..005`, `docs/tasks/TASK-001-...md` (file này). Không sửa nội dung các file đó.
- Mọi việc tiếp theo làm trên nhánh `task/TASK-001-bootstrap`, mở Pull Request vào `main`.

### 2. Khung monorepo
- pnpm workspaces + Turborepo.
- Thư mục: `apps/`, `services/`, `odoo-addons/`, `packages/`, `infra/`, `scripts/` (mỗi thư mục chưa có code thì có một README.md ngắn nói nó để làm gì).
- `.gitignore`, `.editorconfig`, `.env.example`. Không commit `.env` hay bất kỳ mật khẩu nào.

### 3. Dịch vụ `services/gateway` (NestJS, TypeScript, Node LTS)
Chỉ có các endpoint sau:
- `GET /health`: trả trạng thái của gateway, PostgreSQL, Odoo, NATS, Redis (mỗi cái `ok` hoặc `error` kèm lý do).
- `GET /v1/odoo/version`: gọi Odoo của tenant được chỉ định (header `X-Tenant: demo_fnb` khi dev) qua external API của Odoo, trả về phiên bản Odoo. Gateway tra tên database theo quy tắc `t_<mã>` (ADR-002). Tenant không tồn tại trả `404 TENANT_NOT_FOUND`.
- Có test tự động cho cả hai endpoint.
- Chưa làm đăng nhập, chưa làm feature flag (sẽ có task riêng).

### 4. Module Odoo `odoo-addons/iteso_base`
- Module tối thiểu: manifest, giấy phép LGPL-3, phụ thuộc `base`. Chưa có model nào.
- Cài được vào database tenant không lỗi.

### 5. Docker Compose (`infra/`)
- Dịch vụ: `postgres`, `odoo` (Odoo 20.0 Community, ghim tag cụ thể), `gateway`, `nats`, `redis`.
- Odoo: mount `odoo-addons/` vào addons path; `dbfilter` chỉ cho database `t_.*`; tắt trang quản lý database của Odoo; mật khẩu master lấy từ `.env`.
- Chỉ mở cổng ra máy chủ: Odoo `8069`, gateway `3000`. PostgreSQL, NATS, Redis chỉ trong mạng nội bộ của Compose.

### 6. Lệnh tiện ích (`Makefile` ở gốc repo, chạy trong WSL)
- `make up`: dựng toàn bộ; nếu chưa có thì tự tạo database `t_demo_fnb` và cài `iteso_base`.
- `make down`: dừng.
- `make reset`: xóa sạch dữ liệu dev và dựng lại.
- `make seed`: để trống, ghi chú "dữ liệu nhà hàng mẫu sẽ có ở task sau".
- `make test`: chạy test gateway và kiểm tra cài `iteso_base`.

### 7. CI (GitHub Actions)
- Chạy khi mở hoặc cập nhật Pull Request và khi push vào `main`.
- Các bước: cài dependency, lint, test gateway, dựng Compose rồi cài `iteso_base` vào một database test.

### 8. Xác minh và báo lại (chỉ tìm hiểu, không tự quyết)
1. Image Docker chính thức của Odoo 20.0 Community: tên và tag chính xác.
2. Odoo 20 khuyến nghị external API nào (JSON-2, JSON-RPC hay XML-RPC); cái nào đã bị đánh dấu ngừng hỗ trợ. Gateway dùng cái được khuyến nghị.
3. Phiên bản PostgreSQL mà Odoo 20 hỗ trợ; dùng bản đó trong Compose.
4. Module `l10n_vn_edi_viettel` (hóa đơn Viettel SInvoice) có trong bản Community 20.0 không; liệt kê các module `l10n_vn*` có sẵn.
5. Mức RAM thực tế khi toàn bộ Compose chạy (lệnh `docker stats`), và đề xuất cấu hình `.wslconfig`.

## Ngoài phạm vi (không làm)

Đăng nhập, phân quyền, feature flag, control plane, app POS, web quản trị, dữ liệu demo, mọi tính năng nghiệp vụ.

## Tiêu chí nghiệm thu

1. Clone mới → `cp .env.example .env` → `make up`: trong vòng 10 phút mọi container chạy ổn định.
2. `GET http://localhost:3000/health` trả `ok` cho cả 5 thành phần.
3. `GET http://localhost:3000/v1/odoo/version` với header `X-Tenant: demo_fnb` trả đúng phiên bản Odoo 20.
4. Header `X-Tenant: khong_ton_tai` trả `404 TENANT_NOT_FOUND`.
5. Không truy cập được trang quản lý database của Odoo (`/web/database/manager`).
6. `make test` xanh; CI trên Pull Request xanh.
7. Không có mật khẩu hay khóa nào trong lịch sử Git.
8. Không sửa file nào trong mã nguồn Odoo.

## Mẫu báo cáo (ghi vào `docs/tasks/TASK-001-report.md` trong Pull Request)

```
# Báo cáo TASK-001
## Đã làm
- ...
## Lệnh chạy và kết quả (dán output thật)
- make up: ...
- curl /health: ...
- curl /v1/odoo/version: ...
- make test: ...
## Trả lời 5 câu xác minh ở mục 8
1. ...
## Chỗ làm khác phiếu (nếu có) và lý do
- ...
## Vấn đề còn tồn tại / câu hỏi cho Claude
- ...
```

## Quy tắc

- Chỗ nào phiếu chưa rõ hoặc thấy cần làm khác: dừng lại và hỏi, không tự đổi hướng.
- Không merge vào `main`. Claude kiểm duyệt và merge khi CI xanh.
