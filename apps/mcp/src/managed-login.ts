// Human-only repair UI, invoked under the managed deployment lock. No auth call.
import fs from 'node:fs';
import path from 'node:path';
import { CredentialStore, KakaoError } from '@kakao-max/core';
import { parseEnv } from '../../../packages/core/src/env-file.ts';
import { confirmSetup, type SetupPrompt } from './setup-prompts.ts';

/** Repair may replace damaged login fields, but never guess or alter a damaged
 * device key, token, account ID, or policy setting. Original bytes stay on disk
 * until the person supplies replacement login data and explicitly saves it. */
export function readManagedEnv(file: string, allowLoginRepair = false): { values: Record<string, string>; damagedLogin: boolean } {
  const bytes = fs.readFileSync(file), decoder = new TextDecoder('utf-8', { fatal: true });
  const lines: string[] = []; let damagedLogin = false;
  for (const binary of bytes.toString('latin1').split('\n')) {
    const line = Buffer.from(binary, 'latin1');
    try { lines.push(decoder.decode(line)); }
    catch {
      const eq = line.indexOf(61), keyBytes = line.subarray(0, eq);
      const key = keyBytes.toString('ascii').trim();
      if (!allowLoginRepair || eq < 0 || keyBytes.some(value => value > 127) || !['KAKAO_EMAIL', 'KAKAO_PASSWORD'].includes(key)) {
        throw new KakaoError('CONFIG_INVALID', 'Credential file contains damaged non-login data; retain the registered device and inspect the file without logging its contents');
      }
      damagedLogin = true; lines.push(`${key}=`);
    }
  }
  return { values: parseEnv(lines.join('\n')), damagedLogin };
}

export async function configureManagedLogin(file: string, dataDir: string, uid: number, prompt: SetupPrompt): Promise<void> {
  const { values: saved, damagedLogin } = readManagedEnv(file, true);
  const reuse = !damagedLogin && !!saved.KAKAO_EMAIL && !!saved.KAKAO_PASSWORD && await confirmSetup(prompt, '저장된 로그인 정보를 그대로 사용할까요?', true);
  if (!reuse) {
    const email = (await prompt('이 서버에 연결된 카카오 계정 이메일 또는 로그인 ID: ')).trim();
    let password = await prompt('카카오 계정 비밀번호 (화면에 표시되지 않음): ', true);
    try {
      if (!await confirmSetup(prompt, '자동 재로그인을 위해 이 서버의 비공개 파일에 저장할까요? (기존 기기 유지, 강제 로그인 없음)', true)) {
        throw new KakaoError('POLICY_DENIED', 'Login repair cancelled; existing credentials were preserved');
      }
      CredentialStore.saveLogin(file, email, password, Number(saved.KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS ?? 3));
    } finally { password = ''; }
  } else CredentialStore.saveLogin(file, saved.KAKAO_EMAIL, saved.KAKAO_PASSWORD, Number(saved.KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS ?? 3));
  const budget = path.join(dataDir, 'auth-relogin.json');
  if (fs.existsSync(`${budget}.lock`) || fs.existsSync(`${budget}.new`)) throw new KakaoError('STORAGE_UNSAFE', 'An interrupted re-login state needs review; counters were not reset');
  if (!fs.existsSync(budget)) return;
  const stat = fs.lstatSync(budget);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) || stat.size > 1024) throw new KakaoError('STORAGE_UNSAFE', 'Unsafe re-login counters; nothing was reset');
  let state;
  try { state = JSON.parse(fs.readFileSync(budget, 'utf8')); }
  catch { throw new KakaoError('STORAGE_UNSAFE', 'Invalid re-login counters; inspect before resetting'); }
  if (state.version !== 1 || typeof state.stopped !== 'boolean' || !Number.isSafeInteger(state.attempts) || state.attempts < 0) throw new KakaoError('STORAGE_UNSAFE', 'Invalid re-login counters; inspect before resetting');
  if (state.stopped || state.attempts >= Number(saved.KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS ?? 3)) {
    if (reuse || !await confirmSetup(prompt, '로그인 정보를 수정했습니다. 이전 자동 로그인 중단·횟수 제한을 초기화하고 한 번 다시 시작할까요?')) {
      throw new KakaoError('AUTH_EXPIRED', 'Re-login remains stopped. Correct credentials before explicitly resetting its attempt limit.');
    }
    fs.unlinkSync(budget);
    const dir = fs.openSync(dataDir, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}
