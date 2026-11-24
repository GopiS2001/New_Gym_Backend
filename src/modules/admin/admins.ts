import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
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

import { AuditService } from '../../common/audit/audit.service';
import { Actor, CurrentActor, RequirePermissions } from '../../common/auth/decorators';
import { PERMISSIONS } from '../../common/auth/permissions';
import { zId, zListQuery, ZodPipe } from '../../common/pipes/zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { paginate, slugify } from '../../common/utils/helpers';
import { zPassword } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';

const CreateAdminSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(191),
  password: zPassword,
  roleId: zId,
});
const UpdateAdminSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  roleId: zId.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
const RoleSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(255).nullish(),
  permissionKeys: z.array(z.string()).default([]),
});

const adminSelect = {
  id: true,
  name: true,
  email: true,
  status: true,
  avatarUrl: true,
  lastLoginAt: true,
  createdAt: true,
  role: { select: { id: true, key: true, name: true } },
} satisfies Prisma.UserSelect;

@Injectable()
export class AdminsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  // ---- Admin users ---------------------------------------------------------

  async list(q: z.infer<typeof zListQuery>) {
    const where: Prisma.UserWhereInput = {
      type: 'ADMIN',
      ...(q.search ? { OR: [{ name: { contains: q.search } }, { email: { contains: q.search } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: adminSelect, orderBy: { createdAt: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(rows, total, q.page, q.limit);
  }

  async create(input: z.infer<typeof CreateAdminSchema>, actor: Actor) {
    const email = AuthService.normaliseEmail(input.email);
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('Email is already registered');
    const role = await this.prisma.role.findUnique({ where: { id: input.roleId } });
    if (!role) throw new BadRequestException('Role not found');
    const user = await this.prisma.user.create({
      data: {
        name: input.name,
        email,
        passwordHash: await this.auth.hashPassword(input.password),
        type: 'ADMIN',
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: adminSelect,
    });
    await this.audit.log({ actor, action: 'create', entityType: 'AdminUser', entityId: user.id, summary: `Created admin ${email} (${role.name})`, after: user });
    return user;
  }

  private async assertNotLastSuperAdmin(userId: number) {
    const target = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
    if (target?.role?.key !== 'super_admin') return;
    const count = await this.prisma.user.count({ where: { type: 'ADMIN', status: 'ACTIVE', role: { key: 'super_admin' } } });
    if (count <= 1) throw new BadRequestException('At least one active Super Admin is required');
  }

  async update(id: number, input: z.infer<typeof UpdateAdminSchema>, actor: Actor) {
    const before = await this.prisma.user.findFirst({ where: { id, type: 'ADMIN' }, select: adminSelect });
    if (!before) throw new NotFoundException('Admin user not found');
    if (id === actor.userId && (input.status === 'INACTIVE' || (input.roleId && input.roleId !== before.role?.id))) {
      throw new ForbiddenException('You cannot change your own role or deactivate yourself');
    }
    if ((input.roleId && input.roleId !== before.role?.id) || input.status === 'INACTIVE') {
      await this.assertNotLastSuperAdmin(id);
    }
    const after = await this.prisma.user.update({ where: { id }, data: input, select: adminSelect });
    if (input.status === 'INACTIVE') await this.auth.revokeAllSessions(id);
    await this.audit.log({ actor, action: 'update', entityType: 'AdminUser', entityId: id, summary: `Updated admin ${before.email}`, before, after });
    return after;
  }

  async sendReset(id: number, actor: Actor) {
    const user = await this.prisma.user.findFirst({ where: { id, type: 'ADMIN' } });
    if (!user) throw new NotFoundException('Admin user not found');
    const result = await this.auth.forgotPassword(user.email);
    await this.audit.log({ actor, action: 'password_reset_sent', entityType: 'AdminUser', entityId: id, summary: `Sent password reset to ${user.email}` });
    return { success: true, message: `A password reset link was sent to ${user.email}`, ...('resetToken' in result ? { resetToken: result.resetToken } : {}) };
  }

  // ---- Roles ---------------------------------------------------------------

  async roles() {
    const rows = await this.prisma.role.findMany({
      orderBy: { id: 'asc' },
      include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
    });
    return rows.map(({ permissions, _count, ...r }) => ({
      ...r,
      permissionKeys: permissions.map((p) => p.permission.key),
      userCount: _count.users,
    }));
  }

  permissions() {
    return this.prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { key: 'asc' }] });
  }

  private async permissionIds(keys: string[]) {
    const perms = await this.prisma.permission.findMany({ where: { key: { in: keys } } });
    if (perms.length !== new Set(keys).size) throw new BadRequestException('Unknown permission key');
    return perms.map((p) => p.id);
  }

  async createRole(input: z.infer<typeof RoleSchema>, actor: Actor) {
    const key = slugify(input.name).replace(/-/g, '_');
    if (await this.prisma.role.findUnique({ where: { key } })) throw new ConflictException('A role with this name exists');
    const ids = await this.permissionIds(input.permissionKeys);
    const role = await this.prisma.role.create({
      data: { key, name: input.name, description: input.description, permissions: { create: ids.map((permissionId) => ({ permissionId })) } },
    });
    await this.audit.log({ actor, action: 'create', entityType: 'Role', entityId: role.id, summary: `Created role ${role.name}`, after: input });
    return role;
  }

  async updateRole(id: number, input: Partial<z.infer<typeof RoleSchema>>, actor: Actor) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { permissions: { include: { permission: true } } } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.key === 'super_admin' && input.permissionKeys) {
      throw new ForbiddenException('Super Admin permissions cannot be changed');
    }
    const ids = input.permissionKeys ? await this.permissionIds(input.permissionKeys) : undefined;
    const after = await this.prisma.role.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(ids ? { permissions: { deleteMany: {}, create: ids.map((permissionId) => ({ permissionId })) } } : {}),
      },
    });
    await this.audit.log({
      actor,
      action: 'update',
      entityType: 'Role',
      entityId: id,
      summary: `Updated role ${role.name}`,
      before: { name: role.name, permissionKeys: role.permissions.map((p) => p.permission.key) },
      after: input,
    });
    return after;
  }

  async deleteRole(id: number, actor: Actor) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new ForbiddenException('Built-in roles cannot be deleted');
    if (role._count.users) throw new ConflictException('Reassign admins using this role before deleting it');
    await this.prisma.role.delete({ where: { id } });
    await this.audit.log({ actor, action: 'delete', entityType: 'Role', entityId: id, summary: `Deleted role ${role.name}` });
    return { success: true };
  }
}

@ApiTags('Admin · Administrators')
@ApiBearerAuth()
@RequirePermissions(PERMISSIONS.ADMINS_MANAGE)
@Controller('admin')
export class AdminsController {
  constructor(private readonly service: AdminsService) {}

  @Get('admin-users')
  list(@Query(new ZodPipe(zListQuery)) q: z.infer<typeof zListQuery>) {
    return this.service.list(q);
  }

  @Post('admin-users')
  create(@Body(new ZodPipe(CreateAdminSchema)) body: z.infer<typeof CreateAdminSchema>, @CurrentActor() actor: Actor) {
    return this.service.create(body, actor);
  }

  @Patch('admin-users/:id')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(UpdateAdminSchema)) body: z.infer<typeof UpdateAdminSchema>, @CurrentActor() actor: Actor) {
    return this.service.update(id, body, actor);
  }

  @HttpCode(200)
  @Post('admin-users/:id/reset-password')
  reset(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
    return this.service.sendReset(id, actor);
  }

  @Get('roles')
  roles() {
    return this.service.roles();
  }

  @Get('permissions')
  permissions() {
    return this.service.permissions();
  }

  @Post('roles')
  createRole(@Body(new ZodPipe(RoleSchema)) body: z.infer<typeof RoleSchema>, @CurrentActor() actor: Actor) {
    return this.service.createRole(body, actor);
  }

  @Patch('roles/:id')
  updateRole(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(RoleSchema.partial())) body: Partial<z.infer<typeof RoleSchema>>, @CurrentActor() actor: Actor) {
    return this.service.updateRole(id, body, actor);
  }

  @Delete('roles/:id')
  deleteRole(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor) {
    return this.service.deleteRole(id, actor);
  }
}
