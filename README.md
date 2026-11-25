# ITESO ECO SYSTEM

Nền tảng quản trị đa ngành (F&B, lưu trú, bán lẻ, ERP cho SME) do Công ty TNHH Tư Vấn & Chuyển Giao Công Nghệ ITESO phát triển. Sản phẩm độc lập: khi hoàn thiện, bất kỳ doanh nghiệp nào cũng đăng ký dùng được.

Kế hoạch tổng thể: https://claude.ai/artifact/Kp4ENgK8pqDS4ZiFkPe8pm

## Nguyên tắc

1. Odoo 20 Community là lõi nghiệp vụ, chạy ngầm. Không sửa lõi Odoo, không dùng code Odoo Enterprise.
2. Mọi app và web chỉ nói chuyện với API gateway của ITESO, không gọi thẳng Odoo.
3. Trong code không có gì riêng của một khách hàng nào. Mọi thứ là cấu hình của tenant.
4. Tính năng thương mại để ở chế độ chờ; Super Admin bật/tắt trong trang quản trị (ADR-004).
5. Git + Markdown là nguồn sự thật. Mỗi quyết định kiến trúc có một ADR trong `docs/adr/`.
6. Chất lượng kiến trúc trước tốc độ.
7. Thứ tự: chạy được trước, lên server sau, khách hàng sau cùng.

## Cấu trúc repo

```
apps/            Ứng dụng người dùng: web-admin (Next.js), pos (React Native/Expo), guest-web...
services/        Dịch vụ nền tảng TypeScript: gateway, control-plane, sync, integrations, ai
odoo-addons/     Module Odoo của ITESO (tiền tố iteso_)
packages/        Thư viện dùng chung: SDK sinh từ OpenAPI, design system, cấu hình chung
infra/           Docker Compose, cấu hình Odoo, script hạ tầng
scripts/         Script tiện ích cho dev
docs/adr/        Quyết định kiến trúc (ADR)
docs/tasks/      Phiếu việc (TASK-xxx) và báo cáo
```

## Vai trò

| Vai trò | Ai |
| --- | --- |
| Product Owner, quyết định cuối | Tạ Ngọc Thủ |
| Kiến trúc, viết spec, kiểm duyệt code | Claude |
| Lập trình | Antigravity |

## Quy trình

1. Claude viết phiếu việc trong `docs/tasks/`, Product Owner duyệt.
2. Antigravity làm trên nhánh `task/TASK-xxx-...`, mở Pull Request, ghi báo cáo theo mẫu trong phiếu.
3. Claude kiểm duyệt. CI xanh + kiểm duyệt đạt thì merge vào `main`.
4. Không tự đổi hướng: chỗ nào phiếu chưa rõ thì hỏi, không đoán.

## Chạy môi trường dev

Xem `docs/tasks/TASK-001-khoi-tao-repo-va-moi-truong-dev.md`. Sau khi TASK-001 hoàn thành, phần này sẽ ghi lệnh chạy cụ thể.
