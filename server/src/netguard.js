// Runtime netguard: zero real outbound by default. Every non-loopback socket, DNS lookup, fetch and UDP send is refused and recorded.
// The ONLY exception is an exact host allow-list (setAllowed) that the app fills in Real mode from the owner's settings:
// the PingOne API hosts (read-only pull) and the one configured Elasticsearch host (forwarding). Mock mode empties the list,
// so in Mock a non-loopback attempt is refused no matter what the code tries. UDP is never allowed to leave.
import dns from 'node:dns';
import net from 'node:net';
import dgram from 'node:dgram';
import { isLoopbackHost } from './safety.js';

let active = null;
export const getNetguard = () => active;

export function installNetguard() {
  if (active) return active;
  const attempts = [];
  const allowed = new Set();
  const permitted = (h) => isLoopbackHost(h) || allowed.has(String(h).toLowerCase());
  const real = {
    connect: net.Socket.prototype.connect, lookup: dns.lookup, fetch: globalThis.fetch, send: dgram.Socket.prototype.send,
    plookup: dns.promises.lookup,
  };
  // Every resolver entry point that can reach a real name server: dns.resolve*, dns.promises.resolve*, and Resolver instances.
  const RESOLVERS = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'];
  const savedResolvers = [];
  const blockedResolver = (label, name, target) => function guardedResolve(host, ...rest) {
    const h = String(host);
    if (permitted(h)) return target.apply(this, [host, ...rest]);
    attempts.push(`dns:${h}`);
    const err = new Error(`network blocked: ${h}`);
    const cb = rest.find((r) => typeof r === 'function');
    if (label === 'cb') { if (cb) return cb(err); throw err; }
    return Promise.reject(err);
  };
  for (const [label, holder] of [['cb', dns], ['promise', dns.promises], ['cb', dns.Resolver.prototype], ['promise', dns.promises.Resolver.prototype]]) {
    for (const name of RESOLVERS) {
      if (typeof holder[name] !== 'function') continue;
      const orig = holder[name];
      savedResolvers.push([holder, name, orig]);
      holder[name] = blockedResolver(label, name, orig);
    }
  }
  const hostOf = (rawArgs) => {
    // Node's net.connect hands socket.connect() a normalized ARRAY [options, cb] as the first argument; unwrap it.
    const args = Array.isArray(rawArgs[0]) ? rawArgs[0] : rawArgs;
    const a = args[0];
    if (a && typeof a === 'object' && !Array.isArray(a)) return a.path ? 'unix-socket' : (a.host || 'localhost');
    if (typeof a === 'string' && Number.isNaN(Number(a))) return 'unix-socket';
    return typeof args[1] === 'string' ? args[1] : 'localhost';
  };
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const host = hostOf(args);
    if (!permitted(host)) { attempts.push(`socket:${host}`); throw new Error(`network blocked: ${host}`); }
    return real.connect.apply(this, args);
  };
  dns.lookup = function guardedLookup(host, ...rest) {
    // listen() resolves its bind address through lookup. A wildcard bind (the container's OBS_BIND=0.0.0.0) is not outbound,
    // and connecting to it is still refused by the socket guard above, so only the lookup is allowed.
    if (!permitted(host) && host !== '0.0.0.0' && host !== '::') {
      attempts.push(`dns:${host}`);
      const cb = rest.find((r) => typeof r === 'function');
      return cb?.(new Error(`network blocked: ${host}`));
    }
    return real.lookup.call(dns, host, ...rest);
  };
  dns.promises.lookup = async function guardedPromiseLookup(host, ...rest) {
    if (!permitted(host) && host !== '0.0.0.0' && host !== '::') { attempts.push(`dns:${host}`); throw new Error(`network blocked: ${host}`); }
    return real.plookup.call(dns.promises, host, ...rest);
  };
  globalThis.fetch = async function guardedFetch(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!permitted(url.hostname)) { attempts.push(`fetch:${url.hostname}`); throw new Error(`network blocked: ${url.hostname}`); }
    return real.fetch(input, init);
  };
  dgram.Socket.prototype.send = function guardedSend(...args) {
    // send(msg, [offset, length,] port [, address] [, cb]): the message is args[0] and is never the address.
    const rest = args.slice(1);
    const addr = typeof rest[1] === 'number' ? rest[3] : rest[1];
    // No address means Node's own loopback default (an unconnected socket); a non-string, non-function address is refused.
    const ok = addr === undefined || typeof addr === 'function' || (typeof addr === 'string' && isLoopbackHost(addr));
    if (!ok) { attempts.push(`udp:${addr}`); throw new Error(`network blocked: ${addr}`); }
    return real.send.apply(this, args);
  };
  active = {
    attempts,
    // Replace the allow-list. Only exact host names; loopback is always allowed and needs no entry.
    setAllowed(hosts = []) { allowed.clear(); for (const h of hosts) if (typeof h === 'string' && h) allowed.add(h.toLowerCase()); },
    allowedHosts: () => [...allowed],
    restore() {
      for (const [holder, name, orig] of savedResolvers) holder[name] = orig;
      dns.promises.lookup = real.plookup;
      net.Socket.prototype.connect = real.connect; dns.lookup = real.lookup; globalThis.fetch = real.fetch; dgram.Socket.prototype.send = real.send;
      active = null;
    },
  };
  return active;
}

// Proves the guard works by trying to leave and checking that every attempt is refused and recorded.
// Installs the guard if it is not already on. Returns { ok, blocked, detail }. Never touches the network: the guard throws first.
export async function netguardSelfTest() {
  const guard = installNetguard();
  const before = guard.attempts.length;
  const tried = [];
  const refused = async (label, fn) => { try { await fn(); tried.push(`${label}: NOT blocked`); } catch (e) { tried.push(/network blocked/.test(e.message) ? `${label}: blocked` : `${label}: failed differently (${e.message})`); } };
  await refused('fetch', () => fetch('http://self-test.invalid/', { signal: AbortSignal.timeout(2000) }));
  await refused('socket', () => new Promise((_, rej) => { const s = new net.Socket(); s.on('error', rej); try { s.connect(80, 'self-test.invalid'); } catch (e) { rej(e); } }));
  await refused('socket-ip', () => new Promise((_, rej) => { try { const s = net.connect({ host: ['192', '0', '2', '1'].join('.'), port: 80 }); s.on('error', rej); } catch (e) { rej(e); } }));
  await refused('dns', () => new Promise((res, rej) => dns.lookup('self-test.invalid', (e) => (e ? rej(e) : res()))));
  await refused('dns-resolve', () => dns.promises.resolve4('self-test.invalid'));
  await refused('udp', () => { const s = dgram.createSocket('udp4'); try { s.send('x', 9, 'self-test.invalid'); } finally { s.close(); } });
  const blocked = guard.attempts.length - before;
  guard.attempts.length = before; // self-test attempts are not real attempts
  return { ok: tried.every((t) => t.endsWith(': blocked')) && blocked === 6, blocked, detail: tried.join('; ') };
}
