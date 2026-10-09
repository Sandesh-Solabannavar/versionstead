import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";

/** DER length octets: short form below 128, otherwise the minimal long form. */
export function derLength(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid DER length.");
  if (length < 0x80) return Buffer.from([length]);
  const octets: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) octets.unshift(rest % 256);
  return Buffer.from([0x80 | octets.length, ...octets]);
}
const tlv = (tag: number, ...content: Buffer[]) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const sequence = (...content: Buffer[]) => tlv(0x30, ...content);

/** A non-negative INTEGER from big-endian magnitude bytes: minimal, with a 0x00 pad when the top bit is set. */
export function derInteger(magnitude: Buffer): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
  const value = magnitude.subarray(start);
  if (value.length === 0) return tlv(0x02, Buffer.from([0]));
  return tlv(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

export function derOid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  if (arcs.length < 2 || arcs.some((arc) => !Number.isSafeInteger(arc) || arc < 0))
    throw new Error("Invalid object identifier.");
  const octets = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const base128 = [arc % 128];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128))
      base128.unshift((rest % 128) | 0x80);
    octets.push(...base128);
  }
  return tlv(0x06, Buffer.from(octets));
}

/** RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050, both in whole seconds with Z. */
export function derTime(date: Date): Buffer {
  const digits = date.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const year = date.getUTCFullYear();
  return year >= 1950 && year < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, "ascii"))
    : tlv(0x18, Buffer.from(`${digits}Z`, "ascii"));
}

const ecdsaWithSha256 = sequence(derOid("1.2.840.10045.4.3.2"));
const commonName = (text: string) =>
  sequence(tlv(0x31, sequence(derOid("2.5.4.3"), tlv(0x0c, Buffer.from(text, "utf8")))));

/** The to-be-signed part of a self-signed X.509 v3 certificate; deterministic for fixed inputs. */
export function tbsCertificate(input: {
  serial: Buffer;
  publicKey: Buffer;
  address: string;
  notBefore: Date;
  notAfter: Date;
}): Buffer {
  const octets = input.address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    throw new Error("The certificate address must be an IPv4 address.");
  const name = commonName("Versionstead paired device");
  // Clients pin the certificate; the address is informational and may go stale if sharing moves.
  const subjectAltName = sequence(
    derOid("2.5.29.17"),
    tlv(0x04, sequence(tlv(0x87, Buffer.from(octets)))),
  );
  return sequence(
    tlv(0xa0, derInteger(Buffer.from([2]))),
    derInteger(input.serial),
    ecdsaWithSha256,
    name,
    sequence(derTime(input.notBefore), derTime(input.notAfter)),
    name,
    input.publicKey,
    tlv(0xa3, sequence(subjectAltName)),
  );
}

export type GeneratedCertificate = { key: string; cert: string; fingerprint: string };

/** A P-256 key and a self-signed certificate valid for one year, verified by Node before use. */
export function createPeerCertificate(
  address = "127.0.0.1",
  now = new Date(),
): GeneratedCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40;
  const notBefore = new Date(Math.floor(now.getTime() / 1000) * 1000 - 5 * 60_000);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 1);
  const tbs = tbsCertificate({
    serial,
    publicKey: publicKey.export({ type: "spki", format: "der" }),
    address,
    notBefore,
    notAfter,
  });
  const der = sequence(
    tbs,
    ecdsaWithSha256,
    tlv(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)),
  );
  // Fail closed: a certificate Node cannot parse and verify against its own key is never served.
  const parsed = new X509Certificate(der);
  if (!parsed.verify(publicKey) || !parsed.checkPrivateKey(privateKey))
    throw new Error("The generated certificate did not verify.");
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
    fingerprint: createHash("sha256").update(der).digest("hex"),
  };
}
