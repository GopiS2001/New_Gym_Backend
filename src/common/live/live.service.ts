import type { Server as HttpServer, IncomingMessage } from 'http';

import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WebSocket, WebSocketServer } from 'ws';

import { PrismaService } from '../prisma/prisma.service';

type Payload = { sub: number; iat?: number };

/**
 * Live connection between the app and the API (WebSocket at /api/v1/live).
 * Used to tell a member's devices *instantly* that they were signed out
 * (admin force logout, suspension, password reset) instead of waiting for
 * their next request.
 */
@Injectable()
export class LiveService implements OnModuleDestroy {
  private readonly logger = new Logger('Live');
  private wss: WebSocketServer | null = null;
  private readonly sockets = new Map<number, Set<WebSocket>>();
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  attach(server: HttpServer) {
    this.wss = new WebSocketServer({ server, path: '/api/v1/live', maxPayload: 1024 });
    this.wss.on('connection', (ws, req) => void this.onConnection(ws, req));
    // Drop connections that stopped answering (phone lost signal, app killed).
    this.pingTimer = setInterval(() => {
      for (const set of this.sockets.values())
        for (const ws of set) {
          if ((ws as WebSocket & { alive?: boolean }).alive === false) ws.terminate();
          else {
            (ws as WebSocket & { alive?: boolean }).alive = false;
            ws.ping();
          }
        }
    }, 30_000);
    this.logger.log('Live connections ready at /api/v1/live');
  }

  private async onConnection(ws: WebSocket, req: IncomingMessage) {
    const token = new URL(req.url ?? '', 'http://x').searchParams.get('token');
    const userId = await this.authenticate(token);
    if (!userId) return ws.close(4401, 'unauthorized');

    (ws as WebSocket & { alive?: boolean }).alive = true;
    ws.on('pong', () => ((ws as WebSocket & { alive?: boolean }).alive = true));
    ws.on('close', () => {
      const set = this.sockets.get(userId);
      set?.delete(ws);
      if (set && !set.size) this.sockets.delete(userId);
    });
    if (!this.sockets.has(userId)) this.sockets.set(userId, new Set());
    this.sockets.get(userId)!.add(ws);
    ws.send(JSON.stringify({ type: 'ready' }));
  }

  /** Same rules as the HTTP guard: valid token, active account, not force-logged-out. */
  private async authenticate(token: string | null): Promise<number | null> {
    if (!token) return null;
    try {
      const p = await this.jwt.verifyAsync<Payload>(token, { secret: this.config.getOrThrow('JWT_ACCESS_SECRET') });
      const user = await this.prisma.user.findUnique({ where: { id: p.sub }, select: { status: true, sessionsRevokedAt: true } });
      if (!user || user.status !== 'ACTIVE') return null;
      if (user.sessionsRevokedAt && (p.iat ?? 0) * 1000 < user.sessionsRevokedAt.getTime()) return null;
      return p.sub;
    } catch {
      return null;
    }
  }

  /** Pushes a message to every open app of this user (no-op if none are connected). */
  send(userId: number, message: Record<string, unknown>) {
    const set = this.sockets.get(userId);
    if (!set?.size) return 0;
    const msg = JSON.stringify(message);
    for (const ws of set) {
      try {
        ws.send(msg);
      } catch {
        ws.terminate();
      }
    }
    return set.size;
  }

  /** Tells every open app of this user that the session has ended, then disconnects them. */
  signOut(userId: number, reason: 'force_logout' | 'suspended' | 'password_reset') {
    const set = this.sockets.get(userId);
    if (!set?.size) return 0;
    const msg = JSON.stringify({ type: 'signed_out', reason });
    for (const ws of set) {
      try {
        ws.send(msg);
        ws.close(4000, 'signed_out');
      } catch {
        ws.terminate();
      }
    }
    this.sockets.delete(userId);
    return set.size;
  }

  onModuleDestroy() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.wss?.close();
  }
}

@Global()
@Module({ providers: [LiveService], exports: [LiveService] })
export class LiveModule {}
