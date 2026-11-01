# MCP 도구와 권한 계약

2026-10-25 🟡: 현재 구현의 단위·격리 MCP 통합 테스트 기준입니다. 기본 도구의 실계정 확인은 [기능 매트릭스](agent-capability-matrix.md)에
있고, 한 번 호출 읽기 승인과 나와의 채팅 기본 허용은 아직 실계정에서 확인하지 않았습니다.

## 기본 도구 16개

| 도구 | 용도 |
|---|---|
| `get_status` | 연결, pause, 상한·속도 제한, 나와의 채팅 기본값, 친구 추가 하루 한도·오늘 사용량, 승인 수단, 활성 묶음, 권한 개수 |
| `list_chats` | 방 목록; `chatId`로 상세·접근 규칙, `refresh`·`refreshReadState`로 metadata 갱신(목록에 없는 방은 정확한 방 metadata로 읽음 확인) |
| `find_chat` | 제목·참여자·인원수 검색; 모호하거나 다음 페이지가 있으면 계속 확인 |
| `list_friends` | 주소록 검색 |
| `read_messages` | 한 방의 history/recent/wait/search; 날짜 범위는 from/to와 cursor로 페이지 조회. 닫힌 방이면 같은 호출에서 사람에게 묻습니다 |
| `preview_unread` | 승인된 frozen bound 뒤 로컬 수신 본문만 최대 20개 조회 |
| `download_attachment` | 허용된 방의 저장 메시지에 속한 첨부 다운로드 |
| `send_message` | 텍스트·답장·멘션 전송 |
| `send_photos` | 인라인 바이트로 사진·묶음·파일 전송; 데몬 파일 경로는 받지 않음 |
| `edit_or_delete_message` | 저장된 본인 메시지 수정·삭제 |
| `list_permissions` | 방 전송 허가·읽기 규칙·일회성 읽기 허가 |
| `revoke_permission` | `recipient:<chatId>`, `room:<chatId>` 또는 읽기 허가 ID 즉시 철회. 계정이 방을 나가면(이 MCP·다른 기기·로그인 때 서버 삭제 목록) 그 방의 전송 허가·읽기 규칙·읽기 허가는 자동 철회되고, 다시 들어가면 새로 묻습니다 |
| `request_permission` | send/read/room_access 허가 요청; 사람 승인 전 변경 없음. read_messages는 스스로 묻으므로 read는 다른 읽기 도구용. room_default는 저장된 읽기 규칙을 지워 기본값으로 되돌림: 기본값이 더 넓지 않으면 즉시, 더 넓으면(나와의 채팅, trust) 사람 승인(`reset_room_access`) 후 |
| `pause` | true는 즉시 중단, false는 사람 승인으로 해제 |
| `wait_for_approval` | 패스키 페이지의 사람 결정을 기다림 |
| `get_operation` | requestId로 내용 없는 처리 상태 조회 |

일반 쓰기는 정확한 인자와 에이전트가 선택한 UUID `requestId`로 한 번 호출합니다.
사전 방 허가가 없으면 클라이언트 확인 창이 사람에게 묻습니다. 확인 창이 없으면
`APPROVAL_REQUIRED` 오류의 `details.passkey.approvalUrl`을 사람에게 전달하고,
`wait_for_approval` 뒤 같은 도구·인자·requestId로 다시 호출합니다. 패스키를 설정하지 않았다면
지원하는 클라이언트 확인 창이나 패스키 설정이 필요합니다. 에이전트가 대신 승인할 수 없습니다.

확인 창의 올바른 코드만 입력하면 해당 작업만 승인합니다. “앞으로 묻지 않기”도 선택하면
그 방의 후속 일반 메시지·사진을 일일 한도 안에서 허용합니다. 방 읽기 확인 창에서
“이 방에 답장도 묻지 않고 보내기”를 선택하면 같은 전송 허가를 함께 줍니다. 사진은 확인 창에 보여 줄 수 없으므로
확인 창은 그 방의 전송 허가를 묻고, 승인하면 이 사진과 이후 메시지·사진을 보냅니다. 사진 한 장만 승인하려면
실제 바이트의 패스키 미리보기를 씁니다. 결과 불명 오류는 자동 재전송하거나 새 requestId로 대체하지 않습니다.
권한 철회·pause(true)·로컬 메시지 숨기기는 허가를 줄이는 작업이므로 즉시 적용합니다.

닫힌 방(deny·manual)에서 `read_messages`를 부르면 서버가 같은 호출 안에서 확인 창을 띄웁니다.
그대로 승인하면 이번 한 번만 읽고(일회성 읽기 허가, 방 규칙은 그대로), “이 방은 앞으로 묻지 않고 읽기”를
켜면 방 규칙을 immediate로 바꿉니다. 확인 창이 없는 클라이언트는 `APPROVAL_REQUIRED` 오류에 적힌
requestId를 사람이 승인한 뒤 `read_messages`에 그대로 넘겨 다시 부릅니다.
클라이언트 확인 창이 decline을 돌려주면 그 작업은 거절로 기록됩니다. 일부 클라이언트는 창을 보여 주지 않고
스스로 decline합니다. 서버는 둘을 구분할 수 없으므로 [호환 목록](QUICKSTART.md#ai-클라이언트-호환)을 확인합니다.

## 선택형 도구 묶음

`KAKAO_MCP_TOOL_GROUPS=chats,friends,events,vault` 중 필요한 묶음을 선택합니다.
기본은 없음이며, 꺼진 묶음은 목록에도 없고 호출도 할 수 없습니다.

| 묶음 | 도구 |
|---|---|
| chats | open_direct_chat, create_direct_chat, get_members, get_chat_meta, self_delete_messages, forward_message, send_emoticon, leave_chat, set_chat_meta, mark_read |
| friends | sync_friends, list_blocked_users, get_my_profile, get_friend_profile, update_my_profile, block_user, unblock_user, add_friend |
| events | claim_message_events, ack_message_events |

## 권한 두 층

1. 운영자 상한·속도 제한: `KAKAO_ROOM_CEILING`(비면 상한 없음), pause, 전체/방별 속도 제한.
   사람 승인도 이 제한을 넘지 못합니다. `KAKAO_NOTIFY_CHAT_ID`의 데몬 승인 알림과 일반 에이전트 발신에도
   같은 방 상한이 적용됩니다. 비어 있지 않은 상한 밖의 알림 방에는 알림도 보내지 않습니다.
2. 방 허가: 전송은 방별 메시지·사진 허가, 읽기는 deny/manual/scheduled/immediate 규칙과
   deny·manual 방의 제한된 일회성 읽기 허가입니다. 서로 독립이고 읽음 표시도 별도 승인입니다.
   에이전트가 넘긴 `confirmRead`는 승인된 작업 안의 manual 방에서만 인정하고 deny 방은 열지 않습니다.

계정 본인의 나와의 채팅(서버 방 종류 `MemoChat`로만 판별)은 모든 모드에서 승인 없이 읽고, 보내고,
본인 메시지를 수정·삭제합니다. 다른 사람이 쓰지 않고 보낸 내용이 누구에게도 가지 않기 때문입니다.
pause·상한·속도 제한·방 허가 하루 한도는 그대로이고, 저장된 규칙(deny, manual 등)이 있으면 그 규칙을 따릅니다.
`revoke_permission room:<chatId>`는 규칙을 지우지 않고 deny를 저장합니다. 기본 허용으로 되돌리려면
`request_permission type=room_default`로 사람 승인을 받습니다. 읽음 표시·나가기·방 정보 변경은 이 예외에 들어가지 않습니다.

읽기 허가는 기본 read_messages, 20개, 1회, 10분입니다. unread/unknown 방의 일반 본문 조회 제한은
유지됩니다. 특별 unread preview도 별도 수동 규칙·짧은 만료·읽기 허가가 있어야 합니다.
고정 문구 사전 승인 기능은 제거했습니다. 방 허가는 전송 문구를 제한하지 않으므로 승인할 때
그 차이를 확인해야 합니다. `KAKAO_RECIPIENT_DAILY_LIMIT`는 방 허가 사용의 하루 한도(기본 50)입니다.
`add_friend`는 모드와 관계없이 `KAKAO_ADD_FRIEND_DAILY_LIMIT`(1–100, 기본 10) 안에서만 실행됩니다.
한도에 닿으면 승인을 묻지 않고 `RATE_LIMITED`(retryable=false)로 거절하며, 승인 뒤 실행 직전에도 다시 확인합니다.

이전 프로필·권한 모델·오프라인 서명기 설정은 시작 시 `CONFIG_INVALID`입니다. 관리형 업데이트는
이 키가 남아 있으면 데몬을 멈추기 전에 키 이름을 알리고 중단합니다.
`KAKAO_MCP_PROFILE`, `KAKAO_MCP_PERMISSION_MODEL`, `KAKAO_AGENT_APPROVAL_PUBLIC_KEY_FILE`을 제거하고,
`KAKAO_ALLOWED_CHAT_IDS`를 쓰던 운영자 상한은 `KAKAO_ROOM_CEILING`으로 바꿉니다.
옛 prepare/commit 도구와 agent confirm 인자는 지원하지 않습니다. 기존 대기 작업은 새로 검토합니다.


## 방 변경 리소스 구독

초기화된 stateful MCP 연결은 `kakao://rooms/{chatId}/messages`를 `resources/subscribe` / `resources/unsubscribe`로 구독할 수 있습니다. 리소스 템플릿은 `resources/templates/list`에 공개하고 실제 방 목록은 기존 `list_chats`를 사용합니다. stateless modern 요청은 구독 상태를 유지하지 않으며, legacy `initialize` 연결에서만 subscribe=true를 광고합니다. [MCP 리소스 규격](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)을 따릅니다.

`notifications/resources/updated`의 `params`는 `{uri, _meta: {subscriptionId}}`입니다. 본문·작성자·프로필·메시지 ID는 전달하지 않습니다. `_meta.error.code`가 있으면 해당 구독이 중지된 것입니다. 리소스 읽기는 내용 없는 종류 설명만 반환하고, 메시지 본문은 항상 기존 `read_messages`를 통합니다. 알림과 유휴 구독은 내용 조회 예산을 사용하지 않으며 실제 본문 조회의 한도는 유지됩니다.

구독 때와 알림 직전에 기존 방 규칙·ask 읽음 상태·연결 상태를 확인합니다. pause·운영자 방 상한도 적용합니다. 권한 철회, 만료, 방 나가기, 연결 단절 시 해제하며 연결당 최대 한 방, 계정 core당 최대 64개로 제한합니다. `subscriptionId`는 재구독 세대를 구분해 늦은 알림을 버리는 데만 사용합니다. `read_messages` history의 `liveCursor`는 초기 조회 전의 일시적 피드 위치이고 recent의 `hasMore`는 다음 묶음 조회 신호입니다. 피드 cursor는 재시작을 넘는 영속 체크포인트가 아닙니다.
