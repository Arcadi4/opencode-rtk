import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";
import Pwsh from "tree-sitter-pwsh";
const path = require("path");

type UserShell = "bash" | "zsh" | "powershell";

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

    let shell: UserShell = await determineUserShell();
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
            const transformed = transformCommand(original, commands, shell);
            if (transformed !== original) {
                output.args.command = transformed;
            }
        }
    }
}


export default plugin;

async function getProxiedCommands(shell: any): Promise<string[]> {
    const proxiedCommands: string[] = [];
    const helpText = await shell`rtk --help`.text();
    helpText.split("Commands:")[1].split("Options:")[0].split("\n").map((line: string) => line.trim()).filter((line: string) => line).forEach((line: string) => {
        const command = line.split(" ")[0];
        if (command) {
            proxiedCommands.push(command);
        }
    });
    return proxiedCommands;
}

async function determineUserShell(): Promise<UserShell> {
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

let bashParser: Parser | null = null;
let pwshParser: Parser | null = null;

function getBashParser(): Parser {
    if (!bashParser) {
        bashParser = new Parser();
        bashParser.setLanguage(Bash);
    }
    return bashParser;
}

function getPwshParser(): Parser {
    if (!pwshParser) {
        pwshParser = new Parser();
        pwshParser.setLanguage(Pwsh);
    }
    return pwshParser;
}

export function transformCommand(
    command: string,
    proxiedCommands: ReadonlySet<string>,
    shell: "bash" | "zsh" | "powershell",
): string {
    if (!command || !command.trim()) return command;

    const parser = shell === "powershell" ? getPwshParser() : getBashParser();

    let tree;
    try {
        tree = parser.parse(command);
    } catch {
        return command;
    }

    if (!tree) return command;

    const root = tree.rootNode;
    const commandNames = root.descendantsOfType("command_name");

    if (commandNames.length === 0) return command;

    const edits: Array<{ start: number; end: number }> = [];

    for (const node of commandNames) {
        const name = node.text.trim();
        if (name === "rtk" || !proxiedCommands.has(name)) continue;
        edits.push({ start: node.startIndex, end: node.endIndex });
    }

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
