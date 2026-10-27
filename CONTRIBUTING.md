# 기여 안내

이슈와 풀 리퀘스트를 환영합니다. 큰 변경은 먼저 이슈로 방향을 맞춰 주세요.
에이전트로 작업한다면 [AGENTS.md](AGENTS.md)의 규칙을 그대로 따릅니다.

## 시작

```bash
npm ci
npm test
npm run typecheck
git diff --check
npm run check:publication
npm run check:private-terms
npm run check:package
```

배포 패키지 구성과 점검은 [npm 패키지](docs/runbooks/package.md)를 봅니다.

`npm ci`는 Git hook(`.githooks/`)을 설치합니다. 커밋·커밋 메시지·push 때 전화번호·이메일 같은 개인정보와
관리자가 지정한 비공개 용어를 검사합니다. 커밋 메시지와 PR 설명도 공개되므로 같은 기준을 지킵니다.
`--no-verify`로 건너뛰지 말고 문구를 고쳐 주세요. CI가 같은 검사를 다시 합니다.

`npm test`는 protocol을 먼저 빌드합니다. Node는 strip-types와 `node:sqlite`를 지원해야 합니다(CI는 Node 22).
코드는 strict TypeScript를 Node strip-types로 실행하므로 enum과 parameter property 문법을 쓰지 않습니다.
꼭 필요한 경우가 아니면 런타임 의존성을 추가하지 않습니다.

## 지켜 주세요

- **실계정 데이터를 커밋하지 마세요.** 토큰, 비밀번호, 전화번호, 대화 내용, 실명, 실제 사용자·방 ID, `.env.local`,
  계정 데이터 폴더는 저장소에 넣지 않습니다. 예시에는 `홍길동`, `123456789` 같은 값을 씁니다.
- **테스트는 가짜 데이터로.** 픽스처는 `*.test.ts` 안에서 임시 폴더로 만듭니다. 실제 계정 저장소를 쓰지 않습니다.
- **정책을 우회하지 마세요.** 모든 계정 상태 변경은 core의 정책·방 권한·쓰기 엔진을 거칩니다.
  속도 제한과 상한은 승인 대신이 아닙니다. 조회와 읽음 표시는 별개 권한입니다.
- **승인 모델을 지켜 주세요.** 승인이 필요한 쓰기는 호출자가 정한 UUID `requestId`로 한 번 호출합니다.
  결과가 불확실하면 새 ID로 다시 보내지 않고 같은 작업을 확인합니다.
- **MCP 도구를 추가·삭제하면** [기능 매트릭스](docs/agent-capability-matrix.md)도 고칩니다(`capability-matrix.test.ts`가 검사).
  실계정 확인(✅), 단위·픽스처 확인(🟡), 미확인(❓)을 구분해 적습니다.

## 실계정으로 확인할 때

실제 전송·방 변경은 본인 계정에서, 본인이 정한 방(예: 나와의 채팅)에서만 시험하세요.
풀 리퀘스트에는 무엇을 어떻게 확인했는지 적되, 계정 정보와 대화 내용은 빼 주세요.

기여한 코드는 이 저장소의 [MIT 라이선스](LICENSE)로 배포됩니다.

`check:publication`은 staged 파일과 모든 도달 가능한 Git 이력에서 계정 데이터 경로·SQLite 파일을 검사합니다.
CI는 이 검사와 전체 이력 Gitleaks 검사를 수행합니다. 로컬에서 비밀 검사도 실행하려면 Gitleaks 8.30.1로
`gitleaks git --redact --log-opts=--all .`을 실행하세요. 커밋 전에는
`gitleaks git --pre-commit --staged --redact .`으로 staged 변경도 검사합니다.
공개 절차와 남은 운영 확인은 [공개 점검](docs/runbooks/publication.md)을 참고하세요.
