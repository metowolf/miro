/** 构建时注入；源码运行时通过 typeof 检查并回退到 package.json。 */
declare const __MIRO_VERSION__: string;
/** 编译版与 JS bundle 都按输出入口名定位 Worker。 */
declare const __MIRO_BUNDLED__: boolean;

declare module "*.wasm" {
  const path: string;
  export default path;
}
