/**
 * Network guard shared by the policy engine and the egress proxy.
 *
 * "Any public website" (the "*" site pattern) never covers private, loopback or link-local networks, and
 * TaskLatch's own controller is never reachable from an agent desktop, whatever the operator lists.
 */
import net from 'node:net';
import { PORTS } from '../../packages/contracts/runtime.ts';

const LOCAL_NAMES = /^(localhost|host\.docker\.internal|gateway\.docker\.internal|metadata\.google\.internal)$|\.(localhost|local|internal|lan|home\.arpa)$/i;

/** True for IP literals in private, loopback, link-local, CGNAT or unspecified ranges. */
export function isPrivateIp(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(v)) {
    if (v === '::1' || v === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(v);
  }
  return false;
}

/** True when a hostname is a private address literal or a local-only name. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  return isPrivateIp(h) || LOCAL_NAMES.test(h);
}

/** The controller (operator UI and API) is never a destination for agents. */
export function isControllerAddress(hostname: string, port: number): boolean {
  return port === PORTS.controller && isPrivateHost(hostname);
}
