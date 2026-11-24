import { Prisma } from '@prisma/client';

export const exerciseCardInclude = {
  exerciseType: { select: { id: true, name: true, slug: true, loggingFields: true } },
  categories: { include: { category: { select: { id: true, name: true, slug: true } } } },
  focusAreas: { include: { focusArea: { select: { id: true, name: true, slug: true } } } },
  equipment: { include: { equipment: { select: { id: true, name: true, slug: true } } } },
  _count: { select: { saved: true } },
} satisfies Prisma.ExerciseInclude;

export const exerciseDetailInclude = {
  ...exerciseCardInclude,
  muscles: { include: { muscle: { select: { id: true, name: true, slug: true, muscleGroup: true } } } },
  goals: { include: { goal: { select: { id: true, name: true, slug: true } } } },
  alternatives: {
    orderBy: { sortOrder: 'asc' },
    include: {
      alternative: {
        select: { id: true, name: true, slug: true, imageUrl: true, difficulty: true, status: true },
      },
    },
  },
  createdBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
} satisfies Prisma.ExerciseInclude;

type CardRow = Prisma.ExerciseGetPayload<{ include: typeof exerciseCardInclude }>;
type DetailRow = Prisma.ExerciseGetPayload<{ include: typeof exerciseDetailInclude }>;

export function presentExerciseCard(row: CardRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    shortDescription: row.shortDescription,
    imageUrl: row.imageUrl,
    videoUrl: row.videoUrl,
    difficulty: row.difficulty,
    status: row.status,
    viewCount: row.viewCount,
    saveCount: row._count.saved,
    exerciseType: row.exerciseType,
    categories: row.categories.map((c) => c.category),
    focusAreas: row.focusAreas.map((f) => f.focusArea),
    equipment: row.equipment.map((e) => e.equipment),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function presentExerciseDetail(row: DetailRow) {
  const card = presentExerciseCard(row);
  return {
    ...card,
    description: row.description,
    videoUrl: row.videoUrl,
    instructions: (row.instructions as string[]) ?? [],
    tips: (row.tips as string[] | null) ?? [],
    commonMistakes: (row.commonMistakes as string[] | null) ?? [],
    safetyNotes: row.safetyNotes,
    publishedAt: row.publishedAt,
    primaryMuscles: row.muscles.filter((m) => m.role === 'PRIMARY').map((m) => m.muscle),
    secondaryMuscles: row.muscles.filter((m) => m.role === 'SECONDARY').map((m) => m.muscle),
    goals: row.goals.map((g) => g.goal),
    alternatives: row.alternatives.map((a) => a.alternative),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}
