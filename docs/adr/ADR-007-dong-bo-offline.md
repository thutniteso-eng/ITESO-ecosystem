# ADR-007: Đồng bộ offline (sync engine)

- Trạng thái: Đề xuất (chờ Product Owner duyệt)
- Ngày: 27/11/2026
- Liên quan: ADR-001, ADR-002, ADR-004, ADR-005, ADR-006

## Bối cảnh

Máy POS phải bán được khi mất mạng cả buổi, rồi tự đồng bộ khi có mạng lại. TASK-005 đã có ghép máy, đăng nhập PIN và roster offline (hạn 24 giờ). Còn thiếu cách đưa thao tác làm lúc offline lên máy chủ an toàn, đúng người, không trùng, và cách đưa dữ liệu danh mục từ máy chủ xuống máy. Phần này phải có trước khi làm app POS (GĐ 1). Sửa về sau rất đắt.

## Các phương án

| Phương án | Đánh giá |
| --- | --- |
| Đồng bộ trạng thái hai chiều (mỗi bản ghi tự gộp xung đột) | Loại: xung đột khó lường, không hợp với kế toán |
| Đẩy trực tiếp database của máy lên máy chủ | Loại: bỏ qua phân quyền và logic nghiệp vụ |
| **Nhật ký thao tác (operation log) đẩy lên, nhật ký thay đổi (outbox) kéo xuống** | **Chọn**: mỗi thao tác là một lệnh nghiệp vụ, chạy đúng một lần, kiểm tra lại quyền trên máy chủ |

## Quyết định

1. **Đẩy lên bằng thao tác.**
   - Mỗi việc làm trên máy (tạo đơn, tạo khách…) là một *thao tác* gồm: `op_id` (UUIDv7 do máy sinh), `op_type` (ví dụ `contact.create`), `payload`, `membership_id` của người làm, `roster_jti` của roster đang dùng, `client_time` và `seq` tăng dần theo từng máy.
   - Máy gửi thao tác theo lô lên `POST /v1/sync/push` khi có mạng. Mỗi thao tác nhận một trong ba kết quả: `applied`, `rejected` hoặc `needs_review`.

2. **Đúng một lần, trong cùng transaction với dữ liệu nghiệp vụ.**
   - Module Odoo `iteso_sync` giữ sổ thao tác (`iteso.sync.operation`, `op_id` duy nhất) ngay trong database của tenant.
   - Ghi sổ và ghi dữ liệu nghiệp vụ nằm trong **cùng một savepoint**, nên gửi lại bao nhiêu lần cũng chỉ áp dụng một lần. Gửi trùng thì trả lại kết quả cũ.
   - Mỗi thao tác chạy trong savepoint riêng: một thao tác lỗi không làm hỏng cả lô.

3. **Chạy bằng quyền của chính người làm.** Gateway gọi Odoo bằng API key của membership ghi trong thao tác (TASK-004), nên `create_uid` là đúng người và quyền Odoo được áp dụng.

4. **Xác minh người làm khi offline.** Máy gọi `push` bằng *device session token*: JWT ngắn hạn do control-plane cấp cho máy đã ghép, có `tid`, `did`, `bid`, `amr: ["device"]` và không có `mid`. Với từng thao tác, gateway kiểm tra:
   - `roster_jti` là roster đã cấp cho **đúng máy này** (control-plane ghi sổ mỗi lần cấp roster);
   - `membership_id` có trong roster đó;
   - `client_time` nằm trong thời hạn của roster (cho phép lệch thêm tối đa 10 phút) và không ở tương lai quá 5 phút.

   Không đạt thì `rejected`.

5. **Kiểm tra lại quyền hiện tại.**
   - Người làm *vẫn hợp lệ lúc làm* nhưng *nay đã bị thu quyền*: thao tác vẫn được áp dụng, vì tiền đã thu thật, và được đánh dấu `needs_review` cho quản lý xem.
   - Người làm *nay bị vô hiệu hoàn toàn* (không còn người dùng Odoo): trả `rejected` với lý do `MEMBER_DISABLED`. Máy giữ thao tác trong danh sách "cần xử lý" cho quản lý.

6. **Kéo xuống bằng outbox.**
   - `iteso_sync` ghi một dòng `iteso.outbox` (tăng dần) mỗi khi bản ghi của một model được theo dõi bị tạo, sửa hoặc xóa. Việc ghi dùng kế thừa model, không sửa lõi Odoo.
   - Máy gọi `GET /v1/sync/pull?dataset=<tên>&cursor=<số>` và nhận các bản ghi đổi sau `cursor`.
   - Outbox giữ 30 ngày. `cursor` cũ hơn thế thì trả `reset_required`, máy tải lại toàn bộ dataset.
   - Sau này một tiến trình chuyển outbox sang NATS để bếp và app nhận ngay (GĐ 1).

7. **Dải số chứng từ theo máy.**
   - Control-plane cấp cho mỗi máy những dải số không chồng nhau cho từng loại chứng từ, mỗi dải 1.000 số, xin dải mới khi còn dưới 200.
   - Số chứng từ có dạng `<mã chi nhánh>-<mã máy ngắn>-<số>`, không bao giờ trùng dù mất mạng.

8. **Giờ chuẩn.** Ngày hạch toán lấy theo giờ máy chủ lúc áp dụng; `client_time` được lưu lại để đối chiếu. Lệch quá 10 phút thì đánh dấu `needs_review`.

9. **Ranh giới.** Thời gian offline tối đa bằng hạn roster (24 giờ). Quá hạn, máy phải lên mạng để nhập PIN lại; các thao tác đã làm vẫn đẩy lên được về sau. Máy edge cho cơ sở lớn để sang GĐ 2.

## Hệ quả

- **Tốt:** không mất và không trùng thao tác; luôn biết ai làm; kế toán không bị gộp xung đột âm thầm; dùng lại được cho mọi ngành.
- **Phải chấp nhận:**
  - Mỗi loại thao tác cần một hàm xử lý riêng trong `iteso_sync`.
  - Dữ liệu đọc lúc offline có thể cũ: giá lấy theo bản đã tải, và đơn ghi lại giá đã dùng.
  - Gateway được đọc thêm sổ cấp roster.
- **Triển khai:** TASK-006 làm phần móng, thử với `contact.create` và dataset `contacts`. Đơn hàng POS làm ở GĐ 1.
