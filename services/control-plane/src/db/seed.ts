import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export async function seedDatabase(pgPool: Pool): Promise<void> {
  const db = drizzle(pgPool, { schema });

  // 1. Seed demo tenant demo_fnb
  await db
    .insert(schema.tenants)
    .values({
      code: 'demo_fnb',
      dbName: 't_demo_fnb',
      displayName: 'Nhà hàng Demo F&B',
      status: 'active',
      industries: ['fnb'],
    })
    .onConflictDoUpdate({
      target: schema.tenants.code,
      set: {
        dbName: 't_demo_fnb',
        displayName: 'Nhà hàng Demo F&B',
        status: 'active',
        industries: ['fnb'],
        updatedAt: new Date(),
      },
    });

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

  // Ensure iteso_gateway permissions are active
  await pgPool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iteso_gateway') THEN
        GRANT USAGE ON SCHEMA public TO iteso_gateway;
        GRANT SELECT ON TABLE "tenants", "feature_definitions", "tenant_features" TO iteso_gateway;
        REVOKE ALL ON TABLE "admin_audit_log" FROM iteso_gateway;
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
