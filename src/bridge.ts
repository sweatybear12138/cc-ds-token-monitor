import * as fs from 'fs';
import * as path from 'path';
import { BridgeData, WarningData } from './types';

/**
 * 桥接文件读取与监听（扩展是只读方，绝不写这两个文件）。
 * Windows 坑对策：监听父目录 + 文件名过滤（原子 rename 会换 inode，直接 watch 文件会静默失效）；
 * watcher 出错 → 退化为 5s mtime 轮询；运行时目录尚未安装 → 5s 探测直到出现。
 */
export class BridgeFiles {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private dirProbe: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private lastMtime: Record<'bridge' | 'warning', number> = { bridge: 0, warning: 0 };
  private disposed = false;

  constructor(
    private readonly runDir: string,
    private readonly onChange: (kind: 'bridge' | 'warning') => void
  ) {}

  get bridgePath(): string {
    return path.join(this.runDir, 'bridge.json');
  }
  get warningPath(): string {
    return path.join(this.runDir, 'warning.json');
  }

  readBridge(): BridgeData | null {
    return this.readJson<BridgeData>(this.bridgePath);
  }
  readWarning(): WarningData | null {
    return this.readJson<WarningData>(this.warningPath);
  }

  private readJson<T>(p: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  /** 桥接数据的年龄（毫秒）；文件缺失或 updatedAt 非法 → null */
  ageMs(data: { updatedAt: string } | null): number | null {
    if (!data || !data.updatedAt) return null;
    const t = Date.parse(data.updatedAt);
    return Number.isFinite(t) ? Date.now() - t : null;
  }

  start(): void {
    this.snapshotMtimes();
    if (!fs.existsSync(this.runDir)) {
      this.dirProbe = setInterval(() => {
        if (this.disposed) return;
        if (fs.existsSync(this.runDir)) {
          if (this.dirProbe) clearInterval(this.dirProbe);
          this.dirProbe = null;
          this.startWatching();
          this.scheduleEmit();
        }
      }, 5000);
      return;
    }
    this.startWatching();
  }

  private snapshotMtimes(): void {
    for (const kind of ['bridge', 'warning'] as const) {
      const p = kind === 'bridge' ? this.bridgePath : this.warningPath;
      try {
        this.lastMtime[kind] = fs.statSync(p).mtimeMs;
      } catch {
        this.lastMtime[kind] = 0;
      }
    }
  }

  private startWatching(): void {
    try {
      this.watcher = fs.watch(this.runDir, (_event, filename) => {
        if (this.disposed) return;
        const name = String(filename ?? '');
        if (!name.endsWith('bridge.json') && !name.endsWith('warning.json')) return; // 忽略 .tmp 与其他文件
        this.scheduleEmit();
      });
      this.watcher.on('error', () => this.switchToPolling());
    } catch {
      this.switchToPolling();
    }
  }

  private switchToPolling(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* 忽略 */
      }
      this.watcher = null;
    }
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.scheduleEmit(), 5000);
    }
  }

  /** 250ms 防抖 + mtime 对比，只上报真正变化了的文件 */
  private scheduleEmit(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      if (this.disposed) return;
      for (const kind of ['bridge', 'warning'] as const) {
        const p = kind === 'bridge' ? this.bridgePath : this.warningPath;
        let m = 0;
        try {
          m = fs.statSync(p).mtimeMs;
        } catch {
          m = 0;
        }
        if (m !== this.lastMtime[kind]) {
          this.lastMtime[kind] = m;
          this.onChange(kind);
        }
      }
    }, 250);
  }

  dispose(): void {
    this.disposed = true;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* 忽略 */
      }
    }
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.dirProbe) clearInterval(this.dirProbe);
    if (this.debounce) clearTimeout(this.debounce);
  }
}
