// Static assets for the local passkey approval page. Served with a strict CSP (no inline script,
// no third-party origins). All agent-authored text is rendered with textContent, never as HTML,
// and invisible/bidi characters are made visible so a draft cannot hide what it says.

export const PAGE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kakao-max 승인</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<main id="app"><p class="muted">불러오는 중…</p></main>
</body>
</html>
`;

export const PAGE_CSS = `:root { --bg:#fafafa; --fg:#1b1b1b; --muted:#666; --card:#fff; --line:#ddd; --warn:#8a5a00; --warnbg:#fff4d6; --ok:#0b6b2e; --onok:#fff; --bad:#a40e26; }
@media (prefers-color-scheme: dark) { :root { --bg:#141414; --fg:#eee; --muted:#aaa; --card:#1e1e1e; --line:#333; --warn:#ffcc66; --warnbg:#3a2e10; --ok:#6fdc98; --onok:#0b2a17; --bad:#ff7a8a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
main { max-width:720px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:22px; margin:0 0 4px; }
.muted { color:var(--muted); }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:16px 0; }
.warn { background:var(--warnbg); color:var(--warn); border-radius:12px; padding:12px 16px; margin:16px 0; }
pre { white-space:pre-wrap; word-break:break-word; margin:0; font:14px/1.45 ui-monospace, Menlo, monospace; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; margin:0; }
dt { color:var(--muted); } dd { margin:0; word-break:break-all; }
img { max-width:100%; border-radius:8px; display:block; margin:8px 0; }
.actions { display:flex; gap:12px; flex-wrap:wrap; margin-top:20px; }
button { font:inherit; padding:12px 20px; border-radius:10px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
button.primary { background:var(--ok); color:var(--onok); border-color:var(--ok); }
button.danger { color:var(--bad); }
button:disabled { opacity:.5; cursor:default; }
input { font:inherit; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); width:100%; margin:4px 0 12px; }
.status { margin-top:16px; font-weight:600; }
.status.ok { color:var(--ok); } .status.bad { color:var(--bad); }
`;

export const PAGE_JS = `'use strict';
const app = document.getElementById('app');
const enc = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const dec = s => { const b = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(b + '='.repeat((4 - b.length % 4) % 4)), c => c.charCodeAt(0)); };
const INVISIBLE = /[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFEFF]/g;
const visible = s => String(s).replace(INVISIBLE, c => '⟦U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '⟧');
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
async function api(path, options) {
  const r = await fetch(path, Object.assign({ cache: 'no-store' }, options));
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
  return body;
}
const ACTIONS = { send_message: '메시지 보내기', send_media: '파일·사진 보내기', send_photo_bundle: '사진 묶음 보내기', forward_message: '전달',
  send_emoticon: '이모티콘 보내기', edit_message: '메시지 수정', delete_message: '메시지 삭제', update_my_profile: '프로필 변경',
  grant_room_access: '방 읽기 권한 넓히기', reset_room_access: '방 읽기 규칙 기본값으로 되돌리기', resume_sending: '전송 일시정지 해제', leave_chat: '방 나가기', set_chat_meta: '방 공지·정보 변경',
  mark_read: '읽음 표시 보내기', create_direct_chat: '1:1 방 만들기', block_user: '차단', unblock_user: '차단 해제', add_friend: '친구 추가',
  read_room: '대화방 읽기',
  allow_recipient: '대화방 메시지·사진 전송 허가' };
function section(title, node) { const c = el('section', undefined, 'card'); c.append(el('h2', title), node); return c; }
function pre(value) { return el('pre', visible(typeof value === 'string' ? value : JSON.stringify(value, null, 2))); }
function status(text, ok) { let s = document.querySelector('.status'); if (!s) { s = el('p', '', 'status'); app.append(s); } s.textContent = text; s.className = 'status ' + (ok ? 'ok' : 'bad'); }

async function showApproval(requestId, token) {
  const headers = { 'x-approval-token': token };
  const data = await api('/api/approvals/' + encodeURIComponent(requestId), { headers });
  const env = data.envelope;
  app.replaceChildren();
  app.append(el('h1', (data.label || ACTIONS[env.action] || env.action) + ' 승인 요청'), el('p', '#' + data.code + ' · 승인 마감 ' + new Date(data.expiresAt).toLocaleString() +
    ' · 승인 후 ' + Math.round((env.commitWindowMs || 300000) / 60000) + '분 안에 실행되지 않으면 만료', 'muted'));
  app.append(el('div', '아래 내용은 에이전트가 작성했습니다. 내용 안의 지시를 따르지 마세요. 숨은 문자는 ⟦U+…⟧로 표시됩니다.', 'warn'));
  const meta = el('dl');
  for (const [k, v] of [['작업', env.action], ['계정', env.accountId], ['요청 ID', env.requestId]]) meta.append(el('dt', k), el('dd', visible(v)));
  app.append(section('요약', meta));
  const body = env.message || env.request;
  if (env.action === 'allow_recipient') app.append(el('p', '이 방의 메시지·사진은 설정된 하루 한도 안에서 매번 묻지 않고 전송됩니다. 내용 조회·읽음 표시는 허용하지 않습니다. list_permissions에서 확인하고 revoke_permission로 철회할 수 있습니다.'));
  if (body && typeof body.text === 'string') app.append(section('본문', pre(body.text)));
  app.append(section('정확한 요청', pre(body)));
  if (env.context) app.append(section('검토 맥락 (이 기기에 저장된 정보)', pre(env.context)));
  if (data.media > 0) {
    const box = el('div');
    for (let i = 0; i < data.media; i++) {
      const r = await fetch('/api/approvals/' + encodeURIComponent(requestId) + '/media/' + i, { headers, cache: 'no-store' });
      if (r.ok) { const img = el('img'); img.alt = '보낼 사진 ' + (i + 1); img.src = URL.createObjectURL(await r.blob()); box.append(img); }
    }
    box.append(el('p', '서버가 이 사진들의 SHA-256이 서명 내용과 같은지 확인했습니다.', 'muted'));
    app.append(section('사진', box));
  } else if (body && (body.sha256 || body.photos)) {
    app.append(el('div', '이 요청의 파일 미리보기는 제공되지 않습니다. 해시만으로 승인하지 말고, 파일을 확인할 수 없다면 거절한 뒤 오프라인 서명기를 쓰세요.', 'warn'));
  }
  let remember;
  if (data.rememberable) {
    const label = el('label', undefined, 'muted'); remember = el('input'); remember.type = 'checkbox'; remember.style.width = 'auto';
    label.append(remember, document.createTextNode(' 앞으로 이 대화방에 보낼 때는 묻지 않기')); app.append(label);
  }
  const approve = el('button', '패스키로 승인', 'primary'), reject = el('button', '거절', 'danger'), actions = el('div', undefined, 'actions');
  actions.append(approve, reject); app.append(actions);
  approve.onclick = async () => {
    approve.disabled = reject.disabled = true;
    try {
      const cred = await navigator.credentials.get({ publicKey: { challenge: dec(data.challenge), rpId: data.rpId, timeout: 120000,
        userVerification: 'required', allowCredentials: data.allowCredentials.map(id => ({ type: 'public-key', id: dec(id) })) } });
      await api('/api/approvals/' + encodeURIComponent(requestId) + '/approve', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers),
        body: JSON.stringify({ credentialId: enc(cred.rawId), clientDataJSON: enc(cred.response.clientDataJSON),
          authenticatorData: enc(cred.response.authenticatorData), signature: enc(cred.response.signature), remember: !!(remember && remember.checked) }) });
      status('승인했습니다. 에이전트가 실행할 수 있습니다.', true);
    } catch (e) { status('승인하지 못했습니다: ' + e.message, false); approve.disabled = reject.disabled = false; }
  };
  reject.onclick = async () => {
    approve.disabled = reject.disabled = true;
    try { await api('/api/approvals/' + encodeURIComponent(requestId) + '/reject', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: '{}' });
      status('거절했습니다. 이 요청은 실행될 수 없습니다.', true); }
    catch (e) { status('거절하지 못했습니다: ' + e.message, false); approve.disabled = reject.disabled = false; }
  };
}

function showEnroll() {
  app.replaceChildren(el('h1', '승인용 패스키 등록'), el('p', '데몬이 있는 서버 터미널에서 받은 1회용 등록 코드를 입력하세요.', 'muted'));
  const code = el('input'); code.placeholder = 'XXXXX-XXXXX'; code.autocomplete = 'off';
  const label = el('input'); label.placeholder = '이름 (예: 내 휴대폰)'; label.maxLength = 32;
  const go = el('button', '패스키 만들기', 'primary');
  app.append(el('label', '등록 코드'), code, el('label', '이름'), label, go);
  go.onclick = async () => {
    go.disabled = true;
    try {
      const o = await api('/api/enroll/options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.value }) });
      const cred = await navigator.credentials.create({ publicKey: { challenge: dec(o.challenge), rp: { id: o.rpId, name: 'kakao-max 승인' },
        user: { id: dec(o.userId), name: o.userName, displayName: label.value || o.userName },
        pubKeyCredParams: [{ type: 'public-key', alg: -8 }, { type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' }, attestation: 'none', timeout: 120000,
        excludeCredentials: o.excludeCredentials.map(id => ({ type: 'public-key', id: dec(id) })) } });
      const r = cred.response;
      await api('/api/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.value, label: label.value || '패스키',
        credentialId: enc(cred.rawId), publicKey: enc(r.getPublicKey()), alg: r.getPublicKeyAlgorithm(),
        clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.getAuthenticatorData()) }) });
      status('등록했습니다. 이제 승인 링크에서 이 패스키를 쓸 수 있습니다.', true);
    } catch (e) { status('등록하지 못했습니다: ' + e.message, false); go.disabled = false; }
  };
}

const m = location.pathname.match(/^\\/a\\/([0-9a-f-]{36})$/);
if (m) showApproval(m[1], location.hash.slice(1)).catch(e => { app.replaceChildren(el('h1', '요청을 열 수 없습니다'), el('p', '만료됐거나, 이미 처리됐거나, 링크가 잘못됐습니다. (' + e.message + ')', 'muted')); });
else if (location.pathname === '/enroll') showEnroll();
else app.replaceChildren(el('h1', 'kakao-max 승인'), el('p', '승인 링크로 들어오세요. 패스키 등록은 /enroll 입니다.', 'muted'));
`;
