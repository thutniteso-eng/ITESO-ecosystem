import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import * as schema from './schema';

export async function seedDatabase(pgPool: Pool): Promise<void> {
  const db = drizzle(pgPool, { schema });

  // 1. Seed demo tenants demo_fnb and demo_fnb2
  const tenantsList = [
    {
      code: 'demo_fnb',
      dbName: 't_demo_fnb',
      displayName: 'Nhà hàng Demo F&B',
      status: 'active' as const,
      industries: ['fnb'],
    },
    {
      code: 'demo_fnb2',
      dbName: 't_demo_fnb2',
      displayName: 'Nhà hàng Demo F&B 2',
      status: 'active' as const,
      industries: ['fnb'],
    },
  ];

  const tenantRecords: Record<string, string> = {}; // code -> id

  for (const t of tenantsList) {
    const [inserted] = await db
      .insert(schema.tenants)
      .values(t)
      .onConflictDoUpdate({
        target: schema.tenants.code,
        set: {
          dbName: t.dbName,
          displayName: t.displayName,
          status: t.status,
          industries: t.industries,
          updatedAt: new Date(),
        },
      })
      .returning({ id: schema.tenants.id, code: schema.tenants.code });
    tenantRecords[inserted.code] = inserted.id;
  }

  // 2. Seed feature definitions
  const features = [
    // ADR-004 not_implemented features
    { key: 'fnb.pos', group: 'fnb', description: 'Bán hàng tại quầy', implementationStatus: 'not_implemented' as const, platformEnabled: false, defaultEnabled: true },
    { key: 'fnb.qr_order', group: 'fnb', description: 'Khách gọi món qua QR', implementationStatus: 'not_implemented' as const, platformEnabled: false, defaultEnabled: true },
    { key: 'fnb.kds', group: 'fnb', description: 'Màn hình bếp', implementationStatus: 'not_implemented' as const, platformEnabled: false, defaultEnabled: true },
    { key: 'fnb.reservation', group: 'fnb', description: 'Đặt bàn', implementationStatus: 'not_implemented' as const, platformEnabled: false, defaultEnabled: true },
    { key: 'einvoice.viettel', group: 'einvoice', description: 'Hóa đơn điện tử qua Viettel SInvoice', implementationStatus: 'not_implemented' as const, platformEnabled: false, defaultEnabled: false },
    { key: 'inventory.recipe', group: 'inventory', description: 'Định lượng nguyên liệu', implementationStatus: 'not_implemented' as const, platformEnabled: false, defaultEnabled: false },
    { key: 'hotel.pms', group: 'hotel', description: 'Gói lưu trú', implementationStatus: 'not_implemented' as const, platformEnabled: false, defaultEnabled: false },
    { key: 'platform.tenant_create', group: 'platform', description: 'Tạo tenant cho doanh nghiệp khác', implementationStatus: 'not_implemented' as const, platformEnabled: false, defaultEnabled: false },
    { key: 'platform.self_signup', group: 'platform', description: 'Tự đăng ký', implementationStatus: 'not_implemented' as const, platformEnabled: false, defaultEnabled: false },
    { key: 'platform.billing', group: 'platform', description: 'Gói cước, thu phí', implementationStatus: 'not_implemented' as const, platformEnabled: false, defaultEnabled: false },
    { key: 'ai.assistant', group: 'ai', description: 'Trợ lý AI', implementationStatus: 'not_implemented' as const, platformEnabled: false, defaultEnabled: false },
    // TASK-002 available features
    { key: 'system.odoo_version', group: 'system', description: 'Xem phiên bản Odoo qua gateway', implementationStatus: 'available' as const, platformEnabled: true, defaultEnabled: true },
    { key: 'system.features', group: 'system', description: 'Tra cứu danh sách tính năng đang bật', implementationStatus: 'available' as const, platformEnabled: true, defaultEnabled: true },
    // TASK-003 available features
    { key: 'system.auth', group: 'system', description: 'Đăng nhập và phân quyền hệ thống', implementationStatus: 'available' as const, platformEnabled: true, defaultEnabled: true },
  ];

  for (const feat of features) {
    await db
      .insert(schema.featureDefinitions)
      .values(feat)
      .onConflictDoUpdate({
        target: schema.featureDefinitions.key,
        set: {
          group: feat.group,
          description: feat.description,
          implementationStatus: feat.implementationStatus,
        },
      });
  }

  // 3. Seed permissions (ADR-005 & TASK-003)
  const permissionList = [
    { key: 'system.diagnostics.view', group: 'system', description: 'Xem thông tin chẩn đoán hệ thống' },
    { key: 'settings.manage', group: 'settings', description: 'Quản lý cài đặt hệ thống' },
    { key: 'settings.roles.manage', group: 'settings', description: 'Quản lý vai trò và phân quyền' },
    { key: 'pos.order.create', group: 'pos', description: 'Tạo đơn hàng POS' },
    { key: 'pos.order.void', group: 'pos', description: 'Hủy đơn hàng POS' },
    { key: 'pos.discount.apply', group: 'pos', description: 'Áp dụng giảm giá đơn hàng POS' },
    { key: 'report.revenue.view', group: 'report', description: 'Xem báo cáo doanh thu' },
    { key: 'inventory.manage', group: 'inventory', description: 'Quản lý kho hàng' },
    { key: 'accounting.view', group: 'accounting', description: 'Xem dữ liệu kế toán' },
    // Common permission for every tenant member (needed for GET /v1/features)
    { key: 'system.features.read', group: 'system', description: 'Xem danh sách tính năng được bật của tenant' },
  ];

  for (const p of permissionList) {
    await db
      .insert(schema.permissions)
      .values(p)
      .onConflictDoUpdate({
        target: schema.permissions.key,
        set: {
          group: p.group,
          description: p.description,
        },
      });
  }

  // 4. Seed 6 standard roles for each tenant
  // Chủ: all perms
  // Quản lý: all perms except settings.roles.manage
  // Thu ngân: pos.order.create, pos.discount.apply, system.features.read
  // Phục vụ: pos.order.create, system.features.read
  // Bếp: system.features.read
  // Kế toán: report.revenue.view, accounting.view, system.features.read
  const allPermKeys = permissionList.map((p) => p.key);

  const roleConfigs = [
    { name: 'Chủ', isOwner: true, perms: allPermKeys },
    { name: 'Quản lý', isOwner: false, perms: allPermKeys.filter((k) => k !== 'settings.roles.manage') },
    { name: 'Thu ngân', isOwner: false, perms: ['pos.order.create', 'pos.discount.apply', 'system.features.read'] },
    { name: 'Phục vụ', isOwner: false, perms: ['pos.order.create', 'system.features.read'] },
    { name: 'Bếp', isOwner: false, perms: ['system.features.read'] },
    { name: 'Kế toán', isOwner: false, perms: ['report.revenue.view', 'accounting.view', 'system.features.read'] },
  ];

  // Map: `${tenantCode}:${roleName}` -> roleId
  const roleMap: Record<string, string> = {};

  for (const tenantCode of ['demo_fnb', 'demo_fnb2']) {
    const tenantId = tenantRecords[tenantCode];
    for (const r of roleConfigs) {
      const [roleRow] = await db
        .insert(schema.roles)
        .values({
          tenantId,
          name: r.name,
          isOwner: r.isOwner,
        })
        .onConflictDoUpdate({
          target: [schema.roles.tenantId, schema.roles.name],
          set: {
            isOwner: r.isOwner,
          },
        })
        .returning({ id: schema.roles.id });

      roleMap[`${tenantCode}:${r.name}`] = roleRow.id;

      // Seed role_permissions
      for (const pKey of r.perms) {
        await db
          .insert(schema.rolePermissions)
          .values({
            roleId: roleRow.id,
            permissionKey: pKey,
          })
          .onConflictDoNothing();
      }
    }
  }

  // 5. Seed demo accounts
  const demoPassword = process.env.DEMO_ACCOUNTS_PASSWORD || 'Admin@123456';
  const passwordHash = await argon2.hash(demoPassword, {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB
    timeCost: 2,       // t = 2
    parallelism: 1,    // p = 1
  });

  const demoAccounts = [
    { email: 'owner@demo.local', phone: '+84900000001' },
    { email: 'cashier@demo.local', phone: '+84900000002' },
    { email: 'multi@demo.local', phone: '+84900000003' },
  ];

  const accountMap: Record<string, string> = {}; // email -> accountId

  for (const acc of demoAccounts) {
    const [insertedAcc] = await db
      .insert(schema.accounts)
      .values({
        email: acc.email,
        phone: acc.phone,
        passwordHash,
        status: 'active',
        isPlatformAdmin: false,
        totpEnabled: false,
        failedAttempts: 0,
        lockedUntil: null,
      })
      .onConflictDoUpdate({
        target: schema.accounts.email,
        set: {
          phone: acc.phone,
          passwordHash,
          status: 'active',
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: schema.accounts.id, email: schema.accounts.email });

    if (insertedAcc.email) {
      accountMap[insertedAcc.email] = insertedAcc.id;
    }
  }

  // 6. Seed memberships and membership_roles
  // owner@demo.local -> demo_fnb (Chủ)
  // cashier@demo.local -> demo_fnb (Thu ngân)
  // multi@demo.local -> demo_fnb (Thu ngân) & demo_fnb2 (Phục vụ)
  const membershipConfigs = [
    {
      email: 'owner@demo.local',
      tenantCode: 'demo_fnb',
      roleName: 'Chủ',
    },
    {
      email: 'cashier@demo.local',
      tenantCode: 'demo_fnb',
      roleName: 'Thu ngân',
    },
    {
      email: 'multi@demo.local',
      tenantCode: 'demo_fnb',
      roleName: 'Thu ngân',
    },
    {
      email: 'multi@demo.local',
      tenantCode: 'demo_fnb2',
      roleName: 'Phục vụ',
    },
  ];

  for (const m of membershipConfigs) {
    const accountId = accountMap[m.email];
    const tenantId = tenantRecords[m.tenantCode];
    const roleId = roleMap[`${m.tenantCode}:${m.roleName}`];

    if (!accountId || !tenantId || !roleId) continue;

    const [memRow] = await db
      .insert(schema.memberships)
      .values({
        accountId,
        tenantId,
        status: 'active',
        branchScope: [],
      })
      .onConflictDoUpdate({
        target: [schema.memberships.accountId, schema.memberships.tenantId],
        set: {
          status: 'active',
        },
      })
      .returning({ id: schema.memberships.id });

    // Link role
    await db
      .insert(schema.membershipRoles)
      .values({
        membershipId: memRow.id,
        roleId,
      })
      .onConflictDoNothing();
  }

  // 7. Ensure iteso_gateway permissions: only SELECT on tenants, feature_definitions, tenant_features
  await pgPool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iteso_gateway') THEN
        GRANT USAGE ON SCHEMA public TO iteso_gateway;
        GRANT SELECT ON TABLE "tenants", "feature_definitions", "tenant_features" TO iteso_gateway;
        REVOKE ALL ON TABLE "admin_audit_log", "accounts", "permissions", "roles", "role_permissions", "memberships", "membership_roles", "refresh_tokens" FROM iteso_gateway;
      END IF;
    END $$;
  `);
}

if (require.main === module) {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? 'postgres',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_CONTROL_PLANE_USER ?? 'iteso_control_plane',
    password: process.env.POSTGRES_CONTROL_PLANE_PASSWORD ?? '',
    database: process.env.PLATFORM_DB ?? 'platform',
  });

  (async () => {
    try {
      console.log('Seeding database...');
      await seedDatabase(pool);
      console.log('Seeding completed successfully.');
      await pool.end();
    } catch (err) {
      console.error('Seeding failed:', err);
      process.exit(1);
    }
  })();
}
