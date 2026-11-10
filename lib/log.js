// Structured logger with secret redaction. JSON lines in production (LOG_FORMAT=json), readable text otherwise.
// Anything under a key that looks secret is replaced before it is written, so a stray `log.error('x', { headers })`
// cannot leak a token, password, signature or API key into your log pipeline.
const SECRET_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|^key$|signature|credential|cookie|refresh/i;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function redact(value, depth = 0) {
  if (value == null || typeof value !== 'object') return value;
  if (depth > 6) return '[deep]';
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && v != null && v !== '' ? '[redacted]' : redact(v, depth + 1);
  return out;
}

export function createLogger({ level = process.env.LOG_LEVEL || 'info', format = process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'text'), out = (line, lvl) => (lvl === 'error' || lvl === 'warn' ? console.error(line) : console.log(line)), fields = {} } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  function write(lvl, msg, ...rest) {
    if (LEVELS[lvl] < min) return;
    const extra = {};
    for (const r of rest) {
      if (r instanceof Error) extra.err = r.message;
      else if (r && typeof r === 'object') Object.assign(extra, redact(r));
      else if (r !== undefined) extra.detail = extra.detail ? `${extra.detail} ${r}` : String(r);
    }
    const rec = { ts: new Date().toISOString(), level: lvl, msg: String(msg), ...fields, ...extra };
    if (format === 'json') return out(JSON.stringify(rec), lvl);
    const { ts, level: _l, msg: m, ...meta } = rec;
    out(`${ts} ${lvl.toUpperCase().padEnd(5)} ${m}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}`, lvl);
  }
  return {
    debug: (m, ...r) => write('debug', m, ...r), info: (m, ...r) => write('info', m, ...r),
    warn: (m, ...r) => write('warn', m, ...r), error: (m, ...r) => write('error', m, ...r),
    child: (extra) => createLogger({ level, format, out, fields: { ...fields, ...extra } })
  };
}

export const log = createLogger();
