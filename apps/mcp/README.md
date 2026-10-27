# @kakao-max/mcp

하나의 core 계정 세션 위에 MCP 도구를 제공합니다. 현재 계약은
[도구·권한](../../docs/tool-contract.md), 설치는 [빠른 시작](../../docs/QUICKSTART.md),
승인은 [확인 창·패스키](../../docs/runbooks/passkey-approval.md)를 읽으세요.
🟡 현재 단일 도구 목록은 단위·fixture 검증이며 새 목록으로의 실계정 검증은 남아 있습니다.

데몬은 한 번만 시작하고 AI 클라이언트는 `npm run setup`이 만든 커넥터로 연결합니다.
새 AI 대화마다 `src/index.ts`를 실행하면 계정 세션이 충돌할 수 있습니다.

```bash
npm ci
npm run setup
```

데몬의 `KAKAO_MCP_LISTEN`은 loopback 주소 또는 Unix socket을 지정합니다. 원격 AI는 SSH로 연결합니다.
MCP는 newline-delimited JSON-RPC를 쓰며 initialize 방식과 2026-07-28 요청 방식을 지원합니다.
선택형 묶음은 `KAKAO_MCP_TOOL_GROUPS`로 설정합니다. credentials는 비공개 `.env.local`에 저장합니다.
설정과 코드 변경만으로 서비스 재시작·다른 PC 로그아웃을 승인한 것은 아닙니다.

개발 검증:

```bash
npm test
npm run typecheck
```

상시 데몬을 대상으로 하는 상태 검사:

```bash
KAKAO_MCP_LISTEN=127.0.0.1:8787 npm run health --workspace=@kakao-max/mcp
```

계정 충돌 시 기존 runtime을 재사용하거나 사람이 명시적으로 계정 이전을 선택해야 합니다.
새 device UUID가 추가 활성 PC 세션을 보장하지 않습니다. 자동 재로그인은 선택 사항이며
일반 로그인만 최대 24시간 3회, 확정 거절·충돌·추가 인증 요구에는 중단합니다.
