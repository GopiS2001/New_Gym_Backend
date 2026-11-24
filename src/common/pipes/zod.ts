import { BadRequestException, PipeTransform } from '@nestjs/common';
import { z, ZodTypeAny } from 'zod';

/** Validates & transforms a request body/query with a zod schema. */
export class ZodPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        details: result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

// ---------------------------------------------------------------------------
// Reusable schema fragments
// ---------------------------------------------------------------------------

export const zId = z.coerce.number().int().positive();
export const zIdArray = z.array(zId).default([]);
export const zOptionalText = (max = 5000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' ? null : v ?? null));
export const zUrl = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((v) => (v === '' ? null : v ?? null));
export const zStringList = z.array(z.string().trim().min(1).max(1000)).default([]);
export const zStatus = z.enum(['ACTIVE', 'INACTIVE']);
export const zContentStatus = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
export const zDifficulty = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']);
export const zSlug = z
  .string()
  .trim()
  .toLowerCase()
  .max(170)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug may contain lowercase letters, numbers and hyphens')
  .optional()
  .or(z.literal('').transform(() => undefined));

const csvIds = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (!v) return undefined;
    const list = (Array.isArray(v) ? v : v.split(',')).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0);
    return list.length ? list : undefined;
  });

export const zCsvIds = csvIds;

export const zListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  search: z.string().trim().max(100).optional(),
  sortBy: z.string().trim().max(50).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type ListQuery = z.infer<typeof zListQuery>;
