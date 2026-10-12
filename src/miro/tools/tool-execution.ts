import { textContent } from "./shared.ts";
import type { ToolResult, ToolRunner } from "./types.ts";

const REJECTED_SUFFIX = "Do not repeat the same call unchanged; change the approach or ask the user what they want instead.";
const AUTO_REJECTED_SUFFIX = "Do not repeat the same call unchanged and do not ask the user to approve it; choose a safer approach.";

/** 普通调用与脚本内调用共用的授权和执行管线；历史配对由外层循环负责。 */
export function createToolExecution({
  runners, decide, getPermissionMode, cwd, alwaysAllowed, alwaysRejected,
  requestPermission, permissionOptions, riskReviewer, stream, requestOptions, onAutoReview,
}: {
  runners: Record<string, ToolRunner>;
  decide: (params: any) => any;
  getPermissionMode: () => any;
  cwd: string;
  alwaysAllowed: Set<any>;
  alwaysRejected: Set<any>;
  requestPermission: (params: any) => Promise<any>;
  permissionOptions: () => any;
  riskReviewer: (params: any) => Promise<any>;
  stream: any;
  requestOptions: any;
  onAutoReview?: (event: any) => void;
}) {
  const denied = (output: string, status = "failed") => ({ allowed: false, status, result: { output, failed: true, content: textContent(output) } });
  return {
    async authorize(item: any, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!item.parsed.ok) return denied(`Tool arguments are not valid JSON: ${item.parsed.error}`);
      if (!runners[item.name]) return denied(`Unknown tool "${item.name}".`);
      const decision = decide({ item, mode: getPermissionMode(), cwd, alwaysAllowed, alwaysRejected });
      if (decision.rejected) return denied(`The user rejected this tool call. ${REJECTED_SUFFIX}`, "cancelled");
      if (decision.autoReview) {
        const event = { toolCallId: item.id, action: item.title ?? item.name };
        onAutoReview?.({ ...event, status: "checking" });
        const review = await riskReviewer({ stream, requestOptions, item, decision, cwd, signal });
        signal?.throwIfAborted();
        if (review?.approved === true) {
          onAutoReview?.({ ...event, status: "allowed", reason: review.reason });
        } else {
          const reason = review?.reason ?? "Risk reviewer could not reach a safe decision.";
          onAutoReview?.({ ...event, status: "blocked", reason });
          return denied(`Auto safety review blocked this tool call: ${reason} ${AUTO_REJECTED_SUFFIX}`, "cancelled");
        }
      }
      if (decision.prompts) {
        let onAbort: () => void;
        const aborted = new Promise<null>((resolve) => {
          onAbort = () => resolve(null);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
        let optionId;
        try {
          optionId = await Promise.race([aborted, requestPermission({
            options: permissionOptions(), signal,
            toolCall: { toolCallId: item.id, name: item.name, title: item.title, kind: item.kind, rawInput: item.rawInput, content: null, locations: null },
          })]);
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
        if (signal?.aborted) return denied(`The user cancelled this tool call. ${REJECTED_SUFFIX}`, "cancelled");
        if (decision.canPersistApproval && optionId === "allow_session") alwaysAllowed.add(decision.scope);
        if (optionId === "reject_always") alwaysRejected.add(decision.scope);
        if (optionId !== "allow_once" && !(decision.canPersistApproval && optionId === "allow_session")) {
          return denied(`The user ${optionId == null ? "cancelled" : "rejected"} this tool call. ${REJECTED_SUFFIX}`, optionId == null ? "cancelled" : "failed");
        }
      }
      return { allowed: true, status: "pending", result: null };
    },
    async run(item: any, context: any = {}): Promise<ToolResult> {
      context.signal?.throwIfAborted();
      item.executed = true;
      try {
        return await runners[item.name](item.rawInput, context);
      } catch (error) {
        return { error: `${item.name}: ${error?.message ?? String(error)}` };
      }
    },
  };
}
