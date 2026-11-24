import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as path from 'path';

import { AuditModule } from './common/audit/audit.service';
import { AuthGuard } from './common/auth/auth.guard';
import { Public } from './common/auth/decorators';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { SerializeInterceptor } from './common/interceptors/serialize.interceptor';
import { MailModule } from './common/mail/mail.service';
import { LiveModule } from './common/live/live.service';
import { PrismaModule, PrismaService } from './common/prisma/prisma.service';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { ContentModule } from './modules/content/content.module';
import { ExercisesModule } from './modules/exercises/exercises.module';
import { MemberModule } from './modules/member/member.module';
import { SocialModule } from './modules/social/social.module';
import { ProgramsModule } from './modules/programs/programs.module';
import { ReferenceModule } from './modules/reference/reference.module';

@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', time: new Date().toISOString() };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({ global: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    ServeStaticModule.forRoot({
      rootPath: path.resolve(process.cwd(), process.env.UPLOAD_DIR || 'uploads'),
      serveRoot: '/uploads',
      serveStaticOptions: { index: false, maxAge: '7d', fallthrough: false },
    }),
    PrismaModule,
    MailModule,
    LiveModule,
    AuditModule,
    AuthModule,
    ReferenceModule,
    ExercisesModule,
    ProgramsModule,
    ContentModule,
    AdminModule,
    MemberModule,
    SocialModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: SerializeInterceptor },
  ],
})
export class AppModule {}
