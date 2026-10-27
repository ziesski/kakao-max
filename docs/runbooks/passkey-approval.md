# 승인 운영: 클라이언트 확인 창과 패스키

2026-10-25 🟡 현재 도구 경로는 단위·격리 MCP 통합/HTTP fixture 검증입니다.
실제 패스키 기기의 등록·승인, 새 구현의 실계정·배포 검증은 남아 있습니다.
[현재 도구 계약](../tool-contract.md)과 [방 권한](mcp-room-permissions.md)을 함께 읽으세요.

처음 보내는 방은 사람이 승인하고, “앞으로 묻지 않기”를 선택하면 그 방의 메시지·사진을
하루 한도 안에서 허용합니다. 나가기·삭제·권한 확대 등은 개별 승인을 유지합니다.
허가 목록은 `list_permissions`, 철회는 `revoke_permission`의 `permissionId`입니다.
확인 창은 올바른 코드를 입력해야 승인됩니다. Enter나 빈칸은 승인하지 않습니다.

## 승인 수단 두 가지

| 수단 | 기본 | 언제 |
|---|---|---|
| MCP 클라이언트 확인 창 | 켜짐 (`KAKAO_APPROVAL_CLIENT_CONFIRM=off`로 끔) | form elicitation을 지원하는 initialize 또는 MCP 2026-07-28 클라이언트. 쓰기 도구를 부르면 클라이언트가 사람에게 묻는다 |
| 패스키 페이지 | 꺼짐 (아래 설정 필요) | 확인 창을 못 띄우는 클라이언트, 사진 승인(미리보기), 원격·무인 환경 |

오프라인 서명기는 2026-10-24에 제거했다(`KAKAO_AGENT_APPROVAL_PUBLIC_KEY_FILE`이 남아 있으면 시작 시 `CONFIG_INVALID`).

확인 창은 모델이 답할 수 없지만, 사람에게 보여주지 않고 자동으로 답하는 클라이언트라면 보호가 없다. 그런 클라이언트를
쓰면 확인 창을 끄고 패스키를 쓴다.

## 패스키 페이지가 하는 일

에이전트가 쓰기 도구를 `requestId`와 함께 호출하면 승인 전에는 외부 작업을 실행하지 않습니다.
패스키 페이지가 설정돼 있으면 `APPROVAL_REQUIRED`의 `details.passkey.approvalUrl`을 사람에게 전달합니다.
사람이 내용을 검토하고 승인하면 에이전트는 `wait_for_approval` 뒤 같은 도구·인자·requestId로 다시 호출합니다.

- 승인은 WebAuthn user verification이 있어야 통과한다. 링크를 아는 것, 버튼을 누르는 것, 브라우저 자동화로는 승인할 수 없다.
- 초안은 데몬 메모리에만 있다. 재시작하면 대기 중인 승인 링크는 사라지고, 다시 준비한다.
- DB(`agent_approvals`)에는 서명 텍스트의 HMAC, 승인자 ID, 시각만 남는다.
- 알림을 켜면 설정된 알림 수신지(보통 나와의 채팅)에 코드와 링크만 보낸다. 본문·방 이름·작업 종류는 넣지 않는다.

## 설정 (`.env.local`, git 배포로만 반영)

```bash
KAKAO_APPROVAL_LISTEN=127.0.0.1:8788          # loopback만 허용
KAKAO_APPROVAL_ORIGIN=http://localhost:8788   # 또는 https://<호스트>.<tailnet>.ts.net
KAKAO_APPROVAL_NOTIFY=on                      # 알림 수신지가 설정돼 있을 때만 보냄, off로 끔
KAKAO_APPROVAL_WINDOW_MINUTES=15              # prepare부터 승인 마감까지(5–30분), 기본 15
KAKAO_APPROVAL_WINDOWS={"leave_chat":5}       # 선택: action별 덮어쓰기(5–30분)
```

승인한 뒤에는 5분 안에 에이전트가 실행(commit)해야 한다. 이 5분은 승인 마감을 넘어가도 된다.

- WebAuthn은 origin에 묶인다. 등록한 origin을 바꾸면 그 패스키는 다시 등록해야 한다.
- 휴대폰에서 승인하려면 HTTPS origin이 필요하다. 예: 데몬 호스트에서 Tailscale serve로 `https://<호스트>.<tailnet>.ts.net` →
  `http://127.0.0.1:8788`을 연결하고, 그 주소를 `KAKAO_APPROVAL_ORIGIN`에 넣는다. 공개 인터넷에 열지 않는다.
- 같은 머신의 브라우저만 쓸 거라면 `http://localhost:8788`로 충분하다(SSH 터널 `ssh -L 8788:127.0.0.1:8788 <호스트>`도 가능).

## 패스키 등록

데몬이 도는 호스트의 **대화형 터미널**에서, 데몬과 같은 사용자로:

```bash
npm run approver --workspace=@kakao-max/mcp -- enroll
```

1회용 등록 코드(10분, 5회 틀리면 폐기)와 `<origin>/enroll` 주소가 나온다. 그 주소를 승인에 쓸 기기에서 열고 코드를 넣은 뒤
패스키를 만든다. 등록은 `~/.kakao-max/approvers.json`(0600, 기존 설치는 `~/.kakao/approvers.json`)에 기록된다. MCP에는 등록·삭제 도구가 없다.

```bash
npm run approver --workspace=@kakao-max/mcp -- list
npm run approver --workspace=@kakao-max/mcp -- remove <id>   # 그 패스키로 받은 기존 승인도 즉시 무효
```

## 위협 모델 한계

- 에이전트가 데몬과 **같은 OS 사용자**의 shell을 가지면 `approvers.json`과 등록 코드 파일을 고칠 수 있다. 이 경우 승인은
  보장되지 않는다. 데몬을 별도 OS 사용자로 돌린다.
- 승인 페이지의 초안 조회는 링크의 토큰(URL fragment)으로 보호한다. 토큰을 아는 사람은 초안을 볼 수 있지만 승인할 수는 없다.
- 대기 중인 승인은 최대 5개다. 넘치면 승인 링크를 만들지 못하며 작업은 승인 필요 상태로 남습니다.
