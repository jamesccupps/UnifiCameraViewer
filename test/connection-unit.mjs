// Unit checks for ConsoleConnection with a fake ProtectClient.connect. test/run.mjs runs this under
// Electron's Node (ELECTRON_RUN_AS_NODE=1), since unifi-protect needs Node >= 22.20. Prints one
// JSON object of results; run.mjs makes the assertions.
import { ProtectAuthError } from "unifi-protect";
import { ConsoleConnection } from "../src/console-connection.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const fakeClient = () => ({
  controllerName: "Fake",
  cameras: [],
  connection: { on: () => ({ [Symbol.dispose]() {} }) },
  async [Symbol.asyncDispose]() {},
});
const until = async (fn, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return fn();
};

const out = {};

// UniFi OS answers 502/503 to a login while it boots, which the library reports as ProtectAuthError.
// The console must keep being retried and connect once the login is accepted.
{
  let calls = 0;
  const conn = new ConsoleConnection({ id: "c1", host: "h" }, async () => "pw", quiet, {
    connect: async () => {
      if (++calls <= 2) throw new ProtectAuthError("refused");
      return fakeClient();
    },
    authRetryMs: () => 20,
  });
  const states = [];
  conn.on("state", () => states.push(conn.state));
  conn.start();
  await until(() => conn.state === "connected");
  out.refusedThenAccepted = { calls, states, state: conn.state };
  await conn.stop();
}

// Reconnect clicked twice while the old client is slow to close: the second restart connects, and
// the first one finishing its teardown afterwards must not mark the console idle.
{
  const slowClient = () => ({ ...fakeClient(), async [Symbol.asyncDispose]() { await new Promise((r) => setTimeout(r, 200)); } });
  const conn = new ConsoleConnection({ id: "c2", host: "h" }, async () => "pw", quiet, { connect: async () => slowClient() });
  conn.start();
  await until(() => conn.state === "connected");
  const states = [];
  conn.on("state", () => states.push(conn.state));
  await Promise.all([conn.restart(), conn.restart()]);
  await new Promise((r) => setTimeout(r, 400)); // well past the slow close
  out.overlappingRestarts = { state: conn.state, states };
  await conn.stop();
}

// A saved password that can't be decrypted: say so, once, instead of retrying it as a network error.
{
  let calls = 0;
  const conn = new ConsoleConnection({ id: "c3", host: "h" }, async () => { throw new Error("Error while decrypting the ciphertext"); }, quiet, {
    connect: async () => { calls++; return fakeClient(); },
  });
  conn.start();
  await until(() => conn.state === "authfailed", 1_000);
  await new Promise((r) => setTimeout(r, 200));
  out.undecryptable = { state: conn.state, message: conn.message, calls };
  await conn.stop();
}

console.log(JSON.stringify(out));
