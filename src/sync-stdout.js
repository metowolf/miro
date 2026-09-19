export const BSU = "\x1b[?2026h";
export const ESU = "\x1b[?2026l";

const BSU_BUFFER = Buffer.from(BSU);
const ESU_BUFFER = Buffer.from(ESU);

function isEmptyChunk(chunk) {
  return typeof chunk === "string" ? chunk.length === 0 : chunk?.byteLength === 0;
}

/** 包装 stdout：每次 write 包一层 DEC 2026 同步帧。 */
export function createSyncStdout(realStdout) {
  return new Proxy(realStdout, {
    get(target, property) {
      if (property === "write") {
        return (...args) => {
          const [chunk] = args;

          if (isEmptyChunk(chunk)) return target.write(...args);

          const encoding = typeof args[1] === "string" ? args[1] : undefined;
          const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
          const wrapped = Buffer.concat([BSU_BUFFER, payload, ESU_BUFFER]);
          const callback = typeof args[1] === "function" ? args[1] : args[2];

          return typeof callback === "function"
            ? target.write(wrapped, callback)
            : target.write(wrapped);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
