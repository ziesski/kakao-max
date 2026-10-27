// ----------------------------------------------------------------------------
// Typed protocol-level errors. Higher layers (packages/core) map these codes to
// their own error model; the protocol package stays dependency-free of them.
// ----------------------------------------------------------------------------

export type LocoErrorCode =
  | 'NOT_CONNECTED' // no live session (never opened, closed, or reconnecting)
  | 'CLOSED' //        the session closed while a request was in flight
  | 'TIMEOUT' //       no response within the deadline
  | 'UNREACHABLE' //   booking/checkin gave no reachable chat server
  | 'STATUS' //        the server answered with a non-zero status
  | 'AMBIGUOUS_WRITE' // a write may have succeeded; never retry automatically
  | 'MALFORMED' //     a frame or response did not have the expected shape
  | 'INVALID_ARGUMENT'; // the caller passed something the wire format cannot carry

export class LocoError extends Error {
  readonly code: LocoErrorCode;
  /** LOCO command involved, when known (e.g. "WRITE", "LOGINLIST"). */
  readonly command?: string;
  /** Server status for code STATUS. */
  readonly status?: number;

  constructor(code: LocoErrorCode, message: string, opts: { command?: string; status?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'LocoError';
    this.code = code;
    if (opts.command !== undefined) this.command = opts.command;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

export function isLocoError(e: unknown): e is LocoError {
  return e instanceof LocoError || (e instanceof Error && e.name === 'LocoError' && typeof (e as LocoError).code === 'string');
}
