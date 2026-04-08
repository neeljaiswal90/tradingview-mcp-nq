/**
 * CLI command router using node:util parseArgs.
 * Zero dependencies — uses only Node.js built-ins.
 */
import { parseArgs } from 'node:util';

export interface SubcommandConfig {
  description: string;
  options?: Record<string, unknown>;
  handler: (values: Record<string, unknown>, positionals: string[]) => Promise<unknown>;
}

export interface CommandConfig {
  description: string;
  options?: Record<string, unknown>;
  handler?: (values: Record<string, unknown>, positionals: string[]) => Promise<unknown>;
  subcommands?: Map<string, SubcommandConfig>;
}

const commands: Map<string, CommandConfig> = new Map();

export function register(name: string, config: CommandConfig): void {
  commands.set(name, config);
}

function printHelp(): void {
  console.log('Usage: tv <command> [options]\n');
  console.log('Commands:');
  const maxLen = Math.max(...[...commands.keys()].map(k => k.length));
  for (const [name, cmd] of commands) {
    if (cmd.subcommands) {
      const subs = [...cmd.subcommands.keys()].join(', ');
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}  [${subs}]`);
    } else {
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}`);
    }
  }
  console.log('\nRun "tv <command> --help" for command-specific options.');
  console.log('\nDISCLAIMER');
  console.log('  Not affiliated with TradingView Inc. or Anthropic, PBC.');
  console.log('  Use subject to TradingView\'s Terms of Use: tradingview.com/policies');
}

function printCommandHelp(name: string, cmd: CommandConfig): void {
  if (cmd.subcommands) {
    console.log(`Usage: tv ${name} <subcommand> [options]\n`);
    console.log('Subcommands:');
    for (const [sub, subConf] of cmd.subcommands) {
      console.log(`  ${sub.padEnd(12)}${subConf.description}`);
    }
  } else {
    console.log(`Usage: tv ${name} [options]\n`);
    console.log(cmd.description);
  }
  const opts = (cmd.options || {}) as Record<string, { type: string; short?: string; description?: string }>;
  if (Object.keys(opts).length > 0) {
    console.log('\nOptions:');
    for (const [k, v] of Object.entries(opts)) {
      const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
      console.log(`  ${flag.padEnd(20)}${v.description || ''}`);
    }
  }
}

export async function run(argv: string[]): Promise<void> {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const cmdName = args[0]!;
  const cmd = commands.get(cmdName);

  if (!cmd) {
    console.error(`Unknown command: ${cmdName}`);
    console.error('Run "tv --help" for a list of commands.');
    process.exit(1);
  }

  let handler: ((values: Record<string, unknown>, positionals: string[]) => Promise<unknown>) | undefined;
  let options: Record<string, unknown>;

  if (cmd.subcommands) {
    const subName = args[1] as string | undefined;
    if (!subName || subName === '--help' || subName === '-h') {
      printCommandHelp(cmdName!, cmd);
      process.exit(0);
    }
    const sub = cmd.subcommands.get(subName!);
    if (!sub) {
      console.error(`Unknown subcommand: ${cmdName} ${subName!}`);
      printCommandHelp(cmdName!, cmd);
      process.exit(1);
    }
    handler = sub.handler;
    options = sub.options || {};
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(2),
        options: { help: { type: 'boolean', short: 'h' }, ...options } as Record<string, { type: 'string' | 'boolean'; short?: string }>,
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        console.log(`Usage: tv ${cmdName} ${subName} [options]\n`);
        console.log(sub.description);
        if (Object.keys(options).length > 0) {
          console.log('\nOptions:');
          for (const [k, v] of Object.entries(options) as [string, { type: string; short?: string; description?: string }][]) {
            const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
            console.log(`  ${flag.padEnd(20)}${v.description || ''}`);
          }
        }
        process.exit(0);
      }
      await execute(handler, values as Record<string, unknown>, positionals);
    } catch (err) {
      handleError(err);
    }
  } else {
    handler = cmd.handler;
    options = cmd.options || {};
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: { help: { type: 'boolean', short: 'h' }, ...options } as Record<string, { type: 'string' | 'boolean'; short?: string }>,
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        printCommandHelp(cmdName, cmd);
        process.exit(0);
      }
      await execute(handler!, values as Record<string, unknown>, positionals);
    } catch (err) {
      handleError(err);
    }
  }
}

async function execute(
  handler: (values: Record<string, unknown>, positionals: string[]) => Promise<unknown>,
  values: Record<string, unknown>,
  positionals: string[],
): Promise<void> {
  try {
    const result = await handler(values, positionals);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}

function handleError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/CDP|connection|ECONNREFUSED|not running/i.test(message)) {
    console.error(JSON.stringify({ success: false, error: message }, null, 2));
    process.exit(2);
  }
  console.error(JSON.stringify({ success: false, error: message }, null, 2));
  process.exit(1);
}
