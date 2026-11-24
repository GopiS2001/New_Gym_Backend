import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, UserStatus } from '@prisma/client';
import type { Response } from 'express';
import { z } from 'zod';

import { AuditService } from '../../common/audit/audit.service';
import { isOnline, onlineWhere } from '../../common/auth/presence';
import { Actor, CurrentActor, RequirePermissions } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import { zCsvIds, zListQuery, ZodPipe } from '../../common/pipes/zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { orderBy, paginate } from '../../common/utils/helpers';
import { zPassword } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';

const ListSchema = zListQuery.extend({
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
  goalId: zCsvIds,
  experienceLevelId: zCsvIds,
  onboardingStatus: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']).optional(),
  presence: z.enum(['online', 'offline', 'signed_in', 'signed_out']).optional(),
  registeredFrom: z.coerce.date().optional(),
  registeredTo: z.coerce.date().optional(),
});
type ListQ = z.infer<typeof ListSchema>;

const CreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(191),
  password: zPassword,
});

const UpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().email().max(191).optional(),
  avatarUrl: z.string().trim().max(500).nullish(),
});

const StatusSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
  reason: z.string().trim().max(255).optional(),
});

const listInclude = {
  profile: { include: { experienceLevel: { select: { id: true, name: true } } } },
  goals: { where: { isPrimary: true }, include: { goal: { select: { id: true, name: true } } } },
  _count: { select: { workoutSessions: { where: { status: 'COMPLETED' } } } },
  refreshTokens: { where: { revokedAt: null }, select: { familyId: true, expiresAt: true } },
} satisfies Prisma.UserInclude;

/** Signed-in devices = distinct, unexpired refresh-token families. */
function activeDeviceCount(tokens: { familyId: string; expiresAt: Date }[], now = Date.now()) {
  return new Set(tokens.filter((t) => t.expiresAt.getTime() > now).map((t) => t.familyId)).size;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  private where(q: Partial<ListQ>): Prisma.UserWhereInput {
    const now = Date.now();
    const signedIn: Prisma.UserWhereInput = { refreshTokens: { some: { revokedAt: null, expiresAt: { gt: new Date(now) } } } };
    const presence: Prisma.UserWhereInput =
      q.presence === 'online'
        ? onlineWhere(now)
        : q.presence === 'offline'
          ? { NOT: onlineWhere(now) }
          : q.presence === 'signed_in'
            ? signedIn
            : q.presence === 'signed_out'
              ? { NOT: signedIn }
              : {};
    return {
      type: 'MEMBER',
      ...presence,
      ...(q.status ? { status: q.status } : {}),
      ...(q.search ? { OR: [{ name: { contains: q.search } }, { email: { contains: q.search } }] } : {}),
      ...(q.goalId ? { goals: { some: { goalId: { in: q.goalId } } } } : {}),
      ...(q.experienceLevelId || q.onboardingStatus
        ? {
            profile: {
              ...(q.experienceLevelId ? { experienceLevelId: { in: q.experienceLevelId } } : {}),
              ...(q.onboardingStatus ? { onboardingStatus: q.onboardingStatus } : {}),
            },
          }
        : {}),
      ...(q.registeredFrom || q.registeredTo
        ? { createdAt: { ...(q.registeredFrom ? { gte: q.registeredFrom } : {}), ...(q.registeredTo ? { lte: q.registeredTo } : {}) } }
        : {}),
    };
  }

  private presentRow(u: Prisma.UserGetPayload<{ include: typeof listInclude }>) {
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      status: u.status,
      avatarUrl: u.avatarUrl,
      emailVerified: !!u.emailVerifiedAt,
      lastLoginAt: u.lastLoginAt,
      lastSeenAt: u.lastSeenAt,
      online: isOnline(u),
      signedInDevices: activeDeviceCount(u.refreshTokens),
      createdAt: u.createdAt,
      onboardingStatus: u.profile?.onboardingStatus ?? 'NOT_STARTED',
      experienceLevel: u.profile?.experienceLevel ?? null,
      weeklyWorkoutDays: u.profile?.weeklyWorkoutDays ?? null,
      primaryGoal: u.goals[0]?.goal ?? null,
      completedWorkouts: u._count.workoutSessions,
      friendCount: u.friendCount,
    };
  }

  async list(q: ListQ) {
    const where = this.where(q);
    const [rows, total, statusCounts, onlineNow] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: listInclude,
        orderBy: [orderBy(q.sortBy, q.sortOrder, ['name', 'email', 'createdAt', 'lastLoginAt', 'status'], { createdAt: 'desc' }), { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.user.count({ where }),
      this.prisma.user.groupBy({ by: ['status'], where: { type: 'MEMBER' }, _count: { _all: true } }),
      this.prisma.user.count({ where: { type: 'MEMBER', ...onlineWhere() } }),
    ]);
    return {
      ...paginate(rows.map((r) => this.presentRow(r)), total, q.page, q.limit),
      statusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all])),
      onlineNow,
    };
  }

  async get(id: number) {
    const u = await this.prisma.user.findFirst({
      where: { id, type: 'MEMBER' },
      include: {
        profile: { include: { experienceLevel: true, genderOption: true, activityOption: true } },
        goals: { include: { goal: { select: { id: true, name: true } } } },
        focusAreas: { include: { focusArea: { select: { id: true, name: true } } } },
        motivations: { include: { option: { select: { id: true, label: true } } } },
        equipment: { include: { equipment: { select: { id: true, name: true } } } },
        measurements: { orderBy: { measuredAt: 'desc' }, take: 20 },
        notificationPreference: true,
        notificationDays: true,
        enrollments: { include: { program: { select: { id: true, name: true } } }, orderBy: { startedAt: 'desc' } },
        _count: { select: { savedExercises: true, savedPrograms: true, collections: true } },
        refreshTokens: {
          where: { revokedAt: null, expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
          select: { familyId: true, createdAt: true, userAgent: true, ipAddress: true },
        },
      },
    });
    if (!u) throw new NotFoundException('Member not found');

    const [sessionStats, lastSession, recentSessions] = await Promise.all([
      this.prisma.workoutSession.groupBy({ by: ['status'], where: { userId: id }, _count: { _all: true } }),
      this.prisma.workoutSession.findFirst({ where: { userId: id, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' } }),
      this.prisma.workoutSession.findMany({
        where: { userId: id },
        orderBy: { startedAt: 'desc' },
        take: 10,
        include: { _count: { select: { exercises: true } }, program: { select: { id: true, name: true } } },
      }),
    ]);

    const { passwordHash: _ph, refreshTokens, ...user } = u;
    // One entry per device (token family); newest token = last refresh on that device.
    const devices = [...new Map(refreshTokens.map((t) => [t.familyId, t])).values()].map((t) => ({
      lastActiveAt: t.createdAt,
      userAgent: t.userAgent,
      ipAddress: t.ipAddress,
    }));
    return {
      ...user,
      presence: { online: isOnline(u), lastSeenAt: u.lastSeenAt, signedIn: devices.length > 0, devices },
      emailVerified: !!u.emailVerifiedAt,
      onboarding: {
        status: u.profile?.onboardingStatus ?? 'NOT_STARTED',
        completedAt: u.profile?.onboardingCompletedAt ?? null,
        version: u.profile?.onboardingVersion ?? null,
        gender: u.profile?.genderOption?.label ?? null,
        genderCustom: u.profile?.genderCustom ?? null,
        preferredActivity: u.profile?.activityOption?.label ?? null,
        experienceLevel: u.profile?.experienceLevel?.name ?? null,
        weeklyWorkoutDays: u.profile?.weeklyWorkoutDays ?? null,
        goals: u.goals.map((g) => ({ ...g.goal, isPrimary: g.isPrimary })),
        focusAreas: u.focusAreas.map((f) => f.focusArea),
        motivations: u.motivations.map((m) => m.option),
        equipment: u.equipment.map((e) => e.equipment),
      },
      reminders: {
        enabled: u.notificationPreference?.enabled ?? false,
        time: u.notificationPreference?.preferredTime ?? null,
        timezone: u.notificationPreference?.timezone ?? null,
        days: u.notificationDays.map((d) => d.dayOfWeek).sort(),
      },
      stats: {
        sessions: Object.fromEntries(sessionStats.map((s) => [s.status, s._count._all])),
        lastWorkoutAt: lastSession?.completedAt ?? null,
        savedExercises: u._count.savedExercises,
        savedPrograms: u._count.savedPrograms,
        collections: u._count.collections,
      },
      recentSessions,
    };
  }

  async create(input: z.infer<typeof CreateSchema>, actor: Actor) {
    const email = AuthService.normaliseEmail(input.email);
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('Email is already registered');
    const user = await this.prisma.user.create({
      data: {
        name: input.name,
        email,
        passwordHash: await this.auth.hashPassword(input.password),
        type: 'MEMBER',
        profile: { create: {} },
        notificationPreference: { create: {} },
      },
    });
    await this.audit.log({ actor, action: 'create', entityType: 'Member', entityId: user.id, summary: `Created member ${email}`, after: { name: user.name, email } });
    return this.get(user.id);
  }

  async update(id: number, input: z.infer<typeof UpdateSchema>, actor: Actor) {
    const before = await this.prisma.user.findFirst({ where: { id, type: 'MEMBER' }, select: { name: true, email: true, avatarUrl: true } });
    if (!before) throw new NotFoundException('Member not found');
    const data = { ...input, ...(input.email ? { email: AuthService.normaliseEmail(input.email) } : {}) };
    if (data.email && data.email !== before.email && (await this.prisma.user.findUnique({ where: { email: data.email } }))) {
      throw new ConflictException('Email is already registered');
    }
    await this.prisma.user.update({
      where: { id },
      data: { ...data, ...(data.email && data.email !== before.email ? { emailVerifiedAt: null } : {}) },
    });
    await this.audit.log({ actor, action: 'update', entityType: 'Member', entityId: id, summary: `Updated member ${before.email}`, before, after: data });
    return this.get(id);
  }

  async setStatus(id: number, status: UserStatus, reason: string | undefined, actor: Actor) {
    const before = await this.prisma.user.findFirst({ where: { id, type: 'MEMBER' } });
    if (!before) throw new NotFoundException('Member not found');
    await this.prisma.user.update({ where: { id }, data: { status } });
    if (status !== 'ACTIVE') await this.auth.revokeAllSessions(id, 'suspended');
    const action = { ACTIVE: before.status === 'SUSPENDED' ? 'restore' : 'activate', INACTIVE: 'deactivate', SUSPENDED: 'suspend' }[status];
    await this.audit.log({
      actor,
      action,
      entityType: 'Member',
      entityId: id,
      summary: `${action} member ${before.email}${reason ? ` — ${reason}` : ''}`,
      before: { status: before.status },
      after: { status, reason },
    });
    return this.get(id);
  }

  async forceLogout(id: number, actor: Actor) {
    const user = await this.prisma.user.findFirst({ where: { id, type: 'MEMBER' }, select: { email: true } });
    if (!user) throw new NotFoundException('Member not found');
    const { revokedSessions } = await this.auth.forceLogout(id);
    await this.audit.log({
      actor,
      action: 'force_logout',
      entityType: 'Member',
      entityId: id,
      summary: `Force logged out ${user.email} (${revokedSessions} session${revokedSessions === 1 ? '' : 's'})`,
    });
    return { success: true, revokedSessions, message: `${user.email} was signed out on all devices` };
  }

  /** A member's friends and pending friend requests (read-only for admins). */
  async friends(id: number) {
    const user = await this.prisma.user.findFirst({ where: { id, type: 'MEMBER' }, select: { id: true, friendCount: true } });
    if (!user) throw new NotFoundException('Member not found');
    const person = { id: true, name: true, email: true, avatarUrl: true, status: true, friendCount: true, lastSeenAt: true, appInBackground: true } as const;
    const [links, incoming, outgoing] = await Promise.all([
      this.prisma.friendship.findMany({
        where: { OR: [{ userAId: id }, { userBId: id }] },
        include: { userA: { select: person }, userB: { select: person } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.friendRequest.findMany({ where: { toUserId: id, status: 'PENDING' }, include: { fromUser: { select: person } }, orderBy: { createdAt: 'desc' } }),
      this.prisma.friendRequest.findMany({ where: { fromUserId: id, status: 'PENDING' }, include: { toUser: { select: person } }, orderBy: { createdAt: 'desc' } }),
    ]);
    const present = (u: { id: number; name: string; email: string; avatarUrl: string | null; status: string; friendCount: number; lastSeenAt: Date | null; appInBackground: boolean }) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl,
      status: u.status,
      friendCount: u.friendCount,
      online: isOnline(u),
    });
    return {
      friendCount: user.friendCount,
      friends: links.map((f) => ({ ...present(f.userAId === id ? f.userB : f.userA), since: f.createdAt })),
      incoming: incoming.map((r) => ({ requestId: r.id, sentAt: r.createdAt, person: present(r.fromUser) })),
      outgoing: outgoing.map((r) => ({ requestId: r.id, sentAt: r.createdAt, person: present(r.toUser) })),
    };
  }

  /** Sends the member a secure reset link; admins never see or set passwords. */
  async sendPasswordReset(id: number, actor: Actor) {
    const user = await this.prisma.user.findFirst({ where: { id, type: 'MEMBER' } });
    if (!user) throw new NotFoundException('Member not found');
    const result = await this.auth.forgotPassword(user.email);
    await this.audit.log({ actor, action: 'password_reset_sent', entityType: 'Member', entityId: id, summary: `Sent password reset to ${user.email}` });
    return { success: true, message: `A password reset code was sent to ${user.email}`, ...('resetCode' in result ? { resetCode: result.resetCode } : {}) };
  }

  async workouts(id: number, page: number, limit: number) {
    const where = { userId: id };
    const [rows, total] = await Promise.all([
      this.prisma.workoutSession.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          program: { select: { id: true, name: true } },
          exercises: {
            orderBy: { sortOrder: 'asc' },
            include: { exercise: { select: { id: true, name: true } }, sets: { orderBy: { setNumber: 'asc' } } },
          },
        },
      }),
      this.prisma.workoutSession.count({ where }),
    ]);
    return paginate(rows, total, page, limit);
  }

  async exportOne(id: number, actor: Actor) {
    const data = await this.get(id);
    const sessions = await this.prisma.workoutSession.findMany({
      where: { userId: id },
      include: { exercises: { include: { sets: true, exercise: { select: { name: true } } } } },
    });
    await this.audit.log({ actor, action: 'export', entityType: 'Member', entityId: id, summary: `Exported personal data for ${data.email}` });
    return { exportedAt: new Date().toISOString(), member: data, workoutSessions: sessions };
  }

  async exportCsv(q: ListQ, actor: Actor) {
    const rows = await this.prisma.user.findMany({ where: this.where(q), include: listInclude, orderBy: { createdAt: 'desc' }, take: 10000 });
    const header = ['id', 'name', 'email', 'status', 'email_verified', 'onboarding_status', 'primary_goal', 'experience', 'weekly_days', 'completed_workouts', 'registered_at', 'last_login_at'];
    const esc = (v: unknown) => {
      const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((u) => {
      const r = this.presentRow(u);
      return [r.id, r.name, r.email, r.status, r.emailVerified, r.onboardingStatus, r.primaryGoal?.name, r.experienceLevel?.name, r.weeklyWorkoutDays, r.completedWorkouts, r.createdAt, r.lastLoginAt]
        .map(esc)
        .join(',');
    });
    await this.audit.log({ actor, action: 'export', entityType: 'Member', summary: `Exported ${rows.length} members to CSV`, after: { filters: q } });
    return [header.join(','), ...lines].join('\n');
  }
}

@ApiTags('Admin · Members')
@ApiBearerAuth()
@Controller('admin/users')
export class MembersController {
  constructor(private readonly service: MembersService) {}

  @RequirePermissions(PERMISSIONS.USERS_VIEW)
  @Get()
  list(@Query(new ZodPipe(ListSchema)) q: ListQ) {
    return this.service.list(q);
  }

  @RequirePermissions(PERMISSIONS.USERS_EXPORT)
  @Get('export')
  async export(@Query(new ZodPipe(ListSchema)) q: ListQ, @CurrentActor() actor: Actor, @Res() res: Response) {
    const csv = await this.service.exportCsv(q, actor);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="members-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }

  @RequirePermissions(PERMISSIONS.USERS_VIEW)
  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.service.get(id);
  }

  @RequirePermissions(PERMISSIONS.USERS_VIEW)
  @Get(':id/workouts')
  workouts(@Param('id', ParseIntPipe) id: number, @Query('page') page = '1', @Query('limit') limit = '10') {
    return this.service.workouts(id, Math.max(1, Number(page) || 1), Math.min(50, Math.max(1, Number(limit) || 10)));
  }

  @RequirePermissions(PERMISSIONS.USERS_VIEW)
  @Get(':id/friends')
  friends(@Param('id', ParseIntPipe) id: number) {
    return this.service.friends(id);
  }

  @RequirePermissions(PERMISSIONS.USERS_EXPORT)
  @Get(':id/export')
  exportOne(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
    return this.service.exportOne(id, actor);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post()
  create(@Body(new ZodPipe(CreateSchema)) body: z.infer<typeof CreateSchema>, @CurrentActor() actor: Actor) {
    return this.service.create(body, actor);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(UpdateSchema)) body: z.infer<typeof UpdateSchema>, @CurrentActor() actor: Actor) {
    return this.service.update(id, body, actor);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Patch(':id/status')
  status(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(StatusSchema)) body: z.infer<typeof StatusSchema>, @CurrentActor() actor: Actor) {
    return this.service.setStatus(id, body.status, body.reason, actor);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @HttpCode(200)
  @Post(':id/force-logout')
  forceLogout(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
    return this.service.forceLogout(id, actor);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @HttpCode(200)
  @Post(':id/reset-password')
  resetPassword(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
    return this.service.sendPasswordReset(id, actor);
  }
}
