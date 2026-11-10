import { bundledMax } from '../src/portable/max-release.ts';
export const dmgVariants = [
  { platform: 'macos-arm64', variant: 'full', name: 'stick_ai-macos-arm64.dmg' },
  { platform: 'macos-x64', variant: 'full', name: 'stick_ai-macos-x64.dmg' },
  { platform: 'macos-x64', variant: 'lite-picker', name: 'stick_ai-macos-x64-lite-picker.dmg' }
];
export function validateDmgMetadata(data, expected, repo, build) {
  const lite = { path: 'models/stellan-1-lite-q4_k_m.gguf', size: 4147481440, sha256: '84328c452ddef6122b35702f754935ebd7c8bf95a8a9f2b718392cc68968453e' };
  const models = expected.variant === 'full' ? [lite, bundledMax] : [lite];
  if (data.format !== 1 || data.repository !== repo || data.run !== String(build.id) || data.source !== build.head_sha || data.platform !== expected.platform || data.variant !== expected.variant || data.name !== expected.name || !/^[a-f0-9]{64}$/.test(data.sha256 ?? '') || !Number.isSafeInteger(data.size) || data.size <= models.reduce((n,m)=>n+m.size,0) * .9 || data.size > 22 * 1024 ** 3 || !Array.isArray(data.models) || data.models.length !== models.length || models.some(m=> !data.models.some(v=>v.path===m.path && v.size===m.size && v.sha256===m.sha256)) || !['hdiutil verify','read-only mounted file hashes','native app dry-run','Max file picker helper'].every(check=>data.checks?.includes(check))) { throw new Error('DMG metadata does not match the trusted native build and pinned models'); }
  return data;
}
