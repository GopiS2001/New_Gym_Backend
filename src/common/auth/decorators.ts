import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { PermissionKey } from './permissions';

export const IS_PUBLIC_KEY = 'isPublic';
export const PERMISSIONS_KEY = 'permissions';
export const ADMIN_ONLY_KEY = 'adminOnly';
export const OPTIONAL_AUTH_KEY = 'optionalAuth';

/** Route needs no authentication. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Route works for guests, but attaches the user when a valid token is sent. */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH_KEY, true);

/** Route (or controller) requires an ADMIN user holding every listed permission. */
export const RequirePermissions = (...permissions: PermissionKey[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/** Route (or controller) requires an ADMIN user (any role). */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY_KEY, true);

export type AuthUser = {
  id: number;
  email: string;
  type: 'MEMBER' | 'ADMIN';
  role: string | null;
  permissions: string[];
};

export type Actor = {
  userId: number;
  ip?: string;
  userAgent?: string;
};

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request & { user: AuthUser }>();
  return req.user;
});

/** Admin identity + request metadata, used for audit logging. */
export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<Request & { user: AuthUser }>();
  return {
    userId: req.user?.id,
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 255),
  };
});
