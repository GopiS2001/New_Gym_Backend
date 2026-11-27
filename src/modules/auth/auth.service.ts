import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, TokenPurpose, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'crypto';

import { LiveService } from '../../common/live/live.service';
import { codeEmail, MailService } from '../../common/mail/mail.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const BCRYPT_ROUNDS = 12;
const CODE_MINUTES = { EMAIL_VERIFICATION: 30, PASSWORD_RESET: 15 } as const;
const MAX_CODE_ATTEMPTS = 5;

export type ClientMeta = { ip?: string; userAgent?: string };

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly live: LiveService,
  ) {}

  static normaliseEmail(email: string) {
    return email.trim().toLowerCase();
  }

  hashPassword(password: string) {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  // -------------------------------------------------------------------------
  // Registration & login
  // -------------------------------------------------------------------------

  async register(
    input: { name: string; email: string; password: string; onboarding?: Record<string, unknown> },
    meta: ClientMeta,
  ) {
    const email = AuthService.normaliseEmail(input.email);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('An account with this email already exists');

    const user = await this.prisma.user.create({
      data: {
        name: input.name.trim(),
        email,
        passwordHash: await this.hashPassword(input.password),
        type: 'MEMBER',
        profile: {
          create: {
            onboardingStatus: input.onboarding ? 'IN_PROGRESS' : 'NOT_STARTED',
            onboardingDraft: (input.onboarding as Prisma.InputJsonValue) ?? undefined,
          },
        },
        notificationPreference: { create: {} },
      },
    });

    const verification = await this.sendVerificationCode(user);

    const tokens = await this.issueTokens(user, meta);
    return { ...tokens, user: this.publicUser(user), ...this.devOnly({ verificationCode: verification }) };
  }

  async login(input: { email: string; password: string }, meta: ClientMeta, scope: 'MEMBER' | 'ADMIN') {
    const email = AuthService.normaliseEmail(input.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Same message for unknown email and wrong password (no account enumeration).
    const ok = user ? await bcrypt.compare(input.password, user.passwordHash) : false;
    if (!user || !ok) throw new UnauthorizedException('Incorrect email or password');

    if (scope === 'ADMIN' && user.type !== 'ADMIN') {
      throw new ForbiddenException('This account does not have admin access');
    }
    if (user.status === 'SUSPENDED') throw new ForbiddenException('This account is suspended. Contact support.');
    if (user.status !== 'ACTIVE') throw new ForbiddenException('This account is inactive');

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const tokens = await this.issueTokens(user, meta);
    return { ...tokens, user: this.publicUser(user) };
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  private async issueTokens(user: User, meta: ClientMeta, familyId: string = randomUUID()) {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, type: user.type },
      {
        secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
        expiresIn: this.config.get('JWT_ACCESS_TTL', '15m'),
      },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const days = Number(this.config.get('JWT_REFRESH_TTL_DAYS', 30));
    const expiresAt = new Date(Date.now() + days * 86_400_000);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        familyId,
        expiresAt,
        ipAddress: meta.ip?.slice(0, 64),
        userAgent: meta.userAgent?.slice(0, 255),
      },
    });

    return { accessToken, refreshToken, refreshTokenExpiresAt: expiresAt.toISOString() };
  }

  /** Rotates a refresh token. Re-use of a revoked token revokes the whole family. */
  async refresh(refreshToken: string, meta: ClientMeta) {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { user: true },
    });

    if (!record) throw new UnauthorizedException('Invalid refresh token');

    if (record.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(`Refresh token reuse detected for user ${record.userId}; session family revoked`);
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    if (record.expiresAt < new Date()) throw new UnauthorizedException('Session expired. Please sign in again.');
    if (record.user.sessionsRevokedAt && record.createdAt < record.user.sessionsRevokedAt) {
      throw new UnauthorizedException('You were signed out. Please log in again.');
    }
    if (record.user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');

    await this.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    const tokens = await this.issueTokens(record.user, meta, record.familyId);
    return { ...tokens, user: this.publicUser(record.user) };
  }

  async logout(refreshToken?: string) {
    if (!refreshToken) return { success: true };
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (record) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.prisma.user.update({ where: { id: record.userId }, data: { appInBackground: true } }).catch(() => undefined);
    }
    return { success: true };
  }

  /**
   * Ends every session immediately: refresh tokens are revoked and access
   * tokens issued before now stop working on their next request.
   */
  async forceLogout(userId: number) {
    const now = new Date();
    const { count } = await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await this.prisma.user.update({ where: { id: userId }, data: { sessionsRevokedAt: now, appInBackground: true } });
    // Open apps are told right away instead of on their next request.
    this.live.signOut(userId, 'force_logout');
    return { revokedSessions: count };
  }

  /** App heartbeat: 'active' while open, 'background' when sent to the background. */
  async presence(userId: number, state: 'active' | 'background') {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastSeenAt: new Date(), appInBackground: state === 'background' },
    });
    return { success: true };
  }

  /** Revokes refresh tokens; with a reason, open apps are also signed out instantly. */
  async revokeAllSessions(userId: number, reason?: 'suspended' | 'password_reset') {
    await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (reason) this.live.signOut(userId, reason);
  }

  // -------------------------------------------------------------------------
  // Email verification & password reset
  // -------------------------------------------------------------------------

  async issueOneTimeToken(userId: number, purpose: TokenPurpose, ttlHours: number) {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.oneTimeToken.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: new Date() },
    });
    await this.prisma.oneTimeToken.create({
      data: { userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlHours * 3_600_000) },
    });
    return token;
  }

  private async consumeOneTimeToken(token: string, purpose: TokenPurpose) {
    const record = await this.prisma.oneTimeToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.purpose !== purpose || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('This link is invalid or has expired');
    }
    await this.prisma.oneTimeToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    return record;
  }

  // ---- 6-digit email codes -------------------------------------------------

  private codeHash(purpose: TokenPurpose, userId: number, code: string) {
    return sha256(`${purpose}:${userId}:${code}`);
  }

  /** New 6-digit code (older unused codes for the same purpose stop working). */
  private async issueCode(userId: number, purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET') {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.oneTimeToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
    await this.prisma.oneTimeToken.create({
      data: {
        userId,
        purpose,
        tokenHash: this.codeHash(purpose, userId, code),
        expiresAt: new Date(Date.now() + CODE_MINUTES[purpose] * 60_000),
      },
    });
    return code;
  }

  /** Checks a code; wrong entries count toward a lockout of the current code. */
  private async consumeCode(userId: number, purpose: TokenPurpose, code: string, markUsed = true) {
    const record = await this.prisma.oneTimeToken.findFirst({
      where: { userId, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!record) throw new BadRequestException('This code has expired. Request a new one.');
    if (record.attempts >= MAX_CODE_ATTEMPTS) throw new BadRequestException('Too many wrong attempts. Request a new code.');
    const expected = Buffer.from(record.tokenHash);
    const given = Buffer.from(this.codeHash(purpose, userId, code.trim()));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      const left = MAX_CODE_ATTEMPTS - record.attempts - 1;
      await this.prisma.oneTimeToken.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException(left > 0 ? `That code isn't right. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Request a new code.');
    }
    if (markUsed) await this.prisma.oneTimeToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    return record;
  }

  private async sendVerificationCode(user: { id: number; name: string; email: string }) {
    const code = await this.issueCode(user.id, 'EMAIL_VERIFICATION');
    const mail = codeEmail({
      name: user.name.split(' ')[0] || user.name,
      heading: 'Verify your email',
      intro: 'enter this code in the FitFlow app to confirm your email address.',
      code,
      minutes: CODE_MINUTES.EMAIL_VERIFICATION,
      footer: "If you didn't create a FitFlow account, you can ignore this email.",
    });
    void this.mail.send(user.email, `${code} is your FitFlow verification code`, mail.html, mail.text);
    return code;
  }

  async verifyEmailCode(userId: number, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) return { success: true, alreadyVerified: true };
    await this.consumeCode(userId, 'EMAIL_VERIFICATION', code);
    await this.prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    return { success: true };
  }

  /** Older link-style tokens (kept for compatibility). */
  async verifyEmail(token: string) {
    const record = await this.consumeOneTimeToken(token, 'EMAIL_VERIFICATION');
    await this.prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
    return { success: true };
  }

  async resendVerification(userId: number) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) return { success: true, alreadyVerified: true };
    const code = await this.sendVerificationCode(user);
    return { success: true, emailSent: this.mail.configured, ...this.devOnly({ verificationCode: code }) };
  }

  /** Always responds with success so the endpoint cannot be used to discover accounts. */
  async forgotPassword(emailInput: string) {
    const email = AuthService.normaliseEmail(emailInput);
    const user = await this.prisma.user.findUnique({ where: { email } });
    let code: string | undefined;
    if (user && user.status === 'ACTIVE') {
      code = await this.issueCode(user.id, 'PASSWORD_RESET');
      const mail = codeEmail({
        name: user.name.split(' ')[0] || user.name,
        heading: 'Reset your password',
        intro: 'use this code in the FitFlow app to choose a new password.',
        code,
        minutes: CODE_MINUTES.PASSWORD_RESET,
        footer: "If you didn't ask to reset your password, you can ignore this email — your password won't change.",
      });
      const firstName = user.name.split(' ')[0] || user.name;
      void this.mail.sendTemplate(
        user.email,
        Number(this.config.get('BREVO_TEMPLATE_PASSWORD_RESET')) || undefined,
        { name: firstName, code, minutes: CODE_MINUTES.PASSWORD_RESET },
        { subject: `${code} is your FitFlow password reset code`, html: mail.html, text: mail.text },
      );
    }
    return {
      success: true,
      message: 'If an account exists for that email, we sent a 6-digit reset code.',
      ...this.devOnly({ resetCode: code }),
    };
  }

  /** Step 2 of forgot password: is this code right? Wrong tries still count toward the lockout. */
  async checkResetCode(emailInput: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { email: AuthService.normaliseEmail(emailInput) } });
    if (!user) throw new BadRequestException('This code has expired. Request a new one.');
    await this.consumeCode(user.id, 'PASSWORD_RESET', code, false);
    return { success: true };
  }

  /** Reset with { email, code } (app) or a legacy link token. */
  async resetPassword(input: { token?: string; email?: string; code?: string }, password: string) {
    let record: { userId: number };
    if (input.email && input.code) {
      const user = await this.prisma.user.findUnique({ where: { email: AuthService.normaliseEmail(input.email) } });
      if (!user) throw new BadRequestException('This code has expired. Request a new one.');
      record = await this.consumeCode(user.id, 'PASSWORD_RESET', input.code);
    } else if (input.token) {
      record = await this.consumeOneTimeToken(input.token, 'PASSWORD_RESET');
    } else {
      throw new BadRequestException('Enter the code from your email');
    }
    await this.prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await this.hashPassword(password) },
    });
    await this.revokeAllSessions(record.userId, 'password_reset');
    return { success: true };
  }

  /** Signed-in user sets a new password (no current password needed). */
  async changePassword(userId: number, newPassword: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await this.hashPassword(newPassword) } });
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Me
  // -------------------------------------------------------------------------

  async me(userId: number) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
        profile: { select: { onboardingStatus: true, onboardingStep: true } },
      },
    });
    return {
      ...this.publicUser(user),
      role: user.role ? { key: user.role.key, name: user.role.name } : null,
      permissions: user.role?.permissions.map((p) => p.permission.key) ?? [],
      onboarding: user.profile ?? null,
    };
  }

  publicUser(user: User) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      type: user.type,
      status: user.status,
      avatarUrl: user.avatarUrl,
      emailVerified: !!user.emailVerifiedAt,
      createdAt: user.createdAt,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * No email provider is configured yet: messages are written to the server
   * log. Swap this for an SMTP / transactional email provider in production.
   */
  /** Development without SMTP: return codes in the response so the app can be tested. */
  private devOnly<T extends object>(data: T): Partial<T> {
    return this.config.get('NODE_ENV') === 'production' || this.mail.configured ? {} : data;
  }
}
