import { useState } from "react";

import { InputPrompt } from "../input/InputPrompt.tsx";
import { PermissionDialog } from "./PermissionDialog.tsx";

const ITEMS = [
  { value: "approve", label: "Approve and implement" },
  { value: "revise", label: "Request changes" },
  { value: "reject", label: "Reject and exit Plan Mode" },
];

export function PlanReviewDialog({ plan, path, onResolve }: any) {
  const [revising, setRevising] = useState(false);
  if (revising) {
    return (
      <InputPrompt
        title="Plan changes"
        hint="Enter to send feedback · Esc to return"
        onSubmit={(feedback) => onResolve({ action: "revise", feedback })}
        onCancel={() => setRevising(false)}
      />
    );
  }
  return (
    <PermissionDialog
      toolCall={{ kind: "plan", title: path, rawInput: { plan } }}
      items={ITEMS}
      escapeValue="dismiss"
      onResolve={(value) => {
        if (value === "revise") setRevising(true);
        else onResolve({ action: value ?? "dismiss" });
      }}
    />
  );
}
