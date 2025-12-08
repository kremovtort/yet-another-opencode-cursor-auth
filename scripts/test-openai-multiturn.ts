/**
 * Test OpenAI Multi-Turn Tool Calling
 * 
 * This tests the standard OpenAI pattern for tool calling:
 * 1. Send request with tools -> get tool_calls response
 * 2. Execute tool locally
 * 3. Send NEW request with tool result as message -> get final response
 * 
 * This is the pattern OpenCode and other OpenAI-compatible clients use.
 */

const API_ENDPOINT = "http://localhost:18741";

interface ToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface StreamChunk {
  id: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason: string | null;
  }[];
  error?: {
    message: string;
    type: string;
  };
}

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

async function readStream(response: Response): Promise<{
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string | null;
}> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls: { id: string; name: string; arguments: string }[] = [];
  const toolCallArgsBuffers: Map<number, string> = new Map();
  let finishReason: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const chunk = JSON.parse(data) as StreamChunk;
          const choice = chunk.choices?.[0];

          if (choice?.delta?.content) {
            content += choice.delta.content;
          }

          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              // Initialize new tool call entry
              if (tc.id !== undefined) {
                // Found a new tool call
                while (toolCalls.length <= tc.index) {
                  toolCalls.push({ id: "", name: "", arguments: "" });
                }
                toolCalls[tc.index]!.id = tc.id;
              }
              if (tc.function?.name) {
                while (toolCalls.length <= tc.index) {
                  toolCalls.push({ id: "", name: "", arguments: "" });
                }
                toolCalls[tc.index]!.name = tc.function.name;
              }
              if (tc.function?.arguments) {
                const currentArgs = toolCallArgsBuffers.get(tc.index) || "";
                toolCallArgsBuffers.set(tc.index, currentArgs + tc.function.arguments);
                while (toolCalls.length <= tc.index) {
                  toolCalls.push({ id: "", name: "", arguments: "" });
                }
                toolCalls[tc.index]!.arguments = toolCallArgsBuffers.get(tc.index)!;
              }
            }
          }

          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
        } catch (err) {
          // Ignore parse errors
        }
      }
    }
  }

  return { content, toolCalls, finishReason };
}

async function testOpenAIMultiTurn() {
  console.log("=== OpenAI Multi-Turn Tool Calling Test ===\n");

  // Define a custom tool
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather in a location. ALWAYS use this when asked about weather.",
        parameters: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: "The city name",
            },
          },
          required: ["location"],
        },
      },
    },
  ];

  const messages: Message[] = [
    {
      role: "user",
      content: "What's the weather in Tokyo right now? Use the get_weather tool.",
    },
  ];

  // Step 1: Send initial request
  console.log("1. Sending initial request...");
  console.log(`   User: "${messages[0]!.content}"\n`);

  const response1 = await fetch(`${API_ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonnet-4.5",
      stream: true,
      messages,
      tools,
      tool_choice: "auto",
    }),
  });

  if (!response1.ok) {
    console.error("Request 1 failed:", response1.status, await response1.text());
    return;
  }

  const result1 = await readStream(response1);
  console.log("   Response 1:");
  console.log(`   - Content: "${result1.content.slice(0, 100)}${result1.content.length > 100 ? '...' : ''}"`);
  console.log(`   - Tool Calls: ${result1.toolCalls.length}`);
  for (const tc of result1.toolCalls) {
    console.log(`     - ${tc.name}(${tc.arguments}) [id: ${tc.id}]`);
  }
  console.log(`   - Finish Reason: ${result1.finishReason}\n`);

  if (result1.toolCalls.length === 0) {
    console.log("No tool calls - model didn't use the tool. Test inconclusive.");
    return;
  }

  // Step 2: Execute tool locally (simulated)
  console.log("2. Executing tool locally (simulated)...");
  const toolCall = result1.toolCalls[0]!;
  const toolResult = JSON.stringify({
    location: "Tokyo",
    temperature: "22°C",
    condition: "Partly cloudy",
    humidity: "65%",
  });
  console.log(`   Tool: ${toolCall.name}`);
  console.log(`   Result: ${toolResult}\n`);

  // Step 3: Send follow-up request with tool result as message
  console.log("3. Sending follow-up request with tool result...");

  const messagesWithToolResult: Message[] = [
    ...messages,
    {
      role: "assistant",
      content: result1.content || null,
      tool_calls: result1.toolCalls.map(tc => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    },
    {
      role: "tool",
      tool_call_id: toolCall.id,
      content: toolResult,
    },
  ];

  console.log("   Messages being sent:");
  for (const msg of messagesWithToolResult) {
    if (msg.role === "user") {
      console.log(`   - User: "${msg.content?.slice(0, 50)}..."`);
    } else if (msg.role === "assistant") {
      console.log(`   - Assistant: [${msg.tool_calls?.length} tool call(s)]`);
    } else if (msg.role === "tool") {
      console.log(`   - Tool (${msg.tool_call_id}): "${msg.content?.slice(0, 50)}..."`);
    }
  }
  console.log("");

  const response2 = await fetch(`${API_ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonnet-4.5",
      stream: true,
      messages: messagesWithToolResult,
      tools, // Still include tools in case model needs them again
      tool_choice: "auto",
    }),
  });

  if (!response2.ok) {
    console.error("Request 2 failed:", response2.status, await response2.text());
    return;
  }

  const result2 = await readStream(response2);
  console.log("   Response 2 (continuation):");
  console.log(`   - Content: "${result2.content.slice(0, 300)}${result2.content.length > 300 ? '...' : ''}"`);
  console.log(`   - Tool Calls: ${result2.toolCalls.length}`);
  console.log(`   - Finish Reason: ${result2.finishReason}\n`);

  // Summary
  console.log("=== Summary ===");
  if (result2.content.length > 0 && result2.finishReason === "stop") {
    console.log("SUCCESS! Multi-turn tool calling flow completed.");
    console.log("The model received the tool result and generated a response.");
  } else if (result2.toolCalls.length > 0) {
    console.log("Model made additional tool calls - may need another round.");
  } else {
    console.log("Unexpected result - check the response above.");
  }
}

testOpenAIMultiTurn().catch(console.error);
