import assert from "node:assert/strict";
import test from "node:test";
import { searchListWithoutTemporary } from "./credentials.mjs";

const login = "/Users/me/Library/Keychains/login.keychain-db";
const system = "/Library/Keychains/System.keychain";
const temporary =
  "/private/var/folders/zz/abc123/T/vs-keychain-aB3dEf/versionstead-test.keychain-db";
const another = "/private/var/folders/zz/abc123/T/vs-keychain-Zz9xY0/versionstead-test.keychain-db";
// `security list-keychains -d user` prints each entry quoted and indented.
const printed = (...paths) => paths.map((path) => `    "${path}"\n`).join("");

test("the search list is set back without the throwaway keychains, in its order, and nothing else", () => {
  assert.deepEqual(searchListWithoutTemporary(printed(login, temporary, system)), [login, system]);
  assert.deepEqual(searchListWithoutTemporary(printed(temporary, login, another)), [login]);
  const windowsLines = printed(login, temporary).replaceAll("\n", "\r\n").trimEnd();
  assert.deepEqual(searchListWithoutTemporary(windowsLines), [login]);
});

test("nothing is set when the list is empty, unchanged, unparseable or would end up empty", () => {
  for (const output of [
    "",
    "  \n\n",
    printed(login, system), // No throwaway keychain listed: unchanged.
    printed(temporary), // Only throwaway keychains: never an empty list.
    "security: SecKeychainCopyDomainSearchList: failure\n",
    `${printed(login, temporary)}    /Users/me/unquoted.keychain-db\n`, // One line that is not a quoted path.
    `    "relative.keychain-db"\n${printed(temporary)}`,
    // Two quoted paths on one line are not one entry: read as one, the first line would be written back
    // as a single bogus path, and the second would drop the login keychain together with the throwaway one.
    `    "${login}" "${system}"\n${printed(temporary)}`,
    `${printed(system)}    "${login}" "${temporary}"\n`,
  ])
    assert.equal(searchListWithoutTemporary(output), null, JSON.stringify(output));
});

test("only this helper's own keychains match: look-alikes of the owner's stay in the list", () => {
  const lookalikes = [
    "/Users/me/vs-keychain-notes/versionstead-test.keychain-db", // Not six random characters.
    "/Users/me/Library/Keychains/vs-keychain-aB3dEf/other.keychain-db", // Another file name.
    "/Users/me/vs-keychain-aB3dEf-backup/versionstead-test.keychain-db",
    "/Users/me/Library/Keychains/versionstead-test.keychain-db",
  ];
  assert.deepEqual(searchListWithoutTemporary(printed(login, ...lookalikes, temporary)), [
    login,
    ...lookalikes,
  ]);
  assert.equal(searchListWithoutTemporary(printed(login, ...lookalikes)), null);
});
