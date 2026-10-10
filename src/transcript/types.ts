/** 两条 provider 路径共用的数据契约；协议扩展只保留在工具/块边界。 */
export interface TranscriptBlock {
  id?: string;
  role: string;
  text?: string;
  head?: boolean;
  inputId?: string;
  thought?: ThoughtState;
  tool?: Record<string, any>;
  [key: string]: any;
}

export interface ThoughtState {
  startedAt?: number;
  activeAt?: number;
  activeMs?: number;
  pausedAt?: number;
  pausedMs?: number;
  text?: string;
  title?: string;
  expanded?: boolean;
  displayMode?: string;
  hasContent?: boolean;
  [key: string]: any;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  thought?: number;
  cached?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  sessionCumulative?: boolean;
  [key: string]: any;
}

export interface SessionCost {
  amount: number;
  currency: string;
}

export interface ContextUsage {
  used?: number;
  size?: number;
  cost?: SessionCost;
}

export interface TurnResult {
  stopReason?: string;
  cancelled?: boolean;
  [key: string]: any;
}
