import { encodeChatRequest, addConnectEnvelope, CURSOR_API_URL, generateChecksum } from '../src/lib/api/cursor-client.ts';
import { FileCredentialManager } from '../src/lib/storage.ts';
import { randomUUID } from 'node:crypto';

async function main() {
  const cm = new FileCredentialManager();
  const token = await cm.getAccessToken();
  if (!token) throw new Error('No access token');

  const payload = encodeChatRequest({ model: 'gpt-5', messages: [{ role: 'user', content: 'Say hello' }] });
  const envelope = addConnectEnvelope(payload);
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/connect+proto',
    'connect-accept-encoding': 'gzip,br',
    'connect-protocol-version': '1',
    'user-agent': 'connect-es/1.4.0',
    'x-cursor-checksum': generateChecksum(token),
    'x-cursor-client-version': 'cli-2025.11.25-d5b3271',
    'x-cursor-client-type': 'cli',
    'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    'x-ghost-mode': 'true',
    'x-request-id': randomUUID(),
    host: new URL(CURSOR_API_URL).host,
  } as Record<string, string>;

  for (const endpoint of ['StreamChat', 'StreamChatWeb', 'StreamChatContext']) {
    const url = `${CURSOR_API_URL}/aiserver.v1.AiService/${endpoint}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: Buffer.from(envelope),
      });
      const text = await res.text();
      console.log(endpoint, 'status', res.status, 'len', text.length);
      console.log(text.slice(0, 400));
    } catch (error) {
      console.error(endpoint, 'error', error);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
