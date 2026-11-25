# ADR-004: Hệ thống bật/tắt tính năng (feature flags)

- Trạng thái: Đã duyệt (Product Owner, 25/11/2026)
- Ngày: 25/11/2026
- Liên quan: ADR-002

## Bối cảnh

Tính năng thương mại (tự đăng ký, gói cước, thu phí, tạo tenant cho doanh nghiệp khác, AI) chưa dùng lúc này nhưng phải bật được bất cứ lúc nào từ trang quản trị, không cần sửa code hay triển khai lại.

## Quyết định

1. **Mỗi tính năng có một khóa**, dạng `<nhóm>.<tên>`, ví dụ:

   | Khóa | Ý nghĩa | Mặc định |
   | --- | --- | --- |
   | `fnb.pos` | Bán hàng tại quầy | Bật cho tenant demo F&B |
   | `fnb.qr_order` | Khách gọi món qua QR | Bật cho tenant demo F&B |
   | `fnb.kds` | Màn hình bếp | Bật cho tenant demo F&B |
   | `fnb.reservation` | Đặt bàn | Bật cho tenant demo F&B |
   | `einvoice.viettel` | Hóa đơn điện tử qua Viettel SInvoice | Tắt |
   | `inventory.recipe` | Định lượng nguyên liệu | Tắt |
   | `hotel.pms` | Gói lưu trú | Tắt |
   | `platform.tenant_create` | Tạo tenant cho doanh nghiệp khác | Khóa |
   | `platform.self_signup` | Tự đăng ký | Khóa, chưa làm |
   | `platform.billing` | Gói cước, thu phí | Khóa, chưa làm |
   | `ai.assistant` | Trợ lý AI | Tắt |

2. **Hai tầng:**
   - Tầng nền tảng: bật/tắt cho toàn hệ thống (công tắc khẩn cấp).
   - Tầng tenant: bật/tắt cho từng tenant.
   Một tính năng chạy khi và chỉ khi cả hai tầng đều bật.

3. **Trạng thái của khóa:** `available` (đã có code, bật/tắt được), `not_implemented` (mới có chỗ cắm; hiện mờ trong trang quản trị, không bật được). Code của tính năng chỉ viết khi sắp bật.

4. **Lưu trong database `platform` của control plane**: bảng định nghĩa khóa, bảng giá trị theo tenant, và bảng nhật ký (ai đổi, lúc nào, từ gì sang gì, ghi chú).

5. **Ai đổi được:** chỉ Super Admin, trong trang quản trị nền tảng. Mọi thay đổi ghi nhật ký.

6. **Thực thi ở gateway:** mỗi endpoint khai báo khóa nó cần. Tính năng đang tắt thì gateway trả lỗi `403 FEATURE_DISABLED`. Đây là chốt chặn chính; không dựa vào việc giao diện ẩn nút.

7. **Giao diện** lấy danh sách tính năng đang bật qua `GET /v1/features` và ẩn phần không dùng được.

8. **Cờ tính năng khác với cài module Odoo.** Module ngành (`iteso_hotel`…) do control plane cài khi tenant cần; cờ quyết định ai được dùng. Tắt cờ không gỡ module, không xóa dữ liệu.

9. **Đổi cờ có hiệu lực trong vòng 30 giây** (gateway cache ngắn, xóa cache khi nhận sự kiện thay đổi qua NATS).

## Hệ quả

- Tốt: mở bán, thử tính năng mới cho một tenant, hay tắt khẩn cấp một tính năng lỗi đều làm được trong trang quản trị.
- Phải trả giá: mỗi endpoint mới phải khai báo khóa; kiểm duyệt sẽ từ chối endpoint thiếu khai báo.
