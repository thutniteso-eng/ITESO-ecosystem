import * as path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

export async function runMigrations(pgPool: Pool): Promise<void> {
  const db = drizzle(pgPool);
  const migrationsFolder = path.join(__dirname, '../../drizzle');
  await migrate(db, { migrationsFolder });
}

export async function grantGatewayPermissions(pgPool: Pool): Promise<void> {
  // Grant least-privilege SELECT to iteso_gateway on platform catalog tables
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
      console.log('Running Drizzle migrations with migrator tracking...');
      await runMigrations(pool);
      console.log('Applying iteso_gateway permissions...');
      await grantGatewayPermissions(pool);
      console.log('Migrations completed successfully.');
      await pool.end();
    } catch (err) {
      console.error('Migration failed:', err);
      process.exit(1);
    }
  })();
}
