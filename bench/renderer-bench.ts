import assert from "node:assert/strict";
import codexStyle from "../index.ts";

const tools = new Map<string, any>();
const handlers = new Map<string, (event: any) => void>();
const fakePi = {
  on(name: string, handler: (event: any) => void) {
    handlers.set(name, handler);
  },
  registerTool(tool: any) {
    tools.set(tool.name, tool);
  },
};
codexStyle(fakePi as any);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const readOutput = Array.from({ length: 2000 }, (_, i) => `const value${i} = ${i}; // benchmark line ${i}`).join("\n");
const bashOutput = Array.from({ length: 2000 }, (_, i) => `file${i} | ${i} +++`).join("\n");
const diff = Array.from({ length: 2000 }, (_, i) => i % 2 ? `+new line ${i}` : `-old line ${i}`).join("\n");

function now(): bigint {
  return process.hrtime.bigint();
}

function ms(start: bigint): number {
  return Number(now() - start) / 1e6;
}

function begin(toolName: string, id: string, args: any): void {
  handlers.get("turn_start")?.({});
  handlers.get("tool_execution_start")?.({ toolName, toolCallId: id, args });
}

function measure(name: string, iterations: number, setup: () => () => void): void {
  const coldStart = now();
  for (let i = 0; i < iterations; i++) setup()();
  const coldMs = ms(coldStart);

  const render = setup();
  render();
  for (let i = 0; i < 100; i++) render();
  const steadyStart = now();
  for (let i = 0; i < iterations * 10; i++) render();
  const steadyMs = ms(steadyStart);

  console.log(JSON.stringify({
    name,
    coldIterations: iterations,
    coldMs,
    coldMsPerRender: coldMs / iterations,
    steadyIterations: iterations * 10,
    steadyMs,
    steadyMsPerRender: steadyMs / (iterations * 10),
  }));
}

function readSetup(expanded: boolean): () => void {
  const id = `read-${Math.random()}`;
  const args = { path: "/tmp/bench.ts" };
  const context = { toolCallId: id, args, state: {} };
  const tool = tools.get("read");
  assert.ok(tool);
  begin("read", id, args);
  tool.renderCall(args, theme, context);
  const result = { content: [{ type: "text", text: readOutput }], details: {} };
  return () => tool.renderResult(result, { expanded, isPartial: false }, theme, context);
}

function bashSetup(expanded: boolean): () => void {
  const id = `bash-${Math.random()}`;
  const args = { command: "printf benchmark" };
  const context = { toolCallId: id, args, state: {} };
  const tool = tools.get("bash");
  assert.ok(tool);
  begin("bash", id, args);
  tool.renderCall(args, theme, context);
  const result = { content: [{ type: "text", text: `${bashOutput}\nexit code: 0` }], details: {} };
  return () => tool.renderResult(result, { expanded, isPartial: false }, theme, context);
}

function editSetup(expanded: boolean): () => void {
  const id = `edit-${Math.random()}`;
  const args = { path: "/tmp/bench.ts" };
  const context = { toolCallId: id, args, state: {} };
  const tool = tools.get("edit");
  assert.ok(tool);
  begin("edit", id, args);
  tool.renderCall(args, theme, context);
  const result = { content: [{ type: "text", text: "ok" }], details: { diff } };
  return () => tool.renderResult(result, { expanded, isPartial: false }, theme, context);
}

measure("read-collapsed", 20, () => readSetup(false));
measure("read-expanded", 20, () => readSetup(true));
measure("bash-collapsed", 20, () => bashSetup(false));
measure("bash-expanded", 20, () => bashSetup(true));
measure("edit-collapsed", 20, () => editSetup(false));
measure("edit-expanded", 20, () => editSetup(true));

const lagStart = now();
let lagResolve!: (value: number) => void;
const lag = new Promise<number>((resolve) => { lagResolve = resolve; });
setImmediate(() => lagResolve(ms(lagStart)));
for (let i = 0; i < 20; i++) readSetup(true)();
lag.then((eventLoopLagMs) => {
  console.log(JSON.stringify({ name: "event-loop-lag", coldExpandedRenders: 20, eventLoopLagMs }));
  process.exit(0);
});
