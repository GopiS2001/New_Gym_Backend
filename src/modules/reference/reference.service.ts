import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../../common/audit/audit.service';
import type { Actor } from '../../common/auth/decorators';
import { PrismaService } from '../../common/prisma/prisma.service';
import { orderBy, paginate, uniqueSlug } from '../../common/utils/helpers';
import type { ReferenceConfig } from './reference.config';

type Query = Record<string, string | undefined>;

/** Generic CRUD used by every reference-data module (goals, muscles, …). */
@Injectable()
export class ReferenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private delegate(cfg: ReferenceConfig): any {
    return (this.prisma as any)[cfg.model];
  }

  private present(cfg: ReferenceConfig, row: any) {
    return cfg.present ? cfg.present(row) : row;
  }

  async list(cfg: ReferenceConfig, q: Query) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 50));
    const where: Record<string, unknown> = { ...(cfg.filters?.(q) ?? {}) };

    if (q.status === 'ACTIVE' || q.status === 'INACTIVE') where.status = q.status;
    if (q.search) where[cfg.nameField] = { contains: q.search };

    const fallback = cfg.hasSortOrder ? { sortOrder: 'asc' as const } : { [cfg.nameField]: 'asc' as const };
    const sort = orderBy(q.sortBy, q.sortOrder === 'desc' ? 'desc' : 'asc', cfg.sortable, fallback);

    const [rows, total] = await Promise.all([
      this.delegate(cfg).findMany({
        where,
        include: cfg.include,
        orderBy: [sort, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.delegate(cfg).count({ where }),
    ]);

    return paginate(rows.map((r: any) => this.present(cfg, r)), total, page, limit);
  }

  /** Public (member-facing) list: only ACTIVE records, display order. */
  async listActive(cfg: ReferenceConfig, q: Query) {
    const rows = await this.delegate(cfg).findMany({
      where: { status: 'ACTIVE', ...(cfg.filters?.(q) ?? {}) },
      include: cfg.include,
      orderBy: cfg.hasSortOrder ? [{ sortOrder: 'asc' }, { id: 'asc' }] : [{ [cfg.nameField]: 'asc' }],
    });
    return rows.map((r: any) => this.present(cfg, r));
  }

  async get(cfg: ReferenceConfig, id: number) {
    const row = await this.delegate(cfg).findUnique({ where: { id }, include: cfg.include });
    if (!row) throw new NotFoundException(`${cfg.entity} not found`);
    const usage = await cfg.usage(this.prisma, id);
    return { ...this.present(cfg, row), usageCount: usage };
  }

  private async resolveSlug(cfg: ReferenceConfig, input: Record<string, unknown>, excludeId?: number) {
    const scope = cfg.slugScope?.(input) ?? {};
    const source = (input.slug as string | undefined) || (input[cfg.nameField] as string);
    return uniqueSlug(source, async (slug) => {
      const hit = await this.delegate(cfg).findFirst({ where: { slug, ...scope }, select: { id: true } });
      return !!hit && hit.id !== excludeId;
    });
  }

  async create(cfg: ReferenceConfig, input: Record<string, unknown>, actor: Actor) {
    const slug = await this.resolveSlug(cfg, input);
    const data = cfg.toData ? cfg.toData({ ...input, slug }, 'create') : { ...input, slug };
    const row = await this.delegate(cfg).create({ data, include: cfg.include });
    const result = this.present(cfg, row);
    await this.audit.log({
      actor,
      action: 'create',
      entityType: cfg.entity,
      entityId: row.id,
      summary: `Created ${cfg.entity} "${row[cfg.nameField]}"`,
      after: result,
    });
    return result;
  }

  async update(cfg: ReferenceConfig, id: number, input: Record<string, unknown>, actor: Actor) {
    const before = await this.get(cfg, id);
    const slug = await this.resolveSlug(cfg, { ...before, ...input }, id);
    const payload = { ...input, slug };
    const data = cfg.toData ? cfg.toData(payload, 'update') : payload;
    const row = await this.delegate(cfg).update({ where: { id }, data, include: cfg.include });
    const result = this.present(cfg, row);
    await this.audit.log({
      actor,
      action: 'update',
      entityType: cfg.entity,
      entityId: id,
      summary: `Updated ${cfg.entity} "${row[cfg.nameField]}"`,
      before,
      after: result,
    });
    return result;
  }

  async setStatus(cfg: ReferenceConfig, id: number, status: 'ACTIVE' | 'INACTIVE', actor: Actor) {
    const before = await this.get(cfg, id);
    const row = await this.delegate(cfg).update({ where: { id }, data: { status }, include: cfg.include });
    await this.audit.log({
      actor,
      action: status === 'ACTIVE' ? 'activate' : 'deactivate',
      entityType: cfg.entity,
      entityId: id,
      summary: `${status === 'ACTIVE' ? 'Activated' : 'Deactivated'} ${cfg.entity} "${row[cfg.nameField]}"`,
      before: { status: before.status },
      after: { status },
    });
    return this.present(cfg, row);
  }

  async reorder(cfg: ReferenceConfig, ids: number[], actor: Actor) {
    if (!cfg.hasSortOrder) throw new BadRequestException(`${cfg.label} cannot be reordered`);
    await this.prisma.$transaction(
      ids.map((id, index) => this.delegate(cfg).update({ where: { id }, data: { sortOrder: index } })),
    );
    await this.audit.log({ actor, action: 'reorder', entityType: cfg.entity, summary: `Reordered ${cfg.label}`, after: { ids } });
    return { success: true };
  }

  /** Permanent delete is only allowed when nothing references the record. */
  async remove(cfg: ReferenceConfig, id: number, actor: Actor) {
    const before = await this.get(cfg, id);
    if (before.usageCount > 0) {
      throw new ConflictException(
        `This ${cfg.entity} is used by ${before.usageCount} record(s). Deactivate it instead of deleting.`,
      );
    }
    await this.delegate(cfg).delete({ where: { id } });
    await this.audit.log({
      actor,
      action: 'delete',
      entityType: cfg.entity,
      entityId: id,
      summary: `Deleted ${cfg.entity} "${(before as any)[cfg.nameField]}"`,
      before,
    });
    return { success: true };
  }
}
