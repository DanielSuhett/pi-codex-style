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
import { compactSearchResult } from "./search-output.ts";

const PREVIEW_LINES = 5;
const COMMAND_LINES = 2;
const SHORT_DIFF_LINES = 20;
const READ_PREVIEW_LINES = 10;
const BASH_TAIL_LINES = 10;
const MAX_RENDER_LINES = 200;
const MAX_READ_HIGHLIGHT_LINES = READ_PREVIEW_LINES;
const MAX_GROUPS = 256;
const TRANSCRIPT_HINT = "ctrl+o to expand";
const HOME = homedir();
const GROUPED_KINDS = new Set<GroupKind>(["read", "grep", "find", "ls", "edit", "write"]);
const GIT_STAT_PATTERNS = [
  [/\b\d+\s+insertions?\(\+\)/gi, "toolDiffAdded"],
  [/\b\d+\s+deletions?\(-\)/gi, "toolDiffRemoved"],
] as const;
const GIT_FILE_STAT = /\|\s+\d+\s+([+-]+)\s*$/;

type RenderState = {
  done?: boolean;
  error?: boolean;
  exitCode?: number;
  additions?: number;
  removals?: number;
  commandValue?: string;
  commandTheme?: any;
  commandText?: string;
  parsedRaw?: string;
  parsedError?: boolean;
  parsed?: { output: string; outputLines: string[]; exitCode: number };
  outputTheme?: any;
  outputExpanded?: boolean;
  outputText?: string;
};

type GroupKind = "read" | "grep" | "find" | "ls" | "edit" | "write";
type GroupItem = {
  id: string;
  args: any;
  path: string;
  done: boolean;
  error?: boolean;
  result?: any;
  output?: string;
  displayOutput?: string;
  outputLines?: string[];
  diff?: string;
  diffLines?: string[];
  additions?: number;
  removals?: number;
};
type RenderCache = {
  key: string;
  version: number;
  expanded: boolean;
  theme: any;
  text: string;
};
type ToolGroup = {
  kind: GroupKind;
  items: Map<string, GroupItem>;
  firstId?: string;
  version: number;
  label?: string;
  pathLabel?: string;
  output?: { version: number; text: string };
  diffPreview?: { version: number; maxLines: number; totalLines: number; lines: string[] };
  render?: RenderCache;
};

const groupsByToolCall = new Map<string, ToolGroup>();
let lastGroup: ToolGroup | undefined;

function groupedKind(name: string): GroupKind | undefined {
  return GROUPED_KINDS.has(name as GroupKind) ? (name as GroupKind) : undefined;
}

function rememberGroup(id: string, group: ToolGroup): void {
  groupsByToolCall.set(id, group);
  if (groupsByToolCall.size <= MAX_GROUPS) return;

  // ponytail: cap historical grouping state; old rows still have their own result data.
  for (const [, oldGroup] of groupsByToolCall) {
    if (oldGroup === lastGroup) continue;
    for (const oldId of oldGroup.items.keys()) {
      if (groupsByToolCall.get(oldId) === oldGroup) groupsByToolCall.delete(oldId);
    }
    break;
  }
}

function groupItem(group: ToolGroup, id: string, args: any): GroupItem {
  let item = group.items.get(id);
  if (!item) {
    item = { id, args, path: shortPath(args?.path), done: false };
    group.items.set(id, item);
    group.firstId ??= id;
    group.label = undefined;
    group.pathLabel = undefined;
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
      : { kind: groupedKind(name) ?? (name as GroupKind), items: new Map(), version: 0 };
    rememberGroup(id, group);
    lastGroup = group;
  }
  const item = groupItem(group, id, args);
  return { group, item, first: group.firstId === id };
}

function groupItems(group: ToolGroup): GroupItem[] {
  return [...group.items.values()];
}

function groupComplete(group: ToolGroup): boolean {
  for (const item of group.items.values()) {
    if (!item.done) return false;
  }
  return true;
}

function groupHasError(group: ToolGroup): boolean {
  for (const item of group.items.values()) {
    if (item.error) return true;
  }
  return false;
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
  if (path === HOME) return "~";
  if (path.startsWith(`${HOME}/`)) return `~/${relative(HOME, path)}`;
  return path;
}

function textComponent(text: string, context: any): Text {
  const previous = context?.lastComponent;
  if (previous && typeof previous.setText === "function") {
    previous.setText(text);
    return previous as Text;
  }
  return new Text(text, 0, 0);
}

function invalidateGroup(group: ToolGroup): void {
  group.version++;
  group.output = undefined;
  group.diffPreview = undefined;
  group.render = undefined;
}

function updateGroupItem(group: ToolGroup, item: GroupItem, result: any, error: boolean, done: boolean): string {
  const output = resultText(result);
  const displayOutput = output.trim();
  if (item.output !== output || item.displayOutput !== displayOutput || item.error !== error || item.done !== done) {
    item.output = output;
    item.displayOutput = displayOutput;
    item.outputLines = undefined;
    item.error = error;
    item.done = done;
    invalidateGroup(group);
  }
  item.result = result;
  return output;
}

function itemLines(item: GroupItem): string[] {
  if (item.outputLines === undefined) {
    const lines = (item.displayOutput ?? "").split("\n");
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    item.outputLines = lines;
  }
  return item.outputLines;
}

function cachedGroupText(
  group: ToolGroup,
  key: string,
  expanded: boolean,
  theme: any,
  build: () => string,
): string {
  const cache = group.render;
  if (cache && cache.key === key && cache.version === group.version && cache.expanded === expanded && cache.theme === theme) {
    return cache.text;
  }
  const text = build();
  group.render = { key, version: group.version, expanded, theme, text };
  return text;
}

function toLines(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : String(value ?? "").split("\n");
}

function commandLine(command: string, theme: any): string {
  try {
    return toLines(highlightCode(command, "bash")).join("\n");
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
  if (state.commandValue !== value || state.commandTheme !== theme) {
    state.commandValue = value;
    state.commandTheme = theme;
    state.commandText = commandDisplay(value, theme);
  }
  const label = verb(state, "Running", "Ran");
  const firstPrefix = `${marker(theme, state)} ${theme.bold(label)} `;
  return textComponent(`${firstPrefix}${state.commandText}`, context);
}

function outputLines(output: string): string[] {
  const lines = output.split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

function previewLineArray(lines: string[], expanded: boolean, limit = PREVIEW_LINES, tail = false): string[] {
  if (expanded) {
    if (lines.length <= MAX_RENDER_LINES) return lines;
    const visible = Math.max(1, MAX_RENDER_LINES - 1);
    const hint = `… +${lines.length - visible} lines (${TRANSCRIPT_HINT})`;
    return tail
      ? [hint, ...lines.slice(-visible)]
      : [...lines.slice(0, visible), hint];
  }
  if (lines.length <= limit) return lines;

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
  const lines = outputLines(output);
  if (!expanded && lines.length > limit) {
    return [
      ...lines.slice(0, limit),
      `… (${lines.length - limit} more lines, ${TRANSCRIPT_HINT})`,
    ];
  }
  return previewLineArray(lines, expanded, limit);
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
      const output = item.displayOutput ?? "";
      if (!output) return "";

      const path = String(item.args?.path || "");
      let language = "";
      try {
        language = getLanguageFromPath(path) || "";
      } catch {
        // Unknown extensions stay as plain text.
      }

      const lines = previewLineArray(itemLines(item), expanded, READ_PREVIEW_LINES);
      const codeInput: string[] = [];
      for (const line of lines) {
        if (!line.startsWith("… (") && codeInput.length < MAX_READ_HIGHLIGHT_LINES) {
          codeInput.push(line);
        }
      }

      let highlightedLines = codeInput;
      if (codeInput.length > 0) {
        try {
          highlightedLines = toLines(
            highlightCode(codeInput.join("\n"), language || "text"),
          );
        } catch {
          // Keep raw text if the syntax highlighter has no grammar for the path.
        }
      }

      let codeIndex = 0;
      const body = lines.map((line) => {
        if (line.startsWith("… (")) {
          return theme.fg("dim", `    │ ${line}`);
        }
        const code = codeIndex < highlightedLines.length
          ? highlightedLines[codeIndex]
          : line;
        codeIndex++;
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
  if (!line.includes("|") && !line.includes("insertions") && !line.includes("deletions")) return line;

  const ranges: Array<{ start: number; end: number; color: string }> = [];
  for (const [pattern, color] of GIT_STAT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) {
      ranges.push({ start: match.index, end: match.index + match[0].length, color });
    }
  }

  const stat = line.match(GIT_FILE_STAT);
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

function outputDisplayLines(lines: string[], theme: any, expanded: boolean, tail = false): string {
  return previewLineArray(lines, expanded, tail ? BASH_TAIL_LINES : PREVIEW_LINES, tail)
    .map((line, index) => {
      if (line.startsWith("… +")) return theme.fg("dim", `    ${line}`);
      const prefix = index === 0 ? "  └ " : "    ";
      return theme.fg("dim", `${prefix}${highlightGitLine(line, theme)}`);
    })
    .join("\n");
}

function outputDisplay(output: string, theme: any, expanded: boolean, tail = false): string {
  return outputDisplayLines(outputLines(output), theme, expanded, tail);
}

function parseResult(raw: string, isError: boolean) {
  const exit = raw.match(
    /(?:^|\n)\s*(?:(?:command|process)\s+)?(?:exit code|exit status|exited with code|exited with exit code)\s*:?\s*(-?\d+)\s*$/i,
  );
  const exitCode = exit ? Number(exit[1]) : isError ? 1 : 0;
  const output = (exit ? raw.slice(0, exit.index) : raw)
    .replace(/\n?Command completed successfully\.?$/i, "")
    .trimEnd();
  return { output, outputLines: outputLines(output), exitCode };
}

function bashResult(result: any, options: any, theme: any, context: any): Text {
  const state = stateOf(context);
  const raw = resultText(result).trimEnd();
  if (state.parsedRaw !== raw || state.parsedError !== context?.isError) {
    state.parsedRaw = raw;
    state.parsedError = context?.isError;
    state.parsed = parseResult(raw, context?.isError === true);
    state.outputText = undefined;
  }
  const parsed = state.parsed ?? parseResult(raw, context?.isError === true);
  if (options.isPartial) {
    const running = theme.fg("dim", "  └ Running…");
    const content = parsed.output
      ? `${running}\n${outputDisplayLines(parsed.outputLines, theme, false, true)}`
      : running;
    return textComponent(content, context);
  }

  state.done = true;
  state.error = parsed.exitCode !== 0;
  state.exitCode = parsed.exitCode;
  if (!parsed.output) return textComponent("", context);

  if (state.outputText === undefined || state.outputTheme !== theme || state.outputExpanded !== options.expanded) {
    state.outputTheme = theme;
    state.outputExpanded = options.expanded;
    state.outputText = outputDisplayLines(parsed.outputLines, theme, options.expanded, true);
  }
  return textComponent(state.outputText, context);
}

function groupLabel(group: ToolGroup): string {
  if (group.label !== undefined) return group.label;

  const items = groupItems(group);
  const paths = items.map((item) => item.path);

  switch (group.kind) {
    case "read":
      group.label = `Read ${paths.join(" ")}`;
      break;
    case "grep":
      group.label = `Search ${items.map((item) => `/${item.args?.pattern || ""}/ in ${item.path}`).join(" ")}`;
      break;
    case "find":
      group.label = `Find ${items.map((item) => `${item.args?.pattern || "*"} in ${item.path}`).join(" ")}`;
      break;
    case "ls":
      group.label = `List ${paths.join(" ")}`;
      break;
    case "write":
      group.label = `Wrote ${paths.join(" ")}`;
      break;
    case "edit":
      group.label = `Edited ${paths.join(" ")}`;
      break;
  }
  return group.label ?? "";
}

function groupOutput(group: ToolGroup): string {
  if (group.output?.version === group.version) return group.output.text;

  const parts: string[] = [];
  for (const item of group.items.values()) {
    if (item.displayOutput) parts.push(item.displayOutput);
  }
  const text = parts.join("\n");
  group.output = { version: group.version, text };
  return text;
}

function diffPreview(group: ToolGroup, maxLines: number): { totalLines: number; lines: string[] } {
  const cache = group.diffPreview;
  if (cache && cache.version === group.version && cache.maxLines === maxLines) return cache;

  const lines: string[] = [];
  let totalLines = 0;
  for (const entry of group.items.values()) {
    for (const line of entry.diffLines ?? []) {
      totalLines++;
      if (lines.length < maxLines) lines.push(line);
    }
  }
  group.diffPreview = { version: group.version, maxLines, totalLines, lines };
  return group.diffPreview;
}

function explorationCall(name: string, args: any, theme: any, context: any): Text {
  const { group, first } = toolGroup(name, args, context);
  if (!first) return textComponent("", context);

  const state = stateOf(context);
  const label = verb(state, "Exploring", "Explored");
  const line = `${theme.fg("dim", "  └ ")}${theme.fg("accent", groupLabel(group))}`;
  return textComponent(`${marker(theme, state)} ${theme.bold(label)}\n${line}`, context);
}

function explorationResult(name: string, result: any, options: any, theme: any, context: any): Text {
  const { group, item, first } = toolGroup(name, context?.args, context);
  updateGroupItem(group, item, result, context?.isError === true, !options.isPartial);
  if (!first) return textComponent("", context);

  const state = stateOf(context);
  state.done = groupComplete(group);
  state.error = groupHasError(group);
  state.exitCode = state.error ? 1 : 0;

  if (options.isPartial || !groupComplete(group)) {
    return textComponent(theme.fg("dim", "  └ Running…"), context);
  }

  const output = groupOutput(group);
  if (state.error) {
    const text = cachedGroupText(group, "error", options.expanded, theme, () =>
      theme.fg("error", outputDisplay(output || "failed", theme, options.expanded)),
    );
    return textComponent(text, context);
  }
  if (!output) return textComponent("", context);
  if (name === "read") {
    const text = cachedGroupText(group, "read", options.expanded, theme, () =>
      readPreviewDisplay(group, theme, options.expanded),
    );
    return textComponent(text, context);
  }
  if (name === "grep") {
    const text = cachedGroupText(group, "grep", options.expanded, theme, () =>
      textOutputDisplay(output, theme, options.expanded),
    );
    return textComponent(text, context);
  }
  if (!options.expanded) return textComponent("", context);
  const text = cachedGroupText(group, name, true, theme, () => outputDisplay(output, theme, true));
  return textComponent(text, context);
}

function groupPathLabel(group: ToolGroup): string {
  if (group.pathLabel !== undefined) return group.pathLabel;
  group.pathLabel = groupItems(group).map((item) => item.path).join(" ");
  return group.pathLabel;
}

function editCall(args: any, theme: any, context: any): Text {
  const { group, first } = toolGroup("edit", args, context);
  if (!first) return textComponent("", context);

  const state = stateOf(context);
  let text = `${marker(theme, state)} ${theme.bold(verb(state, "Editing", "Edited"))} ${theme.fg("accent", groupPathLabel(group))}`;
  let additions = 0;
  let removals = 0;
  for (const item of group.items.values()) {
    additions += item.additions || 0;
    removals += item.removals || 0;
  }
  if (state.additions !== undefined || additions || removals) {
    text += ` ${theme.fg("toolDiffAdded", `+${additions}`)}${theme.fg("dim", " /")} ${theme.fg("toolDiffRemoved", `-${removals}`)}`;
  }
  return textComponent(text, context);
}

function editResult(result: any, options: any, theme: any, context: any): Text {
  const { group, item, first } = toolGroup("edit", context?.args, context);
  const output = resultText(result);
  updateGroupItem(
    group,
    item,
    result,
    context?.isError === true || output.startsWith("Error"),
    !options.isPartial,
  );

  const diff = typeof result?.details?.diff === "string" ? result.details.diff : "";
  if (item.diff !== diff) {
    item.diff = diff;
    const diffLines = diff ? diff.split("\n") : [];
    item.diffLines = diffLines;
    item.additions = 0;
    item.removals = 0;
    for (const line of diffLines) {
      if (line.startsWith("+") && !line.startsWith("+++")) item.additions++;
      if (line.startsWith("-") && !line.startsWith("---")) item.removals++;
    }
    invalidateGroup(group);
  }
  if (!first) return textComponent("", context);

  const state = stateOf(context);
  state.done = groupComplete(group);
  state.error = false;
  state.additions = 0;
  state.removals = 0;
  for (const entry of group.items.values()) {
    state.error ||= entry.error === true;
    state.additions += entry.additions || 0;
    state.removals += entry.removals || 0;
  }

  if (options.isPartial || !groupComplete(group)) {
    return textComponent(theme.fg("dim", "  └ Running…"), context);
  }
  if (state.error && options.expanded) {
    const text = cachedGroupText(group, "edit-error", true, theme, () =>
      theme.fg("error", groupOutput(group)),
    );
    return textComponent(text, context);
  }

  const maxLines = options.expanded ? 40 : SHORT_DIFF_LINES;
  const preview = diffPreview(group, maxLines);
  if (!preview.totalLines || (!options.expanded && preview.totalLines > SHORT_DIFF_LINES)) return textComponent("", context);

  const text = cachedGroupText(group, "edit", options.expanded, theme, () => preview.lines
    .map((line) => {
      const color = line.startsWith("+")
        ? "toolDiffAdded"
        : line.startsWith("-")
          ? "toolDiffRemoved"
          : "toolDiffContext";
      return theme.fg(color, `    ${line}`);
    })
    .join("\n"));
  return textComponent(text, context);
}


function writeCall(args: any, theme: any, context: any): Text {
  const { group, first } = toolGroup("write", args, context);
  if (!first) return textComponent("", context);

  const state = stateOf(context);
  return textComponent(
    `${marker(theme, state)} ${theme.bold(verb(state, "Writing", "Wrote"))} ${theme.fg("accent", groupPathLabel(group))}`,
    context,
  );
}

function writeResult(result: any, options: any, theme: any, context: any): Text {
  const { group, item, first } = toolGroup("write", context?.args, context);
  updateGroupItem(
    group,
    item,
    result,
    context?.isError === true || resultText(result).startsWith("Error"),
    !options.isPartial,
  );
  if (!first) return textComponent("", context);

  const state = stateOf(context);
  state.done = groupComplete(group);
  state.error = groupHasError(group);
  if (state.error && options.expanded) {
    const text = cachedGroupText(group, "write-error", true, theme, () =>
      theme.fg("error", groupOutput(group)),
    );
    return textComponent(text, context);
  }
  return textComponent("", context);
}


function override(pi: ExtensionAPI, name: string, create: any, renderCall: any, renderResult: any) {
  const initialCwd = process.cwd();
  const initial = create(initialCwd);
  let cachedCwd = initialCwd;
  let cachedTool = initial;
  pi.registerTool({
    ...initial,
    name,
    renderShell: "self",
    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      if (ctx.cwd !== cachedCwd) {
        cachedCwd = ctx.cwd;
        cachedTool = create(cachedCwd);
      }
      return cachedTool.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall,
    renderResult,
  });
}

export default function codexStyle(pi: ExtensionAPI) {
  pi.on("tool_result", (event) => {
    if (event.isError) return;

    const content = compactSearchResult(event.toolName, event.content);
    if (!content) return;

    return {
      content,
      details: event.details,
      isError: event.isError,
      usage: event.usage,
    };
  });

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
      : { kind, items: new Map<string, GroupItem>(), version: 0 };
    groupItem(group, event.toolCallId, event.args);
    rememberGroup(event.toolCallId, group);
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
