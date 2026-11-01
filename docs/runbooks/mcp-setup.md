> 최신 사용자 진입점: [QUICKSTART](../QUICKSTART.md). 설치 포트 선택·자동 진단·비밀번호 선택 저장·범용 repair·재연결 커넥터는 아래 과거 직접 SSH 설정보다 최신입니다. 기존 설정은 다시 생성해야 자동 재연결을 사용합니다.

> 현재 도구·권한은 [단일 계약](../tool-contract.md)을 따릅니다. 아래 호스트별 실행 증거는 이전 버전 기록이며 새 구현의 실계정 검증을 뜻하지 않습니다.

# Linux 첫 설치와 기존 MCP 데몬 연결

🟡 단위 테스트와 실제 Linux Git/build/권한/systemd·SSH fixture로 검증했다. 별도 테스트 계정에서 휴대폰 인증→서비스 시작→SSH
`get_status` connected=true까지 ✅. 지원 AI 클라이언트의 사람 승인·첫 전송/철회를 잇는 전체 E2E는 아직 ❓다.

## 진입점

```bash
npm ci
npm run setup
```

첫 선택은 기존 연결 또는 새 Linux 설치다. 선택하지 않으면 종료한다. 입력/안내는 사람의 TTY를 요구한다.
비밀번호는 raw terminal에서 echo하지 않는다. 일반 CLI 자동 입력으로 승인을 대체하는 흐름은 없다.
단, TTY가 악성 OS 사용자에 대한 인증 수단이라는 뜻은 아니다. 설치 코드를 실행하는 운영자와 sudo 권한을 신뢰한다.

새 설치는 먼저 일반 사용자 권한으로 `git fetch origin main`을 한다. 이후 유일한 배포 진입점으로 넘어간다:

```bash
sudo scripts/install.sh bootstrap
```

기본 loopback 포트 8787이 사용 중이면 기존 서비스를 멈추지 말고 빈 포트를 명시한다:

```bash
sudo scripts/install.sh bootstrap --port 18787
```

포트는 1024–65535 범위이며 공개 인터페이스 대신 `127.0.0.1`에만 바인딩한다. 설치 상태에 저장하므로
재개할 때도 같은 `--port`를 사용한다. 연결 설정에도 `--listen 127.0.0.1:18787`을 지정한다.

이 명령은 실제 새 호스트에서 사람이 마법사를 진행할 때만 실행한다. root·Linux·TTY와 깨끗한
HEAD=origin/main을 요구한다. 브랜치·미커밋 코드는 설치하지 않는다.
소스 체크아웃에 `.env.local`이 있거나 기존 unit·동명 서비스 계정·사용 중인 포트가 있으면 새 설치를 거부한다.

## 설치 단계와 재개

1. 설치 명령을 실행하면 전용 사용자/그룹을 만들고 Git으로 고정 커밋을 설치한다. `--no-local` clone으로 소스의
   object store를 공유하지 않는다. npm lifecycle script를 끄고, 서비스 사용자로 의존성 설치·protocol 빌드를 한다.
2. 빌드된 코드의 소유권은 root로 돌린다. 서비스 사용자는 코드·unit·설치 manifest를 수정할 수 없다.
   코드 그룹은 전용 서비스 그룹이고 디렉터리/실행 파일0750·일반 파일0640으로 정규화한다.
   설치자의 umask077이어도 서비스가 코드를 읽을 수 있다. credentials는 별도로 서비스 사용자0600이다.
   root 소유 home에 npm 기본 cache를 만들지 않도록 서비스 사용자 소유 build-cache와 app CWD를 명시한다.
   성공 시 dependency cache는 제거하고, 실패 시 같은 작업의 재개에만 사용한다(계정 데이터 없음).
3. 이메일·숨김 비밀번호를 입력하면 바로 휴대폰 승인 로그인을 요청한다. `PREPARE`·`LOGIN` 중복 입력은 없다.
   비밀번호는 화면·manifest·argv·설치 로그에 남기지 않는다. 성공 후 사람이 자동 재로그인 저장에 동의한 경우에만 서버의 비공개 env에 저장한다. 로그인 결과의 원문·토큰·실제 계정 ID도 출력하지 않는다.
   서버가 sign=true를 반환하면 휴대폰 승인 알림을 기다린다. sign=false이면 기존 번호 발급 API를
   사용해 터미널에 4자리 코드를 표시하고 휴대폰 카카오톡에서 입력하도록 안내한다(✅ 지정 테스트 계정에서 등록·시작 확인).
   코드는 사람이 볼 터미널에만 출력하며 진단 trace·설정·파일에 저장하지 않는다.
   인증 방식 표시가 없거나 이상하면 다른 경로를 추측하지 않고 중단한다.
4. -101이면 기본은 중단하고 기존 PC를 유지한다. 이번 요청에서 사람이 `[y/N]` 질문에 Y로 답한 경우에만
   같은 device UUID로 한 번 다시 시도한다. 기존 데몬을 멈추거나, 자동 refresh에서 takeover하지 않는다.
5. 성공한 토큰·기기 키를 서비스 사용자 소유 0600 env 파일에 원자적으로 저장한다. 사람에게 버전·경로·
   실행 계정·연결 포트를 보여주고 `서비스를 등록하고 시작할까요? [Y/n]`으로 묻고 Enter 또는 Y로 답하면 systemd에 등록·시작한다. 시작을 취소하면 설정만 보존한다.
6. get_status의 연결 상태와 기대 계정 ID를 대조해 확인한다. 제한된 횟수의 상태 조회만 하며,
   실패를 성공으로 표시하거나 로그인·서비스 재시작을 반복하지 않는다.

root 소유 `install-state.json`은 building/prepared/configured/running 단계와 커밋을 보관한다.
실패한 휴대폰 인증의 pending device UUID는 재개를 위해 0600 manifest에 잠시 보관하고,
credentials 저장 후 manifest에서 제거한다. 이는 대화·사용자 데이터 백업이 아니다.
빌드 실패는 같은 checkout에서 재개하고, 이미 저장한 credentials가 있으면 다시 등록하지 않는다.
실행 중인 정상 설치는 재시작하지 않는다. operator-paused가 있으면 재개하지 않는다.

강제 종료로 `/var/lib/kakao-max.install-lock`이 남았다면 PID와 실행 중인 설치/서비스를 먼저 확인한다.
자동으로 잠금을 지우거나 다른 프로세스를 중지하지 않는다. 상태 파일이 없거나 버전·권한·unit 내용이
달라진 설치는 자동 복구 대상으로 취급하지 않는다. 자격증명이나 unit이 생성된 설치는 다른 커밋으로
업데이트하지 않는다. 로그인 실패 후 prepared 상태이고 자격증명·unit이 없으며 data가 비어 있고,
설치 checkout이 깨끗한 이전 main 커밋일 때만 최신 main으로 빌드를 갱신한다. pending 기기 키는 보존한다.

## 경로와 권한

| 경로 | 소유/역할 |
|---|---|
| `/var/lib/kakao-max/app` | root, Git 코드·빌드 결과, 서비스 사용자에게 쓰기 불가 |
| `app/.env.local` | 서비스 사용자 0600, 토큰·기기 키·데몬 설정, 비밀번호 없음 |
| `/var/lib/kakao-max/data` | 서비스 사용자 0700, core DB·정책·journal·audit |
| `/var/lib/kakao-max/install-state.json` | root 0600, 설치 재개 metadata |
| `/var/lib/kakao-max/deploys.log` | root 0600, 성공 시각·actor·고정 커밋·이유, 계정/본문/토큰 없음 |
| `/etc/systemd/system/kakao-max.service` | root, 생성한 system unit |

새 설치에는 notify destination·env allowlist·사전 방 허가를 넣지 않는다. 프로필 선택 없는 단일 도구 목록·방 허가,
자동 재로그인 꺼짐, loopback MCP만 설정한다. 방 내용 조회·읽음은 독립된 권한이다.
서비스는 ProtectSystem=strict/ProtectHome/NoNewPrivileges를 쓰고 데이터와 env 파일만 쓸 수 있다.
설정값은 계정의 데이터 저장을 self-host한다는 뜻이며, AI에게 보여준 내용은 AI 제공자로 전달될 수 있다.

## 연결 프로그램

### 관리형 설치 갱신

`apps/mcp/src/update-managed.ts`가 관리형 `/var/lib/kakao-max`(또는 옛 이름 `/var/lib/kakaotalk-mcp`)의 실행 중인 설치를 갱신한다.
clean main과 이전 commit, unit 일치, 같은 계정 연결, operator pause 부재를 확인한다. 하나라도 어긋나면 아무것도 멈추지 않는다.
Git fetch 후 기존 daemon을 먼저 멈추고 코드를 갱신·빌드한 뒤 시작한다. 자격증명·기기 키·data/journal을 보존하며
계정 등록·강제 로그인·백업을 하지 않는다.

갱신 실패(`npm ci`·`tsc` 실패 등) 때의 동작:

1. 데몬을 멈춘 직후, 코드를 바꾸기 전에 `install-state.json`에 `phase: configured`와 시도 중인 커밋(`pendingUpdate`)을 기록한다.
   기존 고정 커밋(`commit`)은 그대로 둔다. 기존 `node_modules`는 `/var/lib/kakao-max/rollback/`으로 옮겨 둔다.
2. 빌드가 실패하면 기존 커밋을 다시 checkout하고 옮겨 둔 `node_modules`를 되돌린 뒤 `tsc`만 다시 실행한다(내려받기 없음).
3. 되돌린 코드가 기존 커밋과 정확히 같고 `.env.local`이 바뀌지 않았을 때만 같은 서비스를 한 번 시작하고 같은 계정 연결을 확인한다.
   성공하면 manifest는 갱신 전 상태(`phase: running`, 기존 커밋)로 돌아가고, 오류는 "이전 버전을 복원해 실행 중"이라고 보고한다.
   원인을 고친 뒤 평소처럼 다시 갱신한다.
4. 복원까지 실패하면 서비스는 멈춘 채로 두고 `pendingUpdate`가 남는다. 이때 일반 갱신은 아무것도 멈추지 않고 거부하며,
   오류에 적힌 명령으로 복구한다: clean published checkout에서
   `sudo node --experimental-strip-types apps/mcp/src/update-managed.ts --via-deploy <origin/main 커밋> "<이유>" --recover`.
   `--recover`는 app이 기존 커밋이나 기록된 시도 커밋에 있는 상태를 받아들이고, 방금까지 정상이던 데몬이므로 저장된 비밀번호를
   요구하지 않는다. 다시 빌드에 실패하면 2–3단계로 이전 버전을 복원한다. `npm run setup -- --repair`도 같은 상태를 복구한다
   (로그인 정보 확인을 묻는다). 이름 이전(migration) 직후 빌드 실패도 같은 `--recover`로 마친다.
5. 복원한 데몬의 계정 연결을 확인하지 못하면 재시작·로그인을 재시도하지 않고 `npm run setup -- --repair`를 안내한다.

검증 범위: 주입한 호스트(가짜 `git`·`npm`·`systemctl`)와 임시 디렉터리로 단위 확인했다🟡. 실제 서버에서 실패한 갱신의 복원은 아직 확인하지 않았다❓.

지금은 root가 `--via-deploy`로 직접 호출하는 저수준 도구다. 일반 사용자용 업데이트·삭제 명령은 후속이다.

### AI 연결

Codex의 `approval_policy="never"`는 MCP 확인 창도 자동 거절할 수 있다. 연결 및 도구 목록 조회는
성공해도 전송 승인 응답이 즉시 decline으로 끝나는 경우 이 설정을 확인한다. 사용자 선택에 따라
`approval_policy={granular={sandbox_approval=false,rules=false,mcp_elicitations=true,request_permissions=false,skill_approval=false}}`
및 `approvals_reviewer="user"`로 MCP 확인 창만 표시할 수 있다. 전송을 자동 승인하는 설정이 아니다.
앱/대화의 기존 정책 override가 우선할 수 있으므로 재실행 후 실제 표시를 검증한다.
[공식 설정 문서](https://learn.chatgpt.com/docs/config-file/config-reference).

생성한 SSH 설정은 `ssh -W`로 서버의 loopback MCP에 stdio를 전달한다. 원격 shell·원격 명령·
두 번째 KakaoSession을 만들지 않는다. SSH 키와 known_hosts는 운영자가 미리 준비해야 한다.
SSH 서버에서 stdio TCP forwarding을 허용해야 한다. BatchMode이므로 AI의 MCP 접속 중 SSH 비밀번호를 묻지 않는다.

같은 컴퓨터에서는 절대 경로의 `connect.ts --listen 127.0.0.1:8787`를 등록한다.
연결 프로그램은 MCP 바이트를 해석·변경·기록하지 않는다. backpressure를 유지하고 stdin EOF 후 마지막
응답을 전달한다. 연결 실패는 nonzero이고 자동 daemon 시작·재접속·전송 재시도는 하지 않는다.
Unix socket을 지정하려면 같은 소유자의 private 디렉터리와 0600 socket이어야 한다.

연결 설정만 출력:

```bash
npm run --silent setup -- --config --ssh <SSH-대상>
```

기본 마법사는 `~/.config/kakao-max/mcp.json`에 0600으로 저장한다(기존 `~/.config/kakaotalk-mcp/mcp.json` fallback 지원). 기존 파일이 다르면 `[y/N]`으로
확인한다. AI 앱의 설정을 추측해서 편집하지 않는다. SSH 설정은 내 AI가 있는 컴퓨터로 복사/등록한다.

현재 raw MCP listener는 인증된 원격 HTTP API가 아니다. loopback 접근이 가능한 로컬 OS 사용자와
SSH/MCP 클라이언트를 신뢰해야 한다. TCP 연결의 OS 사용자 확인은 Linux에만 있다. macOS·Windows의 TCP listener는
그 컴퓨터의 모든 사용자에게 열리므로 단일 사용자 컴퓨터에서만 쓴다(macOS는 소유자 전용 폴더의 Unix 소켓으로 대신할 수 있다). 파일 소유권 분리가 악성 MCP 클라이언트의 확인 창 위조까지 막는다는
보장은 하지 않는다. 기존 [승인 신뢰 경계](passkey-approval.md)를 함께 적용한다.

## 남은 검증

### 로그인 실패 데이터포인트 (2026-10-24)

✅ 사용자 직접 시험: Android·전화번호만 사용하는 계정에서 국가번호를 빼고 입력한 시도는
`initial_login status=30 httpStatus=200 signRegistration=absent`로 끝났다. 사용자가 국가번호 누락을
입력 실수로 확인했다. 휴대폰 승인 요청 전의 로그인 실패를 조사할 때 입력 형식도 확인한다.
실제 번호·비밀번호는 기록하지 않는다. 국가번호를 복원한 재시도 결과는 아직 ❓다.

이전 `initial_login=-100 → request_sign=-500`은 별도 관측이며 원인은 여전히 ❓다.

후속 ✅ 실계정 trace에서 signRegistration=disabled인데 request_sign을 호출한 분기 결함이 확인됐다.
🟡 이제 enabled만 sign, disabled는 사람에게 번호를 표시할 수 있는 설치 CLI의 passcode 경로로 분기한다.
후속 ✅ 지정 테스트 계정에서 번호 발급/휴대폰 인증/최종 로그인/daemon 시작과 SSH connected=true까지 확인했다.
이 성공을 다른 계정이나 -500의 서버 내부 원인에 일반화하지 않는다.

### 이후 시험

- 다른 지원 환경의 계정 등록·휴대폰 승인·서비스 시작(지정 Android/전화번호 테스트 계정은 확인).
- 지원 AI 클라이언트의 실제 사람 승인·거절·종료, 실제 방 첫 전송·철회.
- 새 버전 업데이트·삭제·기존 수동 설치의 관리형 전환. bootstrap은 이 작업을 자동 수행하지 않는다.
