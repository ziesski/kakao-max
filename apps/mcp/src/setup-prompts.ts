// Human-only setup input; account secrets are never echoed or passed as command arguments.
import { KakaoError } from '@kakao-max/core';
import { StringDecoder } from 'node:string_decoder';

export type SetupPrompt = (question: string, secret?: boolean) => Promise<string>;

export async function confirmSetup(prompt: SetupPrompt, question: string, defaultYes = false): Promise<boolean> {
  let invalid = false;
  for (;;) {
    const answer = (await prompt(`${invalid ? 'Y 또는 N을 입력해 주세요. ' : ''}${question} ${defaultYes ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    invalid = true;
  }
}

export const terminalPrompt: SetupPrompt = (question, secret = false) => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new KakaoError('APPROVAL_REQUIRED', 'Setup requires a human at an interactive terminal');
  return new Promise((resolve, reject) => {
    let value = '';
    const decoder = new StringDecoder('utf8');
    const wasRaw = process.stdin.isRaw;
    const cleanup = () => {
      process.stdin.removeListener('data', onData); process.stdin.setRawMode(wasRaw); process.stdin.pause();
      process.removeListener('SIGTERM', cancelled); process.removeListener('SIGINT', cancelled);
      process.stderr.write('\n');
    };
    const onData = (chunk: Buffer) => {
      for (const ch of decoder.write(chunk)) {
        if (ch === '\u0003' || ch === '\u0004') { cleanup(); reject(new KakaoError('POLICY_DENIED', 'Setup cancelled')); return; }
        if (ch === '\r' || ch === '\n') { cleanup(); resolve(value); return; }
        if (ch === '\u007f' || ch === '\b') {
          if (value) { value = [...value].slice(0, -1).join(''); if (!secret) process.stderr.write('\b \b'); }
        } else if (ch >= ' ' && ch !== '\u007f') {
          if (value.length >= 4096) { cleanup(); reject(new KakaoError('INVALID_ARGUMENT', 'Setup input is too long')); return; }
          value += ch; if (!secret) process.stderr.write(ch);
        }
      }
    };
    const cancelled = () => { cleanup(); reject(new KakaoError('POLICY_DENIED', 'Setup cancelled')); };
    process.once('SIGTERM', cancelled); process.once('SIGINT', cancelled);
    process.stderr.write(question); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onData);
  });
};
