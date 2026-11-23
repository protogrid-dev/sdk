/** Questions on the terminal: a yes or no, and a secret typed without echo. */
import { createInterface } from "node:readline";

export interface Prompter {
  /** Whether a person can answer (stdin is a terminal). */
  interactive: boolean;
  confirm(question: string): Promise<boolean>;
  secret(question: string): Promise<string>;
}

export function terminalPrompter(): Prompter {
  const interactive = !!process.stdin.isTTY;
  const ask = (question: string, hidden: boolean) =>
    new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      if (hidden) {
        // Print the question, then swallow what readline would echo of the typed value.
        const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
        out._writeToOutput = (s: string) => {
          if (s.includes(question)) out.output.write(question);
        };
      }
      rl.question(question, (answer) => {
        rl.close();
        if (hidden) process.stdout.write("\n");
        resolve(answer);
      });
    });
  return {
    interactive,
    confirm: async (q) => /^y(es)?$/i.test((await ask(`${q} [y/N] `, false)).trim()),
    secret: (q) => ask(q, true),
  };
}
