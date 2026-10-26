// Build script for production deployment (e.g. Vercel, static hosting).
// Assembles web/ and core/ into the public/ directory.
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = resolve(ROOT, 'public');

console.log('Building WasteLedger static distribution to', OUT);

// Clean previous build output
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Copy web/ to public/
cpSync(resolve(ROOT, 'web'), OUT, { recursive: true });

// Copy core/ to public/core/ so browser imports '../core/*.js' from '/js/*.js' resolve to '/core/*.js'
cpSync(resolve(ROOT, 'core'), resolve(OUT, 'core'), { recursive: true });

console.log('Build complete. Output written to public/');
