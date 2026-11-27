# TASK-006: Phần móng đồng bộ offline

- Người giao: Claude (kiến trúc)
- Người làm: Antigravity
- Người duyệt cuối: Product Owner
- Giai đoạn: GĐ 0 — Nền móng
- Căn cứ: ADR-007 (bắt buộc đọc trước), ADR-005, ADR-006

## Mục tiêu

Làm đủ đường đi của ADR-007 với **một loại thao tác thật** (`contact.create`: tạo khách hàng từ máy POS) và **một dataset thật** (`contacts`). Kiểm tra bằng script giả lập máy POS bị mất mạng rồi có mạng lại. Chưa làm app, chưa làm đơn hàng.

## Vị trí làm việc

`~/projects/ITESO-ecosystem` (WSL), kéo `main` mới nhất, nhánh `task/TASK-006-offline-sync`.

## Việc cần làm

### 1. Module Odoo `iteso_sync` (phụ thuộc `iteso_base`)

- **Model `iteso.sync.operation`** (sổ thao tác): `op_id` (duy nhất), `device_id`, `membership_id`, `op_type`, `seq`, `client_time`, `server_time`, `status` (`applied`/`rejected`/`needs_review`), `result` (JSON), `error`.
- **Phương thức công khai `apply_operations(operations)`**, gọi qua JSON-2 bằng key của thành viên. Với mỗi thao tác:
  - mở một savepoint riêng;
  - `op_id` đã có thì trả lại kết quả cũ;
  - chưa có thì gọi hàm xử lý theo `op_type` rồi ghi sổ trong **cùng savepoint**;
  - lỗi nghiệp vụ thì ghi `rejected` kèm lý do. Một thao tác lỗi không ảnh hưởng thao tác khác.
- **`op_type` không có hàm xử lý** thì `rejected`, lý do `UNKNOWN_OP_TYPE`.
- **Hàm xử lý `contact.create`:** `payload` gồm `{name, phone?, email?}`, tạo `res.partner` và trả `{id}`. Kiểm tra dữ liệu: `name` bắt buộc, tối đa 200 ký tự.
- Gateway gửi kèm cờ `flag_review` cho thao tác cần đánh dấu `needs_review` (quyết định 5 và 8 của ADR-007); có cờ thì sổ ghi `needs_review` thay cho `applied`.
- **Model `iteso.outbox`:** `model`, `res_id`, `action` (`create`/`write`/`unlink`), thời điểm.
  - Ghi bằng cách kế thừa `res.partner` (override `create`/`write`/`unlink`), không sửa lõi.
  - Cron hằng ngày xóa dòng cũ hơn 30 ngày.
- **Phương thức `pull(dataset, cursor, limit)`:**
  - `dataset = "contacts"`: trả các khách hàng thay đổi sau `cursor` (`id`, `name`, `phone`, `email`, `active`, `deleted`) cùng `next_cursor`.
  - `cursor` nhỏ hơn dòng outbox cũ nhất còn giữ thì trả `reset_required: true`.
  - `cursor = 0` là tải toàn bộ.
  - `limit` tối đa 500.
- Người dùng thành viên (`base.group_user`) được ghi sổ và gọi `pull`, nhưng **không sửa hay xóa được** dòng sổ đã có.
- Có test Odoo, chạy trong CI như `iteso_base`.

### 2. Control-plane

- **`POST /v1/pos/auth/device-session`** (header `Authorization: Device <token>`): cấp device session token 15 phút, gồm `typ: access`, `aud: iteso-api`, `tid`, `did`, `bid`, `amr: ["device"]`, `perms: []`, không có `mid`. Kiểm tra máy, tenant, cờ `pos.devices` như TASK-005.
- **Bảng `pos_roster_issues`** (`jti`, `device_id`, `tenant_id`, `member_ids uuid[]`, `issued_at`, `expires_at`): ghi mỗi lần `GET /v1/pos/roster` cấp roster.
- **Bảng `device_number_blocks`** (`device_id`, `doc_type`, `range_start`, `range_end`, `allocated_at`):
  - `POST /v1/pos/number-blocks {doc_type}` (header Device) cấp dải 1.000 số kế tiếp **không chồng nhau trong cùng tenant**, có khóa chống hai yêu cầu đồng thời;
  - `doc_type` hiện chỉ chấp nhận `order`.
- **Quyền database của `iteso_gateway`:** chỉ thêm `SELECT` trên `pos_roster_issues`.
- **Tính năng mới `sync.offline`** (nhóm `sync`): `available`, platform bật, mặc định bật.

### 3. Gateway

- **`POST /v1/sync/push`** `{operations: [...]}` (tối đa 200 thao tác/lô; `@RequireFeature('sync.offline')`): chỉ nhận device session token (`amr` có `device`).
  - Với từng thao tác, kiểm tra theo quyết định 4 của ADR-007 bằng `pos_roster_issues` (cùng `device_id` với token).
  - Gom các thao tác hợp lệ theo `membership_id`, gọi `iteso.sync.apply_operations` bằng key Odoo của chính người đó (TASK-004).
  - Membership không còn key dùng được thì `rejected` với lý do `MEMBER_DISABLED`.
  - Người hợp lệ lúc làm nhưng nay thiếu quyền `pos.session.open`, hoặc thao tác lệch giờ quá 10 phút: gửi kèm cờ `flag_review` để Odoo ghi `needs_review`. Để biết quyền hiện tại, gateway gọi control-plane, không mở thêm quyền database.
  - Trả về danh sách `{op_id, status, result?, reason?}` theo đúng thứ tự đã gửi.
- **`GET /v1/sync/pull?dataset=contacts&cursor=<n>&limit=<n>`:** nhận device session token. Gateway gọi `iteso.sync.pull` bằng một **người dùng Odoo chỉ đọc của máy**: thêm vào TASK-004 một người dùng `iteso-device-<device_id>` chỉ thuộc `base.group_user`, được tạo khi ghép máy và tắt khi thu hồi máy.

### 4. Tồn đọng nhỏ

- Giới hạn tần suất ghép máy (TASK-005) chuyển sang Redis.

## Test tự động bắt buộc

- **Odoo:**
  - gửi trùng `op_id` chỉ áp dụng một lần;
  - một thao tác lỗi giữa lô không làm hỏng các thao tác khác;
  - `UNKNOWN_OP_TYPE`;
  - outbox ghi đủ cả 3 loại `action`;
  - `pull` có phân trang và trả `reset_required` khi cần;
  - người dùng thành viên không sửa được sổ.
- **Gateway:**
  - roster của máy khác, `membership_id` không có trong roster, roster hết hạn và giờ ở tương lai đều bị `rejected`;
  - nhận `needs_review` khi người làm bị thu quyền hoặc khi lệch giờ;
  - `MEMBER_DISABLED`;
  - lô quá 200 thao tác thì `400`.
- **Control-plane:** dải số không chồng nhau khi 10 yêu cầu đồng thời; device session token không dùng được cho các route cần `mid`.
- Không giả lập chính phần đang kiểm. Kịch bản đầu-cuối chạy với Odoo thật trong CI.

## Tiêu chí nghiệm thu (chạy trong CI, dán output thật vào báo cáo)

1. Script giả lập máy: ghép máy, cashier đặt PIN, tải roster, xin device session token.
2. **"Offline":** script tạo 3 thao tác `contact.create` có `client_time` trong quá khứ (nằm trong hạn roster), mỗi thao tác một `op_id`.
3. **"Có mạng lại":** push được 3 `applied`. Trong `t_demo_fnb` có 3 khách hàng mới với `create_uid` là `iteso-<mid của cashier>`.
4. Push lại đúng lô đó thì vẫn là 3 `applied` với cùng `result`, và không thêm khách hàng nào.
5. Push thao tác có `membership_id` không có trong roster hoặc dùng roster của máy khác thì `rejected`.
6. Thu quyền `pos.session.open` của cashier, push 1 thao tác làm lúc còn quyền: kết quả `needs_review`, và khách hàng vẫn được tạo.
7. Tắt membership cashier rồi push thì `rejected`, lý do `MEMBER_DISABLED`.
8. `pull` với `cursor=0` thấy cả 3 khách hàng. Sửa tên một khách trong Odoo, `pull` với `next_cursor` chỉ thấy khách vừa sửa.
9. Hai máy, mỗi máy xin 3 dải số `order`: không có dải nào chồng nhau.
10. Kịch bản nghiệm thu của TASK-002 đến TASK-005 vẫn đạt; quyền database của gateway đúng; `make test` và CI xanh; repo không có bí mật thật.

## Mẫu báo cáo

Ghi vào `docs/tasks/TASK-006-report.md` như các task trước.

## Quy tắc

- Chỗ nào phiếu chưa rõ hoặc thấy cần làm khác: dừng lại và hỏi, không tự đổi hướng.
- Không merge. Claude kiểm duyệt và merge khi CI xanh.
