import { networkInterfaces } from 'node:os';

/**
 * Addresses a phone on the same network can actually open.
 * Loopback is excluded: the phone is not this machine. Private ranges are
 * preferred over a public interface, which is usually the wrong one to print.
 */
export function lanIPv4(): string[] {
  const found: { ip: string; score: number }[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.internal) continue;
      const v4 = net.family === 'IPv4' || (net.family as unknown) === 4;
      if (!v4) continue;
      found.push({ ip: net.address, score: privateScore(net.address) });
    }
  }
  found.sort((a, b) => b.score - a.score || a.ip.localeCompare(b.ip));
  return found.map((item) => item.ip);
}

function privateScore(ip: string): number {
  if (ip.startsWith('192.168.')) return 3;
  if (ip.startsWith('10.')) return 2;
  const match = /^172\.(\d+)\./.exec(ip);
  if (match) {
    const n = Number(match[1]);
    if (n >= 16 && n <= 31) return 2;
  }
  return 1;
}

export function phoneUrls(host: string, port: number, token: string): { urls: string[]; reachable: boolean } {
  if (host !== '0.0.0.0' && host !== '::') {
    return { urls: [`http://${host}:${port}/${token}/`], reachable: host !== '127.0.0.1' && host !== 'localhost' };
  }
  const ips = lanIPv4();
  if (ips.length === 0) {
    return { urls: [`http://127.0.0.1:${port}/${token}/`], reachable: false };
  }
  return { urls: ips.map((ip) => `http://${ip}:${port}/${token}/`), reachable: true };
}
