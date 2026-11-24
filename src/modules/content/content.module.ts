import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
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
import { Actor, CurrentActor, Public, RequirePermissions } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import {
  zContentStatus,
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

const StatusSchema = z.object({ status: zContentStatus });
const AdminList = zListQuery.extend({ status: zContentStatus.optional() });
type AdminListQ = z.infer<typeof AdminList>;

// ===========================================================================
// Coaches
// ===========================================================================

const CredentialSchema = z.object({
  title: z.string().trim().min(1).max(150),
  issuer: zOptionalText(150),
  year: z.coerce.number().int().min(1950).max(2100).nullish(),
  verified: z.boolean().default(false),
});

const CoachSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: zSlug,
  imageUrl: zUrl,
  headline: zOptionalText(200),
  bio: zOptionalText(10000),
  specialities: zStringList,
  credentials: z.array(CredentialSchema).default([]),
  experienceYears: z.coerce.number().int().min(0).max(80).nullish(),
  socialLinks: z.record(z.string().max(300)).default({}),
  status: zContentStatus.default('DRAFT'),
  programIds: zIdArray.optional(),
});
type CoachInput = z.infer<typeof CoachSchema>;

@Injectable()
export class CoachesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: AdminListQ) {
    const where: Prisma.CoachWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.search ? { name: { contains: q.search } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.coach.findMany({
        where,
        include: { _count: { select: { programs: true } } },
        orderBy: [orderBy(q.sortBy, q.sortOrder, ['name', 'createdAt', 'updatedAt', 'status'], { name: 'asc' }), { id: 'asc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.coach.count({ where }),
    ]);
    return paginate(rows.map(({ _count, ...r }) => ({ ...r, programCount: _count.programs })), total, q.page, q.limit);
  }

  async get(id: number) {
    const row = await this.prisma.coach.findUnique({
      where: { id },
      include: { programs: { select: { id: true, name: true, status: true, imageUrl: true } } },
    });
    if (!row) throw new NotFoundException('Coach not found');
    return { ...row, programIds: row.programs.map((p) => p.id) };
  }

  private slug(source: string, excludeId?: number) {
    return uniqueSlug(source, async (slug) => {
      const hit = await this.prisma.coach.findUnique({ where: { slug }, select: { id: true } });
      return !!hit && hit.id !== excludeId;
    });
  }

  private async assignPrograms(tx: Prisma.TransactionClient, coachId: number, programIds?: number[]) {
    if (!programIds) return;
    await tx.program.updateMany({ where: { coachId, id: { notIn: programIds } }, data: { coachId: null } });
    if (programIds.length) await tx.program.updateMany({ where: { id: { in: programIds } }, data: { coachId } });
  }

  async create(input: CoachInput, actor: Actor) {
    const { programIds, ...data } = input;
    const slug = await this.slug(input.slug || input.name);
    const id = await this.prisma.$transaction(async (tx) => {
      const coach = await tx.coach.create({ data: { ...data, slug } });
      await this.assignPrograms(tx, coach.id, programIds);
      return coach.id;
    });
    const result = await this.get(id);
    await this.audit.log({ actor, action: 'create', entityType: 'Coach', entityId: id, summary: `Created coach "${result.name}"`, after: result });
    return result;
  }

  async update(id: number, input: Partial<CoachInput>, actor: Actor) {
    const before = await this.get(id);
    const { programIds, ...data } = input;
    const slug = input.slug || input.name ? await this.slug(input.slug || input.name!, id) : undefined;
    await this.prisma.$transaction(async (tx) => {
      await tx.coach.update({ where: { id }, data: { ...data, ...(slug ? { slug } : {}) } });
      await this.assignPrograms(tx, id, programIds);
    });
    const result = await this.get(id);
    await this.audit.log({ actor, action: 'update', entityType: 'Coach', entityId: id, summary: `Updated coach "${result.name}"`, before, after: result });
    return result;
  }

  async setStatus(id: number, status: ContentStatus, actor: Actor) {
    const before = await this.get(id);
    await this.prisma.coach.update({ where: { id }, data: { status } });
    await this.audit.log({ actor, action: status.toLowerCase(), entityType: 'Coach', entityId: id, summary: `${status} coach "${before.name}"`, before: { status: before.status }, after: { status } });
    return this.get(id);
  }

  async remove(id: number, actor: Actor) {
    const before = await this.get(id);
    if (before.programs.length) throw new ConflictException('This coach has programs assigned. Archive the coach instead.');
    await this.prisma.coach.delete({ where: { id } });
    await this.audit.log({ actor, action: 'delete', entityType: 'Coach', entityId: id, summary: `Deleted coach "${before.name}"`, before });
    return { success: true };
  }

  // ---- public -------------------------------------------------------------

  private publicCoach<T extends { credentials: Prisma.JsonValue }>(row: T) {
    const creds = (row.credentials as z.infer<typeof CredentialSchema>[] | null) ?? [];
    // Only verified qualifications are ever published to members.
    return { ...row, credentials: creds.filter((c) => c.verified).map(({ verified: _v, ...c }) => c) };
  }

  async publicList() {
    const rows = await this.prisma.coach.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: { name: 'asc' },
      include: { _count: { select: { programs: { where: { status: 'PUBLISHED' } } } } },
    });
    return rows.map(({ _count, ...r }) => ({ ...this.publicCoach(r), programCount: _count.programs }));
  }

  async publicDetail(idOrSlug: string) {
    const where = /^\d+$/.test(idOrSlug) ? { id: Number(idOrSlug) } : { slug: idOrSlug };
    const row = await this.prisma.coach.findUnique({
      where,
      include: {
        programs: {
          where: { status: 'PUBLISHED' },
          select: { id: true, name: true, slug: true, imageUrl: true, difficulty: true, durationWeeks: true, daysPerWeek: true },
        },
      },
    });
    if (!row || row.status !== 'PUBLISHED') throw new NotFoundException('Coach not found');
    return this.publicCoach(row);
  }
}

@ApiTags('Admin · Coaches')
@ApiBearerAuth()
@Controller('admin/coaches')
export class CoachesAdminController {
  constructor(private readonly service: CoachesService) {}

  @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
  @Get()
  list(@Query(new ZodPipe(AdminList)) q: AdminListQ) {
    return this.service.list(q);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.service.get(id);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Post()
  create(@Body(new ZodPipe(CoachSchema)) body: CoachInput, @CurrentActor() actor: Actor) {
    return this.service.create(body, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(CoachSchema.partial())) body: Partial<CoachInput>, @CurrentActor() actor: Actor) {
    return this.service.update(id, body, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Patch(':id/status')
  status(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(StatusSchema)) body: { status: ContentStatus }, @CurrentActor() actor: Actor) {
    return this.service.setStatus(id, body.status, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
    return this.service.remove(id, actor);
  }
}

@ApiTags('Discovery')
@Controller('coaches')
export class CoachesPublicController {
  constructor(private readonly service: CoachesService) {}

  @Public()
  @Get()
  list() {
    return this.service.publicList();
  }

  @Public()
  @Get(':idOrSlug')
  detail(@Param('idOrSlug') idOrSlug: string) {
    return this.service.publicDetail(idOrSlug);
  }
}

// ===========================================================================
// Workout templates
// ===========================================================================

const TemplateExerciseSchema = z.object({
  exerciseId: zId,
  dayNumber: z.coerce.number().int().min(1).max(7).default(1),
  sets: z.coerce.number().int().min(0).max(100).nullish(),
  reps: zOptionalText(20),
  durationSeconds: z.coerce.number().int().min(0).max(86400).nullish(),
  restSeconds: z.coerce.number().int().min(0).max(3600).nullish(),
  notes: zOptionalText(500),
});

const TemplateSchema = z.object({
  name: z.string().trim().min(2).max(150),
  slug: zSlug,
  description: zOptionalText(10000),
  imageUrl: zUrl,
  goalId: zId.nullish(),
  difficulty: zDifficulty.default('BEGINNER'),
  daysPerWeek: z.coerce.number().int().min(1).max(7).default(3),
  split: zOptionalText(120),
  progressionNotes: zOptionalText(5000),
  status: zContentStatus.default('DRAFT'),
  equipmentIds: zIdArray,
  exercises: z.array(TemplateExerciseSchema).default([]),
});
type TemplateInput = z.infer<typeof TemplateSchema>;

const templateInclude = {
  goal: { select: { id: true, name: true } },
  equipment: { include: { equipment: { select: { id: true, name: true } } } },
  exercises: {
    orderBy: [{ dayNumber: 'asc' }, { sortOrder: 'asc' }],
    include: { exercise: { select: { id: true, name: true, imageUrl: true, status: true } } },
  },
} satisfies Prisma.WorkoutTemplateInclude;

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private present(row: Prisma.WorkoutTemplateGetPayload<{ include: typeof templateInclude }>) {
    return { ...row, equipment: row.equipment.map((e) => e.equipment), equipmentIds: row.equipment.map((e) => e.equipment.id) };
  }

  async list(q: AdminListQ, publicOnly = false) {
    const where: Prisma.WorkoutTemplateWhereInput = {
      ...(publicOnly ? { status: 'PUBLISHED' } : q.status ? { status: q.status } : {}),
      ...(q.search ? { name: { contains: q.search } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.workoutTemplate.findMany({
        where,
        include: templateInclude,
        orderBy: [orderBy(q.sortBy, q.sortOrder, ['name', 'createdAt', 'updatedAt', 'status', 'difficulty'], { updatedAt: 'desc' }), { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.workoutTemplate.count({ where }),
    ]);
    return paginate(rows.map((r) => this.present(r)), total, q.page, q.limit);
  }

  async get(id: number, publicOnly = false) {
    const row = await this.prisma.workoutTemplate.findUnique({ where: { id }, include: templateInclude });
    if (!row || (publicOnly && row.status !== 'PUBLISHED')) throw new NotFoundException('Workout template not found');
    return this.present(row);
  }

  private slug(source: string, excludeId?: number) {
    return uniqueSlug(source, async (slug) => {
      const hit = await this.prisma.workoutTemplate.findUnique({ where: { slug }, select: { id: true } });
      return !!hit && hit.id !== excludeId;
    });
  }

  private validate(input: Partial<TemplateInput>) {
    if (input.status === 'PUBLISHED' && !input.exercises?.length) {
      throw new BadRequestException('Add at least one exercise before publishing');
    }
    if (input.exercises && input.daysPerWeek && input.exercises.some((e) => e.dayNumber > input.daysPerWeek!)) {
      throw new BadRequestException('An exercise is scheduled on a day beyond the weekly frequency');
    }
  }

  private nested(input: Partial<TemplateInput>, mode: 'create' | 'update') {
    const reset = mode === 'update' ? { deleteMany: {} } : {};
    const byDay = new Map<number, number>();
    return {
      ...(input.equipmentIds ? { equipment: { ...reset, create: input.equipmentIds.map((equipmentId) => ({ equipmentId })) } } : {}),
      ...(input.exercises
        ? {
            exercises: {
              ...reset,
              create: input.exercises.map((e) => {
                const order = byDay.get(e.dayNumber) ?? 0;
                byDay.set(e.dayNumber, order + 1);
                return { ...e, sortOrder: order, sets: e.sets ?? null, durationSeconds: e.durationSeconds ?? null, restSeconds: e.restSeconds ?? null };
              }),
            },
          }
        : {}),
    };
  }

  async create(input: TemplateInput, actor: Actor) {
    this.validate(input);
    const { equipmentIds: _e, exercises: _x, ...data } = input;
    const row = await this.prisma.workoutTemplate.create({
      data: { ...data, slug: await this.slug(input.slug || input.name), ...this.nested(input, 'create') },
      include: templateInclude,
    });
    const result = this.present(row);
    await this.audit.log({ actor, action: 'create', entityType: 'WorkoutTemplate', entityId: row.id, summary: `Created template "${row.name}"`, after: result });
    return result;
  }

  async update(id: number, input: Partial<TemplateInput>, actor: Actor) {
    const before = await this.get(id);
    this.validate({ daysPerWeek: before.daysPerWeek, status: before.status, exercises: before.exercises as any, ...input });
    const { equipmentIds: _e, exercises: _x, ...data } = input;
    const slug = input.slug || input.name ? await this.slug(input.slug || input.name!, id) : undefined;
    const row = await this.prisma.workoutTemplate.update({
      where: { id },
      data: { ...data, ...(slug ? { slug } : {}), ...this.nested(input, 'update') },
      include: templateInclude,
    });
    const result = this.present(row);
    await this.audit.log({ actor, action: 'update', entityType: 'WorkoutTemplate', entityId: id, summary: `Updated template "${row.name}"`, before, after: result });
    return result;
  }

  async setStatus(id: number, status: ContentStatus, actor: Actor) {
    const before = await this.get(id);
    if (status === 'PUBLISHED') this.validate({ status, exercises: before.exercises as any });
    await this.prisma.workoutTemplate.update({ where: { id }, data: { status } });
    await this.audit.log({ actor, action: status.toLowerCase(), entityType: 'WorkoutTemplate', entityId: id, summary: `${status} template "${before.name}"`, before: { status: before.status }, after: { status } });
    return this.get(id);
  }

  async remove(id: number, actor: Actor) {
    const before = await this.get(id);
    if (await this.prisma.workoutSession.count({ where: { templateId: id } })) {
      throw new ConflictException('Members have trained with this template. Archive it instead.');
    }
    await this.prisma.workoutTemplate.delete({ where: { id } });
    await this.audit.log({ actor, action: 'delete', entityType: 'WorkoutTemplate', entityId: id, summary: `Deleted template "${before.name}"`, before });
    return { success: true };
  }
}

@ApiTags('Admin · Workout templates')
@ApiBearerAuth()
@Controller('admin/workout-templates')
export class TemplatesAdminController {
  constructor(private readonly service: TemplatesService) {}

  @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
  @Get()
  list(@Query(new ZodPipe(AdminList)) q: AdminListQ) {
    return this.service.list(q);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.service.get(id);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Post()
  create(@Body(new ZodPipe(TemplateSchema)) body: TemplateInput, @CurrentActor() actor: Actor) {
    return this.service.create(body, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(TemplateSchema.partial())) body: Partial<TemplateInput>, @CurrentActor() actor: Actor) {
    return this.service.update(id, body, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Patch(':id/status')
  status(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(StatusSchema)) body: { status: ContentStatus }, @CurrentActor() actor: Actor) {
    return this.service.setStatus(id, body.status, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
    return this.service.remove(id, actor);
  }
}

@ApiTags('Discovery')
@Controller('workout-templates')
export class TemplatesPublicController {
  constructor(private readonly service: TemplatesService) {}

  @Public()
  @Get()
  list(@Query(new ZodPipe(AdminList)) q: AdminListQ) {
    return this.service.list(q, true);
  }

  @Public()
  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.service.get(id, true);
  }
}

// ===========================================================================
// Featured collections
// ===========================================================================

const CollectionSchema = z.object({
  name: z.string().trim().min(2).max(150),
  slug: zSlug,
  description: zOptionalText(5000),
  imageUrl: zUrl,
  sortOrder: z.coerce.number().int().min(0).default(0),
  isFeatured: z.boolean().default(false),
  status: zContentStatus.default('DRAFT'),
  exerciseIds: zIdArray,
  programIds: zIdArray,
});
type CollectionInput = z.infer<typeof CollectionSchema>;

const collectionInclude = {
  exercises: {
    orderBy: { sortOrder: 'asc' },
    include: { exercise: { select: { id: true, name: true, slug: true, imageUrl: true, difficulty: true, status: true } } },
  },
  programs: {
    orderBy: { sortOrder: 'asc' },
    include: { program: { select: { id: true, name: true, slug: true, imageUrl: true, difficulty: true, status: true } } },
  },
} satisfies Prisma.FeaturedCollectionInclude;

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private present(row: Prisma.FeaturedCollectionGetPayload<{ include: typeof collectionInclude }>, publicOnly = false) {
    const exercises = row.exercises.map((e) => e.exercise).filter((e) => !publicOnly || e.status === 'PUBLISHED');
    const programs = row.programs.map((p) => p.program).filter((p) => !publicOnly || p.status === 'PUBLISHED');
    return {
      ...row,
      exercises,
      programs,
      exerciseIds: exercises.map((e) => e.id),
      programIds: programs.map((p) => p.id),
    };
  }

  async list(q: AdminListQ) {
    const where: Prisma.FeaturedCollectionWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.search ? { name: { contains: q.search } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.featuredCollection.findMany({
        where,
        include: collectionInclude,
        orderBy: [orderBy(q.sortBy, q.sortOrder, ['name', 'sortOrder', 'createdAt', 'status'], { sortOrder: 'asc' }), { id: 'asc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.featuredCollection.count({ where }),
    ]);
    return paginate(rows.map((r) => this.present(r)), total, q.page, q.limit);
  }

  async get(id: number) {
    const row = await this.prisma.featuredCollection.findUnique({ where: { id }, include: collectionInclude });
    if (!row) throw new NotFoundException('Collection not found');
    return this.present(row);
  }

  private slug(source: string, excludeId?: number) {
    return uniqueSlug(source, async (slug) => {
      const hit = await this.prisma.featuredCollection.findUnique({ where: { slug }, select: { id: true } });
      return !!hit && hit.id !== excludeId;
    });
  }

  private nested(input: Partial<CollectionInput>, mode: 'create' | 'update') {
    const reset = mode === 'update' ? { deleteMany: {} } : {};
    return {
      ...(input.exerciseIds ? { exercises: { ...reset, create: input.exerciseIds.map((exerciseId, sortOrder) => ({ exerciseId, sortOrder })) } } : {}),
      ...(input.programIds ? { programs: { ...reset, create: input.programIds.map((programId, sortOrder) => ({ programId, sortOrder })) } } : {}),
    };
  }

  async create(input: CollectionInput, actor: Actor) {
    const { exerciseIds: _e, programIds: _p, ...data } = input;
    const row = await this.prisma.featuredCollection.create({
      data: { ...data, slug: await this.slug(input.slug || input.name), ...this.nested(input, 'create') },
      include: collectionInclude,
    });
    const result = this.present(row);
    await this.audit.log({ actor, action: 'create', entityType: 'FeaturedCollection', entityId: row.id, summary: `Created collection "${row.name}"`, after: result });
    return result;
  }

  async update(id: number, input: Partial<CollectionInput>, actor: Actor) {
    const before = await this.get(id);
    const { exerciseIds: _e, programIds: _p, ...data } = input;
    const slug = input.slug || input.name ? await this.slug(input.slug || input.name!, id) : undefined;
    const row = await this.prisma.featuredCollection.update({
      where: { id },
      data: { ...data, ...(slug ? { slug } : {}), ...this.nested(input, 'update') },
      include: collectionInclude,
    });
    const result = this.present(row);
    await this.audit.log({ actor, action: 'update', entityType: 'FeaturedCollection', entityId: id, summary: `Updated collection "${row.name}"`, before, after: result });
    return result;
  }

  async setStatus(id: number, status: ContentStatus, actor: Actor) {
    const before = await this.get(id);
    await this.prisma.featuredCollection.update({ where: { id }, data: { status } });
    await this.audit.log({ actor, action: status.toLowerCase(), entityType: 'FeaturedCollection', entityId: id, summary: `${status} collection "${before.name}"`, before: { status: before.status }, after: { status } });
    return this.get(id);
  }

  async remove(id: number, actor: Actor) {
    const before = await this.get(id);
    await this.prisma.featuredCollection.delete({ where: { id } });
    await this.audit.log({ actor, action: 'delete', entityType: 'FeaturedCollection', entityId: id, summary: `Deleted collection "${before.name}"`, before });
    return { success: true };
  }

  async publicList(featuredOnly: boolean) {
    const rows = await this.prisma.featuredCollection.findMany({
      where: { status: 'PUBLISHED', ...(featuredOnly ? { isFeatured: true } : {}) },
      include: collectionInclude,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => this.present(r, true));
  }

  async publicDetail(idOrSlug: string) {
    const where = /^\d+$/.test(idOrSlug) ? { id: Number(idOrSlug) } : { slug: idOrSlug };
    const row = await this.prisma.featuredCollection.findUnique({ where, include: collectionInclude });
    if (!row || row.status !== 'PUBLISHED') throw new NotFoundException('Collection not found');
    return this.present(row, true);
  }
}

@ApiTags('Admin · Featured collections')
@ApiBearerAuth()
@Controller('admin/collections')
export class CollectionsAdminController {
  constructor(private readonly service: CollectionsService) {}

  @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
  @Get()
  list(@Query(new ZodPipe(AdminList)) q: AdminListQ) {
    return this.service.list(q);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_VIEW)
  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.service.get(id);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Post()
  create(@Body(new ZodPipe(CollectionSchema)) body: CollectionInput, @CurrentActor() actor: Actor) {
    return this.service.create(body, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(CollectionSchema.partial())) body: Partial<CollectionInput>, @CurrentActor() actor: Actor) {
    return this.service.update(id, body, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Patch(':id/status')
  status(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(StatusSchema)) body: { status: ContentStatus }, @CurrentActor() actor: Actor) {
    return this.service.setStatus(id, body.status, actor);
  }

  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
    return this.service.remove(id, actor);
  }
}

@ApiTags('Discovery')
@Controller('collections')
export class CollectionsPublicController {
  constructor(private readonly service: CollectionsService) {}

  @Public()
  @Get()
  list(@Query('featured') featured?: string) {
    return this.service.publicList(featured === 'true');
  }

  @Public()
  @Get(':idOrSlug')
  detail(@Param('idOrSlug') idOrSlug: string) {
    return this.service.publicDetail(idOrSlug);
  }
}

@Module({
  controllers: [
    CoachesAdminController,
    CoachesPublicController,
    TemplatesAdminController,
    TemplatesPublicController,
    CollectionsAdminController,
    CollectionsPublicController,
  ],
  providers: [CoachesService, TemplatesService, CollectionsService],
})
export class ContentModule {}
