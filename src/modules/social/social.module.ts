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
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { AuthUser, CurrentUser } from '../../common/auth/decorators';
import { LiveService } from '../../common/live/live.service';
import { zId, ZodPipe } from '../../common/pipes/zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { paginate } from '../../common/utils/helpers';

/** The Super Admin never appears in, or uses, the friends feature. */
const SUPER_ADMIN = 'super_admin';

const PeopleQuery = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
const SendSchema = z.object({ userId: zId });

export type Relation = 'none' | 'friends' | 'request_sent' | 'request_received';

const personSelect = { id: true, name: true, avatarUrl: true, friendCount: true, lastSeenAt: true, appInBackground: true } as const;

const pair = (a: number, b: number) => (a < b ? { userAId: a, userBId: b } : { userAId: b, userBId: a });

@Injectable()
export class SocialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
  ) {}

  /** Who can take part: active accounts that are not the Super Admin. */
  private eligible(): Prisma.UserWhereInput {
    return { status: 'ACTIVE', OR: [{ roleId: null }, { role: { key: { not: SUPER_ADMIN } } }] };
  }

  assertParticipant(user: AuthUser) {
    if (user.role === SUPER_ADMIN) throw new ForbiddenException('The Super Admin account does not use friends');
  }

  /** Recomputes the stored friend count from the friendships table (always exact). */
  private async syncCounts(tx: Prisma.TransactionClient, ...userIds: number[]) {
    for (const id of new Set(userIds)) {
      const count = await tx.friendship.count({ where: { OR: [{ userAId: id }, { userBId: id }] } });
      await tx.user.updateMany({ where: { id }, data: { friendCount: count } });
    }
  }

  // ---- people -------------------------------------------------------------

  async people(me: AuthUser, q: z.infer<typeof PeopleQuery>) {
    this.assertParticipant(me);
    const where: Prisma.UserWhereInput = {
      AND: [this.eligible(), { id: { not: me.id } }, q.search ? { OR: [{ name: { contains: q.search } }, { email: { contains: q.search } }] } : {}],
    };
    const [rows, total, rel] = await Promise.all([
      this.prisma.user.findMany({ where, select: personSelect, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.user.count({ where }),
      this.relations(me.id),
    ]);
    return paginate(rows.map((u) => this.presentPerson(u, rel)), total, q.page, q.limit);
  }

  private async relations(meId: number) {
    const [friends, pending] = await Promise.all([
      this.prisma.friendship.findMany({ where: { OR: [{ userAId: meId }, { userBId: meId }] } }),
      this.prisma.friendRequest.findMany({ where: { status: 'PENDING', OR: [{ fromUserId: meId }, { toUserId: meId }] } }),
    ]);
    const friendIds = new Set(friends.map((f) => (f.userAId === meId ? f.userBId : f.userAId)));
    const sent = new Map(pending.filter((r) => r.fromUserId === meId).map((r) => [r.toUserId, r.id]));
    const received = new Map(pending.filter((r) => r.toUserId === meId).map((r) => [r.fromUserId, r.id]));
    return { friendIds, sent, received };
  }

  private presentPerson(u: Prisma.UserGetPayload<{ select: typeof personSelect }>, rel: Awaited<ReturnType<SocialService['relations']>>) {
    const relation: Relation = rel.friendIds.has(u.id) ? 'friends' : rel.sent.has(u.id) ? 'request_sent' : rel.received.has(u.id) ? 'request_received' : 'none';
    return {
      id: u.id,
      name: u.name,
      avatarUrl: u.avatarUrl,
      friendCount: u.friendCount,
      online: !!u.lastSeenAt && !u.appInBackground && Date.now() - u.lastSeenAt.getTime() < 150_000,
      relation,
      requestId: rel.sent.get(u.id) ?? rel.received.get(u.id) ?? null,
    };
  }

  // ---- friends ------------------------------------------------------------

  async friends(me: AuthUser) {
    this.assertParticipant(me);
    const rows = await this.prisma.friendship.findMany({
      where: { OR: [{ userAId: me.id }, { userBId: me.id }] },
      include: { userA: { select: personSelect }, userB: { select: personSelect } },
      orderBy: { createdAt: 'desc' },
    });
    const meRow = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { friendCount: true } });
    const rel = { friendIds: new Set<number>(), sent: new Map(), received: new Map() };
    return {
      friendCount: meRow.friendCount,
      data: rows.map((f) => {
        const other = f.userAId === me.id ? f.userB : f.userA;
        rel.friendIds.add(other.id);
        return { ...this.presentPerson(other, rel), friendsSince: f.createdAt };
      }),
    };
  }

  async removeFriend(me: AuthUser, otherId: number) {
    this.assertParticipant(me);
    const key = pair(me.id, otherId);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.friendship.deleteMany({ where: key });
      if (!count) throw new NotFoundException('You are not friends with this member');
      await this.syncCounts(tx, me.id, otherId);
    });
    this.live.send(otherId, { type: 'friends_changed' });
    return { success: true };
  }

  // ---- requests -----------------------------------------------------------

  async requests(me: AuthUser) {
    this.assertParticipant(me);
    const include = { fromUser: { select: personSelect }, toUser: { select: personSelect } };
    const [incoming, outgoing] = await Promise.all([
      this.prisma.friendRequest.findMany({ where: { toUserId: me.id, status: 'PENDING' }, include, orderBy: { createdAt: 'desc' } }),
      this.prisma.friendRequest.findMany({ where: { fromUserId: me.id, status: 'PENDING' }, include, orderBy: { createdAt: 'desc' } }),
    ]);
    const rel = await this.relations(me.id);
    return {
      incoming: incoming.map((r) => ({ id: r.id, createdAt: r.createdAt, person: this.presentPerson(r.fromUser, rel) })),
      outgoing: outgoing.map((r) => ({ id: r.id, createdAt: r.createdAt, person: this.presentPerson(r.toUser, rel) })),
    };
  }

  async send(me: AuthUser, toUserId: number) {
    this.assertParticipant(me);
    if (toUserId === me.id) throw new BadRequestException("You can't add yourself");
    const target = await this.prisma.user.findFirst({ where: { AND: [{ id: toUserId }, this.eligible()] }, select: { id: true, name: true } });
    if (!target) throw new NotFoundException('Member not found');
    if (await this.prisma.friendship.findUnique({ where: { userAId_userBId: pair(me.id, toUserId) } })) throw new ConflictException(`You're already friends with ${target.name}`);

    // They already asked me: accept theirs instead of creating a second request.
    const reverse = await this.prisma.friendRequest.findFirst({ where: { fromUserId: toUserId, toUserId: me.id, status: 'PENDING' } });
    if (reverse) return { ...(await this.respond(me, reverse.id, true)), autoAccepted: true };

    const existing = await this.prisma.friendRequest.findFirst({ where: { fromUserId: me.id, toUserId, status: 'PENDING' } });
    if (existing) throw new ConflictException('Friend request already sent');

    const meRow = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { name: true, avatarUrl: true } });
    const request = await this.prisma.friendRequest.create({ data: { fromUserId: me.id, toUserId } });
    await this.notify(toUserId, {
      type: 'friend_request',
      title: `${meRow.name} sent you a friend request`,
      body: 'Accept to train together and see each other in your friends list.',
      data: { requestId: request.id, fromUserId: me.id, fromName: meRow.name, fromAvatarUrl: meRow.avatarUrl },
    });
    return { success: true, requestId: request.id, relation: 'request_sent' as Relation };
  }

  /** Accept or reject a request sent to me. */
  async respond(me: AuthUser, requestId: number, accept: boolean) {
    this.assertParticipant(me);
    const req = await this.prisma.friendRequest.findUnique({ where: { id: requestId } });
    if (!req || req.toUserId !== me.id) throw new NotFoundException('Friend request not found');
    if (req.status !== 'PENDING') throw new ConflictException(`This request was already ${req.status.toLowerCase()}`);

    await this.prisma.$transaction(async (tx) => {
      await tx.friendRequest.update({ where: { id: req.id }, data: { status: accept ? 'ACCEPTED' : 'REJECTED', respondedAt: new Date() } });
      if (accept) {
        const key = pair(req.fromUserId, req.toUserId);
        await tx.friendship.upsert({ where: { userAId_userBId: key }, create: key, update: {} });
        await this.syncCounts(tx, req.fromUserId, req.toUserId);
      }
    });
    // The request notification has been handled.
    await this.prisma.memberNotification.updateMany({
      where: { userId: me.id, type: 'friend_request', readAt: null, data: { path: '$.requestId', equals: req.id } },
      data: { readAt: new Date() },
    });

    // The person who sent the request is told either way.
    const meRow = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { name: true, avatarUrl: true } });
    await this.notify(req.fromUserId, {
      type: accept ? 'friend_accepted' : 'friend_rejected',
      title: accept ? `${meRow.name} accepted your friend request` : `${meRow.name} declined your friend request`,
      body: accept ? "You're now friends." : 'You can send another request later.',
      data: { userId: me.id, fromName: meRow.name, fromAvatarUrl: meRow.avatarUrl },
    });
    return { success: true, relation: (accept ? 'friends' : 'none') as Relation };
  }

  /** Withdraw a request I sent (removes it from their notifications). */
  async cancel(me: AuthUser, requestId: number) {
    this.assertParticipant(me);
    const req = await this.prisma.friendRequest.findUnique({ where: { id: requestId } });
    if (!req || req.fromUserId !== me.id || req.status !== 'PENDING') throw new NotFoundException('Friend request not found');
    await this.prisma.friendRequest.update({ where: { id: req.id }, data: { status: 'CANCELLED', respondedAt: new Date() } });
    await this.prisma.memberNotification.deleteMany({ where: { userId: req.toUserId, type: 'friend_request', data: { path: '$.requestId', equals: req.id } } });
    this.live.send(req.toUserId, { type: 'notifications_changed' });
    return { success: true, relation: 'none' as Relation };
  }

  // ---- notifications ------------------------------------------------------

  private async notify(userId: number, n: { type: string; title: string; body?: string; data?: Prisma.InputJsonValue }) {
    const row = await this.prisma.memberNotification.create({ data: { userId, ...n } });
    // Instant delivery to the person's open app (they also see it in their inbox).
    this.live.send(userId, { type: 'notification', notification: { id: row.id, type: row.type, title: row.title, body: row.body, data: row.data } });
    return row;
  }

  async notifications(me: AuthUser) {
    const rows = await this.prisma.memberNotification.findMany({ where: { userId: me.id }, orderBy: { createdAt: 'desc' }, take: 60 });
    const requestIds = rows.filter((r) => r.type === 'friend_request').map((r) => Number((r.data as { requestId?: number } | null)?.requestId)).filter(Boolean);
    const statuses = new Map(
      (await this.prisma.friendRequest.findMany({ where: { id: { in: requestIds } }, select: { id: true, status: true } })).map((r) => [r.id, r.status]),
    );
    const unread = await this.prisma.memberNotification.count({ where: { userId: me.id, readAt: null } });
    return {
      unread,
      data: rows.map((r) => {
        const requestId = r.type === 'friend_request' ? Number((r.data as { requestId?: number } | null)?.requestId) : null;
        return { ...r, requestStatus: requestId ? (statuses.get(requestId) ?? 'CANCELLED') : null };
      }),
    };
  }

  async unreadCount(me: AuthUser) {
    return { unread: await this.prisma.memberNotification.count({ where: { userId: me.id, readAt: null } }) };
  }

  async markRead(me: AuthUser, id?: number) {
    await this.prisma.memberNotification.updateMany({ where: { userId: me.id, readAt: null, ...(id ? { id } : {}) }, data: { readAt: new Date() } });
    return { success: true };
  }

  /** Before an account is deleted: remember its friends so their counts can be fixed afterwards. */
  async friendIdsOf(userId: number) {
    const rows = await this.prisma.friendship.findMany({ where: { OR: [{ userAId: userId }, { userBId: userId }] } });
    return rows.map((f) => (f.userAId === userId ? f.userBId : f.userAId));
  }

  async resyncCounts(userIds: number[]) {
    await this.prisma.$transaction((tx) => this.syncCounts(tx, ...userIds));
  }
}

@ApiTags('Friends')
@ApiBearerAuth()
@Controller('friends')
export class FriendsController {
  constructor(private readonly social: SocialService) {}

  @Get()
  list(@CurrentUser() me: AuthUser) {
    return this.social.friends(me);
  }

  @Get('people')
  people(@CurrentUser() me: AuthUser, @Query(new ZodPipe(PeopleQuery)) q: z.infer<typeof PeopleQuery>) {
    return this.social.people(me, q);
  }

  @Get('requests')
  requests(@CurrentUser() me: AuthUser) {
    return this.social.requests(me);
  }

  @Post('requests')
  send(@CurrentUser() me: AuthUser, @Body(new ZodPipe(SendSchema)) body: z.infer<typeof SendSchema>) {
    return this.social.send(me, body.userId);
  }

  @HttpCode(200)
  @Post('requests/:id/accept')
  accept(@CurrentUser() me: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.social.respond(me, id, true);
  }

  @HttpCode(200)
  @Post('requests/:id/reject')
  reject(@CurrentUser() me: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.social.respond(me, id, false);
  }

  @Delete('requests/:id')
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.social.cancel(me, id);
  }

  @Delete(':userId')
  remove(@CurrentUser() me: AuthUser, @Param('userId', ParseIntPipe) userId: number) {
    return this.social.removeFriend(me, userId);
  }
}

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class MemberNotificationsController {
  constructor(private readonly social: SocialService) {}

  @Get()
  list(@CurrentUser() me: AuthUser) {
    return this.social.notifications(me);
  }

  @Get('unread-count')
  unread(@CurrentUser() me: AuthUser) {
    return this.social.unreadCount(me);
  }

  @HttpCode(200)
  @Post('read-all')
  readAll(@CurrentUser() me: AuthUser) {
    return this.social.markRead(me);
  }

  @HttpCode(200)
  @Post(':id/read')
  read(@CurrentUser() me: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.social.markRead(me, id);
  }
}

@Module({
  controllers: [FriendsController, MemberNotificationsController],
  providers: [SocialService],
  exports: [SocialService],
})
export class SocialModule {}
