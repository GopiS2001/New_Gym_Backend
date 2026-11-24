/** A member counts as online if the app reported activity within this window. */
export const ONLINE_WINDOW_MS = 150_000; // app heartbeat is every 60 s
/** Don't write last-seen more often than this per user on ordinary requests. */
export const LAST_SEEN_THROTTLE_MS = 30_000;

export function isOnline(u: { lastSeenAt: Date | null; appInBackground: boolean }, now = Date.now()) {
  return !!u.lastSeenAt && !u.appInBackground && now - u.lastSeenAt.getTime() < ONLINE_WINDOW_MS;
}

export const onlineWhere = (now = Date.now()) => ({
  appInBackground: false,
  lastSeenAt: { gte: new Date(now - ONLINE_WINDOW_MS) },
});
