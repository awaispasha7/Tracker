// Live check of the SkyAccess MCP server: handshake, tool schemas, one read-only search.
// Never calls request_booking (that would send an enquiry to a real specialist).
//
//   npm run skyaccess:check                      # origin TEB
//   npm run skyaccess:check -- "Los Angeles" "Las Vegas"

import { SkyAccessClient } from '../src/integrations/skyaccess/client.ts';
import { normalizeFlight } from '../src/integrations/skyaccess/service.ts';
import type { FetchLike } from '../src/integrations/aviapages/client.ts';

const [origin = 'TEB', destination] = process.argv.slice(2);
const client = new SkyAccessClient({
  fetch: globalThis.fetch as unknown as FetchLike,
  config: process.env.SKYACCESS_ENDPOINT ? { endpoint: process.env.SKYACCESS_ENDPOINT } : undefined,
});
console.log(`SkyAccess MCP check against ${client.config.endpoint}\n`);

try {
  const init = await client.initialize();
  console.log('initialize  ', init.protocolVersion, JSON.stringify(init.serverInfo));

  const tools = await client.listTools(true);
  console.log(`tools/list   ${tools.length} tools`);
  for (const t of tools) {
    const props = t.inputSchema?.properties ?? {};
    const req = new Set(t.inputSchema?.required ?? []);
    console.log(`  ${t.name}${t.annotations?.readOnlyHint === false ? '  [WRITE]' : ''}`);
    console.log(`    input: ${Object.keys(props).map((k) => (req.has(k) ? `${k}*` : k)).join(', ') || '(none)'}`);
  }

  const r = await client.callTool('search_empty_legs', { origin, destination });
  const raw = r.data;
  console.log(`\nsearch_empty_legs origin=${origin}${destination ? ` destination=${destination}` : ''}`);
  console.log(`  structured payload: ${raw === null ? 'none (text only)' : `keys ${JSON.stringify(Array.isArray(raw) ? '[array]' : Object.keys(raw as object))}`}`);
  const list = Array.isArray(raw) ? raw : Object.values((raw ?? {}) as Record<string, unknown>).find(Array.isArray) ?? [];
  console.log(`  flights: ${list.length}`);
  if (list[0]) {
    console.log('\n  first raw record:\n' + JSON.stringify(list[0], null, 2).replace(/^/gm, '    '));
    const n = normalizeFlight(list[0]);
    const { raw: _raw, ...shown } = n ?? { raw: null };
    console.log('\n  normalized:\n' + JSON.stringify(shown, null, 2).replace(/^/gm, '    '));
    const gaps = n ? Object.entries(shown).filter(([, v]) => v === null).map(([k]) => k) : ['(record not recognised)'];
    if (gaps.length) console.log(`\n  ! not mapped: ${gaps.join(', ')}. Add the field names above to normalizeFlight() in src/integrations/skyaccess/service.ts`);
  } else {
    console.log('\n  text:\n' + r.text.replace(/^/gm, '    '));
  }
  console.log('\nOK');
} catch (e) {
  console.error(`\nFAILED: ${(e as Error).message}`);
  process.exit(1);
}
