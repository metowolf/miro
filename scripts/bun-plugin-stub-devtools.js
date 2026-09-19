// Bun 构建插件：把 ink 里可选的 react-devtools-core 依赖换成空壳。
//
// 背景：ink 将 react-devtools-core 声明为可选 peer 依赖，仅在 process.env.DEV === "true"
// 时动态 import（见 node_modules/ink/build/reconciler.js）。但 `bun build --compile`
// 会静态遍历整张依赖图，于是这个我们永远用不到的包会让构建失败。
//
// 两种更省事的做法都不行：
//   1. 装上 react-devtools-core —— 为一个死代码路径塞进一大坨依赖。
//   2. 用 --external react-devtools-core —— 构建能过，但单文件二进制在运行时
//      无法从 /$bunfs 虚拟文件系统解析外部包，一启动就报
//      "Cannot find package 'react-devtools-core'"。
// 所以这里在解析阶段直接把它重定向到本地空壳，依赖图闭合且不留运行时外部依赖。
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("./stub-react-devtools-core.js", import.meta.url));

export default {
  name: "stub-react-devtools-core",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: stub,
    }));
  },
};
