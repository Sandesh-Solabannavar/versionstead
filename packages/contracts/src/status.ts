import * as Schema from "effect/Schema";

export const Status = Schema.Struct({
  app: Schema.Literal("Versionstead"),
  appVersion: Schema.String,
  protocolVersion: Schema.Literal(1),
  startedAt: Schema.String,
  environment: Schema.Struct({
    hostname: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
    nodeVersion: Schema.String,
  }),
  capabilities: Schema.Struct({
    inventory: Schema.Literal(false),
    updates: Schema.Literal(false),
    vulnerabilities: Schema.Literal(false),
    remoteAgents: Schema.Literal(false),
  }),
});

export type Status = typeof Status.Type;
export const decodeStatus = Schema.decodeUnknownSync(Status);
