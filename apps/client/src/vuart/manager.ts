import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import type { VuartInfo } from './types';

const TEMP_DIR = '/tmp';
const CREATE_TIMEOUT = 5000;

export class VuartManager {
  private instances: Map<string, { info: VuartInfo; process: ChildProcess }> = new Map();
  private nextId = 1;

  async create(): Promise<VuartInfo> {
    const id = `vuart-${this.nextId++}`;
    const clientPath = path.join(TEMP_DIR, `${id}-client`);
    const devicePath = path.join(TEMP_DIR, `${id}-device`);

    const socat = spawn('socat', [
      '-d', '-d',
      `pty,raw,echo=0,link=${clientPath},mode=666`,
      `pty,raw,echo=0,link=${devicePath},mode=666`,
    ], { stdio: 'ignore' });

    socat.on('error', (err) => {
      log.error(`socat error (${id}):`, err);
    });

    socat.on('exit', (code) => {
      log.warn(`socat exited (${id}) code:`, code);
      this.instances.delete(id);
    });

    await this.waitForPath(clientPath, CREATE_TIMEOUT);
    await this.waitForPath(devicePath, CREATE_TIMEOUT);

    const info: VuartInfo = { id, clientPath, devicePath, createdAt: Date.now() };
    this.instances.set(id, { info, process: socat });

    log.info(`vUART created: ${id} (client=${clientPath}, device=${devicePath})`);
    return info;
  }

  private async waitForPath(filePath: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        const stat = await fs.promises.lstat(filePath);
        if (stat.isSymbolicLink()) {
          const target = await fs.promises.readlink(filePath);
          if (target.startsWith('/dev/ttys') || target.startsWith('/dev/pts')) {
            return;
          }
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const target = await fs.promises.readlink(filePath).catch(() => 'unknown');
    if (target.startsWith('/dev/ttys') || target.startsWith('/dev/pts')) {
      return;
    }
    throw new Error(`Timeout waiting for PTY device: ${filePath}`);
  }

  list(): VuartInfo[] {
    return Array.from(this.instances.values()).map(e => e.info);
  }

  get(id: string): VuartInfo | undefined {
    return this.instances.get(id)?.info;
  }

  getClientPath(id: string): string | undefined {
    return this.instances.get(id)?.info.clientPath;
  }

  getDevicePath(id: string): string | undefined {
    return this.instances.get(id)?.info.devicePath;
  }

  async delete(id: string): Promise<boolean> {
    const entry = this.instances.get(id);
    if (!entry) return false;

    const { info, process } = entry;
    log.info(`Deleting vUART: ${id}`);

    process.kill('SIGTERM');
    setTimeout(() => {
      if (process.exitCode === null) {
        process.kill('SIGKILL');
      }
    }, 2000);

    try { await fs.promises.unlink(info.clientPath); } catch { }
    try { await fs.promises.unlink(info.devicePath); } catch { }

    this.instances.delete(id);
    return true;
  }

  async cleanup(): Promise<void> {
    for (const id of this.instances.keys()) {
      await this.delete(id);
    }
  }

  get size(): number {
    return this.instances.size;
  }
}

export const vuartManager = new VuartManager();
