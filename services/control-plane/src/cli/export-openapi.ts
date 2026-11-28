import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { createOpenApiDocument } from '../openapi';
import { NatsService } from '../nats/nats.service';

async function exportOpenApi() {
  process.env.NODE_ENV = 'test';
  process.env.INTERNAL_API_TOKEN =
    process.env.INTERNAL_API_TOKEN || '0123456789abcdef0123456789abcdef';
  process.env.PLATFORM_ENCRYPTION_KEY =
    process.env.PLATFORM_ENCRYPTION_KEY || Buffer.alloc(32, 1).toString('base64');
  process.env.ODOO_CREDENTIALS_KEY =
    process.env.ODOO_CREDENTIALS_KEY || Buffer.alloc(32, 1).toString('base64');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(NatsService)
    .useValue({
      onModuleInit: () => {},
      onModuleDestroy: () => {},
      publish: async () => {},
      isHealthy: async () => true,
    })
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  const document = createOpenApiDocument(app);
  const outPath = path.resolve(__dirname, '../../openapi.json');
  fs.writeFileSync(outPath, JSON.stringify(document, null, 2), 'utf8');
  console.log(`[export-openapi] Control plane OpenAPI spec written to ${outPath}`);
  await app.close();
  process.exit(0);
}

exportOpenApi().catch((err) => {
  console.error('[export-openapi] Failed:', err);
  process.exit(1);
});
