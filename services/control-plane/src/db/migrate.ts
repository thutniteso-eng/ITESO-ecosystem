import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

dotenv.config({ path: path.join(__dirname, '../../../../.env') });

export async function runMigrations(pgPool: Pool): Promise<void> {
  const sqlFile = path.join(__dirname, '../../drizzle/0000_init_control_plane.sql');
  const sql = fs.readFileSync(sqlFile, 'utf-8');
  await pgPool.query(sql);
}

if (require.main === module) {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_CONTROL_PLANE_USER ?? 'iteso_control_plane',
    password: process.env.POSTGRES_CONTROL_PLANE_PASSWORD ?? '',
    database: process.env.PLATFORM_DB ?? 'platform',
  });

  runMigrations(pool)
    .then(() => {
      console.log('Migrations completed successfully.');
      return pool.end();
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
