import { Controller, Get, Injectable, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { AuthUser, CurrentUser, OptionalAuth, Public } from '../../common/auth/decorators';
import { zDifficulty, ZodPipe } from '../../common/pipes/zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { paginate } from '../../common/utils/helpers';
import { exerciseCardInclude, exerciseDetailInclude, presentExerciseCard, presentExerciseDetail } from './exercise.presenter';

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined));

export const PublicExerciseQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(100).optional(),
  category: csv,
  focusArea: csv,
  equipment: csv,
  type: csv,
  muscle: csv,
  primaryMuscle: csv,
  secondaryMuscle: csv,
  goal: csv,
  difficulty: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim().toUpperCase()) : undefined))
    .pipe(z.array(zDifficulty).optional()),
  sort: z.enum(['recommended', 'az', 'recent', 'popular']).default('recommended'),
});
type PublicQuery = z.infer<typeof PublicExerciseQuery>;

/** Accepts either numeric ids or slugs in the same filter. */
const bySlugOrId = (values: string[]) => {
  const ids = values.filter((v) => /^\d+$/.test(v)).map(Number);
  const slugs = values.filter((v) => !/^\d+$/.test(v));
  return { OR: [...(ids.length ? [{ id: { in: ids } }] : []), ...(slugs.length ? [{ slug: { in: slugs } }] : [])] };
};

@Injectable()
export class ExercisesPublicService {
  constructor(private readonly prisma: PrismaService) {}

  async savedIds(userId: number | undefined, ids: number[]) {
    if (!userId || !ids.length) return new Set<number>();
    const rows = await this.prisma.savedExercise.findMany({
      where: { userId, exerciseId: { in: ids } },
      select: { exerciseId: true },
    });
    return new Set(rows.map((r) => r.exerciseId));
  }

  async list(q: PublicQuery, userId?: number) {
    const where: Prisma.ExerciseWhereInput = {
      status: 'PUBLISHED',
      ...(q.search
        ? { OR: [{ name: { contains: q.search } }, { shortDescription: { contains: q.search } }] }
        : {}),
      ...(q.difficulty ? { difficulty: { in: q.difficulty } } : {}),
      ...(q.type ? { exerciseType: bySlugOrId(q.type) } : {}),
      AND: [
        ...(q.category ? [{ categories: { some: { category: bySlugOrId(q.category) } } }] : []),
        ...(q.focusArea ? [{ focusAreas: { some: { focusArea: bySlugOrId(q.focusArea) } } }] : []),
        ...(q.equipment ? [{ equipment: { some: { equipment: bySlugOrId(q.equipment) } } }] : []),
        ...(q.goal ? [{ goals: { some: { goal: bySlugOrId(q.goal) } } }] : []),
        ...(q.muscle ? [{ muscles: { some: { muscle: bySlugOrId(q.muscle) } } }] : []),
        ...(q.primaryMuscle ? [{ muscles: { some: { role: 'PRIMARY' as const, muscle: bySlugOrId(q.primaryMuscle) } } }] : []),
        ...(q.secondaryMuscle
          ? [{ muscles: { some: { role: 'SECONDARY' as const, muscle: bySlugOrId(q.secondaryMuscle) } } }]
          : []),
      ],
    };

    const sort: Prisma.ExerciseOrderByWithRelationInput[] =
      q.sort === 'az'
        ? [{ name: 'asc' }]
        : q.sort === 'recent'
          ? [{ publishedAt: 'desc' }, { id: 'desc' }]
          : q.sort === 'popular'
            ? [{ saved: { _count: 'desc' } }, { viewCount: 'desc' }]
            : [{ viewCount: 'desc' }, { name: 'asc' }];

    const [rows, total] = await Promise.all([
      this.prisma.exercise.findMany({
        where,
        include: exerciseCardInclude,
        orderBy: sort,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.exercise.count({ where }),
    ]);

    const saved = await this.savedIds(userId, rows.map((r) => r.id));
    return paginate(
      rows.map((r) => ({ ...presentExerciseCard(r), isSaved: saved.has(r.id) })),
      total,
      q.page,
      q.limit,
    );
  }

  private async findPublicOrSaved(idOrSlug: string, userId?: number) {
    const where = /^\d+$/.test(idOrSlug) ? { id: Number(idOrSlug) } : { slug: idOrSlug };
    const row = await this.prisma.exercise.findUnique({ where, include: exerciseDetailInclude });
    if (!row) throw new NotFoundException('Exercise not found');

    if (row.status !== 'PUBLISHED') {
      // Saved or previously logged content stays reachable, flagged as unavailable.
      const owned =
        userId &&
        ((await this.prisma.savedExercise.count({ where: { userId, exerciseId: row.id } })) ||
          (await this.prisma.workoutSessionExercise.count({ where: { exerciseId: row.id, session: { userId } } })));
      if (!owned) throw new NotFoundException('Exercise not found');
    }
    return row;
  }

  async detail(idOrSlug: string, userId?: number) {
    const row = await this.findPublicOrSaved(idOrSlug, userId);

    await this.prisma.$transaction([
      this.prisma.exercise.update({ where: { id: row.id }, data: { viewCount: { increment: 1 } } }),
      this.prisma.exerciseView.create({ data: { exerciseId: row.id, userId: userId ?? null } }),
    ]);

    const saved = await this.savedIds(userId, [row.id]);
    const detail = presentExerciseDetail(row);
    return {
      ...detail,
      alternatives: detail.alternatives.filter((a) => a.status === 'PUBLISHED'),
      isSaved: saved.has(row.id),
      isAvailable: row.status === 'PUBLISHED',
      createdBy: undefined,
      updatedBy: undefined,
    };
  }

  async history(idOrSlug: string, userId: number) {
    const row = await this.findPublicOrSaved(idOrSlug, userId);
    const entries = await this.prisma.workoutSessionExercise.findMany({
      where: { exerciseId: row.id, session: { userId, status: 'COMPLETED' } },
      include: {
        session: { select: { id: true, title: true, startedAt: true, completedAt: true } },
        sets: { orderBy: { setNumber: 'asc' } },
      },
      orderBy: { session: { startedAt: 'desc' } },
      take: 100,
    });

    const logs = entries.map((e) => ({
      sessionId: e.session.id,
      title: e.session.title,
      date: e.session.completedAt ?? e.session.startedAt,
      notes: e.notes,
      sets: e.sets,
    }));

    // Best set per session (heaviest weight, else most reps / longest duration) for progress chart.
    const progress = logs
      .map((l) => {
        const best = l.sets.reduce<{ weight: number; reps: number; duration: number }>(
          (acc, s) => ({
            weight: Math.max(acc.weight, Number(s.weightValue ?? 0)),
            reps: Math.max(acc.reps, s.reps ?? 0),
            duration: Math.max(acc.duration, s.durationSeconds ?? 0),
          }),
          { weight: 0, reps: 0, duration: 0 },
        );
        const volume = l.sets.reduce((sum, s) => sum + Number(s.weightValue ?? 0) * (s.reps ?? 0), 0);
        return { date: l.date, ...best, volume };
      })
      .reverse();

    return { exerciseId: row.id, logs, progress };
  }

  async programs(idOrSlug: string) {
    const where = /^\d+$/.test(idOrSlug) ? { id: Number(idOrSlug) } : { slug: idOrSlug };
    const row = await this.prisma.exercise.findUnique({ where, select: { id: true } });
    if (!row) throw new NotFoundException('Exercise not found');
    return this.prisma.program.findMany({
      where: {
        status: 'PUBLISHED',
        weeks: { some: { workouts: { some: { exercises: { some: { exerciseId: row.id } } } } } },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        imageUrl: true,
        difficulty: true,
        durationWeeks: true,
        daysPerWeek: true,
        goal: { select: { id: true, name: true } },
      },
      take: 20,
    });
  }
}

@ApiTags('Discovery')
@Controller('exercises')
export class ExercisesPublicController {
  constructor(private readonly service: ExercisesPublicService) {}

  @OptionalAuth()
  @Public()
  @Get()
  list(@Query(new ZodPipe(PublicExerciseQuery)) q: PublicQuery, @CurrentUser() user?: AuthUser) {
    return this.service.list(q, user?.id);
  }

  @OptionalAuth()
  @Public()
  @Get(':idOrSlug')
  detail(@Param('idOrSlug') idOrSlug: string, @CurrentUser() user?: AuthUser) {
    return this.service.detail(idOrSlug, user?.id);
  }

  @ApiBearerAuth()
  @Get(':idOrSlug/history')
  history(@Param('idOrSlug') idOrSlug: string, @CurrentUser() user: AuthUser) {
    return this.service.history(idOrSlug, user.id);
  }

  @Public()
  @Get(':idOrSlug/programs')
  programs(@Param('idOrSlug') idOrSlug: string) {
    return this.service.programs(idOrSlug);
  }
}
