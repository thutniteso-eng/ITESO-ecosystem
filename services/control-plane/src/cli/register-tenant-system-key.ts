import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import * as schema from '../db/schema';
import { encryptAesGcm } from '../auth/crypto.util';

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

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data.trim());
    });
    process.stdin.on('error', (err) => {
      reject(err);
    });
  });
}

async function main() {
  const { tenantCode } = parseArgs();

  if (!tenantCode) {
    console.error('Usage: node dist/cli/register-tenant-system-key.js --tenant <code>');
    process.exit(1);
  }

  const rawKey = await readStdin();
  if (!rawKey) {
    console.error('ERROR: No raw API key provided on stdin.');
    process.exit(1);
  }

  let encryptionKey = process.env.PLATFORM_ENCRYPTION_KEY;
  const keyPath =
    process.env.PLATFORM_ENCRYPTION_KEY_PATH ||
    path.resolve(__dirname, '../../../../infra/secrets/platform_encryption.key');

  if (fs.existsSync(keyPath)) {
    encryptionKey = fs.readFileSync(keyPath, 'utf8').trim();
  }

  if (!encryptionKey) {
    console.error('FATAL: Platform encryption key not found.');
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

  try {
    const tenant = await db.query.tenants.findFirst({
      where: eq(schema.tenants.code, tenantCode),
    });

    if (!tenant) {
      console.error(`ERROR: Tenant with code '${tenantCode}' not found.`);
      process.exit(1);
    }

    const keyEnc = encryptAesGcm(rawKey, encryptionKey);

    await db
      .insert(schema.tenantOdooSystemKeys)
      .values({
        tenantId: tenant.id,
        keyEnc,
        rotatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.tenantOdooSystemKeys.tenantId,
        set: {
          keyEnc,
          rotatedAt: new Date(),
        },
      });

    console.log(`[register-tenant-system-key] Successfully registered system key for tenant '${tenantCode}'.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
