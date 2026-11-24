import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { AuditService } from '../../common/audit/audit.service';
import { Actor, CurrentActor, RequirePermissions } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import { zId, zListQuery, zStatus, ZodPipe } from '../../common/pipes/zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { orderBy, paginate } from '../../common/utils/helpers';

// ===========================================================================
// Notification templates
// ===========================================================================

const SegmentSchema = z
  .object({
    goalIds: z.array(zId).optional(),
    experienceLevelIds: z.array(zId).optional(),
    onboardingStatus: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']).optional(),
    remindersEnabledOnly: z.boolean().optional(),
  })
  .default({});

const ScheduleSchema = z
  .object({
    sendAt: z.string().datetime().optional(),
    inactiveDays: z.coerce.number().int().min(1).max(365).optional(),
    minutesBefore: z.coerce.number().int().min(0).max(240).optional(),
  })
  .default({});

const TemplateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  title: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(500),
  type: z.enum(['REMINDER', 'MOTIVATION', 'ANNOUNCEMENT']).default('REMINDER'),
  trigger: z.enum(['SCHEDULED', 'WORKOUT_REMINDER', 'INACTIVITY', 'MANUAL']).default('WORKOUT_REMINDER'),
  targetSegment: SegmentSchema,
  schedule: ScheduleSchema,
  status: zStatus.default('ACTIVE'),
});
type TemplateInput = z.infer<typeof TemplateSchema>;

const ListSchema = zListQuery.extend({ status: zStatus.optional(), type: z.enum(['REMINDER', 'MOTIVATION', 'ANNOUNCEMENT']).optional() });

@Injectable()
export class NotificationTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: z.infer<typeof ListSchema>) {
    const where: Prisma.NotificationTemplateWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.search ? { OR: [{ name: { contains: q.search } }, { title: { contains: q.search } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.notificationTemplate.findMany({
        where,
        include: { _count: { select: { jobs: true } } },
        orderBy: [orderBy(q.sortBy, q.sortOrder, ['name', 'createdAt', 'updatedAt', 'status', 'type'], { updatedAt: 'desc' })],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.notificationTemplate.count({ where }),
    ]);
    return paginate(rows.map(({ _count, ...r }) => ({ ...r, jobCount: _count.jobs })), total, q.page, q.limit);
  }

  async get(id: number) {
    const row = await this.prisma.notificationTemplate.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Notification template not found');
    return row;
  }

  /** Estimates how many members a segment reaches (respecting opt-in). */
  async audience(segment: z.infer<typeof SegmentSchema>) {
    const where: Prisma.UserWhereInput = {
      type: 'MEMBER',
      status: 'ACTIVE',
      ...(segment.goalIds?.length ? { goals: { some: { goalId: { in: segment.goalIds } } } } : {}),
      ...(segment.experienceLevelIds?.length || segment.onboardingStatus
        ? {
            profile: {
              ...(segment.experienceLevelIds?.length ? { experienceLevelId: { in: segment.experienceLevelIds } } : {}),
              ...(segment.onboardingStatus ? { onboardingStatus: segment.onboardingStatus } : {}),
            },
          }
        : {}),
    };
    const [total, optedIn] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.count({ where: { ...where, notificationPreference: { enabled: true } } }),
    ]);
    return { total, optedIn };
  }

  async create(input: TemplateInput, actor: Actor) {
    const row = await this.prisma.notificationTemplate.create({ data: input });
    await this.audit.log({ actor, action: 'create', entityType: 'NotificationTemplate', entityId: row.id, summary: `Created notification "${row.name}"`, after: row });
    return row;
  }

  async update(id: number, input: Partial<TemplateInput>, actor: Actor) {
    const before = await this.get(id);
    const row = await this.prisma.notificationTemplate.update({ where: { id }, data: input });
    await this.audit.log({ actor, action: 'update', entityType: 'NotificationTemplate', entityId: id, summary: `Updated notification "${row.name}"`, before, after: row });
    return row;
  }

  async remove(id: number, actor: Actor) {
    const before = await this.get(id);
    const sent = await this.prisma.notificationJob.count({ where: { templateId: id, status: 'SENT' } });
    if (sent) throw new ConflictException('This template has delivery history. Deactivate it instead.');
    await this.prisma.notificationTemplate.delete({ where: { id } });
    await this.audit.log({ actor, action: 'delete', entityType: 'NotificationTemplate', entityId: id, summary: `Deleted notification "${before.name}"`, before });
    return { success: true };
  }
}

@ApiTags('Admin · Notifications')
@ApiBearerAuth()
@Controller('admin/notifications')
export class NotificationTemplatesController {
  constructor(private readonly service: NotificationTemplatesService) {}

  @RequirePermissions(PERMISSIONS.NOTIFICATIONS_MANAGE)
  @Get()
  list(@Query(new ZodPipe(ListSchema)) q: z.infer<typeof ListSchema>) {
    return this.service.list(q);
  }

  @RequirePermissions(PERMISSIONS.NOTIFICATIONS_MANAGE)
  @Post('audience')
  audience(@Body(new ZodPipe(z.object({ targetSegment: SegmentSchema }))) body: { targetSegment: z.infer<typeof SegmentSchema> }) {
    return this.service.audience(body.targetSegment);
  }

  @RequirePermissions(PERMISSIONS.NOTIFICATIONS_MANAGE)
  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.service.get(id);
  }

  @RequirePermissions(PERMISSIONS.NOTIFICATIONS_MANAGE)
  @Post()
  create(@Body(new ZodPipe(TemplateSchema)) body: TemplateInput, @CurrentActor() actor: Actor) {
    return this.service.create(body, actor);
  }

  @RequirePermissions(PERMISSIONS.NOTIFICATIONS_MANAGE)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(TemplateSchema.partial())) body: Partial<TemplateInput>, @CurrentActor() actor: Actor) {
    return this.service.update(id, body, actor);
  }

  @RequirePermissions(PERMISSIONS.NOTIFICATIONS_MANAGE)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
    return this.service.remove(id, actor);
  }
}

// ===========================================================================
// Audit logs (read-only)
// ===========================================================================

const AuditListSchema = zListQuery.extend({
  entityType: z.string().max(64).optional(),
  entityId: z.string().max(64).optional(),
  action: z.string().max(64).optional(),
  adminUserId: zId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

@ApiTags('Admin · Audit logs')
@ApiBearerAuth()
@Controller('admin/audit-logs')
export class AuditLogsController {
  constructor(private readonly prisma: PrismaService) {}

  @RequirePermissions(PERMISSIONS.AUDIT_VIEW)
  @Get()
  async list(@Query(new ZodPipe(AuditListSchema)) q: z.infer<typeof AuditListSchema>) {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.adminUserId ? { adminUserId: q.adminUserId } : {}),
      ...(q.search ? { summary: { contains: q.search } } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [rows, total, entityTypes] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: { adminUser: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.groupBy({ by: ['entityType'], orderBy: { entityType: 'asc' } }),
    ]);
    return { ...paginate(rows, total, q.page, q.limit), entityTypes: entityTypes.map((e) => e.entityType) };
  }

  @RequirePermissions(PERMISSIONS.AUDIT_VIEW)
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    const row = await this.prisma.auditLog.findUnique({
      where: { id },
      include: { adminUser: { select: { id: true, name: true, email: true } } },
    });
    if (!row) throw new NotFoundException('Audit entry not found');
    return row;
  }
}

export { AuditService };
