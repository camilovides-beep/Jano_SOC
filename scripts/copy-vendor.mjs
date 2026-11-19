// Copia Three.js desde node_modules a public/vendor para servirlo localmente (sin CDN).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'three');
const dst = join(root, 'public', 'vendor', 'three');
const files = [
  'build/three.module.js',
  'build/three.core.js',
  'examples/jsm/loaders/GLTFLoader.js',
  'examples/jsm/utils/BufferGeometryUtils.js',
  'examples/jsm/utils/SkeletonUtils.js',
  'examples/jsm/environments/RoomEnvironment.js',
];
for (const f of files) {
  mkdirSync(dirname(join(dst, f)), { recursive: true });
  cpSync(join(src, f), join(dst, f));
}
console.log(`vendor: ${files.length} archivos de three copiados`);
