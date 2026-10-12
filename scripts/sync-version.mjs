// Syncs package.json version from manifest.json (single source of truth for
// the addon version), so the bundled zip name matches what Wealthfolio shows.
import { readFileSync, writeFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

if (pkg.version !== manifest.version) {
  pkg.version = manifest.version;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log(`package.json version synced to ${manifest.version}`);
} else {
  console.log(`package.json already at ${manifest.version}`);
}
