import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { OdooProvisioningService } from '../control-plane/odoo-provisioning.service';
import { NatsService } from '../nats/nats.service';

function parseArgs() {
  const args = process.argv.slice(2);
  let tenantCode = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tenant' && i + 1 < args.length) {
      tenantCode = args[++i];
    }
  }

  return { tenantCode };
}

async function main() {
  const { tenantCode } = parseArgs();

  if (!tenantCode) {
    console.error('Usage: node dist/cli/provision-odoo-users.js --tenant <code>');
    process.exit(1);
  }

  const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? 'postgres',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_CONTROL_PLANE_USER ?? 'iteso_control_plane',
    password: process.env.POSTGRES_CONTROL_PLANE_PASSWORD ?? '',
    database: process.env.PLATFORM_DB ?? 'platform',
  });

  const db = drizzle(pool, { schema });
  const nats = new NatsService();
  await nats.onModuleInit();
  const provisioningService = new OdooProvisioningService(nats);

  try {
    const tenant = await db.query.tenants.findFirst({
      where: eq(schema.tenants.code, tenantCode),
    });

    if (!tenant) {
      console.error(`ERROR: Tenant with code '${tenantCode}' not found.`);
      process.exit(1);
    }

    const memberships = await db.query.memberships.findMany({
      where: eq(schema.memberships.tenantId, tenant.id),
    });

    console.log(`[provision-odoo-users] Found ${memberships.length} memberships for tenant '${tenantCode}'. Provisioning...`);

    for (const mem of memberships) {
      const res = await provisioningService.syncMembership(mem.id);
      console.log(`[provision-odoo-users] Membership ${mem.id}: status=${res.status}, odooUid=${res.odooUid ?? 'none'}, error=${res.lastError ?? 'none'}`);
    }

    console.log(`[provision-odoo-users] Completed provisioning for tenant '${tenantCode}'.`);
  } finally {
    await provisioningService.onModuleDestroy();
    await nats.onModuleDestroy();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
