import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
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

import { AuthUser, CurrentUser } from '../../common/auth/decorators';
import { zId, ZodPipe } from '../../common/pipes/zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { addDays, paginate, startOfDayUtc } from '../../common/utils/helpers';

const SetFields = {
  reps: z.coerce.number().int().min(0).max(1000).nullish(),
  weightValue: z.coerce.number().min(0).max(2000).nullish(),
  weightUnit: z.enum(['KG', 'LB']).nullish(),
  durationSeconds: z.coerce.number().int().min(0).max(86400).nullish(),
  distanceValue: z.coerce.number().min(0).max(1000).nullish(),
  distanceUnit: z.enum(['KM', 'MI', 'M']).nullish(),
  restSeconds: z.coerce.number().int().min(0).max(3600).nullish(),
  rpe: z.coerce.number().min(1).max(10).nullish(),
  calories: z.coerce.number().int().min(0).max(10000).nullish(),
  caloriesEstimated: z.boolean().optional(),
  notes: z.string().trim().max(500).nullish(),
  completedAt: z.coerce.date().nullish(),
};

const AddSetSchema = z.object({
  sessionExerciseId: zId,
  clientId: z.string().max(64).optional(),
  setNumber: z.coerce.number().int().min(1).max(100).optional(),
  ...SetFields,
});
const UpdateSetSchema = z.object(SetFields).partial();

const StartSchema = z.object({
  clientId: z.string().max(64).optional(),
  title: z.string().trim().max(150).optional(),
  programWorkoutId: zId.optional(),
  templateId: zId.optional(),
  templateDay: z.coerce.number().int().min(1).max(7).optional(),
  exerciseIds: z.array(zId).optional(),
  startedAt: z.coerce.date().optional(),
});

const UpdateSessionSchema = z.object({
  title: z.string().trim().max(150).optional(),
  notes: z.string().trim().max(5000).nullish(),
  action: z.enum(['pause', 'resume']).optional(),
});

const AddExerciseSchema = z.object({ exerciseId: zId, notes: z.string().trim().max(500).nullish() });
const CompleteSchema = z.object({ completedAt: z.coerce.date().optional(), notes: z.string().trim().max(5000).nullish() });

/** Full offline session upload; idempotent on `clientId`. */
const SyncSchema = z.object({
  clientId: z.string().min(8).max(64),
  title: z.string().trim().max(150).optional(),
  programWorkoutId: zId.optional(),
  templateId: zId.optional(),
  startedAt: z.coerce.date(),
  completedAt: z.coerce.date().optional(),
  durationSeconds: z.coerce.number().int().min(0).max(86400).optional(),
  status: z.enum(['COMPLETED', 'DISCARDED', 'ACTIVE', 'PAUSED']).default('COMPLETED'),
  notes: z.string().trim().max(5000).nullish(),
  exercises: z
    .array(
      z.object({
        exerciseId: zId,
        notes: z.string().trim().max(500).nullish(),
        sets: z.array(z.object({ clientId: z.string().max(64).optional(), setNumber: z.coerce.number().int().min(1), ...SetFields })).default([]),
      }),
    )
    .default([]),
});

const ListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'DISCARDED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const sessionInclude = {
  program: { select: { id: true, name: true, slug: true } },
  programWorkout: { select: { id: true, title: true, dayNumber: true } },
  template: { select: { id: true, name: true } },
  exercises: {
    orderBy: { sortOrder: 'asc' },
    include: {
      exercise: {
        select: {
          id: true,
          name: true,
          slug: true,
          imageUrl: true,
          exerciseType: { select: { id: true, name: true, loggingFields: true } },
        },
      },
      sets: { orderBy: { setNumber: 'asc' } },
    },
  },
} satisfies Prisma.WorkoutSessionInclude;

@Injectable()
export class WorkoutsService {
  constructor(private readonly prisma: PrismaService) {}

  private async own(userId: number, id: number) {
    const s = await this.prisma.workoutSession.findFirst({ where: { id, userId } });
    if (!s) throw new NotFoundException('Workout not found');
    return s;
  }

  private assertOpen(s: { status: string }) {
    if (s.status === 'COMPLETED' || s.status === 'DISCARDED') throw new BadRequestException('This workout is already finished');
  }

  get(userId: number, id: number) {
    return this.prisma.workoutSession.findFirstOrThrow({ where: { id, userId }, include: sessionInclude });
  }

  active(userId: number) {
    return this.prisma.workoutSession.findFirst({
      where: { userId, status: { in: ['ACTIVE', 'PAUSED'] } },
      orderBy: { startedAt: 'desc' },
      include: sessionInclude,
    });
  }

  async list(userId: number, q: z.infer<typeof ListSchema>) {
    const where: Prisma.WorkoutSessionWhereInput = {
      userId,
      ...(q.status ? { status: q.status } : { status: { not: 'DISCARDED' } }),
      ...(q.from || q.to ? { startedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.workoutSession.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: sessionInclude,
      }),
      this.prisma.workoutSession.count({ where }),
    ]);
    return paginate(rows, total, q.page, q.limit);
  }

  async start(userId: number, input: z.infer<typeof StartSchema>) {
    if (input.clientId) {
      const existing = await this.prisma.workoutSession.findUnique({ where: { clientId: input.clientId } });
      if (existing && existing.userId === userId) return this.get(userId, existing.id);
    }

    const open = await this.prisma.workoutSession.findFirst({ where: { userId, status: { in: ['ACTIVE', 'PAUSED'] } } });
    if (open) {
      throw new ConflictException({
        message: 'You already have a workout in progress. Finish or discard it first.',
        details: { activeSessionId: open.id },
      });
    }

    let title = input.title;
    let programId: number | undefined;
    let exerciseIds = input.exerciseIds ?? [];

    if (input.programWorkoutId) {
      const pw = await this.prisma.programWorkout.findUnique({
        where: { id: input.programWorkoutId },
        include: { week: true, exercises: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!pw) throw new NotFoundException('Program workout not found');
      programId = pw.week.programId;
      title ??= pw.title;
      if (!input.exerciseIds) exerciseIds = pw.exercises.map((e) => e.exerciseId);
    } else if (input.templateId) {
      const t = await this.prisma.workoutTemplate.findUnique({
        where: { id: input.templateId },
        include: { exercises: { where: { dayNumber: input.templateDay ?? 1 }, orderBy: { sortOrder: 'asc' } } },
      });
      if (!t) throw new NotFoundException('Workout template not found');
      title ??= t.name;
      if (!input.exerciseIds) exerciseIds = t.exercises.map((e) => e.exerciseId);
    }

    const session = await this.prisma.workoutSession.create({
      data: {
        userId,
        clientId: input.clientId,
        title: title ?? 'Workout',
        programId,
        programWorkoutId: input.programWorkoutId,
        templateId: input.templateId,
        startedAt: input.startedAt ?? new Date(),
        exercises: { create: exerciseIds.map((exerciseId, sortOrder) => ({ exerciseId, sortOrder })) },
      },
    });
    return this.get(userId, session.id);
  }

  async update(userId: number, id: number, input: z.infer<typeof UpdateSessionSchema>) {
    const s = await this.own(userId, id);
    this.assertOpen(s);
    const data: Prisma.WorkoutSessionUpdateInput = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
    if (input.action === 'pause' && s.status === 'ACTIVE') {
      Object.assign(data, { status: 'PAUSED', pausedAt: new Date() });
    }
    if (input.action === 'resume' && s.status === 'PAUSED') {
      const paused = s.pausedAt ? Math.round((Date.now() - s.pausedAt.getTime()) / 1000) : 0;
      Object.assign(data, { status: 'ACTIVE', pausedAt: null, pausedSeconds: s.pausedSeconds + paused });
    }
    await this.prisma.workoutSession.update({ where: { id }, data });
    return this.get(userId, id);
  }

  async addExercise(userId: number, id: number, input: z.infer<typeof AddExerciseSchema>) {
    const s = await this.own(userId, id);
    this.assertOpen(s);
    const ex = await this.prisma.exercise.findUnique({ where: { id: input.exerciseId }, select: { id: true } });
    if (!ex) throw new NotFoundException('Exercise not found');
    const count = await this.prisma.workoutSessionExercise.count({ where: { sessionId: id } });
    await this.prisma.workoutSessionExercise.create({ data: { sessionId: id, exerciseId: input.exerciseId, notes: input.notes, sortOrder: count } });
    return this.get(userId, id);
  }

  async removeExercise(userId: number, id: number, sessionExerciseId: number) {
    const s = await this.own(userId, id);
    this.assertOpen(s);
    await this.prisma.workoutSessionExercise.deleteMany({ where: { id: sessionExerciseId, sessionId: id } });
    return this.get(userId, id);
  }

  async addSet(userId: number, id: number, input: z.infer<typeof AddSetSchema>) {
    const s = await this.own(userId, id);
    this.assertOpen(s);
    const se = await this.prisma.workoutSessionExercise.findFirst({ where: { id: input.sessionExerciseId, sessionId: id } });
    if (!se) throw new NotFoundException('Exercise is not part of this workout');

    // Idempotent on clientId so retried requests never duplicate a set.
    if (input.clientId) {
      const dup = await this.prisma.workoutSet.findUnique({ where: { clientId: input.clientId } });
      if (dup) return dup;
    }
    const setNumber = input.setNumber ?? (await this.prisma.workoutSet.count({ where: { sessionExerciseId: se.id } })) + 1;
    const { sessionExerciseId, ...data } = input;
    return this.prisma.workoutSet.create({
      data: { ...data, sessionExerciseId, setNumber, completedAt: input.completedAt ?? new Date() },
    });
  }

  private async ownSet(userId: number, setId: number) {
    const set = await this.prisma.workoutSet.findFirst({
      where: { id: setId, sessionExercise: { session: { userId } } },
      include: { sessionExercise: { include: { session: true } } },
    });
    if (!set) throw new NotFoundException('Set not found');
    return set;
  }

  async updateSet(userId: number, setId: number, input: z.infer<typeof UpdateSetSchema>) {
    await this.ownSet(userId, setId);
    return this.prisma.workoutSet.update({ where: { id: setId }, data: input });
  }

  async deleteSet(userId: number, setId: number) {
    const set = await this.ownSet(userId, setId);
    this.assertOpen(set.sessionExercise.session);
    await this.prisma.workoutSet.delete({ where: { id: setId } });
    return { success: true };
  }

  /** Advances the member's program enrollment after a program workout. */
  private async advanceEnrollment(tx: Prisma.TransactionClient, userId: number, programWorkoutId: number) {
    const pw = await tx.programWorkout.findUnique({ where: { id: programWorkoutId }, include: { week: true } });
    if (!pw) return;
    const enrollment = await tx.programEnrollment.findFirst({ where: { userId, programId: pw.week.programId, status: 'ACTIVE' } });
    if (!enrollment) return;

    const next = await tx.programWorkout.findFirst({
      where: {
        week: { programId: pw.week.programId },
        OR: [
          { week: { weekNumber: pw.week.weekNumber }, dayNumber: { gt: pw.dayNumber } },
          { week: { weekNumber: { gt: pw.week.weekNumber } } },
        ],
      },
      orderBy: [{ week: { weekNumber: 'asc' } }, { dayNumber: 'asc' }],
      include: { week: true },
    });

    await tx.programEnrollment.update({
      where: { id: enrollment.id },
      data: {
        completedWorkouts: { increment: 1 },
        ...(next
          ? { currentWeek: next.week.weekNumber, currentDay: next.dayNumber }
          : { status: 'COMPLETED', completedAt: new Date() }),
      },
    });
  }

  async complete(userId: number, id: number, input: z.infer<typeof CompleteSchema>) {
    const s = await this.own(userId, id);
    if (s.status === 'COMPLETED') return this.get(userId, id); // duplicate submit is a no-op
    this.assertOpen(s);
    const completedAt = input.completedAt ?? new Date();
    const pausedNow = s.status === 'PAUSED' && s.pausedAt ? Math.round((completedAt.getTime() - s.pausedAt.getTime()) / 1000) : 0;
    const duration = Math.max(0, Math.round((completedAt.getTime() - s.startedAt.getTime()) / 1000) - s.pausedSeconds - pausedNow);

    await this.prisma.$transaction(async (tx) => {
      await tx.workoutSession.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          completedAt,
          durationSeconds: duration,
          pausedAt: null,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
      if (s.programWorkoutId) await this.advanceEnrollment(tx, userId, s.programWorkoutId);
    });
    return this.get(userId, id);
  }

  async discard(userId: number, id: number) {
    const s = await this.own(userId, id);
    this.assertOpen(s);
    await this.prisma.workoutSession.update({ where: { id }, data: { status: 'DISCARDED', pausedAt: null } });
    return { success: true };
  }

  async sync(userId: number, input: z.infer<typeof SyncSchema>) {
    const existing = await this.prisma.workoutSession.findUnique({ where: { clientId: input.clientId } });
    if (existing) {
      if (existing.userId !== userId) throw new ConflictException('Duplicate client id');
      return { duplicate: true, session: await this.get(userId, existing.id) };
    }

    let programId: number | undefined;
    if (input.programWorkoutId) {
      const pw = await this.prisma.programWorkout.findUnique({ where: { id: input.programWorkoutId }, include: { week: true } });
      programId = pw?.week.programId;
    }
    const duration =
      input.durationSeconds ??
      (input.completedAt ? Math.max(0, Math.round((input.completedAt.getTime() - input.startedAt.getTime()) / 1000)) : null);

    const id = await this.prisma.$transaction(async (tx) => {
      const session = await tx.workoutSession.create({
        data: {
          userId,
          clientId: input.clientId,
          title: input.title ?? 'Workout',
          programId,
          programWorkoutId: input.programWorkoutId,
          templateId: input.templateId,
          status: input.status,
          startedAt: input.startedAt,
          completedAt: input.status === 'COMPLETED' ? input.completedAt ?? new Date() : null,
          durationSeconds: input.status === 'COMPLETED' ? duration : null,
          notes: input.notes,
        },
      });
      for (const [sortOrder, ex] of input.exercises.entries()) {
        await tx.workoutSessionExercise.create({
          data: {
            sessionId: session.id,
            exerciseId: ex.exerciseId,
            sortOrder,
            notes: ex.notes,
            sets: { create: ex.sets.map((set) => ({ ...set })) },
          },
        });
      }
      if (input.status === 'COMPLETED' && input.programWorkoutId) await this.advanceEnrollment(tx, userId, input.programWorkoutId);
      return session.id;
    });
    return { duplicate: false, session: await this.get(userId, id) };
  }

  async progress(userId: number, period: 'week' | 'month') {
    const today = startOfDayUtc(new Date());
    const from =
      period === 'week'
        ? addDays(today, -((today.getUTCDay() + 6) % 7))
        : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

    const sessions = await this.prisma.workoutSession.findMany({
      where: { userId, status: 'COMPLETED', completedAt: { gte: from } },
      include: { exercises: { include: { sets: true } } },
    });

    const byDay = new Map<string, number>();
    let volume = 0;
    let sets = 0;
    let duration = 0;
    for (const s of sessions) {
      const key = s.completedAt!.toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
      duration += s.durationSeconds ?? 0;
      for (const e of s.exercises) {
        for (const set of e.sets) {
          sets++;
          // volume normalised to kg
          const w = Number(set.weightValue ?? 0) * (set.weightUnit === 'LB' ? 0.45359237 : 1);
          volume += w * (set.reps ?? 0);
        }
      }
    }

    const days: { date: string; workouts: number }[] = [];
    for (let d = from; d <= today; d = addDays(d, 1)) {
      const key = d.toISOString().slice(0, 10);
      days.push({ date: key, workouts: byDay.get(key) ?? 0 });
    }

    const [profile, totalCompleted] = await Promise.all([
      this.prisma.memberProfile.findUnique({ where: { userId } }),
      this.prisma.workoutSession.count({ where: { userId, status: 'COMPLETED' } }),
    ]);
    return {
      period,
      from: from.toISOString(),
      workouts: sessions.length,
      activeDays: byDay.size,
      totalSets: sets,
      totalVolumeKg: Math.round(volume),
      totalDurationSeconds: duration,
      weeklyTarget: profile?.weeklyWorkoutDays ?? null,
      allTimeWorkouts: totalCompleted,
      days,
    };
  }
}

@ApiTags('Workouts')
@ApiBearerAuth()
@Controller()
export class WorkoutsController {
  constructor(private readonly service: WorkoutsService) {}

  @Get('workout-sessions')
  list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(ListSchema)) q: z.infer<typeof ListSchema>) {
    return this.service.list(user.id, q);
  }

  @Get('workout-sessions/active')
  active(@CurrentUser() user: AuthUser) {
    return this.service.active(user.id);
  }

  @Post('workout-sessions')
  start(@CurrentUser() user: AuthUser, @Body(new ZodPipe(StartSchema)) body: z.infer<typeof StartSchema>) {
    return this.service.start(user.id, body);
  }

  @HttpCode(200)
  @Post('workout-sessions/sync')
  sync(@CurrentUser() user: AuthUser, @Body(new ZodPipe(SyncSchema)) body: z.infer<typeof SyncSchema>) {
    return this.service.sync(user.id, body);
  }

  @Get('workout-sessions/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.service.get(user.id, id);
  }

  @Patch('workout-sessions/:id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(UpdateSessionSchema)) body: z.infer<typeof UpdateSessionSchema>) {
    return this.service.update(user.id, id, body);
  }

  @Post('workout-sessions/:id/exercises')
  addExercise(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(AddExerciseSchema)) body: z.infer<typeof AddExerciseSchema>) {
    return this.service.addExercise(user.id, id, body);
  }

  @Delete('workout-sessions/:id/exercises/:sessionExerciseId')
  removeExercise(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Param('sessionExerciseId', ParseIntPipe) seId: number) {
    return this.service.removeExercise(user.id, id, seId);
  }

  @Post('workout-sessions/:id/sets')
  addSet(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(AddSetSchema)) body: z.infer<typeof AddSetSchema>) {
    return this.service.addSet(user.id, id, body);
  }

  @HttpCode(200)
  @Post('workout-sessions/:id/complete')
  complete(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(CompleteSchema)) body: z.infer<typeof CompleteSchema>) {
    return this.service.complete(user.id, id, body);
  }

  @HttpCode(200)
  @Post('workout-sessions/:id/discard')
  discard(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.service.discard(user.id, id);
  }

  @Patch('workout-sets/:id')
  updateSet(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(UpdateSetSchema)) body: z.infer<typeof UpdateSetSchema>) {
    return this.service.updateSet(user.id, id, body);
  }

  @Delete('workout-sets/:id')
  deleteSet(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.service.deleteSet(user.id, id);
  }

  @Get('workout-progress/summary')
  progress(@CurrentUser() user: AuthUser, @Query('period') period?: string) {
    return this.service.progress(user.id, period === 'month' ? 'month' : 'week');
  }
}
