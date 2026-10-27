// ----------------------------------------------------------------------------
// Pure curation parsers:
//
// 1. collectSharedLinks: Extracts and categorizes links (YouTube, GitHub, Figma, etc.)
// 2. extractScheduleAndTodos: Parses schedules, meeting dates/times, and todo items
//
// Both functions are pure data transformations taking messages and returning structured results.
// Room access authorization must be checked by the caller before messages are passed here.
// ----------------------------------------------------------------------------

export interface SharedLinkItem {
  url: string;
  domain: string;
  category: 'youtube' | 'github' | 'figma' | 'article' | 'social' | 'docs' | 'general';
  messageId: string;
  chatId: string;
  authorId?: string;
  authorName?: string;
  sendAt: number;
}

export interface SharedLinksResult {
  totalLinks: number;
  categories: {
    youtube: SharedLinkItem[];
    github: SharedLinkItem[];
    figma: SharedLinkItem[];
    article: SharedLinkItem[];
    social: SharedLinkItem[];
    docs: SharedLinkItem[];
    general: SharedLinkItem[];
  };
  allLinks: SharedLinkItem[];
}

export interface ExtractedScheduleItem {
  messageId: string;
  chatId: string;
  authorName?: string;
  rawSnippet: string;
  timeHint?: string;
  locationHint?: string;
  sendAt: number;
}

export interface ExtractedTodoItem {
  messageId: string;
  chatId: string;
  authorName?: string;
  task: string;
  completed: boolean;
  assignee?: string;
  sendAt: number;
}

export interface ExtractedScheduleAndTodos {
  schedules: ExtractedScheduleItem[];
  todos: ExtractedTodoItem[];
  analyzedMessageCount: number;
}

/**
 * Extract and categorize all URLs shared in messages.
 */
export function collectSharedLinks(
  messages: Array<{
    messageId: string;
    chatId: string;
    authorId?: string;
    authorName?: string;
    text: string;
    sendAt: number;
  }>
): SharedLinksResult {
  const urlRegex = /(https?:\/\/[^\s<>"]+)/gi;
  const categories: SharedLinksResult['categories'] = {
    youtube: [],
    github: [],
    figma: [],
    article: [],
    social: [],
    docs: [],
    general: []
  };
  const allLinks: SharedLinkItem[] = [];

  for (const m of messages) {
    if (!m.text) continue;
    const matches = m.text.match(urlRegex);
    if (!matches) continue;

    for (const rawUrl of matches) {
      // Clean trailing punctuation
      const cleanUrl = rawUrl.replace(/[.,;!?)>]+$/, '');
      let domain = '';
      try {
        domain = new URL(cleanUrl).hostname.toLowerCase();
      } catch {
        continue;
      }

      let category: SharedLinkItem['category'] = 'general';

      if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
        category = 'youtube';
      } else if (domain.includes('github.com') || domain.includes('gist.github.com')) {
        category = 'github';
      } else if (domain.includes('figma.com')) {
        category = 'figma';
      } else if (
        domain.includes('news.naver.com') ||
        domain.includes('v.daum.net') ||
        domain.includes('medium.com') ||
        domain.includes('velog.io') ||
        domain.includes('tistory.com') ||
        domain.includes('brunch.co.kr') ||
        domain.includes('substack.com') ||
        domain.includes('nytimes.com') ||
        domain.includes('techcrunch.com')
      ) {
        category = 'article';
      } else if (
        domain.includes('twitter.com') ||
        domain.includes('x.com') ||
        domain.includes('instagram.com') ||
        domain.includes('linkedin.com') ||
        domain.includes('facebook.com') ||
        domain.includes('threads.net')
      ) {
        category = 'social';
      } else if (domain.includes('docs.google.com') || domain.includes('notion.so') || domain.includes('notion.site')) {
        category = 'docs';
      }

      const item: SharedLinkItem = {
        url: cleanUrl,
        domain,
        category,
        messageId: m.messageId,
        chatId: m.chatId,
        authorId: m.authorId,
        authorName: m.authorName,
        sendAt: m.sendAt
      };

      categories[category].push(item);
      allLinks.push(item);
    }
  }

  return {
    totalLinks: allLinks.length,
    categories,
    allLinks
  };
}

/**
 * Parse messages to extract appointments, dates, times, and todo action items.
 */
export function extractScheduleAndTodos(
  messages: Array<{
    messageId: string;
    chatId: string;
    authorId?: string;
    authorName?: string;
    text: string;
    sendAt: number;
  }>
): ExtractedScheduleAndTodos {
  const schedules: ExtractedScheduleItem[] = [];
  const todos: ExtractedTodoItem[] = [];

  const timePattern = /(오늘|내일|모레|이번주|다음주)?\s*([월화수목금토일]요일)?\s*(\d{1,2}월\s*\d{1,2}일|\d{4}[-.]\d{1,2}[-.]\d{1,2})?\s*(오전|오후|저녁|아침|점심|새벽)?\s*(\d{1,2}시(?:\s*\d{1,2}분)?|\d{1,2}:\d{2})/i;
  const locationPattern = /([가-힣a-zA-Z0-9_\s]{2,15}(?:역|점|앞|스타벅스|카페|식당|회의실|사무실|로비|빌딩))\s*(에서|앞에서|위치)/;

  const todoPrefixPattern = /^(?:-\s*\[([ xX])\]|\*\s*\[([ xX])\]|(?:\d+\.|\*|-|•)\s*(?:TODO|투두|할일|준비물|과제|확인|체크)?[:\s]+)(.*)/i;
  const todoVerbPattern = /([가-힣a-zA-Z0-9_\s]{3,40}(?:하기|보내기|확인하기|제출하기|작성하기|수정하기|배포하기|정리하기|체크하기|전달하기|공유하기))(?:\s*부탁|\s*요청|\s*필요|[!.]|$)/;

  for (const m of messages) {
    if (!m.text) continue;
    const lines = m.text.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // 1. Schedule Detection
      const timeMatch = line.match(timePattern);
      if (timeMatch) {
        const remaining = line.replace(timeMatch[0], '').trim();
        const locMatch = remaining.match(locationPattern) ?? line.match(locationPattern);
        schedules.push({
          messageId: m.messageId,
          chatId: m.chatId,
          authorName: m.authorName,
          rawSnippet: line,
          timeHint: timeMatch[0].trim(),
          locationHint: locMatch ? locMatch[1].trim() : undefined,
          sendAt: m.sendAt
        });
      }

      // 2. Todo Detection
      const prefixMatch = line.match(todoPrefixPattern);
      if (prefixMatch) {
        const isBox = prefixMatch[1] ?? prefixMatch[2];
        const isDone = isBox ? isBox.toLowerCase() === 'x' : false;
        const taskText = (prefixMatch[3] ?? line).trim();
        if (taskText.length >= 2) {
          todos.push({
            messageId: m.messageId,
            chatId: m.chatId,
            authorName: m.authorName,
            task: taskText,
            completed: isDone,
            sendAt: m.sendAt
          });
          continue;
        }
      }

      const verbMatch = line.match(todoVerbPattern);
      if (verbMatch) {
        todos.push({
          messageId: m.messageId,
          chatId: m.chatId,
          authorName: m.authorName,
          task: verbMatch[1].trim(),
          completed: false,
          sendAt: m.sendAt
        });
      }
    }
  }

  return {
    schedules,
    todos,
    analyzedMessageCount: messages.length
  };
}
