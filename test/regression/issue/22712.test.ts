import { afterAll, beforeAll, expect, test } from "bun:test";
import dgram from "node:dgram";
import dns from "node:dns";
import { once } from "node:events";

let ohosResolver: dns.Resolver | undefined;
let ohosPromiseResolver: dns.promises.Resolver | undefined;
let ohosDnsSocket: dgram.Socket | undefined;

beforeAll(async () => {
  if (process.platform !== "openharmony") return;
  const socket = dgram.createSocket("udp4");
  socket.on("message", (query, rinfo) => {
    let off = 12;
    while (query[off] !== 0) off += query[off] + 1;
    const qtype = query.readUInt16BE(off + 1);
    const question = query.subarray(12, off + 5);
    const rdata = qtype === 28
      ? Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
      : Buffer.from([192, 0, 2, 1]);
    const answer = Buffer.concat([
      Buffer.from([0xc0, 0x0c, qtype >> 8, qtype & 0xff, 0, 1, 0, 0, 0, 60, rdata.length >> 8, rdata.length & 0xff]),
      rdata,
    ]);
    const header = Buffer.from([query[0], query[1], 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
    socket.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address);
  });
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  const resolver = new dns.Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers(["127.0.0.1:" + socket.address().port]);
  const promiseResolver = new dns.promises.Resolver({ timeout: 1000, tries: 1 });
  promiseResolver.setServers(["127.0.0.1:" + socket.address().port]);
  ohosResolver = resolver;
  ohosPromiseResolver = promiseResolver;
  ohosDnsSocket = socket;
});

afterAll(() => {
  ohosDnsSocket?.close();
});

function resolverApi() {
  return ohosResolver ?? dns;
}

function promiseResolverApi() {
  return ohosPromiseResolver ?? dns.promises;
}

test("dns.resolve callback parameters match Node.js", done => {
  resolverApi().resolve("dns.google", (...args) => {
    // Should receive exactly 2 parameters: error and addresses array
    expect(args.length).toBe(2);
    expect(args[0]).toBe(null); // no error
    expect(Array.isArray(args[1])).toBe(true); // addresses should be array
    expect(args[1].every((addr: any) => typeof addr === "string")).toBe(true); // each address should be string
    done();
  });
});

test("dns.resolve with A record type callback parameters", done => {
  resolverApi().resolve("dns.google", "A", (...args) => {
    expect(args.length).toBe(2);
    expect(args[0]).toBe(null);
    expect(Array.isArray(args[1])).toBe(true);
    expect(args[1].every((addr: any) => typeof addr === "string")).toBe(true);
    done();
  });
});

test("dns.resolve with AAAA record type callback parameters", done => {
  // Use a hostname that has AAAA records
  resolverApi().resolve("google.com", "AAAA", (...args) => {
    expect(args.length).toBe(2);
    expect(args[0]).toBe(null);
    expect(Array.isArray(args[1])).toBe(true);
    expect(args[1].every((addr: any) => typeof addr === "string")).toBe(true);
    done();
  });
});

test("dns.promises.resolve returns array of strings", async () => {
  const result = await promiseResolverApi().resolve("dns.google");
  expect(Array.isArray(result)).toBe(true);
  expect(result.every((addr: any) => typeof addr === "string")).toBe(true);
});

test("dns.promises.resolve with A record returns array of strings", async () => {
  const result = await promiseResolverApi().resolve("dns.google", "A");
  expect(Array.isArray(result)).toBe(true);
  expect(result.every((addr: any) => typeof addr === "string")).toBe(true);
});

test("dns.promises.resolve with AAAA record returns array of strings", async () => {
  const result = await promiseResolverApi().resolve("google.com", "AAAA");
  expect(Array.isArray(result)).toBe(true);
  expect(result.every((addr: any) => typeof addr === "string")).toBe(true);
});
