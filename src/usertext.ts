/**
 * 从用户消息 content 提取纯文本（string 或 [{type:'text',text}] 数组；跳过系统 XML/Caveat）。
 * 供 jsonl 解析（当前会话标题）与 daily 解析（全部会话列表的自动标题）共用。
 */
export function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') {
    const t = content.trim();
    if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return null;
    return t;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'text' &&
        typeof (block as { text?: string }).text === 'string'
      ) {
        parts.push((block as { text: string }).text.trim());
      }
    }
    const t = parts.join(' ').trim();
    if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return null;
    return t;
  }
  return null;
}
