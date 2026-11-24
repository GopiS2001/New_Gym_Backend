import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';

import { AdminOnly, AuthUser, CurrentUser, Public } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/pipes/zod';
import { AuthService, ClientMeta } from './auth.service';

export const zPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[0-9]/, 'Password must include a number');

const RegisterSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your full name').max(120),
    email: z.string().trim().email('Enter a valid email address').max(191),
    password: zPassword,
    confirmPassword: z.string(),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the Terms and Privacy Policy' }) }),
    onboarding: z.record(z.unknown()).optional(),
  })
  .refine((d) => d.password === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

const LoginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

const RefreshSchema = z.object({ refreshToken: z.string().min(20) });
const PresenceSchema = z.object({ state: z.enum(['active', 'background']) });
const LogoutSchema = z.object({ refreshToken: z.string().optional() });
const TokenSchema = z.object({ token: z.string().min(10) });
const ForgotSchema = z.object({ email: z.string().trim().email() });
const zCode = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');
const VerifyCodeSchema = z.object({ code: zCode });
const ResetSchema = z
  .object({
    token: z.string().min(10).optional(),
    email: z.string().trim().email().optional(),
    code: zCode.optional(),
    password: zPassword,
    confirmPassword: z.string(),
  })
  .refine((d) => d.token || (d.email && d.code), { path: ['code'], message: 'Enter the 6-digit code from your email' })
  .refine((d) => d.password === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });
const ChangePasswordSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: zPassword, confirmPassword: z.string() })
  .refine((d) => d.newPassword === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

const meta = (req: Request): ClientMeta => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  register(@Body(new ZodPipe(RegisterSchema)) body: z.infer<typeof RegisterSchema>, @Req() req: Request) {
    return this.auth.register(body, meta(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  login(@Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>, @Req() req: Request) {
    return this.auth.login(body, meta(req), 'MEMBER');
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body(new ZodPipe(RefreshSchema)) body: z.infer<typeof RefreshSchema>, @Req() req: Request) {
    return this.auth.refresh(body.refreshToken, meta(req));
  }

  @Public()
  @HttpCode(200)
  @Post('logout')
  logout(@Body(new ZodPipe(LogoutSchema)) body: z.infer<typeof LogoutSchema>) {
    return this.auth.logout(body.refreshToken);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('verify-email')
  verifyEmail(@Body(new ZodPipe(TokenSchema)) body: z.infer<typeof TokenSchema>) {
    return this.auth.verifyEmail(body.token);
  }

  /** Signed-in member enters the 6-digit code from the email. */
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('verify-email-code')
  verifyEmailCode(@CurrentUser() user: AuthUser, @Body(new ZodPipe(VerifyCodeSchema)) body: z.infer<typeof VerifyCodeSchema>) {
    return this.auth.verifyEmailCode(user.id, body.code);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(200)
  @Post('resend-verification')
  resendVerification(@CurrentUser() user: AuthUser) {
    return this.auth.resendVerification(user.id);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('forgot-password')
  forgotPassword(@Body(new ZodPipe(ForgotSchema)) body: z.infer<typeof ForgotSchema>) {
    return this.auth.forgotPassword(body.email);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('reset-password')
  resetPassword(@Body(new ZodPipe(ResetSchema)) body: z.infer<typeof ResetSchema>) {
    return this.auth.resetPassword(body, body.password);
  }

  @ApiBearerAuth()
  @HttpCode(200)
  @Post('change-password')
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(ChangePasswordSchema)) body: z.infer<typeof ChangePasswordSchema>,
  ) {
    return this.auth.changePassword(user.id, body.currentPassword, body.newPassword);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}

@ApiTags('Admin · Auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  login(@Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>, @Req() req: Request) {
    return this.auth.login(body, meta(req), 'ADMIN');
  }

  @ApiBearerAuth()
  @AdminOnly()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}

/** App heartbeat for the admin "online / offline" view. */
@ApiTags('Presence')
@ApiBearerAuth()
@Controller('presence')
export class PresenceController {
  constructor(private readonly auth: AuthService) {}

  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  presence(@CurrentUser() user: AuthUser, @Body(new ZodPipe(PresenceSchema)) body: z.infer<typeof PresenceSchema>) {
    return this.auth.presence(user.id, body.state);
  }
}
