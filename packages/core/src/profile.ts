// ----------------------------------------------------------------------------
// Real KakaoTalk Profile Manager.
//
// Fetches the user's detailed profile and multi-profiles list from KakaoTalk WAS
// endpoints:
//   - GET https://katalk.kakao.com/mac/profile/list.json (all profiles list)
//   - GET https://katalk.kakao.com/mac/profile3/me.json?profileId=... (detailed profile)
//   - GET https://katalk.kakao.com/mac/profile3/friend.json?id=... (friend profile)
// ----------------------------------------------------------------------------

import type { KakaoConfig } from './config.ts';
import { KakaoError } from './errors.ts';
import { wasRequest, type WasCreds } from './was-http.ts';

/** One profile or background history entry ("feed"). `contents` holds typed values such as image URLs. */
export interface KakaoProfileFeed {
  id: string;
  type?: number;
  updatedAt?: number;
  isCurrent?: boolean;
  contents: { type: string; value: string }[];
}

/** A feed list as the server sends it: `{ feeds: [...], totalCnt }`. */
export interface KakaoProfileFeedList {
  total: number;
  items: KakaoProfileFeed[];
}

/** A profile music entry (from `musics.contentsInfo`). */
export interface KakaoProfileMusic {
  title: string;
  album?: string;
  artists: string[];
}

export interface KakaoProfileSummary {
  profileId: string;
  nickname: string;
  statusMessage?: string;
  profileImageUrl?: string;
  fullProfileImageUrl?: string;
  originalProfileImageUrl?: string;
  main: boolean;
  intickerLastReactedAt?: number;
}

export interface KakaoProfileDetail {
  profileId: string;
  nickname: string;
  userId: string;
  statusMessage?: string;
  profileImageUrl?: string;
  fullProfileImageUrl?: string;
  originalProfileImageUrl?: string;
  backgroundImageUrl?: string;
  originalBackgroundImageUrl?: string;
  decoration?: any;
  profileFeeds?: KakaoProfileFeedList;
  backgroundFeeds?: KakaoProfileFeedList;
  allowPay?: boolean;
  order?: number;
  suspended?: boolean;
}

export interface KakaoFriendProfile {
  userId: string;
  statusMessage?: string;
  profileImageUrl?: string;
  fullProfileImageUrl?: string;
  originalProfileImageUrl?: string;
  backgroundImageUrl?: string;
  originalBackgroundImageUrl?: string;
  decoration?: any;
  musics?: KakaoProfileMusic[];
  profileFeeds?: KakaoProfileFeedList;
  backgroundFeeds?: KakaoProfileFeedList;
  suspended?: boolean;
  suspectedImpostor?: boolean;
}

// The raw responses are deliberately not passed on: besides duplicating every parsed field
// they carry opaque tokens (`screenToken`, `itemNewBadgeToken`, `accessPermit`) that an agent
// has no use for and should not see.

function parseFeedList(v: any): KakaoProfileFeedList | undefined {
  if (!v || typeof v !== 'object' || !Array.isArray(v.feeds)) return undefined;
  const items: KakaoProfileFeed[] = v.feeds.map((f: any) => ({
    id: String(f.id ?? ''),
    type: typeof f.type === 'number' ? f.type : undefined,
    updatedAt: typeof f.updatedAt === 'number' ? f.updatedAt : undefined,
    isCurrent: typeof f.isCurrent === 'boolean' ? f.isCurrent : undefined,
    contents: Array.isArray(f.contents)
      ? f.contents
          .filter((c: any) => c && typeof c.value === 'string' && c.value)
          .map((c: any) => ({ type: String(c.type ?? ''), value: c.value }))
      : []
  }));
  return { total: typeof v.totalCnt === 'number' ? v.totalCnt : items.length, items };
}

function parseMusics(v: any): KakaoProfileMusic[] | undefined {
  if (!v || typeof v !== 'object' || !Array.isArray(v.contentsInfo)) return undefined;
  return v.contentsInfo.map((m: any) => ({
    title: String(m.contentName ?? ''),
    album: m.albumName || undefined,
    artists: Array.isArray(m.artistList) ? m.artistList.map((a: any) => String(a?.artistName ?? '')).filter(Boolean) : []
  }));
}

export interface MyProfileResult {
  profile: KakaoProfileDetail;
  profiles: KakaoProfileSummary[];
}

export class ProfileManager {
  private readonly client: KakaoConfig['client'];

  constructor(client: KakaoConfig['client'] = { appVersion: '26.4.0', os: 'mac', lang: 'ko', timeZone: 'Asia/Seoul' }) {
    this.client = client;
  }

  /**
   * Fetch all profile summaries (including multi-profiles) via GET /mac/profile/list.json
   */
  async listProfiles(creds: WasCreds): Promise<KakaoProfileSummary[]> {
    const data = await wasRequest(this.client, creds, 'profile/list.json');
    const rawProfiles: any[] = Array.isArray(data.profiles) ? data.profiles : [];
    return rawProfiles.map((p) => ({
      profileId: String(p.profileId),
      nickname: String(p.nickname || ''),
      statusMessage: p.statusMessage || undefined,
      profileImageUrl: p.profileImageUrl || undefined,
      fullProfileImageUrl: p.fullProfileImageUrl || undefined,
      originalProfileImageUrl: p.originalProfileImageUrl || undefined,
      main: p.main === true,
      intickerLastReactedAt: typeof p.intickerLastReactedAt === 'number' ? p.intickerLastReactedAt : undefined
    }));
  }

  /**
   * Fetch detailed profile for a profileId (or main profile if omitted) via GET /mac/profile3/me.json.
   * The server answers status -400 without a profileId, so the main one is looked up first.
   */
  async getMyProfile(creds: WasCreds & { userId?: string }, profileId?: string): Promise<MyProfileResult> {
    const profiles = await this.listProfiles(creds);
    let targetId = profileId;
    if (!targetId) {
      const main = profiles.find((p) => p.main) || profiles[0];
      if (!main) {
        throw new KakaoError('NOT_FOUND', 'No profile found for this account');
      }
      targetId = main.profileId;
    }

    const data = await wasRequest(this.client, creds, 'profile3/me.json', {
      query: { profileId: targetId, skipTodayViewCountIncr: 'true', timeZone: this.client.timeZone }
    });
    const p = data.profile || {};
    const profile: KakaoProfileDetail = {
      profileId: String(p.profileId || targetId),
      nickname: String(p.nickname || ''),
      userId: String(p.userId || creds.userId || ''),
      statusMessage: p.statusMessage || undefined,
      profileImageUrl: p.profileImageUrl || undefined,
      fullProfileImageUrl: p.fullProfileImageUrl || undefined,
      originalProfileImageUrl: p.originalProfileImageUrl || undefined,
      backgroundImageUrl: p.backgroundImageUrl || undefined,
      originalBackgroundImageUrl: p.originalBackgroundImageUrl || undefined,
      decoration: p.decoration,
      profileFeeds: parseFeedList(p.profileFeeds),
      backgroundFeeds: parseFeedList(p.backgroundFeeds),
      allowPay: p.allowPay === true,
      order: typeof p.order === 'number' ? p.order : undefined,
      suspended: p.suspended === true
    };
    return { profile, profiles };
  }

  /**
   * Fetch a friend's detailed profile via GET /mac/profile3/friend.json
   */
  async getFriendProfile(creds: WasCreds, userId: string): Promise<KakaoFriendProfile> {
    const data = await wasRequest(this.client, creds, 'profile3/friend.json', { query: { id: String(userId) } });
    const p = data.profile || {};
    return {
      userId: String(p.userId || userId),
      statusMessage: p.statusMessage || undefined,
      profileImageUrl: p.profileImageUrl || undefined,
      fullProfileImageUrl: p.fullProfileImageUrl || undefined,
      originalProfileImageUrl: p.originalProfileImageUrl || undefined,
      backgroundImageUrl: p.backgroundImageUrl || undefined,
      originalBackgroundImageUrl: p.originalBackgroundImageUrl || undefined,
      decoration: p.decoration,
      musics: parseMusics(p.musics),
      profileFeeds: parseFeedList(p.profileFeeds),
      backgroundFeeds: parseFeedList(p.backgroundFeeds),
      suspended: p.suspended === true,
      suspectedImpostor: p.suspectedImpostor === true
    };
  }

  /**
   * Update profile information via POST /mac/profile/update.json
   * Note: Starting with statusMessage as scoped in task.
   */
  async updateProfile(
    creds: WasCreds,
    profileId: string,
    params: {
      statusMessage?: string;
      nickname?: string;
    }
  ): Promise<Record<string, any>> {
    const json: Record<string, any> = { profileId };
    if (params.statusMessage !== undefined) {
      json.statusMessage = params.statusMessage;
    }
    if (params.nickname !== undefined) {
      json.nickname = params.nickname;
    }
    const data = await wasRequest(this.client, creds, 'profile/update.json', { json });
    return data;
  }
}
