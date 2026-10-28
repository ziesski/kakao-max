# npm 패키지

`kakao-max`는 npm 패키지 하나로 배포할 수 있게 빌드됩니다. 게시는 [게시](#게시) 절차를 따릅니다.

## 패키지 구성

- `npm run build:package`가 프로그램마다 의존성을 포함한 ESM 번들 하나를 `dist/<이름>.mjs`로 만듭니다. Node는
  `node_modules` 안의 TypeScript를 실행하지 않으므로 설치된 패키지는 일반 JavaScript만 실행합니다.
- 런타임 의존성이 없습니다. `bson`은 번들에 포함되며 라이선스는 `dist/THIRD-PARTY-NOTICES.txt`에 있습니다.
- 명령은 세 개입니다.

| 명령 | 하는 일 |
|---|---|
| `kakao-max` | CLI. `kakao-max setup`, `kakao-max web`, `kakao-max approver`도 이 명령으로 실행 |
| `kakao-max-mcp` | 계정 데몬 |
| `kakao-max-web` | 로컬 웹 화면 |

- 소스 체크아웃은 그대로 `npm run setup`, `npm run web`으로 동작합니다. 프로그램은 실행 위치(체크아웃·패키지)를 스스로 알고
  다른 프로그램을 같은 방식으로 시작합니다(`packages/core/src/entry.ts`).

## Linux 서비스 설치: 버전 고정

패키지에서 `kakao-max setup`의 `새 Linux 서버 설치`를 고르면 Git 대신 실행 중인 패키지 자체를 설치합니다.

- 패키지는 시스템 전역 설치(`sudo npm install -g kakao-max`)여야 합니다. 패키지 폴더와 상위 폴더가 root 소유이고 다른
  사용자가 쓸 수 없어야 하며, 아니면 설치를 거부합니다.
- `package.json`·`LICENSE`·`dist/`를 `/var/lib/kakao-max/app`으로 복사하고, 버전과 SHA-256 digest를
  `install-state.json`(version 2)에 기록합니다. 내려받기·빌드는 하지 않습니다.
- 서비스는 `node dist/mcp.mjs`로 시작합니다. 시작 전과 갱신 때마다 복사본 digest를 다시 확인하고, 다르면 계정 작업 없이 멈춥니다.
- 갱신: 전역 패키지를 새 버전으로 올린 뒤 서버에서 `kakao-max setup --update`. 데몬을 멈추고 파일을 바꾸고
  `.env.local`과 데이터는 그대로 둔 채 같은 계정으로 연결됐는지 확인합니다. 같은 버전이면 재시작하지 않습니다.
- 복구: `kakao-max setup --repair`.
- 소스 체크아웃으로 설치한 서버(version 1, Git 커밋 고정)는 패키지로 갱신하지 않습니다. 반대도 마찬가지입니다.

검증 범위: 주입한 호스트로 설치·변조 감지·갱신·같은 버전 무시를 단위 확인했습니다🟡. 실제 Linux root·systemd에서
패키지 설치는 아직 확인하지 않았습니다❓.

## 패키지 점검

```bash
npm run check:package
```

`npm pack`으로 tarball을 만들고, 임시 폴더에 오프라인 설치한 뒤 다음을 확인합니다. 카카오에 연결하지 않습니다.

- tarball에는 `package.json`, `README.md`, `LICENSE`, `dist/`만 있고 TypeScript 소스가 없음
- 세 명령이 연결되고 `kakao-max help`가 실행됨
- `kakao-max setup --config`가 설치된 `dist/connect.mjs`를 가리킴
- 등록된 기기가 없으면 `kakao-max-mcp`가 세션을 열기 전에 멈춤
- `kakao-max setup --doctor`가 패키지 명령으로 안내함
- `kakao-max-web`이 화면을 띄우고 실행 링크 없는 요청을 거부함

CI의 `package` 작업이 Linux·macOS·Windows에서 이 점검을 실행합니다. 게시는 하지 않습니다.

## 게시

`main`에 있는 커밋에 `package.json`의 버전과 같은 `v<버전>` 태그를 push하면 `publish` 워크플로가 게시합니다.
npm trusted publishing(OIDC)을 쓰므로 저장소에 npm 토큰을 두지 않고, 게시본에는 빌드 출처(provenance)가 붙습니다.

- 워크플로는 태그와 버전이 다르거나 태그 커밋이 `main`에 없으면 멈춥니다. 게시 전에 typecheck, 테스트,
  `check:publication`, `check:package`를 다시 실행합니다.
- 작업은 GitHub `npm` environment에서 실행됩니다. 이 environment에 필수 검토자를 두면 사람이 승인해야 게시됩니다.
- 태그 없이 수동 실행하면 `npm publish --dry-run`만 하고 게시하지 않습니다.
- 게시한 버전은 덮어쓸 수 없습니다. 문제가 있으면 새 버전을 게시하고, 필요하면 `npm deprecate`로 표시합니다.

처음 한 번은 관리자가 직접 준비합니다. 게시 계정은 실명이 아닌 프로젝트 계정을 씁니다.

1. GitHub 저장소 설정에서 `npm` environment를 만들고 필수 검토자를 지정합니다.
2. npmjs.com에서 패키지의 Trusted Publisher로 이 저장소, 워크플로 파일 `publish.yml`, environment `npm`을
   등록합니다. 패키지가 아직 없어 등록할 수 없으면, 첫 버전만 관리자가 2단계 인증으로 직접 게시한 뒤 등록합니다.
3. 등록 후에는 토큰 게시를 막도록 패키지의 publishing access를 trusted publishing 전용으로 바꿉니다.

검증 범위: 워크플로는 아직 실제로 게시해 보지 않았습니다❓.
