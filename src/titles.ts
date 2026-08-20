import * as fs from 'fs';
import * as path from 'path';

/**
 * 用户自定义会话标题（titles.json，唯一写入方 = 本扩展；与桥接文件完全分离，无竞态）。
 * set 空标题 = 删除自定义 → 恢复 transcript 自动提取。
 */
export class TitleStore {
  private map: Record<string, string> = {};

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      this.map = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      this.map = {};
    }
  }

  get(sessionId: string): string | null {
    return this.map[sessionId] || null;
  }

  set(sessionId: string, title: string): void {
    const t = (title || '').trim().slice(0, 60);
    if (t) {
      this.map[sessionId] = t;
    } else {
      delete this.map[sessionId];
    }
    try {
      const tmp = this.filePath + '.tmp';
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.map, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch {
      /* 保存失败不影响主流程 */
    }
  }
}
