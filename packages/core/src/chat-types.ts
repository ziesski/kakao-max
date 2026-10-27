// ----------------------------------------------------------------------------
// LOCO chat type codes (verified on a live account: LOGINLIST `t`, CHATINFO `chatInfo.type`):
//   DirectChat  1:1            MultiChat  group (stays a group even if only 2 remain)
//   MemoChat    chat with self PlusChat   business channel
//   OM          open group     OD         open 1:1
// ----------------------------------------------------------------------------

const GROUP_TYPES = new Set(['MultiChat', 'OM']);
const ONE_TO_ONE_TYPES = new Set(['DirectChat', 'OD', 'MemoChat']);

/** True/false when the type code decides it; undefined for unknown or channel types. */
export function isGroupType(type: string | undefined): boolean | undefined {
  if (!type) return undefined;
  if (GROUP_TYPES.has(type)) return true;
  if (ONE_TO_ONE_TYPES.has(type)) return false;
  return undefined;
}

export function isOpenChatType(type: string | undefined): boolean {
  return type === 'OM' || type === 'OD';
}
