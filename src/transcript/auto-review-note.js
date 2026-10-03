/**
 * Auto 安全审查在工具行下的说明文案。
 *
 * 审查结论本身带着分类器给出的理由，被阻断时这条理由是用户唯一能看到的解释：
 * 不带出来，界面上就只剩「命令没跑」，看不出是谁、因为什么拦下的。
 */
export function autoReviewNote(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.status === "checking") return "Auto safety review: checking…";
  if (payload.status === "allowed") return "Auto safety review: approved";
  if (payload.status === "blocked") {
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    return `Auto safety review: blocked · ${reason || "no reason given"}`;
  }
  return "Auto safety review: no decision";
}
