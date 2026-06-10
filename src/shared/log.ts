/**
 * Logging that routes to @actions/core annotations inside the Action and to
 * stderr in the CLI (stdout stays clean for the dry-run review output).
 */

type Sink = {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
  setSecret(value: string): void;
};

let sink: Sink = {
  info: (m) => process.stderr.write(`${m}\n`),
  warn: (m) => process.stderr.write(`[warn] ${m}\n`),
  debug: (m) => {
    if (process.env.RECENSIO_DEBUG) process.stderr.write(`[debug] ${m}\n`);
  },
  setSecret: () => {},
};

export function useActionsSink(core: {
  info(msg: string): void;
  warning(msg: string): void;
  debug(msg: string): void;
  setSecret(value: string): void;
}): void {
  sink = {
    info: (m) => core.info(m),
    warn: (m) => core.warning(m),
    debug: (m) => core.debug(m),
    setSecret: (v) => core.setSecret(v),
  };
}

export const log = {
  info: (msg: string) => sink.info(msg),
  warn: (msg: string) => sink.warn(msg),
  debug: (msg: string) => sink.debug(msg),
  setSecret: (value: string) => sink.setSecret(value),
};
