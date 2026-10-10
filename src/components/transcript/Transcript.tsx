import { Static, useWindowSize } from "ink";

import { useStore } from "../../transcript/store.ts";
import { Message } from "./Message.tsx";

/** 历史交给 <Static>；必须钉死 width，否则 Yoga 会按内容撑出终端宽度。 */
export function Transcript() {
  const blocks = useStore((state) => state.blocks);
  const epoch = useStore((state) => state.epoch);
  const { columns } = useWindowSize();

  return (
    <Static key={epoch} items={blocks} style={{ width: columns }}>
      {(block) => <Message key={block.id} block={block} width={columns} />}
    </Static>
  );
}
