# Báo cáo TASK-006: Phần móng đồng bộ offline

## Đã làm

1. **Module Odoo mới `iteso_sync`:**
   - Tạo addon [odoo-addons/iteso_sync](file:///home/iteso/projects/ITESO-ecosystem/odoo-addons/iteso_sync) phụ thuộc `base` và `iteso_base`.
   - **Sổ thao tác `iteso.sync.operation`:**
     - Mô hình lưu trữ: `op_id` (duy nhất qua `models.Constraint`), `device_id`, `membership_id`, `op_type`, `seq`, `client_time`, `server_time`, `status` (`applied`, `rejected`, `needs_review`), `result` (JSON text), `error`.
     - Phân quyền CSV: `base.group_user` chỉ có quyền `create` và `read` (`cr`), tuyệt đối không được `update` hay `unlink` (`ud`).
     - Phương thức `apply_operations(operations)`:
       - Duyệt từng thao tác trong lô, mỗi thao tác được bọc trong một **savepoint riêng biệt** (`with self.env.cr.savepoint():`). Lỗi của một thao tác không làm hỏng các thao tác khác trong cùng lô.
       - Ghi sổ thao tác và thay đổi nghiệp vụ thực thi trong cùng một savepoint / transaction.
       - Đảm bảo tính lũy thừa (idempotent) tuyệt đối qua `op_id`: nếu `op_id` đã tồn tại trong sổ, trả về kết quả cũ mà không thực thi lại logic nghiệp vụ.
       - Hỗ trợ thao tác `contact.create`: tạo bản ghi `res.partner` với quyền `base.group_user`, kiểm tra tên không rỗng và không quá 200 ký tự.
       - Xử lý cờ `flag_review`: nếu cờ bật, trạng thái ghi nhận là `needs_review`, thao tác nghiệp vụ vẫn được áp dụng bình thường.
       - Báo lỗi rõ ràng `UNKNOWN_OP_TYPE` khi gặp loại thao tác chưa được định nghĩa.
   - **Bảng thay đổi Outbox `iteso.outbox`:**
     - Mô hình theo dõi thay đổi dữ liệu: `model`, `res_id`, `action` (`create`, `write`, `unlink`), `created_at`.
     - Phân quyền CSV: `base.group_user` có quyền `cr`.
     - Kế thừa `res.partner`: ghi nhận vào `iteso.outbox.sudo()` khi tạo, sửa, hoặc xóa bản ghi.
     - Dọn dẹp định kỳ: cron job `iteso.outbox.purge_old_outbox(30)` chạy hàng ngày lúc 03:00 UTC để xóa các thay đổi cũ hơn 30 ngày.
     - Phương thức `pull(dataset, cursor=0, limit=500)`:
       - Với `cursor=0`: trả về toàn bộ dữ liệu ảnh chụp (snapshot) của `dataset = 'contacts'`.
       - Với `cursor > 0`: trả về các thay đổi gia tăng (incremental), đánh dấu `deleted: True` nếu hành động là `unlink`.
       - Nếu `cursor` cũ hơn bản ghi outbox nhỏ nhất hiện có (do đã bị purge): trả về `reset_required: True`.
   - **Unit tests:**
     - Viết 7 kịch bản kiểm thử trong [odoo-addons/iteso_sync/tests/test_sync.py](file:///home/iteso/projects/ITESO-ecosystem/odoo-addons/iteso_sync/tests/test_sync.py).
     - Kiểm thử tự động chạy và đạt 100% (15/15 test gồm 8 của `iteso_base` và 7 của `iteso_sync`).

2. **Dữ liệu & Migration Drizzle Control-plane (`0005_add_offline_sync.sql`):**
   - Tạo migration tại [services/control-plane/drizzle/0005_add_offline_sync.sql](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/drizzle/0005_add_offline_sync.sql):
     - Bảng `pos_roster_issues`: lưu lịch sử các phiên roster đã ký cấp cho thiết bị: `jti` (uuid, PK), `device_id`, `tenant_id`, `member_ids` (uuid array), `issued_at`, `expires_at`.
     - Cấp quyền `SELECT` cho `iteso_gateway` trên bảng `pos_roster_issues`.
     - Bảng `device_number_blocks`: theo dõi dải số thứ tự tài liệu cấp cho máy POS: `id`, `device_id`, `tenant_id`, `doc_type`, `range_start`, `range_end`, `allocated_at`. Thu hồi quyền của `iteso_gateway` trên bảng này.
     - Bổ sung các cột người dùng Odoo cho thiết bị POS trong `pos_devices`: `odoo_uid`, `api_key_enc`, `key_expires_at`.
   - Cập nhật phân quyền DB trong [services/control-plane/src/db/migrate.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/db/migrate.ts) và kiểm tra DB isolation tự động trong [scripts/test-db-isolation.sh](file:///home/iteso/projects/ITESO-ecosystem/scripts/test-db-isolation.sh).
   - Đăng ký tính năng `sync.offline` trong [services/control-plane/src/db/seed.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/db/seed.ts) (`implementation_status = 'available'`, `platform_enabled = true`, `default_enabled = true`).

3. **Control-plane: Dịch vụ & Cấp phát tài nguyên:**
   - Cập nhật [services/control-plane/src/auth/token.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/auth/token.service.ts):
     - Ký JWS cho roster có chứa claim `jti` duy nhất.
   - Cập nhật [services/control-plane/src/control-plane/odoo-provisioning.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/control-plane/odoo-provisioning.service.ts):
     - Thêm `provisionDeviceUser(tenantId, deviceId, deviceName)`: tự động tạo người dùng Odoo chỉ đọc `iteso-device-<deviceId>` thuộc `base.group_user` và cấp API key 365 ngày khi ghép máy POS.
     - Thêm `disableDeviceUser(tenantId, deviceId)`: tắt người dùng và thu hồi API key khi máy bị thu hồi.
     - Thêm `getDeviceCredential(deviceId, tenantCode)`: hỗ trợ gateway lấy credential đọc dữ liệu cho máy POS.
   - Cập nhật [services/control-plane/src/control-plane/pos-device.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/control-plane/pos-device.service.ts) và [services/control-plane/src/control-plane/pos-device.controller.ts](file:///home/iteso/projects/ITESO-ecosystem/services/control-plane/src/control-plane/pos-device.controller.ts):
     - Chuyển giới hạn tần suất ghép máy POS sang Redis (`ratelimit:pair:${clientIp}` với `INCR` + `EXPIRE 60`, tự động dự phòng sang in-memory Map nếu Redis ngắt kết nối).
     - `POST /v1/pos/auth/device-session`: Cấp device session token (JWT 15 phút, `amr: ['device']`, mang `did`, `bid`, `tid`, không có `mid`).
     - `POST /v1/pos/number-blocks`: Cấp phát dải 1.000 số cho `doc_type = 'order'`. Dùng khóa transaction mức PostgreSQL `pg_advisory_xact_lock(hashtext(tenantId || ':number_block:' || docType))` để đảm bảo 100% không trùng lặp hay chồng lấn ngay cả khi có nhiều yêu cầu đồng thời.
     - Internal API: `GET /v1/internal/pos/devices/:id/odoo-credential` và `GET /v1/internal/memberships/:id/permissions` để gateway gọi kiểm tra nội bộ mà không cần mở rộng quyền database.

4. **Gateway: Ủy quyền & Đồng bộ ngoại tuyến:**
   - Cập nhật [services/gateway/src/auth/auth.guard.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/auth/auth.guard.ts):
     - Bổ sung decorator `@RequireDeviceSession()`: chỉ cho phép token mang `amr` chứa `device`, `did` và `tid`.
     - Ngược lại, các route thông thường của tenant yêu cầu token phải có `mid`, ngăn chặn triệt để việc dùng nhầm device session token cho các route của thành viên.
   - Thêm bộ chuyển tiếp proxy trong [services/gateway/src/auth/auth-proxy.controller.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/auth/auth-proxy.controller.ts) cho `POST /v1/pos/auth/device-session` và `POST /v1/pos/number-blocks`.
   - Tạo mới [services/gateway/src/sync/sync.controller.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/sync/sync.controller.ts) và [services/gateway/src/sync/sync.service.ts](file:///home/iteso/projects/ITESO-ecosystem/services/gateway/src/sync/sync.service.ts):
     - `POST /v1/sync/push`:
       - Yêu cầu cờ tính năng `sync.offline` và phiên máy `@RequireDeviceSession()`.
       - Giới hạn kích thước lô từ 1 đến 200 thao tác.
       - Kiểm tra tính hợp lệ của từng thao tác đối chiếu với `pos_roster_issues`: phải thuộc đúng thiết bị, thành viên nằm trong danh sách roster, `client_time` nằm trong khoảng dung sai `[issued_at - 10m, expires_at + 10m]` và không vượt quá 5 phút trong tương lai.
       - Lấy API key Odoo của từng thành viên từ `membership_odoo_users`. Nếu thành viên bị vô hiệu hóa/xóa, từ chối với lý do `MEMBER_DISABLED`.
       - Gọi Control-plane internal API để kiểm tra quyền `pos.session.open` hiện tại của thành viên. Nếu bị mất quyền hoặc lệch giờ so với server > 10 phút, tự động gửi kèm cờ `flag_review: true`.
       - Gom các thao tác theo từng thành viên và gọi `iteso.sync.operation.apply_operations` tới Odoo bằng API key của chính thành viên đó.
       - Trả về danh sách kết quả đúng nguyên trạng thứ tự của lô gửi vào.
     - `GET /v1/sync/pull`:
       - Yêu cầu cờ tính năng `sync.offline` và phiên máy `@RequireDeviceSession()`.
       - Lấy API key chỉ đọc của thiết bị từ Control-plane và gọi `iteso.outbox.pull` trên Odoo.
       - Trả về `{ reset_required, records, next_cursor }`.

---

## Output kiểm tra thực tế

### 1. Unit Tests Odoo (`./scripts/test-odoo-module.sh`)

```text
[test-odoo-module] Dropping any leftover 't_test_iteso_base'...
[test-odoo-module] Installing 'iteso_base' and 'iteso_sync' into fresh database 't_test_iteso_base'...
...
2026-11-27 16:30:01,175 40977 INFO t_test_iteso_base odoo.addons.iteso_sync.tests.test_sync: Starting TestItesoSync.test_01_idempotent_op_id ...
2026-11-27 16:30:01,220 40977 INFO t_test_iteso_base odoo.addons.iteso_sync.tests.test_sync: Starting TestItesoSync.test_02_atomic_savepoint_per_op ...
2026-11-27 16:30:01,252 40977 INFO t_test_iteso_base odoo.addons.iteso_sync.tests.test_sync: Starting TestItesoSync.test_03_unknown_op_type ...
2026-11-27 16:30:01,263 40977 INFO t_test_iteso_base odoo.addons.iteso_sync.tests.test_sync: Starting TestItesoSync.test_04_flag_review ...
2026-11-27 16:30:01,290 40977 INFO t_test_iteso_base odoo.addons.iteso_sync.tests.test_sync: Starting TestItesoSync.test_05_outbox_tracking ...
2026-11-27 16:30:01,309 40977 INFO t_test_iteso_base odoo.addons.iteso_sync.tests.test_sync: Starting TestItesoSync.test_06_pull_pagination_and_reset ...
2026-11-27 16:30:01,338 40977 INFO t_test_iteso_base odoo.addons.iteso_sync.tests.test_sync: Starting TestItesoSync.test_07_member_cannot_modify_ledger ...
2026-11-27 16:30:01,384 40977 INFO t_test_iteso_base odoo.service.server: 15 post-tests in 19.13s, 892 queries
2026-11-27 16:30:01,384 40977 INFO t_test_iteso_base odoo.tests.stats: iteso_base: 8 tests 0.31s 288 queries
2026-11-27 16:30:01,385 40977 INFO t_test_iteso_base odoo.tests.stats: iteso_sync: 9 tests 0.23s 206 queries
2026-11-27 16:30:01,385 40977 INFO t_test_iteso_base odoo.tests.stats: web: 6 tests 0.01s 12 queries
2026-11-27 16:30:01,385 40977 INFO t_test_iteso_base odoo.tests.result: 0 failed, 0 error(s) of 15 tests when loading database 't_test_iteso_base'
[test-odoo-module] ALL TESTS PASSED for iteso_base and iteso_sync.
```

### 2. Kiểm tra Phân quyền Database (`./scripts/test-db-isolation.sh`)

```text
[test-db-isolation] Verifying 'iteso_gateway' can connect to 'platform' and SELECT tenants...
[test-db-isolation] Verifying 'iteso_gateway' is DENIED access to 't_demo_fnb' (res_users)...
[test-db-isolation] Verifying 'iteso_gateway' cannot write to 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' cannot SELECT from 'admin_audit_log' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' cannot SELECT from 'accounts' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' can SELECT the 6 permitted columns from 'membership_odoo_users' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT unpermitted column 'last_error' or 'synced_at' on 'membership_odoo_users'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'tenant_odoo_system_keys' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'refresh_tokens' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' can SELECT permitted 4 columns from 'pos_devices' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT unpermitted column 'token_hash' on 'pos_devices'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'branches' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'pos_pairing_codes' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'membership_pins' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' can SELECT from 'pos_roster_issues' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT unpermitted column 'api_key_enc' on 'pos_devices'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'device_number_blocks' in 'platform'...
[test-db-isolation] PASS: All database isolation checks passed cleanly.
```

### 3. Kịch bản Nghiệm thu Toàn diện TASK-006 (`scripts/test-acceptance-criteria-task006.js`)

```text
=================================================================
STARTING TASK-006 ACCEPTANCE CRITERIA VERIFICATION
=================================================================

--- Setup: Authenticating demo accounts ---
Owner MID: 14345ef1-3243-45dc-80b6-f6f9d4a4d38e, Cashier MID: 250eeb60-290d-491b-b049-a5148fa17c96

--- Criterion 1: POS device pairing, roster download & device session token ---
✓ Criterion 1 PASS: Paired device, downloaded roster with jti, obtained device session token, confirmed mid route rejection.

--- Criterion 2: "Offline" generation of 3 contact.create operations ---
✓ Criterion 2 PASS: 3 offline operations generated with valid roster_jti and past client_time.

--- Criterion 3: "Online again" push: 3 applied, create_uid is cashier ---
Created partner IDs in Odoo: 52, 53, 54
id |         name         |                   login                    
----+----------------------+--------------------------------------------
 54 | Khách hàng Offline 3 | iteso-250eeb60-290d-491b-b049-a5148fa17c96
 53 | Khách hàng Offline 2 | iteso-250eeb60-290d-491b-b049-a5148fa17c96
 52 | Khách hàng Offline 1 | iteso-250eeb60-290d-491b-b049-a5148fa17c96
(3 rows)
✓ Criterion 3 PASS: 3 operations pushed and applied. Created records in Odoo have cashier create_uid.

--- Criterion 4: Idempotency of push batch ---
✓ Criterion 4 PASS: Idempotent push returned identical results without creating duplicates.

--- Criterion 5: Push with invalid roster or member not in roster -> rejected ---
✓ Criterion 5 PASS: Unauthorized members and foreign/fake rosters strictly rejected.

--- Criterion 6: Revoke permission pos.session.open -> needs_review & customer created ---
✓ Criterion 6 PASS: Operation executed when member lost permission is marked needs_review and customer is created.

--- Criterion 7: Disabled membership -> rejected with MEMBER_DISABLED ---
✓ Criterion 7 PASS: Disabled membership rejected with MEMBER_DISABLED.

--- Criterion 8: Outbox pull with cursor=0 and incremental updates ---
Snapshot records count: 52, next_cursor: 84
✓ Criterion 8 PASS: Pull snapshot contains created records; incremental pull returns updated contact.

--- Criterion 9: Number block allocation (2 devices x 3 blocks, non-overlapping) ---
Allocated blocks: [
  { start: 6001, end: 7000 },
  { start: 8001, end: 9000 },
  { start: 7001, end: 8000 },
  { start: 11001, end: 12000 },
  { start: 9001, end: 10000 },
  { start: 10001, end: 11000 }
]
✓ Criterion 9 PASS: 6 number blocks allocated concurrently without gaps or overlaps.

--- Criterion 10: Git history check for secrets ---
✓ Criterion 10 PASS: No secret keys, credentials or .env in git history.

=================================================================
ALL TASK-006 ACCEPTANCE CRITERIA PASSED SUCCESSFULLY (10/10)!
=================================================================
```

### 4. Kết quả `make test`

- `pnpm --filter @iteso/control-plane test`: 3 passed, 33 passed.
- `pnpm --filter @iteso/gateway test`: 3 passed, 34 passed.
- `scripts/test-db-isolation.sh`: PASS.
- `scripts/test-odoo-module.sh`: PASS (15/15 tests).
- `scripts/test-acceptance-criteria.js`: PASS (10/10 criteria).
- `scripts/test-acceptance-criteria-task006.js`: PASS (10/10 criteria).

---

## Vòng 2 (Sửa theo review Claude)

Đã hoàn thành toàn bộ 5 điểm trong mục "Bắt buộc sửa (vòng 2)":

### 1. Điểm 1: Bảo mật API nội bộ & Loại bỏ hoàn toàn endpoint trả key Odoo dạng rõ
- **Xóa endpoint:** Đã xóa bỏ hoàn toàn endpoint `GET /v1/internal/pos/devices/:id/odoo-credential` trên Control Plane.
- **Bảng `device_odoo_users`:** Tạo bảng `device_odoo_users` lưu trữ `odoo_uid`, `odoo_login`, `api_key_enc` (mã hóa đối xứng AES-256-GCM bằng `odoo_credentials.key`), `key_expires_at`, `status`. Bảng thuộc sở hữu của `iteso_control_plane`, chỉ cấp quyền `SELECT` cho `iteso_gateway`.
- **Gateway giải mã cục bộ:** `OdooCredentialService` trong Gateway truy vấn trực tiếp bảng `device_odoo_users` và giải mã cục bộ qua `odooCredentialsKey`, lưu cache và lắng nghe NATS event `platform.odoo_credentials.changed` để xóa cache khi thiết bị bị thu hồi hoặc đổi trạng thái.
- **Xác thực token nội bộ `X-Internal-Token`:**
  - Script `scripts/generate-keys.sh` sinh bí mật 32 byte hex ngẫu nhiên vào `infra/secrets/internal_api.token` (`chmod 600`).
  - Docker Compose mount file token và cấu hình `INTERNAL_API_TOKEN_PATH` cho cả `control-plane` và `gateway`.
  - Tạo `InternalTokenGuard` trên Control-plane bảo vệ toàn bộ các route `/v1/internal/*` (ví dụ `GET /v1/internal/memberships/:id/permissions`), so sánh constant-time bằng `crypto.timingSafeEqual`. Thiếu hoặc sai token trả về HTTP 401.

### 2. Điểm 2: Trạng thái thứ tư `retry` cho lỗi tạm thời & Cập nhật ADR-007
- **Bổ sung trạng thái `retry`:** Cập nhật ADR-007 mục "Bổ sung khi triển khai (28/11/2026 — Vòng 2 TASK-006)".
- **Odoo `apply_operations`:**
  - Chỉ ghi nhận `rejected` vào sổ cái `iteso.sync.operation` đối với các lỗi nghiệp vụ xác định (`INVALID_NAME`, `UNKNOWN_OP_TYPE`).
  - Mọi exception bất ngờ (lỗi kết nối, serialization failure, vi phạm ràng buộc unique `op_id` do hai request đồng thời) đều tự động rollback savepoint, **tuyệt đối không ghi sổ** và trả về `status: "retry"` kèm mã lỗi ngắn (`TEMPORARY_ERROR`, `CONCURRENT_OP`), không để lộ `str(exc)`.
- **Gateway `push`:**
  - Lỗi hạ tầng (Database connection timeout / error, Odoo trả HTTP 5xx, lỗi kết nối mạng tới Odoo) trả về trạng thái `retry` (`INFRASTRUCTURE_ERROR`, `ODOO_TEMPORARY_ERROR`, `ODOO_CALL_FAILED`, `ODOO_NO_RESPONSE`).
  - Trạng thái `rejected` với mã `MEMBER_DISABLED` chỉ được trả về khi người dùng Odoo của thành viên thực sự ở trạng thái vô hiệu hóa (`ForbiddenException`).

### 3. Điểm 3: Phân trang snapshot khi tải toàn bộ (`cursor = 0`)
- Cập nhật `iteso.outbox.pull` hỗ trợ phân trang snapshot qua tham số `snapshot_after_id` và `snapshot_until_outbox_id`, trả về cờ `has_more`.
- `next_cursor` được chốt bằng id outbox lớn nhất tại thời điểm bắt đầu snapshot (`snapshot_until_outbox_id`) và chỉ trả về ở trang cuối cùng (`has_more = false`).
- Các bản ghi bị sửa đổi trong lúc client đang tải snapshot sẽ tạo dòng outbox mới có ID lớn hơn `snapshot_until_outbox_id`, và được client nhận đầy đủ ngay trong lần gọi pull gia tăng (incremental) đầu tiên sau khi kết thúc snapshot.
- Viết test Odoo kiểm thử với 1.200 khách hàng (phân trang 3 đợt với `limit=500`), xác nhận nhận đủ 1.200 bản ghi, không trùng, không sót.

### 4. Điểm 4: Bổ sung Unit Tests cho Gateway và Control-plane
- **Gateway (`services/gateway/test/sync.spec.ts`):** 10 test cases kiểm thử logic thật của `SyncService`:
  - Từ chối lô thao tác > 200 items (`INVALID_BATCH_SIZE`).
  - Từ chối thao tác có device khác phiên đăng nhập (`DEVICE_MISMATCH`).
  - Từ chối thao tác có thành viên ngoài roster (`MEMBER_NOT_IN_ROSTER`).
  - Từ chối thao tác có roster hết hạn (`ROSTER_EXPIRED`).
  - Từ chối thao tác có thời gian tương lai > 5 phút (`FUTURE_TIMESTAMP`).
  - Đánh dấu `needs_review` khi thành viên bị thu hồi quyền `pos.session.open`.
  - Đánh dấu `needs_review` khi độ lệch thời gian > 10 phút.
  - Trả về `rejected` (`MEMBER_DISABLED`) khi thành viên bị vô hiệu hóa.
  - Trả về `retry` (`INFRASTRUCTURE_ERROR`) khi kiểm tra DB bị timeout.
  - Trả về `retry` (`ODOO_TEMPORARY_ERROR`) khi Odoo trả về 500.
  - Trả về `retry` (`ODOO_CALL_FAILED`) khi gọi mạng tới Odoo bị ngắt kết nối.
  - Trả về `retry` (`ODOO_NO_RESPONSE`) khi kết quả Odoo thiếu op.
  - *(Tổng test suites Gateway: 4 passed, 46/46 tests passed - tăng từ 34 tests)*.
- **Control-plane (`services/control-plane/test/pos-device.spec.ts`):**
  - Kiểm thử 10 yêu cầu cấp dải số đồng thời không chồng nhau: 10 blocks x 1.000 số, hoàn toàn liên tục từ 1 đến 10.000 không kẽ hở và không trùng lặp.
  - Kiểm thử `InternalTokenGuard`: từ chối thiếu token (401), từ chối token sai (401), chấp thuận token hợp lệ (200).
  - *(Tổng test suites Control-plane: 3 passed, 38/38 tests passed - tăng từ 33 tests)*.

### 5. Điểm 5: Thu hồi quyền `create` trên outbox của `base.group_user`
- Sửa [odoo-addons/iteso_sync/security/ir.access.csv](file:///home/iteso/projects/ITESO-ecosystem/odoo-addons/iteso_sync/security/ir.access.csv): `access_iteso_outbox_user` chuyển từ `cr` thành `r` (chỉ đọc).
- Toàn bộ việc ghi nhận outbox được thực hiện qua ORM hook với `iteso.outbox.sudo()`.
- Thêm test `test_08_member_cannot_create_outbox_directly` trong Odoo test suite, chứng minh thành viên gọi `.create()` trên outbox sẽ bị `AccessError`.

---

## Output thực tế kiểm tra Vòng 2

### 1. Unit Tests Odoo (`./scripts/test-odoo-module.sh`)
```text
2026-11-27 23:38:40,211 INFO t_test_iteso_base odoo.addons.iteso_sync.tests.test_sync: Starting TestItesoSync.test_08_member_cannot_create_outbox_directly ...
2026-11-27 23:38:40,221 INFO t_test_iteso_base odoo.addons.iteso_sync.tests.test_sync: Starting TestItesoSync.test_09_unexpected_exception_returns_retry_without_ledger_record ...
2026-11-27 23:38:40,235 WARNING t_test_iteso_base odoo.addons.iteso_sync.models.sync_operation: Temporary or unexpected failure processing sync operation: Database serialization failure
2026-11-27 23:38:40,258 INFO t_test_iteso_base odoo.addons.iteso_sync.tests.test_sync: Starting TestItesoSync.test_10_concurrent_operations_retry_and_applied ...
2026-11-27 23:38:40,287 WARNING t_test_iteso_base odoo.addons.iteso_sync.models.sync_operation: Temporary or unexpected failure processing sync operation: duplicate key value violates unique constraint
2026-11-27 23:38:40,291 INFO t_test_iteso_base odoo.addons.iteso_sync.tests.test_sync: Starting TestItesoSync.test_11_snapshot_pagination_1200_contacts ...
2026-11-27 23:38:41,469 INFO t_test_iteso_base odoo.tests.stats: iteso_base: 8 tests 0.48s 288 queries
2026-11-27 23:38:41,469 INFO t_test_iteso_base odoo.tests.stats: iteso_sync: 13 tests 1.48s 339 queries
2026-11-27 23:38:41,469 INFO t_test_iteso_base odoo.tests.stats: web: 6 tests 0.01s 12 queries
2026-11-27 23:38:41,469 INFO t_test_iteso_base odoo.tests.result: 0 failed, 0 error(s) of 19 tests when loading database 't_test_iteso_base'
[test-odoo-module] ALL TESTS PASSED for iteso_base and iteso_sync.
```

### 2. Unit Tests Services
- **Gateway:**
```text
PASS test/device-verification.spec.ts
PASS test/odoo-credential.spec.ts
PASS test/sync.spec.ts
PASS test/app.spec.ts
Test Suites: 4 passed, 4 total
Tests:       46 passed, 46 total
```

- **Control-plane:**
```text
PASS test/odoo-provisioning.spec.ts
PASS test/pos-device.spec.ts
PASS test/app.spec.ts
Test Suites: 3 passed, 3 total
Tests:       38 passed, 38 total
```

### 3. Kiểm tra DB Isolation (`./scripts/test-db-isolation.sh`)
```text
[test-db-isolation] Verifying 'iteso_gateway' can SELECT from 'pos_roster_issues' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' can SELECT from 'device_odoo_users' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT INSERT into 'device_odoo_users' in 'platform'...
[test-db-isolation] Verifying 'iteso_gateway' CANNOT SELECT from 'device_number_blocks' in 'platform'...
[test-db-isolation] PASS: All database isolation checks passed cleanly.
```

### 4. Kiểm tra Tiêu chí nghiệm thu đầu-cuối (`node scripts/test-acceptance-criteria-task006.js`)
```text
=================================================================
STARTING TASK-006 ACCEPTANCE CRITERIA VERIFICATION
=================================================================

--- Setup: Authenticating demo accounts ---
Owner MID: 14345ef1-3243-45dc-80b6-f6f9d4a4d38e, Cashier MID: 250eeb60-290d-491b-b049-a5148fa17c96

--- Criterion 1: POS device pairing, roster download & device session token ---
✓ Criterion 1 PASS: Paired device, downloaded roster with jti, obtained device session token, confirmed mid route rejection.

--- Criterion 2: "Offline" generation of 3 contact.create operations ---
✓ Criterion 2 PASS: 3 offline operations generated with valid roster_jti and past client_time.

--- Criterion 3: "Online again" push: 3 applied, create_uid is cashier ---
✓ Criterion 3 PASS: 3 operations pushed and applied. Created records in Odoo have cashier create_uid.

--- Criterion 4: Idempotency of push batch ---
✓ Criterion 4 PASS: Idempotent push returned identical results without creating duplicates.

--- Criterion 5: Push with invalid roster or member not in roster -> rejected ---
✓ Criterion 5 PASS: Unauthorized members and foreign/fake rosters strictly rejected.

--- Criterion 6: Revoke permission pos.session.open -> needs_review & customer created ---
✓ Criterion 6 PASS: Operation executed when member lost permission is marked needs_review and customer is created.

--- Criterion 7: Disabled membership -> rejected with MEMBER_DISABLED ---
✓ Criterion 7 PASS: Disabled membership rejected with MEMBER_DISABLED.

--- Criterion 8: Outbox pull with cursor=0 and incremental updates ---
✓ Criterion 8 PASS: Pull snapshot contains created records; incremental pull returns updated contact.

--- Criterion 9: Number block allocation (2 devices x 3 blocks, non-overlapping) ---
Allocated blocks: [
  { start: 30001, end: 31000 },
  { start: 33001, end: 34000 },
  { start: 31001, end: 32000 },
  { start: 34001, end: 35000 },
  { start: 35001, end: 36000 },
  { start: 32001, end: 33000 }
]
✓ Criterion 9 PASS: 6 number blocks allocated concurrently without gaps or overlaps.

--- Criterion 10: Internal API Token authentication & Endpoint security ---
device_odoo_users row count & encrypted key count: 9 |     9
✓ Criterion 10 PASS: Internal routes protected with 32-byte token; old cleartext credential endpoint removed; device keys encrypted in device_odoo_users.

--- Criterion 11: Concurrent push batches with same op_id (Retry & Idempotency) ---
Concurrent Push A result: {
  op_id: '018e0000-0000-7000-8000-000000000999',
  status: 'applied',
  result: { id: 93 },
  reason: null
}
Concurrent Push B result: {
  op_id: '018e0000-0000-7000-8000-000000000999',
  status: 'retry',
  result: null,
  reason: 'CONCURRENT_OP'
}
Retried op result: {
  op_id: '018e0000-0000-7000-8000-000000000999',
  status: 'applied',
  result: { id: 93 },
  reason: false
}
✓ Criterion 11 PASS: Concurrent pushes handled safely with retry/idempotency, exactly 1 contact created.

--- Criterion 12: Git history check for secrets ---
✓ Criterion 12 PASS: No secret keys, credentials or .env in git history.

=================================================================
ALL TASK-006 ACCEPTANCE CRITERIA PASSED SUCCESSFULLY (12/12)!
=================================================================
```
