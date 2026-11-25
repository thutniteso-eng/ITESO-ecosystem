import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as fs from 'fs';
import * as path from 'path';
import * as schema from '../db/schema';
import {
  encryptAesGcm,
  generateBase32Secret,
  hashPassword,
} from '../auth/crypto.util';

function parseArgs() {
  const args = process.argv.slice(2);
  let email = '';
  let password = '';
  let totpSecret = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && i + 1 < args.length) {
      email = args[++i];
    } else if (args[i] === '--password' && i + 1 < args.length) {
      password = args[++i];
    } else if (args[i] === '--totp-secret' && i + 1 < args.length) {
      totpSecret = args[++i];
    }
  }

  return { email, password, totpSecret };
}

async function main() {
  const { email, password, totpSecret: cliSecret } = parseArgs();

  if (!email || !password) {
    console.error('Usage: node dist/cli/create-platform-admin.js --email <email> --password <password> [--totp-secret <base32_secret>]');
    process.exit(1);
  }

  if (password.length < 10) {
    console.error('Password must be at least 10 characters');
    process.exit(1);
  }

  let encryptionKey = process.env.PLATFORM_ENCRYPTION_KEY;
  const keyPath =
    process.env.PLATFORM_ENCRYPTION_KEY_PATH ||
    path.resolve(__dirname, '../../../../infra/secrets/platform_encryption.key');

  if (fs.existsSync(keyPath)) {
    encryptionKey = fs.readFileSync(keyPath, 'utf8').trim();
  }

  if (!encryptionKey || Buffer.from(encryptionKey, 'base64').length !== 32) {
    console.error('FATAL: Valid 32-byte PLATFORM_ENCRYPTION_KEY or key file at PLATFORM_ENCRYPTION_KEY_PATH is required');
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
    const finalSecret = cliSecret ? cliSecret.trim().toUpperCase() : generateBase32Secret(32);
    const totpSecretEnc = encryptAesGcm(finalSecret, encryptionKey);
    const passwordHash = await hashPassword(password);
    const cleanEmail = email.trim().toLowerCase();

    const [account] = await db
      .insert(schema.accounts)
      .values({
        email: cleanEmail,
        passwordHash,
        totpSecretEnc,
        totpEnabled: true,
        isPlatformAdmin: true,
        status: 'active',
        failedAttempts: 0,
        lockedUntil: null,
      })
      .onConflictDoUpdate({
        target: schema.accounts.email,
        set: {
          passwordHash,
          totpSecretEnc,
          totpEnabled: true,
          isPlatformAdmin: true,
          status: 'active',
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    const otpauthUri = `otpauth://totp/ITESO%20Platform:${encodeURIComponent(cleanEmail)}?secret=${finalSecret}&issuer=ITESO%20Platform`;

    console.log('Platform admin created successfully.');
    console.log(`Account ID: ${account.id}`);
    console.log(`Email: ${account.email}`);
    console.log(`TOTP Secret: ${finalSecret}`);
    console.log(otpauthUri);

    await pool.end();
  } catch (err) {
    console.error('Failed to create platform admin:', err);
    await pool.end();
    process.exit(1);
  }
}

main();
