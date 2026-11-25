import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { OdooController } from './odoo/odoo.controller';
import { OdooService } from './odoo/odoo.service';

@Module({
  controllers: [HealthController, OdooController],
  providers: [HealthService, OdooService],
})
export class AppModule {}
