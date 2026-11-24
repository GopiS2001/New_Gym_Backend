import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from '../auth/decorators';
import { serialize } from '../utils/helpers';

const REDACT = ['passwordHash', 'password', 'tokenHash'];

function clean(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  const plain = JSON.parse(
    JSON.stringify(serialize(value), (k, v) => (REDACT.includes(k) ? '[redacted]' : v)),
  );
  return plain as Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  /** Records an admin action. Never throws — auditing must not break the request. */
  async log(params: {
    actor: Actor;
    action: string;
    entityType: string;
    entityId?: string | number | null;
    summary?: string;
    before?: unknown;
    after?: unknown;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          adminUserId: params.actor?.userId ?? null,
          action: params.action,
          entityType: params.entityType,
          entityId: params.entityId != null ? String(params.entityId) : null,
          summary: params.summary?.slice(0, 255),
          beforeJson: clean(params.before),
          afterJson: clean(params.after),
          ipAddress: params.actor?.ip?.slice(0, 64),
          userAgent: params.actor?.userAgent?.slice(0, 255),
        },
      });
    } catch (e) {
      this.logger.error(`Failed to write audit log: ${(e as Error).message}`);
    }
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
