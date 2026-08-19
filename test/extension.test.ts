import assert from "node:assert/strict";
import test from "node:test";
import codexStyle from "../index.ts";

type Handler = (event: any, ctx?: any) => unknown;
type ToolResultPatch = { content?: unknown; details?: unknown };

type FakePi = {
  handlers: Map<string, Handler[]>;
  tools: Map<string, any>;
  on: (name: string, handler: Handler) => void;
  registerTool: (tool: any) => void;
};

function createPi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  return {
    handlers,
    tools,
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function renderText(value: any): string {
  assert.ok(value);
  return typeof value.render === "function" ? value.render(120).join("\n") : String(value);
}

function begin(pi: FakePi, toolName: string, toolCallId: string, args: any): void {
  pi.handlers.get("turn_start")?.[0]?.({});
  pi.handlers.get("tool_execution_start")?.[0]?.({
    toolName,
    toolCallId,
    args,
  });
}

test("registers the built-in tool renderers as a Pi package extension", () => {
  const pi = createPi();
  codexStyle(pi as any);

  assert.deepEqual([...pi.tools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  for (const tool of pi.tools.values()) {
    assert.equal(tool.renderShell, "self");
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
  }
  assert.ok(pi.handlers.has("turn_start"));
  assert.ok(pi.handlers.has("tool_execution_start"));
  assert.ok(pi.handlers.has("tool_result"));
});

test("compacts search results from different tools to source links", () => {
  const pi = createPi();
  codexStyle(pi as any);
  const compact = pi.handlers.get("tool_result")?.[0];
  assert.ok(compact);

  const cases = [
    [
      "search",
      JSON.stringify({
        web: [{
          url: "https://example.com/web",
          title: "Web result",
          description: "See https://example.com/inside only in the snippet",
        }],
      }),
      "https://example.com/web",
    ],
    [
      "tavily_search",
      JSON.stringify({ results: [{ url: "https://example.com/tavily", title: "Tavily" }] }),
      "https://example.com/tavily",
    ],
    [
      "brave_web_search",
      JSON.stringify({ organic_results: [{ link: "https://example.com/brave" }] }),
      "https://example.com/brave",
    ],
    [
      "search",
      "[Readable result](https://example.com/markdown)",
      "https://example.com/markdown",
    ],
  ] as const;

  for (const [toolName, text, expected] of cases) {
    const details = { original: true };
    const result = compact({
      toolName,
      toolCallId: `${toolName}-test`,
      input: {},
      content: [{ type: "text", text }],
      details,
      isError: false,
    }) as ToolResultPatch | undefined;

    assert.deepEqual(result?.content, [{ type: "text", text: expected }]);
    assert.equal(result?.details, details);
  }

  const empty = compact({
    toolName: "firecrawl_search",
    toolCallId: "empty-search",
    input: {},
    content: [{ type: "text", text: '{"web":[]}' }],
    details: {},
    isError: false,
  }) as ToolResultPatch | undefined;
  assert.deepEqual(empty?.content, [{ type: "text", text: "No results" }]);

  assert.equal(
    compact({
      toolName: "search",
      toolCallId: "failed-search",
      input: {},
      content: [{ type: "text", text: "Error: https://example.com" }],
      details: {},
      isError: true,
    }),
    undefined,
  );
});

test("does not rewrite unrelated URL-bearing tool output", () => {
  const pi = createPi();
  codexStyle(pi as any);
  const compact = pi.handlers.get("tool_result")?.[0];
  assert.ok(compact);

  for (const text of [
    '{"url":"https://example.com"}',
    '[{"url":"https://example.com"}]',
    '{"data":{"url":"https://example.com"}}',
  ]) {
    assert.equal(
      compact({
        toolName: "browser",
        toolCallId: "browser-test",
        input: {},
        content: [{ type: "text", text }],
        details: {},
        isError: false,
      }),
      undefined,
    );
  }
});

test("renders Codex-style bash and read output", () => {
  const pi = createPi();
  codexStyle(pi as any);

  const bash = pi.tools.get("bash");
  const bashArgs = { command: "printf hello" };
  const bashContext = { toolCallId: "bash-test", args: bashArgs, state: {} };
  begin(pi, "bash", bashContext.toolCallId, bashArgs);

  assert.match(renderText(bash.renderCall(bashArgs, theme, bashContext)), /Running/);
  const bashResult = bash.renderResult(
    { content: [{ type: "text", text: "hello\nexit code: 0" }], details: {} },
    { expanded: false, isPartial: false },
    theme,
    bashContext,
  );
  assert.match(renderText(bashResult), /hello/);

  const read = pi.tools.get("read");
  const readArgs = { path: "src/example.ts" };
  const readContext = { toolCallId: "read-test", args: readArgs, state: {} };
  begin(pi, "read", readContext.toolCallId, readArgs);

  assert.match(renderText(read.renderCall(readArgs, theme, readContext)), /Exploring/);
  const readResult = read.renderResult(
    { content: [{ type: "text", text: "const answer = 42;" }], details: {} },
    { expanded: false, isPartial: false },
    theme,
    readContext,
  );
  assert.match(renderText(readResult), /src\/example\.ts/);
  assert.match(renderText(readResult), /answer/);
});

test("renders the remaining built-in tool result shapes", () => {
  const pi = createPi();
  codexStyle(pi as any);

  const cases = [
    ["grep", { pattern: "TODO", path: "src" }],
    ["find", { pattern: "*.ts", path: "." }],
    ["ls", { path: "." }],
  ] as const;

  for (const [toolName, args] of cases) {
    const tool = pi.tools.get(toolName);
    const context = {
      toolCallId: `${toolName}-test`,
      args,
      state: {},
    };
    begin(pi, toolName, context.toolCallId, args);

    assert.ok(renderText(tool.renderCall(args, theme, context)));
    const result = tool.renderResult(
      { content: [{ type: "text", text: "entry.ts" }], details: {} },
      { expanded: true, isPartial: false },
      theme,
      context,
    );
    assert.match(renderText(result), /entry\.ts/);
  }

  const edit = pi.tools.get("edit");
  const editArgs = { path: "src/example.ts" };
  const editContext = { toolCallId: "edit-test", args: editArgs, state: {} };
  begin(pi, "edit", editContext.toolCallId, editArgs);
  assert.match(renderText(edit.renderCall(editArgs, theme, editContext)), /Editing/);
  const editResult = edit.renderResult(
    {
      content: [{ type: "text", text: "ok" }],
      details: { diff: "-old\n+new" },
    },
    { expanded: false, isPartial: false },
    theme,
    editContext,
  );
  assert.match(renderText(editResult), /\+new/);

  const write = pi.tools.get("write");
  const writeArgs = { path: "src/output.ts" };
  const writeContext = { toolCallId: "write-test", args: writeArgs, state: {} };
  begin(pi, "write", writeContext.toolCallId, writeArgs);
  assert.match(renderText(write.renderCall(writeArgs, theme, writeContext)), /Writing/);
  write.renderResult(
    { content: [{ type: "text", text: "" }], details: {} },
    { expanded: false, isPartial: false },
    theme,
    writeContext,
  );
});
