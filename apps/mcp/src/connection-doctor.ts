import { setupCommand } from '@kakao-max/core';
import { openDaemon, type ConnectionOptions } from './daemon-connection.ts';
import { probe } from './healthcheck.ts';

/** Read-only metadata probe. Never returns account IDs, chat names, or credentials. */
export async function diagnoseConnection(options: ConnectionOptions) {
  let connection;
  try {
    connection = await openDaemon(options);
    const result = await probe(connection, 7000);
    return result.healthy ? { status: 'ready', connected: true, nextAction: 'Register the generated MCP settings in your AI client, then use find_chat. Room permissions are requested separately.' } :
      { status: 'needs_attention', connected: false, nextAction: `On the server, run ${setupCommand('--repair')}. Keep the registered device. If the daemon is running, check its account connection before restarting it.` };
  } catch {
    return { status: 'unreachable', connected: false, nextAction: options.ssh ?
      `Check SSH access and the daemon loopback port. Run ${setupCommand('--doctor')} on the server to separate account/service problems from SSH problems. No login was attempted.` :
      `Check the configured loopback port and existing service. For a managed installation run ${setupCommand('--repair')} on the server. No daemon or login was started.` };
  } finally { connection?.destroy(); }
}
