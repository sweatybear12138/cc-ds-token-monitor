import * as os from 'os';

/**
 * 主目录解析：优先 %USERPROFILE%（Windows 权威来源），
 * 防扩展宿主进程被注入 HOME 环境变量导致 os.homedir() 指向别处。
 */
export function homeDir(): string {
  return process.env.USERPROFILE || os.homedir();
}
