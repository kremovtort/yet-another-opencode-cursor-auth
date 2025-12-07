import { promises as fs } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { proto3, Message, protoInt64, Timestamp, Struct } from "@bufbuild/protobuf";

type UnifiedExports = {
  ConversationMessage?: any;
  ConversationMessage_MessageType?: any;
  StreamUnifiedChatRequest?: any;
  StreamUnifiedChatRequestWithTools?: any;
  StreamUnifiedChatRequest_UnifiedMode?: any;
  StreamUnifiedChatResponse?: any;
  ModelDetails?: any;
};

// Minimal webpack helpers to satisfy the generated bundles.
function createWebpackHelpers(mapping: Record<string, any>) {
  const __webpack_require__ = (id: string) => {
    if (id in mapping) return mapping[id];
    throw new Error(`Missing webpack module mapping for ${id}`);
  };

  __webpack_require__.d = (exports: any, definition: Record<string, () => any>) => {
    for (const key of Object.keys(definition)) {
      Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
    }
  };
  __webpack_require__.o = (obj: any, prop: PropertyKey) =>
    Object.prototype.hasOwnProperty.call(obj, prop);
  __webpack_require__.r = (exports: any) => {
    Object.defineProperty(exports, "__esModule", { value: true });
  };

  return __webpack_require__;
}

async function loadWebpackModule(filePath: string, extraMapping: Record<string, any> = {}): Promise<Record<string, any>> {
  const code = await fs.readFile(filePath, "utf8");
  const __webpack_exports__: Record<string, any> = {};

  const mapping: Record<string, any> = {
    "../../node_modules/.pnpm/@bufbuild+protobuf@1.10.0/node_modules/@bufbuild/protobuf/dist/esm/proto3.js":
      { C: proto3 },
    "../../node_modules/.pnpm/@bufbuild+protobuf@1.10.0/node_modules/@bufbuild/protobuf/dist/esm/message.js":
      { Q: Message },
    "../../node_modules/.pnpm/@bufbuild+protobuf@1.10.0/node_modules/@bufbuild/protobuf/dist/esm/proto-int64.js":
      { M: protoInt64 },
    "../../node_modules/.pnpm/@bufbuild+protobuf@1.10.0/node_modules/@bufbuild/protobuf/dist/esm/google/protobuf/timestamp_pb.js":
      { Timestamp },
    "../../node_modules/.pnpm/@bufbuild+protobuf@1.10.0/node_modules/@bufbuild/protobuf/dist/esm/google/protobuf/struct_pb.js":
      { Struct },
    ...extraMapping
  };

  const __webpack_require__ = createWebpackHelpers(mapping);

  const context = vm.createContext({
    __webpack_exports__,
    __webpack_require__,
    console,
    global: globalThis,
    proto3: { C: proto3 },
    message: { Q: Message },
    proto_int64: { M: protoInt64 },
  });

  const wrapped = `(function(){ ${code}; return __webpack_exports__; })()`;
  const result = vm.runInContext(wrapped, context, { filename: filePath });
  return result as Record<string, any>;
}

let cachedExports: UnifiedExports | null = null;

export async function loadUnifiedExports(): Promise<UnifiedExports | null> {
  if (cachedExports) return cachedExports;

  try {
    const base = join(
      process.cwd(),
      "cursor-agent-restored-source-code/proto/dist/generated/aiserver/v1"
    );
    const agentBase = join(
      process.cwd(),
      "cursor-agent-restored-source-code/proto/dist/generated/agent/v1"
    );
    
    // 1. Load utils_pb.js
    const utils = await loadWebpackModule(join(base, "utils_pb.js"));

    // 2. Load symbolic_context_pb.js (depends on utils)
    const symbolic = await loadWebpackModule(join(base, "symbolic_context_pb.js"), {
      "../proto/dist/generated/aiserver/v1/utils_pb.js": utils
    });

    // 3. Load repository_pb.js (depends on utils and symbolic)
    const repository = await loadWebpackModule(join(base, "repository_pb.js"), {
      "../proto/dist/generated/aiserver/v1/utils_pb.js": utils,
      "../proto/dist/generated/aiserver/v1/symbolic_context_pb.js": symbolic
    });

    // 4. Load agent dependencies
    const agentApplyDiff = await loadWebpackModule(join(agentBase, "apply_agent_diff_tool_pb.js"));
    const agentSandbox = await loadWebpackModule(join(agentBase, "sandbox_pb.js"));
    const agentLs = await loadWebpackModule(join(agentBase, "ls_exec_pb.js"), {
      "../proto/dist/generated/agent/v1/sandbox_pb.js": agentSandbox
    });
    const agentRepo = await loadWebpackModule(join(agentBase, "repo_pb.js"));
    const agentRules = await loadWebpackModule(join(agentBase, "cursor_rules_pb.js"));
    const agentMcp = await loadWebpackModule(join(agentBase, "mcp_pb.js"));
    
    const agentRequestContext = await loadWebpackModule(join(agentBase, "request_context_exec_pb.js"), {
      "../proto/dist/generated/agent/v1/cursor_rules_pb.js": agentRules,
      "../proto/dist/generated/agent/v1/repo_pb.js": agentRepo,
      "../proto/dist/generated/agent/v1/mcp_pb.js": agentMcp,
      "../proto/dist/generated/agent/v1/ls_exec_pb.js": agentLs
    });

    // 5. Load tools_pb.js (depends on all above)
    const tools = await loadWebpackModule(join(base, "tools_pb.js"), {
      "../proto/dist/generated/aiserver/v1/utils_pb.js": utils,
      "../proto/dist/generated/aiserver/v1/repository_pb.js": repository,
      "../proto/dist/generated/agent/v1/apply_agent_diff_tool_pb.js": agentApplyDiff,
      "../proto/dist/generated/agent/v1/sandbox_pb.js": agentSandbox,
      "../proto/dist/generated/agent/v1/ls_exec_pb.js": agentLs
    });

    // 6. Load composer_pb.js (raw script, needed by chat_pb.js)
    // It defines ComposerCapabilityRequest and ComposerCapabilityContext
    let composerCode = await fs.readFile(join(base, "composer_pb.js"), "utf8");
    
    // Append exports to global context for composer_pb.js
    composerCode += `
      this.ComposerCapabilityRequest = ComposerCapabilityRequest;
      this.ComposerCapabilityContext = ComposerCapabilityContext;
    `;

    // 7. Load chat_pb.js (raw script)
    let chatCode = await fs.readFile(join(base, "chat_pb.js"), "utf8");
    
    // Append exports to global context
    chatCode += `
      this.ConversationMessage = ConversationMessage;
      this.ConversationMessage_MessageType = ConversationMessage_MessageType;
      this.StreamUnifiedChatRequest = StreamUnifiedChatRequest;
      this.StreamUnifiedChatRequestWithTools = StreamUnifiedChatRequestWithTools;
      this.StreamUnifiedChatRequest_UnifiedMode = StreamUnifiedChatRequest_UnifiedMode;
      this.StreamUnifiedChatResponse = StreamUnifiedChatResponse;
    `;
    
    const context = vm.createContext({
      console,
      global: globalThis,
      proto3: { C: proto3 },
      message: { Q: Message },
      // Provide loaded dependencies to chat_pb.js
      utils_pb: utils,
      repository_pb: repository,
      tools_pb: tools,
      request_context_exec_pb: agentRequestContext,
    });

    // Execute composer_pb.js first
    vm.runInContext(composerCode, context, { filename: "composer_pb.js" });
    
    // Execute chat_pb.js
    vm.runInContext(chatCode, context, { filename: "chat_pb.js" });

    cachedExports = {
      ConversationMessage: context.ConversationMessage,
      ConversationMessage_MessageType: context.ConversationMessage_MessageType,
      StreamUnifiedChatRequest: context.StreamUnifiedChatRequest,
      StreamUnifiedChatRequestWithTools: context.StreamUnifiedChatRequestWithTools,
      StreamUnifiedChatRequest_UnifiedMode: context.StreamUnifiedChatRequest_UnifiedMode,
      StreamUnifiedChatResponse: context.StreamUnifiedChatResponse,
      ModelDetails: utils.Gm,
    };
    return cachedExports;
  } catch (error) {
    console.warn("Failed to load unified proto exports via webpack shim:", error);
    return null;
  }
}
