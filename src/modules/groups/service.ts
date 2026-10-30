import type { Types } from "mongoose";
import { bus } from "../../lib/events.js";
import { StoredFile } from "../../models/file.js";
import { Group, GroupMessage, type GroupDoc } from "../../models/group.js";
import { deleteFiles } from "../files/service.js";

/** A plain line in the group ("administrator added rami.t"): no secret, so no encryption. */
export async function systemLine(
  group: GroupDoc,
  kind: "added" | "removed" | "left" | "created" | "settings",
  user?: { _id: Types.ObjectId; username: string },
) {
  await GroupMessage.create({
    groupId: group._id,
    system: { kind, userId: user?._id, name: user?.username },
    expiresAt: new Date(Date.now() + (group.retentionMinutes ?? 1440) * 60_000),
  });
  bus.toUsers(group.members, "group:changed", { groupId: group.id });
}

/** Someone leaves or is removed: their keys go, so every new message is locked only for those who remain. */
export async function dropMember(group: GroupDoc, userId: Types.ObjectId | string) {
  group.set(
    "members",
    group.members.filter((m) => String(m) !== String(userId)),
  );
  group.set(
    "keys",
    group.keys.filter((k) => String(k.userId) !== String(userId)),
  );
  await group.save();
  bus.toUsers([userId], "group:changed", { groupId: group.id, removed: true });
}

/** Deleting a group: its messages and files go at once. */
export async function deleteGroup(group: GroupDoc) {
  const members = group.members;
  await deleteFiles(await StoredFile.find({ groupId: group._id, status: { $ne: "deleted" } }), "group_deleted");
  await Promise.all([GroupMessage.deleteMany({ groupId: group._id }), StoredFile.deleteMany({ groupId: group._id })]);
  await Group.deleteOne({ _id: group._id });
  bus.toUsers(members, "group:changed", { groupId: group.id, removed: true });
}
