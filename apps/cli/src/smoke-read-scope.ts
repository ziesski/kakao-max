/** Smoke checks may inspect only a room explicitly reported as read at each call. */
export function readRoomSmokeAccess<History, Search>(backend: {
  getState(): Promise<{ chats: Array<{ id: string; unreadCount?: number | null }> }>;
  getHistory(chatId: string, limit?: number): Promise<History>;
  searchMessages(query: string, chatId?: string, limit?: number): Promise<Search>;
}) {
  async function requireRead(chatId: string) {
    const state = await backend.getState();
    if (!chatId || state.chats.find(chat => chat.id === chatId)?.unreadCount !== 0) {
      throw new Error('Smoke check requires a room with explicit unreadCount=0');
    }
  }
  return {
    async history(chatId: string, limit: number) {
      await requireRead(chatId);
      return backend.getHistory(chatId, limit);
    },
    async search(query: string, chatId: string, limit: number) {
      await requireRead(chatId);
      return backend.searchMessages(query, chatId, limit);
    }
  };
}
