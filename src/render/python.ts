// tools/tiles.py from TypeScript: the 2x finishing step's cut and join, and the face detector the local
// renders' face pass uses. Needs a Python with numpy, pillow and opencv-python-headless<5 (CHARFORGE_PYTHON,
// else tools/.venv, else python3).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function findPython(): string {
  if (process.env.CHARFORGE_PYTHON) return process.env.CHARFORGE_PYTHON;
  for (const p of [join(ROOT, 'tools', '.venv', 'bin', 'python'), join(ROOT, 'tools', '.venv', 'Scripts', 'python.exe')]) if (existsSync(p)) return p;
  return 'python3';
}

const SETUP = 'python3 -m venv tools/.venv && tools/.venv/bin/pip install numpy pillow "opencv-python-headless<5" (or set CHARFORGE_PYTHON)';

/** Run tools/<script> and return the JSON object it prints last. */
export function runTool(script: string, args: string[]): Promise<Record<string, unknown>> {
  const python = findPython();
  return new Promise((resolve_, reject) => {
    const p = spawn(python, ['-I', join(ROOT, 'tools', script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`could not run ${python} (${e.message}). The finishing step needs Python: ${SETUP}`)));
    p.on('close', (code) => {
      if (code !== 0) {
        const missing = /No module named '(\w+)'/.exec(err);
        return reject(new Error(missing ? `${python} has no ${missing[1]}: ${SETUP}` : `tools/${script} ${args[0]} failed: ${err.trim().split('\n').slice(-3).join(' ')}`));
      }
      const last = out.trim().split('\n').pop() ?? '{}';
      try {
        resolve_(JSON.parse(last));
      } catch {
        reject(new Error(`tools/${script} ${args[0]} printed no result: ${last}`));
      }
    });
  });
}


export const tiles = (args: string[]) => runTool('tiles.py', args);
