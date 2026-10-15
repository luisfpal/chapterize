/** A problem the reader can act on. The message says what happened and what to do. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}
