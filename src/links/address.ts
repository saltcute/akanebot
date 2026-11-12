import { BlockList, isIP } from "node:net";

/**
 * Every range that isn't the public internet: private networks, loopback, link-local (cloud metadata lives there), carrier NAT,
 * documentation, benchmarking, multicast and reserved space. The IPv6 forms that wrap an IPv4 address (mapped, NAT64, 6to4, Teredo)
 * are refused whole, since no ordinary site needs them and each could carry a private address inside.
 */
const NOT_PUBLIC_V4 = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const) {
    NOT_PUBLIC_V4.addSubnet(network, prefix, "ipv4");
}
/** Separate from the IPv4 list, because a BlockList also matches IPv4 addresses against IPv6 rules, and `::ffff:0:0/96` would catch them all. */
const NOT_PUBLIC_V6 = new BlockList();
for (const [network, prefix] of [
    ["::", 127],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
] as const) {
    NOT_PUBLIC_V6.addSubnet(network, prefix, "ipv6");
}

/** Whether an address is somewhere on the public internet. Anything that doesn't parse as an address isn't. */
export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 0) return false;
    return family === 4 ? !NOT_PUBLIC_V4.check(address, "ipv4") : !NOT_PUBLIC_V6.check(address, "ipv6");
}
