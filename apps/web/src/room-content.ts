/** List/status/SSE metadata must not replay a previously cached message preview. */
export function metadataChat<T extends object>(chat: T): Omit<T, 'lastMessage' | 'lastMessageType'> & { lastMessage: string; lastMessageType: undefined } {
  return { ...chat, lastMessage: '', lastMessageType: undefined };
}

/** Return only this authorized bounded response, never a cache on deny/disconnect. */
export async function authorizedHistory(connected: boolean, fetch: () => Promise<{ messages: any[] }>): Promise<any[]> {
  if (!connected) throw new Error('Content unavailable while disconnected');
  const result = await fetch();
  if (!Array.isArray(result.messages)) throw new Error('Invalid authorized history response');
  return result.messages;
}
