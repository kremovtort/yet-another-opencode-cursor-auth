import { FileCredentialManager } from '../src/lib/storage.ts';
import { randomUUID } from 'node:crypto';
import { addConnectEnvelope, generateChecksum, CURSOR_API_URL } from '../src/lib/api/cursor-client.ts';

async function main() {
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  if (!token) throw new Error('no token');

  const checksum = generateChecksum(token);
  const emptyPayload = addConnectEnvelope(new Uint8Array(0), 0);

  const contentTypes = [
    'application/connect+proto',
    'application/proto',
    'application/grpc+proto',
    'application/grpc-web+proto',
    'application/x-protobuf',
  ];

  for (const ct of contentTypes) {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': ct,
      'connect-protocol-version': '1',
      'user-agent': 'connect-es/1.4.0',
      'x-cursor-checksum': checksum,
      'x-cursor-client-version': 'cli-2025.11.25-d5b3271',
      'x-cursor-client-type': 'cli',
      'x-ghost-mode': 'true',
      'x-request-id': randomUUID(),
    } as Record<string, string>;

    console.log(`\nTesting content-type: ${ct}`);
    try {
      const res = await fetch(`${CURSOR_API_URL}/aiserver.v1.AiService/GetUsableModels`, {
        method: 'POST',
        headers,
        body: Buffer.from(emptyPayload),
      });
      console.log(`  Status: ${res.status}`);
      const text = await res.text();
      if (text) console.log(`  Response: ${text.slice(0, 200)}`);
    } catch (err: any) {
      console.log(`  Error: ${err.message}`);
    }
  }
}

main().catch(console.error);
