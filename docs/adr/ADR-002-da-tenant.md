# ADR-002: Đa doanh nghiệp (multi-tenant) — mỗi tenant một database

- Trạng thái: Đã duyệt (Product Owner, 25/11/2026)
- Ngày: 25/11/2026
- Liên quan: ADR-001, ADR-004

## Bối cảnh

Sản phẩm phục vụ nhiều doanh nghiệp độc lập. Dữ liệu của từng doanh nghiệp phải tách biệt, sao lưu, khôi phục và xóa riêng được (Luật Bảo vệ dữ liệu cá nhân 91/2025). Hiện chưa mở cho khách, nhưng cấu trúc phải đúng từ đầu vì đổi sau rất tốn công.

## Quyết định

1. **Tenant** là một doanh nghiệp khách hàng. Một tenant có thể có nhiều chi nhánh (dùng tính năng đa công ty/chi nhánh của Odoo bên trong database của tenant).
2. **Mỗi tenant một database PostgreSQL riêng cho Odoo**, tên dạng `t_<mã>`, ví dụ `t_demo_fnb`. Odoo chọn database theo cấu hình `dbfilter`; người dùng cuối không bao giờ thấy màn hình chọn database của Odoo.
3. **Control plane có database riêng** (`platform`), chứa: danh sách tenant, trạng thái, gói ngành đã cài, cờ tính năng (ADR-004), nhật ký quản trị. Không chứa dữ liệu nghiệp vụ.
4. **Gateway xác định tenant** cho mỗi request (theo tên miền con, hoặc header khi dev), tra control plane để biết database tương ứng, rồi mới gọi Odoo. Request không xác định được tenant bị từ chối.
5. **Tạo tenant** chỉ qua control plane: tạo database, cài module theo gói ngành, nạp cấu hình mặc định. Hiện chỉ Super Admin làm được (tính năng `platform.tenant_create` đang khóa, ADR-004).
6. **Tenant demo** là tenant đầu tiên: `t_demo_fnb` (nhà hàng mẫu). Sau này thêm `t_demo_hotel`, `t_demo_retail`, `t_demo_sme`. Dữ liệu demo nạp bằng script, chạy lại được.
7. **Mọi tenant chạy cùng một phiên bản Odoo và cùng bộ module `iteso_`.** Khác nhau chỉ ở cấu hình và module ngành được cài.
8. **Không có code riêng cho một tenant.** Số bàn, phòng, ngôn ngữ, máy in, tài khoản ngân hàng, phương thức thanh toán đều là cấu hình.

## Hệ quả

- Tốt: tách biệt dữ liệu mạnh; sao lưu, khôi phục, xóa theo từng khách; phù hợp cách Odoo vốn làm.
- Phải trả giá: nâng cấp module phải chạy trên từng database; control plane cần lệnh nâng cấp theo đợt và báo cáo kết quả từng tenant. Số database lớn thì cần chia cụm máy chủ (việc của GĐ 3 trở đi).

## Đề xuất cho các phần liên quan

- **Tên miền khi lên server (GĐ 3):** mỗi tenant một tên miền con `<mã-tenant>.<tên-miền-ITESO>` cho web; API chung ở `api.<tên-miền-ITESO>`, gateway xác định tenant theo token đăng nhập. Tên miền gốc chọn khi chuẩn bị GĐ 3.
- **Một người làm cho nhiều doanh nghiệp:** một tài khoản toàn cục, gắn vào nhiều tenant qua membership (ADR-005).
