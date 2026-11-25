# ADR-001: Kiến trúc lai — Odoo Community làm lõi, các lớp còn lại tự xây

- Trạng thái: Đã duyệt (Product Owner, 25/11/2026)
- Ngày: 25/11/2026
- Liên quan: ADR-002, ADR-003, ADR-004

## Bối cảnh

ITESO ECO SYSTEM cần đủ nghiệp vụ của một ERP (kế toán, kho, mua hàng, nhân sự) nhưng phải hiện đại hơn Odoo: giao diện tiếng Việt, mobile, chạy khi mất mạng, tuân thủ thuế Việt Nam sẵn có. Đội hình gồm Product Owner, Claude (kiến trúc) và Antigravity (lập trình), nên không thể tự viết lại toàn bộ ERP.

Ba phương án đã xét:

| Phương án | Ưu | Nhược |
| --- | --- | --- |
| Odoo + module, dùng giao diện Odoo | Nhanh nhất | Trông như Odoo, khó khác biệt; offline khó |
| **Lai: Odoo Community làm lõi, phần còn lại tự xây** | Dùng lại ERP sẵn có, giao diện và trải nghiệm hoàn toàn của ITESO | Phụ thuộc phiên bản Odoo; phải giữ ranh giới chặt |
| Xây mới từ đầu | Tự do nhất | Nhiều năm mới có kế toán, kho đủ dùng |

## Quyết định

Chọn phương án lai.

1. **Lõi:** Odoo 20.0 Community, ghim đúng phiên bản (image Docker có tag cụ thể). Giấy phép LGPLv3.
2. **Không sửa lõi Odoo.** Mọi tùy biến nằm trong module riêng ở `odoo-addons/`, tiền tố `iteso_`: `iteso_base`, `iteso_vn` (thuế, hóa đơn, sổ sách Việt Nam), `iteso_fnb`, `iteso_hotel`, `iteso_retail`. Không dùng tiền tố `x_` vì Odoo dành nó cho trường tùy biến.
3. **Không dùng, không đọc code Odoo Enterprise.** Chỉ dùng module Community (LGPL) và module OCA có giấy phép tương thích.
4. **API gateway là cổng duy nhất.** Web, app, đối tác chỉ gọi gateway. Gateway gọi Odoo qua external API chính thức của Odoo 20 (TASK-001 xác minh API nào được khuyến nghị). Không app nào gọi thẳng Odoo.
5. **Dịch vụ nền tảng viết bằng TypeScript** (NestJS, Node LTS): gateway, control plane, sync, integrations, AI. Cùng ngôn ngữ với frontend; kiểu dữ liệu sinh từ OpenAPI vào `packages/`.
6. **Frontend:** Next.js cho web quản trị, QR order, booking; React Native (Expo) cho app POS (APK Android + iOS). Design system riêng; người dùng cuối không thấy giao diện Odoo.
7. **Sự kiện thời gian thực:** Odoo ghi sự kiện vào bảng outbox trong cùng giao dịch; một worker chuyển lên message bus (NATS). Bếp, app, webhook nhận từ bus.
8. **Monorepo:** pnpm workspaces + Turborepo cho phần TypeScript; addon Python nằm cùng repo.
9. Tên sản phẩm không chứa chữ "Odoo".

## Hệ quả

- Tốt: có ngay kế toán, kho, mua hàng, đa công ty của Odoo; giao diện và luồng nghiệp vụ là của ITESO; đổi giao diện không đụng lõi.
- Phải trả giá: gateway là lớp phải duy trì; mỗi lần nâng cấp Odoo cần chạy bộ test tương thích (Community không có dịch vụ nâng cấp chính thức, dùng OpenUpgrade của OCA). Nâng cấp tối đa 1 lần/năm.
- Ràng buộc kiểm duyệt: mọi PR sửa file trong lõi Odoo, hoặc frontend gọi thẳng cổng Odoo, sẽ bị từ chối.

## Việc còn lại

- Định danh và phân quyền: đề xuất trong ADR-005 (tài khoản do ITESO quản lý; gateway gọi Odoo bằng chính người dùng Odoo của người đang thao tác).
- Trước khi mở bán: nhờ luật sư xác nhận cách dùng LGPLv3 và thương hiệu.
