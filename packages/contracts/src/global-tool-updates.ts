import * as Schema from "effect/Schema";

const id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
const version = Schema.String.check(
  Schema.isMaxLength(100),
  Schema.isPattern(/^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/),
);
export const GlobalToolUpdateRequest = Schema.Struct({
  installationId: id,
  expectedVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  targetVersion: version,
});
export type GlobalToolUpdateRequest = typeof GlobalToolUpdateRequest.Type;
export const decodeGlobalToolUpdateRequest = Schema.decodeUnknownSync(GlobalToolUpdateRequest);
export const decodeGlobalToolUpdateCommand = Schema.decodeUnknownSync(
  Schema.String.check(Schema.isMaxLength(12000)),
);
export const GlobalToolUpdateRun = Schema.Struct({
  installationId: id,
  rootId: id,
  manager: Schema.Literals(["npm", "bun"]),
  name: Schema.String.check(Schema.isMaxLength(214)),
  packageId: Schema.String.check(Schema.isMaxLength(214)),
  previousVersion: Schema.String,
  targetVersion: version,
  status: Schema.Literals(["preparing", "updating", "verifying", "succeeded", "failed"]),
  command: Schema.NullOr(Schema.String.check(Schema.isMaxLength(12000))),
  message: Schema.String.check(Schema.isMaxLength(500)),
});
export type GlobalToolUpdateRun = typeof GlobalToolUpdateRun.Type;
export const decodeGlobalToolUpdateRun = Schema.decodeUnknownSync(GlobalToolUpdateRun);
export const GlobalToolUpdateRuns = Schema.Array(GlobalToolUpdateRun).check(Schema.isMaxLength(20));
export const decodeGlobalToolUpdateRuns = Schema.decodeUnknownSync(GlobalToolUpdateRuns);
export const globalToolUpdateActive = (run: GlobalToolUpdateRun) =>
  run.status === "preparing" || run.status === "updating" || run.status === "verifying";
