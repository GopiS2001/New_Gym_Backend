import { z } from 'zod';

import type { PrismaService } from '../../common/prisma/prisma.service';
import { zId, zIdArray, zOptionalText, zSlug, zStatus, zUrl } from '../../common/pipes/zod';

/** Logging fields an exercise type can enable in the mobile workout logger. */
export const LOGGING_FIELDS = [
  'sets',
  'reps',
  'weight',
  'duration',
  'distance',
  'pace',
  'calories',
  'hold',
  'rest',
  'rpe',
  'notes',
] as const;

export type ReferenceConfig = {
  /** URL segment, e.g. `goals` → /admin/goals and /goals */
  path: string;
  /** Prisma delegate name */
  model:
    | 'goal'
    | 'focusArea'
    | 'exerciseCategory'
    | 'muscle'
    | 'exerciseType'
    | 'equipment'
    | 'equipmentGroup'
    | 'experienceLevel'
    | 'onboardingOption';
  entity: string;
  label: string;
  nameField: 'name' | 'label';
  hasSortOrder: boolean;
  schema: z.ZodObject<z.ZodRawShape>;
  sortable: string[];
  /** Extra list filters from the query string */
  filters?: (q: Record<string, string | undefined>) => Record<string, unknown>;
  /** Fields that make the slug unique (in addition to slug itself) */
  slugScope?: (input: Record<string, unknown>) => Record<string, unknown>;
  include?: Record<string, unknown>;
  /** Shape relation inputs (id arrays) into Prisma nested writes */
  toData?: (input: Record<string, unknown>, mode: 'create' | 'update') => Record<string, unknown>;
  /** Post-process a record for the response (e.g. flatten join tables) */
  present?: (row: Record<string, any>) => Record<string, unknown>;
  /** How many records reference this entity (blocks hard delete) */
  usage: (prisma: PrismaService, id: number) => Promise<number>;
};

const base = {
  name: z.string().trim().min(1, 'Name is required').max(100),
  slug: zSlug,
  description: zOptionalText(5000),
  imageUrl: zUrl,
  status: zStatus.default('ACTIVE'),
};

const sortOrder = { sortOrder: z.coerce.number().int().min(0).max(100000).default(0) };

const count = async (...ps: Promise<number>[]) => (await Promise.all(ps)).reduce((a, b) => a + b, 0);

export const REFERENCE_CONFIGS: ReferenceConfig[] = [
  {
    path: 'goals',
    model: 'goal',
    entity: 'Goal',
    label: 'Goals',
    nameField: 'name',
    hasSortOrder: true,
    sortable: ['name', 'sortOrder', 'createdAt', 'status'],
    schema: z.object({
      ...base,
      ...sortOrder,
      icon: zOptionalText(100),
      motivationMessage: zOptionalText(255),
      recommendationMeta: z.record(z.unknown()).nullish(),
    }),
    usage: (p, id) =>
      count(
        p.memberGoal.count({ where: { goalId: id } }),
        p.program.count({ where: { goalId: id } }),
        p.workoutTemplate.count({ where: { goalId: id } }),
        p.exerciseGoal.count({ where: { goalId: id } }),
      ),
  },
  {
    path: 'focus-areas',
    model: 'focusArea',
    entity: 'FocusArea',
    label: 'Focus areas',
    nameField: 'name',
    hasSortOrder: true,
    sortable: ['name', 'sortOrder', 'createdAt', 'status'],
    schema: z.object({ ...base, ...sortOrder }),
    usage: (p, id) =>
      count(
        p.memberFocusArea.count({ where: { focusAreaId: id } }),
        p.exerciseFocusArea.count({ where: { focusAreaId: id } }),
      ),
  },
  {
    path: 'exercise-categories',
    model: 'exerciseCategory',
    entity: 'ExerciseCategory',
    label: 'Exercise categories',
    nameField: 'name',
    hasSortOrder: true,
    sortable: ['name', 'sortOrder', 'createdAt', 'status'],
    schema: z.object({ ...base, ...sortOrder }),
    usage: (p, id) => p.exerciseCategoryLink.count({ where: { categoryId: id } }),
  },
  {
    path: 'muscles',
    model: 'muscle',
    entity: 'Muscle',
    label: 'Muscles',
    nameField: 'name',
    hasSortOrder: false,
    sortable: ['name', 'muscleGroup', 'bodyRegion', 'createdAt', 'status'],
    schema: z.object({
      ...base,
      muscleGroup: zOptionalText(100),
      bodyRegion: zOptionalText(100),
    }),
    filters: (q) => ({
      ...(q.muscleGroup ? { muscleGroup: q.muscleGroup } : {}),
      ...(q.bodyRegion ? { bodyRegion: q.bodyRegion } : {}),
    }),
    usage: (p, id) => p.exerciseMuscle.count({ where: { muscleId: id } }),
  },
  {
    path: 'exercise-types',
    model: 'exerciseType',
    entity: 'ExerciseType',
    label: 'Exercise types',
    nameField: 'name',
    hasSortOrder: true,
    sortable: ['name', 'sortOrder', 'createdAt', 'status'],
    schema: z.object({
      ...base,
      ...sortOrder,
      icon: zOptionalText(100),
      loggingFields: z.array(z.enum(LOGGING_FIELDS)).min(1, 'Select at least one logging field'),
    }),
    usage: (p, id) => p.exercise.count({ where: { exerciseTypeId: id } }),
  },
  {
    path: 'equipment',
    model: 'equipment',
    entity: 'Equipment',
    label: 'Equipment',
    nameField: 'name',
    hasSortOrder: true,
    sortable: ['name', 'sortOrder', 'createdAt', 'status'],
    schema: z.object({ ...base, ...sortOrder, groupIds: zIdArray }),
    filters: (q) => (q.groupId ? { groups: { some: { groupId: Number(q.groupId) } } } : {}),
    include: { groups: { include: { group: { select: { id: true, name: true } } } } },
    toData: ({ groupIds, ...rest }, mode) => ({
      ...rest,
      ...(Array.isArray(groupIds)
        ? {
            groups: {
              ...(mode === 'update' ? { deleteMany: {} } : {}),
              create: (groupIds as number[]).map((groupId) => ({ groupId })),
            },
          }
        : {}),
    }),
    present: ({ groups, ...row }) => ({
      ...row,
      groups: (groups ?? []).map((g: any) => g.group),
      groupIds: (groups ?? []).map((g: any) => g.group.id),
    }),
    usage: (p, id) =>
      count(
        p.exerciseEquipment.count({ where: { equipmentId: id } }),
        p.memberEquipment.count({ where: { equipmentId: id } }),
        p.programEquipment.count({ where: { equipmentId: id } }),
        p.workoutTemplateEquipment.count({ where: { equipmentId: id } }),
      ),
  },
  {
    path: 'equipment-groups',
    model: 'equipmentGroup',
    entity: 'EquipmentGroup',
    label: 'Equipment groups',
    nameField: 'name',
    hasSortOrder: true,
    sortable: ['name', 'sortOrder', 'createdAt', 'status'],
    schema: z.object({ ...base, ...sortOrder, equipmentIds: zIdArray }),
    include: { items: { include: { equipment: { select: { id: true, name: true } } } } },
    toData: ({ equipmentIds, ...rest }, mode) => ({
      ...rest,
      ...(Array.isArray(equipmentIds)
        ? {
            items: {
              ...(mode === 'update' ? { deleteMany: {} } : {}),
              create: (equipmentIds as number[]).map((equipmentId) => ({ equipmentId })),
            },
          }
        : {}),
    }),
    present: ({ items, ...row }) => ({
      ...row,
      equipment: (items ?? []).map((i: any) => i.equipment),
      equipmentIds: (items ?? []).map((i: any) => i.equipment.id),
    }),
    usage: async () => 0,
  },
  {
    path: 'experience-levels',
    model: 'experienceLevel',
    entity: 'ExperienceLevel',
    label: 'Experience levels',
    nameField: 'name',
    hasSortOrder: true,
    sortable: ['name', 'sortOrder', 'rank', 'createdAt', 'status'],
    schema: z.object({
      ...base,
      ...sortOrder,
      rank: z.coerce.number().int().min(0).max(100).default(0),
    }),
    usage: (p, id) => p.memberProfile.count({ where: { experienceLevelId: id } }),
  },
  {
    path: 'onboarding-options',
    model: 'onboardingOption',
    entity: 'OnboardingOption',
    label: 'Onboarding options',
    nameField: 'label',
    hasSortOrder: true,
    sortable: ['label', 'group', 'sortOrder', 'createdAt', 'status'],
    schema: z.object({
      group: z.enum(['GENDER', 'ACTIVITY', 'MOTIVATION']),
      label: z.string().trim().min(1, 'Label is required').max(120),
      slug: zSlug,
      description: zOptionalText(255),
      imageUrl: zUrl,
      allowsFreeText: z.boolean().default(false),
      status: zStatus.default('ACTIVE'),
      ...sortOrder,
    }),
    filters: (q) => (q.group ? { group: q.group } : {}),
    slugScope: (input) => ({ group: input.group }),
    usage: (p, id) =>
      count(
        p.memberProfile.count({ where: { OR: [{ genderOptionId: id }, { activityOptionId: id }] } }),
        p.memberMotivation.count({ where: { optionId: id } }),
      ),
  },
];

export const zReferenceStatus = z.object({ status: zStatus });
export const zReorder = z.object({ ids: z.array(zId).min(1) });
