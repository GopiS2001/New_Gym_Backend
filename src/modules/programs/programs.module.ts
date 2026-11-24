import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ContentStatus, Prisma } from '@prisma/client';
import { z } from 'zod';

import { AuditService } from '../../common/audit/audit.service';
import { Actor, AuthUser, CurrentActor, CurrentUser, OptionalAuth, Public, RequirePermissions } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import {
  zContentStatus,
  zCsvIds,
  zDifficulty,
  zId,
  zIdArray,
  zListQuery,
  zOptionalText,
  zSlug,
  zUrl,
  ZodPipe,
} from '../../common/pipes/zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { orderBy, paginate, uniqueSlug } from '../../common/utils/helpers';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ProgramExerciseSchema = z.object({
  id: zId.optional(),
  exerciseId: zId,
  sets: z.coerce.number().int().min(0).max(100).nullish(),
  reps: zOptionalText(20),
  durationSeconds: z.coerce.number().int().min(0).max(86400).nullish(),
  restSeconds: z.coerce.number().int().min(0).max(3600).nullish(),
  notes: zOptionalText(500),
});

const ProgramWorkoutSchema = z.object({
  id: zId.optional(),
  dayNumber: z.coerce.number().int().min(1).max(7),
  title: z.string().trim().min(1, 'Workout title is required').max(150),
  description: zOptionalText(5000),
  estimatedMinutes: z.coerce.number().int().min(0).max(600).nullish(),
  exercises: z.array(ProgramExerciseSchema).default([]),
});

const ProgramWeekSchema = z.object({
  id: zId.optional(),
  weekNumber: z.coerce.number().int().min(1).max(104),
  title: zOptionalText(150),
  notes: zOptionalText(5000),
  workouts: z.array(ProgramWorkoutSchema).default([]),
});

export const ProgramSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(150),
  slug: zSlug,
  shortDescription: zOptionalText(255),
  description: zOptionalText(20000),
  imageUrl: zUrl,
  goalId: zId.nullish(),
  coachId: zId.nullish(),
  difficulty: zDifficulty.default('BEGINNER'),
  durationWeeks: z.coerce.number().int().min(1).max(104).default(4),
  daysPerWeek: z.coerce.number().int().min(1).max(7).default(3),
  targetAudience: zOptionalText(255),
  minExperienceRank: z.coerce.number().int().min(0).max(100).nullish(),
  maxExperienceRank: z.coerce.number().int().min(0).max(100).nullish(),
  status: zContentStatus.default('DRAFT'),
  equipmentIds: zIdArray,
  weeks: z.array(ProgramWeekSchema).optional(),
});
type ProgramInput = z.infer<typeof ProgramSchema>;
type WeekInput = z.infer<typeof ProgramWeekSchema>;

const AdminListSchema = zListQuery.extend({
  status: zContentStatus.optional(),
  difficulty: zDifficulty.optional(),
  goalId: zCsvIds,
  coachId: zCsvIds,
});

const StatusSchema = z.object({ status: zContentStatus });

const PublicListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(100).optional(),
  goal: z.string().optional(),
  coach: z.string().optional(),
  difficulty: zDifficulty.optional(),
  daysPerWeek: z.coerce.number().int().min(1).max(7).optional(),
  sort: z.enum(['recommended', 'recent', 'popular', 'az']).default('recommended'),
});

const EnrollmentUpdateSchema = z.object({
  status: z.enum(['ACTIVE', 'COMPLETED', 'ABANDONED']).optional(),
  currentWeek: z.coerce.number().int().min(1).optional(),
  currentDay: z.coerce.number().int().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Shared includes
// ---------------------------------------------------------------------------

const scheduleInclude = {
  weeks: {
    orderBy: { weekNumber: 'asc' },
    include: {
      workouts: {
        orderBy: { dayNumber: 'asc' },
        include: {
          exercises: {
            orderBy: { sortOrder: 'asc' },
            include: {
              exercise: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                  imageUrl: true,
                  videoUrl: true,
                  difficulty: true,
                  status: true,
                  exerciseType: { select: { id: true, name: true, loggingFields: true } },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ProgramInclude;

const cardInclude = {
  goal: { select: { id: true, name: true, slug: true } },
  coach: { select: { id: true, name: true, slug: true, imageUrl: true } },
  equipment: { include: { equipment: { select: { id: true, name: true, slug: true } } } },
  _count: { select: { enrollments: true, saved: true } },
} satisfies Prisma.ProgramInclude;

type CardRow = Prisma.ProgramGetPayload<{ include: typeof cardInclude }>;

function presentCard(row: CardRow) {
  const { equipment, _count, ...rest } = row;
  return {
    ...rest,
    equipment: equipment.map((e) => e.equipment),
    enrollmentCount: _count.enrollments,
    saveCount: _count.saved,
  };
}

// ---------------------------------------------------------------------------
// Admin service
// ---------------------------------------------------------------------------

@Injectable()
export class ProgramsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: z.infer<typeof AdminListSchema>) {
    const where: Prisma.ProgramWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.difficulty ? { difficulty: q.difficulty } : {}),
      ...(q.goalId ? { goalId: { in: q.goalId } } : {}),
      ...(q.coachId ? { coachId: { in: q.coachId } } : {}),
      ...(q.search ? { name: { contains: q.search } } : {}),
    };
    const [rows, total, counts] = await Promise.all([
      this.prisma.program.findMany({
        where,
        include: cardInclude,
        orderBy: [
          orderBy(q.sortBy, q.sortOrder, ['name', 'createdAt', 'updatedAt', 'difficulty', 'durationWeeks', 'status'], {
            updatedAt: 'desc',
          }),
          { id: 'desc' },
        ],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.program.count({ where }),
      this.prisma.program.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return {
      ...paginate(rows.map(presentCard), total, q.page, q.limit),
      statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    };
  }

  async get(id: number) {
    const row = await this.prisma.program.findUnique({
      where: { id },
      include: { ...cardInclude, ...scheduleInclude },
    });
    if (!row) throw new NotFoundException('Program not found');
    const { weeks, ...card } = row;
    return { ...presentCard(card as CardRow), weeks };
  }

  private async validate(input: Partial<ProgramInput>) {
    if (input.minExperienceRank != null && input.maxExperienceRank != null && input.minExperienceRank > input.maxExperienceRank) {
      throw new BadRequestException('Minimum experience cannot be higher than maximum experience');
    }
    if (input.weeks) {
      const nums = input.weeks.map((w) => w.weekNumber);
      if (new Set(nums).size !== nums.length) throw new BadRequestException('Week numbers must be unique');
      if (input.durationWeeks && Math.max(0, ...nums) > input.durationWeeks) {
        throw new BadRequestException('A week number exceeds the program duration');
      }
    }
    if (input.status === 'PUBLISHED') {
      const workouts = input.weeks?.flatMap((w) => w.workouts) ?? [];
      if (!workouts.length || workouts.every((w) => !w.exercises.length)) {
        throw new BadRequestException('Add at least one workout with exercises before publishing');
      }
      const ids = [...new Set(workouts.flatMap((w) => w.exercises.map((e) => e.exerciseId)))];
      const unpublished = await this.prisma.exercise.findMany({
        where: { id: { in: ids }, status: { not: 'PUBLISHED' } },
        select: { name: true },
      });
      if (unpublished.length) {
        throw new BadRequestException(
          `These exercises are not published: ${unpublished.map((e) => e.name).join(', ')}`,
        );
      }
    }
  }

  /** Synchronises the week → workout → exercise tree, preserving ids where given. */
  private async syncSchedule(tx: Prisma.TransactionClient, programId: number, weeks: WeekInput[]) {
    const existingWeeks = await tx.programWeek.findMany({
      where: { programId },
      include: { workouts: { include: { exercises: { select: { id: true } } } } },
    });
    const keepWeekIds = new Set(weeks.filter((w) => w.id).map((w) => w.id!));

    await tx.programWeek.deleteMany({ where: { programId, id: { notIn: [...keepWeekIds] } } });
    // Temporarily move kept weeks out of the way so week numbers can be swapped.
    for (const w of existingWeeks.filter((w) => keepWeekIds.has(w.id))) {
      await tx.programWeek.update({ where: { id: w.id }, data: { weekNumber: -w.id } });
    }

    for (const week of weeks) {
      const existing = existingWeeks.find((w) => w.id === week.id);
      const weekRow = existing
        ? await tx.programWeek.update({
            where: { id: existing.id },
            data: { weekNumber: week.weekNumber, title: week.title, notes: week.notes },
          })
        : await tx.programWeek.create({
            data: { programId, weekNumber: week.weekNumber, title: week.title, notes: week.notes },
          });

      const existingWorkouts = existing?.workouts ?? [];
      const keepWorkoutIds = week.workouts.filter((w) => w.id).map((w) => w.id!);
      await tx.programWorkout.deleteMany({ where: { programWeekId: weekRow.id, id: { notIn: keepWorkoutIds } } });

      for (const workout of week.workouts) {
        const prev = existingWorkouts.find((w) => w.id === workout.id);
        const data = {
          dayNumber: workout.dayNumber,
          title: workout.title,
          description: workout.description,
          estimatedMinutes: workout.estimatedMinutes ?? null,
        };
        const workoutRow = prev
          ? await tx.programWorkout.update({ where: { id: prev.id }, data })
          : await tx.programWorkout.create({ data: { ...data, programWeekId: weekRow.id } });

        const keepExerciseIds = workout.exercises.filter((e) => e.id).map((e) => e.id!);
        await tx.programWorkoutExercise.deleteMany({ where: { workoutId: workoutRow.id, id: { notIn: keepExerciseIds } } });

        for (const [sortOrder, ex] of workout.exercises.entries()) {
          const exData = {
            exerciseId: ex.exerciseId,
            sortOrder,
            sets: ex.sets ?? null,
            reps: ex.reps ?? null,
            durationSeconds: ex.durationSeconds ?? null,
            restSeconds: ex.restSeconds ?? null,
            notes: ex.notes ?? null,
          };
          const owned = prev?.exercises.some((e) => e.id === ex.id);
          if (ex.id && owned) {
            await tx.programWorkoutExercise.update({ where: { id: ex.id }, data: exData });
          } else {
            await tx.programWorkoutExercise.create({ data: { ...exData, workoutId: workoutRow.id } });
          }
        }
      }
    }
  }

  private slugFor(source: string, excludeId?: number) {
    return uniqueSlug(source, async (slug) => {
      const hit = await this.prisma.program.findUnique({ where: { slug }, select: { id: true } });
      return !!hit && hit.id !== excludeId;
    });
  }

  private scalars(input: Partial<ProgramInput>) {
    const { weeks: _w, equipmentIds: _e, goalId, coachId, ...rest } = input;
    return {
      ...rest,
      ...(goalId !== undefined ? { goalId } : {}),
      ...(coachId !== undefined ? { coachId } : {}),
    };
  }

  async create(input: ProgramInput, actor: Actor) {
    await this.validate(input);
    const slug = await this.slugFor(input.slug || input.name);
    const id = await this.prisma.$transaction(async (tx) => {
      const program = await tx.program.create({
        data: {
          ...(this.scalars(input) as Prisma.ProgramUncheckedCreateInput),
          slug,
          publishedAt: input.status === 'PUBLISHED' ? new Date() : null,
          equipment: { create: input.equipmentIds.map((equipmentId) => ({ equipmentId })) },
        },
      });
      if (input.weeks) await this.syncSchedule(tx, program.id, input.weeks);
      return program.id;
    });
    const result = await this.get(id);
    await this.audit.log({ actor, action: 'create', entityType: 'Program', entityId: id, summary: `Created program "${result.name}"`, after: result });
    return result;
  }

  async update(id: number, input: Partial<ProgramInput>, actor: Actor) {
    const before = await this.get(id);
    const weeks =
      input.weeks ??
      before.weeks.map((w) => ({
        ...w,
        workouts: w.workouts.map((wo) => ({ ...wo, exercises: wo.exercises.map((e) => ({ ...e })) })),
      }));
    await this.validate({
      durationWeeks: before.durationWeeks,
      status: before.status,
      ...input,
      weeks: weeks as WeekInput[],
    });
    const slug = input.slug || input.name ? await this.slugFor(input.slug || input.name!, id) : undefined;

    await this.prisma.$transaction(async (tx) => {
      await tx.program.update({
        where: { id },
        data: {
          ...(this.scalars(input) as Prisma.ProgramUncheckedUpdateInput),
          ...(slug ? { slug } : {}),
          ...(input.status === 'PUBLISHED' && !before.publishedAt ? { publishedAt: new Date() } : {}),
          ...(input.equipmentIds
            ? { equipment: { deleteMany: {}, create: input.equipmentIds.map((equipmentId) => ({ equipmentId })) } }
            : {}),
        },
      });
      if (input.weeks) await this.syncSchedule(tx, id, input.weeks);
    });

    const result = await this.get(id);
    await this.audit.log({ actor, action: 'update', entityType: 'Program', entityId: id, summary: `Updated program "${result.name}"`, before, after: result });
    return result;
  }

  async setStatus(id: number, status: ContentStatus, actor: Actor) {
    const before = await this.get(id);
    if (status === 'PUBLISHED') {
      await this.validate({
        status,
        weeks: before.weeks.map((w) => ({
          ...w,
          workouts: w.workouts.map((wo) => ({ ...wo, exercises: wo.exercises })),
        })) as unknown as WeekInput[],
      });
    }
    await this.prisma.program.update({
      where: { id },
      data: { status, ...(status === 'PUBLISHED' && !before.publishedAt ? { publishedAt: new Date() } : {}) },
    });
    await this.audit.log({
      actor,
      action: status === 'ARCHIVED' ? 'archive' : status === 'PUBLISHED' ? 'publish' : 'unpublish',
      entityType: 'Program',
      entityId: id,
      summary: `${status} program "${before.name}"`,
      before: { status: before.status },
      after: { status },
    });
    return this.get(id);
  }

  async duplicate(id: number, actor: Actor) {
    const src = await this.get(id);
    return this.create(
      {
        name: `${src.name} (copy)`,
        slug: undefined,
        shortDescription: src.shortDescription,
        description: src.description,
        imageUrl: src.imageUrl,
        goalId: src.goalId,
        coachId: src.coachId,
        difficulty: src.difficulty,
        durationWeeks: src.durationWeeks,
        daysPerWeek: src.daysPerWeek,
        targetAudience: src.targetAudience,
        minExperienceRank: src.minExperienceRank,
        maxExperienceRank: src.maxExperienceRank,
        status: 'DRAFT',
        equipmentIds: src.equipment.map((e) => e.id),
        weeks: src.weeks.map((w) => ({
          weekNumber: w.weekNumber,
          title: w.title,
          notes: w.notes,
          workouts: w.workouts.map((wo) => ({
            dayNumber: wo.dayNumber,
            title: wo.title,
            description: wo.description,
            estimatedMinutes: wo.estimatedMinutes,
            exercises: wo.exercises.map((e) => ({
              exerciseId: e.exerciseId,
              sets: e.sets,
              reps: e.reps,
              durationSeconds: e.durationSeconds,
              restSeconds: e.restSeconds,
              notes: e.notes,
            })),
          })),
        })),
      },
      actor,
    );
  }

  async remove(id: number, actor: Actor) {
    const before = await this.get(id);
    const sessions = await this.prisma.workoutSession.count({ where: { programId: id } });
    if (before.enrollmentCount || before.saveCount || sessions) {
      throw new ConflictException('Members have followed, saved or trained with this program. Archive it instead.');
    }
    await this.prisma.program.delete({ where: { id } });
    await this.audit.log({ actor, action: 'delete', entityType: 'Program', entityId: id, summary: `Deleted program "${before.name}"`, before });
    return { success: true };
  }
}

@ApiTags('Admin · Programs')
@ApiBearerAuth()
@Controller('admin/programs')
export class ProgramsAdminController {
  constructor(private readonly service: ProgramsAdminService) {}

  @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
  @Get()
  list(@Query(new ZodPipe(AdminListSchema)) q: z.infer<typeof AdminListSchema>) {
    return this.service.list(q);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.service.get(id);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Post()
  create(@Body(new ZodPipe(ProgramSchema)) body: ProgramInput, @CurrentActor() actor: Actor) {
    return this.service.create(body, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(ProgramSchema.partial())) body: Partial<ProgramInput>,
    @CurrentActor() actor: Actor,
  ) {
    return this.service.update(id, body, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Patch(':id/status')
  status(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(StatusSchema)) body: z.infer<typeof StatusSchema>,
    @CurrentActor() actor: Actor,
  ) {
    return this.service.setStatus(id, body.status, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Post(':id/duplicate')
  duplicate(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
    return this.service.duplicate(id, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
    return this.service.remove(id, actor);
  }
}

// ---------------------------------------------------------------------------
// Member-facing
// ---------------------------------------------------------------------------

@Injectable()
export class ProgramsPublicService {
  constructor(private readonly prisma: PrismaService) {}

  private where(idOrSlug: string) {
    return /^\d+$/.test(idOrSlug) ? { id: Number(idOrSlug) } : { slug: idOrSlug };
  }

  async list(q: z.infer<typeof PublicListSchema>, userId?: number) {
    const ref = (v?: string) => (v ? (/^\d+$/.test(v) ? { id: Number(v) } : { slug: v }) : undefined);
    const where: Prisma.ProgramWhereInput = {
      status: 'PUBLISHED',
      ...(q.search ? { name: { contains: q.search } } : {}),
      ...(q.goal ? { goal: ref(q.goal) } : {}),
      ...(q.coach ? { coach: ref(q.coach) } : {}),
      ...(q.difficulty ? { difficulty: q.difficulty } : {}),
      ...(q.daysPerWeek ? { daysPerWeek: q.daysPerWeek } : {}),
    };
    const sort: Prisma.ProgramOrderByWithRelationInput[] =
      q.sort === 'az'
        ? [{ name: 'asc' }]
        : q.sort === 'recent'
          ? [{ publishedAt: 'desc' }]
          : [{ enrollments: { _count: 'desc' } }, { publishedAt: 'desc' }];

    const [rows, total] = await Promise.all([
      this.prisma.program.findMany({ where, include: cardInclude, orderBy: sort, skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.program.count({ where }),
    ]);
    const saved = userId
      ? new Set(
          (
            await this.prisma.savedProgram.findMany({
              where: { userId, programId: { in: rows.map((r) => r.id) } },
              select: { programId: true },
            })
          ).map((s) => s.programId),
        )
      : new Set<number>();
    return paginate(rows.map((r) => ({ ...presentCard(r), isSaved: saved.has(r.id) })), total, q.page, q.limit);
  }

  async detail(idOrSlug: string, userId?: number) {
    const row = await this.prisma.program.findUnique({
      where: this.where(idOrSlug),
      include: { ...cardInclude, ...scheduleInclude },
    });
    if (!row) throw new NotFoundException('Program not found');

    const [saved, enrollment] = userId
      ? await Promise.all([
          this.prisma.savedProgram.count({ where: { userId, programId: row.id } }),
          this.prisma.programEnrollment.findFirst({
            where: { userId, programId: row.id },
            orderBy: { startedAt: 'desc' },
          }),
        ])
      : [0, null];

    if (row.status !== 'PUBLISHED' && !saved && !enrollment) throw new NotFoundException('Program not found');

    const { weeks, ...card } = row;
    const totalWorkouts = weeks.reduce((n, w) => n + w.workouts.length, 0);
    return {
      ...presentCard(card as CardRow),
      weeks,
      totalWorkouts,
      isSaved: !!saved,
      isAvailable: row.status === 'PUBLISHED',
      enrollment: enrollment
        ? { ...enrollment, progressPercent: totalWorkouts ? Math.round((enrollment.completedWorkouts / totalWorkouts) * 100) : 0 }
        : null,
    };
  }

  async enroll(idOrSlug: string, userId: number) {
    const program = await this.prisma.program.findUnique({ where: this.where(idOrSlug) });
    if (!program || program.status !== 'PUBLISHED') throw new NotFoundException('Program not found');

    const active = await this.prisma.programEnrollment.findFirst({
      where: { userId, programId: program.id, status: 'ACTIVE' },
    });
    if (active) return active;

    return this.prisma.programEnrollment.create({ data: { userId, programId: program.id } });
  }

  async updateEnrollment(idOrSlug: string, userId: number, input: z.infer<typeof EnrollmentUpdateSchema>) {
    const program = await this.prisma.program.findUnique({ where: this.where(idOrSlug), select: { id: true } });
    if (!program) throw new NotFoundException('Program not found');
    const enrollment = await this.prisma.programEnrollment.findFirst({
      where: { userId, programId: program.id, status: 'ACTIVE' },
    });
    if (!enrollment) throw new NotFoundException('You are not following this program');
    return this.prisma.programEnrollment.update({
      where: { id: enrollment.id },
      data: {
        ...input,
        ...(input.status === 'COMPLETED' ? { completedAt: new Date() } : {}),
      },
    });
  }

  async myPrograms(userId: number) {
    const rows = await this.prisma.programEnrollment.findMany({
      where: { userId },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      include: { program: { include: cardInclude } },
    });
    return rows.map(({ program, ...e }) => ({ ...e, program: presentCard(program) }));
  }
}

@ApiTags('Programs')
@Controller('programs')
export class ProgramsPublicController {
  constructor(private readonly service: ProgramsPublicService) {}

  @Public()
  @OptionalAuth()
  @Get()
  list(@Query(new ZodPipe(PublicListSchema)) q: z.infer<typeof PublicListSchema>, @CurrentUser() user?: AuthUser) {
    return this.service.list(q, user?.id);
  }

  @ApiBearerAuth()
  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.service.myPrograms(user.id);
  }

  @Public()
  @OptionalAuth()
  @Get(':idOrSlug')
  detail(@Param('idOrSlug') idOrSlug: string, @CurrentUser() user?: AuthUser) {
    return this.service.detail(idOrSlug, user?.id);
  }

  @ApiBearerAuth()
  @HttpCode(200)
  @Post(':idOrSlug/enroll')
  enroll(@Param('idOrSlug') idOrSlug: string, @CurrentUser() user: AuthUser) {
    return this.service.enroll(idOrSlug, user.id);
  }

  @ApiBearerAuth()
  @Patch(':idOrSlug/enrollment')
  updateEnrollment(
    @Param('idOrSlug') idOrSlug: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(EnrollmentUpdateSchema)) body: z.infer<typeof EnrollmentUpdateSchema>,
  ) {
    return this.service.updateEnrollment(idOrSlug, user.id, body);
  }
}

@Module({
  controllers: [ProgramsAdminController, ProgramsPublicController],
  providers: [ProgramsAdminService, ProgramsPublicService],
})
export class ProgramsModule {}
