/**
 * 桥接文件与渲染状态的数据模型（扩展侧唯一事实来源）。
 * 运行时脚本侧的 JSON 结构与此保持一致。
 */
export interface CurrentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface BridgeData {
  schemaVersion: number;
  source: 'statusline' | 'jsonl' | 'error' | 'none' | 'panel-anchor';
  /** ISO-8601 UTC，陈旧判定时钟 */
  updatedAt: string;
  sessionId: string | null;
  /** 从 transcript 第一条真人消息提取的会话标题（jsonl 模式可用） */
  sessionTitle: string | null;
  transcriptPath: string | null;
  cwd: string | null;
  model: {
    id: string | null;
    pricingKnown: boolean;
    pricingSource: 'default' | 'config' | null;
  };
  context: {
    windowSize: number | null;
    usedPct: number | null;
    remainingPct: number | null;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
    /** 最近一次 API 响应的用量；首次调用前与 /compact 后为 null */
    current: CurrentUsage | null;
  };
  stats: {
    cacheHitRate: number | null;
    costSessionUsd: number | null;
    /** 本轮（最近一次 API 调用）费用 ¥ */
    costTurnYuan: number | null;
    /** 会话累计费用 ¥（仅 jsonl 兜底模式能算；statusline 模式下为 null，由仪表盘按轮次累计） */
    costSessionYuan: number | null;
    tokensInTurn: number | null;
    isPeakTime: boolean | null;
  };
  lastError: string | null;
}

export interface WarningData {
  schemaVersion: number;
  updatedAt: string;
  sessionId: string | null;
  transcriptPath: string | null;
  active: boolean;
  trigger: 'auto' | 'manual' | null;
  at: string | null;
}

export type SourceMode = 'bridge' | 'jsonl' | 'none';

export interface SessionInfo {
  path: string;
  sessionId: string;
  title: string;
  yuanToday: number;
  lastActivityMs: number;
  lastUserMs: number;
}

export interface BalanceInfo {
  yuan: number | null;
  daysRemaining: number | null;
  error: string | null;
  checkedAt: string;
}

export interface RenderState {
  data: BridgeData | null;
  warning: WarningData | null;
  mode: SourceMode;
  stale: boolean;
  /** 检测到多个会话在短时间内轮流写桥接文件（单活跃会话监控限制） */
  sessionChurn: boolean;
  /** 今日（北京时间）全部会话合计费用 ¥ */
  todayYuan: number | null;
  /** 今日会话清单（按最后活动倒序） */
  sessions: SessionInfo[];
  /** 用户主动钉选的会话路径（null = 跟随最新） */
  pinnedPath: string | null;
  /** DeepSeek 账户余额（开关关闭时为 null） */
  balance: BalanceInfo | null;
}
