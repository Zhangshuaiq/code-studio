const { StringDecoder } = require('node:string_decoder');
// Only change child environments; never rewrite shell profiles or system locales.
function utf8ProcessEnvironment(input, platform = process.platform) {
  const env = { ...input };
  if (platform === 'win32') return env;
  // A bare "UTF-8" is accepted as LC_CTYPE on macOS, but is not a valid
  // LANG/LC_ALL locale. Copying it there makes the JVM fall back to ASCII.
  const isUtf8 = value => /^[a-z][a-z0-9_-]*\.utf-?8(?:@[\w.-]+)?$/i.test(value || '');
  const fallback = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isUtf8) || fallback;
  if (!isUtf8(env.LANG)) env.LANG = locale;
  if (!isUtf8(env.LC_CTYPE)) env.LC_CTYPE = locale;
  if (env.LC_ALL && !isUtf8(env.LC_ALL)) env.LC_ALL = locale;
  if (env.LC_MESSAGES && !isUtf8(env.LC_MESSAGES) && !['C', 'POSIX'].includes(env.LC_MESSAGES)) env.LC_MESSAGES = locale;
  return env;
}
function pipeUtf8Output(stream, append) {
  const decoder = new StringDecoder('utf8'); let ended = false;
  stream.on('data', chunk => { const text = typeof chunk === 'string' ? chunk : decoder.write(chunk); if (text) append(text); });
  const flush = () => { if (ended) return; ended = true; const text = decoder.end(); if (text) append(text); };
  stream.once('end', flush); stream.once('close', flush);
}
module.exports = { utf8ProcessEnvironment, pipeUtf8Output };
