#!/usr/bin/env node
/**
 * Acceptance Criteria Verification Suite (TASK-004)
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
  console.log('STARTING TASK-004 ACCEPTANCE CRITERIA VERIFICATION');
  console.log('=================================================================\n');

  // ---------------------------------------------------------------------------
  // CRITERION 1: Dev API key removed from repo (except docs/)
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 1: Dev API key removal check ---');
  let devKeyOccurrences = '';
  try {
    devKeyOccurrences = execSync('grep -rn "ODOO_DEV_API_KEY" . --exclude-dir=docs --exclude-dir=.git --exclude="test-acceptance-criteria.js" || true', {
      cwd: projectRoot,
    }).toString().trim();
  } catch {}

  assert(
    !devKeyOccurrences,
    `Dev API key still found outside docs/: \n${devKeyOccurrences}`,
  );
  console.log('✓ Criterion 1 PASS: Dev API key completely removed from codebase.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 2: Database res_users and apikeys verification in t_demo_fnb
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 2: Dedicated Odoo users and keys in t_demo_fnb ---');
  const userCheckSql = `
    SELECT u.login, u.active, count(k.id) as key_count
    FROM res_users u
    JOIN res_users_apikeys k ON u.id = k.user_id AND k.name = 'iteso-gateway'
    WHERE u.login LIKE 'iteso-%'
    GROUP BY u.login, u.active
    ORDER BY u.login;
  `;
  const userCheckOut = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U odoo -d t_demo_fnb -tAc "${userCheckSql}"`,
    { cwd: projectRoot },
  ).toString().trim();

  console.log('Odoo provisioned users:\n' + userCheckOut);
  const rows = userCheckOut.split('\n').filter(Boolean);
  assert(rows.length >= 2, `Expected at least 2 iteso-* users in t_demo_fnb (got ${rows.length})`);
  for (const r of rows) {
    const [login, active, keyCount] = r.split('|');
    assert(active === 't', `User ${login} is active`);
    assert(keyCount === '1', `User ${login} has exactly 1 iteso-gateway key (got ${keyCount})`);
  }

  // Check group_system membership: only __system__, admin, iteso_system allowed
  const privUsersOut = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U odoo -d t_demo_fnb -tAc "
      SELECT u.login FROM res_users u
      JOIN res_groups_users_rel rel ON u.id = rel.uid
      JOIN ir_model_data d ON d.res_id = rel.gid AND d.model = 'res.groups'
      WHERE d.name = 'group_system';
    "`,
    { cwd: projectRoot },
  ).toString().trim().split('\n').map(s => s.trim()).filter(Boolean);

  console.log('Privileged group_system users:', privUsersOut);
  for (const login of privUsersOut) {
    assert(
      ['__system__', 'admin', 'iteso_system'].includes(login),
      `Unexpected user with group_system: ${login}`,
    );
  }
  console.log('✓ Criterion 2 PASS: Dedicated iteso-* users exist, each has 1 key, none has group_system.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 3: GET /v1/odoo/version returns 200 with matching odoo_uid
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 3: GET /v1/odoo/version with member credentials ---');
  const ownerLoginRes = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'owner@demo.local', password: DEMO_PASSWORD }),
  });
  assert(ownerLoginRes.status === 200, `Owner login status 200 (got ${ownerLoginRes.status})`);
  const ownerLogin = await ownerLoginRes.json();

  const odooVerRes = await fetch(`${GATEWAY_URL}/v1/odoo/version`, {
    headers: { Authorization: `Bearer ${ownerLogin.access_token}` },
  });
  assert(odooVerRes.status === 200, `GET /v1/odoo/version status 200 (got ${odooVerRes.status})`);
  const odooVer = await odooVerRes.json();
  console.log('GET /v1/odoo/version response:', JSON.stringify(odooVer, null, 2));

  assert(odooVer.odoo_uid && typeof odooVer.odoo_uid === 'number', 'odoo_uid returned in response');

  // Check expected uid in platform membership_odoo_users
  const ownerMid = JSON.parse(Buffer.from(ownerLogin.access_token.split('.')[1], 'base64').toString()).mid;
  const platformUid = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -tAc "SELECT odoo_uid FROM membership_odoo_users WHERE membership_id = '${ownerMid}';"`,
    { cwd: projectRoot },
  ).toString().trim();

  assert(String(odooVer.odoo_uid) === platformUid, `odoo_uid ${odooVer.odoo_uid} matches platform record ${platformUid}`);
  console.log(`✓ Criterion 3 PASS: Version 200 OK with correct odoo_uid=${odooVer.odoo_uid}.\n`);

  // ---------------------------------------------------------------------------
  // CRITERION 4: Disable membership -> immediate revocation & re-enable
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 4: Disable membership revocation and re-enable ---');
  // Authenticate platform admin
  try {
    execSync(
      `docker compose --env-file .env -f infra/docker-compose.yml exec -T control-plane node dist/cli/create-platform-admin.js --email admin@platform.local --password "${ADMIN_PASSWORD}" --totp-secret "${TOTP_SECRET}"`,
      { cwd: projectRoot, stdio: 'ignore' },
    );
  } catch {}

  let adminToken;
  // Wait if current step was recently used
  const epoch = Math.floor(Date.now() / 1000);
  const remainingInStep = 30 - (epoch % 30);
  console.log(`Current TOTP step window remaining: ${remainingInStep}s`);
  if (remainingInStep < 2 || remainingInStep > 28) {
    console.log('Waiting for fresh TOTP time-step window...');
    await new Promise(r => setTimeout(r, (remainingInStep + 1) * 1000));
  }

  const adminLoginRes = await fetch(`${CONTROL_PLANE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin@platform.local', password: ADMIN_PASSWORD }),
  });
  const adminLoginData = await adminLoginRes.json();
  if (!adminLoginData.challenge_token) {
    console.error('admin login failed:', adminLoginData);
  }
  const totpCode = getTotp(TOTP_SECRET);
  const totpRes = await fetch(`${CONTROL_PLANE_URL}/v1/auth/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_token: adminLoginData.challenge_token, code: totpCode }),
  });
  const totpData = await totpRes.json();
  if (!totpData.access_token) {
    console.error('totp verification failed:', totpData);
  }
  adminToken = totpData.access_token;
  assert(adminToken, 'Obtained Super Admin token');

  // 4.1: Disable owner membership
  console.log(`Disabling owner membership ${ownerMid}...`);
  const disableMemRes = await fetch(`${CONTROL_PLANE_URL}/admin/tenants/demo_fnb/memberships/${ownerMid}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ status: 'disabled' }),
  });
  assert(disableMemRes.status === 200, `Disable membership status 200 (got ${disableMemRes.status})`);

  // Wait 500ms for event propagation
  await new Promise(r => setTimeout(r, 500));

  // Call /v1/odoo/version with old owner access token -> MUST be 403 ODOO_USER_NOT_PROVISIONED
  const checkRevokedRes = await fetch(`${GATEWAY_URL}/v1/odoo/version`, {
    headers: { Authorization: `Bearer ${ownerLogin.access_token}` },
  });
  assert(checkRevokedRes.status === 403, `Revoked membership call returned 403 (got ${checkRevokedRes.status})`);
  const checkRevokedBody = await checkRevokedRes.json();
  assert(checkRevokedBody.error === 'ODOO_USER_NOT_PROVISIONED', `Error is ODOO_USER_NOT_PROVISIONED (got ${checkRevokedBody.error})`);

  // Verify in Odoo database: user is inactive, 0 keys
  const odooInactive = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U odoo -d t_demo_fnb -tAc "SELECT active, count(k.id) FROM res_users u LEFT JOIN res_users_apikeys k ON u.id = k.user_id AND k.name = 'iteso-gateway' WHERE u.login = 'iteso-${ownerMid}' GROUP BY active;"`,
    { cwd: projectRoot },
  ).toString().trim();
  assert(odooInactive === 'f|0', `Odoo user is inactive with 0 keys (got ${odooInactive})`);
  console.log('✓ 4.1 Immediately rejected call with 403 ODOO_USER_NOT_PROVISIONED, user deactivated in Odoo.');

  // 4.2: Re-enable owner membership
  console.log(`Re-enabling owner membership ${ownerMid}...`);
  const enableMemRes = await fetch(`${CONTROL_PLANE_URL}/admin/tenants/demo_fnb/memberships/${ownerMid}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ status: 'active' }),
  });
  assert(enableMemRes.status === 200, `Re-enable membership status 200 (got ${enableMemRes.status})`);

  await new Promise(r => setTimeout(r, 500));

  // Call /v1/odoo/version again -> MUST be 200 OK
  const checkReEnabledRes = await fetch(`${GATEWAY_URL}/v1/odoo/version`, {
    headers: { Authorization: `Bearer ${ownerLogin.access_token}` },
  });
  assert(checkReEnabledRes.status === 200, `Re-enabled call returned 200 (got ${checkReEnabledRes.status})`);
  console.log('✓ 4.2 Re-enabled membership succeeds immediately -> 200 OK.');
  console.log('✓ Criterion 4 PASS.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 5: Direct JSON-2 call to iteso.provisioning with member key -> AccessError
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 5: Direct JSON-2 iteso.provisioning caller verification ---');
  // Read member decrypted API key from DB using odoo_credentials.key
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
  console.log(`Direct call status: ${directCallRes.status}, body: ${directCallBody}`);
  assert(
    directCallRes.status === 403 || directCallBody.includes('AccessError') || directCallBody.includes('Access denied'),
    'Direct call was rejected with AccessError',
  );
  console.log('✓ Criterion 5 PASS: Calling iteso.provisioning with member key is strictly rejected.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 6: Idempotent sync check
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 6: Idempotent sync verification ---');
  const countBefore = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U odoo -d t_demo_fnb -tAc "SELECT count(*) FROM res_users WHERE login LIKE 'iteso-%';"`,
    { cwd: projectRoot },
  ).toString().trim();

  execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T control-plane node dist/cli/provision-odoo-users.js --tenant demo_fnb`,
    { cwd: projectRoot },
  );

  const countAfter = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U odoo -d t_demo_fnb -tAc "SELECT count(*) FROM res_users WHERE login LIKE 'iteso-%';"`,
    { cwd: projectRoot },
  ).toString().trim();

  assert(countBefore === countAfter, `User count changed! Before: ${countBefore}, After: ${countAfter}`);
  console.log(`✓ Criterion 6 PASS: Running sync twice preserves exact user count (${countAfter}).\n`);

  // ---------------------------------------------------------------------------
  // CRITERION 7: multi@demo.local in demo_fnb2 has status = pending
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 7: multi@demo.local in demo_fnb2 status = pending ---');
  const fnb2Status = execSync(
    `docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -tAc "SELECT o.status FROM accounts a JOIN memberships m ON a.id = m.account_id JOIN tenants t ON m.tenant_id = t.id JOIN membership_odoo_users o ON m.id = o.membership_id WHERE a.email = 'multi@demo.local' AND t.code = 'demo_fnb2';"`,
    { cwd: projectRoot },
  ).toString().trim();

  assert(fnb2Status === 'pending', `demo_fnb2 membership status is pending (got ${fnb2Status})`);
  console.log(`✓ Criterion 7 PASS: multi@demo.local status in demo_fnb2 is '${fnb2Status}'.\n`);

  // ---------------------------------------------------------------------------
  // CRITERION 8: Database least-privilege permissions verification
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 8: Database permissions check ---');
  execSync('./scripts/test-db-isolation.sh', { cwd: projectRoot, stdio: 'inherit' });
  console.log('✓ Criterion 8 PASS: Database isolation verified.\n');

  // Small delay to ensure sockets are settled
  await new Promise(r => setTimeout(r, 500));

  // ---------------------------------------------------------------------------
  // CRITERION 9: Prior tasks regression verification
  // ---------------------------------------------------------------------------
  console.log('--- Criterion 9: Regressions from TASK-002 and TASK-003 ---');
  // Cashier forbidden diagnostics
  console.log('9.1 Checking cashier diagnostics access...');
  const cashierLoginRes = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ identifier: 'cashier@demo.local', password: DEMO_PASSWORD }),
  });
  assert(cashierLoginRes.status === 200, `Cashier login 200 (got ${cashierLoginRes.status})`);
  const cashierLogin = await cashierLoginRes.json();

  console.log('9.2 Calling /v1/odoo/version with cashier token...');
  const cashierDiag = await fetch(`${GATEWAY_URL}/v1/odoo/version`, {
    headers: { Authorization: `Bearer ${cashierLogin.access_token}`, Connection: 'close' },
  });
  console.log(`9.2 Cashier diagnostics status: ${cashierDiag.status}`);
  assert(cashierDiag.status === 403, `Cashier diagnostics status 403 (got ${cashierDiag.status})`);

  // Tenant header mismatch
  console.log('9.3 Checking tenant mismatch header rejection...');
  const mismatchRes = await fetch(`${GATEWAY_URL}/v1/odoo/version`, {
    headers: {
      Authorization: `Bearer ${ownerLogin.access_token}`,
      'X-Tenant': 'demo_fnb2',
      Connection: 'close',
    },
  });
  console.log(`9.3 Mismatch status: ${mismatchRes.status}`);
  assert(mismatchRes.status === 403, `Tenant mismatch status 403 (got ${mismatchRes.status})`);

  // Multi-tenant selection flow
  console.log('9.4 Checking multi-tenant login flow...');
  const multiLoginRes = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ identifier: 'multi@demo.local', password: DEMO_PASSWORD }),
  });
  assert(multiLoginRes.status === 200, `Multi-tenant login 200 (got ${multiLoginRes.status})`);
  const multiLoginData = await multiLoginRes.json();
  assert(multiLoginData.next === 'select_tenant', 'Multi-tenant login returns select_tenant');

  // TOTP single use: Reusing TOTP code rejected
  console.log('9.5 Checking TOTP single-use code rejection...');
  const totpReuseRes = await fetch(`${CONTROL_PLANE_URL}/v1/auth/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ challenge_token: adminLoginData.challenge_token, code: totpCode }),
  });
  assert(totpReuseRes.status === 401, 'Reused TOTP code or challenge rejected');

  console.log('✓ Criterion 9 PASS: Prior criteria and backlog fixes intact.\n');

  // ---------------------------------------------------------------------------
  // CRITERION 10: Git history check
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

  console.log('✓ Criterion 10 PASS: No secret keys or credentials in git history.\n');

  console.log('=================================================================');
  console.log('ALL TASK-004 ACCEPTANCE CRITERIA PASSED SUCCESSFULLY (10/10)!');
  console.log('=================================================================');
}

run().catch((err) => {
  console.error('Acceptance verification failed:', err);
  process.exit(1);
});
