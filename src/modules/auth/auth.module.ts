import { Global, Module } from '@nestjs/common';

import { AdminAuthController, AuthController, PresenceController } from './auth.controller';
import { AuthService } from './auth.service';

@Global()
@Module({
  controllers: [AuthController, AdminAuthController, PresenceController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
