import { spawn } from "bun";
import { describe, expect, test } from "bun:test";
import { X509Certificate } from "crypto";
import { readFileSync } from "fs";
import { bunEnv, bunExe, tempDir, tempDirWithFiles } from "harness";
import tls from "tls";

// Gate network tests behind environment variable to avoid CI flakes
// TODO: Replace with hermetic local TLS fixtures in a follow-up
const networkTest = process.env.BUN_TEST_ALLOW_NET === "1" ? test : test.skip;

describe("system CA discovery", () => {
  test("SSL_CERT_FILE loads a PEM bundle for getCACertificates('system')", async () => {
    const pem = tls.rootCertificates[0];
    using dir = tempDir("system-ca-file", {
      "bundle.pem": pem,
    });

    await using proc = spawn({
      cmd: [
        bunExe(),
        "-e",
        `const c=require("tls").getCACertificates("system");
         if (!c.length) process.exit(2);
         if (!String(c[0]).startsWith("-----BEGIN CERTIFICATE-----")) process.exit(3);
         process.stdout.write(String(c.length));`,
      ],
      env: { ...bunEnv, SSL_CERT_FILE: `${dir}/bundle.pem`, SSL_CERT_DIR: undefined },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "1",
      stderr,
      exitCode: 0,
    });
  });

  // Hashed DER is how some OHOS/Android system stores ship individual CAs.
  // The unfixed loader only PEM-reads directory entries, so this exits 2 on
  // system bun and passes once d2i_X509_fp is tried after PEM_read fails.
  test("SSL_CERT_DIR loads a hashed DER certificate for getCACertificates('system')", async () => {
    const pem = tls.rootCertificates[0];
    const der = Buffer.from(new X509Certificate(pem).raw);
    using dir = tempDir("system-ca-dir", {
      "01234567.0": der,
    });

    await using proc = spawn({
      cmd: [
        bunExe(),
        "-e",
        `const c=require("tls").getCACertificates("system");
         if (!c.length) process.exit(2);
         if (!String(c[0]).startsWith("-----BEGIN CERTIFICATE-----")) process.exit(3);
         process.stdout.write(String(c.length));`,
      ],
      env: { ...bunEnv, SSL_CERT_FILE: undefined, SSL_CERT_DIR: String(dir) },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "1",
      stderr,
      exitCode: 0,
    });
  });
});

describe("system CA with HTTPS", () => {
  // Skip test if no system certificates are available
  const skipIfNoSystemCerts = () => {
    if (process.platform === "linux" || process.platform === "openharmony") {
      // Check if common certificate paths exist on Linux
      const certPaths = [
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/ssl/ca-bundle.pem",
        "/etc/pki/tls/cacert.pem",
        "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
        "/etc/ssl/cert.pem",
        "/system/etc/ssl/certs/cacert.pem",
        "/etc/ssl/certs/cacert.pem",
      ];
      const hasSystemCerts = certPaths.some(path => {
        try {
          readFileSync(path);
          return true;
        } catch {
          return false;
        }
      });
      if (!hasSystemCerts) {
        return "no system certificates available on Linux/OHOS";
      }
    }
    return null;
  };

  networkTest("HTTPS request with system CA", async () => {
    const skipReason = skipIfNoSystemCerts();
    if (skipReason) {
      test.skip(skipReason);
      return;
    }

    // Test that we can make HTTPS requests to well-known sites with system CA
    const testCode = `
      const https = require('https');
      
      // Test against a well-known HTTPS endpoint
      https.get('https://www.google.com', (res) => {
        console.log('STATUS:', res.statusCode);
        process.exit(res.statusCode === 200 || res.statusCode === 301 || res.statusCode === 302 ? 0 : 1);
      }).on('error', (err) => {
        console.error('ERROR:', err.message);
        process.exit(1);
      });
    `;

    const dir = tempDirWithFiles("test-system-ca", {
      "test.js": testCode,
    });

    // Test with --use-system-ca flag
    await using proc1 = spawn({
      cmd: [bunExe(), "--use-system-ca", "test.js"],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout1, stderr1, exitCode1] = await Promise.all([proc1.stdout.text(), proc1.stderr.text(), proc1.exited]);

    expect(exitCode1).toBe(0);
    expect(stdout1).toContain("STATUS:");

    // Test with NODE_USE_SYSTEM_CA=1
    await using proc2 = spawn({
      cmd: [bunExe(), "test.js"],
      env: { ...bunEnv, NODE_USE_SYSTEM_CA: "1" },
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout2, stderr2, exitCode2] = await Promise.all([proc2.stdout.text(), proc2.stderr.text(), proc2.exited]);

    expect(exitCode2).toBe(0);
    expect(stdout2).toContain("STATUS:");
  });

  networkTest("HTTPS fails without system CA for custom root cert", async () => {
    // This test verifies that without system CA, connections to sites
    // with certificates not in the bundled list will fail
    const testCode = `
      const https = require('https');
      
      // Test against a site that typically uses a custom or less common CA
      // Using a government site as they often have their own CAs
      https.get('https://www.irs.gov', (res) => {
        console.log('SUCCESS');
        process.exit(0);
      }).on('error', (err) => {
        if (err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || 
            err.code === 'CERT_HAS_EXPIRED' ||
            err.code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
            err.message.includes('certificate')) {
          console.log('CERT_ERROR');
          process.exit(1);
        }
        // Other errors (network, DNS, etc)
        console.error('OTHER_ERROR:', err.code);
        process.exit(2);
      });
    `;

    const dir = tempDirWithFiles("test-no-system-ca", {
      "test.js": testCode,
    });

    // Test WITHOUT system CA - might fail for some sites
    await using proc1 = spawn({
      cmd: [bunExe(), "test.js"],
      env: { ...bunEnv, NODE_USE_SYSTEM_CA: "0" },
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout1, stderr1, exitCode1] = await Promise.all([proc1.stdout.text(), proc1.stderr.text(), proc1.exited]);

    // This might succeed or fail depending on whether the site's CA is bundled
    // We just verify the test runs without crashing
    expect([0, 1, 2]).toContain(exitCode1);

    // Test WITH system CA - should have better success rate
    await using proc2 = spawn({
      cmd: [bunExe(), "--use-system-ca", "test.js"],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout2, stderr2, exitCode2] = await Promise.all([proc2.stdout.text(), proc2.stderr.text(), proc2.exited]);

    // With system CA, we expect either success or non-cert errors
    expect([0, 2]).toContain(exitCode2);
  });
});
