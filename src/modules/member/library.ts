import {
  Body,
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
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AuthUser, CurrentUser } from '../../common/auth/decorators';
import { zId, ZodPipe } from '../../common/pipes/zod';
import { PrismaService } from '../../common/prisma/prisma.service';

const CollectionSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(500).nullish(),
});
const ReorderSchema = z.object({ ids: z.array(zId).min(1) });
const ItemSchema = z.object({ exerciseId: zId.optional(), programId: zId.optional() }).refine((v) => v.exerciseId || v.programId, {
  message: 'exerciseId or programId is required',
});

const exerciseSummary = {
  id: true,
  name: true,
  slug: true,
  imageUrl: true,
  videoUrl: true,
  difficulty: true,
  status: true,
  exerciseType: { select: { id: true, name: true } },
  categories: { select: { category: { select: { id: true, name: true } } } },
  equipment: { select: { equipment: { select: { id: true, name: true } } } },
} as const;

const programSummary = {
  id: true,
  name: true,
  slug: true,
  imageUrl: true,
  difficulty: true,
  status: true,
  durationWeeks: true,
  daysPerWeek: true,
} as const;

type ExerciseSummary = {
  status: string;
  categories: { category: { id: number; name: string } }[];
  equipment: { equipment: { id: number; name: string } }[];
  [k: string]: unknown;
};

/** Retired content stays in the library but is flagged unavailable. */
const presentExercise = ({ categories, equipment, ...e }: ExerciseSummary) => ({
  ...e,
  categories: categories.map((c) => c.category),
  equipment: equipment.map((x) => x.equipment),
  isAvailable: e.status === 'PUBLISHED',
});
const presentProgram = <T extends { status: string }>(p: T) => ({ ...p, isAvailable: p.status === 'PUBLISHED' });

@Injectable()
export class LibraryService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(userId: number) {
    const [exercises, programs, collections] = await Promise.all([
      this.prisma.savedExercise.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        include: { exercise: { select: exerciseSummary } },
      }),
      this.prisma.savedProgram.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        include: { program: { select: programSummary } },
      }),
      this.collections(userId),
    ]);
    return {
      savedExercises: exercises.map((s) => ({ savedAt: s.createdAt, ...presentExercise(s.exercise as ExerciseSummary) })),
      savedPrograms: programs.map((s) => ({ savedAt: s.createdAt, ...presentProgram(s.program) })),
      collections,
    };
  }

  async saveExercise(userId: number, exerciseId: number) {
    const ex = await this.prisma.exercise.findUnique({ where: { id: exerciseId }, select: { status: true } });
    if (!ex || ex.status !== 'PUBLISHED') throw new NotFoundException('Exercise not found');
    await this.prisma.savedExercise.upsert({
      where: { userId_exerciseId: { userId, exerciseId } },
      update: {},
      create: { userId, exerciseId },
    });
    return { saved: true };
  }

  async unsaveExercise(userId: number, exerciseId: number) {
    await this.prisma.savedExercise.deleteMany({ where: { userId, exerciseId } });
    return { saved: false };
  }

  async saveProgram(userId: number, programId: number) {
    const p = await this.prisma.program.findUnique({ where: { id: programId }, select: { status: true } });
    if (!p || p.status !== 'PUBLISHED') throw new NotFoundException('Program not found');
    await this.prisma.savedProgram.upsert({
      where: { userId_programId: { userId, programId } },
      update: {},
      create: { userId, programId },
    });
    return { saved: true };
  }

  async unsaveProgram(userId: number, programId: number) {
    await this.prisma.savedProgram.deleteMany({ where: { userId, programId } });
    return { saved: false };
  }

  // ---- collections ---------------------------------------------------------

  async collections(userId: number) {
    const rows = await this.prisma.memberCollection.findMany({
      where: { userId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: {
        exercises: { orderBy: { sortOrder: 'asc' }, include: { exercise: { select: exerciseSummary } } },
        programs: { orderBy: { sortOrder: 'asc' }, include: { program: { select: programSummary } } },
      },
    });
    return rows.map((c) => ({
      ...c,
      exercises: c.exercises.map((e) => presentExercise(e.exercise as ExerciseSummary)),
      programs: c.programs.map((p) => presentProgram(p.program)),
      itemCount: c.exercises.length + c.programs.length,
    }));
  }

  private async own(userId: number, id: number) {
    const c = await this.prisma.memberCollection.findFirst({ where: { id, userId } });
    if (!c) throw new NotFoundException('Collection not found');
    return c;
  }

  async getCollection(userId: number, id: number) {
    await this.own(userId, id);
    return (await this.collections(userId)).find((c) => c.id === id);
  }

  async createCollection(userId: number, input: z.infer<typeof CollectionSchema>) {
    const max = await this.prisma.memberCollection.aggregate({ where: { userId }, _max: { sortOrder: true } });
    return this.prisma.memberCollection.create({ data: { userId, ...input, sortOrder: (max._max.sortOrder ?? -1) + 1 } });
  }

  async updateCollection(userId: number, id: number, input: Partial<z.infer<typeof CollectionSchema>>) {
    await this.own(userId, id);
    return this.prisma.memberCollection.update({ where: { id }, data: input });
  }

  async deleteCollection(userId: number, id: number) {
    await this.own(userId, id);
    await this.prisma.memberCollection.delete({ where: { id } });
    return { success: true };
  }

  async reorderCollections(userId: number, ids: number[]) {
    const owned = await this.prisma.memberCollection.findMany({ where: { userId, id: { in: ids } }, select: { id: true } });
    if (owned.length !== ids.length) throw new NotFoundException('Collection not found');
    await this.prisma.$transaction(ids.map((id, sortOrder) => this.prisma.memberCollection.update({ where: { id }, data: { sortOrder } })));
    return { success: true };
  }

  async addItem(userId: number, id: number, item: { exerciseId?: number; programId?: number }) {
    await this.own(userId, id);
    if (item.exerciseId) {
      const count = await this.prisma.memberCollectionExercise.count({ where: { collectionId: id } });
      await this.prisma.memberCollectionExercise.upsert({
        where: { collectionId_exerciseId: { collectionId: id, exerciseId: item.exerciseId } },
        update: {},
        create: { collectionId: id, exerciseId: item.exerciseId, sortOrder: count },
      });
    }
    if (item.programId) {
      const count = await this.prisma.memberCollectionProgram.count({ where: { collectionId: id } });
      await this.prisma.memberCollectionProgram.upsert({
        where: { collectionId_programId: { collectionId: id, programId: item.programId } },
        update: {},
        create: { collectionId: id, programId: item.programId, sortOrder: count },
      });
    }
    return this.getCollection(userId, id);
  }

  async removeItem(userId: number, id: number, kind: 'exercises' | 'programs', itemId: number) {
    await this.own(userId, id);
    if (kind === 'exercises') await this.prisma.memberCollectionExercise.deleteMany({ where: { collectionId: id, exerciseId: itemId } });
    else await this.prisma.memberCollectionProgram.deleteMany({ where: { collectionId: id, programId: itemId } });
    return this.getCollection(userId, id);
  }

  async reorderItems(userId: number, id: number, kind: 'exercises' | 'programs', ids: number[]) {
    await this.own(userId, id);
    await this.prisma.$transaction(
      ids.map((itemId, sortOrder) =>
        kind === 'exercises'
          ? this.prisma.memberCollectionExercise.update({ where: { collectionId_exerciseId: { collectionId: id, exerciseId: itemId } }, data: { sortOrder } })
          : this.prisma.memberCollectionProgram.update({ where: { collectionId_programId: { collectionId: id, programId: itemId } }, data: { sortOrder } }),
      ),
    );
    return this.getCollection(userId, id);
  }
}

const zKind = z.enum(['exercises', 'programs']);

@ApiTags('Library')
@ApiBearerAuth()
@Controller('library')
export class LibraryController {
  constructor(private readonly service: LibraryService) {}

  @Get()
  overview(@CurrentUser() user: AuthUser) {
    return this.service.overview(user.id);
  }

  @HttpCode(200)
  @Post('exercises/:exerciseId')
  saveExercise(@CurrentUser() user: AuthUser, @Param('exerciseId', ParseIntPipe) id: number) {
    return this.service.saveExercise(user.id, id);
  }

  @Delete('exercises/:exerciseId')
  unsaveExercise(@CurrentUser() user: AuthUser, @Param('exerciseId', ParseIntPipe) id: number) {
    return this.service.unsaveExercise(user.id, id);
  }

  @HttpCode(200)
  @Post('programs/:programId')
  saveProgram(@CurrentUser() user: AuthUser, @Param('programId', ParseIntPipe) id: number) {
    return this.service.saveProgram(user.id, id);
  }

  @Delete('programs/:programId')
  unsaveProgram(@CurrentUser() user: AuthUser, @Param('programId', ParseIntPipe) id: number) {
    return this.service.unsaveProgram(user.id, id);
  }

  @Get('collections')
  collections(@CurrentUser() user: AuthUser) {
    return this.service.collections(user.id);
  }

  @Post('collections')
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(CollectionSchema)) body: z.infer<typeof CollectionSchema>) {
    return this.service.createCollection(user.id, body);
  }

  @Put('collections/reorder')
  reorder(@CurrentUser() user: AuthUser, @Body(new ZodPipe(ReorderSchema)) body: { ids: number[] }) {
    return this.service.reorderCollections(user.id, body.ids);
  }

  @Get('collections/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.service.getCollection(user.id, id);
  }

  @Patch('collections/:id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(CollectionSchema.partial())) body: Partial<z.infer<typeof CollectionSchema>>) {
    return this.service.updateCollection(user.id, id, body);
  }

  @Delete('collections/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.service.deleteCollection(user.id, id);
  }

  @Post('collections/:id/items')
  addItem(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(ItemSchema)) body: z.infer<typeof ItemSchema>) {
    return this.service.addItem(user.id, id, body);
  }

  @Delete('collections/:id/:kind/:itemId')
  removeItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('kind', new ZodPipe(zKind)) kind: z.infer<typeof zKind>,
    @Param('itemId', ParseIntPipe) itemId: number,
  ) {
    return this.service.removeItem(user.id, id, kind, itemId);
  }

  @Put('collections/:id/:kind/reorder')
  reorderItems(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('kind', new ZodPipe(zKind)) kind: z.infer<typeof zKind>,
    @Body(new ZodPipe(ReorderSchema)) body: { ids: number[] },
  ) {
    return this.service.reorderItems(user.id, id, kind, body.ids);
  }
}
