# 확인 창(MRTR elicitation) 실기기 시험용 테스트 서버

실계정·데몬·자격증명·네트워크 없이, 실제 MCP 서버 코드(`apps/mcp/src/mcp-stdio.ts`, `client-approval.ts`)와
승인 저장소·허용한 대화방(assistant 프로필 동작)을 그대로 씁니다. 보내기는 가짜 어댑터라 아무것도 나가지 않고,
`fixture.log`에 본문 없이 요약만 남습니다. 대화방 ID `123456789`는 테스트 값입니다.

2026-10-24 이 서버로 Claude Code 2.1.308 대화형 세션을 시험했습니다(결과는
세션 인계).

## 자동 확인 (사람 없이)

```bash
node tools/elicitation-fixture/smoke.mjs "$(which node)" "$PWD/tools/elicitation-fixture/server.ts"
```

새 방식 클라이언트를 흉내 내어 discover → prepare → send(확인 창 요청) → Enter만(다시 묻기) →
코드+묻지 않기(전송) → 두 번째 전송(확인 창 없음)까지 출력합니다. 먼저 `npm run build --workspace=@kakao-max/protocol`.

## 실제 Claude Code로 시험

1. `claude update` 후 `claude --version`이 2.1.274 이상인지 확인(2026-07-28 기본 협상).
2. `mcp-config.example.json`을 `mcp-config.json`으로 복사하고 경로를 이 폴더의 절대경로로 바꿉니다.
3. 이 폴더에서 `claude --mcp-config mcp-config.json --strict-mcp-config` → `/mcp`로 connected 확인.
4. "kakao-fixture로 chatId 123456789에 "첫 메시지"를 보내줘. prepare_message 후 send_message를 써."
   → 확인 창에서 4자리 코드 입력(+ "앞으로 묻지 않기") → `sent_unverified`. 두 번째 메시지는 확인 창 없이 전송돼야 합니다.
5. `cat fixture.log`로 확인: `input_required` 뒤에 `inputResponses.approve.content.code`가 담긴 재시도와 `FAKE_SEND`.
