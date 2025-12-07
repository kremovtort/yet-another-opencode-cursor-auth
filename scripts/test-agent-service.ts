/**
 * Test the Agent Service for chat functionality
 */
import { FileCredentialManager } from '../src/lib/storage.ts';
import { createAgentServiceClient, AgentMode } from '../src/lib/api/agent-service.ts';

async function main() {
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  if (!token) throw new Error('No token - please authenticate first');

  console.log('Creating Agent Service client...');
  const client = createAgentServiceClient(token);

  console.log('\n=== Testing Agent Service Chat ===\n');
  
  const request = {
    message: 'Write a haiku about programming.',
    model: 'gpt-4o',
    mode: AgentMode.AGENT,
  };

  console.log(`Request: "${request.message}"`);
  console.log(`Model: ${request.model}`);
  console.log(`Mode: ${AgentMode[request.mode]}`);
  console.log('\n--- Streaming Response ---\n');

  try {
    for await (const chunk of client.chatStream(request)) {
      switch (chunk.type) {
        case 'text':
        case 'token':
          process.stdout.write(chunk.content ?? '');
          break;
        case 'thinking':
          console.log(`[Thinking] ${chunk.content}`);
          break;
        case 'checkpoint':
          console.log('\n[Checkpoint received]');
          break;
        case 'error':
          console.error(`\n[Error] ${chunk.error}`);
          break;
        case 'done':
          console.log('\n\n--- Stream Complete ---');
          break;
      }
    }
  } catch (err: any) {
    console.error('\nError:', err.message);
  }
}

main().catch(console.error);
