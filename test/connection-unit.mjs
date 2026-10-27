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

console.log(JSON.stringify(out));
