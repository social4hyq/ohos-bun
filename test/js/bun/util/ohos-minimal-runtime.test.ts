import { expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("link preserves contents and reports existing or missing paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-minimal-link-"));
  try {
    const source = join(dir, "source");
    const dest = join(dir, "dest");
    writeFileSync(source, "contents");
    linkSync(source, dest);
    expect(readFileSync(dest, "utf8")).toBe("contents");
    expect(() => linkSync(source, dest)).toThrow();
    expect(() => linkSync(join(dir, "absent"), join(dir, "other"))).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("process.cwd reports a removed working directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-minimal-cwd-"));
  const cwd = join(dir, "child");
  mkdirSync(cwd);
  try {
    const proc = Bun.spawn([process.execPath, "-e", `
      const fs = require("node:fs");
      const dir = process.argv[1];
      process.chdir(dir);
      fs.rmdirSync(dir);
      try { process.cwd(); process.exit(2); }
      catch (e) { console.log(e.code); }
    `, cwd], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ out: out.trim(), err, code }).toEqual({ out: "ENOENT", err: "", code: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const payload = Buffer.alloc(4 * 1024 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
const digest = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
const reader = `
  const data = await Bun.stdin.arrayBuffer();
  console.log(data.byteLength + ":" + new Bun.CryptoHasher("sha256").update(data).digest("hex"));
`;

test("repeated stdin readiness preserves every byte", async () => {
  for (let round = 0; round < 12; round++) {
    await using proc = Bun.spawn([process.execPath, "-e", reader], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const output = proc.stdout.text();
    const errors = proc.stderr.text();
    for (let offset = 0; offset < payload.length; offset += 16381) {
      proc.stdin.write(payload.subarray(offset, offset + 16381));
      await proc.stdin.flush();
      if (offset % (16381 * 32) === 0) await Bun.sleep(1);
    }
    await proc.stdin.end();
    expect(await output).toBe(`${payload.length}:${digest}\n`);
    expect(await errors).toBe("");
    expect(await proc.exited).toBe(0);
  }
}, 60_000);

test("synchronous stdin read preserves every byte", () => {
  const proc = Bun.spawnSync([process.execPath, "-e", reader], { stdin: payload });
  expect(proc.stdout.toString()).toBe(`${payload.length}:${digest}\n`);
  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
});
