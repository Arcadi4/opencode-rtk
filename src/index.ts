import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { createRequire } from "node:module";
import * as path from "node:path";
import { parse as parseBash } from "unbash";
import { Language, Parser, type Node as TreeSitterNode } from "web-tree-sitter";

type UserShell = "bash" | "zsh" | "powershell";
type CommandEdit = { start: number; end: number };
type BashAstObject = Record<string, unknown> & { type: string };
type CommandWord = { text: string; pos: number; end: number; parts?: unknown[] };

const require = createRequire(import.meta.url);
const webTreeSitterWasmPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
const pwshWasmPath = require.resolve("tree-sitter-pwsh/tree-sitter-powershell.wasm");

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
    const rtkInstalled = await input.$`which rtk`.text() !== '' && (await input.$`rtk --version`.text()).startsWith("rtk");
    if (!rtkInstalled) {
        input.client.app.log({
            body: {
                service: "rtk",
                level: "warn",
                message: "rtk is not installed; skipping plugin."
            }
        })
        return {};
    }

    input.client.app.log({
        body: {
            service: "rtk",
            level: "info",
            message: "loading plugin."
        }
    })

    const proxiedCommands: string[] = await getProxiedCommands(input.$);
    if (proxiedCommands.length === 0) {
        input.client.app.log({
            body: {
                service: "rtk",
                level: "warn",
                message: "cannot parse rtk commands; skipping plugin."
            }
        })
        return {};
    }

    let shell: UserShell = await getUserShell();
    const commands = new Set(proxiedCommands);

    input.client.app.log({
        body: {
            service: "rtk",
            level: "info",
            message: `proxied commands: ${[...commands].join(", ")}; user shell: ${shell}.`
        }
    })

    return {
        "tool.execute.before": async (input, output) => {
            if (input.tool !== "bash") { return }
            const original = output.args.command;
            const transformed = await proxyCommand(original, commands, shell);
            if (transformed !== original) {
                output.args.command = transformed;
            }
        }
    }
}


export default plugin;

async function getProxiedCommands(shell: PluginInput["$"]): Promise<string[]> {
    const proxiedCommands: string[] = [];
    const helpText = await shell`rtk --help`.text();
    const commandsSection = helpText.split("Commands:")[1]?.split("Options:")[0];
    if (!commandsSection) return proxiedCommands;

    commandsSection.split("\n").map((line: string) => line.trim()).filter((line: string) => line).forEach((line: string) => {
        const command = line.split(" ")[0];
        if (command) {
            proxiedCommands.push(command);
        }
    });
    return proxiedCommands;
}

async function getUserShell(): Promise<UserShell> {
    if (!process.env.SHELL) {
        const platform = process.platform;
        if (platform === "win32") {
            return "powershell";
        } else if (platform === "darwin") {
            return "zsh";
        } else if (platform === "linux") {
            return "bash";
        } else {
            throw new Error("Cannot infer user shell from platform: " + platform);
        }
    }

    const shellPath = process.env.SHELL;
    if (path.basename(shellPath) === "bash") {
        return "bash";
    } else if (path.basename(shellPath) === "zsh") {
        return "zsh";
    } else if (path.basename(shellPath).toLowerCase().includes("powershell")) {
        return "powershell";
    }

    throw new Error("Unable to determine user shell");
}

let webTreeSitterInit: Promise<void> | null = null;
let pwshParser: Promise<Parser> | null = null;

function initWebTreeSitter(): Promise<void> {
    if (!webTreeSitterInit) {
        webTreeSitterInit = Parser.init({
            locateFile: (scriptName: string): string => scriptName === "web-tree-sitter.wasm" ? webTreeSitterWasmPath : scriptName,
        });
    }

    return webTreeSitterInit;
}

function getPwshParser(): Promise<Parser> {
    if (!pwshParser) {
        pwshParser = (async (): Promise<Parser> => {
            await initWebTreeSitter();
            const parser = new Parser();
            const language = await Language.load(pwshWasmPath);
            parser.setLanguage(language);
            return parser;
        })();
    }

    return pwshParser;
}

export async function proxyCommand(
    command: string,
    proxiedCommands: ReadonlySet<string>,
    shell: "bash" | "zsh" | "powershell",
): Promise<string> {
    if (!command || !command.trim()) return command;

    if (shell === "powershell") {
        return proxyPowerShellCommand(command, proxiedCommands);
    }

    return proxyBashCommand(command, proxiedCommands);
}

function proxyBashCommand(command: string, proxiedCommands: ReadonlySet<string>): string {
    let ast: unknown;
    try {
        ast = parseBash(command);
    } catch {
        return command;
    }

    const edits: CommandEdit[] = [];
    visitBashAst(ast, (node, baseOffset) => {
        if (node.type !== "Command") return;
        const name = node.name;
        if (!isCommandWord(name)) return;
        addCommandEdit(edits, name.text.trim(), baseOffset + name.pos, baseOffset + name.end, proxiedCommands);
    });

    return applyCommandEdits(command, edits);
}

async function proxyPowerShellCommand(command: string, proxiedCommands: ReadonlySet<string>): Promise<string> {
    let parser: Parser;
    try {
        parser = await getPwshParser();
    } catch {
        webTreeSitterInit = null;
        pwshParser = null;
        return command;
    }

    let tree;
    try {
        tree = parser.parse(command);
    } catch {
        return command;
    }

    if (!tree) return command;

    const edits = collectPowerShellCommandEdits(tree.rootNode, proxiedCommands);
    return applyCommandEdits(command, edits);
}

function collectPowerShellCommandEdits(root: TreeSitterNode, proxiedCommands: ReadonlySet<string>): CommandEdit[] {
    const edits: CommandEdit[] = [];

    for (const node of root.descendantsOfType("command_name")) {
        addCommandEdit(edits, node.text.trim(), node.startIndex, node.endIndex, proxiedCommands);
    }

    return edits;
}

function visitBashAst(value: unknown, visit: (node: BashAstObject, baseOffset: number) => void, baseOffset = 0, seen = new WeakSet<object>()): void {
    if (!isObject(value) || seen.has(value)) return;
    seen.add(value);

    if (isBashAstObject(value)) {
        visit(value, baseOffset);
    }

    const script = value.script;
    if (isObject(script)) {
        visitBashAst(script, visit, getNestedScriptBase(value, baseOffset), seen);
    }

    if (isCommandWord(value) && Array.isArray(value.parts)) {
        visitBashWordParts(value, visit, baseOffset, seen);
    }

    for (const [key, child] of Object.entries(value)) {
        if (key === "script" || key === "parts") continue;
        if (Array.isArray(child)) {
            for (const item of child) {
                visitBashAst(item, visit, baseOffset, seen);
            }
        } else {
            visitBashAst(child, visit, baseOffset, seen);
        }
    }
}

function visitBashWordParts(word: CommandWord, visit: (node: BashAstObject, baseOffset: number) => void, baseOffset: number, seen: WeakSet<object>): void {
    let searchStart = 0;

    for (const part of word.parts ?? []) {
        if (!isObject(part) || typeof part.text !== "string") continue;

        const partStart = word.text.indexOf(part.text, searchStart);
        const partBaseOffset = baseOffset + word.pos + Math.max(partStart, 0);
        if (partStart >= 0) {
            searchStart = partStart + part.text.length;
        }

        visitBashAst(part, visit, partBaseOffset, seen);
    }
}

function getNestedScriptBase(part: Record<string, unknown>, partBaseOffset: number): number {
    if (typeof part.text !== "string") return partBaseOffset;
    if (typeof part.inner === "string") {
        const innerStart = part.text.indexOf(part.inner);
        if (innerStart >= 0) return partBaseOffset + innerStart;
    }

    if (part.text.startsWith("$(") || part.text.startsWith("<(") || part.text.startsWith(">(")) return partBaseOffset + 2;
    if (part.text.startsWith("`")) return partBaseOffset + 1;
    if (part.text.startsWith("${")) return partBaseOffset + 2;

    return partBaseOffset;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isBashAstObject(value: unknown): value is BashAstObject {
    return isObject(value) && typeof value.type === "string";
}

function isCommandWord(value: unknown): value is CommandWord {
    return isObject(value) && typeof value.text === "string" && typeof value.pos === "number" && typeof value.end === "number";
}

function addCommandEdit(
    edits: CommandEdit[],
    commandName: string,
    start: number,
    end: number,
    proxiedCommands: ReadonlySet<string>,
): void {
    if (commandName === "rtk" || !proxiedCommands.has(commandName) || start < 0 || end <= start) return;
    edits.push({ start, end });
}

function applyCommandEdits(command: string, edits: CommandEdit[]): string {
    if (edits.length === 0) return command;

    edits.sort((a, b) => b.start - a.start);

    let result = command;
    for (const { start, end } of edits) {
        const before = result.slice(0, start);
        const cmdName = result.slice(start, end);
        const after = result.slice(end);
        result = `${before}rtk ${cmdName}${after}`;
    }

    return result;
}
