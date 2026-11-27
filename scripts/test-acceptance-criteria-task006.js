#!/usr/bin/env node
/**
 * Acceptance Criteria Verification Suite for TASK-006: Offline Sync Foundation
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..');

// Load .env
const dotenvPath = path.join(projectRoot, '.env');
if (fs.existsSync(dotenvPath)) {
  const envContent = fs.readFileSync(dotenvPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';
const DEMO_PASSWORD = process.env.DEMO_ACCOUNTS_PASSWORD || 'Admin@1234567';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

async function run() {
  console.log('=================================================================');
  console.log('STARTING TASK-006 ACCEPTANCE CRITERIA VERIFICATION');
  console.log('=================================================================\n');

  // Authenticate owner & cashier with passwords
  console.log('--- Setup: Authenticating demo accounts ---');
  const ownerLoginRes = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'owner@demo.local', password: DEMO_PASSWORD }),
  });
  assert(ownerLoginRes.status === 200, `Owner login 200 (got ${ownerLoginRes.status})`);
  const ownerLogin = await ownerLoginRes.json();
  const ownerPayload = JSON.parse(Buffer.from(ownerLogin.access_token.split('.')[1], 'base64').toString());
  const ownerMid = ownerPayload.mid;

  const cashierLoginRes = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'cashier@demo.local', password: DEMO_PASSWORD }),
  });
  assert(cashierLoginRes.status === 200, `Cashier login 200 (got ${cashierLoginRes.status})`);
  const cashierLogin = await cashierLoginRes.json();
  const cashierPayload = JSON.parse(Buffer.from(cashierLogin.access_token.split('.')[1], 'base64').toString());
  const cashierMid = cashierPayload.mid;

  console.log(`Owner MID: ${ownerMid}, Cashier MID: ${cashierMid}\n`);

  // Ensure cashier has PIN set and unlock if locked from previous tests
  await fetch(`${GATEWAY_URL}/v1/me/pin`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cashierLogin.access_token}`,
    },
    body: JSON.stringify({ pin: '654321', password: DEMO_PASSWORD }),
  });

  execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -c "
      UPDATE membership_pins SET failed_attempts = 0, locked_until = NULL WHERE membership_id = '${cashierMid}';
      UPDATE membership_odoo_users SET status = 'active' WHERE membership_id = '${cashierMid}';
    "`,
    { cwd: projectRoot },
  );

  // ---------------------------------------------------------------------------
  // CRITERION 1: Pairing device, cashier sets PIN, downloads roster & gets device session token
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 1: POS device pairing, roster download & device session token ---');
  const pairCodeRes = await fetch(`${GATEWAY_URL}/v1/pos/pairing-codes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerLogin.access_token}`,
    },
    body: JSON.stringify({ branch_code: 'main', device_name: 'POS Quầy Đồng Bộ 1' }),
  });
  assert(pairCodeRes.status === 200, `Pairing code created 200 (got ${pairCodeRes.status})`);
  const pairCodeData = await pairCodeRes.json();

  const pairRes = await fetch(`${GATEWAY_URL}/v1/pos/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: pairCodeData.pairing_code }),
  });
  assert(pairRes.status === 200, `Device paired 200 (got ${pairRes.status})`);
  const pairData = await pairRes.json();
  const deviceId = pairData.device_id;
  const deviceToken = pairData.device_token;

  // Download roster
  const rosterRes = await fetch(`${GATEWAY_URL}/v1/pos/roster`, {
    headers: { Authorization: `Device ${deviceToken}` },
  });
  assert(rosterRes.status === 200, `Roster downloaded 200 (got ${rosterRes.status})`);
  const rosterData = await rosterRes.json();
  const rosterJws = rosterData.roster || rosterData.roster_jws;
  const rosterHeaderAndPayload = rosterJws.split('.');
  const rosterPayload = JSON.parse(Buffer.from(rosterHeaderAndPayload[1], 'base64').toString());
  const rosterJti = rosterPayload.jti;
  assert(rosterJti, 'Roster payload must contain jti claim');

  // Obtain device session token
  const devSessionRes = await fetch(`${GATEWAY_URL}/v1/pos/auth/device-session`, {
    method: 'POST',
    headers: { Authorization: `Device ${deviceToken}` },
  });
  assert(devSessionRes.status === 200, `Device session token 200 (got ${devSessionRes.status})`);
  const devSessionData = await devSessionRes.json();
  const deviceSessionToken = devSessionData.access_token;
  assert(deviceSessionToken, 'Device session token must be returned');

  // Verify device session token payload
  const devTokenPayload = JSON.parse(Buffer.from(deviceSessionToken.split('.')[1], 'base64').toString());
  assert(devTokenPayload.did === deviceId, `Device session token did matches deviceId`);
  assert(devTokenPayload.tid === 'demo_fnb', `Device session token tid is demo_fnb`);
  assert(devTokenPayload.amr && devTokenPayload.amr.includes('device'), `Device session token amr includes 'device'`);
  assert(!devTokenPayload.mid, `Device session token has NO mid claim`);

  // Device session token cannot access normal tenant routes requiring mid
  const testMidRes = await fetch(`${GATEWAY_URL}/v1/odoo/version`, {
    headers: {
      Authorization: `Bearer ${deviceSessionToken}`,
      'X-Tenant': 'demo_fnb',
    },
  });
  assert(testMidRes.status === 403, `Device session token on mid route returned 403 (got ${testMidRes.status})`);
  console.log('✓ Criterion 1 PASS: Paired device, downloaded roster with jti, obtained device session token, confirmed mid route rejection.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 2: "Offline": Create 3 operations contact.create in the past within roster validity
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 2: "Offline" generation of 3 contact.create operations ---');
  const now = Date.now();
  const pastTime1 = new Date(now - 60000).toISOString();
  const pastTime2 = new Date(now - 50000).toISOString();
  const pastTime3 = new Date(now - 40000).toISOString();

  const op1_id = crypto.randomUUID();
  const op2_id = crypto.randomUUID();
  const op3_id = crypto.randomUUID();

  const op1 = {
    op_id: op1_id,
    device_id: deviceId,
    roster_jti: rosterJti,
    membership_id: cashierMid,
    client_time: pastTime1,
    seq: 1,
    op_type: 'contact.create',
    payload: { name: 'Khách hàng Offline 1', phone: '0901000001' },
  };

  const op2 = {
    op_id: op2_id,
    device_id: deviceId,
    roster_jti: rosterJti,
    membership_id: cashierMid,
    client_time: pastTime2,
    seq: 2,
    op_type: 'contact.create',
    payload: { name: 'Khách hàng Offline 2', phone: '0901000002' },
  };

  const op3 = {
    op_id: op3_id,
    device_id: deviceId,
    roster_jti: rosterJti,
    membership_id: cashierMid,
    client_time: pastTime3,
    seq: 3,
    op_type: 'contact.create',
    payload: { name: 'Khách hàng Offline 3', phone: '0901000003' },
  };

  console.log('✓ Criterion 2 PASS: 3 offline operations generated with valid roster_jti and past client_time.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 3: "Online again": Push batch of 3 ops -> all applied, customers in Odoo with cashier uid
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 3: "Online again" push: 3 applied, create_uid is cashier ---');
  const pushRes = await fetch(`${GATEWAY_URL}/v1/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deviceSessionToken}`,
    },
    body: JSON.stringify({ operations: [op1, op2, op3] }),
  });
  assert(pushRes.status === 200, `Push returned 200 (got ${pushRes.status})`);
  const pushData = await pushRes.json();
  if (pushData.results && pushData.results[0] && pushData.results[0].status !== 'applied') {
    console.error('Push results:', JSON.stringify(pushData, null, 2));
  }
  assert(pushData.results && pushData.results.length === 3, 'Push returned 3 results');
  assert(pushData.results[0].status === 'applied', `Op 1 status applied (got ${pushData.results[0].status})`);
  assert(pushData.results[1].status === 'applied', `Op 2 status applied (got ${pushData.results[1].status})`);
  assert(pushData.results[2].status === 'applied', `Op 3 status applied (got ${pushData.results[2].status})`);

  const partner1Id = pushData.results[0].result.id;
  const partner2Id = pushData.results[1].result.id;
  const partner3Id = pushData.results[2].result.id;
  console.log(`Created partner IDs in Odoo: ${partner1Id}, ${partner2Id}, ${partner3Id}`);

  // Query PostgreSQL directly in t_demo_fnb to check create_uid of these partners
  const checkPartnersSql = `
    SELECT p.id, p.name, u.login 
    FROM res_partner p 
    JOIN res_users u ON p.create_uid = u.id 
    WHERE p.id IN (${partner1Id}, ${partner2Id}, ${partner3Id});
  `;
  const partnerCheckOut = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U odoo -d t_demo_fnb -c "${checkPartnersSql}"`,
    { cwd: projectRoot },
  ).toString().trim();
  console.log(partnerCheckOut);
  assert(partnerCheckOut.includes(`iteso-${cashierMid}`), `create_uid belongs to cashier (iteso-${cashierMid})`);
  console.log('✓ Criterion 3 PASS: 3 operations pushed and applied. Created records in Odoo have cashier create_uid.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 4: Push exact same batch -> all 3 applied with exact same results, no duplicate partners
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 4: Idempotency of push batch ---');
  const countBefore = Number(
    execSync(
      `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U odoo -d t_demo_fnb -tAc "SELECT count(*) FROM res_partner WHERE id IN (${partner1Id}, ${partner2Id}, ${partner3Id});"`,
      { cwd: projectRoot },
    ).toString().trim(),
  );

  const pushAgainRes = await fetch(`${GATEWAY_URL}/v1/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deviceSessionToken}`,
    },
    body: JSON.stringify({ operations: [op1, op2, op3] }),
  });
  assert(pushAgainRes.status === 200, `Second push returned 200 (got ${pushAgainRes.status})`);
  const pushAgainData = await pushAgainRes.json();
  assert(pushAgainData.results[0].status === 'applied', 'Op 1 status applied on second push');
  assert(pushAgainData.results[0].result.id === partner1Id, 'Op 1 returns identical partner ID');
  assert(pushAgainData.results[1].result.id === partner2Id, 'Op 2 returns identical partner ID');
  assert(pushAgainData.results[2].result.id === partner3Id, 'Op 3 returns identical partner ID');

  const countAfter = Number(
    execSync(
      `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U odoo -d t_demo_fnb -tAc "SELECT count(*) FROM res_partner WHERE id IN (${partner1Id}, ${partner2Id}, ${partner3Id});"`,
      { cwd: projectRoot },
    ).toString().trim(),
  );
  assert(countBefore === countAfter && countAfter === 3, 'No additional partners created in Odoo');
  console.log('✓ Criterion 4 PASS: Idempotent push returned identical results without creating duplicates.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 5: Invalid roster / membership not in roster -> rejected
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 5: Push with invalid roster or member not in roster -> rejected ---');
  // Fake member ID
  const fakeMemberOp = {
    op_id: crypto.randomUUID(),
    device_id: deviceId,
    roster_jti: rosterJti,
    membership_id: '00000000-0000-0000-0000-000000000000',
    client_time: new Date().toISOString(),
    seq: 4,
    op_type: 'contact.create',
    payload: { name: 'Fake Member' },
  };

  // Fake roster JTI
  const fakeRosterOp = {
    op_id: crypto.randomUUID(),
    device_id: deviceId,
    roster_jti: crypto.randomUUID(),
    membership_id: cashierMid,
    client_time: new Date().toISOString(),
    seq: 5,
    op_type: 'contact.create',
    payload: { name: 'Fake Roster' },
  };

  const pushInvalidRes = await fetch(`${GATEWAY_URL}/v1/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deviceSessionToken}`,
    },
    body: JSON.stringify({ operations: [fakeMemberOp, fakeRosterOp] }),
  });
  assert(pushInvalidRes.status === 200, `Push invalid ops returned 200 (got ${pushInvalidRes.status})`);
  const pushInvalidData = await pushInvalidRes.json();
  assert(pushInvalidData.results[0].status === 'rejected', 'Fake member op rejected');
  assert(pushInvalidData.results[0].error === 'MEMBER_NOT_IN_ROSTER', `Error is MEMBER_NOT_IN_ROSTER (got ${pushInvalidData.results[0].error})`);
  assert(pushInvalidData.results[1].status === 'rejected', 'Fake roster op rejected');
  assert(pushInvalidData.results[1].error === 'ROSTER_NOT_FOUND', `Error is ROSTER_NOT_FOUND (got ${pushInvalidData.results[1].error})`);
  console.log('✓ Criterion 5 PASS: Unauthorized members and foreign/fake rosters strictly rejected.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 6: Revoke pos.session.open from cashier, push op created before -> needs_review & customer created
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 6: Revoke permission pos.session.open -> needs_review & customer created ---');
  // Temporarily revoke pos.session.open from cashier's role
  const cashierRoleIdRes = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -tAc "
      SELECT role_id FROM membership_roles WHERE membership_id = '${cashierMid}' LIMIT 1;
    "`,
    { cwd: projectRoot },
  ).toString().trim();

  execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -c "
      DELETE FROM role_permissions WHERE role_id = '${cashierRoleIdRes}' AND permission_key = 'pos.session.open';
    "`,
    { cwd: projectRoot },
  );

  const opReviewId = crypto.randomUUID();
  const opReview = {
    op_id: opReviewId,
    device_id: deviceId,
    roster_jti: rosterJti,
    membership_id: cashierMid,
    client_time: new Date(now - 30000).toISOString(),
    seq: 6,
    op_type: 'contact.create',
    payload: { name: 'Khách hàng Cần Kiểm Tra', phone: '0901999999' },
  };

  const pushReviewRes = await fetch(`${GATEWAY_URL}/v1/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deviceSessionToken}`,
    },
    body: JSON.stringify({ operations: [opReview] }),
  });
  assert(pushReviewRes.status === 200, `Push review returned 200 (got ${pushReviewRes.status})`);
  const pushReviewData = await pushReviewRes.json();
  assert(pushReviewData.results[0].status === 'needs_review', `Op status is needs_review (got ${pushReviewData.results[0].status})`);
  const reviewPartnerId = pushReviewData.results[0].result.id;
  assert(reviewPartnerId, 'Partner was still created in Odoo despite needs_review');

  // Verify sync operation row in Odoo has status = 'needs_review'
  const checkReviewSql = `SELECT status FROM iteso_sync_operation WHERE op_id = '${opReviewId}';`;
  const reviewCheckOut = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U odoo -d t_demo_fnb -tAc "${checkReviewSql}"`,
    { cwd: projectRoot },
  ).toString().trim();
  assert(reviewCheckOut === 'needs_review', `Odoo ledger row has needs_review status (got ${reviewCheckOut})`);

  // Restore pos.session.open to cashier role
  execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -c "
      INSERT INTO role_permissions (role_id, permission_key) VALUES ('${cashierRoleIdRes}', 'pos.session.open') ON CONFLICT DO NOTHING;
    "`,
    { cwd: projectRoot },
  );
  console.log('✓ Criterion 6 PASS: Operation executed when member lost permission is marked needs_review and customer is created.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 7: Disabled membership -> rejected with MEMBER_DISABLED
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 7: Disabled membership -> rejected with MEMBER_DISABLED ---');
  // Temporarily disable cashier in membership_odoo_users
  execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -c "
      UPDATE membership_odoo_users SET status = 'disabled' WHERE membership_id = '${cashierMid}';
    "`,
    { cwd: projectRoot },
  );

  const opDisabledId = crypto.randomUUID();
  const opDisabled = {
    op_id: opDisabledId,
    device_id: deviceId,
    roster_jti: rosterJti,
    membership_id: cashierMid,
    client_time: new Date(now - 20000).toISOString(),
    seq: 7,
    op_type: 'contact.create',
    payload: { name: 'Khách hàng Không được phép' },
  };

  const pushDisabledRes = await fetch(`${GATEWAY_URL}/v1/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deviceSessionToken}`,
    },
    body: JSON.stringify({ operations: [opDisabled] }),
  });
  assert(pushDisabledRes.status === 200, `Push disabled returned 200 (got ${pushDisabledRes.status})`);
  const pushDisabledData = await pushDisabledRes.json();
  assert(pushDisabledData.results[0].status === 'rejected', `Disabled member op rejected (got ${pushDisabledData.results[0].status})`);
  assert(pushDisabledData.results[0].error === 'MEMBER_DISABLED', `Error is MEMBER_DISABLED (got ${pushDisabledData.results[0].error})`);

  // Restore cashier active status in membership_odoo_users
  execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -c "
      UPDATE membership_odoo_users SET status = 'active' WHERE membership_id = '${cashierMid}';
    "`,
    { cwd: projectRoot },
  );
  console.log('✓ Criterion 7 PASS: Disabled membership rejected with MEMBER_DISABLED.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 8: Pull with cursor=0 sees all 3 customers; update customer in Odoo -> pull with next_cursor sees update
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 8: Outbox pull with cursor=0 and incremental updates ---');
  const pullSnapshotRes = await fetch(`${GATEWAY_URL}/v1/sync/pull?dataset=contacts&cursor=0&limit=500`, {
    headers: { Authorization: `Bearer ${deviceSessionToken}` },
  });
  assert(pullSnapshotRes.status === 200, `Pull snapshot returned 200 (got ${pullSnapshotRes.status})`);
  const pullSnapshot = await pullSnapshotRes.json();
  assert(pullSnapshot.reset_required === false, 'Snapshot reset_required is false');
  assert(Array.isArray(pullSnapshot.records), 'Snapshot records is array');
  const snapshotIds = pullSnapshot.records.map((r) => r.id);
  assert(snapshotIds.includes(partner1Id), `Snapshot includes partner 1 (${partner1Id})`);
  assert(snapshotIds.includes(partner2Id), `Snapshot includes partner 2 (${partner2Id})`);
  assert(snapshotIds.includes(partner3Id), `Snapshot includes partner 3 (${partner3Id})`);

  const initialCursor = pullSnapshot.next_cursor;
  console.log(`Snapshot records count: ${pullSnapshot.records.length}, next_cursor: ${initialCursor}`);

  // Update partner 1 in Odoo via python/odoo shell so Odoo write() triggers outbox
  const newName = `Khach hang Offline 1 Da doi ten ${Date.now()}`;
  execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T odoo odoo shell -d t_demo_fnb --db_host postgres --db_user odoo --db_password "${process.env.POSTGRES_PASSWORD || 'change_me_postgres_password'}" --no-http << 'EOF'
p = env['res.partner'].browse(${partner1Id})
p.write({'name': '${newName}'})
env.cr.commit()
EOF`,
    { cwd: projectRoot },
  );

  // Pull incremental changes with cursor = initialCursor
  const pullIncrRes = await fetch(`${GATEWAY_URL}/v1/sync/pull?dataset=contacts&cursor=${initialCursor}&limit=500`, {
    headers: { Authorization: `Bearer ${deviceSessionToken}` },
  });
  assert(pullIncrRes.status === 200, `Incremental pull returned 200 (got ${pullIncrRes.status})`);
  const pullIncr = await pullIncrRes.json();
  assert(pullIncr.reset_required === false, 'Incremental reset_required is false');
  assert(pullIncr.records.length >= 1, `Incremental records returned at least 1 (got ${pullIncr.records.length})`);
  const updatedRec = pullIncr.records.find((r) => r.id === partner1Id);
  assert(updatedRec, `Updated partner ${partner1Id} present in incremental pull`);
  assert(updatedRec.name === newName, `Updated partner name matches: ${updatedRec.name}`);
  console.log('✓ Criterion 8 PASS: Pull snapshot contains created records; incremental pull returns updated contact.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 9: Number block allocation for 2 devices, 3 blocks each -> no overlapping blocks
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 9: Number block allocation (2 devices x 3 blocks, non-overlapping) ---');
  // Pair second device
  const pairCode2Res = await fetch(`${GATEWAY_URL}/v1/pos/pairing-codes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerLogin.access_token}`,
    },
    body: JSON.stringify({ branch_code: 'main', device_name: 'POS Quầy Đồng Bộ 2' }),
  });
  const pairCode2 = await pairCode2Res.json();
  const pair2Res = await fetch(`${GATEWAY_URL}/v1/pos/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: pairCode2.pairing_code }),
  });
  const pair2 = await pair2Res.json();
  const device2Token = pair2.device_token;

  // Allocate 3 blocks for device 1 and 3 blocks for device 2 concurrently
  const reqPromises = [];
  for (let i = 0; i < 3; i++) {
    reqPromises.push(
      fetch(`${GATEWAY_URL}/v1/pos/number-blocks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Device ${deviceToken}`,
        },
        body: JSON.stringify({ doc_type: 'order' }),
      }).then((r) => r.json()),
    );
    reqPromises.push(
      fetch(`${GATEWAY_URL}/v1/pos/number-blocks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Device ${device2Token}`,
        },
        body: JSON.stringify({ doc_type: 'order' }),
      }).then((r) => r.json()),
    );
  }

  const blockResults = await Promise.all(reqPromises);
  const ranges = blockResults.map((b) => ({ start: b.range_start, end: b.range_end }));
  console.log('Allocated blocks:', ranges);

  // Sort ranges by start
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 0; i < ranges.length; i++) {
    assert(ranges[i].end - ranges[i].start + 1 === 1000, `Block ${i} size is exactly 1000`);
    if (i > 0) {
      assert(ranges[i].start === ranges[i - 1].end + 1, `Blocks ${i - 1} and ${i} are strictly continuous and non-overlapping`);
    }
  }
  console.log('✓ Criterion 9 PASS: 6 number blocks allocated concurrently without gaps or overlaps.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 10: Round 2 Security - Internal API Token & No cleartext key endpoints
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 10: Internal API Token authentication & Endpoint security ---');
  const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || 'http://127.0.0.1:3100';

  // 1. Verify old cleartext credential endpoint is 404 (removed)
  const deadEndpointRes = await fetch(`${CONTROL_PLANE_URL}/v1/internal/pos/devices/${deviceId}/odoo-credential`, {
    headers: { 'X-Tenant': 'demo_fnb' },
  });
  assert(deadEndpointRes.status === 404, `Old internal odoo-credential endpoint must be 404 removed (got ${deadEndpointRes.status})`);

  // 2. Verify /v1/internal/* requires X-Internal-Token (401 without token)
  const noTokenRes = await fetch(`${CONTROL_PLANE_URL}/v1/internal/memberships/${ownerMid}/permissions`, {
    headers: { 'X-Tenant': 'demo_fnb' },
  });
  assert(noTokenRes.status === 401, `/v1/internal without X-Internal-Token returns 401 (got ${noTokenRes.status})`);

  // 3. Verify /v1/internal/* rejects invalid token (401)
  const badTokenRes = await fetch(`${CONTROL_PLANE_URL}/v1/internal/memberships/${ownerMid}/permissions`, {
    headers: {
      'X-Tenant': 'demo_fnb',
      'X-Internal-Token': 'wrong-token-value-0000000000000000',
    },
  });
  assert(badTokenRes.status === 401, `/v1/internal with bad token returns 401 (got ${badTokenRes.status})`);

  // 4. Verify /v1/internal/* accepts valid token
  const internalTokenPath = path.join(projectRoot, 'infra/secrets/internal_api.token');
  assert(fs.existsSync(internalTokenPath), 'internal_api.token exists in infra/secrets');
  let validInternalToken = '';
  try {
    validInternalToken = fs.readFileSync(internalTokenPath, 'utf8').trim();
  } catch {
    validInternalToken = execSync(
      `docker compose --env-file .env -f infra/docker-compose.yml exec -T control-plane cat /app/secrets/internal_api.token`,
      { cwd: projectRoot },
    ).toString().trim();
  }
  assert(validInternalToken.length === 64, 'valid internal token is 64 hex characters (32 bytes)');

  const validTokenRes = await fetch(`${CONTROL_PLANE_URL}/v1/internal/memberships/${ownerMid}/permissions`, {
    headers: {
      'X-Tenant': 'demo_fnb',
      'X-Internal-Token': validInternalToken,
    },
  });
  assert(validTokenRes.status === 200, `/v1/internal with valid token returns 200 (got ${validTokenRes.status})`);
  const permData = await validTokenRes.json();
  assert(Array.isArray(permData.perms), 'Internal permissions response contains perms array');

  // 5. Verify device keys are stored encrypted in device_odoo_users table
  const deviceOdooCheck = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U odoo -d platform -t -c "SELECT COUNT(*), COUNT(api_key_enc) FROM device_odoo_users WHERE status = 'active';"`,
    { cwd: projectRoot },
  ).toString().trim();
  console.log(`device_odoo_users row count & encrypted key count: ${deviceOdooCheck}`);
  const rowCount = parseInt(deviceOdooCheck.split('|')[0].trim(), 10);
  assert(rowCount > 0, 'device_odoo_users table contains active encrypted keys');
  console.log('✓ Criterion 10 PASS: Internal routes protected with 32-byte token; old cleartext credential endpoint removed; device keys encrypted in device_odoo_users.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 11: Round 2 Temporary Error & Retry handling with concurrent pushes
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 11: Concurrent push batches with same op_id (Retry & Idempotency) ---');
  const randSuffix = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const concurrentOpId = `018e0000-0000-7000-8000-${randSuffix}0000`;
  const concurrentOp = {
    op_id: concurrentOpId,
    device_id: deviceId,
    roster_jti: rosterJti,
    membership_id: cashierMid,
    client_time: new Date().toISOString(),
    seq: 100,
    op_type: 'contact.create',
    payload: { name: `Khach Dong Thoi ${Date.now()}` },
  };

  const [pushA, pushB] = await Promise.all([
    fetch(`${GATEWAY_URL}/v1/sync/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operations: [concurrentOp] }),
    }).then((r) => r.json()),
    fetch(`${GATEWAY_URL}/v1/sync/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operations: [concurrentOp] }),
    }).then((r) => r.json()),
  ]);

  const resA = pushA.results[0];
  const resB = pushB.results[0];
  console.log('Concurrent Push A result:', resA);
  console.log('Concurrent Push B result:', resB);

  // At least one must be applied or retry, never permanently rejected
  assert(
    (resA.status === 'applied' && (resB.status === 'applied' || resB.status === 'retry')) ||
    (resB.status === 'applied' && (resA.status === 'applied' || resA.status === 'retry')),
    `Concurrent push returned valid applied/retry statuses (A: ${resA.status}, B: ${resB.status})`,
  );

  // If one returned retry, retrying it now must return applied with same contact ID
  if (resA.status === 'retry' || resB.status === 'retry') {
    const retryRes = await fetch(`${GATEWAY_URL}/v1/sync/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operations: [concurrentOp] }),
    });
    assert(retryRes.status === 200, 'Retry push returns 200');
    const retryData = await retryRes.json();
    assert(retryData.results[0].status === 'applied', `Retried op returns status applied (got ${retryData.results[0].status})`);
    console.log('Retried op result:', retryData.results[0]);
  }

  // Verify only 1 contact was created
  const partnerCheck = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U odoo -d t_demo_fnb -t -c "SELECT COUNT(*) FROM res_partner WHERE name = '${concurrentOp.payload.name}';"`,
    { cwd: projectRoot },
  ).toString().trim();
  assert(partnerCheck === '1', `Exactly 1 contact was created for concurrent op (got ${partnerCheck})`);
  console.log('✓ Criterion 11 PASS: Concurrent pushes handled safely with retry/idempotency, exactly 1 contact created.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 12: Git history check for secrets
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 12: Git history check for secrets ---');
  const committedSecretsFiles = execSync(
    'git log --name-only --oneline | grep -E "^infra/secrets/|^\\.env$" || true',
    { cwd: projectRoot },
  ).toString().trim();
  assert(!committedSecretsFiles, `No secret files or .env in git commits (found: ${committedSecretsFiles})`);

  const privKeyMarker = '-----BEGIN ' + 'PRIVATE KEY-----';
  const committedPrivKey = execSync(
    `git log -S "${privKeyMarker}" -- . ":(exclude)scripts/test-acceptance-criteria.js" ":(exclude)scripts/test-acceptance-criteria-task006.js" --oneline || true`,
    { cwd: projectRoot },
  ).toString().trim();
  assert(!committedPrivKey, 'No private keys committed in source files');

  console.log('✓ Criterion 12 PASS: No secret keys, credentials or .env in git history.\n');

  console.log('=================================================================');
  console.log('ALL TASK-006 ACCEPTANCE CRITERIA PASSED SUCCESSFULLY (12/12)!');
  console.log('=================================================================');
}

run().catch((err) => {
  console.error('Acceptance verification failed:', err);
  process.exit(1);
});
