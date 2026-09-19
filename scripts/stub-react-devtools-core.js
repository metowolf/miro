// react-devtools-core 的构建期替身。
//
// ink 把 react-devtools-core 声明为可选 peer 依赖，只在 process.env.DEV === "true"
// 时才会 import（见 node_modules/ink/build/reconciler.js）。我们不需要 devtools，
// 但 `bun build --compile` 会静态解析这个 import：
//   - 不处理 → 构建直接失败（Could not resolve）
//   - 用 --external → 能构建，但单文件二进制在运行时无法从 /$bunfs 解析外部包，启动即崩
// 所以这里提供一个空壳，通过 package.json 的 imports 映射进去，让依赖图闭合。
const devtools = {
  connectToDevTools() {},
};

export default devtools;
export const connectToDevTools = devtools.connectToDevTools;
