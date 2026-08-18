import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  getLanguageFromPath,
  highlightCode,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { relative } from "node:path";

const PREVIEW_LINES = 5;
const COMMAND_LINES = 2;
const SHORT_DIFF_LINES = 20;
const READ_PREVIEW_LINES = 10;
const BASH_TAIL_LINES = 10;
const TRANSCRIPT_HINT = "ctrl+o to expand";

type RenderState = {
  done?: boolean;
  error?: boolean;
  exitCode?: number;
  additions?: number;
  removals?: number;
};

type GroupKind = "read" | "grep" | "find" | "ls" | "edit" | "write";
type GroupItem = {
  id: string;
  args: any;
  done: boolean;
  error?: boolean;
  result?: any;
  additions?: number;
  removals?: number;
};
type ToolGroup = {
  kind: GroupKind;
  items: Map<string, GroupItem>;
};

const groupsByToolCall = new Map<string, ToolGroup>();
let lastGroup: ToolGroup | undefined;

function groupedKind(name: string): GroupKind | undefined {
  return ["read", "grep", "find", "ls", "edit", "write"].includes(name)
    ? (name as GroupKind)
    : undefined;
}

function groupItem(group: ToolGroup, id: string, args: any): GroupItem {
  let item = group.items.get(id);
  if (!item) {
    item = { id, args, done: false };
    group.items.set(id, item);
  } else if (args !== undefined) {
    item.args = args;
  }
  return item;
}

function toolGroup(name: string, args: any, context: any): { group: ToolGroup; item: GroupItem; first: boolean } {
  const id = String(context?.toolCallId || `${name}:${Math.random()}`);
  let group = groupsByToolCall.get(id);
  if (!group) {
    group = lastGroup && lastGroup.kind === name
      ? lastGroup
      : { kind: groupedKind(name) ?? (name as GroupKind), items: new Map() };
    groupsByToolCall.set(id, group);
    lastGroup = group;
  }
  const item = groupItem(group, id, args);
  return { group, item, first: group.items.keys().next().value === id };
}

function groupItems(group: ToolGroup): GroupItem[] {
  return [...group.items.values()];
}

function groupComplete(group: ToolGroup): boolean {
  return groupItems(group).every((item) => item.done);
}

function stateOf(context: any): RenderState {
  return context?.state && typeof context.state === "object" ? context.state : {};
}

function resultText(result: any): string {
  const item = result?.content?.find((entry: any) => entry.type === "text");
  return item?.text ?? "";
}

function shortPath(value: unknown): string {
  const path = String(value || ".");
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${relative(home, path)}`;
  return path;
}

function commandLine(command: string, theme: any): string {
  try {
    return highlightCode(command, "bash", theme);
  } catch {
    return theme.fg("accent", command);
  }
}

function marker(theme: any, state: RenderState): string {
  if (state.error) return theme.fg("error", theme.bold("•"));
  if (state.done) return theme.fg("success", theme.bold("•"));
  return theme.fg("dim", "•");
}

function verb(state: RenderState, running: string, done: string): string {
  if (state.error) return "Failed";
  return state.done ? done : running;
}

function commandDisplay(command: string, theme: any): string {
  const lines = command.trim().split("\n");
  const visible = lines.slice(0, COMMAND_LINES);
  if (lines.length > COMMAND_LINES) {
    visible.push(`… +${lines.length - COMMAND_LINES} lines`);
  }

  return visible
    .map((line, index) => {
      const prefix = index === 0 ? "" : theme.fg("dim", "  │ ");
      return `${prefix}${commandLine(line, theme)}`;
    })
    .join("\n");
}

function commandCall(command: unknown, theme: any, context: any): Text {
  lastGroup = undefined;
  const state = stateOf(context);
  const value = String(command || "…");
  const label = verb(state, "Running", "Ran");
  const firstPrefix = `${marker(theme, state)} ${theme.bold(label)} `;
  return new Text(`${firstPrefix}${commandDisplay(value, theme)}`, 0, 0);
}

function previewLines(
  output: string,
  expanded: boolean,
  limit = PREVIEW_LINES,
  tail = false,
): string[] {
  const lines = output.split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (expanded || lines.length <= limit) return lines;

  if (tail) {
    const visible = Math.max(1, limit - 1);
    return [
      `… +${lines.length - visible} lines (${TRANSCRIPT_HINT})`,
      ...lines.slice(-visible),
    ];
  }

  const head = Math.floor((limit - 1) / 2);
  const tailLines = limit - head - 1;
  const omitted = lines.length - head - tailLines;
  return [
    ...lines.slice(0, head),
    `… +${omitted} lines (${TRANSCRIPT_HINT})`,
    ...lines.slice(-tailLines),
  ];
}

function textPreviewLines(output: string, expanded: boolean, limit: number): string[] {
  const lines = output.split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (expanded || lines.length <= limit) return lines;
  return [
    ...lines.slice(0, limit),
    `… (${lines.length - limit} more lines, ${TRANSCRIPT_HINT})`,
  ];
}

function textOutputDisplay(output: string, theme: any, expanded: boolean): string {
  return textPreviewLines(output, expanded, PREVIEW_LINES)
    .map((line, index) => {
      const prefix = index === 0 ? "  └ " : "    ";
      return theme.fg("dim", `${prefix}${line}`);
    })
    .join("\n");
}

function readPreviewDisplay(group: ToolGroup, theme: any, expanded: boolean): string {
  return groupItems(group)
    .map((item) => {
      const output = resultText(item.result).trim();
      if (!output) return "";

      const path = String(item.args?.path || "");
      let language = "";
      try {
        language = getLanguageFromPath(path) || "";
      } catch {
        // Unknown extensions stay as plain text.
      }

      const lines = textPreviewLines(output, expanded, READ_PREVIEW_LINES);
      const codeLines = lines.filter((line) => !line.startsWith("… ("));
      let highlighted = codeLines.join("\n");
      try {
        highlighted = highlightCode(highlighted, language || "text", theme);
      } catch {
        // Keep raw text if the syntax highlighter has no grammar for the path.
      }
      const highlightedLines = highlighted.split("\n");
      let codeIndex = 0;
      const body = lines.map((line) => {
        if (line.startsWith("… (")) {
          return theme.fg("dim", `    │ ${line}`);
        }
        const code = highlightedLines[codeIndex++] ?? line;
        return `${theme.fg("dim", "    │ ")}${code}`;
      });

      const label = language ? ` (${language})` : "";
      return [
        theme.fg("dim", `    ┌─ ${shortPath(path)}${label}`),
        ...body,
        theme.fg("dim", "    └─"),
      ].join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

function highlightGitLine(line: string, theme: any): string {
  const ranges: Array<{ start: number; end: number; color: string }> = [];
  const patterns = [
    [/\b\d+\s+insertions?\(\+\)/gi, "toolDiffAdded"],
    [/\b\d+\s+deletions?\(-\)/gi, "toolDiffRemoved"],
  ] as const;

  for (const [pattern, color] of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) {
      ranges.push({ start: match.index, end: match.index + match[0].length, color });
    }
  }

  const stat = line.match(/\|\s+\d+\s+([+-]+)\s*$/);
  if (stat?.index !== undefined) {
    const bar = stat[1];
    const barStart = stat.index + stat[0].lastIndexOf(bar);
    let start = 0;
    while (start < bar.length) {
      const color = bar[start] === "+" ? "toolDiffAdded" : "toolDiffRemoved";
      let end = start + 1;
      while (end < bar.length && bar[end] === bar[start]) end++;
      ranges.push({ start: barStart + start, end: barStart + end, color });
      start = end;
    }
  }

  if (!ranges.length) return line;
  ranges.sort((a, b) => a.start - b.start);
  let rendered = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    rendered += line.slice(cursor, range.start);
    rendered += theme.fg(range.color, line.slice(range.start, range.end));
    cursor = range.end;
  }
  return rendered + line.slice(cursor);
}

function outputDisplay(output: string, theme: any, expanded: boolean, tail = false): string {
  const lines = previewLines(output, expanded, tail ? BASH_TAIL_LINES : PREVIEW_LINES, tail);
  return lines
    .map((line, index) => {
      if (line.startsWith("… +")) return theme.fg("dim", `    ${line}`);
      const prefix = index === 0 ? "  └ " : "    ";
      return theme.fg("dim", `${prefix}${highlightGitLine(line, theme)}`);
    })
    .join("\n");
}

function parseResult(result: any, context: any) {
  const raw = resultText(result).trimEnd();
  const exit = raw.match(
    /(?:^|\n)\s*(?:(?:command|process)\s+)?(?:exit code|exit status|exited with code|exited with exit code)\s*:?\s*(-?\d+)\s*$/i,
  );
  const exitCode = exit ? Number(exit[1]) : context?.isError ? 1 : 0;
  const output = (exit ? raw.slice(0, exit.index) : raw)
    .replace(/\n?Command completed successfully\.?$/i, "")
    .trimEnd();
  return { output, exitCode };
}

function bashResult(result: any, options: any, theme: any, context: any): Text {
  const state = stateOf(context);
  const parsed = parseResult(result, context);
  if (options.isPartial) {
    const running = theme.fg("dim", "  └ Running…");
    return new Text(
      parsed.output ? `${running}\n${outputDisplay(parsed.output, theme, false, true)}` : running,
      0,
      0,
    );
  }

  state.done = true;
  state.error = parsed.exitCode !== 0;
  state.exitCode = parsed.exitCode;
  if (!parsed.output) return new Text("", 0, 0);

  return new Text(outputDisplay(parsed.output, theme, options.expanded, true), 0, 0);
}

function groupLabel(group: ToolGroup, theme: any): string {
  const items = groupItems(group);
  const paths = items.map((item) => shortPath(item.args?.path));

  switch (group.kind) {
    case "read":
      return `Read ${paths.join(" ")}`;
    case "grep":
      return `Search ${items.map((item) => `/${item.args?.pattern || ""}/ in ${shortPath(item.args?.path)}`).join(" ")}`;
    case "find":
      return `Find ${items.map((item) => `${item.args?.pattern || "*"} in ${shortPath(item.args?.path)}`).join(" ")}`;
    case "ls":
      return `List ${paths.join(" ")}`;
    case "write":
      return `Wrote ${paths.join(" ")}`;
    case "edit":
      return `Edited ${paths.join(" ")}`;
  }
}

function groupOutput(group: ToolGroup): string {
  return groupItems(group)
    .map((item) => resultText(item.result).trim())
    .filter(Boolean)
    .join("\n");
}

function explorationCall(name: string, args: any, theme: any, context: any): Text {
  const { group, first } = toolGroup(name, args, context);
  if (!first) return new Text("", 0, 0);

  const state = stateOf(context);
  const label = verb(state, "Exploring", "Explored");
  const line = `${theme.fg("dim", "  └ ")}${theme.fg("accent", groupLabel(group, theme))}`;
  return new Text(`${marker(theme, state)} ${theme.bold(label)}\n${line}`, 0, 0);
}

function explorationResult(name: string, result: any, options: any, theme: any, context: any): Text {
  const { group, item, first } = toolGroup(name, context?.args, context);
  item.result = result;
  item.error = context?.isError === true;
  item.done = !options.isPartial;
  if (!first) return new Text("", 0, 0);

  const state = stateOf(context);
  state.done = groupComplete(group);
  state.error = groupItems(group).some((entry) => entry.error);
  state.exitCode = state.error ? 1 : 0;

  if (options.isPartial || !groupComplete(group)) {
    return new Text(theme.fg("dim", "  └ Running…"), 0, 0);
  }

  const output = groupOutput(group);
  if (state.error) {
    return new Text(theme.fg("error", outputDisplay(output || "failed", theme, options.expanded)), 0, 0);
  }
  if (!output) return new Text("", 0, 0);
  if (name === "read") {
    return new Text(readPreviewDisplay(group, theme, options.expanded), 0, 0);
  }
  if (name === "grep") {
    return new Text(textOutputDisplay(output, theme, options.expanded), 0, 0);
  }
  if (!options.expanded) return new Text("", 0, 0);
  return new Text(outputDisplay(output, theme, true), 0, 0);
}

function editCall(args: any, theme: any, context: any): Text {
  const { group, first } = toolGroup("edit", args, context);
  if (!first) return new Text("", 0, 0);

  const state = stateOf(context);
  let text = `${marker(theme, state)} ${theme.bold(verb(state, "Editing", "Edited"))} ${theme.fg("accent", groupItems(group).map((item) => shortPath(item.args?.path)).join(" "))}`;
  const additions = groupItems(group).reduce((sum, item) => sum + (item.additions || 0), 0);
  const removals = groupItems(group).reduce((sum, item) => sum + (item.removals || 0), 0);
  if (state.additions !== undefined || additions || removals) {
    text += ` ${theme.fg("toolDiffAdded", `+${additions}`)}${theme.fg("dim", " /")} ${theme.fg("toolDiffRemoved", `-${removals}`)}`;
  }
  return new Text(text, 0, 0);
}

function editResult(result: any, options: any, theme: any, context: any): Text {
  const { group, item, first } = toolGroup("edit", context?.args, context);
  item.result = result;
  item.error = context?.isError === true || resultText(result).startsWith("Error");
  item.done = !options.isPartial;

  const diff = typeof result?.details?.diff === "string" ? result.details.diff : "";
  const lines = diff ? diff.split("\n") : [];
  item.additions = lines.filter((line: string) => line.startsWith("+") && !line.startsWith("+++")).length;
  item.removals = lines.filter((line: string) => line.startsWith("-") && !line.startsWith("---")).length;
  if (!first) return new Text("", 0, 0);

  const state = stateOf(context);
  state.done = groupComplete(group);
  state.error = groupItems(group).some((entry) => entry.error);
  state.additions = groupItems(group).reduce((sum, entry) => sum + (entry.additions || 0), 0);
  state.removals = groupItems(group).reduce((sum, entry) => sum + (entry.removals || 0), 0);

  if (options.isPartial || !groupComplete(group)) {
    return new Text(theme.fg("dim", "  └ Running…"), 0, 0);
  }
  if (state.error && options.expanded) return new Text(theme.fg("error", groupOutput(group)), 0, 0);

  const allDiff = groupItems(group)
    .map((entry) => typeof entry.result?.details?.diff === "string" ? entry.result.details.diff : "")
    .filter(Boolean)
    .join("\n")
    .trimEnd();
  if (!allDiff) return new Text("", 0, 0);

  const diffLines = allDiff.split("\n");
  const visibleLines = options.expanded
    ? diffLines.slice(0, 40)
    : diffLines.length <= SHORT_DIFF_LINES
      ? diffLines
      : [];
  if (!visibleLines.length) return new Text("", 0, 0);

  const rendered = visibleLines.map((line: string) => {
    const color = line.startsWith("+")
      ? "toolDiffAdded"
      : line.startsWith("-")
        ? "toolDiffRemoved"
        : "toolDiffContext";
    return theme.fg(color, `    ${line}`);
  });
  return new Text(rendered.join("\n"), 0, 0);
}


function writeCall(args: any, theme: any, context: any): Text {
  const { group, first } = toolGroup("write", args, context);
  if (!first) return new Text("", 0, 0);

  const state = stateOf(context);
  return new Text(
    `${marker(theme, state)} ${theme.bold(verb(state, "Writing", "Wrote"))} ${theme.fg("accent", groupItems(group).map((item) => shortPath(item.args?.path)).join(" "))}`,
    0,
    0,
  );
}

function writeResult(result: any, options: any, theme: any, context: any): Text {
  const { group, item, first } = toolGroup("write", context?.args, context);
  item.result = result;
  item.error = context?.isError === true || resultText(result).startsWith("Error");
  item.done = !options.isPartial;
  if (!first) return new Text("", 0, 0);

  const state = stateOf(context);
  state.done = groupComplete(group);
  state.error = groupItems(group).some((entry) => entry.error);
  if (state.error && options.expanded) return new Text(theme.fg("error", groupOutput(group)), 0, 0);
  return new Text("", 0, 0);
}


function override(pi: ExtensionAPI, name: string, create: any, renderCall: any, renderResult: any) {
  const initial = create(process.cwd());
  pi.registerTool({
    ...initial,
    name,
    renderShell: "self",
    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      return create(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
    },
    renderCall,
    renderResult,
  });
}

export default function codexStyle(pi: ExtensionAPI) {
  pi.on("turn_start", () => {
    lastGroup = undefined;
  });

  pi.on("tool_execution_start", (event) => {
    const kind = groupedKind(event.toolName);
    if (!kind) {
      lastGroup = undefined;
      return;
    }

    const group = lastGroup?.kind === kind
      ? lastGroup
      : { kind, items: new Map<string, GroupItem>() };
    groupItem(group, event.toolCallId, event.args);
    groupsByToolCall.set(event.toolCallId, group);
    lastGroup = group;
  });

  override(pi, "bash", createBashTool, (args: any, theme: any, context: any) => commandCall(args.command, theme, context), bashResult);
  override(pi, "read", createReadTool, (args: any, theme: any, context: any) => explorationCall("read", args, theme, context), (result: any, options: any, theme: any, context: any) => explorationResult("read", result, options, theme, context));
  override(pi, "grep", createGrepTool, (args: any, theme: any, context: any) => explorationCall("grep", args, theme, context), (result: any, options: any, theme: any, context: any) => explorationResult("grep", result, options, theme, context));
  override(pi, "find", createFindTool, (args: any, theme: any, context: any) => explorationCall("find", args, theme, context), (result: any, options: any, theme: any, context: any) => explorationResult("find", result, options, theme, context));
  override(pi, "ls", createLsTool, (args: any, theme: any, context: any) => explorationCall("ls", args, theme, context), (result: any, options: any, theme: any, context: any) => explorationResult("ls", result, options, theme, context));
  override(pi, "edit", createEditTool, editCall, editResult);
  override(pi, "write", createWriteTool, writeCall, writeResult);
}
