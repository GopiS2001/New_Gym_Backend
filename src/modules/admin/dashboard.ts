import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { RequirePermissions } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import { zId, ZodPipe } from '../../common/pipes/zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { addDays, startOfDayUtc } from '../../common/utils/helpers';

const QuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  goalId: zId.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
  segment: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']).optional(),
});
type Q = z.infer<typeof QuerySchema>;

/**
 * All figures are computed from live data — there are no demo numbers.
 * Member filters (goal / status / onboarding segment) apply to every
 * member-based metric and chart.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  private range(q: Q) {
    const to = q.to ? addDays(startOfDayUtc(q.to), 1) : addDays(startOfDayUtc(new Date()), 1);
    const from = q.from ? startOfDayUtc(q.from) : addDays(to, -30);
    const span = to.getTime() - from.getTime();
    return { from, to, prevFrom: new Date(from.getTime() - span), prevTo: from };
  }

  private memberWhere(q: Q): Prisma.UserWhereInput {
    return {
      type: 'MEMBER',
      ...(q.status ? { status: q.status } : {}),
      ...(q.goalId ? { goals: { some: { goalId: q.goalId, isPrimary: true } } } : {}),
      ...(q.segment ? { profile: { onboardingStatus: q.segment } } : {}),
    };
  }

  /** SQL fragment restricting `u` (users alias) to the filtered members. */
  private memberSql(q: Q) {
    const parts: Prisma.Sql[] = [Prisma.sql`u.type = 'MEMBER'`];
    if (q.status) parts.push(Prisma.sql`u.status = ${q.status}`);
    if (q.goalId) {
      parts.push(Prisma.sql`EXISTS (SELECT 1 FROM member_goals mg WHERE mg.user_id = u.id AND mg.goal_id = ${q.goalId} AND mg.is_primary = 1)`);
    }
    if (q.segment) {
      parts.push(Prisma.sql`EXISTS (SELECT 1 FROM member_profiles mp WHERE mp.user_id = u.id AND mp.onboarding_status = ${q.segment})`);
    }
    return Prisma.join(parts, ' AND ');
  }

  private pct(curr: number, prev: number) {
    if (!prev) return curr ? 100 : 0;
    return Math.round(((curr - prev) / prev) * 1000) / 10;
  }

  private fillDays(from: Date, to: Date, rows: { day: Date | string; count: bigint | number }[]) {
    const map = new Map(rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), Number(r.count)]));
    const out: { date: string; count: number }[] = [];
    for (let d = new Date(from); d < to; d = addDays(d, 1)) {
      const key = d.toISOString().slice(0, 10);
      out.push({ date: key, count: map.get(key) ?? 0 });
    }
    return out;
  }

  async summary(q: Q) {
    const { from, to, prevFrom, prevTo } = this.range(q);
    const members = this.memberWhere(q);
    const mSql = this.memberSql(q);

    const [
      totalMembers,
      newMembers,
      prevNewMembers,
      workouts,
      prevWorkouts,
      activeRows,
      prevActiveRows,
      publishedPrograms,
      activeEnrollments,
      publishedExercises,
      draftExercises,
    ] = await Promise.all([
      this.prisma.user.count({ where: members }),
      this.prisma.user.count({ where: { ...members, createdAt: { gte: from, lt: to } } }),
      this.prisma.user.count({ where: { ...members, createdAt: { gte: prevFrom, lt: prevTo } } }),
      this.prisma.workoutSession.count({ where: { status: 'COMPLETED', completedAt: { gte: from, lt: to }, user: members } }),
      this.prisma.workoutSession.count({ where: { status: 'COMPLETED', completedAt: { gte: prevFrom, lt: prevTo }, user: members } }),
      this.prisma.workoutSession.groupBy({ by: ['userId'], where: { status: 'COMPLETED', completedAt: { gte: from, lt: to }, user: members } }),
      this.prisma.workoutSession.groupBy({ by: ['userId'], where: { status: 'COMPLETED', completedAt: { gte: prevFrom, lt: prevTo }, user: members } }),
      this.prisma.program.count({ where: { status: 'PUBLISHED' } }),
      this.prisma.programEnrollment.count({ where: { status: 'ACTIVE', user: members } }),
      this.prisma.exercise.count({ where: { status: 'PUBLISHED' } }),
      this.prisma.exercise.count({ where: { status: 'DRAFT' } }),
    ]);

    const [registrationsDaily, workoutsDaily, goalDistribution, popularCategories, topExercises, topPrograms] =
      await Promise.all([
        this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
          SELECT DATE(u.created_at) AS day, COUNT(*) AS count
          FROM users u
          WHERE ${mSql} AND u.created_at >= ${from} AND u.created_at < ${to}
          GROUP BY DATE(u.created_at) ORDER BY day`,
        this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
          SELECT DATE(s.completed_at) AS day, COUNT(*) AS count
          FROM workout_sessions s JOIN users u ON u.id = s.user_id
          WHERE ${mSql} AND s.status = 'COMPLETED' AND s.completed_at >= ${from} AND s.completed_at < ${to}
          GROUP BY DATE(s.completed_at) ORDER BY day`,
        this.prisma.$queryRaw<{ id: number; name: string; count: bigint }[]>`
          SELECT g.id, g.name, COUNT(mg.user_id) AS count
          FROM goals g
          LEFT JOIN member_goals mg ON mg.goal_id = g.id AND mg.is_primary = 1
            AND EXISTS (SELECT 1 FROM users u WHERE u.id = mg.user_id AND ${mSql})
          GROUP BY g.id, g.name ORDER BY count DESC, g.sort_order`,
        this.prisma.$queryRaw<{ id: number; name: string; views: bigint; saves: bigint }[]>`
          SELECT c.id, c.name,
            (SELECT COUNT(*) FROM exercise_views v JOIN exercise_category_links l2 ON l2.exercise_id = v.exercise_id
              WHERE l2.category_id = c.id AND v.viewed_at >= ${from} AND v.viewed_at < ${to}) AS views,
            (SELECT COUNT(*) FROM saved_exercises se JOIN exercise_category_links l3 ON l3.exercise_id = se.exercise_id
              WHERE l3.category_id = c.id AND se.created_at >= ${from} AND se.created_at < ${to}) AS saves
          FROM exercise_categories c
          WHERE c.status = 'ACTIVE'
          ORDER BY views DESC, saves DESC, c.sort_order LIMIT 10`,
        this.prisma.$queryRaw<{ id: number; name: string; imageUrl: string | null; views: bigint }[]>`
          SELECT e.id, e.name, e.image_url AS imageUrl, COUNT(v.id) AS views
          FROM exercise_views v JOIN exercises e ON e.id = v.exercise_id
          WHERE v.viewed_at >= ${from} AND v.viewed_at < ${to}
          GROUP BY e.id, e.name, e.image_url ORDER BY views DESC LIMIT 5`,
        this.prisma.$queryRaw<{ id: number; name: string; imageUrl: string | null; enrollments: bigint; completed: bigint }[]>`
          SELECT p.id, p.name, p.image_url AS imageUrl,
            COUNT(pe.id) AS enrollments,
            SUM(CASE WHEN pe.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
          FROM program_enrollments pe JOIN programs p ON p.id = pe.program_id
            JOIN users u ON u.id = pe.user_id
          WHERE ${mSql} AND pe.started_at >= ${from} AND pe.started_at < ${to}
          GROUP BY p.id, p.name, p.image_url ORDER BY enrollments DESC LIMIT 5`,
      ]);

    // Health ratios (all-time, filtered by the member segment)
    const [onboardingGroups, enrollmentGroups, exerciseGroups, mediaCount, coachCount] = await Promise.all([
      this.prisma.memberProfile.groupBy({ by: ['onboardingStatus'], where: { user: members }, _count: { _all: true } }),
      this.prisma.programEnrollment.groupBy({ by: ['status'], where: { user: members }, _count: { _all: true } }),
      this.prisma.exercise.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.mediaAsset.count(),
      this.prisma.coach.count({ where: { status: 'PUBLISHED' } }),
    ]);
    const toMap = (rows: { _count: { _all: number } }[], key: string) =>
      Object.fromEntries(rows.map((r: any) => [r[key], r._count._all])) as Record<string, number>;

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      health: {
        onboarding: toMap(onboardingGroups, 'onboardingStatus'),
        enrollments: toMap(enrollmentGroups, 'status'),
        exercises: toMap(exerciseGroups, 'status'),
        mediaAssets: mediaCount,
        publishedCoaches: coachCount,
      },
      kpis: {
        totalMembers,
        activeMembers: { value: activeRows.length, change: this.pct(activeRows.length, prevActiveRows.length) },
        newRegistrations: { value: newMembers, change: this.pct(newMembers, prevNewMembers) },
        workoutsLogged: { value: workouts, change: this.pct(workouts, prevWorkouts) },
        activePrograms: publishedPrograms,
        activeEnrollments,
        totalExercises: publishedExercises,
        draftExercises,
      },
      mostViewedExercises: topExercises.map((r) => ({ ...r, views: Number(r.views) })),
      mostFollowedPrograms: topPrograms.map((r) => ({ ...r, enrollments: Number(r.enrollments), completed: Number(r.completed ?? 0) })),
      charts: {
        registrations: this.fillDays(from, to, registrationsDaily),
        workouts: this.fillDays(from, to, workoutsDaily),
        goalDistribution: goalDistribution.map((r) => ({ ...r, count: Number(r.count) })),
        popularCategories: popularCategories.map((r) => ({ ...r, views: Number(r.views), saves: Number(r.saves) })),
      },
    };
  }
}

@ApiTags('Admin · Dashboard')
@ApiBearerAuth()
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @RequirePermissions(PERMISSIONS.DASHBOARD_VIEW)
  @Get('summary')
  summary(@Query(new ZodPipe(QuerySchema)) q: Q) {
    return this.service.summary(q);
  }
}
