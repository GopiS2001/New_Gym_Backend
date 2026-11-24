import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Post,
  Put,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';

import { AuthUser, CurrentUser, Public } from '../../common/auth/decorators';
import { zId, ZodPipe } from '../../common/pipes/zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { addDays, startOfDayUtc } from '../../common/utils/helpers';
import { exerciseCardInclude, presentExerciseCard } from '../exercises/exercise.presenter';

export const ONBOARDING_VERSION = 1;

const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');

const RemindersSchema = z.object({
  enabled: z.boolean(),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  time: zTime.optional(),
  timezone: z.string().max(64).optional(),
  permissionGranted: z.boolean().nullish(),
});

const WeightSchema = z.object({
  value: z.coerce.number().positive().max(700),
  unit: z.enum(['KG', 'LB']),
});

/** Answers saved step by step; every field optional while in progress. */
export const OnboardingDraftSchema = z.object({
  genderOptionId: zId.nullish(),
  genderCustom: z.string().trim().max(80).nullish(),
  goalId: zId.optional(),
  activityOptionId: zId.optional(),
  focusAreaIds: z.array(zId).optional(),
  motivationOptionIds: z.array(zId).optional(),
  experienceLevelId: zId.optional(),
  weeklyWorkoutDays: z.coerce.number().int().min(1).max(7).optional(),
  reminders: RemindersSchema.optional(),
  equipmentIds: z.array(zId).optional(),
  equipmentGroupIds: z.array(zId).optional(),
  weight: WeightSchema.nullish(),
});
type Draft = z.infer<typeof OnboardingDraftSchema>;

const SaveDraftSchema = z.object({
  step: z.string().max(64).optional(),
  answers: OnboardingDraftSchema.default({}),
});

const ProfileUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  avatarUrl: z.string().trim().max(500).nullish(),
  heightCm: z.coerce.number().min(50).max(272).nullish(),
  preferredWeightUnit: z.enum(['KG', 'LB']).optional(),
  preferredDistanceUnit: z.enum(['KM', 'MI']).optional(),
  timezone: z.string().max(64).optional(),
  genderOptionId: zId.nullish(),
  genderCustom: z.string().trim().max(80).nullish(),
  goalId: zId.optional(),
  activityOptionId: zId.nullish(),
  focusAreaIds: z.array(zId).optional(),
  motivationOptionIds: z.array(zId).optional(),
  experienceLevelId: zId.nullish(),
  weeklyWorkoutDays: z.coerce.number().int().min(1).max(7).nullish(),
  equipmentIds: z.array(zId).optional(),
});

const MeasurementSchema = z.object({
  measurementType: z.enum(['weight', 'body_fat', 'waist', 'chest', 'hips', 'arm', 'thigh']).default('weight'),
  value: z.coerce.number().positive().max(1000),
  unit: z.string().max(10),
  measuredAt: z.coerce.date().optional(),
});

const PushTokenSchema = z.object({ token: z.string().min(10).max(255), platform: z.enum(['ios', 'android', 'web']) });
const DeleteAccountSchema = z.object({ password: z.string().min(1), confirm: z.literal('DELETE') });

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Onboarding
  // -------------------------------------------------------------------------

  /** Everything the onboarding screens need, in one call (works before sign-up). */
  async options() {
    const active = { status: 'ACTIVE' as const };
    const [goals, focusAreas, experienceLevels, equipment, equipmentGroups, options] = await Promise.all([
      this.prisma.goal.findMany({ where: active, orderBy: { sortOrder: 'asc' } }),
      this.prisma.focusArea.findMany({ where: active, orderBy: { sortOrder: 'asc' } }),
      this.prisma.experienceLevel.findMany({ where: active, orderBy: { sortOrder: 'asc' } }),
      this.prisma.equipment.findMany({ where: active, orderBy: { sortOrder: 'asc' } }),
      this.prisma.equipmentGroup.findMany({
        where: active,
        orderBy: { sortOrder: 'asc' },
        include: { items: { select: { equipmentId: true } } },
      }),
      this.prisma.onboardingOption.findMany({ where: active, orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }] }),
    ]);
    return {
      version: ONBOARDING_VERSION,
      goals,
      focusAreas,
      experienceLevels,
      equipment,
      equipmentGroups: equipmentGroups.map(({ items, ...g }) => ({ ...g, equipmentIds: items.map((i) => i.equipmentId) })),
      genders: options.filter((o) => o.group === 'GENDER'),
      activities: options.filter((o) => o.group === 'ACTIVITY'),
      motivations: options.filter((o) => o.group === 'MOTIVATION'),
      weeklyFrequency: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ value: d, label: d === 7 ? 'Every day' : `${d} day${d > 1 ? 's' : ''}` })),
    };
  }

  async getOnboarding(userId: number) {
    const profile = await this.ensureProfile(userId);
    return {
      status: profile.onboardingStatus,
      step: profile.onboardingStep,
      version: profile.onboardingVersion,
      answers: (profile.onboardingDraft as Draft | null) ?? {},
      completedAt: profile.onboardingCompletedAt,
    };
  }

  private ensureProfile(userId: number) {
    return this.prisma.memberProfile.upsert({ where: { userId }, update: {}, create: { userId } });
  }

  async saveDraft(userId: number, input: z.infer<typeof SaveDraftSchema>) {
    const profile = await this.ensureProfile(userId);
    const merged = { ...((profile.onboardingDraft as Draft | null) ?? {}), ...input.answers };
    const updated = await this.prisma.memberProfile.update({
      where: { userId },
      data: {
        onboardingDraft: merged as Prisma.InputJsonValue,
        onboardingStep: input.step ?? profile.onboardingStep,
        onboardingStatus: profile.onboardingStatus === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS',
        onboardingVersion: ONBOARDING_VERSION,
      },
    });
    return { status: updated.onboardingStatus, step: updated.onboardingStep, answers: merged };
  }

  /** Expands equipment groups (e.g. "Full Gym") into individual equipment ids. */
  private async resolveEquipment(equipmentIds: number[] = [], groupIds: number[] = []) {
    if (!groupIds.length) return [...new Set(equipmentIds)];
    const items = await this.prisma.equipmentGroupItem.findMany({ where: { groupId: { in: groupIds } } });
    return [...new Set([...equipmentIds, ...items.map((i) => i.equipmentId)])];
  }

  /** Writes preference relations; shared by onboarding completion and profile edits. */
  private async applyPreferences(tx: Prisma.TransactionClient, userId: number, p: Partial<Draft> & { equipmentIds?: number[] }) {
    if (p.goalId) {
      await tx.memberGoal.deleteMany({ where: { userId } });
      await tx.memberGoal.create({ data: { userId, goalId: p.goalId, isPrimary: true } });
    }
    if (p.focusAreaIds) {
      await tx.memberFocusArea.deleteMany({ where: { userId } });
      if (p.focusAreaIds.length) await tx.memberFocusArea.createMany({ data: p.focusAreaIds.map((focusAreaId) => ({ userId, focusAreaId })) });
    }
    if (p.motivationOptionIds) {
      await tx.memberMotivation.deleteMany({ where: { userId } });
      if (p.motivationOptionIds.length) await tx.memberMotivation.createMany({ data: p.motivationOptionIds.map((optionId) => ({ userId, optionId })) });
    }
    if (p.equipmentIds) {
      await tx.memberEquipment.deleteMany({ where: { userId } });
      if (p.equipmentIds.length) await tx.memberEquipment.createMany({ data: p.equipmentIds.map((equipmentId) => ({ userId, equipmentId })) });
    }
  }

  async setReminders(tx: Prisma.TransactionClient, userId: number, r: z.infer<typeof RemindersSchema>) {
    await tx.notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        enabled: r.enabled,
        preferredTime: r.time ?? null,
        timezone: r.timezone ?? 'UTC',
        permissionAsked: r.permissionGranted != null,
        permissionGranted: r.permissionGranted ?? null,
      },
      update: {
        enabled: r.enabled,
        ...(r.time ? { preferredTime: r.time } : {}),
        ...(r.timezone ? { timezone: r.timezone } : {}),
        ...(r.permissionGranted != null ? { permissionAsked: true, permissionGranted: r.permissionGranted } : {}),
      },
    });
    if (r.days) {
      await tx.notificationDay.deleteMany({ where: { userId } });
      if (r.days.length) await tx.notificationDay.createMany({ data: [...new Set(r.days)].map((dayOfWeek) => ({ userId, dayOfWeek })) });
    }
  }

  async complete(userId: number, extra?: Draft) {
    const profile = await this.ensureProfile(userId);
    const answers: Draft = { ...((profile.onboardingDraft as Draft | null) ?? {}), ...(extra ?? {}) };

    const missing = [
      !answers.goalId && 'goal',
      !answers.focusAreaIds?.length && 'focus areas',
      !answers.experienceLevelId && 'experience',
      !answers.weeklyWorkoutDays && 'weekly workout days',
    ].filter(Boolean);
    if (missing.length) throw new BadRequestException(`Please answer: ${missing.join(', ')}`);

    const equipmentIds = await this.resolveEquipment(answers.equipmentIds, answers.equipmentGroupIds);

    await this.prisma.$transaction(async (tx) => {
      await tx.memberProfile.update({
        where: { userId },
        data: {
          genderOptionId: answers.genderOptionId ?? null,
          genderCustom: answers.genderCustom ?? null,
          activityOptionId: answers.activityOptionId ?? null,
          experienceLevelId: answers.experienceLevelId,
          weeklyWorkoutDays: answers.weeklyWorkoutDays,
          ...(answers.weight ? { preferredWeightUnit: answers.weight.unit } : {}),
          ...(answers.reminders?.timezone ? { timezone: answers.reminders.timezone } : {}),
          onboardingStatus: 'COMPLETED',
          onboardingStep: 'complete',
          onboardingVersion: ONBOARDING_VERSION,
          onboardingCompletedAt: profile.onboardingCompletedAt ?? new Date(),
          onboardingDraft: answers as Prisma.InputJsonValue,
        },
      });
      await this.applyPreferences(tx, userId, { ...answers, equipmentIds });
      if (answers.reminders) await this.setReminders(tx, userId, answers.reminders);
      if (answers.weight) {
        // Measurements are appended as history, never overwritten.
        await tx.bodyMeasurement.create({
          data: { userId, measurementType: 'weight', value: answers.weight.value, unit: answers.weight.unit.toLowerCase() },
        });
      }
    });

    const [goal, focusAreas, recommendedProgram] = await Promise.all([
      this.prisma.goal.findUnique({ where: { id: answers.goalId! }, select: { id: true, name: true, motivationMessage: true } }),
      this.prisma.focusArea.findMany({ where: { id: { in: answers.focusAreaIds! } }, select: { id: true, name: true } }),
      this.recommendedProgram(userId),
    ]);

    return {
      status: 'COMPLETED',
      summary: {
        goal,
        focusAreas,
        weeklyTarget: answers.weeklyWorkoutDays,
        suggestedNextAction: recommendedProgram
          ? { type: 'program', label: `Start ${recommendedProgram.name}`, program: recommendedProgram }
          : { type: 'explore', label: 'Explore exercises for your focus areas' },
      },
    };
  }

  // -------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------

  async getProfile(userId: number) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        profile: { include: { experienceLevel: true, genderOption: true, activityOption: true } },
        goals: { include: { goal: true } },
        focusAreas: { include: { focusArea: true } },
        motivations: { include: { option: true } },
        equipment: { include: { equipment: true } },
        notificationPreference: true,
        notificationDays: true,
        measurements: { where: { measurementType: 'weight' }, orderBy: { measuredAt: 'desc' }, take: 1 },
      },
    });
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl,
      emailVerified: !!u.emailVerifiedAt,
      createdAt: u.createdAt,
      heightCm: u.profile?.heightCm ?? null,
      preferredWeightUnit: u.profile?.preferredWeightUnit ?? 'KG',
      preferredDistanceUnit: u.profile?.preferredDistanceUnit ?? 'KM',
      timezone: u.profile?.timezone ?? 'UTC',
      gender: u.profile?.genderOption ?? null,
      genderCustom: u.profile?.genderCustom ?? null,
      preferredActivity: u.profile?.activityOption ?? null,
      experienceLevel: u.profile?.experienceLevel ?? null,
      weeklyWorkoutDays: u.profile?.weeklyWorkoutDays ?? null,
      onboardingStatus: u.profile?.onboardingStatus ?? 'NOT_STARTED',
      goal: u.goals.find((g) => g.isPrimary)?.goal ?? null,
      focusAreas: u.focusAreas.map((f) => f.focusArea),
      motivations: u.motivations.map((m) => m.option),
      equipment: u.equipment.map((e) => e.equipment),
      latestWeight: u.measurements[0] ?? null,
      reminders: {
        enabled: u.notificationPreference?.enabled ?? false,
        time: u.notificationPreference?.preferredTime ?? null,
        timezone: u.notificationPreference?.timezone ?? 'UTC',
        permissionAsked: u.notificationPreference?.permissionAsked ?? false,
        permissionGranted: u.notificationPreference?.permissionGranted ?? null,
        days: u.notificationDays.map((d) => d.dayOfWeek).sort(),
      },
    };
  }

  async updateProfile(userId: number, input: z.infer<typeof ProfileUpdateSchema>) {
    const { name, avatarUrl, goalId, focusAreaIds, motivationOptionIds, equipmentIds, ...profileFields } = input;
    await this.ensureProfile(userId);
    await this.prisma.$transaction(async (tx) => {
      if (name !== undefined || avatarUrl !== undefined) {
        await tx.user.update({ where: { id: userId }, data: { ...(name ? { name } : {}), ...(avatarUrl !== undefined ? { avatarUrl } : {}) } });
      }
      if (Object.keys(profileFields).length) {
        await tx.memberProfile.update({ where: { userId }, data: profileFields });
      }
      await this.applyPreferences(tx, userId, { goalId, focusAreaIds, motivationOptionIds, equipmentIds });
    });
    return this.getProfile(userId);
  }

  async updateReminders(userId: number, input: z.infer<typeof RemindersSchema>) {
    await this.prisma.$transaction((tx) => this.setReminders(tx, userId, input));
    return (await this.getProfile(userId)).reminders;
  }

  measurements(userId: number, type?: string) {
    return this.prisma.bodyMeasurement.findMany({
      where: { userId, ...(type ? { measurementType: type } : {}) },
      orderBy: { measuredAt: 'desc' },
      take: 365,
    });
  }

  addMeasurement(userId: number, input: z.infer<typeof MeasurementSchema>) {
    return this.prisma.bodyMeasurement.create({ data: { userId, ...input, measuredAt: input.measuredAt ?? new Date() } });
  }

  registerPushToken(userId: number, input: z.infer<typeof PushTokenSchema>) {
    return this.prisma.devicePushToken.upsert({
      where: { token: input.token },
      update: { userId, platform: input.platform },
      create: { userId, ...input },
    });
  }

  async exportData(userId: number) {
    const [profile, sessions, measurements, library] = await Promise.all([
      this.getProfile(userId),
      this.prisma.workoutSession.findMany({ where: { userId }, include: { exercises: { include: { sets: true, exercise: { select: { name: true } } } } } }),
      this.prisma.bodyMeasurement.findMany({ where: { userId } }),
      this.prisma.memberCollection.findMany({ where: { userId }, include: { exercises: true, programs: true } }),
    ]);
    return { exportedAt: new Date().toISOString(), profile, workoutSessions: sessions, measurements, collections: library };
  }

  async deleteAccount(userId: number, password: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(password, user.passwordHash))) throw new BadRequestException('Password is incorrect');
    // Friendships are removed with the account; keep the friends' counts exact.
    const links = await this.prisma.friendship.findMany({ where: { OR: [{ userAId: userId }, { userBId: userId }] } });
    const friendIds = links.map((f) => (f.userAId === userId ? f.userBId : f.userAId));
    await this.prisma.user.delete({ where: { id: userId } });
    for (const id of friendIds) {
      const count = await this.prisma.friendship.count({ where: { OR: [{ userAId: id }, { userBId: id }] } });
      await this.prisma.user.updateMany({ where: { id }, data: { friendCount: count } });
    }
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Recommendations & Home
  // -------------------------------------------------------------------------

  private async context(userId: number) {
    const [profile, goal, focus, equipment] = await Promise.all([
      this.prisma.memberProfile.findUnique({ where: { userId }, include: { experienceLevel: true } }),
      this.prisma.memberGoal.findFirst({ where: { userId, isPrimary: true }, include: { goal: true } }),
      this.prisma.memberFocusArea.findMany({ where: { userId } }),
      this.prisma.memberEquipment.findMany({ where: { userId } }),
    ]);
    return {
      profile,
      goal: goal?.goal ?? null,
      focusAreaIds: focus.map((f) => f.focusAreaId),
      equipmentIds: equipment.map((e) => e.equipmentId),
      rank: profile?.experienceLevel?.rank ?? null,
    };
  }

  async recommendedProgram(userId: number) {
    const ctx = await this.context(userId);
    const candidates = await this.prisma.program.findMany({
      where: {
        status: 'PUBLISHED',
        ...(ctx.goal ? { goalId: ctx.goal.id } : {}),
        enrollments: { none: { userId, status: 'ACTIVE' } },
      },
      include: { equipment: true, goal: { select: { id: true, name: true } }, _count: { select: { enrollments: true } } },
      take: 50,
    });
    const scored = candidates
      .map((p) => {
        let score = p._count.enrollments * 0.01;
        if (ctx.rank != null) {
          if ((p.minExperienceRank ?? 0) <= ctx.rank && (p.maxExperienceRank ?? 100) >= ctx.rank) score += 5;
        }
        if (ctx.profile?.weeklyWorkoutDays && p.daysPerWeek <= ctx.profile.weeklyWorkoutDays) score += 3;
        if (ctx.equipmentIds.length) {
          const missing = p.equipment.filter((e) => !ctx.equipmentIds.includes(e.equipmentId)).length;
          score -= missing * 2;
        }
        return { p, score };
      })
      .sort((a, b) => b.score - a.score);
    const best = scored[0]?.p;
    return best
      ? {
          id: best.id,
          name: best.name,
          slug: best.slug,
          imageUrl: best.imageUrl,
          difficulty: best.difficulty,
          durationWeeks: best.durationWeeks,
          daysPerWeek: best.daysPerWeek,
          goal: best.goal,
        }
      : null;
  }

  async recommendedExercises(userId: number, limit = 10) {
    const ctx = await this.context(userId);
    const where: Prisma.ExerciseWhereInput = {
      status: 'PUBLISHED',
      ...(ctx.focusAreaIds.length ? { focusAreas: { some: { focusAreaId: { in: ctx.focusAreaIds } } } } : {}),
      ...(ctx.equipmentIds.length
        ? { equipment: { every: { equipmentId: { in: ctx.equipmentIds } } } }
        : {}),
    };
    let rows = await this.prisma.exercise.findMany({ where, include: exerciseCardInclude, orderBy: { viewCount: 'desc' }, take: limit });
    if (!rows.length) {
      rows = await this.prisma.exercise.findMany({ where: { status: 'PUBLISHED' }, include: exerciseCardInclude, orderBy: { viewCount: 'desc' }, take: limit });
    }
    return rows.map(presentExerciseCard);
  }

  /** Monday-based week start in UTC. */
  private weekStart(d = new Date()) {
    const day = startOfDayUtc(d);
    const dow = (day.getUTCDay() + 6) % 7;
    return addDays(day, -dow);
  }

  async weeklyProgress(userId: number) {
    const profile = await this.prisma.memberProfile.findUnique({ where: { userId } });
    const start = this.weekStart();
    const sessions = await this.prisma.workoutSession.findMany({
      where: { userId, status: 'COMPLETED', completedAt: { gte: start } },
      select: { completedAt: true },
    });
    const days = [...new Set(sessions.map((s) => s.completedAt!.toISOString().slice(0, 10)))];

    // Streak = consecutive previous weeks (plus this one if met) hitting the weekly target.
    const target = profile?.weeklyWorkoutDays ?? 3;
    let streak = 0;
    for (let w = 0; w < 52; w++) {
      const ws = addDays(start, -7 * w);
      const we = addDays(ws, 7);
      const count = await this.prisma.workoutSession.count({ where: { userId, status: 'COMPLETED', completedAt: { gte: ws, lt: we } } });
      if (count >= target) streak++;
      else if (w > 0) break;
    }

    return { weekStart: start.toISOString(), target, completed: sessions.length, activeDays: days, weekStreak: streak };
  }

  async home(userId: number) {
    const [user, ctx, activeSession, enrollment, weekly, recentViews, savedCount] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, avatarUrl: true } }),
      this.context(userId),
      this.prisma.workoutSession.findFirst({
        where: { userId, status: { in: ['ACTIVE', 'PAUSED'] } },
        orderBy: { startedAt: 'desc' },
        include: { _count: { select: { exercises: true } } },
      }),
      this.prisma.programEnrollment.findFirst({
        where: { userId, status: 'ACTIVE' },
        orderBy: { updatedAt: 'desc' },
        include: { program: { select: { id: true, name: true, slug: true, imageUrl: true, durationWeeks: true } } },
      }),
      this.weeklyProgress(userId),
      this.prisma.exerciseView.findMany({
        where: { userId, exercise: { status: 'PUBLISHED' } },
        orderBy: { viewedAt: 'desc' },
        distinct: ['exerciseId'],
        take: 8,
        include: { exercise: { select: { id: true, name: true, slug: true, imageUrl: true, difficulty: true } } },
      }),
      this.prisma.savedExercise.count({ where: { userId } }),
    ]);

    let todaysWorkout = null;
    if (enrollment) {
      todaysWorkout = await this.prisma.programWorkout.findFirst({
        where: { week: { programId: enrollment.programId, weekNumber: enrollment.currentWeek }, dayNumber: { gte: enrollment.currentDay } },
        orderBy: { dayNumber: 'asc' },
        include: {
          exercises: {
            orderBy: { sortOrder: 'asc' },
            include: { exercise: { select: { id: true, name: true, imageUrl: true } } },
          },
        },
      });
    }

    const [recommendedProgram, recommendedExercises] = await Promise.all([
      this.recommendedProgram(userId),
      this.recommendedExercises(userId, 8),
    ]);

    return {
      greeting: { name: user.name.split(' ')[0], avatarUrl: user.avatarUrl },
      activeSession,
      currentProgram: enrollment,
      todaysWorkout,
      weeklyProgress: weekly,
      recommendedProgram,
      recommendedExercises,
      recentlyViewed: recentViews.map((v) => v.exercise),
      savedExerciseCount: savedCount,
      motivation: ctx.goal?.motivationMessage ?? 'Your progress starts with your next workout.',
      isNewMember: weekly.completed === 0 && !(await this.prisma.workoutSession.count({ where: { userId, status: 'COMPLETED' } })),
    };
  }
}

@ApiTags('Onboarding')
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly service: ProfileService) {}

  @Public()
  @Get('options')
  options() {
    return this.service.options();
  }

  @ApiBearerAuth()
  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.service.getOnboarding(user.id);
  }

  @ApiBearerAuth()
  @Put()
  save(@CurrentUser() user: AuthUser, @Body(new ZodPipe(SaveDraftSchema)) body: z.infer<typeof SaveDraftSchema>) {
    return this.service.saveDraft(user.id, body);
  }

  @ApiBearerAuth()
  @HttpCode(200)
  @Post('complete')
  complete(@CurrentUser() user: AuthUser, @Body(new ZodPipe(z.object({ answers: OnboardingDraftSchema.optional() }))) body: { answers?: Draft }) {
    return this.service.complete(user.id, body.answers);
  }
}

@ApiTags('Profile')
@ApiBearerAuth()
@Controller()
export class ProfileController {
  constructor(private readonly service: ProfileService) {}

  @Get('home')
  home(@CurrentUser() user: AuthUser) {
    return this.service.home(user.id);
  }

  @Get('recommendations')
  async recommendations(@CurrentUser() user: AuthUser) {
    const [program, exercises] = await Promise.all([
      this.service.recommendedProgram(user.id),
      this.service.recommendedExercises(user.id, 20),
    ]);
    return { program, exercises };
  }

  @Get('profile')
  get(@CurrentUser() user: AuthUser) {
    return this.service.getProfile(user.id);
  }

  @Patch('profile')
  update(@CurrentUser() user: AuthUser, @Body(new ZodPipe(ProfileUpdateSchema)) body: z.infer<typeof ProfileUpdateSchema>) {
    return this.service.updateProfile(user.id, body);
  }

  @Get('profile/measurements')
  measurements(@CurrentUser() user: AuthUser, @Query('type') type?: string) {
    return this.service.measurements(user.id, type);
  }

  @Post('profile/measurements')
  addMeasurement(@CurrentUser() user: AuthUser, @Body(new ZodPipe(MeasurementSchema)) body: z.infer<typeof MeasurementSchema>) {
    return this.service.addMeasurement(user.id, body);
  }

  @Patch('profile/notification-preferences')
  reminders(@CurrentUser() user: AuthUser, @Body(new ZodPipe(RemindersSchema)) body: z.infer<typeof RemindersSchema>) {
    return this.service.updateReminders(user.id, body);
  }

  @Post('profile/push-tokens')
  pushToken(@CurrentUser() user: AuthUser, @Body(new ZodPipe(PushTokenSchema)) body: z.infer<typeof PushTokenSchema>) {
    return this.service.registerPushToken(user.id, body);
  }

  @Get('profile/export')
  export(@CurrentUser() user: AuthUser) {
    return this.service.exportData(user.id);
  }

  @HttpCode(200)
  @Delete('profile')
  deleteAccount(@CurrentUser() user: AuthUser, @Body(new ZodPipe(DeleteAccountSchema)) body: z.infer<typeof DeleteAccountSchema>) {
    return this.service.deleteAccount(user.id, body.password);
  }
}
