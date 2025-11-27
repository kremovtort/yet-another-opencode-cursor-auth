import { promises as fs } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { proto3, Message, protoInt64 } from "@bufbuild/protobuf";

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

async function loadWebpackModule(filePath: string): Promise<Record<string, any>> {
  const code = await fs.readFile(filePath, "utf8");
  const __webpack_exports__: Record<string, any> = {};

  const mapping: Record<string, any> = {
    "../../node_modules/.pnpm/@bufbuild+protobuf@1.10.0/node_modules/@bufbuild/protobuf/dist/esm/proto3.js":
      { C: proto3 },
    "../../node_modules/.pnpm/@bufbuild+protobuf@1.10.0/node_modules/@bufbuild/protobuf/dist/esm/message.js":
      { Q: Message },
    "../../node_modules/.pnpm/@bufbuild+protobuf@1.10.0/node_modules/@bufbuild/protobuf/dist/esm/proto-int64.js":
      { M: protoInt64 },
    // These files only use the above, but the helper keeps the API surface.
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
    const chat = await loadWebpackModule(join(base, "chat_pb.js"));
    const utils = await loadWebpackModule(join(base, "utils_pb.js"));

    cachedExports = {
      ConversationMessage: chat.hS,
      ConversationMessage_MessageType: chat.ZP,
      StreamUnifiedChatRequest: chat.x8,
      StreamUnifiedChatRequestWithTools: chat.eb,
      StreamUnifiedChatRequest_UnifiedMode: chat.gn,
      StreamUnifiedChatResponse: chat.An,
      ModelDetails: utils.Gm,
    };
    return cachedExports;
  } catch (error) {
    console.warn("Failed to load unified proto exports via webpack shim:", error);
    return null;
  }
}
