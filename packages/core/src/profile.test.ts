import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileManager } from './profile.ts';
import { KakaoError } from './errors.ts';

const mockCreds = {
  userId: '123456789',
  accessToken: 'mock_token',
  deviceUUID: 'mock_uuid'
};

test('ProfileManager.listProfiles parses profile list and main profile correctly', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.ok(url.includes('/mac/profile/list.json'));
    return new Response(
      JSON.stringify({
        status: 0,
        revision: 42,
        profiles: [
          {
            profileId: 'main_prof_1',
            nickname: '홍길동',
            statusMessage: '반갑습니다',
            profileImageUrl: 'https://example.com/p1.jpg',
            main: true,
            intickerLastReactedAt: 12345
          },
          {
            profileId: 'sub_prof_2',
            nickname: '길동(부)',
            main: false
          }
        ]
      }),
      { status: 200 }
    );
  };

  const mgr = new ProfileManager();
  const profiles = await mgr.listProfiles(mockCreds);
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].profileId, 'main_prof_1');
  assert.equal(profiles[0].nickname, '홍길동');
  assert.equal(profiles[0].main, true);
  assert.equal(profiles[1].profileId, 'sub_prof_2');
  assert.equal(profiles[1].main, false);
});

test('ProfileManager.listProfiles surfaces LOCO_STATUS on non-zero response status', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ status: -400 }), { status: 200 });
  };

  const mgr = new ProfileManager();
  await assert.rejects(
    () => mgr.listProfiles(mockCreds),
    (err: unknown) => err instanceof KakaoError && err.code === 'LOCO_STATUS'
  );
});

test('ProfileManager.listProfiles surfaces AUTH_EXPIRED on HTTP 401', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    return new Response('Unauthorized', { status: 401 });
  };

  const mgr = new ProfileManager();
  await assert.rejects(
    () => mgr.listProfiles(mockCreds),
    (err: unknown) => err instanceof KakaoError && err.code === 'AUTH_EXPIRED'
  );
});

test('ProfileManager.getMyProfile without profileId resolves main profile and returns details', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/mac/profile/list.json')) {
      return new Response(
        JSON.stringify({
          status: 0,
          profiles: [
            { profileId: 'main_prof_1', nickname: '홍길동', main: true },
            { profileId: 'sub_prof_2', nickname: '길동(부)', main: false }
          ]
        }),
        { status: 200 }
      );
    }
    if (url.includes('/mac/profile3/me.json')) {
      assert.ok(url.includes('profileId=main_prof_1'));
      assert.ok(url.includes('skipTodayViewCountIncr=true'));
      assert.ok(url.includes('timeZone=Asia%2FSeoul'));
      return new Response(
        JSON.stringify({
          status: 0,
          profile: {
            profileId: 'main_prof_1',
            nickname: '홍길동',
            userId: '123456789',
            statusMessage: '행복한 하루',
            profileImageUrl: 'https://example.com/p1.jpg',
            backgroundImageUrl: 'https://example.com/b1.jpg',
            suspended: false
          }
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const mgr = new ProfileManager();
  const res = await mgr.getMyProfile(mockCreds);
  assert.equal(res.profile.profileId, 'main_prof_1');
  assert.equal(res.profile.nickname, '홍길동');
  assert.equal(res.profile.statusMessage, '행복한 하루');
  assert.equal(res.profiles.length, 2);
});

test('ProfileManager.getMyProfile with explicit profileId targets specified sub-profile', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/mac/profile/list.json')) {
      return new Response(
        JSON.stringify({
          status: 0,
          profiles: [
            { profileId: 'main_prof_1', nickname: '홍길동', main: true },
            { profileId: 'sub_prof_2', nickname: '길동(부)', main: false }
          ]
        }),
        { status: 200 }
      );
    }
    if (url.includes('/mac/profile3/me.json')) {
      assert.ok(url.includes('profileId=sub_prof_2'));
      return new Response(
        JSON.stringify({
          status: 0,
          profile: {
            profileId: 'sub_prof_2',
            nickname: '길동(부)',
            userId: '123456789',
            statusMessage: '업무용 프로필'
          }
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const mgr = new ProfileManager();
  const res = await mgr.getMyProfile(mockCreds, 'sub_prof_2');
  assert.equal(res.profile.profileId, 'sub_prof_2');
  assert.equal(res.profile.nickname, '길동(부)');
  assert.equal(res.profile.statusMessage, '업무용 프로필');
});

test('ProfileManager.getFriendProfile fetches friend details', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.ok(url.includes('/mac/profile3/friend.json'));
    assert.ok(url.includes('id=987654321'));
    return new Response(
      JSON.stringify({
        status: 0,
        profile: {
          userId: '987654321',
          statusMessage: '친구 상태메시지',
          profileImageUrl: 'https://example.com/friend.jpg',
          suspended: false
        }
      }),
      { status: 200 }
    );
  };

  const mgr = new ProfileManager();
  const friend = await mgr.getFriendProfile(mockCreds, '987654321');
  assert.equal(friend.userId, '987654321');
  assert.equal(friend.statusMessage, '친구 상태메시지');
  assert.equal(friend.profileImageUrl, 'https://example.com/friend.jpg');
});

// Fixtures below follow the shape of live profile3 responses (2026-10-19); every value is made up.
const feedList = (n: number) => ({
  totalCnt: n,
  feeds: Array.from({ length: n }, (_, i) => ({
    id: `feed_${i}`,
    type: 1,
    updatedAt: 1700000000 + i,
    isCurrent: i === 0,
    permission: 0,
    cursor: i,
    feedMessage: '',
    url: '',
    webUrl: '',
    downloadId: '',
    serviceName: '',
    typeIconUrl: 'https://example.com/icon.png',
    extra: {},
    contents: [{ type: 'image', value: `https://example.com/feed_${i}.jpg` }]
  }))
});

const leaksToken = (o: unknown) => /screenToken|itemNewBadgeToken|accessPermit/.test(JSON.stringify(o));

test('getMyProfile unwraps profileFeeds/backgroundFeeds and drops the raw response with its tokens', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/mac/profile/list.json')) {
      return new Response(JSON.stringify({ status: 0, profiles: [{ profileId: 'main_prof_1', nickname: '홍길동', main: true }] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        status: 0,
        itemNewBadgeToken: 111,
        profile: {
          profileId: 'main_prof_1',
          nickname: '홍길동',
          userId: 123456789,
          statusMessage: '',
          backgroundImageUrl: '',
          screenToken: 222,
          feeds: { feeds: [], last: true },
          profileFeeds: feedList(1),
          backgroundFeeds: feedList(3),
          decoration: []
        }
      }),
      { status: 200 }
    );
  };

  const res = await new ProfileManager().getMyProfile(mockCreds);
  assert.equal(res.profile.userId, '123456789');
  assert.equal(res.profile.statusMessage, undefined);
  assert.equal(res.profile.profileFeeds?.total, 1);
  assert.deepEqual(res.profile.profileFeeds?.items[0], {
    id: 'feed_0',
    type: 1,
    updatedAt: 1700000000,
    isCurrent: true,
    contents: [{ type: 'image', value: 'https://example.com/feed_0.jpg' }]
  });
  assert.equal(res.profile.backgroundFeeds?.items.length, 3);
  assert.equal('raw' in res.profile, false);
  assert.equal(leaksToken(res), false);
});

test('getFriendProfile parses musics.contentsInfo and feeds, without tokens', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        status: 0,
        accessPermit: 'opaque',
        designationButton: { show: false },
        profile: {
          userId: 987654321,
          statusMessage: '친구 상태메시지',
          screenToken: 333,
          feeds: { feeds: [], last: true },
          profileFeeds: feedList(2),
          musics: {
            status: 0,
            total: 1,
            contentsInfo: [
              {
                contentId: 'c1',
                contentName: '노래 제목',
                albumId: 'a1',
                albumName: '앨범',
                artistList: [{ artistId: 'r1', artistName: '가수' }],
                isAdult: false,
                updatedAt: 1700000000
              }
            ]
          }
        }
      }),
      { status: 200 }
    );

  const friend = await new ProfileManager().getFriendProfile(mockCreds, '987654321');
  assert.equal(friend.userId, '987654321');
  assert.deepEqual(friend.musics, [{ title: '노래 제목', album: '앨범', artists: ['가수'] }]);
  assert.equal(friend.profileFeeds?.total, 2);
  assert.equal(friend.backgroundFeeds, undefined);
  assert.equal(leaksToken(friend), false);
});

test('ProfileManager.updateProfile makes JSON POST to /mac/profile/update.json', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let capturedBody = '';
  let capturedMethod = '';
  let capturedContentType = '';
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.includes('/mac/profile/update.json'));
    capturedMethod = init?.method ?? '';
    capturedBody = String(init?.body ?? '');
    capturedContentType = (init?.headers as Record<string, string>)?.[`Content-Type`] ?? '';
    return new Response(JSON.stringify({ status: 0 }), { status: 200 });
  };

  const mgr = new ProfileManager();
  const res = await mgr.updateProfile(mockCreds, 'prof_123', { statusMessage: '새로운 상태메시지' });
  assert.equal(res.status, 0);
  assert.equal(capturedMethod, 'POST');
  assert.equal(capturedContentType, 'application/json');
  const parsed = JSON.parse(capturedBody);
  assert.equal(parsed.profileId, 'prof_123');
  assert.equal(parsed.statusMessage, '새로운 상태메시지');
});
