import { Controller, Get } from '@nestjs/common';

@Controller('v1/test-undeclared')
export class TestUndeclaredController {
  @Get()
  getTest(): { status: string } {
    return { status: 'ok' };
  }
}
