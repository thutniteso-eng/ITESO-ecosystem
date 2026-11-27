#!/usr/bin/env node
/**
 * Acceptance Criteria Verification Suite (TASK-005: Shared POS Devices, PIN Auth & Offline Roster)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

const jose = require(path.join(projectRoot, 'services/control-plane/node_modules/jose'));
const argon2 = require(path.join(projectRoot, 'services/control-plane/node_modules/argon2'));

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || 'http://localhost:3100';
const DEMO_PASSWORD = process.env.DEMO_ACCOUNTS_PASSWORD || 'Admin@1234567';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AdminPassword@123';
const TOTP_SECRET = process.env.TOTP_SECRET || 'JBSWY3DPEHPK3PXP';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

function getTotp(secret) {
  return execSync(`node scripts/get-totp.js ${secret}`, { cwd: projectRoot }).toString().trim();
}

async function run() {
  console.log('=================================================================');
  console.log('STARTING TASK-005 ACCEPTANCE CRITERIA VERIFICATION');
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

  // ---------------------------------------------------------------------------
  // CRITERION 1: Owner creates pairing code for branch 'main'; simulator pairs device
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 1: Pairing code generation & POS device pairing ---');
  const pairCodeRes = await fetch(`${GATEWAY_URL}/v1/pos/pairing-codes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerLogin.access_token}`,
    },
    body: JSON.stringify({ branch_code: 'main', device_name: 'POS Quầy 1' }),
  });
  assert(pairCodeRes.status === 200 || pairCodeRes.status === 201, `Create pairing code 200/201 (got ${pairCodeRes.status})`);
  const pairCodeData = await pairCodeRes.json();
  console.log('Pairing code response:', pairCodeData);

  assert(pairCodeData.pairing_code, 'Pairing code generated');
  assert(
    /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(pairCodeData.pairing_code),
    `Pairing code '${pairCodeData.pairing_code}' matches 8-char charset (no 0, O, 1, I)`,
  );

  // Simulator pairs device
  const pairDeviceRes = await fetch(`${GATEWAY_URL}/v1/pos/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: pairCodeData.pairing_code }),
  });
  assert(pairDeviceRes.status === 200, `Pair device 200 (got ${pairDeviceRes.status})`);
  const pairDeviceData = await pairDeviceRes.json();
  console.log('Paired device info:', {
    device_id: pairDeviceData.device_id,
    branch: pairDeviceData.branch,
    has_token: !!pairDeviceData.device_token,
    has_jwk: !!pairDeviceData.roster_public_jwk,
  });

  assert(pairDeviceData.device_id, 'device_id returned');
  assert(pairDeviceData.device_token && pairDeviceData.device_token.length === 64, 'device_token is 64-char hex');
  assert(pairDeviceData.branch && pairDeviceData.branch.code === 'main', 'branch is main');
  assert(pairDeviceData.roster_public_jwk && pairDeviceData.roster_public_jwk.kty === 'OKP', 'roster_public_jwk returned');

  const deviceId = pairDeviceData.device_id;
  const deviceToken = pairDeviceData.device_token;
  const rosterJwk = pairDeviceData.roster_public_jwk;
  console.log('✓ Criterion 1 PASS: Pairing code generated and device paired successfully.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 2: Cashier sets PIN via /v1/me/pin -> POS PIN login -> GET /v1/odoo/version -> 403
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 2: Cashier sets PIN & logs in on POS device (403 diagnostics) ---');
  const cashierSetPinRes = await fetch(`${GATEWAY_URL}/v1/me/pin`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cashierLogin.access_token}`,
    },
    body: JSON.stringify({ pin: '246813', password: DEMO_PASSWORD }),
  });
  assert(cashierSetPinRes.status === 200, `Cashier set PIN 200 (got ${cashierSetPinRes.status})`);

  // Device logs in with Cashier PIN
  const cashierPinLoginRes = await fetch(`${GATEWAY_URL}/v1/pos/auth/pin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Device ${deviceToken}`,
    },
    body: JSON.stringify({ membership_id: cashierMid, pin: '246813' }),
  });
  assert(cashierPinLoginRes.status === 200, `Cashier PIN login 200 (got ${cashierPinLoginRes.status})`);
  const cashierPinData = await cashierPinLoginRes.json();
  assert(cashierPinData.access_token, 'PIN login issued access_token');
  assert(cashierPinData.refresh_token, 'PIN login issued refresh_token');

  const cashierPinPayload = JSON.parse(Buffer.from(cashierPinData.access_token.split('.')[1], 'base64').toString());
  assert(cashierPinPayload.did === deviceId, `Token did matches deviceId (${cashierPinPayload.did})`);
  assert(cashierPinPayload.bid === pairDeviceData.branch.id, `Token bid matches branchId`);
  assert(cashierPinPayload.amr && cashierPinPayload.amr.includes('pin'), `amr includes 'pin'`);

  // Call /v1/odoo/version with cashier PIN access token -> MUST be 403 (missing system.diagnostics.view)
  const cashierDiagRes = await fetch(`${GATEWAY_URL}/v1/odoo/version`, {
    headers: { Authorization: `Bearer ${cashierPinData.access_token}` },
  });
  assert(cashierDiagRes.status === 403, `Cashier diagnostics status 403 (got ${cashierDiagRes.status})`);
  console.log('✓ Criterion 2 PASS: Cashier PIN login token carries cashier permissions (403 on diagnostics).\n');

  // ---------------------------------------------------------------------------
  // CRITERION 3: Owner sets PIN -> POS PIN login -> GET /v1/odoo/version -> 200 with odoo_uid
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 3: Owner sets PIN & logs in on POS device (200 with odoo_uid) ---');
  const ownerSetPinRes = await fetch(`${GATEWAY_URL}/v1/me/pin`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerLogin.access_token}`,
    },
    body: JSON.stringify({ pin: '135792', password: DEMO_PASSWORD }),
  });
  assert(ownerSetPinRes.status === 200, `Owner set PIN 200 (got ${ownerSetPinRes.status})`);

  // Device logs in with Owner PIN
  const ownerPinLoginRes = await fetch(`${GATEWAY_URL}/v1/pos/auth/pin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Device ${deviceToken}`,
    },
    body: JSON.stringify({ membership_id: ownerMid, pin: '135792' }),
  });
  assert(ownerPinLoginRes.status === 200, `Owner PIN login 200 (got ${ownerPinLoginRes.status})`);
  const ownerPinData = await ownerPinLoginRes.json();

  // Call /v1/odoo/version with owner PIN access token -> MUST be 200 with odoo_uid
  const ownerDiagRes = await fetch(`${GATEWAY_URL}/v1/odoo/version`, {
    headers: { Authorization: `Bearer ${ownerPinData.access_token}` },
  });
  assert(ownerDiagRes.status === 200, `Owner diagnostics status 200 (got ${ownerDiagRes.status})`);
  const ownerDiagBody = await ownerDiagRes.json();
  console.log('Owner diagnostics response:', ownerDiagBody);
  assert(ownerDiagBody.odoo_uid && typeof ownerDiagBody.odoo_uid === 'number', 'odoo_uid is returned');
  console.log('✓ Criterion 3 PASS: Owner PIN login token yields 200 OK with owner odoo_uid.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 4: Fast user switching on same device (cashier -> owner -> cashier) in 3 calls
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 4: Fast user switching on same device without passwords ---');
  // Switch 1: Cashier
  const sw1Res = await fetch(`${GATEWAY_URL}/v1/pos/auth/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Device ${deviceToken}` },
    body: JSON.stringify({ membership_id: cashierMid, pin: '246813' }),
  });
  assert(sw1Res.status === 200, 'Switch 1 cashier PIN login 200');
  const sw1Data = await sw1Res.json();
  const sw1Payload = JSON.parse(Buffer.from(sw1Data.access_token.split('.')[1], 'base64').toString());
  assert(sw1Payload.mid === cashierMid, 'Switch 1 token belongs to cashier');

  // Switch 2: Owner
  const sw2Res = await fetch(`${GATEWAY_URL}/v1/pos/auth/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Device ${deviceToken}` },
    body: JSON.stringify({ membership_id: ownerMid, pin: '135792' }),
  });
  assert(sw2Res.status === 200, 'Switch 2 owner PIN login 200');
  const sw2Data = await sw2Res.json();
  const sw2Payload = JSON.parse(Buffer.from(sw2Data.access_token.split('.')[1], 'base64').toString());
  assert(sw2Payload.mid === ownerMid, 'Switch 2 token belongs to owner');

  // Switch 3: Cashier again
  const sw3Res = await fetch(`${GATEWAY_URL}/v1/pos/auth/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Device ${deviceToken}` },
    body: JSON.stringify({ membership_id: cashierMid, pin: '246813' }),
  });
  assert(sw3Res.status === 200, 'Switch 3 cashier PIN login 200');
  const sw3Data = await sw3Res.json();
  const sw3Payload = JSON.parse(Buffer.from(sw3Data.access_token.split('.')[1], 'base64').toString());
  assert(sw3Payload.mid === cashierMid, 'Switch 3 token belongs to cashier');

  console.log('✓ Criterion 4 PASS: Fast user switching completed in 3 API calls without passwords.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 5: 5 wrong PIN attempts lock account on 6th attempt even with correct PIN
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 5: PIN brute-force lockout after 5 failed attempts ---');
  for (let i = 1; i <= 5; i++) {
    const wrongRes = await fetch(`${GATEWAY_URL}/v1/pos/auth/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Device ${deviceToken}` },
      body: JSON.stringify({ membership_id: cashierMid, pin: '999999' }),
    });
    assert(wrongRes.status === 401, `Wrong attempt ${i} status 401 (got ${wrongRes.status})`);
    const wrongBody = await wrongRes.json();
    assert(wrongBody.error === 'INVALID_PIN', `Error is INVALID_PIN on attempt ${i}`);
  }

  // 6th attempt with CORRECT PIN -> MUST be 401 INVALID_PIN because locked!
  const lockedRes = await fetch(`${GATEWAY_URL}/v1/pos/auth/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Device ${deviceToken}` },
    body: JSON.stringify({ membership_id: cashierMid, pin: '246813' }),
  });
  assert(lockedRes.status === 401, `6th attempt with correct PIN returned 401 (got ${lockedRes.status})`);
  const lockedBody = await lockedRes.json();
  assert(lockedBody.error === 'INVALID_PIN', `Locked error is INVALID_PIN (got ${lockedBody.error})`);

  // Verify in PostgreSQL: failed_attempts = 5 and locked_until > NOW()
  const lockDbCheck = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -tAc "SELECT failed_attempts, (locked_until > NOW()) FROM membership_pins WHERE membership_id = '${cashierMid}';"`,
    { cwd: projectRoot },
  ).toString().trim();
  console.log(`Database lock state (failed_attempts|locked_until_active): ${lockDbCheck}`);
  assert(lockDbCheck === '5|t', `Database shows 5 failed attempts and active lock (got ${lockDbCheck})`);
  console.log('✓ Criterion 5 PASS: Account locked after 5 failed attempts, 6th attempt rejected.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 6: Roster contains owner & cashier, Ed25519 signature verified, argon2 offline check
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 6: Offline Roster download, Ed25519 signature & Argon2 verification ---');
  const rosterRes = await fetch(`${GATEWAY_URL}/v1/pos/roster`, {
    headers: { Authorization: `Device ${deviceToken}` },
  });
  assert(rosterRes.status === 200, `Get roster status 200 (got ${rosterRes.status})`);
  const rosterData = await rosterRes.json();
  assert(rosterData.roster_jws, 'roster_jws present');
  assert(rosterData.roster_public_jwk, 'roster_public_jwk present');

  // Verify JWS signature using Ed25519 public JWK
  const publicKey = await jose.importJWK(rosterData.roster_public_jwk, 'EdDSA');
  const verifiedJws = await jose.compactVerify(rosterData.roster_jws, publicKey);
  const rosterPayload = JSON.parse(Buffer.from(verifiedJws.payload).toString());
  console.log('Roster payload summary:', {
    iss: rosterPayload.iss,
    sub: rosterPayload.sub,
    aud: rosterPayload.aud,
    exp: rosterPayload.exp,
    members_count: rosterPayload.members?.length,
  });

  assert(rosterPayload.iss === 'iteso-control-plane', 'iss is iteso-control-plane');
  assert(rosterPayload.sub === deviceId, `sub matches deviceId (${deviceId})`);
  assert(rosterPayload.aud === 'iteso-pos', 'aud is iteso-pos');
  assert(rosterPayload.exp && rosterPayload.exp > Math.floor(Date.now() / 1000), 'exp is valid');

  const rosterOwner = rosterPayload.members.find(m => m.membership_id === ownerMid);
  const rosterCashier = rosterPayload.members.find(m => m.membership_id === cashierMid);
  assert(rosterOwner, 'Roster contains owner');
  assert(rosterCashier, 'Roster contains cashier');

  // Verify that an account without PIN or without pos.session.open (e.g. accountant) is NOT in roster
  const nonPosInRoster = rosterPayload.members.some(m => m.role === 'accountant');
  assert(!nonPosInRoster, 'Roster does NOT contain members without pos.session.open');

  // Verify owner PIN offline with Argon2
  const ownerPinMatches = await argon2.verify(rosterOwner.pin_hash, '135792');
  assert(ownerPinMatches, 'Argon2 hash in roster verifies owner PIN 135792 offline');
  const wrongPinMatches = await argon2.verify(rosterOwner.pin_hash, '000000');
  assert(!wrongPinMatches, 'Argon2 rejects wrong PIN 000000 offline');

  console.log('✓ Criterion 6 PASS: Roster JWS signature verified, payload correct, offline PIN check succeeded.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 7: Owner revokes device -> within 2s, did tokens get 401 DEVICE_REVOKED
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 7: Device revocation & immediate gateway rejection (<2s) ---');
  // Revoke device
  const revokeRes = await fetch(`${GATEWAY_URL}/v1/pos/devices/${deviceId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ownerLogin.access_token}` },
  });
  assert(revokeRes.status === 200, `Revoke device 200 (got ${revokeRes.status})`);

  // Wait 1.5 seconds for NATS event propagation & gateway cache eviction
  await new Promise(r => setTimeout(r, 1500));

  // 7.1 Existing PIN access token with did -> MUST return 401 DEVICE_REVOKED
  const revokedAccessRes = await fetch(`${GATEWAY_URL}/v1/odoo/version`, {
    headers: { Authorization: `Bearer ${ownerPinData.access_token}` },
  });
  assert(revokedAccessRes.status === 401, `Revoked device token returned 401 (got ${revokedAccessRes.status})`);
  const revokedAccessBody = await revokedAccessRes.json();
  assert(revokedAccessBody.error === 'DEVICE_REVOKED', `Error is DEVICE_REVOKED (got ${revokedAccessBody.error})`);

  // 7.2 Refresh token of revoked device -> MUST be rejected (401)
  const revokedRefreshRes = await fetch(`${GATEWAY_URL}/v1/pos/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Device ${deviceToken}`,
    },
    body: JSON.stringify({ refresh_token: ownerPinData.refresh_token }),
  });
  assert(revokedRefreshRes.status === 401, `Revoked refresh token returned 401 (got ${revokedRefreshRes.status})`);

  // 7.3 GET /v1/pos/roster with revoked device token -> MUST return 401
  const revokedRosterRes = await fetch(`${GATEWAY_URL}/v1/pos/roster`, {
    headers: { Authorization: `Device ${deviceToken}` },
  });
  assert(revokedRosterRes.status === 401, `Revoked device roster returned 401 (got ${revokedRosterRes.status})`);

  console.log('✓ Criterion 7 PASS: Device revoked; gateway immediately returns 401 DEVICE_REVOKED, refresh and roster rejected.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 8: Pairing code reuse, expiry & PIN complexity validation
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 8: Pairing code reuse/expiry & PIN complexity ---');
  // 8.1 Reusing pairing code
  const reusePairRes = await fetch(`${GATEWAY_URL}/v1/pos/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: pairCodeData.pairing_code }),
  });
  assert(
    reusePairRes.status === 400 || reusePairRes.status === 401 || reusePairRes.status === 404,
    `Pairing code reuse rejected (got ${reusePairRes.status})`,
  );

  // 8.2 Expired pairing code
  const expiredCodeRes = await fetch(`${GATEWAY_URL}/v1/pos/pairing-codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerLogin.access_token}` },
    body: JSON.stringify({ branch_code: 'main', device_name: 'POS Quầy 2' }),
  });
  const expiredCodeData = await expiredCodeRes.json();
  // Manually expire the code in DB using SHA-256 hash
  const crypto = require('crypto');
  const codeHash = crypto.createHash('sha256').update(expiredCodeData.pairing_code).digest('hex');
  execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -c "UPDATE pos_pairing_codes SET expires_at = NOW() - INTERVAL '5 minutes' WHERE code_hash = '${codeHash}';"`,
    { cwd: projectRoot },
  );
  const pairExpiredRes = await fetch(`${GATEWAY_URL}/v1/pos/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: expiredCodeData.pairing_code }),
  });
  assert(
    pairExpiredRes.status === 400 || pairExpiredRes.status === 401 || pairExpiredRes.status === 404,
    `Expired pairing code rejected (got ${pairExpiredRes.status})`,
  );

  // 8.3 PIN complexity
  const testComplexities = [
    { pin: '111111', desc: 'identical digits' },
    { pin: '123456', desc: 'ascending sequence' },
    { pin: '654321', desc: 'descending sequence' },
    { pin: '12345', desc: 'short PIN' },
  ];
  for (const tc of testComplexities) {
    const badPinRes = await fetch(`${GATEWAY_URL}/v1/me/pin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerLogin.access_token}` },
      body: JSON.stringify({ pin: tc.pin, password: DEMO_PASSWORD }),
    });
    assert(badPinRes.status === 400, `PIN ${tc.pin} (${tc.desc}) rejected with 400 (got ${badPinRes.status})`);
  }

  // 8.4 Set PIN missing password
  const noPwdRes = await fetch(`${GATEWAY_URL}/v1/me/pin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerLogin.access_token}` },
    body: JSON.stringify({ pin: '592841' }),
  });
  assert(noPwdRes.status === 400, `Set PIN without password rejected with 400 (got ${noPwdRes.status})`);

  console.log('✓ Criterion 8 PASS: Pairing code reuse/expiry and PIN complexity properly enforced.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 9: Regressions & TASK-004 Backlog
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 9: Regressions & TASK-004 Backlog Items ---');
  // Backlog 1: Check regex in register-tenant-system-key.ts
  const regScriptContent = fs.readFileSync(path.join(projectRoot, 'services/control-plane/src/cli/register-tenant-system-key.ts'), 'utf8');
  assert(regScriptContent.includes('^[0-9a-f]{40}_oak$'), 'Odoo system key regex tightened to ^[0-9a-f]{40}_oak$');

  // Backlog 2: Challenge token reuse rejection across control-plane restart
  console.log('9.1 Testing challenge_token reuse after control-plane restart...');
  // Ensure platform admin exists
  try {
    execSync(
      `docker compose --env-file .env -f infra/docker-compose.yml exec -T control-plane node dist/cli/create-platform-admin.js --email admin@platform.local --password "${ADMIN_PASSWORD}" --totp-secret "${TOTP_SECRET}"`,
      { cwd: projectRoot, stdio: 'ignore' },
    );
  } catch {}

  const preAdminLoginRes = await fetch(`${CONTROL_PLANE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin@platform.local', password: ADMIN_PASSWORD }),
  });
  const preAdminLoginData = await preAdminLoginRes.json();
  assert(preAdminLoginData.challenge_token, 'Pre-restart platform admin login returned challenge_token');
  const restartChallengeToken = preAdminLoginData.challenge_token;

  // Use the challenge_token once before restart
  const totpCodeBeforeRestart = getTotp(TOTP_SECRET);
  const firstUseRes = await fetch(`${CONTROL_PLANE_URL}/v1/auth/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_token: restartChallengeToken, code: totpCodeBeforeRestart }),
  });
  assert(firstUseRes.status === 200, 'Initial TOTP verification with challenge_token succeeded');

  console.log('Restarting control-plane container...');
  execSync('docker compose --env-file .env -f infra/docker-compose.yml restart control-plane', { cwd: projectRoot });

  // Wait for control-plane to become healthy
  console.log('Waiting for control-plane to restart and become healthy...');
  let cpHealthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const hRes = await fetch(`${CONTROL_PLANE_URL}/health`);
      if (hRes.status === 200) {
        cpHealthy = true;
        break;
      }
    } catch {}
  }
  assert(cpHealthy, 'Control plane restarted and is healthy');

  // Attempt to REUSE pre-restart challenge_token (even with fresh TOTP code) -> MUST be 401
  const freshTotpCode = getTotp(TOTP_SECRET);
  const postRestartTotpRes = await fetch(`${CONTROL_PLANE_URL}/v1/auth/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_token: restartChallengeToken, code: freshTotpCode }),
  });
  assert(postRestartTotpRes.status === 401, `Reused challenge_token after restart rejected with 401 (got ${postRestartTotpRes.status})`);
  console.log('✓ 9.1 Reused challenge_token strictly rejected after restart (Redis persistence verified).');

  // 9.2 Cashier diagnostics forbidden with password login token
  const cashierDiag2 = await fetch(`${GATEWAY_URL}/v1/odoo/version`, {
    headers: { Authorization: `Bearer ${cashierLogin.access_token}` },
  });
  assert(cashierDiag2.status === 403, `Cashier password token diagnostics status 403 (got ${cashierDiag2.status})`);

  // 9.3 Tenant mismatch header rejection
  const mismatchRes = await fetch(`${GATEWAY_URL}/v1/odoo/version`, {
    headers: {
      Authorization: `Bearer ${ownerLogin.access_token}`,
      'X-Tenant': 'demo_fnb2',
    },
  });
  assert(mismatchRes.status === 403, `Tenant mismatch status 403 (got ${mismatchRes.status})`);

  // 9.4 Multi-tenant selection flow
  const multiLoginRes = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'multi@demo.local', password: DEMO_PASSWORD }),
  });
  assert(multiLoginRes.status === 200, 'Multi-tenant login 200');
  const multiLoginData = await multiLoginRes.json();
  assert(multiLoginData.next === 'select_tenant', 'Multi-tenant login returns select_tenant');

  // 9.5 Direct JSON-2 iteso.provisioning rejection with member key
  const memberKey = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T control-plane node -e '
      const { decryptAesGcm } = require("./dist/auth/crypto.util");
      const fs = require("fs");
      const key = fs.readFileSync("/app/secrets/odoo_credentials.key", "utf8").trim();
      const { Pool } = require("pg");
      const pool = new Pool({ host: "postgres", user: "iteso_control_plane", password: process.env.POSTGRES_CONTROL_PLANE_PASSWORD, database: "platform" });
      pool.query("SELECT api_key_enc FROM membership_odoo_users WHERE membership_id = $1", ["${ownerMid}"]).then(r => {
        console.log(decryptAesGcm(r.rows[0].api_key_enc, key));
        pool.end();
      });
    '`,
    { cwd: projectRoot },
  ).toString().trim();

  const directCallRes = await fetch('http://localhost:8069/json/2/iteso.provisioning/provision_member', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Odoo-Database': 't_demo_fnb',
      Authorization: `bearer ${memberKey}`,
    },
    body: JSON.stringify({ membership_id: 'hack-test', name: 'Hacker' }),
  });
  const directCallBody = await directCallRes.text();
  assert(
    directCallRes.status === 403 || directCallBody.includes('AccessError') || directCallBody.includes('Access denied'),
    'Direct call was rejected with AccessError',
  );

  // 9.6 Run DB isolation tests
  execSync('./scripts/test-db-isolation.sh', { cwd: projectRoot, stdio: 'inherit' });

  console.log('✓ Criterion 9 PASS: Prior tasks criteria, backlog items, and database isolation intact.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 10: Git history check for secrets
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 10: Git history check for secrets ---');
  const committedSecretsFiles = execSync(
    'git log --name-only --oneline | grep -E "^infra/secrets/|^\\.env$" || true',
    { cwd: projectRoot },
  ).toString().trim();
  assert(!committedSecretsFiles, `No secret files or .env in git commits (found: ${committedSecretsFiles})`);

  const privKeyMarker = '-----BEGIN ' + 'PRIVATE KEY-----';
  const committedPrivKey = execSync(
    `git log -S "${privKeyMarker}" -- . ":(exclude)scripts/test-acceptance-criteria.js" --oneline || true`,
    { cwd: projectRoot },
  ).toString().trim();
  assert(!committedPrivKey, 'No private keys committed in source files');

  console.log('✓ Criterion 10 PASS: No secret keys, credentials or .env in git history.\n');

  console.log('=================================================================');
  console.log('ALL TASK-005 ACCEPTANCE CRITERIA PASSED SUCCESSFULLY (10/10)!');
  console.log('=================================================================');
}

run().catch((err) => {
  console.error('Acceptance verification failed:', err);
  process.exit(1);
});
