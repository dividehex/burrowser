/** A failure to report to the user as a one-line message (never a stack trace). */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const usageError = (message: string) => new CliError(`${message}\nRun "burrowser --help" for usage.`, 2);
