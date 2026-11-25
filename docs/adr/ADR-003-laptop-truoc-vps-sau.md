# ADR-003: Môi trường — laptop trước, VPS/server từ GĐ 3

- Trạng thái: Đã duyệt (Product Owner, 25/11/2026)
- Ngày: 25/11/2026
- Liên quan: ADR-001, ADR-002

## Bối cảnh

Sản phẩm chưa chạy được, chưa có khách. Thuê server lúc này là tốn tiền vô ích. Máy phát triển là PC Windows 10, 16 GB RAM, có WSL2; Antigravity và Claude Code cài trên Windows.

## Quyết định

1. **GĐ 0–2: chỉ chạy trên laptop**, trong WSL2 bằng Docker Compose. Không có môi trường production.
2. **Mọi thành phần chạy trong container** (Odoo, PostgreSQL, gateway, NATS, Redis…). Không cài trực tiếp lên máy. Nhờ vậy khi lên server chỉ cần chép cấu hình sang.
3. **Một lệnh dựng toàn bộ**: `make up` trong WSL (TASK-001 tạo). Một lệnh xóa sạch và dựng lại: `make reset`. Một lệnh nạp dữ liệu demo: `make seed`.
4. **Giới hạn tài nguyên**: WSL2 dùng tối đa khoảng 10 GB RAM (file `.wslconfig`), để Windows và công cụ lập trình còn chỗ chạy. TASK-001 đo mức dùng thực tế và báo lại.
5. **Bí mật** (mật khẩu, khóa API) nằm trong `.env`, không commit. Repo chỉ có `.env.example`.
6. **An toàn dữ liệu khi phát triển**: code đẩy lên GitHub mỗi ngày; dữ liệu demo sinh lại được bằng script, nên laptop hỏng không mất việc.
7. **GĐ 3**: thuê VPS hoặc máy chủ đặt tại Việt Nam, dùng lại cùng file Compose (sau này chuyển Kubernetes khi khoảng 50 tenant). Khi đó mới thêm sao lưu tự động, giám sát, tên miền. Quyết định chi tiết sẽ có ADR riêng.

## Hệ quả

- Tốt: không tốn chi phí server; môi trường dev giống môi trường server sau này.
- Phải trả giá: 16 GB RAM là giới hạn thật; nếu chật, ưu tiên tắt bớt dịch vụ không cần cho việc đang làm (Compose profiles).
