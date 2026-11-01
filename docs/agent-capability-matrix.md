# 에이전트 기능 매트릭스 (MCP 기준)

> 목표는 "AI 에이전트가 카카오톡 기능을 자율 제어"다. 행 하나가 에이전트가 쓸 수 있어야 하는 기능 하나다.
> **완료(✅)는 현재 도구로 실계정에서 검증된 것만 센다.** `apps/mcp/src/capability-matrix.test.ts`가
> 등록된 모든 MCP 도구가 이 표에 있는지, 없어진 도구가 남아 있지 않은지 검사한다.

## 도구 표면

- 기본 도구 16개는 항상 보인다. 고급 도구는 `KAKAO_MCP_TOOL_GROUPS=chats,friends,events,vault`로 켠 묶음만 존재한다(꺼진 도구는 호출도 안 된다).
- 모든 쓰기 도구는 에이전트가 정한 `requestId`로 **한 번 호출**한다. 방 허가로 덮이면 바로 실행하고, 아니면 같은 호출 안에서 클라이언트 확인 창으로 묻거나
  오류에 패스키 링크를 담아 돌려준다. 승인 뒤 같은 `requestId`로 다시 부른다. `prepare_*`, `commit_operation`, 별칭은 없어졌다.
- 승인 수단은 MCP 클라이언트 확인 창과 패스키 페이지 둘뿐이다. 오프라인 서명기와 `confirm` 인자는 제거됐다.
- 방 권한 모델은 하나다(방 허가 + 선택적 운영자 상한 `KAKAO_ROOM_CEILING`).
- **이전 도구로 얻은 실계정 증거는 아래 "이전 증거"에 남겼지만, 새 도구 이름·승인 경로로는 다시 확인하지 않았으므로 상태는 🟡다.**
- ✅ 2026-10-25 테스트 계정에서 터미널 Claude Code 2.1.308 확인 창으로 기본 도구 10개를 다시 확인했다(아래 표). 데스크톱 앱 Code 탭은 확인 창을 띄우지 않고 decline을 보내 요청이 rejected로 끝났다. 승인은 데몬 DB(`agent_approvals`·방 허가 사용 기록)로 교차 확인했다.

## 상태 표시

| 표시 | 뜻 |
|---|---|
| ✅ | 현재 도구로 실계정에서 검증됨. "검증" 칸에 날짜와 확인 방법을 적는다 |
| 🟡 | 구현됨, 단위 테스트/fixture만 통과. 이전 도구의 실계정 증거가 있으면 "이전 증거"에 적는다 |
| ❓ | 막힘. 프로토콜이나 서버 동작을 모름 |
| ⬜ | 시작 전 |
| 🚫 | v1 범위 밖 |

쓰기 기능은 사람 승인(확인 창·패스키·방 허가)과 정책(일시정지, 상한, 속도 제한)을 거친다. 실계정 검증은 사용자가 지정한 방에서 사용자 승인을 받고 한다.

## 1. 기본 도구 (항상 보임)

| 기능 | MCP 도구 | 상태 | 검증 | 이전 증거 / 메모 |
|---|---|---|---|---|
| 세션·정책 상태 | `get_status` | ✅ | ✅ 2026-10-25 테스트 계정·SSH 터널 MCP 직접 호출: connected=true, ask 기본, 정책·승인 수단·권한 개수 표시(Claude Code에서도 같은 결과). ✅ 2026-10-26  배포 후 `memoChat`·`addFriendDailyLimit` 표시 확인. 단위: 연결·에이전트 모드(ask/trust, 설정 또는 기본값)·일시정지·상한·승인 수단·권한 개수, 본문 없음 | 이전 `get_status`·`get_policy` ✅ 2026-10-18 스모크 |
| 방 목록·상세·안읽음 | `list_chats` | ✅ | ✅ 2026-10-25 테스트 계정·SSH 터널 MCP 직접 호출: 목록 untrusted 표시, chatId+refresh 상세(멤버·접근 규칙). 전체 목록 refresh는 chatId 필요(INVALID_ARGUMENT). 단위: chatId 상세(멤버·접근 규칙), `refreshReadState`는 metadata만, `unreadOnly`는 서버 갱신 | 이전 `list_chats`·`get_chat_info`·`get_unread_summary`·`get_room_access` ✅(2026-10-18~22, read state server_unread 확인) |
| 방 찾기 | `find_chat` | ✅ | ✅ 2026-10-26 테스트 서버: `memberCount=1`만으로 나와의 채팅(MemoChat) 1건, ambiguous=false. 이전(2026-10-25)에는 인원수를 모르는 방을 빼던 필터 때문에 searched 0이었고 이후 수정에서 고침. 단위: 이름·참여자·인원수, 모호하면 ambiguous/incomplete | ✅ 2026-10-24 테스트 서버 지정 두 방 이름 검색 각각 1page/유일 후보(이전 surface, 도구 동일) |
| 친구 찾기 | `list_friends` | ✅ | ✅ 2026-10-25 테스트 계정·SSH 터널 MCP 직접 호출: 친구 18명, 전화번호 필드 없음. 단위 | 이전 `list_friends` ✅ 2026-10-18 주소록 검색. 전화번호는 저장·반환 안 함 |
| 메시지 읽기 | `read_messages` | ✅ | ✅ 2026-10-25 테스트 계정·터미널 Claude Code 2.1.308 확인 창: 권한 없는 나와의 채팅 history·search·가짜 grant 모두 POLICY_DENIED·본문 0, 승인된 일회성 grant(5개·1회·10분)로 1건 조회 후 usesLeft 0. 2026-10-26: 나와의 채팅에 이전 검증의 manual 규칙이 저장돼 있어 기본 허용 대신 확인 창 요청 → 데스크톱 앱 Code 탭이 자동 거절(POLICY_DENIED). 저장 규칙이 기본값보다 우선하는 설계대로. 터미널 CLI에서 `room_access immediate` 승인 뒤 무확인 읽기 ✅. 규칙이 없는 상태의 나와의 채팅 기본 허용과 한 번 호출 확인 창(이번만/항상, 답장도 묻지 않기) 승인 경로는 여전히 단위·격리 MCP 통합만🟡. 단위: history(로그 범위·날짜 범위+cursor)·recent·wait·search, 모드별 인자 분리, read grant 범위 `read_messages` | 이전 `get_history`·`get_recent_messages`·`wait_for_messages`·`search_messages` ✅(2026-10-18, 날짜 범위 2026-10-24 2pages/31records). 기본 deny, 명시 방·fresh unread0 필요. 읽음 표시 없음 |
| 숫자1 유지 미리보기 | `preview_unread` | 🟡 | 2026-10-25 테스트 서버: readGrantId 없으면 인자 단계 거부만 확인. 단위: manual 방 frozen bound + read grant `preview_unread`, agent `confirmRead` 거절 | 이전 `preview_unread_messages` ✅ 2026-10-22 지정 1:1 사용자 화면에서 1 유지 확인. 인계 |
| 받은 첨부 다운로드 | `download_attachment` | ✅ | ✅ 2026-10-26 테스트 서버·SSH 터널 MCP 직접 호출: 나와의 채팅 사진 `save=true` → `<dataDir>/downloads/<chatId>/<messageId>-<임의>`에 저장, SHA-1이 첨부 `cs`와 일치, 파일 600·폴더 700(서비스 사용자), `outputPath`는 unknown argument로 거부. 데스크톱 앱은 재시작 전 도구 목록을 써 `save`를 문자열로 보냈다(서버가 boolean 아님으로 거부). 단위 | 이전 `download_media` ✅ 2026-10-18 원본 SHA-1 일치, 2026-10-20 MINI 썸네일. 이제 에이전트가 고른 경로에 쓰지 않는다: 기본은 dataBase64, `save=true`는 `<dataDir>/downloads/<chatId>/`에만 저장(단위🟡). CLI는 받은 바이트를 자기 쪽에 쓴다 |
| 텍스트·답장·멘션 | `send_message` | ✅ | ✅ 2026-10-25 테스트 계정·터미널 Claude Code 2.1.308 확인 창: 첫 전송 확인 창 승인+묻지 않기→방 허가 생성, 두 번째 무확인(방 허가 사용), 철회 후 다시 확인 창, pause 중 POLICY_DENIED. 휴대폰 도착 확인. ✅ 2026-10-26: 방 허가 없는 나와의 채팅에 확인 창 없이 전송(sent_unverified). 단위/fixture: 한 번 호출, 허용 방 즉시, 아니면 확인 창 → 같은 requestId로 발신, 중복 0 | 이전 2단계 계약 ✅ 2026-10-24 테스트 서버 첫 승인 발신·도착 확인, 같은 방 두 번째 무확인 발신. 답장 ✅ 2026-10-18, 멘션 ✅ 2026-10-20 |
| 사진·파일·묶음 | `send_photos` | ✅ | ✅ 2026-10-25 테스트 계정·터미널 Claude Code 2.1.308 확인 창: inline 32×32 이미지 1장, 같은 방 허가로 무확인 전송, 휴대폰 도착 확인. 묶음·파일은 이번에 미시험. 단위: inline base64만, 데몬 파일 경로 거절, 묶음 중간 pause → unknown, 허가 없는 방의 첫 사진 확인 창은 방 전송 허가로 묻고 올바른 코드에만 허가(🟡, 실계정 미확인) | 이전 `send_media` ✅ 2026-10-18(사진·파일 체크섬 일치), `send_photo_bundle` ✅ 2026-10-22(두 사진 한 묶음 휴대폰 확인) |
| 메시지 수정·삭제 | `edit_or_delete_message` | 🟡 | 2026-10-25 테스트 서버: 나와의 채팅 삭제 확인 창 승인 후 서버 수락(applied_unverified), 휴대폰 표시 미확인. manual 방은 첫 시도에 confirmRead 필요로 거부됨(이후 수정에서 다음 행동을 알려 주는 오류로 바꿈, 2026-10-26 그 오류 문구 확인). ✅ 2026-10-26: 읽기 규칙 immediate인 나와의 채팅에서 내 메시지 삭제가 확인 창 없이 서버 수락(applied_unverified), 다시 읽은 저장소에서도 사라짐. 휴대폰 표시는 미확인. 단위: 나와의 채팅의 내 메시지는 승인 없음, 그 밖에는 항상 사람 승인, 내 저장 메시지만 | 이전 `edit_message` ✅ 2026-10-19, `delete_message` ✅ 2026-10-18 |
| 권한 목록 | `list_permissions` | ✅ | ✅ 2026-10-25 테스트 계정·SSH 터널 MCP 직접 호출: 전송 방·읽기 규칙·grant 개수, untrusted 표시. 단위: 무확인 전송 방(`recipient:`), 읽기 규칙(`room:`), 일회성 read grant, 본문 없음 | 이전 `list_grants` 🟡 |
| 권한 철회 | `revoke_permission` | ✅ | ✅ 2026-10-25 테스트 계정·터미널 Claude Code 2.1.308 확인 창: `recipient:` 철회 즉시 적용, 다음 전송은 방 허가 없이 새 확인 창 승인. 단위: 즉시, 승인 불필요, `room:`은 deny로 | 이전 `revoke_grant` 🟡(철회 후 보류 재시도 거부 `grant-revocation.test.ts`). 실계정 철회 ❓ |
| 나간 방 권한 자동 회수 | (자동: `leave_chat`·`LEFT` 푸시·LOGINLIST `delChatIds`) | 🟡 | 단위: 세 경로 모두 읽기 규칙·read grant 회수와 리스너 호출, 실패한 LEAVE는 유지, trust 모드에서도 넓어지지 않음(`room-access.test.ts`, `kakao-session.test.ts`). 전송 허가 회수는 `apps/mcp/src/index.ts` 연결(단위 없음) | `LEFT {chatId,lastTokenId,serviceId}` 모양은 ✅ 2026-10-25 테스트 서버 실계정 로그(휴대폰에서 방 나감, 키만 기록). 회수 동작 자체 실계정 ❓, `delChatIds` 내용 ❓ |
| 권한 요청 | `request_permission` | ✅ | ✅ 2026-10-25 테스트 계정·터미널 Claude Code 2.1.308 확인 창: room_access(deny→manual)와 read grant 각각 확인 창 승인 후 적용. deny 방은 read grant 전에 room_access가 필요해 호출 6번·승인 2번이었고, 이후 수정에서 read_messages가 스스로 묻고 deny 방도 일회성 grant를 받도록 바꿈(단위🟡). 단위: send / read(기본 read_messages·20개·1회·10분) / room_access, 사람 승인 후 같은 requestId로 적용. room_default(저장 규칙 삭제·기본값 복귀): 더 넓지 않으면 즉시, 나와의 채팅·trust처럼 기본값이 더 넓으면 `reset_room_access` 승인 후, 감사 기록(단위·격리 MCP 통합🟡). ✅ 2026-10-26 테스트 서버·터미널 Claude Code: 나와의 채팅 deny 저장 → `room_default` 한 번 호출 안에서 확인 창 코드 승인(approver `client:claude-code`) → applied, 저장 규칙 사라짐·`defaultMode`/`rule` immediate. 클라이언트 쪽 모델은 호출 안의 확인 창을 몰라 "승인 불필요"로 보고했다 | 이전 `prepare_operation`(allow_recipient·read_room·grant_room_access) 🟡 |
| 비상 정지 | `pause` | ✅ | ✅ 2026-10-25 테스트 계정·터미널 Claude Code 2.1.308 확인 창: true 즉시·발신 거부, false는 확인 창 승인 후 applied. 거부된 발신은 audit에 남지 않음(결함). 단위: true 즉시, false는 requestId + 사람 승인 | 이전 `set_pause` ✅ 2026-10-18 일시정지 중 발신 거부 |
| 승인 대기 | `wait_for_approval` | 🟡 | 단위: 패스키 승인·거절 즉시 반환, 시간 초과 `awaiting_approval` | 실제 휴대폰 패스키 미검증 |
| 작업 상태 | `get_operation` | 🟡 | 단위: requestId별 상태, 본문 없음 | |

## 2. `chats` 묶음

| 기능 | MCP 도구 | 상태 | 검증 | 이전 증거 / 메모 |
|---|---|---|---|---|
| 1:1 방 찾기 | `open_direct_chat` | 🟡 | 단위: 조회만, CREATE 안 함 | ✅ 2026-10-18 `needsCreate` 응답(조회 계약 동일) |
| 1:1 방 만들기 | `create_direct_chat` | 🟡 | 단위: 사람 승인, 대상 친구 context | 이전 confirm 계약 ✅ 2026-10-22 CREATE→두 멤버 확인 |
| 특정 멤버 조회 | `get_members` | 🟡 | 단위 | ✅ 2026-10-18 큰 방 발신자 5명 이름(도구 동일) |
| 방 메타(공지) 읽기 | `get_chat_meta` | 🟡 | 단위: read grant 범위 `get_chat_meta` | ✅ 2026-10-18 Notice·Title |
| 나에게서만 삭제 | `self_delete_messages` | 🟡 | 단위 | ✅ 2026-10-18 로컬 숨김(도구 동일, 응답에서 status 필드 제거) |
| 전달 | `forward_message` | 🟡 | 단위: 허용 방에서도 항상 사람 승인 | 이전 계약 실계정 2026-10-19 사진 전달 status0. 텍스트 전달은 -203 |
| 이모티콘 | `send_emoticon` | 🟡 | 단위: 항상 사람 승인 | 이전 계약 2026-10-19 type20 재전송 status0 |
| 방 나가기 | `leave_chat` | 🟡 | 단위 | 이전 confirm 계약 ✅ 2026-10-20 LEAVE status0. 되돌릴 수 없음 |
| 방 메타 쓰기 | `set_chat_meta` | 🟡 | 단위: 검토 context에 공지 본문 없음 | 이전 confirm 계약 ✅ 2026-10-20 공지 변경·복원 |
| 읽음 표시 | `mark_read` | 🟡 | 단위: 항상 사람 승인, ACK와 서버 unread 구분 | 이전 ✅ 2026-10-18 NOTIREAD status0 |

## 3. `friends` 묶음

| 기능 | MCP 도구 | 상태 | 검증 | 이전 증거 / 메모 |
|---|---|---|---|---|
| 주소록 재동기화 | `sync_friends` | 🟡 | 단위 | ✅ 2026-10-18 시작 로그 |
| 차단 목록 | `list_blocked_users` | 🟡 | 단위 | ✅ 2026-10-18 차단자 2명 조회. LOCO BLSYNC는 실계정에서 응답 없음 |
| 내 프로필 | `get_my_profile` | 🟡 | 단위 | ✅ 2026-10-19 멀티프로필 2개 |
| 친구 프로필 | `get_friend_profile` | 🟡 | 단위: numeric userId만 | ✅ 2026-10-19 친구 5명 |
| 상태 메시지 변경 | `update_my_profile` | 🟡 | 단위: 항상 사람 승인, 명시 profileId | 이전 계약 2026-10-20 변경·원복 status0. 서버 CAS 보장 없음 |
| 차단 | `block_user` | 🟡 | 단위 | 이전 confirm 계약 ✅ 2026-10-18 BLADDITEM status0 |
| 차단 해제 | `unblock_user` | 🟡 | 단위 | 이전 confirm 계약 ✅ 2026-10-18 BLDELITEM status0 |
| 친구 추가 | `add_friend` | 🟡 | 단위: 하루 한도 `KAKAO_ADD_FRIEND_DAILY_LIMIT`(기본 10, 두 모드 모두)를 승인 요청 전에 확인하고 승인 뒤 실행 직전에 예약, 재시작 후 유지·다음 날 초기화 | 이전 confirm 계약 ✅ 2026-10-18 status0 |

## 4. `events` 묶음

| 기능 | MCP 도구 | 상태 | 검증 | 이전 증거 / 메모 |
|---|---|---|---|---|
| 영속 메시지 lease | `claim_message_events` | 🟡 | 임시 SQLite: 원자성·backlog·재시작 재전달 | 로컬 관찰 이후 메시지만. live 완전성 미검증 |
| 영속 처리 확인 | `ack_message_events` | 🟡 | 임시 SQLite: rollback·중복·만료 거절 | consumer idempotency 필수 |

## 5. `vault` 묶음 (`KAKAO_MCP_TOOL_GROUPS=vault`)

| 기능 | MCP 도구 | 상태 | 검증 | 이전 증거 / 메모 |
|---|---|---|---|---|
| 대화 내역 내보내기 | `export_chat_history` | 🟡 | 단위 테스트: 방 접근 정책(`RoomAccessPolicy`) 적용, 고정 디렉터리(`vault/exports/`) 저장, JSON/HTML 렌더링 | 기본 꺼짐. deny 방 거절, manual 방 readGrantId 필수 |
| 공유 링크 수집 | `collect_shared_links` | 🟡 | 단위 테스트: 방 접근 정책 적용, URL 카테고리화(YouTube, GitHub, Figma, 기사 등), untrusted 래핑 | 기본 꺼짐. deny 방 거절, manual 방 readGrantId 필수 |
| 일정·할일 추출 | `extract_schedule_and_todos` | 🟡 | 단위 테스트: 방 접근 정책 적용, 약속 시간/장소 및 투두 파싱, untrusted 래핑 | 기본 꺼짐. deny 방 거절, manual 방 readGrantId 필수 |
| 볼트 메시지 검색 | `search_vault` | 🟡 | 단위 테스트: 명시적 chatIds 필수, 모든 방 개별 정책 검증(하나라도 실패 시 전체 거절) | 기본 꺼짐. 교차 방 전역 검색 불가 |
| 볼트 통계 조회 | `get_vault_stats` | 🟡 | 단위 테스트: 저장 파일 수·용량·내보내기 개수만 반환, 방 제목/본문 미포함 | 기본 꺼짐 |

## 6. MCP 도구가 아닌 것

| 기능 | 경로 | 상태 | 검증 | 메모 |
|---|---|---|---|---|
| 토큰 자동 갱신·일반 재로그인 | (내부) | ✅ | 2026-10-24 테스트 서버 기존 기기 일반 재로그인 1회 성공·토큰 저장 | 24시간 최대 3회, 거절·충돌 시 영속 중단 |
| 리눅스 기기 등록 | `npm run register` | ☑️ | 2026-10-16 이전 세션 보고 | 휴대폰 승인 흐름 |
| 미디어 지속 보관(스트리밍) | (내부 데몬 플래그, `KAKAO_VAULT_AUTO_SAVE`) | 🟡 | 단위 테스트: 조각 sink 스트리밍 임시 파일 작성→원자적 확정, 크기·체크섬 검증 실패 시 파기, 디스크 상한(`KAKAO_VAULT_MAX_BYTES`/`KAKAO_VAULT_MIN_FREE_BYTES`), 순차 다운로드 속도 조절, 보낸 사람이 정한 파일 이름으로 vault 밖 경로 불가, 프레임 분할 수신, 유휴 시간 제한(총 시간 제한 없음) | 기본 꺼짐. 사용자 서버 자체 보관 기능. 로그에 ID·내용 미포함. `ask` 모드에서 켤 수 없게 하는 제약은 `KAKAO_AGENT_MODE` 구현 대기. 실서버 대용량 다운로드 ❓ |
| 설치 마법사 | `npm run setup` (`scripts/install.sh`) | 🟡 | 2026-10-24 별도 테스트 계정 4자리 인증→systemd→SSH connected=true ✅는 이전 진입점 시절 | 진입점이 `scripts/install.sh`로 바뀐 뒤 재검증 필요. [설치 운영](runbooks/mcp-setup.md) |
| 기존 데몬 연결 | `connect.ts` / setup 연결 설정 | 🟡 | 실제 Unix/TCP·SSH -W fixture | 실제 AI 앱·사람 승인 연결은 별도 증거(첫 발신) |
| 관리형 설치 마이그레이션 | `update-managed.ts` (`--update-managed-mcp`) | ✅ | 2026-10-26 테스트 서버: `kakaotalk-mcp` → `kakao-max` 이전, Linux 전체 테스트 통과 후 실행, 서비스 enabled·재시작 0회·경고 0, uid/gid 유지, 새 기기 등록 없음, `get_status` connected(같은 계정). 단위 21건(: `KAKAO_AUDIT_LOG` 이동·옛 경로 설정 거부 포함) | `KAKAO_AUDIT_LOG`는 테스트 서버에서 손으로 옮겼고, 이를 자동으로 하는 코드는 단위 테스트만(🟡) |

## 7. 막힘·범위 밖

| 기능 | 상태 | 이유 |
|---|---|---|
| 전체 방 목록(LOGINLIST 밖) | 🚫 | 서버가 새 기기에 약 50개만 준다. 그 밖의 과거 방은 가져올 수 없다 |
| 오픈채팅 동기화 | ❓ | `SYNCLINK` 응답에 `ols` 없음(계정에 오픈채팅이 없을 수 있음) |
| 공지 등록(게시판) | ⬜ | Alaska 게시판 HTTP API, LOCO 아님 |
| 보이스톡·페이스톡 | 🚫 | WebRTC + 별도 시그널링 |


## 대화형 CLI

`kakao shell`은 기존 MCP 도구를 사용하는 클라이언트이며 새 도구·로그인 경로를 추가하지 않습니다.

| 기능 | 상태 | 검증 범위 |
|---|---|---|
| ls/-al, cd·Tab 자동완성, 입장 시 최근 30개, history/older, 입력 전송 | 🟡 | 실계정: 기존 데몬 연결·방 선택 Tab 완성·최근 대화 조회 확인. CLI 단위 fixture: 중복 이름·조회 순서·페이지 경계·실패 시 대상 해제·UUID·결과 불명 시 후속 전송 차단. 이 대화형 입력의 실제 발신과 older는 fixture 검증만 |
| 촬영 모드의 방·발신자 가명과 공개 방 제한 | 🟡 | 실계정: 목록의 방 가명·발신자 가명·알림 메타데이터 숨김 확인. 단위 fixture: 비공개 방 조회 차단·오류 텍스트·터미널 제어문자 처리. 본문 안의 실명은 자동 익명화하지 않음 |
| 터미널의 사람 확인 코드 입력 | 🟡 | MCP 클라이언트 TCP fixture: 명시한 form 처리기에서만 승인 응답, 처리기 없으면 취소. 실제 터미널·실계정 승인은 미검증 |


### 터미널 메신저 화면

`kakao chat`은 조회·전송 모두 기존 MCP와 데몬의 ask/trust 정책을 사용합니다. 별도 사람용 조회 소켓과 API는 사용하지 않습니다. [터미널 메신저 설계](designs/terminal-messenger.md)를 보세요.

| 기능 | 상태 | 검증 범위 |
|---|---|---|
| 방 검색·방향키 선택·최근 대화·입력창 | 🟡 | 기존 실계정 화면·발신 사용자 확인과 별개로 현재 MCP 어댑터는 fixture 검증: 검색·가명·최근30개·일반 입력·한글/이모지·화면 크기 |
| 공통 MCP 조회·모드 표시 | 🟡 | fixture: get_status/list_chats/read_messages만 사용, ask/trust 표시, 정책 오류 그대로 전달·fallback/모드 변경 없음, recent cursor·중복 제거·200개 상한·이전 방 지연 응답 폐기 |
| 붙여넣기·승인·전송 오류 | 🟡 | fixture: 붙여넣기 자동 제출 방지·사람 입력 승인·remember=false 기본·이번만 읽기 뒤 polling 중지·결과 불명 후 새 전송 차단. 기존 메신저 발신은 사용자 수신 확인; 이번 통합 이후 실제 발신은 미시험 |

기존 소유자 전용 조회 경로의 실계정 증거는 현재 MCP 경로의 검증으로 간주하지 않습니다. ask는 안읽은 방 제한을 유지하고, trust는 해당 제한을 해제하지만 명시한 방 제한과 운영자 상한은 유지합니다. 과거 메시지 수정·삭제의 완전한 자동 반영은 보장하지 않으며 수동 refresh로 최근 기록을 재조회합니다.


## MCP 이벤트 구독

| 기능 | 상태 | 검증 / 범위 |
|---|---|---|
| 방 변경 리소스 구독 | ✅ | 실계정: trust에서 유휴 추가 조회 없음, 새 메시지 알림 1회·조회 1회·화면 반영, 터미널 TCP 재연결 후 최근 기록 재조회·구독 복구 확인. 통합 fixture: 초기화된 연결의 구독/해제, 본문 없는 알림, 권한·pause 중단, 연결 정리. 데몬 내부 계정 연결 복구는 fixture 검증만. 내용은 기존 read_messages 권한·예산 적용. |
