import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { LAST_SEEN_THROTTLE_MS } from './presence';
import {
  ADMIN_ONLY_KEY,
  AuthUser,
  IS_PUBLIC_KEY,
  OPTIONAL_AUTH_KEY,
  PERMISSIONS_KEY,
} from './decorators';

type AccessPayload = { sub: number; email: string; type: 'MEMBER' | 'ADMIN'; iat?: number };

/**
 * Global guard: verifies the bearer access token, re-loads the user (so a
 * suspended account or changed role takes effect immediately) and enforces
 * admin-only / permission metadata.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
    const optional = this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH_KEY, targets);
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    const token = this.extractToken(req);

    if (isPublic && !optional) return true;

    if (!token) {
      if (optional) return true;
      throw new UnauthorizedException('Authentication required');
    }

    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token, {
        secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
      });
    } catch {
      if (optional) return true;
      throw new UnauthorizedException('Access token is invalid or expired');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });

    if (!user || user.status !== 'ACTIVE') {
      if (optional) return true;
      throw new UnauthorizedException('Account is not active');
    }

    // Admin "force logout": every access token issued before that moment is dead.
    if (user.sessionsRevokedAt && (payload.iat ?? 0) * 1000 < user.sessionsRevokedAt.getTime()) {
      if (optional) return true;
      throw new UnauthorizedException('You were signed out. Please log in again.');
    }

    // Presence: any authenticated request means the user is active (throttled write).
    if (!user.lastSeenAt || Date.now() - user.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS || user.appInBackground) {
      if (!req.path.endsWith('/presence')) {
        this.prisma.user
          .update({ where: { id: user.id }, data: { lastSeenAt: new Date(), appInBackground: false } })
          .catch(() => undefined);
      }
    }

    req.user = {
      id: user.id,
      email: user.email,
      type: user.type,
      role: user.role?.key ?? null,
      permissions: user.role?.permissions.map((rp) => rp.permission.key) ?? [],
    };

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? [];
    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY_KEY, targets);

    if ((adminOnly || required.length) && user.type !== 'ADMIN') {
      throw new ForbiddenException('Admin access required');
    }

    const missing = required.filter((p) => !req.user!.permissions.includes(p));
    if (missing.length) {
      throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    }

    return true;
  }

  private extractToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}
