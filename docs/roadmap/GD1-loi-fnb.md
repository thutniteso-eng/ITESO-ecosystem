# Kế hoạch GĐ 1: Lõi F&B chạy được

- Trạng thái: Đề xuất (chờ Product Owner duyệt)
- Ngày: 28/11/2026
- Căn cứ: Kế hoạch phát triển ITESO ECO SYSTEM (bảng "Chế độ chờ" và "Lộ trình"), ADR-001 đến ADR-007

## Mục tiêu

Một nhà hàng mẫu vận hành trọn một ngày trên ITESO ECO SYSTEM:
- nhập thực đơn;
- mở ca;
- gọi món tại bàn và qua QR;
- bếp nhận món;
- in phiếu;
- thu tiền mặt và VietQR;
- đóng ca khớp tiền.

Kể cả khi một máy mất mạng giữa ca. Đây là lúc bắt đầu có **giao diện**: trang quản trị web và app POS.

Phạm vi theo bảng "Chế độ chờ" đã duyệt:
- **Bật trong bản demo:** POS, sơ đồ bàn, QR order, đặt bàn, màn hình bếp, in bếp/bar, thực đơn và hóa đơn in nhiều ngôn ngữ.
- **Viết ở GĐ 1 nhưng để tắt:** hóa đơn điện tử Viettel SInvoice (chỉ thử với sandbox).
- **Không làm ở GĐ 1:** kho, định lượng, kế toán hộ kinh doanh (GĐ 2); gói lưu trú (GĐ 3).

## Quyết định kiến trúc đề xuất

Mỗi quyết định sẽ được viết thành ADR riêng trong PR của task đầu tiên dùng đến nó.

1. **Giao diện** (ADR-008, ở TASK-007):
   - Trang quản trị: **Next.js** (`apps/admin-web`).
   - App POS: **Expo / React Native**, ưu tiên **máy tính bảng Android** (`apps/pos`), lưu dữ liệu offline bằng SQLite.
   - Gói dùng chung: `packages/api-client` sinh từ OpenAPI của gateway, nên frontend và backend luôn khớp kiểu dữ liệu; `packages/ui` chứa màu, chữ và thành phần dùng chung.
   - Tiếng Việt trước, kèm tiếng Anh.
   - App chỉ gọi gateway, không gọi thẳng Odoo.
2. **Nghiệp vụ F&B trên Odoo** (ADR-009, ở TASK-009):
   - Dùng phần backend của module **`point_of_sale` + `pos_restaurant`** của Odoo Community: đơn, ca, thanh toán, bàn. Như vậy đơn hàng chảy sẵn vào kế toán ở GĐ 2, và module hóa đơn điện tử `l10n_vn_edi_viettel_pos` dùng được.
   - **Không dùng giao diện POS của Odoo.** Phần riêng của ITESO (trạm bếp, topping, tên món nhiều ngôn ngữ…) nằm trong module `iteso_fnb`.
   - Mọi thao tác bán hàng từ máy đi qua nhật ký thao tác của ADR-007.
3. **Realtime cho bếp và trạng thái đơn** (ADR-010, ở TASK-015): outbox của Odoo chuyển sang NATS rồi tới WebSocket của gateway. Mất kết nối thì máy tự kéo lại bằng cursor.
4. **In ấn:** app POS in thẳng qua máy in nhiệt **ESC/POS** trong mạng LAN; phiếu tự chia theo trạm (bếp, bar); mẫu in theo ngôn ngữ của khách. In được cả khi mất mạng Internet.
5. **Thanh toán GĐ 1:**
   - Tiền mặt.
   - **VietQR** theo chuẩn NAPAS, sinh mã kèm số tiền và nội dung đơn; nhân viên xác nhận đã nhận tiền. Tự đối soát qua dịch vụ đọc biến động ngân hàng để sau.
   - Quẹt thẻ để sau.

## Chia task

Mỗi task là một PR, đi đúng quy trình: phiếu do anh duyệt, Antigravity làm, Claude kiểm duyệt.

| # | Task | Kết quả nhìn thấy được |
| --- | --- | --- |
| 007 | Trang quản trị web nền + bảng điều khiển Super Admin | Anh đăng nhập web bằng mật khẩu và mã 6 số; xem doanh nghiệp, bật/tắt tính năng, xem nhật ký |
| 008 | Quản trị doanh nghiệp: nhân viên, vai trò, chi nhánh, máy POS | Thêm nhân viên, gán vai trò, tạo mã ghép máy ngay trên web |
| 009 | Lõi F&B trên Odoo: cài `point_of_sale`, `pos_restaurant`, module `iteso_fnb`; API thực đơn | Có dữ liệu thực đơn mẫu nhiều ngôn ngữ qua API |
| 010 | Quản trị thực đơn và sơ đồ bàn trên web | Nhập món, giá, ảnh, topping, nhập từ Excel; vẽ khu vực và bàn |
| 011 | App POS nền | Cài lên máy tính bảng Android: ghép máy, đăng nhập PIN, tải thực đơn, chạy offline |
| 012 | Gọi món theo bàn | Mở bàn, thêm món, ghi chú, chuyển hoặc gộp bàn, kể cả khi mất mạng |
| 013 | Thanh toán và ca | Tiền mặt, VietQR, chia hóa đơn, giảm giá; mở và đóng ca, báo cáo ca khớp tiền |
| 014 | In ấn | In hóa đơn, phiếu bếp và phiếu bar ra máy in nhiệt; mẫu in nhiều ngôn ngữ |
| 015 | Màn hình bếp (KDS) | Bếp thấy món ngay khi gọi; bấm "xong" thì máy phục vụ thấy |
| 016 | QR order tại bàn | Khách quét QR, xem thực đơn theo ngôn ngữ, gọi món; nhân viên xác nhận |
| 017 | Đặt bàn | Nhận và quản lý đặt bàn, giữ bàn trên sơ đồ |
| 018 | Hóa đơn điện tử Viettel SInvoice | Phát hành thử trên sandbox; mặc định tắt |
| 019 | Nghiệm thu GĐ 1 | Chạy kịch bản "một ngày bán hàng" và bàn giao bản demo |

**Thứ tự:** TASK-007 và 008 đi trước để anh sớm có giao diện xem và thao tác. Từ TASK-009 đến 015 là xương sống bán hàng. Task 016–018 làm sau khi xương sống ổn.

## Cổng nghiệm thu GĐ 1 (đề xuất)

Qua cổng mới sang GĐ 2:

1. Trên laptop và ít nhất 1 máy tính bảng Android thật, chạy kịch bản "một ngày bán hàng" của nhà hàng mẫu:
   - 3 máy POS, 50 đơn;
   - 1 máy mất mạng 2 giờ giữa ca;
   - bếp nhận đủ món;
   - in đủ phiếu;
   - thu tiền mặt và VietQR;
   - đóng ca: tiền mặt khớp, không trùng và không mất đơn nào.
2. Số liệu đơn và ca trong Odoo khớp với báo cáo ca trên app.
3. Tắt một tính năng (ví dụ QR order) cho tenant demo thì tính năng đó biến mất khỏi app và web.
4. CI xanh; mọi kịch bản nghiệm thu của GĐ 0 vẫn đạt.

## Cần anh quyết

1. **Thiết bị POS mục tiêu.** Tôi đề xuất: máy tính bảng Android 10 inch phổ thông cho thu ngân, và điện thoại Android cho phục vụ gọi món tại bàn. Máy POS Android có máy in liền (loại Sunmi) để hỗ trợ sau, ở GĐ 2.
2. **Thứ tự** như bảng trên, trang quản trị web làm trước.
3. **Cổng nghiệm thu** như trên.
