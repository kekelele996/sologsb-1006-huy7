// 提供 Svelte store 在 Node 下运行所需的最小浏览器环境，再载入验证脚本
const backing = new Map<string, string>()
globalThis.localStorage = {
  getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
  setItem: (key: string, value: string) => void backing.set(key, String(value)),
  removeItem: (key: string) => void backing.delete(key),
  clear: () => backing.clear(),
  key: (index: number) => Array.from(backing.keys())[index] ?? null,
  get length() { return backing.size }
} as unknown as Storage
;(globalThis as { navigator?: Navigator }).navigator = { onLine: true } as Navigator

await import('./verify-logic.mts')
