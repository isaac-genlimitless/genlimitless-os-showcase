import { DEFAULT_USER } from "../accounts/identity";
import type { UserRow } from "../accounts/users";

/** Where this user's code goes: their own phone, else their own email. The legacy OWNER_IMESSAGE_HANDLE is only
 *  ever used for the default owner, and only when the users row has no phone yet. */
export function loginRecipient(user: UserRow): { kind: "phone" | "email"; to: string } | null {
  if (user.phone) return { kind: "phone", to: user.phone };
  if (user.id === DEFAULT_USER && user.role === "owner" && process.env.OWNER_IMESSAGE_HANDLE) {
    return { kind: "phone", to: process.env.OWNER_IMESSAGE_HANDLE };
  }
  if (user.email) return { kind: "email", to: user.email };
  return null;
}
