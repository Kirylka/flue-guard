/** Check the published package surface without installing the optional SDK. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(path.join(tmpdir(), "flue-guard-package-"));
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
    cwd: root, encoding: "utf8",
  }));
  const modules = path.join(temporary, "node_modules");
  const installed = path.join(modules, "flue-guard");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(temporary, packed[0].filename), "--strip-components=1", "-C", installed]);
  const link = (name) => {
    const target = path.join(modules, name);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(path.join(root, "node_modules", name), target, "dir");
  };
  link("@flue/runtime");
  link("valibot");
  const run = (source) => execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: temporary, encoding: "utf8", env: { ...process.env, NODE_PATH: "" },
  });
  run(`
    import assert from 'node:assert/strict';
    const core = await import('flue-guard');
    const { InMemoryAuditLog } = await import('flue-guard/audit');
    const gov = core.createGovernedToolkit({ audit: new InMemoryAuditLog(), context: () => ({ actor: {id:'test',roles:[]}, tenantId:'test' }) });
    const tool = gov.defineGovernedTool({name:'read',description:'read', guard:{evaluate:async()=>({decision:'deny',reasonCodes:[]})},execute:()=>assert.fail('executed')});
    await assert.rejects(tool.execute({}), {code:'guard_denied'});
    await assert.rejects(import('flue-guard/jev'), {code:'ERR_MODULE_NOT_FOUND'});
  `);
  link("@typesafe-ai/sdk");
  run(`
    import assert from 'node:assert/strict';
    import { createJevGuard } from 'flue-guard/jev';
    import { TypeSafeClient } from '@typesafe-ai/sdk';
    const client = new TypeSafeClient({apiKey:'synthetic', logLevel:'off', fetch: async()=>Response.json({model:'test',usage:{input_tokens:1,output_tokens:1},answers:{policyViolation:{type:'noul',noul:0}}})});
    const guard = createJevGuard({client,model:'test',policyId:'test',policyVersion:'1',policy:'Help the user',thresholds:{review:0.3,deny:0.8},state:()=>({request:'help',action:'help'})});
    assert.equal((await guard.evaluate({tool:'read',args:{},ctx:{actor:{id:'test',roles:[]},tenantId:'test',authorizedScopes:[]}})).decision,'allow');
  `);
  console.log("Packed package: core works without SDK; optional adapter works when SDK is installed.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
