import { promises as fs } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

type ChunkModule = Record<string, any>;

/**
 * Load a webpack chunk file (e.g., 1016.index.js) and evaluate it with a
 * synthetic module/exports to retrieve its __webpack_modules__ additions.
 */
export async function loadChunk(chunkId: string): Promise<ChunkModule | null> {
  const chunkFile = `${chunkId}.index.js`;
  const fullPath = join(process.cwd(), "cursor-agent-source", chunkFile);
  const code = await fs.readFile(fullPath, "utf8");

  const module: { exports: any } = { exports: {} };
  const exports = module.exports;
  const __webpack_modules__: Record<string, any> = {};

  const context = vm.createContext({
    module,
    exports,
    __webpack_modules__,
    console,
    require,
  });

  const wrapped = `(function(){${code}; return { exports: module.exports, modules: __webpack_modules__ }; })()`;
  const result = vm.runInContext(wrapped, context, { filename: chunkFile });
  if (result && result.modules) {
    return result.modules as ChunkModule;
  }
  return null;
}

/**
 * Scan a set of chunk ids and return the first module map that contains a key
 * including the given substring.
 */
export async function findChunkModule(
  chunkIds: string[],
  needle: string
): Promise<{ moduleId: string; factory: any } | null> {
  for (const id of chunkIds) {
    const modules = await loadChunk(id);
    if (!modules) continue;
    for (const [key, factory] of Object.entries(modules)) {
      if (key.includes(needle)) {
        return { moduleId: key, factory };
      }
    }
  }
  return null;
}
