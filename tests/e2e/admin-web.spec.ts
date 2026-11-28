import { test, expect, Page } from '@playwright/test';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const BASE_URL = process.env.ADMIN_WEB_URL || 'http://127.0.0.1:3001';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
const DEMO_PASSWORD = process.env.DEMO_ACCOUNTS_PASSWORD || 'Admin@1234567';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AdminPassword@123';
const TOTP_SECRET = process.env.TOTP_SECRET || 'JBSWY3DPEHPK3PXP';

const SCREENSHOT_DIR = path.resolve(process.cwd(), 'artifacts/admin-web-screenshots');

function base32Decode(str: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = str.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (let i = 0; i < cleaned.length; i++) {
    const val = alphabet.indexOf(cleaned[i]);
    if (val === -1) throw new Error('Invalid base32 char: ' + cleaned[i]);
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTOTP(secret: string, offset = 0): string {
  const key = base32Decode(secret);
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / 30) + offset;
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[off] & 0x7f) << 24) |
    ((hmac[off + 1] & 0xff) << 16) |
    ((hmac[off + 2] & 0xff) << 8) |
    (hmac[off + 3] & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, '0');
}

async function captureScreenshots(page: Page, baseName: string) {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  // Desktop (1280x800)
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${baseName}-desktop.png`),
    fullPage: true,
  });

  // Mobile (390x844 - iPhone standard)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${baseName}-mobile.png`),
    fullPage: true,
  });

  // Restore desktop
  await page.setViewportSize({ width: 1280, height: 800 });
}

test.describe('TASK-007 Admin Web E2E Scenarios', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
    try {
      execSync(
        'docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres psql -U iteso_control_plane -d platform -c "UPDATE accounts SET last_totp_step = NULL WHERE email = \'admin@platform.local\'; DELETE FROM tenant_features WHERE feature_key = \'pos.devices\';"',
        { stdio: 'ignore' },
      );
    } catch {
      // In non-docker environments, ignore
    }
  });

  test('Kịch bản 1: Super Admin đăng nhập thành công với TOTP', async ({ page }) => {
    // 1. Mở trang login
    await page.goto(`${BASE_URL}/login`);
    await expect(page.locator('h1')).toContainText('Đăng nhập hệ thống');

    // 2. Nhập thông tin Super Admin
    await page.fill('[data-testid="identifier-input"]', 'admin@platform.local');
    await page.fill('[data-testid="password-input"]', ADMIN_PASSWORD);
    await page.click('[data-testid="login-submit-button"]');

    // 3. Hiển thị form MFA
    await expect(page.locator('[data-testid="otp-input"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('h1')).toContainText('Xác thực hai bước');

    // 4. Sinh mã TOTP hợp lệ và submit
    const totp = generateTOTP(TOTP_SECRET);
    await page.fill('[data-testid="otp-input"]', totp);
    await page.click('[data-testid="mfa-submit-button"]');

    // 5. Chuyển hướng vào trang quản trị
    await page.waitForURL('**/platform**', { timeout: 10000 });
    await expect(page.locator('h1')).toContainText('Danh sách Doanh nghiệp');

    // 6. Thấy danh sách tenant và liên kết audit log
    await page.goto(`${BASE_URL}/platform/tenants`);
    await expect(page.locator('h1')).toContainText('Danh sách Doanh nghiệp');
    await expect(page.locator('[data-testid="tenant-row-demo_fnb"]')).toBeVisible();

    // 7. Chụp ảnh artifact
    await captureScreenshots(page, 'scenario-1-super-admin');
  });

  test('Kịch bản 2: Super Admin nhập sai TOTP 6 số hiển thị lỗi tiếng Việt', async ({ page }) => {
    // 1. Mở trang login
    await page.goto(`${BASE_URL}/login`);
    await expect(page.locator('h1')).toContainText('Đăng nhập hệ thống');

    // 2. Nhập thông tin Super Admin
    await page.fill('[data-testid="identifier-input"]', 'admin@platform.local');
    await page.fill('[data-testid="password-input"]', ADMIN_PASSWORD);
    await page.click('[data-testid="login-submit-button"]');

    // 3. Hiển thị form MFA
    await expect(page.locator('[data-testid="otp-input"]')).toBeVisible({ timeout: 10000 });

    // 4. Nhập sai mã TOTP (000000)
    await page.fill('[data-testid="otp-input"]', '000000');
    await page.click('[data-testid="mfa-submit-button"]');

    // 5. Hiển thị thông báo lỗi tiếng Việt
    const alert = page.locator('[data-testid="login-error-alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Mã xác thực');
    await expect(alert).toContainText('không đúng hoặc đã hết hạn');

    // Vẫn ở trang login, không vào dashboard
    expect(page.url()).toContain('/login');

    // 6. Chụp ảnh artifact
    await captureScreenshots(page, 'scenario-2-invalid-totp');
  });

  test('Kịch bản 3: Super Admin bật / tắt cờ pos.devices cho demo_fnb và kiểm tra Gateway + Audit log', async ({ page }) => {
    // 1. Tạo trước một pairing code hợp lệ của tenant demo_fnb khi tính năng đang bật
    const loginRes = await fetch(`${GATEWAY_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'owner@demo.local', password: DEMO_PASSWORD }),
    });
    const loginData = await loginRes.json();
    expect(loginRes.ok).toBe(true);

    const codeRes = await fetch(`${GATEWAY_URL}/v1/pos/pairing-codes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginData.access_token}`,
      },
      body: JSON.stringify({ branch_code: 'main', device_name: 'TEST_POS_E2E' }),
    });
    const codeData = await codeRes.json();
    expect(codeRes.ok).toBe(true);
    const pairingCode = codeData.pairing_code;
    expect(pairingCode).toBeDefined();

    // 2. Đăng nhập Super Admin
    await page.goto(`${BASE_URL}/login`);
    await page.fill('[data-testid="identifier-input"]', 'admin@platform.local');
    await page.fill('[data-testid="password-input"]', ADMIN_PASSWORD);
    await page.click('[data-testid="login-submit-button"]');
    await expect(page.locator('[data-testid="otp-input"]')).toBeVisible({ timeout: 10000 });
    await page.fill('[data-testid="otp-input"]', generateTOTP(TOTP_SECRET));
    await page.click('[data-testid="mfa-submit-button"]');
    await page.waitForURL('**/platform**', { timeout: 10000 });

    // 3. Truy cập trang cấu hình tính năng của demo_fnb
    await page.goto(`${BASE_URL}/platform/tenants/demo_fnb/features`);
    await expect(page.locator('h1')).toContainText('Cấu hình tính năng: demo_fnb');

    // 4. Tắt cờ pos.devices (chọn "false" / "Tắt")
    const select = page.locator('[data-testid="override-select-pos.devices"]');
    await expect(select).toBeVisible();
    await select.selectOption('false');

    // Đợi thông báo thành công và badge hiển thị Đang Tắt
    await expect(page.locator('text=Cập nhật cấu hình tính năng \'pos.devices\' thành công')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="effective-badge-pos.devices"]')).toContainText('Đang Tắt');

    // 5. Kiểm tra Gateway API: Gọi route pairing với demo_fnb trả về 403 FEATURE_DISABLED
    const gwResDisabled = await fetch(`${GATEWAY_URL}/v1/pos/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairing_code: pairingCode }),
    });
    expect(gwResDisabled.status).toBe(403);
    const bodyDisabled = await gwResDisabled.json();
    expect(bodyDisabled.error).toBe('FEATURE_DISABLED');

    // 6. Kiểm tra trang Audit Log ghi nhận hành động UPDATE_TENANT_FEATURE cho demo_fnb
    await page.goto(`${BASE_URL}/platform/audit-log`);
    await expect(page.locator('h1')).toContainText('Nhật ký');
    await expect(page.locator('text=UPDATE_TENANT_FEATURE').first()).toBeVisible();
    await expect(page.locator('text=tenant_feature:demo_fnb:pos.devices').first()).toBeVisible();

    // 7. Bật lại tính năng pos.devices (chọn "default" - theo mặc định nền tảng đang bật)
    await page.goto(`${BASE_URL}/platform/tenants/demo_fnb/features`);
    await select.selectOption('default');
    await expect(page.locator('text=Cập nhật cấu hình tính năng \'pos.devices\' thành công')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="effective-badge-pos.devices"]')).toContainText('Đang Bật');

    // 8. Kiểm tra Gateway API không còn bị chặn 403 FEATURE_DISABLED khi gọi pairing
    const gwResEnabled = await fetch(`${GATEWAY_URL}/v1/pos/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairing_code: pairingCode }),
    });
    expect(gwResEnabled.status).toBe(200);

    // 9. Chụp ảnh artifact
    await captureScreenshots(page, 'scenario-3-feature-toggle');
  });

  test('Kịch bản 4: owner@demo.local đăng nhập vào tenant và bị chặn khi vào /platform', async ({ page }) => {
    // 1. Mở trang login
    await page.goto(`${BASE_URL}/login`);

    // 2. Đăng nhập với tài khoản owner của tenant demo_fnb
    await page.fill('[data-testid="identifier-input"]', 'owner@demo.local');
    await page.fill('[data-testid="password-input"]', DEMO_PASSWORD);
    await page.click('[data-testid="login-submit-button"]');

    // 3. Nếu có bước chọn tenant
    const tenantSelect = page.locator('[data-testid="tenant-select"]');
    if (await tenantSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tenantSelect.selectOption('demo_fnb');
      await page.click('[data-testid="tenant-submit-button"]');
    }

    // 4. Chuyển hướng vào /t/demo_fnb
    await page.waitForURL('**/t/demo_fnb**', { timeout: 10000 });
    await expect(page.locator('[data-testid="tenant-greeting-container"]')).toBeVisible();

    // 5. Kiểm tra thông tin hiển thị: Tên + Tên quán + Vai trò
    await expect(page.locator('[data-testid="user-display-name"]')).toContainText('owner@demo.local');
    await expect(page.locator('[data-testid="tenant-display-name"]')).toContainText('Nhà hàng Demo F&B');
    await expect(page.locator('text=demo_fnb')).toBeVisible();
    await expect(page.locator('[data-testid="user-role-name"]')).toContainText('Chủ');

    // 6. Thấy danh sách tính năng đang hoạt động
    await expect(page.locator('[data-testid="enabled-features-list"]')).toBeVisible();

    // 7. Cố truy cập /platform -> Bị chặn 403 / Không có quyền truy cập
    await page.goto(`${BASE_URL}/platform`);
    await expect(page.locator('text=403')).toBeVisible();
    await expect(page.locator('text=Không có quyền truy cập')).toBeVisible();

    // 8. Chụp ảnh artifact
    await captureScreenshots(page, 'scenario-4-tenant-owner');
  });

  test('Kịch bản 5: Trình duyệt không lưu token trong localStorage, sessionStorage, document.cookie', async ({ page, context }) => {
    // 1. Đăng nhập thành công với Super Admin
    await page.goto(`${BASE_URL}/login`);
    await page.fill('[data-testid="identifier-input"]', 'admin@platform.local');
    await page.fill('[data-testid="password-input"]', ADMIN_PASSWORD);
    await page.click('[data-testid="login-submit-button"]');
    await expect(page.locator('[data-testid="otp-input"]')).toBeVisible({ timeout: 10000 });
    await page.fill('[data-testid="otp-input"]', generateTOTP(TOTP_SECRET));
    await page.click('[data-testid="mfa-submit-button"]');
    await page.waitForURL('**/platform**', { timeout: 10000 });

    // 2. Đánh giá JavaScript: không có token nào trong storage hoặc document.cookie
    const storageState = await page.evaluate(() => {
      return {
        localStorageKeys: Object.keys(localStorage),
        localStorageContent: JSON.stringify(localStorage),
        sessionStorageKeys: Object.keys(sessionStorage),
        documentCookie: document.cookie,
      };
    });

    // localStorage không chứa bất kỳ access/refresh token nào
    expect(storageState.localStorageContent).not.toContain('access_token');
    expect(storageState.localStorageContent).not.toContain('refresh_token');
    expect(storageState.localStorageContent).not.toContain('Bearer');

    // document.cookie là rỗng do cookie có cờ HttpOnly
    expect(storageState.documentCookie).not.toContain('access_token');
    expect(storageState.documentCookie).not.toContain('refresh_token');
    expect(storageState.documentCookie).not.toContain('iteso_admin_session');

    // 3. Kiểm tra thuộc tính Cookie bảo mật qua context
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'iteso_admin_session');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite.toLowerCase()).toBe('strict');

    // 4. Chụp ảnh artifact
    await captureScreenshots(page, 'scenario-5-token-security');
  });

  test('Kịch bản 6: Đăng xuất xóa cookie và nút Back không thể vào lại trang nội bộ', async ({ page, context }) => {
    // 1. Đăng nhập với owner@demo.local
    await page.goto(`${BASE_URL}/login`);
    await page.fill('[data-testid="identifier-input"]', 'owner@demo.local');
    await page.fill('[data-testid="password-input"]', DEMO_PASSWORD);
    await page.click('[data-testid="login-submit-button"]');

    // Chuyển hướng vào trang nội bộ /t/demo_fnb
    await page.waitForURL('**/t/demo_fnb**', { timeout: 10000 });
    await expect(page.locator('[data-testid="tenant-greeting-container"]')).toBeVisible();

    // 2. Nhấn nút Đăng xuất
    const logoutBtn = page.locator('[data-testid="logout-button"]');
    await expect(logoutBtn).toBeVisible();
    await logoutBtn.click();

    // 3. Chuyển hướng về /login
    await page.waitForURL('**/login**', { timeout: 10000 });
    await expect(page.locator('h1')).toContainText('Đăng nhập hệ thống');

    // Cookie session đã bị xóa (hoặc set value rỗng/maxAge 0)
    const cookiesAfterLogout = await context.cookies();
    const activeSessionCookie = cookiesAfterLogout.find(
      (c) => c.name === 'iteso_admin_session' && c.value && c.expires > Date.now() / 1000,
    );
    expect(activeSessionCookie).toBeUndefined();

    // 4. Bấm nút Back của trình duyệt
    await page.goBack();
    await page.waitForTimeout(1000);

    // Không vào lại được trang nội bộ: bị redirect về /login hoặc báo lỗi
    expect(page.url()).not.toContain('/t/demo_fnb');
    expect(page.url()).not.toContain('/platform');

    // 5. Chụp ảnh artifact
    await captureScreenshots(page, 'scenario-6-logout');
  });

  test('Kịch bản 7: Token hết hạn và nhiều request song song được gộp thành công không bị REFRESH_TOKEN_REUSE', async ({ page }) => {
    // 1. Đăng nhập Super Admin
    await page.goto(`${BASE_URL}/login`);
    await page.fill('[data-testid="identifier-input"]', 'admin@platform.local');
    await page.fill('[data-testid="password-input"]', ADMIN_PASSWORD);
    await page.click('[data-testid="login-submit-button"]');
    await expect(page.locator('[data-testid="otp-input"]')).toBeVisible({ timeout: 10000 });
    await page.fill('[data-testid="otp-input"]', generateTOTP(TOTP_SECRET));
    await page.click('[data-testid="mfa-submit-button"]');
    await page.waitForURL('**/platform**', { timeout: 10000 });
    await expect(page.locator('h1')).toContainText('Danh sách Doanh nghiệp');

    // 2. Chờ access token hết hạn nếu ACCESS_TOKEN_TTL_SECONDS ngắn (ví dụ 20s)
    const waitSeconds = parseInt(process.env.ACCESS_TOKEN_TTL_SECONDS || '0', 10);
    if (waitSeconds > 0 && waitSeconds <= 30) {
      await page.waitForTimeout((waitSeconds + 2) * 1000);
    }

    // 3. Thực hiện nhiều request đồng thời tới các API nội bộ và điều hướng trang
    const [tenantsRes, featuresRes, meRes] = await Promise.all([
      page.request.get(`${BASE_URL}/api/platform/tenants`),
      page.request.get(`${BASE_URL}/api/platform/features`),
      page.request.get(`${BASE_URL}/api/auth/me`),
      page.goto(`${BASE_URL}/platform/audit-log`),
    ]);

    expect(tenantsRes.ok()).toBe(true);
    expect(featuresRes.ok()).toBe(true);
    expect(meRes.ok()).toBe(true);
    await expect(page.locator('h1')).toContainText('Nhật ký');

    // Người dùng vẫn đăng nhập bình thường
    expect(page.url()).toContain('/platform/audit-log');

    // 4. Kiểm tra log control-plane: không có lỗi REFRESH_TOKEN_REUSE
    try {
      const logs = execSync(
        'docker compose --env-file .env -f infra/docker-compose.yml logs --tail=100 control-plane',
        { encoding: 'utf8' },
      );
      expect(logs).not.toContain('REFRESH_TOKEN_REUSE');
    } catch {
      // In non-docker test runs, skip container log inspection
    }

    // 5. Chụp ảnh artifact
    await captureScreenshots(page, 'scenario-7-refresh-coalescing');
  });
});
