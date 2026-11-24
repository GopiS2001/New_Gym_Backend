import {
  BadRequestException,
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
import { ContentStatus, Prisma } from '@prisma/client';
import { z } from 'zod';

import { AuditService } from '../../common/audit/audit.service';
import { Actor, CurrentActor, RequirePermissions } from '../../common/auth/decorators';
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
  zStringList,
  zUrl,
  ZodPipe,
} from '../../common/pipes/zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { orderBy, paginate, uniqueSlug } from '../../common/utils/helpers';
import { exerciseCardInclude, exerciseDetailInclude, presentExerciseCard, presentExerciseDetail } from './exercise.presenter';

export const ExerciseSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(150),
  slug: zSlug,
  shortDescription: zOptionalText(255),
  description: zOptionalText(20000),
  imageUrl: zUrl,
  videoUrl: zUrl,
  exerciseTypeId: zId,
  difficulty: zDifficulty.default('BEGINNER'),
  instructions: zStringList,
  tips: zStringList,
  commonMistakes: zStringList,
  safetyNotes: zOptionalText(5000),
  status: zContentStatus.default('DRAFT'),
  categoryIds: zIdArray,
  focusAreaIds: zIdArray,
  primaryMuscleIds: zIdArray,
  secondaryMuscleIds: zIdArray,
  equipmentIds: zIdArray,
  goalIds: zIdArray,
  alternativeIds: zIdArray,
});
type ExerciseInput = z.infer<typeof ExerciseSchema>;

const ListSchema = zListQuery.extend({
  status: zContentStatus.optional(),
  difficulty: zDifficulty.optional(),
  typeId: zCsvIds,
  categoryId: zCsvIds,
  focusAreaId: zCsvIds,
  equipmentId: zCsvIds,
  muscleId: zCsvIds,
});

const StatusSchema = z.object({ status: zContentStatus });

@Injectable()
export class ExercisesAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: z.infer<typeof ListSchema>) {
    const where: Prisma.ExerciseWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.difficulty ? { difficulty: q.difficulty } : {}),
      ...(q.typeId ? { exerciseTypeId: { in: q.typeId } } : {}),
      ...(q.categoryId ? { categories: { some: { categoryId: { in: q.categoryId } } } } : {}),
      ...(q.focusAreaId ? { focusAreas: { some: { focusAreaId: { in: q.focusAreaId } } } } : {}),
      ...(q.equipmentId ? { equipment: { some: { equipmentId: { in: q.equipmentId } } } } : {}),
      ...(q.muscleId ? { muscles: { some: { muscleId: { in: q.muscleId } } } } : {}),
      ...(q.search
        ? { OR: [{ name: { contains: q.search } }, { slug: { contains: q.search } }] }
        : {}),
    };

    const [rows, total, counts] = await Promise.all([
      this.prisma.exercise.findMany({
        where,
        include: exerciseCardInclude,
        orderBy: [
          orderBy(q.sortBy, q.sortOrder, ['name', 'createdAt', 'updatedAt', 'viewCount', 'difficulty', 'status'], {
            updatedAt: 'desc',
          }),
          { id: 'desc' },
        ],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.exercise.count({ where }),
      this.prisma.exercise.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const statusCounts = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
    return { ...paginate(rows.map(presentExerciseCard), total, q.page, q.limit), statusCounts };
  }

  async get(id: number) {
    const row = await this.prisma.exercise.findUnique({ where: { id }, include: exerciseDetailInclude });
    if (!row) throw new NotFoundException('Exercise not found');
    const [programCount, sessionCount] = await Promise.all([
      this.prisma.programWorkoutExercise.count({ where: { exerciseId: id } }),
      this.prisma.workoutSessionExercise.count({ where: { exerciseId: id } }),
    ]);
    return { ...presentExerciseDetail(row), usage: { programs: programCount, sessions: sessionCount } };
  }

  private validate(input: Partial<ExerciseInput>, selfId?: number) {
    if (input.status === 'PUBLISHED') {
      if (!input.instructions?.length) throw new BadRequestException('Add at least one instruction step before publishing');
      if (!input.categoryIds?.length) throw new BadRequestException('Select at least one category before publishing');
    }
    if (selfId && input.alternativeIds?.includes(selfId)) {
      throw new BadRequestException('An exercise cannot be an alternative of itself');
    }
    const overlap = input.primaryMuscleIds?.filter((id) => input.secondaryMuscleIds?.includes(id)) ?? [];
    if (overlap.length) throw new BadRequestException('A muscle cannot be both primary and secondary');
  }

  private relationData(input: Partial<ExerciseInput>, mode: 'create' | 'update') {
    const reset = mode === 'update' ? { deleteMany: {} } : {};
    const data: Record<string, unknown> = {};
    if (input.categoryIds) data.categories = { ...reset, create: input.categoryIds.map((categoryId) => ({ categoryId })) };
    if (input.focusAreaIds) data.focusAreas = { ...reset, create: input.focusAreaIds.map((focusAreaId) => ({ focusAreaId })) };
    if (input.equipmentIds) data.equipment = { ...reset, create: input.equipmentIds.map((equipmentId) => ({ equipmentId })) };
    if (input.goalIds) data.goals = { ...reset, create: input.goalIds.map((goalId) => ({ goalId })) };
    if (input.alternativeIds) {
      data.alternatives = {
        ...reset,
        create: input.alternativeIds.map((alternativeExerciseId, sortOrder) => ({ alternativeExerciseId, sortOrder })),
      };
    }
    if (input.primaryMuscleIds || input.secondaryMuscleIds) {
      data.muscles = {
        ...reset,
        create: [
          ...(input.primaryMuscleIds ?? []).map((muscleId) => ({ muscleId, role: 'PRIMARY' as const })),
          ...(input.secondaryMuscleIds ?? []).map((muscleId) => ({ muscleId, role: 'SECONDARY' as const })),
        ],
      };
    }
    return data;
  }

  private scalarData(input: Partial<ExerciseInput>) {
    const {
      categoryIds: _c,
      focusAreaIds: _f,
      primaryMuscleIds: _p,
      secondaryMuscleIds: _s,
      equipmentIds: _e,
      goalIds: _g,
      alternativeIds: _a,
      exerciseTypeId,
      ...scalars
    } = input;
    return {
      ...scalars,
      ...(exerciseTypeId ? { exerciseType: { connect: { id: exerciseTypeId } } } : {}),
    };
  }

  private slugFor(source: string, excludeId?: number) {
    return uniqueSlug(source, async (slug) => {
      const hit = await this.prisma.exercise.findUnique({ where: { slug }, select: { id: true } });
      return !!hit && hit.id !== excludeId;
    });
  }

  async create(input: ExerciseInput, actor: Actor) {
    this.validate(input);
    const slug = await this.slugFor(input.slug || input.name);
    const row = await this.prisma.exercise.create({
      data: {
        ...(this.scalarData(input) as Prisma.ExerciseCreateInput),
        slug,
        publishedAt: input.status === 'PUBLISHED' ? new Date() : null,
        createdBy: { connect: { id: actor.userId } },
        updatedBy: { connect: { id: actor.userId } },
        ...this.relationData(input, 'create'),
      },
      include: exerciseDetailInclude,
    });
    const result = presentExerciseDetail(row);
    await this.audit.log({ actor, action: 'create', entityType: 'Exercise', entityId: row.id, summary: `Created exercise "${row.name}"`, after: result });
    return result;
  }

  async update(id: number, input: Partial<ExerciseInput>, actor: Actor) {
    const before = await this.get(id);
    const merged = {
      instructions: before.instructions,
      categoryIds: before.categories.map((c) => c.id),
      primaryMuscleIds: before.primaryMuscles.map((m) => m.id),
      secondaryMuscleIds: before.secondaryMuscles.map((m) => m.id),
      status: before.status,
      ...input,
    };
    this.validate(merged, id);

    const slug = input.slug || input.name ? await this.slugFor(input.slug || input.name!, id) : undefined;
    const publishing = input.status === 'PUBLISHED' && before.status !== 'PUBLISHED';

    const row = await this.prisma.$transaction(async (tx) => {
      return tx.exercise.update({
        where: { id },
        data: {
          ...(this.scalarData(input) as Prisma.ExerciseUpdateInput),
          ...(slug ? { slug } : {}),
          ...(publishing ? { publishedAt: new Date() } : {}),
          updatedBy: { connect: { id: actor.userId } },
          ...this.relationData(
            {
              ...input,
              // muscles are stored together, so always send both lists when either changes
              ...(input.primaryMuscleIds || input.secondaryMuscleIds
                ? { primaryMuscleIds: merged.primaryMuscleIds, secondaryMuscleIds: merged.secondaryMuscleIds }
                : {}),
            },
            'update',
          ),
        },
        include: exerciseDetailInclude,
      });
    });

    const result = presentExerciseDetail(row);
    await this.audit.log({ actor, action: 'update', entityType: 'Exercise', entityId: id, summary: `Updated exercise "${row.name}"`, before, after: result });
    return result;
  }

  async setStatus(id: number, status: ContentStatus, actor: Actor) {
    const before = await this.get(id);
    if (status === 'PUBLISHED') {
      this.validate({
        status,
        instructions: before.instructions,
        categoryIds: before.categories.map((c) => c.id),
      });
    }
    await this.prisma.exercise.update({
      where: { id },
      data: {
        status,
        ...(status === 'PUBLISHED' && !before.publishedAt ? { publishedAt: new Date() } : {}),
        updatedBy: { connect: { id: actor.userId } },
      },
    });
    const verb = { DRAFT: 'Moved to draft', PUBLISHED: 'Published', ARCHIVED: 'Archived' }[status];
    await this.audit.log({
      actor,
      action: status === 'ARCHIVED' ? 'archive' : status === 'PUBLISHED' ? 'publish' : 'unpublish',
      entityType: 'Exercise',
      entityId: id,
      summary: `${verb} exercise "${before.name}"`,
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
        videoUrl: src.videoUrl,
        exerciseTypeId: src.exerciseType.id,
        difficulty: src.difficulty,
        instructions: src.instructions,
        tips: src.tips,
        commonMistakes: src.commonMistakes,
        safetyNotes: src.safetyNotes,
        status: 'DRAFT',
        categoryIds: src.categories.map((c) => c.id),
        focusAreaIds: src.focusAreas.map((c) => c.id),
        primaryMuscleIds: src.primaryMuscles.map((c) => c.id),
        secondaryMuscleIds: src.secondaryMuscles.map((c) => c.id),
        equipmentIds: src.equipment.map((c) => c.id),
        goalIds: src.goals.map((c) => c.id),
        alternativeIds: src.alternatives.map((c) => c.id),
      },
      actor,
    );
  }

  /** Permanent delete: only for exercises never used in programs, workouts or libraries. */
  async remove(id: number, actor: Actor) {
    const before = await this.get(id);
    const saved = await this.prisma.savedExercise.count({ where: { exerciseId: id } });
    if (before.usage.programs || before.usage.sessions || before.saveCount || saved) {
      throw new ConflictException('This exercise is referenced by programs, workout history or member libraries. Archive it instead.');
    }
    await this.prisma.exercise.delete({ where: { id } });
    await this.audit.log({ actor, action: 'delete', entityType: 'Exercise', entityId: id, summary: `Deleted exercise "${before.name}"`, before });
    return { success: true };
  }
}

@ApiTags('Admin · Exercises')
@ApiBearerAuth()
@Controller('admin/exercises')
export class ExercisesAdminController {
  constructor(private readonly service: ExercisesAdminService) {}

  @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
  @Get()
  list(@Query(new ZodPipe(ListSchema)) q: z.infer<typeof ListSchema>) {
    return this.service.list(q);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.service.get(id);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Post()
  create(@Body(new ZodPipe(ExerciseSchema)) body: ExerciseInput, @CurrentActor() actor: Actor) {
    return this.service.create(body, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(ExerciseSchema.partial())) body: Partial<ExerciseInput>,
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
