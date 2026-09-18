import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Notification from '@/models/Notification';
import { handle, ok, requireAuth, BadRequest } from '@/lib/rbac';

/**
 * The signed-in user's notifications.
 *
 * What this replaces: on an empty inbox the old GET *synthesised* notifications
 * by querying applications and certificates — and for any non-Owner role it did
 * so with `{}` as the filter, then wrote the resulting rows into the reader's own
 * notification collection. An officer opening the bell icon permanently copied
 * other businesses' application and certificate details into their own inbox.
 *
 * Notifications are now written at the moment the event happens (see
 * `src/lib/notify.ts`, which also handles email / SMS / WhatsApp fan-out and
 * deduplication). This route only reads and marks them.
 */

export const GET = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const sp = req.nextUrl.searchParams;

  const query: Record<string, unknown> = {
    userId: new Types.ObjectId(user.id),
    // Email/SMS/WhatsApp rows are delivery records, not inbox items.
    channel: 'app',
  };

  if (sp.get('unread') === 'true') query.isRead = false;

  const type = sp.get('type');
  if (type && ['info', 'success', 'warning', 'error'].includes(type)) query.type = type;

  const limit = Math.min(100, Math.max(1, Number(sp.get('limit')) || 50));

  const [notifications, unreadCount, total] = await Promise.all([
    Notification.find(query).sort({ createdAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({
      userId: new Types.ObjectId(user.id),
      channel: 'app',
      isRead: false,
    }),
    Notification.countDocuments({ userId: new Types.ObjectId(user.id), channel: 'app' }),
  ]);

  return ok({ notifications, unreadCount, total });
});

/**
 * Marks notifications read — all of them, or the ids given.
 *
 * Scoped by `userId` in the filter itself, so passing someone else's id simply
 * matches nothing.
 */
export const PATCH = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const body = (await req.json().catch(() => ({}))) as { ids?: string[]; all?: boolean };

  const filter: Record<string, unknown> = {
    userId: new Types.ObjectId(user.id),
    isRead: false,
  };

  if (Array.isArray(body.ids) && body.ids.length > 0) {
    const ids = body.ids.filter((i) => Types.ObjectId.isValid(i)).map((i) => new Types.ObjectId(i));
    if (ids.length === 0) throw BadRequest('No valid notification ids supplied', 'INVALID_IDS');
    filter._id = { $in: ids };
  } else if (body.all !== true) {
    throw BadRequest('Supply `ids` to mark specific notifications, or `all: true`', 'NOTHING_TO_MARK');
  }

  const result = await Notification.updateMany(filter, {
    isRead: true,
    readAt: new Date(),
  });

  const unreadCount = await Notification.countDocuments({
    userId: new Types.ObjectId(user.id),
    channel: 'app',
    isRead: false,
  });

  return ok({ updated: result.modifiedCount, unreadCount });
});

/**
 * Clears the user's own read notifications.
 *
 * Unread ones are kept deliberately: a compliance alert about an expiring
 * certificate should not disappear because the inbox was cleared before it was
 * seen. `?includeUnread=true` overrides that when the user really means it.
 */
export const DELETE = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const includeUnread = req.nextUrl.searchParams.get('includeUnread') === 'true';
  const id = req.nextUrl.searchParams.get('id');

  const filter: Record<string, unknown> = { userId: new Types.ObjectId(user.id) };
  if (id) {
    if (!Types.ObjectId.isValid(id)) throw BadRequest('Invalid notification id', 'INVALID_ID');
    filter._id = new Types.ObjectId(id);
  } else if (!includeUnread) {
    filter.isRead = true;
  }

  const result = await Notification.deleteMany(filter);
  return ok({ deleted: result.deletedCount });
});
