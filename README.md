# Premium Fitness — Backend API

NestJS + Prisma + MySQL. Single source of truth for the member app (`../App`) and the admin dashboard (`../Dashboard`).

## Quick start

```bash
npm install
cp .env.example .env          # set DATABASE_URL, JWT secrets, seed admin
npm run db:deploy             # apply migrations (creates the database tables)
npm run db:seed               # roles, permissions, Super Admin, reference data, starter catalogue
npm run dev                   # http://localhost:4100/api/v1  ·  Swagger: http://localhost:4100/api/docs
```

Local `.env` points at `mysql://root:…@localhost:3306/premium_gym`. The password is URL-encoded (`@` → `%40`).

Seeded Super Admin: `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (`admin@gym.local` / `Admin@12345` locally — **change it**).

| Script | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Watch mode / compile / run `dist` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | Create a new migration after editing `prisma/schema.prisma` |
| `npm run db:deploy` | Apply migrations (CI / production) |
| `npm run db:seed` | Idempotent seed — safe to re-run |
| `npm run db:reset` | Drop, re-migrate and re-seed (**destroys data**) |
| `npm run db:studio` | Prisma Studio |

## Architecture

```
src/
  common/          prisma, global auth guard + RBAC decorators, zod validation pipe,
                   error filter (uniform envelope), Decimal serializer, audit service
  modules/
    auth/          member + admin login, rotating refresh tokens, verify email, reset password
    reference/     one config-driven CRUD for goals, focus areas, exercise categories,
                   exercise types, equipment, equipment groups, muscles, experience
                   levels, onboarding options (admin + public read endpoints)
    exercises/     admin CRUD/publish/archive/duplicate + discovery, detail, history, programs
    programs/      program builder (weeks → workouts → exercises, id-preserving sync),
                   publish/duplicate, member enrollment and progress
    content/       coaches (verified-credentials-only to members), workout templates,
                   featured collections
    admin/         dashboard KPIs, members, admin users & roles, media, notifications, audit logs
    member/        onboarding (draft + resume + complete), profile, home & recommendations,
                   library & collections, workout sessions (offline sync, idempotent sets)
prisma/            schema, migrations, seed
uploads/           local media storage (served at /uploads) — swap for object storage + CDN in prod
```

### Conventions

- All routes under `/api/v1`. Lists return `{ data, meta: { page, limit, total, totalPages } }`.
- Errors: `{ statusCode, error, message, details?, path, timestamp }`; validation `details` are `[{ field, message }]`.
- Every route is authenticated unless marked `@Public()`. Admin routes declare `@RequirePermissions(...)` and are enforced server-side.
- Access token: 15 min JWT. Refresh token: opaque, stored hashed, rotated on every use; reuse revokes the session family.
- Content referenced by history is archived/deactivated, never hard-deleted (hard delete is refused with 409 when in use).
- Admin mutations are written to `admin_audit_logs` with before/after snapshots (secrets redacted).
- Weights/distances carry explicit units; timestamps are UTC.

### Permissions & roles

`dashboard.view, users.view, users.manage, users.export, content.view, content.manage, media.manage, notifications.manage, admins.manage, audit.view`

Built-in roles: **Super Admin** (all), **Content Admin**, **Support Admin**, **Analyst**. Custom roles can be created in the dashboard.

## Not yet wired (by design / needs a provider)

- **Email delivery** — verification and reset tokens are logged to the server console (`AuthService.deliver`). In non-production responses also include the token for testing. Plug in SMTP / a transactional provider.
- **Push delivery** — templates, audience targeting and device-token registration exist; a sender worker (e.g. Expo push) is the next step with the mobile app.
- **Video thumbnails** — images get WebP thumbnails via `sharp`; videos need ffmpeg.
- **Object storage/CDN** — media is on local disk; set `MEDIA_BASE_URL` and replace the write in `MediaService` for S3/R2/etc.
