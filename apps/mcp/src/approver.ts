// Operator terminal on the daemon host: create a one-time passkey enrollment code, list or remove
// approvers. Requires an interactive terminal; there is deliberately no MCP equivalent.
import { ApproverRegistry, KakaoError, loadConfig, packagedEntry } from '@kakao-max/core';
import { createEnrollment } from './enrollment.ts';

function main(): void {
  const [command, arg] = process.argv.slice(2);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new KakaoError('APPROVAL_REQUIRED', 'Run this from an interactive operator terminal on the daemon host');
  const config = loadConfig(), registry = new ApproverRegistry(config.dataDir);
  if (command === 'enroll') {
    if (!config.approval.origin) throw new KakaoError('CONFIG_INVALID', 'Set KAKAO_APPROVAL_LISTEN and KAKAO_APPROVAL_ORIGIN first');
    const { code, expiresAt } = createEnrollment(config.dataDir);
    process.stdout.write(`등록 코드: ${code}\n열 주소: ${config.approval.origin}/enroll\n만료: ${new Date(expiresAt).toLocaleString()} (1회용, 5회 틀리면 폐기)\n`);
  } else if (command === 'list') {
    const all = registry.list();
    if (!all.length) process.stdout.write('등록된 승인 패스키가 없습니다.\n');
    for (const a of all) process.stdout.write(`${a.id}\t${a.label}\t${a.origin}\t${a.createdAt}\n`);
  } else if (command === 'remove' && arg) {
    process.stdout.write(registry.remove(arg) ? '삭제했습니다. 이 패스키의 기존 승인도 더는 쓸 수 없습니다.\n' : '해당 ID가 없습니다.\n');
  } else {
    process.stdout.write(`사용법: ${packagedEntry() ? 'kakao-max approver' : 'npm run approver --workspace=@kakao-max/mcp --'} enroll | list | remove <id>\n`);
    process.exitCode = 1;
  }
}
try { main(); }
catch (error) {
  process.stderr.write(`[approver] ${error instanceof KakaoError ? `${error.code}: ${error.message}` : (error as Error).message}\n`);
  process.exitCode = 1;
}
