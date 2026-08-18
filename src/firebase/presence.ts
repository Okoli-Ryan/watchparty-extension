import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './config';
import { COLLECTIONS, STALE_MS } from '../shared/constants';
import type { Member, MemberRole, Room, UserProfile } from '../shared/types';

const membersCol = (roomId: string) =>
  collection(db, COLLECTIONS.rooms, roomId, COLLECTIONS.members);
const memberRef = (roomId: string, uid: string) =>
  doc(db, COLLECTIONS.rooms, roomId, COLLECTIONS.members, uid);

/** Add (or refresh) my membership doc. joinedAt is only set on first join. */
export async function joinRoom(
  roomId: string,
  profile: UserProfile,
  role: MemberRole,
): Promise<void> {
  const ref = memberRef(roomId, profile.uid);
  const existing = await getDoc(ref);
  await setDoc(
    ref,
    {
      displayName: profile.displayName,
      role,
      lastSeen: serverTimestamp(),
      ...(existing.exists() ? {} : { joinedAt: serverTimestamp() }),
    },
    { merge: true },
  );
}

/** One heartbeat write. Call on an interval while attached. */
export function heartbeat(roomId: string, uid: string): Promise<void> {
  return updateDoc(memberRef(roomId, uid), { lastSeen: serverTimestamp() }).catch(
    // If the doc was pruned out from under us, re-create it on the next join.
    () => undefined,
  );
}

export function leaveRoom(roomId: string, uid: string): Promise<void> {
  return deleteDoc(memberRef(roomId, uid)).catch(() => undefined);
}

export function setMemberRole(roomId: string, uid: string, role: MemberRole): Promise<void> {
  return updateDoc(memberRef(roomId, uid), { role }).catch(() => undefined);
}

function memberFromSnap(uid: string, data: any): Member {
  return {
    uid,
    displayName: data.displayName ?? 'Someone',
    role: (data.role as MemberRole) ?? 'viewer',
    joinedAt: data.joinedAt ?? null,
    lastSeen: data.lastSeen ?? null,
  };
}

/**
 * Subscribe to a room's members.
 *
 * `fromCache` matters: Firestore delivers a local snapshot immediately, before
 * the server round-trip. For someone who has just joined, that snapshot holds
 * only their OWN pending write — every other member is missing. Treating it as
 * authoritative made a joiner conclude the host was gone and promote itself, so
 * callers must not make ownership decisions on a cached snapshot.
 */
export function watchMembers(
  roomId: string,
  cb: (members: Member[], fromCache: boolean) => void,
): Unsubscribe {
  return onSnapshot(membersCol(roomId), { includeMetadataChanges: true }, (snap) => {
    cb(
      snap.docs.map((d) => memberFromSnap(d.id, d.data())),
      snap.metadata.fromCache,
    );
  });
}

/**
 * Estimated offset between server time and this machine's clock, in ms.
 * `serverNow() ≈ Date.now() + clockOffset`.
 *
 * Heartbeats are server timestamps but our clock is local, and comparing the
 * two directly is what caused earlier false-stale bugs. Rather than pick one,
 * we calibrate: the newest heartbeat in the room is at most one beat old, so
 * `newest - Date.now()` is a good estimate of the skew. Freshness is then
 * measured against an estimated server clock that keeps ticking even when no
 * snapshots arrive.
 */
let clockOffset = 0;

/** Re-estimate the skew. Call only with a FRESH snapshot of members. */
export function calibrateClock(members: Member[]): void {
  let max = 0;
  for (const m of members) {
    const t = m.lastSeen?.toMillis?.() ?? 0;
    if (t > max) max = t;
  }
  if (max > 0) clockOffset = max - Date.now();
}

/** Best estimate of the server's current time. */
export function serverNow(): number {
  return Date.now() + clockOffset;
}

/**
 * Reference "now" for freshness, recalibrating from the given snapshot.
 *
 * Note it returns an estimated *server* clock rather than the newest heartbeat
 * itself. Using the newest heartbeat directly meant that if every member froze
 * at once (all tabs closed, machine slept), they all stayed "fresh" relative to
 * each other forever and the watcher count never decayed.
 */
export function freshnessRef(members: Member[]): number {
  calibrateClock(members);
  return serverNow();
}

/**
 * A member counts as present if its heartbeat isn't far behind the freshest one.
 * A member whose `lastSeen` hasn't resolved yet (pending serverTimestamp right
 * after joining) is treated as fresh, not gone.
 */
export function isFresh(m: Member, ref: number): boolean {
  const seen = m.lastSeen?.toMillis?.() ?? null;
  if (seen === null) return true;
  return ref - seen <= STALE_MS;
}

/**
 * Reconcile ownership after a members change. Idempotent and safe to run from
 * every attached client. Deliberately conservative — it never touches a room it
 * isn't actively part of, never removes its own membership, and never
 * deactivates a room (that only happens on an explicit leave, see the service
 * worker's deactivateIfEmpty):
 *   • If the owner is gone and *I* am the earliest-joined fresh member, I
 *     promote myself (rules allow setting ownerUid to my own uid).
 *   • If I am the current owner, I prune members (other than me) whose
 *     heartbeats have fallen behind.
 *
 * Returns the role I should now hold ('owner' | 'viewer').
 */
export async function reconcileOwnership(
  room: Room,
  members: Member[],
  me: UserProfile,
): Promise<MemberRole | null> {
  const ref = freshnessRef(members);
  const fresh = members.filter((m) => isFresh(m, ref));

  const iAmPresent = fresh.some((m) => m.uid === me.uid);
  const ownerPresent = fresh.some((m) => m.uid === room.ownerUid);

  // 1. Promotion — only act on a room I'm actually present in.
  if (iAmPresent && !ownerPresent) {
    // The room's primary owner outranks join order: if they're here, the room
    // goes back to them rather than to whoever arrived first.
    const primary = fresh.find((m) => m.uid === room.primaryOwnerUid);
    const heir =
      primary ??
      [...fresh].sort(
        (a, b) => (a.joinedAt?.toMillis?.() ?? Infinity) - (b.joinedAt?.toMillis?.() ?? Infinity),
      )[0];
    if (heir?.uid === me.uid && room.ownerUid !== me.uid) {
      await updateDoc(doc(db, COLLECTIONS.rooms, room.id), {
        ownerUid: me.uid,
        ownerName: me.displayName,
      }).catch(() => undefined);
      await setMemberRole(room.id, me.uid, 'owner');
      return 'owner';
    }
  }

  // 2. Pruning — only the current owner prunes, and never itself. (No
  //    deactivation here: a sole owner must be able to host alone.)
  if (room.ownerUid === me.uid) {
    const stale = members.filter((m) => m.uid !== me.uid && !isFresh(m, ref));
    await Promise.all(
      stale.map((m) => deleteDoc(memberRef(room.id, m.uid)).catch(() => undefined)),
    );
  }

  return room.ownerUid === me.uid ? 'owner' : 'viewer';
}
