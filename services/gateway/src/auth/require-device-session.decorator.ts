import { SetMetadata } from '@nestjs/common';

export const REQUIRE_DEVICE_SESSION_KEY = 'requireDeviceSession';
export const RequireDeviceSession = () => SetMetadata(REQUIRE_DEVICE_SESSION_KEY, true);
