import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { connect } from "node:tls";
import {
  createPeerCertificate,
  derInteger,
  derLength,
  derOid,
  derTime,
  tbsCertificate,
} from "../dist/adapters/certificate.js";

const hex = (buffer) => buffer.toString("hex");
// A fixed P-256 SubjectPublicKeyInfo, so the to-be-signed bytes below never change.
const publicKey = Buffer.from(
  "3059301306072a8648ce3d020106082a8648ce3d03010703420004607575f09c6246d15a3015e8e3eb88d5816a4e3632b4564e1de14f44b69210dc7e91af51b3cad89b8d32558ba9cb4d15fa39656ed4715d3e0c32a26c61821529",
  "hex",
);
const fixedInput = {
  serial: Buffer.from("4000000000000000000000000000002a", "hex"),
  publicKey,
  address: "100.64.1.2",
  notBefore: new Date("2026-10-08T11:55:00Z"),
  notAfter: new Date("2027-10-08T11:55:00Z"),
};

test("DER primitives use minimal lengths, unsigned integers, base-128 OIDs and RFC 5280 times", () => {
  assert.equal(hex(derLength(0)), "00");
  assert.equal(hex(derLength(127)), "7f");
  assert.equal(hex(derLength(128)), "8180");
  assert.equal(hex(derLength(255)), "81ff");
  assert.equal(hex(derLength(256)), "820100");
  assert.equal(hex(derLength(65536)), "83010000");
  assert.throws(() => derLength(-1), /length/);
  assert.equal(hex(derInteger(Buffer.from([0x80]))), "02020080");
  assert.equal(hex(derInteger(Buffer.from([0, 0, 1]))), "020101");
  assert.equal(hex(derInteger(Buffer.from([0x7f]))), "02017f");
  assert.equal(hex(derInteger(Buffer.from([0, 0]))), "020100");
  assert.equal(hex(derOid("1.2.840.10045.4.3.2")), "06082a8648ce3d040302");
  assert.equal(hex(derOid("2.5.29.17")), "0603551d11");
  assert.equal(hex(derOid("2.5.4.3")), "0603550403");
  assert.throws(() => derOid("1"), /object identifier/);
  assert.equal(
    hex(derTime(new Date("2049-12-31T23:59:59.999Z"))),
    "170d3439313233313233353935395a",
    "UTCTime through 2049, whole seconds",
  );
  assert.equal(
    hex(derTime(new Date("2050-01-01T00:00:00Z"))),
    "180f32303530303130313030303030305a",
    "GeneralizedTime from 2050",
  );
});

test("the to-be-signed certificate is byte-for-byte stable for fixed inputs", () => {
  assert.equal(
    hex(tbsCertificate(fixedInput)),
    "30820101a00302010202104000000000000000000000000000002a300a06082a8648ce3d04030230253123302106035504030c1a56657273696f6e73746561642070616972656420646576696365301e170d3236313030383131353530305a170d3237313030383131353530305a30253123302106035504030c1a56657273696f6e737465616420706169726564206465766963653059301306072a8648ce3d020106082a8648ce3d03010703420004607575f09c6246d15a3015e8e3eb88d5816a4e3632b4564e1de14f44b69210dc7e91af51b3cad89b8d32558ba9cb4d15fa39656ed4715d3e0c32a26c61821529a3133011300f0603551d1104083006870464400102",
  );
  for (const address of ["example.com", "256.1.1.1", "10.0.0", "::1"])
    assert.throws(() => tbsCertificate({ ...fixedInput, address }), /IPv4/, address);
});

test("Node parses and verifies a generated certificate: P-256, ECDSA-SHA256, one year, SAN, pin", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const generated = createPeerCertificate("192.168.1.20", now);
  const certificate = new X509Certificate(generated.cert);
  assert.equal(certificate.subject, "CN=Versionstead paired device");
  assert.equal(certificate.issuer, "CN=Versionstead paired device");
  assert.equal(certificate.subjectAltName, "IP Address:192.168.1.20");
  assert.equal(new Date(certificate.validFrom).toISOString(), "2026-10-08T11:55:00.000Z");
  assert.equal(new Date(certificate.validTo).toISOString(), "2027-10-08T11:55:00.000Z");
  assert.equal(certificate.serialNumber.length, 32);
  assert.equal(certificate.publicKey.asymmetricKeyDetails.namedCurve, "prime256v1");
  assert.equal(certificate.ca, false);
  assert(certificate.verify(createPublicKey(generated.key)), "Self-signed with its own key");
  assert(certificate.checkPrivateKey(createPrivateKey(generated.key)));
  assert.equal(certificate.fingerprint256.replaceAll(":", "").toLowerCase(), generated.fingerprint);
  assert.notEqual(
    createPeerCertificate("192.168.1.20", now).fingerprint,
    generated.fingerprint,
    "Each certificate has its own key and serial",
  );
});

test("TLS 1.2 and 1.3 handshakes serve the generated certificate and its pin matches", async (t) => {
  const generated = createPeerCertificate("127.0.0.1");
  const server = createServer(
    { key: generated.key, cert: generated.cert, minVersion: "TLSv1.2" },
    (_request, response) => response.end("ok"),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const maxVersion of ["TLSv1.2", "TLSv1.3"]) {
    const fingerprint = await new Promise((resolve, reject) => {
      const socket = connect({
        host: "127.0.0.1",
        port: server.address().port,
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
        maxVersion,
      });
      socket.once("secureConnect", () => {
        assert.equal(socket.getProtocol(), maxVersion);
        resolve(socket.getPeerCertificate().fingerprint256.replaceAll(":", "").toLowerCase());
        socket.destroy();
      });
      socket.once("error", reject);
    });
    assert.equal(fingerprint, generated.fingerprint);
  }
});
