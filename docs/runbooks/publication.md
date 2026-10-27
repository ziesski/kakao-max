# 공개 점검

소스 보안 검사 통과와 배포 권리·약관 판단은 별개입니다. README의 비공식·계정 제한 고지와 선택한 MIT 라이선스를 유지합니다.

공개할 커밋에서 다음 검사를 수행합니다.

```bash
npm ci
npm test
npm run typecheck
git diff --check
npm run check:publication
npm run check:private-terms
gitleaks git --redact --log-opts=--all .
```

`check:publication`은 로컬 계정 파일을 열지 않고 index와 모든 도달 가능한 Git 이력만 검사합니다.
금지된 파일을 현재 트리에서 지워도 과거 커밋에 있으면 실패합니다. 검사 실패 시 원문·민감 경로를 출력하지 않습니다.
Git 명령 실패나 검사 용량 초과도 성공으로 처리하지 않습니다. Gitleaks 버전은 CI의 고정 버전과 맞춥니다.
CI의 배포된 검사기 바이너리는 버전과 SHA-256을 함께 고정합니다.

`check:private-terms`는 추가된 줄·파일 이름·커밋 메시지·PR 제목과 설명에서 개인정보 패턴과 관리자의 비공개 용어 목록을
찾습니다. 목록은 이 저장소에 없고, 로컬에서는 `KAKAO_MAX_DENYLIST_FILE` 또는 체크아웃 옆의 관리자 저장소에서,
CI에서는 `KAKAO_MAX_DENYLIST` secret에서 읽습니다. 결과에는 위치만 나오고 일치한 값이나 목록 항목은 출력하지 않습니다.
PR 검사는 `pull_request_target`으로 base 브랜치의 검사기를 실행하며 PR 코드를 실행하지 않습니다.

Linux CI가 실제로 시작돼 Node 22 테스트·systemd 권한 fixture까지 통과했는지 확인합니다.
GitHub 결제/지출 한도로 실행이 시작되지 않았다면 로컬 macOS 통과로 Linux 검증을 대체하지 않습니다.
별도 bootstrap fixture는 `main` push에서만 실행합니다. 실제 계정 smoke는 승인된 실행 중 데몬이 있을 때만 수행합니다.

저장소 설정을 공개로 바꾸는 것은 별도 사람 결정입니다. 전환 시에는 다음을 확인합니다.

- GitHub의 비공개 취약점 신고를 활성화하고 `SECURITY.md`가 안내하는 버튼이 실제로 표시되는지 확인합니다.
- GitHub Actions 이력·로그·releases·첨부·issues에도 민감정보가 없는지 다시 점검합니다.
- 데모 대화·프로필·이미지의 공개 동의와 코드·에셋·제3자 의존성의 배포 권리를 확인합니다.
- 기존 운영 로그에는 과거 버전이 남긴 ID가 있을 수 있으므로, 지원 요청에 원본 로그·DB·env 파일을 첨부하지 않습니다.

이 절차는 계정 로그인·자동 재시작·배포·저장된 agent mode 변경을 승인하지 않습니다.
